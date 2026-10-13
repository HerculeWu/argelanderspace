/**
 * Live Mail updates (Mail ticket 08; ADR 0008: the remote mailbox is the
 * authority, this only notices changes sooner).
 *
 * One {@link MailWatcher} per server process keeps one IMAP connection per
 * account on INBOX (IDLE, or polling when the server has no IDLE; the protocol
 * detail lives in infra's `MailInboxWatcher`). Several processes each hold
 * their own connections: nothing here is shared or locked across processes.
 *
 * Lifecycle: accounts are reconciled against `accounts.json` periodically and
 * on demand, so an added, edited or removed account (by this process or
 * another one) starts, restarts or stops exactly its own connection. A lost
 * connection is retried with exponential backoff; a login the server refuses
 * is NOT retried until the account changes (hammering a wrong password locks
 * accounts). `stop()` aborts every connection and timer and resolves once
 * they are gone. Errors become a watch state, and no credential, server text
 * or mail content ever leaves this file. What goes to the user-level log is
 * the account id (`acc-<random hex>`, never the address), the watch state and
 * the failure code a connection ended with: all values from fixed lists.
 *
 * Time is injected ({@link MailWatchClock}) so reconnect tests need no real waiting.
 */

import {
  type MailAccount,
  type MailUnreadAccount,
  type MailUnreadSummary,
  type MailWatchState,
  MailWatchStateSchema,
  mailUnreadTotal,
  type WsMailChanged,
} from "@argelanderspace/contracts";
import type {
  CredentialStore,
  MailAccountStore,
  MailInboxSnapshot,
  MailInboxWatcher,
  MailWatchEnd,
  MailWatchEvent,
} from "@argelanderspace/infra";
import { f } from "@argelanderspace/infra";
import { type ServerLog, silentLog } from "./log.js";
import { MAIL_FAILURE_CODES, mailAccountField } from "./log-observers.js";

export interface MailWatchClock {
  now(): number;
  /** Resolve after `ms`, or at once if `signal` aborts; no timer may outlive either. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realMailWatchClock: MailWatchClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      signal.addEventListener("abort", done, { once: true });
    }),
};

export interface MailWatcherDeps {
  accounts: Pick<MailAccountStore, "read">;
  credentials: Pick<CredentialStore, "get">;
  inbox: MailInboxWatcher;
  /** Push to the WS clients. */
  emit: (message: WsMailChanged) => void;
  clock?: MailWatchClock;
  /** First retry delay, doubled per failed attempt up to `maxMs` (defaults 2 s, 5 min). */
  backoff?: {
    baseMs?: number;
    maxMs?: number;
    /** A connection that lived at least this long counts as healthy: the next failure starts from `baseMs` again (default 30 s). */
    stableMs?: number;
    /** This many temporary login refusals in a row (never a successful connection between) are treated as a refused login and stop (default 3). */
    maxTemporaryRefusals?: number;
    /** [0,1) randomness for +-20 % jitter (default Math.random). */
    random?: () => number;
  };
  /** How often accounts.json is compared with the running connections (default 5 s). */
  reconcileMs?: number;
  /** The user-level log; absent = nothing is recorded. */
  log?: ServerLog;
}

interface Entry {
  account: MailAccount;
  /** accounts.json rev seen when this connection was started. */
  rev: number;
  fingerprint: string;
  controller: AbortController;
  state: MailWatchState;
  last: MailInboxSnapshot | null;
  loop: Promise<void>;
}

const WATCH_STATES = MailWatchStateSchema.options;
const YES_NO = ["yes", "no"] as const;

/** What identifies the connection: a change of any of these restarts it. */
const fingerprint = (a: MailAccount) =>
  JSON.stringify([a.imap.host, a.imap.port, a.imap.security, a.imapUser, a.credentialRef]);
/** States that are left only by the account changing (rev moves): a refused login is not hammered, and a missing password is likely re-entered at once. */
const RESTART_ON_REV_CHANGE = new Set<MailWatchState>(["auth_failed", "credential_missing"]);

