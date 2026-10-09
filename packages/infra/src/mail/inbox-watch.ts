/**
 * One live look at INBOX of one account (Mail ticket 08). A narrow seam like
 * `protocol.ts`: imapflow stays in the infra package, errors are reduced to a
 * failure CODE (server text, user names and banners are dropped) and the
 * password only lives inside the call.
 *
 * `watch` holds ONE connection until it ends: it logs in, selects INBOX
 * read-only, takes a snapshot (unread/total/uidNext) and then keeps taking
 * one whenever the server pushes a change (IDLE), or every `pollIntervalMs`
 * when the server does not advertise IDLE. The caller owns reconnecting and
 * backing off; this function never retries by itself and never leaves a
 * connection or timer behind: aborting the signal or any failure closes the
 * socket before it returns.
 */

import { ImapFlow } from "imapflow";
import { imapSocketOptions } from "./imap-internal.js";
import { classifyMailError, type MailLoginTarget, type MailRemoteFailure } from "./protocol.js";

export interface MailInboxSnapshot {
  /**
   * Messages without \Seen, the number the folder tree shows: SEARCH UNSEEN in the selected INBOX
   * (IDLE mode; RFC 3501 6.3.10 discourages STATUS on the selected mailbox), STATUS UNSEEN when polling.
   */
  unread: number;
  total: number;
  /** Next UID the server will assign (STATUS UIDNEXT when polling, the value from SELECT in IDLE mode); 0 = unknown. */
  uidNext: number;
  uidValidity: number;
}

/** What the server pushed since the previous snapshot (empty for the first look and for polls). */
export type MailWatchEvent = "exists" | "expunge" | "flags";

export type MailWatchMode = "idle" | "polling";

export interface MailWatchHandlers {
  /** Logged in; `mode` says how changes will be noticed. */
  onConnected(mode: MailWatchMode): void;
  /**
   * The first look after connecting, then one per observed change (or poll). `events` names the pushes
   * behind it, so a flag change is known even when the unread count did not move.
   */
  onSnapshot(snapshot: MailInboxSnapshot, events: readonly MailWatchEvent[]): void;
}

export type MailWatchEnd =
  | { reason: "aborted" }
  | {
      reason: "failed";
      code: MailRemoteFailure;
      /**
       * The server refused the login for a reason that is not "wrong credentials" (a connection-count limit
       * or a temporary response code). The caller retries, but must give up after a few in a row.
       */
      temporaryRefusal?: true;
    };

export interface MailInboxWatcher {
  watch(
    target: MailLoginTarget,
    handlers: MailWatchHandlers,
    signal: AbortSignal
  ): Promise<MailWatchEnd>;
}

export interface NodeMailInboxWatcherOptions {
  /** Connect and greeting timeout, default 10 s. */
  timeoutMs?: number;
  /** Silence after which a dead peer is detected (a NOOP is tried first), default 2 min. */
  socketTimeoutMs?: number;
  /** Poll interval when the server has no IDLE, default 60 s. */
  pollIntervalMs?: number;
  /** IDLE is broken and restarted this often so servers do not drop it (RFC 2177 says < 29 min), default 9 min. */
  idleRestartMs?: number;
  /** TLS overrides (tests pass a private CA); production leaves this unset. */
  tls?: { ca?: string | Buffer; rejectUnauthorized?: boolean; servername?: string };
}

const INBOX = "INBOX";

/** Standard IMAP response codes (RFC 5530) that say the server is busy or broken, not that the credentials are wrong. */
const TEMPORARY_CODES = new Set(["UNAVAILABLE", "LIMIT", "INUSE", "SERVERBUG"]);
/** Server text that is about the credentials or about lock-outs: such a refusal must never be retried. */
const CREDENTIAL_TEXT =
  /password|passphrase|credential|login (fail|incorrect|denied|invalid)|log ?in (fail|incorrect|denied)|authenti|authoriz|invalid (user|login|account)|unknown user|attempt|locked|lock-?out|disabled|suspended|blocked|denied|bad (user|login)/i;
/** Server text that is only about the number of connections. */
const CONNECTION_TEXT =
  /simultaneous|too many (connections|sessions|concurrent|logins from)|connection limit|maximum (number of )?(connections|sessions)|concurrent (connection|session)/i;

interface WatchFailure {
  code: MailRemoteFailure;
  temporary: boolean;
}

/**
 * The failure of a watch. A refused login is `auth_failed` (the caller stops until the account changes)
 * unless it is clearly not about the credentials:
 * - a response code AUTHENTICATIONFAILED / AUTHORIZATIONFAILED is always `auth_failed`;
 * - UNAVAILABLE / LIMIT / INUSE / SERVERBUG are temporary;
 * - otherwise (no code, ALERT, ...) only text that speaks of connection counts, and nothing about
 *   passwords, attempts or locks, is temporary; anything else (including no text) is `auth_failed`.
 * A temporary refusal is reported with `code: "protocol_error"` and `temporary: true`; the server text is
 * only inspected here and never kept.
 */
