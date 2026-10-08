/**
 * Reconnect, lifecycle and bookkeeping of the live INBOX watcher (Mail ticket 08),
 * against a scripted InboxWatcher and a manual clock: no sockets, no real waiting.
 */

import type { MailAccount, MailAccountsFile, WsMailChanged } from "@argelanderspace/contracts";
import type {
  GetCredentialResult,
  MailInboxSnapshot,
  MailInboxWatcher,
  MailWatchEnd,
  MailWatchHandlers,
} from "@argelanderspace/infra";
import { afterEach, expect, test } from "vitest";
import { type MailWatchClock, MailWatcher } from "../src/mail-watch.js";

// ---- test doubles -----------------------------------------------------------

class ManualClock implements MailWatchClock {
  time = 1_000_000;
  readonly pending: { ms: number; resolve: () => void }[] = [];
  readonly slept: number[] = [];
  now() {
    return this.time;
  }
  sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const item = {
        ms,
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          const i = this.pending.indexOf(item);
          if (i >= 0) this.pending.splice(i, 1);
          resolve();
        },
      };
      const onAbort = () => item.resolve();
      signal.addEventListener("abort", onAbort, { once: true });
      this.slept.push(ms);
      this.pending.push(item);
    });
  }
  /** Let the oldest sleeper whose delay equals `ms` (or the first one) wake up. */
  async wake(ms?: number) {
    const item = ms === undefined ? this.pending[0] : this.pending.find((p) => p.ms === ms);
    if (!item) throw new Error(`no sleeper${ms === undefined ? "" : ` for ${ms}`}`);
    item.resolve();
    await settle();
  }
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

interface Call {
  password: string;
  user: string;
  handlers: MailWatchHandlers;
  signal: AbortSignal;
  end: (e: MailWatchEnd) => void;
}
class ScriptedInbox implements MailInboxWatcher {
  readonly calls: Call[] = [];
  watch(
    target: { user: string; password: string },
    handlers: MailWatchHandlers,
    signal: AbortSignal
  ): Promise<MailWatchEnd> {
    return new Promise((resolve) => {
      const finish = (e: MailWatchEnd) => resolve(e);
      signal.addEventListener("abort", () => finish({ reason: "aborted" }), { once: true });
      this.calls.push({
        password: target.password,
        user: target.user,
        handlers,
        signal,
        end: finish,
      });
    });
  }
  get last(): Call {
    const c = this.calls.at(-1);
    if (!c) throw new Error("no watch call yet");
    return c;
  }
}

const snap = (over: Partial<MailInboxSnapshot> = {}): MailInboxSnapshot => ({
  unread: 2,
  total: 5,
  uidNext: 6,
  uidValidity: 7,
  ...over,
});

const account = (n: number, over: Partial<MailAccount> = {}): MailAccount => {
  const id = `acc-${String(n).padStart(12, "0")}` as MailAccount["id"];
  return {
    id,
    displayName: `Account ${n}`,
    address: `u${n}@fake.test`,
    preset: "custom",
    imap: { host: "127.0.0.1", port: 9990 + n, security: "tls" },
    smtp: { host: "127.0.0.1", port: 1, security: "tls" },
    imapUser: `user${n}`,
    smtpUser: `user${n}`,
    credentialRef: id,
    credentialProtection: "keychain",
    ...over,
  };
};

interface Rig {
  file: MailAccountsFile | null;
  creds: Map<string, string>;
  inbox: ScriptedInbox;
  clock: ManualClock;
  events: WsMailChanged[];
  watcher: MailWatcher;
}