export class MailWatcher {
  private readonly entries = new Map<string, Entry>();
  private readonly clock: MailWatchClock;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly stableMs: number;
  private readonly maxRefusals: number;
  private readonly random: () => number;
  private readonly reconcileMs: number;
  private readonly log: ServerLog;
  private readonly lifetime = new AbortController();
  private readonly retired = new Set<Promise<void>>();
  private ticker: Promise<void> | null = null;

  constructor(private readonly deps: MailWatcherDeps) {
    this.clock = deps.clock ?? realMailWatchClock;
    this.baseMs = deps.backoff?.baseMs ?? 2000;
    this.maxMs = deps.backoff?.maxMs ?? 5 * 60_000;
    this.stableMs = deps.backoff?.stableMs ?? 30_000;
    this.maxRefusals = deps.backoff?.maxTemporaryRefusals ?? 3;
    this.random = deps.backoff?.random ?? Math.random;
    this.reconcileMs = deps.reconcileMs ?? 5000;
    this.log = deps.log ?? silentLog;
  }

  /** Begin watching: connect for the accounts that exist now and keep following accounts.json. */
  start(): void {
    if (this.ticker || this.lifetime.signal.aborted) return;
    this.reconcile();
    this.ticker = (async () => {
      while (!this.lifetime.signal.aborted) {
        await this.clock.sleep(this.reconcileMs, this.lifetime.signal);
        if (!this.lifetime.signal.aborted) this.reconcile();
      }
    })();
  }

  /** Abort every connection and timer; resolves when all of them have ended. */
  async stop(): Promise<void> {
    this.lifetime.abort();
    for (const e of this.entries.values()) e.controller.abort();
    const loops = [...this.entries.values()].map((e) => e.loop);
    this.entries.clear();
    await Promise.all([...loops, ...this.retired, this.ticker].filter((p) => p !== null));
  }

  /** Make the running connections match accounts.json (cheap; safe to call at any time). */
  reconcile(): void {
    if (this.lifetime.signal.aborted) return;
    let file: ReturnType<MailAccountStore["read"]>;
    try {
      file = this.deps.accounts.read();
    } catch {
      return; // unreadable file: keep what runs, look again next time
    }
    const wanted = new Map(file.accounts.map((a) => [a.id, a]));
    for (const [id, e] of this.entries) {
      if (!wanted.has(id)) this.retire(id, e);
    }
    for (const a of file.accounts) {
      const e = this.entries.get(a.id);
      if (!e) {
        this.begin(a, file.rev);
      } else if (e.fingerprint !== fingerprint(a)) {
        this.retire(a.id, e);
        this.begin(a, file.rev);
      } else if (RESTART_ON_REV_CHANGE.has(e.state) && e.rev !== file.rev) {
        // Something about the accounts changed (e.g. the password was re-entered): try the login again.
        this.retire(a.id, e);
        this.begin(a, file.rev);
      }
    }
  }

  /** The numbers behind the sidebar badge, in accounts.json order. */
  summary(): MailUnreadSummary {
    const accounts: MailUnreadAccount[] = [];
    let ids: string[];
    try {
      ids = this.deps.accounts.read().accounts.map((a) => a.id);
    } catch {
      ids = [...this.entries.keys()];
    }
    for (const id of ids) {
      const e = this.entries.get(id);
      accounts.push({
        accountId: id,
        unread: e?.last?.unread ?? null,
        watch: e?.state ?? "connecting",
      });
    }
    return { version: 1, accounts, total: mailUnreadTotal(accounts) };
  }

  // ---- internals -------------------------------------------------------------

  private retire(id: string, e: Entry): void {
    e.controller.abort();
    this.entries.delete(id);
    this.retired.add(e.loop);
    void e.loop.finally(() => this.retired.delete(e.loop));
  }

  private begin(account: MailAccount, rev: number): void {
    const controller = new AbortController();
    const entry: Entry = {
      account,
      rev,
      fingerprint: fingerprint(account),
      controller,
      state: "connecting",
      last: null,
      loop: Promise.resolve(),
    };
    this.entries.set(account.id, entry);
    entry.loop = this.run(entry).catch(() => {});
  }