function watchFailure(error: unknown): WatchFailure {
  const code = classifyMailError(error);
  if (code !== "auth_failed") return { code, temporary: false };
  const e = (error ?? {}) as { serverResponseCode?: unknown; responseText?: unknown };
  const rc = typeof e.serverResponseCode === "string" ? e.serverResponseCode.toUpperCase() : "";
  const temporary = { code: "protocol_error" as const, temporary: true };
  if (rc === "AUTHENTICATIONFAILED" || rc === "AUTHORIZATIONFAILED")
    return { code, temporary: false };
  if (TEMPORARY_CODES.has(rc)) return temporary;
  const text = typeof e.responseText === "string" ? e.responseText : "";
  if (CONNECTION_TEXT.test(text) && !CREDENTIAL_TEXT.test(text)) return temporary;
  return { code, temporary: false };
}

const failed = (f: WatchFailure): MailWatchEnd =>
  f.temporary
    ? { reason: "failed", code: f.code, temporaryRefusal: true }
    : { reason: "failed", code: f.code };

/** Resolve after `ms`, or as soon as `signal` aborts; the timer never outlives either. */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createNodeMailInboxWatcher(
  options: NodeMailInboxWatcherOptions = {}
): MailInboxWatcher {
  const timeout = options.timeoutMs ?? 10_000;
  const socketTimeout = options.socketTimeoutMs ?? 120_000;
  const pollMs = options.pollIntervalMs ?? 60_000;
  const idleRestartMs = options.idleRestartMs ?? 9 * 60_000;
  const tls = imapSocketOptions(options.tls, timeout);

  return {
    async watch(t, handlers, signal) {
      if (signal.aborted) return { reason: "aborted" };
      const client = new ImapFlow({
        host: t.host,
        port: t.port,
        secure: t.security === "tls",
        doSTARTTLS: t.security === "starttls" ? true : undefined,
        auth: { user: t.user, pass: t.password },
        logger: false,
        tls,
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout,
        maxIdleTime: idleRestartMs,
        disableAutoIdle: true,
      });
      // Surfaced through the failing call or the close below; never logged (messages can name hosts/users).
      const st: { lastFailure: WatchFailure | null; failure: WatchFailure | null } = {
        lastFailure: null,
        failure: null,
      };
      client.on("error", (error: unknown) => {
        st.lastFailure = watchFailure(error);
      });
      const onAbort = () => client.close();
      signal.addEventListener("abort", onAbort, { once: true });

      let looking = false;
      let again = false;
      let idleMode = false;
      const pending = new Set<MailWatchEvent>();
      const fail = (failure: MailRemoteFailure | WatchFailure) => {
        st.failure ??= typeof failure === "string" ? { code: failure, temporary: false } : failure;
        client.close();
      };
      const look = async (): Promise<void> => {
        // One STATUS at a time; a change that lands meanwhile makes exactly one more look.
        if (looking) {
          again = true;
          return;
        }
        looking = true;
        try {
          do {
            again = false;
            const events = [...pending];
            pending.clear();
            if (idleMode) {
              const unseen = await client.search({ seen: false }, { uid: true });
              const box = client.mailbox;
              if (!unseen || !box) return fail("protocol_error");
              handlers.onSnapshot(
                {
                  unread: unseen.length,
                  total: box.exists,
                  uidNext: Number(box.uidNext ?? 0),
                  uidValidity: Number(box.uidValidity),
                },
                events
              );
            } else {
              const s = await client.status(INBOX, {
                messages: true,
                unseen: true,
                uidNext: true,
                uidValidity: true,
              });
              if (!s) return fail("protocol_error");
              handlers.onSnapshot(
                {
                  unread: s.unseen ?? 0,
                  total: s.messages ?? 0,
                  uidNext: s.uidNext ?? 0,
                  uidValidity: Number(s.uidValidity ?? 0),
                },
                events
              );
            }
          } while (again && !signal.aborted);
        } catch (error) {
          if (!signal.aborted) fail(watchFailure(error));
        } finally {
          looking = false;
        }
      };
      const changed = (kind: MailWatchEvent) => () => {
        pending.add(kind);
        void look();
      };

      try {
        await client.connect();
        const canIdle = client.capabilities.has("IDLE");
        if (canIdle) {
          await client.mailboxOpen(INBOX, { readOnly: true });
          idleMode = true;
          client.on("exists", changed("exists"));
          client.on("expunge", changed("expunge"));
          client.on("flags", changed("flags"));
        }
        handlers.onConnected(canIdle ? "idle" : "polling");
        await look();
        let quick = 0;
        while (!signal.aborted && !st.failure && client.usable) {
          if (canIdle) {
            const began = Date.now();
            const r = await client.idle();
            if (r === false) fail("protocol_error");
            // A loop that returns at once, again and again, would burn CPU: treat it as a broken server.
            quick = Date.now() - began < 5 && !looking ? quick + 1 : 0;
            if (quick > 100) fail("protocol_error");
          } else {
            await sleepUnlessAborted(pollMs, signal);
            if (!signal.aborted && !st.failure) await look();
          }
        }
        if (signal.aborted) return { reason: "aborted" };
        return failed(
          st.failure ?? st.lastFailure ?? { code: "connection_refused", temporary: false }
        );
      } catch (error) {
        if (signal.aborted) return { reason: "aborted" };
        return failed(st.failure ?? watchFailure(error));
      } finally {
        signal.removeEventListener("abort", onAbort);
        client.close();
      }
    },
  };
}