const rigs: Rig[] = [];
function rig(accounts: MailAccount[]): Rig {
  const file: MailAccountsFile = { version: 1, rev: 1, accounts };
  const creds = new Map(accounts.map((a) => [a.credentialRef, `pw-of-${a.id}`]));
  const inbox = new ScriptedInbox();
  const clock = new ManualClock();
  const events: WsMailChanged[] = [];
  const r: Rig = {
    file,
    creds,
    inbox,
    clock,
    events,
    watcher: new MailWatcher({
      accounts: {
        read: () => {
          if (!r.file) throw new Error("unreadable");
          return r.file;
        },
      },
      credentials: {
        get: async (id): Promise<GetCredentialResult> => {
          const p = r.creds.get(id);
          return p === undefined
            ? { status: "not-found" }
            : { status: "ok", password: p, protection: "keychain", keychainProtected: true };
        },
      },
      inbox,
      emit: (m) => events.push(m),
      clock,
      backoff: { baseMs: 1000, maxMs: 8000, stableMs: 30_000, random: () => 0.5 },
      reconcileMs: 5000,
    }),
  };
  rigs.push(r);
  return r;
}

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((r) => r.watcher.stop()));
});

const connect = async (r: Rig, mode: "idle" | "polling" = "idle", s = snap()) => {
  await settle();
  r.inbox.last.handlers.onConnected(mode);
  r.inbox.last.handlers.onSnapshot(s, []);
  await settle();
};

// ---- tests ------------------------------------------------------------------

test("each account gets one connection with its own login; the badge counts only INBOX unread", async () => {
  const r = rig([account(1), account(2)]);
  r.watcher.start();
  await settle();
  expect(r.inbox.calls).toHaveLength(2);
  expect(r.inbox.calls.map((c) => c.user).sort()).toEqual(["user1", "user2"]);
  expect(r.inbox.calls.map((c) => c.password).sort()).toEqual([
    "pw-of-acc-000000000001",
    "pw-of-acc-000000000002",
  ]);
  expect(r.watcher.summary()).toEqual({
    version: 1,
    accounts: [
      { accountId: "acc-000000000001", unread: null, watch: "connecting" },
      { accountId: "acc-000000000002", unread: null, watch: "connecting" },
    ],
    total: 0,
  });
  const [c1, c2] = r.inbox.calls;
  c1?.handlers.onConnected("idle");
  c1?.handlers.onSnapshot(snap({ unread: 3 }), []);
  c2?.handlers.onConnected("polling");
  c2?.handlers.onSnapshot(snap({ unread: 4 }), []);
  expect(r.watcher.summary().total).toBe(7);
  expect(r.watcher.summary().accounts.map((a) => a.watch)).toEqual(["idle", "polling"]);
});

test("classifies what changed: new mail, flags only, nothing", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await connect(r);
  const causes = () => r.events.map((e) => e.cause);
  expect(causes()).toEqual(["state", "state"]); // connecting->idle, then the first look
  expect(r.events.at(-1)).toMatchObject({ unread: 2, watch: "idle" });

  const h = r.inbox.last.handlers;
  h.onSnapshot(snap({ unread: 3, total: 6 }), []);
  expect(causes().at(-1)).toBe("inbox");
  h.onSnapshot(snap({ unread: 2, total: 6 }), []);
  expect(causes().at(-1)).toBe("flags");
  const n = r.events.length;
  h.onSnapshot(snap({ unread: 2, total: 6 }), []); // a duplicate look is silent
  expect(r.events).toHaveLength(n);
  h.onSnapshot(snap({ unread: 1, total: 5 }), []); // expunge
  expect(causes().at(-1)).toBe("inbox");
  h.onSnapshot(snap({ unread: 1, total: 5, uidValidity: 8 }), []);
  expect(causes().at(-1)).toBe("inbox");
});