  private emit(e: Entry, cause: WsMailChanged["cause"]): void {
    if (e.controller.signal.aborted) return;
    this.deps.emit({
      type: "mail.changed",
      accountId: e.account.id,
      cause,
      unread: e.last?.unread ?? null,
      watch: e.state,
      at: new Date(this.clock.now()).toISOString(),
    });
  }

  private setState(e: Entry, state: MailWatchState): void {
    if (e.state === state || e.controller.signal.aborted) return;
    const fields = {
      account: mailAccountField(e.account.id),
      state: f.oneOf(WATCH_STATES, state),
      previous: f.oneOf(WATCH_STATES, e.state),
    };
    if (state === "auth_failed" || state === "credential_missing")
      this.log.warn("mail_watch.state_changed", fields);
    else this.log.info("mail_watch.state_changed", fields);
    e.state = state;
    this.emit(e, "state");
  }

  /** A fresh look at INBOX: say what kind of change it is compared with the previous look. */
  private onSnapshot(e: Entry, s: MailInboxSnapshot, events: readonly MailWatchEvent[]): void {
    if (e.controller.signal.aborted) return;
    const prev = e.last;
    e.last = s;
    if (!prev) {
      this.emit(e, "state");
    } else if (
      s.uidValidity !== prev.uidValidity ||
      s.total !== prev.total ||
      (s.uidNext > 0 && prev.uidNext > 0 && s.uidNext > prev.uidNext) ||
      events.includes("exists") ||
      events.includes("expunge")
    ) {
      this.emit(e, "inbox");
    } else if (s.unread !== prev.unread || events.includes("flags")) {
      // A flag push counts even when the unread number did not move (starred, or one read and one unread).
      this.emit(e, "flags");
    }
  }

  private delay(attempt: number): number {
    const raw = Math.min(this.maxMs, this.baseMs * 2 ** Math.min(attempt, 30));
    return Math.round(raw * (0.8 + 0.4 * this.random()));
  }

  private async run(e: Entry): Promise<void> {
    const { signal } = e.controller;
    let attempt = 0;
    let refusals = 0;
    while (!signal.aborted) {
      let connectedAt: number | null = null;
      try {
        const got = await this.deps.credentials.get(e.account.credentialRef);
        if (signal.aborted) return;
        if (got.status !== "ok") {
          this.setState(e, "credential_missing");
        } else {
          if (e.state === "credential_missing") this.setState(e, "connecting");
          const end: MailWatchEnd = await this.deps.inbox.watch(
            { ...e.account.imap, user: e.account.imapUser, password: got.password },
            {
              onConnected: (mode) => {
                connectedAt = this.clock.now();
                refusals = 0;
                this.setState(e, mode);
              },
              onSnapshot: (s, events) => this.onSnapshot(e, s, events),
            },
            signal
          );
          if (end.reason === "aborted" || signal.aborted) return;
          this.log.info("mail_watch.connection_ended", {
            account: mailAccountField(e.account.id),
            code: f.oneOf(MAIL_FAILURE_CODES, end.code),
            temporary_refusal: f.oneOf(YES_NO, end.temporaryRefusal ? "yes" : "no"),
            ...(connectedAt === null
              ? {}
              : { connected_ms: f.ms(Math.max(0, this.clock.now() - connectedAt)) }),
          });
          if (end.code === "auth_failed") {
            this.setState(e, "auth_failed");
            return; // not retried: a changed account (reconcile) starts a new connection
          }
          // A refusal that is not about the credentials (busy server, too many connections) is retried,
          // but not forever: the same login keeps being refused, which may be a lock-out in disguise.
          if (end.temporaryRefusal && ++refusals >= this.maxRefusals) {
            this.setState(e, "auth_failed");
            return;
          }
          if (!end.temporaryRefusal) refusals = 0;
          this.setState(e, "offline");
        }
      } catch {
        if (signal.aborted) return;
        this.setState(e, "offline");
      }
      if (connectedAt !== null && this.clock.now() - connectedAt >= this.stableMs) attempt = 0;
      await this.clock.sleep(this.delay(attempt), signal);
      attempt++;
    }
  }
}
