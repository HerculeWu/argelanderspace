/**
 * Live updates end to end (Mail ticket 08): a real server, the real node IMAP seam and a fake IMAP
 * server with IDLE. Synthetic accounts and mail only; the real global directories are never touched.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MailAccount,
  MailFoldersResponse,
  MailUnreadSummary,
  WsMailChanged,
  WsServerMessage,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import {
  createCredentialStore,
  createMailAccountStore,
  createNodeMailInboxWatcher,
  createNodeMailMailbox,
  type KeychainBackend,
  type MailAccountStore,
} from "@argelanderspace/infra";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  type FakeIdleMailbox,
  startFakeIdleMailbox,
} from "../../infra/tests/mail/fake-idle-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "../../infra/tests/mail/fake-servers.js";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { MailAccountService } from "../src/mail-accounts.js";
import { MailCache } from "../src/mail-cache.js";
import { MailReadService } from "../src/mail-read.js";
import { MailWatcher } from "../src/mail-watch.js";
import { createServer, type RunningServer } from "../src/server.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const ID = "acc-0123456789ab";
let root: string;
let globalData: string;
let store: MailAccountStore;
let fake: FakeIdleMailbox;
let srv: RunningServer | null = null;
const closers: (() => Promise<void>)[] = [];
const keychain = new Map<string, string>();
const backend = (): KeychainBackend => ({
  get: (a) => keychain.get(a) ?? null,
  set: (a, p) => void keychain.set(a, p),
  delete: (a) => keychain.delete(a),
});
const credentials = () => createCredentialStore({ backend: backend(), dataDir: globalData });

const accountFor = (port: number, id = ID): MailAccount => ({
  id: id as never,
  displayName: "Test",
  address: "tester@fake.test",
  preset: "custom",
  imap: { host: "127.0.0.1", port, security: "tls" },
  smtp: { host: "127.0.0.1", port: 1, security: "tls" },
  imapUser: TEST_USER,
  smtpUser: TEST_USER,
  credentialRef: id as never,
  credentialProtection: "keychain",
});

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "mail-watch-live-"));
  globalData = join(root, "global");
  keychain.clear();
  store = createMailAccountStore({ dataDir: globalData });
  fake = await startFakeIdleMailbox(3, 2);
  await credentials().set(ID, TEST_PASSWORD, { fileFallbackConsent: false });
  await store.update(0, async () => ({ accounts: [accountFor(fake.port)], result: null }));
});
afterEach(async () => {
  await srv?.close();
  srv = null;
  for (const c of closers.splice(0)) await c();
  await fake.close();
});

const inboxWatcher = () =>
  createNodeMailInboxWatcher({
    timeoutMs: 3000,
    pollIntervalMs: 60,
    tls: { rejectUnauthorized: false },
  });

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 5000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function startServer(
  backoff: { maxTemporaryRefusals?: number } = {}
): Promise<{ port: number; mail: WsMailChanged[] }> {
  srv = createServer({
    dataDir: makeDataDir(),
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    watchIntervalMs: 5000,
    mailWatch: {
      accounts: store,
      credentials: credentials(),
      inbox: inboxWatcher(),
      backoff: { baseMs: 30, maxMs: 120, stableMs: 10_000, random: () => 0.5, ...backoff },
      reconcileMs: 80,
    },
  });
  const port = await srv.ready();
  const mail: WsMailChanged[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()) as WsServerMessage;
    if (m.type === "mail.changed") mail.push(m);
  });
  closers.push(async () => ws.terminate());
  await new Promise<void>((r) => ws.on("open", () => r()));
  return { port, mail };
}

const summary = async (port: number): Promise<MailUnreadSummary> =>
  (await fetch(`http://127.0.0.1:${port}/api/mail/unread`)).json() as Promise<MailUnreadSummary>;

const readService = () =>
  new MailReadService({
    accounts: store,
    credentials: credentials(),
    mailbox: createNodeMailMailbox({ timeoutMs: 3000, tls: { rejectUnauthorized: false } }),
    cache: new MailCache(() => join(root, "gcache")),
  });

/** INBOX unread exactly as the folder tree gets it (the read path, over the same fake server). */
async function folderInboxUnread(): Promise<number | null> {
  const r: MailFoldersResponse = await readService().folders(ID);
  return r.folders.find((f) => f.role === "inbox")?.unread ?? null;
}