test("a dropped connection is retried with exponential backoff capped at maxMs", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await connect(r);
  r.inbox.last.end({ reason: "failed", code: "connection_refused" });
  await settle();
  expect(r.watcher.summary().accounts[0]).toMatchObject({ watch: "offline", unread: 2 });
  expect(r.events.at(-1)).toMatchObject({ cause: "state", watch: "offline", unread: 2 });
  expect(r.clock.slept.filter((ms) => ms !== 5000)).toEqual([1000]);

  // The server stays down: 1s, 2s, 4s, 8s, then it stays at 8s.
  for (const ms of [1000, 2000, 4000, 8000, 8000]) {
    const before = r.inbox.calls.length;
    await r.clock.wake(ms);
    expect(r.inbox.calls).toHaveLength(before + 1);
    r.inbox.last.end({ reason: "failed", code: "timeout" });
    await settle();
  }
  expect(r.clock.slept.filter((ms) => ms !== 5000)).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
  // No connection is open while waiting, and exactly one timer is pending for this account (plus reconcile).
  expect(r.inbox.calls.filter((c) => !c.signal.aborted)).toHaveLength(6);
});

test("reconnect: state returns to idle and a change missed while offline is reported once", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await connect(r);
  r.inbox.last.end({ reason: "failed", code: "connection_refused" });
  await settle();
  await r.clock.wake(1000);
  r.events.length = 0;
  r.inbox.last.handlers.onConnected("idle");
  expect(r.events.map((e) => [e.cause, e.watch])).toEqual([["state", "idle"]]);
  r.inbox.last.handlers.onSnapshot(snap({ unread: 5, total: 8 }), []);
  expect(r.events.map((e) => e.cause)).toEqual(["state", "inbox"]);
  expect(r.events.at(-1)).toMatchObject({ unread: 5 });
  expect(r.watcher.summary().total).toBe(5);
});

test("backoff restarts from the base only after a connection that stayed up", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await connect(r);
  r.inbox.last.end({ reason: "failed", code: "timeout" }); // up for 0 ms: not stable
  await settle();
  await r.clock.wake(1000);
  r.inbox.last.handlers.onConnected("idle"); // connects, drops again at once
  r.inbox.last.end({ reason: "failed", code: "timeout" });
  await settle();
  expect(r.clock.slept.filter((ms) => ms !== 5000)).toEqual([1000, 2000]);
  await r.clock.wake(2000);
  r.inbox.last.handlers.onConnected("idle");
  r.clock.time += 31_000; // this time it stays up past stableMs
  r.inbox.last.end({ reason: "failed", code: "timeout" });
  await settle();
  expect(r.clock.slept.filter((ms) => ms !== 5000)).toEqual([1000, 2000, 1000]);
});

test("a refused login is not retried by time; changing the account starts a new attempt", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await settle();
  r.inbox.last.end({ reason: "failed", code: "auth_failed" });
  await settle();
  expect(r.watcher.summary().accounts[0]).toMatchObject({ watch: "auth_failed" });
  expect(r.clock.pending.map((p) => p.ms)).toEqual([5000]); // only the reconcile tick; no retry timer
  const calls = r.inbox.calls.length;
  await r.clock.wake(5000); // reconcile with an unchanged file
  await r.clock.wake(5000);
  expect(r.inbox.calls).toHaveLength(calls);

  r.creds.set("acc-000000000001", "new-password"); // re-entered in the app: the file's rev moves
  r.file = { version: 1, rev: 2, accounts: [account(1)] };
  await r.clock.wake(5000);
  expect(r.inbox.calls).toHaveLength(calls + 1);
  expect(r.inbox.last.password).toBe("new-password");
  expect(r.watcher.summary().accounts[0]?.watch).toBe("connecting");
});

test("the badge excludes accounts that cannot log in but keeps offline ones' last count", async () => {
  const r = rig([account(1), account(2), account(3)]);
  r.watcher.start();
  await settle();
  const [c1, c2, c3] = r.inbox.calls;
  for (const [c, unread] of [
    [c1, 4],
    [c2, 10],
    [c3, 1],
  ] as const) {
    c?.handlers.onConnected("idle");
    c?.handlers.onSnapshot(snap({ unread }), []);
  }
  expect(r.watcher.summary().total).toBe(15);
  c2?.end({ reason: "failed", code: "auth_failed" });
  c3?.end({ reason: "failed", code: "connection_refused" });
  await settle();
  const s = r.watcher.summary();
  expect(s.accounts.map((a) => a.watch)).toEqual(["idle", "auth_failed", "offline"]);
  expect(s.total).toBe(5); // 4 + 1 (offline keeps its last count), the failed login's 10 is out
});

