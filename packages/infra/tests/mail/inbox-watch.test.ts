import { afterEach, expect, test } from "vitest";
import {
  createNodeMailInboxWatcher,
  type MailInboxSnapshot,
  type MailWatchEnd,
  type MailWatchEvent,
  type MailWatchMode,
} from "../../src/index.js";
import { type FakeIdleMailbox, startFakeIdleMailbox } from "./fake-idle-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "./fake-servers.js";

const servers: FakeIdleMailbox[] = [];
const controllers: AbortController[] = [];
afterEach(async () => {
  for (const c of controllers.splice(0)) c.abort();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const watcher = createNodeMailInboxWatcher({
  timeoutMs: 3000,
  pollIntervalMs: 40,
  tls: { rejectUnauthorized: false },
});
const login = (port: number, password = TEST_PASSWORD) => ({
  host: "127.0.0.1",
  port,
  security: "tls" as const,
  user: TEST_USER,
  password,
});

async function until(check: () => boolean, what: string, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function start(unread = 2, seen = 1) {
  const s = await startFakeIdleMailbox(unread, seen);
  servers.push(s);
  return s;
}

function begin(s: FakeIdleMailbox, password = TEST_PASSWORD) {
  const ctl = new AbortController();
  controllers.push(ctl);
  const snapshots: MailInboxSnapshot[] = [];
  const events: MailWatchEvent[][] = [];
  const modes: MailWatchMode[] = [];
  const done: Promise<MailWatchEnd> = watcher.watch(
    login(s.port, password),
    {
      onConnected: (m) => modes.push(m),
      onSnapshot: (x, ev) => {
        snapshots.push(x);
        events.push([...ev]);
      },
    },
    ctl.signal
  );
  return { ctl, snapshots, events, modes, done };
}

test("IDLE: first snapshot, then pushed changes (new mail, \\Seen by another client, expunge)", async () => {
  const s = await start(2, 1);
  const w = begin(s);
  await until(() => w.snapshots.length === 1, "first snapshot");
  expect(w.modes).toEqual(["idle"]);
  expect(w.snapshots[0]).toMatchObject({ unread: 2, total: 3, uidValidity: 7 });
  await until(() => s.idlingConnections === 1, "IDLE started");

  s.deliver();
  await until(() => w.snapshots.at(-1)?.total === 4, "new mail seen");
  expect(w.snapshots.at(-1)).toMatchObject({ unread: 3, total: 4 });

  s.markSeen(2);
  await until(() => w.snapshots.at(-1)?.unread === 2, "flag change seen");
  expect(w.snapshots.at(-1)).toMatchObject({ unread: 2, total: 4 });

  s.expunge(1);
  await until(() => w.snapshots.at(-1)?.total === 3, "expunge seen");

  // One watching connection, no polling, and no STATUS on the selected INBOX (RFC 3501 6.3.10): the
  // counts come from the selected mailbox itself (EXISTS) plus SEARCH UNSEEN.
  expect(s.openConnections).toBe(1);
  expect(s.commands).not.toContain("STATUS");
  expect(s.commands).toContain("UID SEARCH");
  expect(w.events[0]).toEqual([]);
  expect(w.events.flat()).toEqual(expect.arrayContaining(["exists", "flags", "expunge"]));
  expect(s.commands.filter((c) => c === "IDLE").length).toBeGreaterThanOrEqual(1);
  expect(s.commands).not.toContain("NOOP");

  w.ctl.abort();
  expect(await w.done).toEqual({ reason: "aborted" });
  await until(() => s.openConnections === 0, "connection closed after abort");
});

test("no IDLE support: INBOX is polled, mode says so, nothing idles", async () => {
  const s = await start(1, 0);
  s.idleSupported = false;
  const w = begin(s);
  await until(() => w.snapshots.length === 1, "first snapshot");
  expect(w.modes).toEqual(["polling"]);
  s.deliver();
  await until(() => w.snapshots.at(-1)?.total === 2, "polled change");
  expect(w.snapshots.at(-1)?.unread).toBe(2);
  expect(s.commands).not.toContain("IDLE");
  expect(s.commands).not.toContain("SELECT");
  expect(s.commands).not.toContain("EXAMINE");
  w.ctl.abort();
  expect(await w.done).toEqual({ reason: "aborted" });
  await until(() => s.openConnections === 0, "connection closed after abort");
});

test("the server cutting the connection ends the watch with a retryable failure and no leftover socket", async () => {
  const s = await start();
  const w = begin(s);
  await until(() => s.idlingConnections === 1, "IDLE started");
  s.dropAll();
  const end = await w.done;
  expect(end.reason).toBe("failed");
  if (end.reason === "failed") expect(end.code).not.toBe("auth_failed");
  await until(() => s.openConnections === 0, "no connection left");
});

test("bad password ends with auth_failed; a refused connection with a retryable code", async () => {
  const s = await start();
  const bad = begin(s, "wrong");
  expect(await bad.done).toEqual({ reason: "failed", code: "auth_failed" });
  expect(bad.snapshots).toEqual([]);

  s.refuseConnections = true;
  const down = begin(s);
  const end = await down.done;
  expect(end.reason).toBe("failed");
  if (end.reason === "failed") expect(end.code).not.toBe("auth_failed");
});

test("an already aborted signal never connects", async () => {
  const s = await start();
  const ctl = new AbortController();
  ctl.abort();
  const end = await watcher.watch(
    login(s.port),
    { onConnected: () => {}, onSnapshot: () => {} },
    ctl.signal
  );
  expect(end).toEqual({ reason: "aborted" });
  expect(s.totalConnections).toBe(0);
});

test("a flag change that leaves the unread count alone still produces a snapshot that names it", async () => {
  const s = await start(2, 1);
  const w = begin(s);
  await until(() => s.idlingConnections === 1 && w.snapshots.length === 1, "IDLE started");
  const n = w.snapshots.length;
  s.setFlagged(1, true); // starring: unread stays 2
  await until(() => w.snapshots.length > n, "snapshot after \\Flagged");
  expect(w.snapshots.at(-1)?.unread).toBe(2);
  expect(w.events.at(-1)).toContain("flags");
  w.ctl.abort();
  await w.done;
});

test("one message read while another arrives (net unread change 0) is still reported", async () => {
  const s = await start(2, 0);
  const w = begin(s);
  await until(() => s.idlingConnections === 1 && w.snapshots.length === 1, "IDLE started");
  const n = w.snapshots.length;
  s.markSeen(1);
  s.deliver();
  await until(() => {
    const kinds = w.events.slice(n).flat();
    return kinds.includes("flags") && kinds.includes("exists");
  }, "both pushes reported");
  expect(w.snapshots.at(-1)).toMatchObject({ total: 3, unread: 2 });
  const kinds = w.events.slice(n).flat();
  expect(kinds).toContain("flags");
  expect(kinds).toContain("exists");
  w.ctl.abort();
  await w.done;
});

test("login refusals: only connection-count or temporary-code refusals are retryable, everything about credentials stops", async () => {
  const s = await start();
  const end = async (refusal: string) => {
    s.loginRefusal = refusal;
    return begin(s).done;
  };
  const stops = [
    "[AUTHENTICATIONFAILED] invalid credentials",
    "[AUTHORIZATIONFAILED] not allowed",
    "login rejected", // NO without a response code
    "[ALERT] Application-specific password required",
    // Real wrong-password / lock-out texts that also sound "temporary": retrying them locks the account.
    "Invalid username or password. Please try again",
    "[ALERT] Too many failed login attempts, account temporarily locked",
    "Login failed: too many invalid attempts",
    "Authentication failed, try again later",
    "[ALERT] Too many failed attempts",
    "account temporarily disabled",
    "[AUTHENTICATIONFAILED] Too many simultaneous connections", // an auth code always wins
  ];
  for (const text of stops) {
    const e = await end(text);
    expect(e, text).toEqual({ reason: "failed", code: "auth_failed" });
  }
  const retries = [
    "[UNAVAILABLE] try later",
    "[LIMIT] too busy",
    "[INUSE] mailbox in use",
    "[SERVERBUG] oops",
    "[ALERT] Too many simultaneous connections",
    "Too many connections from your IP",
    "Maximum number of connections reached",
    "connection limit exceeded for this account",
  ];
  for (const text of retries) {
    const e = await end(text);
    expect(e, text).toEqual({ reason: "failed", code: "protocol_error", temporaryRefusal: true });
  }
});