test("badge and folder unread agree through new mail, another client reading, and expunge", async () => {
  const { port, mail } = await startServer();
  await until(async () => (await summary(port)).accounts[0]?.watch === "idle", "idle watch");
  await until(async () => (await summary(port)).total === 3, "first count");
  expect(await folderInboxUnread()).toBe(3);

  const agree = async (n: number) => {
    await until(async () => (await summary(port)).total === n, `badge ${n}`);
    expect(await folderInboxUnread()).toBe(n);
    expect(fake.unseen).toBe(n);
  };

  fake.deliver();
  await agree(4);
  await until(
    () => mail.some((m) => m.cause === "inbox" && m.unread === 4),
    "the matching push reaches the client"
  );

  fake.markSeen(3); // another client reads one
  await agree(3);
  await until(
    () => mail.some((m) => m.cause === "flags" && m.unread === 3),
    "the matching push reaches the client"
  );

  fake.expunge(4); // an unread message disappears
  await agree(2);
  expect(mail.every((m) => m.watch !== "auth_failed")).toBe(true);
  // One watching connection (the folder tree's own calls open and close theirs).
  expect(fake.commands.filter((c) => c === "IDLE").length).toBeGreaterThan(0);
});

test("opening a message in the app sets \\Seen and this process's own IDLE connection moves the badge", async () => {
  const { port, mail } = await startServer();
  await until(async () => (await summary(port)).total === 3, "first count");
  const opened = await readService().open(ID, { folder: "INBOX", uid: 4, unread: true });
  expect(opened.seen).toBe(true);
  expect(fake.isSeen(4)).toBe(true);
  await until(async () => (await summary(port)).total === 2, "badge after reading");
  expect(await folderInboxUnread()).toBe(2);
  await until(
    () => mail.some((m) => m.cause === "flags" && m.unread === 2),
    "the matching push reaches the client"
  );
});

test("the server dropping us is retried and mail that arrived meanwhile is reported", async () => {
  const { port, mail } = await startServer();
  await until(async () => (await summary(port)).total === 3, "first count");
  const before = fake.totalConnections;

  fake.refuseConnections = true;
  fake.dropAll();
  await until(async () => (await summary(port)).accounts[0]?.watch === "offline", "offline");
  // The last count stands while offline; the badge does not blink to zero.
  expect((await summary(port)).total).toBe(3);
  fake.deliver(); // arrives while we cannot see it
  await until(() => fake.totalConnections > before + 1, "reconnect attempts keep coming");

  fake.refuseConnections = false;
  await until(async () => (await summary(port)).accounts[0]?.watch === "idle", "idle again");
  await until(async () => (await summary(port)).total === 4, "missed mail counted");
  expect(mail.map((m) => m.watch)).toContain("offline");
  expect(mail.at(-1)).toMatchObject({ unread: 4 });
  await until(
    () => mail.some((m) => m.cause === "inbox" && m.unread === 4),
    "the matching push reaches the client"
  );
});

test("a server without IDLE is polled", async () => {
  await fake.close();
  fake = await startFakeIdleMailbox(1, 0);
  fake.idleSupported = false;
  await store.update(1, async () => ({ accounts: [accountFor(fake.port)], result: null }));
  const { port } = await startServer();
  await until(async () => (await summary(port)).accounts[0]?.watch === "polling", "polling");
  fake.deliver();
  await until(async () => (await summary(port)).total === 2, "polled count");
  expect(fake.commands).not.toContain("IDLE");
});

test("a wrong password stops the watcher from retrying and the account leaves the badge", async () => {
  keychain.set(ID, "not-the-password");
  const { port } = await startServer();
  await until(
    async () => (await summary(port)).accounts[0]?.watch === "auth_failed",
    "auth_failed"
  );
  const logins = fake.commands.filter((c) => c === "AUTHENTICATE" || c === "LOGIN").length;
  await new Promise((r) => setTimeout(r, 400)); // several backoff periods
  expect(fake.commands.filter((c) => c === "AUTHENTICATE" || c === "LOGIN")).toHaveLength(logins);
  expect((await summary(port)).total).toBe(0);
});

test("removing the account closes its connection; closing the server leaves none open", async () => {
  const { port } = await startServer();
  await until(async () => (await summary(port)).accounts[0]?.watch === "idle", "idle watch");
  expect(fake.openConnections).toBe(1);

  const file = store.read();
  await store.update(file.rev, async () => ({ accounts: [], result: null }));
  await until(() => fake.openConnections === 0, "connection closed after account removal");
  await until(async () => (await summary(port)).accounts.length === 0, "summary empty");

  await store.update(store.read().rev, async () => ({
    accounts: [accountFor(fake.port)],
    result: null,
  }));
  await until(() => fake.openConnections === 1, "new account watched");
  await srv?.close();
  srv = null;
  await until(() => fake.openConnections === 0, "every connection closed with the server");
});