test("a missing credential is a blocked state that heals by itself once the password exists", async () => {
  const r = rig([account(1)]);
  r.creds.clear();
  r.watcher.start();
  await settle();
  expect(r.inbox.calls).toHaveLength(0);
  expect(r.watcher.summary().accounts[0]?.watch).toBe("credential_missing");
  expect(r.watcher.summary().total).toBe(0);
  r.creds.set("acc-000000000001", "back");
  await r.clock.wake(1000);
  expect(r.inbox.calls).toHaveLength(1);
});

test("removing an account closes its connection and timers; adding one starts watching it", async () => {
  const r = rig([account(1), account(2)]);
  r.watcher.start();
  await settle();
  const [c1, c2] = r.inbox.calls;
  c1?.handlers.onConnected("idle");
  c1?.handlers.onSnapshot(snap({ unread: 3 }), []);
  c2?.handlers.onConnected("idle");
  c2?.handlers.onSnapshot(snap({ unread: 4 }), []);

  r.creds.set("acc-000000000003", "pw3");
  r.file = { version: 1, rev: 2, accounts: [account(2), account(3)] };
  r.watcher.reconcile();
  await settle();
  expect(c1?.signal.aborted).toBe(true);
  expect(c2?.signal.aborted).toBe(false);
  expect(r.inbox.calls).toHaveLength(3);
  expect(r.inbox.last.user).toBe("user3");
  expect(r.watcher.summary().accounts.map((a) => a.accountId)).toEqual([
    "acc-000000000002",
    "acc-000000000003",
  ]);
  // A late snapshot from the removed account's old connection changes nothing and says nothing.
  const n = r.events.length;
  c1?.handlers.onSnapshot(snap({ unread: 99 }), []);
  expect(r.events).toHaveLength(n);
  expect(r.watcher.summary().total).toBe(4);
});

test("editing the connection settings restarts exactly that account's connection", async () => {
  const r = rig([account(1), account(2)]);
  r.watcher.start();
  await settle();
  const [c1, c2] = r.inbox.calls;
  r.file = {
    version: 1,
    rev: 2,
    accounts: [
      account(1, { imap: { host: "127.0.0.1", port: 12345, security: "tls" } }),
      account(2),
    ],
  };
  r.watcher.reconcile();
  await settle();
  expect(c1?.signal.aborted).toBe(true);
  expect(c2?.signal.aborted).toBe(false);
  expect(r.inbox.calls).toHaveLength(3);
});

test("stop aborts every connection and clears every timer, and nothing starts afterwards", async () => {
  const r = rig([account(1), account(2)]);
  r.watcher.start();
  await settle();
  const [c1, c2] = r.inbox.calls;
  c1?.handlers.onConnected("idle");
  c1?.end({ reason: "failed", code: "timeout" }); // account 1 is waiting to reconnect
  await settle();
  expect(r.clock.pending.length).toBeGreaterThan(0);
  await r.watcher.stop();
  expect(c2?.signal.aborted).toBe(true);
  expect(r.clock.pending).toHaveLength(0);
  const calls = r.inbox.calls.length;
  r.file = { version: 1, rev: 9, accounts: [account(7)] };
  r.watcher.reconcile();
  r.watcher.start();
  await settle();
  expect(r.inbox.calls).toHaveLength(calls);
});

test("an unreadable accounts file keeps the running connections", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await settle();
  const c = r.inbox.last;
  r.file = null; // read() now throws, like a damaged accounts.json
  r.watcher.reconcile();
  await settle();
  expect(c.signal.aborted).toBe(false);
});

test("nothing sensitive reaches events or the summary", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await connect(r);
  const text = JSON.stringify([r.events, r.watcher.summary()]);
  expect(text).not.toContain("pw-of-");
  expect(text).not.toContain("user1");
  expect(text).not.toContain("fake.test");
});