test("a server started without mailWatch never reads accounts or connects", async () => {
  srv = createServer({
    dataDir: makeDataDir(),
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
  });
  const port = await srv.ready();
  await new Promise((r) => setTimeout(r, 150));
  expect(fake.totalConnections).toBe(0);
  expect(await summary(port)).toEqual({ version: 1, accounts: [], total: 0 });
});

test("adding an account through the API starts watching it at once, not at the next tick", async () => {
  const watcher = new MailWatcher({
    accounts: store,
    credentials: credentials(),
    inbox: inboxWatcher(),
    emit: () => {},
    reconcileMs: 3_600_000,
  });
  watcher.start();
  closers.push(() => watcher.stop());
  await store.update(store.read().rev, async () => ({ accounts: [], result: null }));
  watcher.reconcile();
  expect(watcher.summary().accounts).toEqual([]);

  const app = createApp({
    paths: libraryPaths(join(root, "data")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    mailAccounts: new MailAccountService({
      store,
      credentials: credentials(),
      protocol: {
        verifyImapLogin: async () => ({ ok: true }),
        verifySmtpLogin: async () => ({ ok: true }),
      },
      cacheDir: () => join(root, "gcache"),
    }),
    mailWatch: watcher,
  });
  const res = await app.request("/api/mail/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({
      displayName: "Added",
      address: "added@fake.test",
      preset: "custom",
      imap: { host: "127.0.0.1", port: fake.port, security: "tls" },
      smtp: { host: "127.0.0.1", port: 1, security: "tls" },
      imapUser: TEST_USER,
      smtpUser: TEST_USER,
      password: TEST_PASSWORD,
    }),
  });
  expect(res.status).toBe(201);
  expect(watcher.summary().accounts).toHaveLength(1);
  const id = watcher.summary().accounts[0]?.accountId as string;
  await until(() => watcher.summary().accounts[0]?.watch === "idle", "added account watched");

  const del = await app.request(`/api/mail/accounts/${id}?rev=${store.read().rev}`, {
    method: "DELETE",
    headers: { Origin: "http://localhost:5173" },
  });
  expect(del.status).toBe(200);
  expect(watcher.summary().accounts).toEqual([]);
  await until(() => fake.openConnections === 0, "removed account's connection closed");
});

test("starring on another client is pushed as flags although the unread count is unchanged", async () => {
  const { port, mail } = await startServer();
  await until(() => mail.some((m) => m.watch === "idle" && m.unread === 3), "first count pushed");
  const before = mail.length;
  fake.setFlagged(1, true);
  await until(
    () => mail.slice(before).some((m) => m.cause === "flags" && m.unread === 3),
    "flags push"
  );
  expect((await summary(port)).total).toBe(3);
});

test("a temporary login refusal is retried until it clears, never treated as a wrong password", async () => {
  fake.loginRefusal = "[ALERT] Too many simultaneous connections";
  const { port } = await startServer({ maxTemporaryRefusals: 1000 });
  await until(async () => (await summary(port)).accounts[0]?.watch === "offline", "offline");
  await new Promise((r) => setTimeout(r, 300));
  expect((await summary(port)).accounts[0]?.watch).toBe("offline");
  fake.loginRefusal = null;
  await until(
    async () => (await summary(port)).accounts[0]?.watch === "idle",
    "idle after the refusal cleared"
  );
  await until(async () => (await summary(port)).total === 3, "count after reconnect");
});

const logins = () => fake.commands.filter((c) => c === "AUTHENTICATE" || c === "LOGIN").length;

test("a wrong-password text that sounds temporary stops after the first refusal (no retries against the old password)", async () => {
  fake.loginRefusal = "[ALERT] Too many failed login attempts, account temporarily locked";
  const { port } = await startServer();
  await until(
    async () => (await summary(port)).accounts[0]?.watch === "auth_failed",
    "auth_failed"
  );
  const n = logins();
  await new Promise((r) => setTimeout(r, 400));
  expect(logins()).toBe(n);
  expect(n).toBe(1);
});

test("a refusal that keeps saying 'temporary' is given up on after three in a row", async () => {
  fake.loginRefusal = "[UNAVAILABLE] try again later";
  const { port } = await startServer();
  await until(
    async () => (await summary(port)).accounts[0]?.watch === "auth_failed",
    "auth_failed after 3"
  );
  const n = logins();
  await new Promise((r) => setTimeout(r, 400));
  expect(logins()).toBe(n);
  expect(n).toBe(3);
});