test("flag pushes are reported even when the unread count did not change; polls with no change stay silent", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await connect(r);
  const h = r.inbox.last.handlers;
  const n = r.events.length;
  h.onSnapshot(snap(), ["flags"]); // starred elsewhere
  expect(r.events).toHaveLength(n + 1);
  expect(r.events.at(-1)).toMatchObject({ cause: "flags", unread: 2 });
  // one message read and another arrived: unread 2 -> 2, total 5 -> 6
  h.onSnapshot(snap({ total: 6 }), ["flags", "exists"]);
  expect(r.events.at(-1)).toMatchObject({ cause: "inbox", unread: 2 });
  // an expunge push with the same counts is a mailbox change too
  h.onSnapshot(snap({ total: 6 }), ["expunge"]);
  expect(r.events.at(-1)).toMatchObject({ cause: "inbox" });
  const m = r.events.length;
  h.onSnapshot(snap({ total: 6 }), []); // a poll that saw nothing new
  expect(r.events).toHaveLength(m);
});

test("a refusal that is not about the credentials (temporary/too many connections) is retried with backoff", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await settle();
  r.inbox.last.end({ reason: "failed", code: "protocol_error" });
  await settle();
  expect(r.watcher.summary().accounts[0]?.watch).toBe("offline");
  const calls = r.inbox.calls.length;
  await r.clock.wake(1000);
  expect(r.inbox.calls).toHaveLength(calls + 1);
});

test("a missing credential restarts at once when the accounts rev moves (re-entered password)", async () => {
  const r = rig([account(1)]);
  r.creds.clear();
  r.watcher.start();
  await settle();
  expect(r.watcher.summary().accounts[0]?.watch).toBe("credential_missing");
  r.creds.set("acc-000000000001", "typed-again");
  r.file = { version: 1, rev: 2, accounts: [account(1)] };
  await r.clock.wake(5000); // the reconcile tick, not the 1 s retry timer
  expect(r.inbox.calls).toHaveLength(1);
  expect(r.inbox.last.password).toBe("typed-again");
});

test("three temporary refusals in a row stop like a refused login; a successful connection resets the count", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await settle();
  const wakeRetry = async () => {
    const t = r.clock.pending.filter((p) => p.ms !== 5000).at(-1);
    if (!t) throw new Error("no retry timer");
    t.resolve();
    await settle();
  };
  const refuse = () =>
    r.inbox.last.end({ reason: "failed", code: "protocol_error", temporaryRefusal: true });
  refuse();
  await settle();
  await wakeRetry();
  refuse();
  await settle();
  expect(r.watcher.summary().accounts[0]?.watch).toBe("offline");
  await wakeRetry();
  // This attempt gets in: the count starts over.
  r.inbox.last.handlers.onConnected("idle");
  r.inbox.last.end({ reason: "failed", code: "connection_refused" });
  await settle();
  await wakeRetry();
  refuse();
  await settle();
  await wakeRetry();
  refuse();
  await settle();
  expect(r.watcher.summary().accounts[0]?.watch).toBe("offline");
  await wakeRetry();
  refuse();
  await settle();
  expect(r.watcher.summary().accounts[0]?.watch).toBe("auth_failed");
  const calls = r.inbox.calls.length;
  await r.clock.wake(5000);
  expect(r.inbox.calls).toHaveLength(calls); // stopped until the account changes
});

test("new mail is noticed from uidNext alone when total and unread did not change", async () => {
  const r = rig([account(1)]);
  r.watcher.start();
  await connect(r);
  const n = r.events.length;
  r.inbox.last.handlers.onSnapshot(snap({ uidNext: 7 }), []); // one arrived and one was expunged unseen
  expect(r.events).toHaveLength(n + 1);
  expect(r.events.at(-1)?.cause).toBe("inbox");
  r.inbox.last.handlers.onSnapshot(snap({ uidNext: 0 }), []); // an unknown value never counts
  expect(r.events).toHaveLength(n + 1);
});
