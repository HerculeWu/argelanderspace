import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryPaths } from "@argelanderspace/core";
import {
  createCredentialStore,
  createMailAccountStore,
  createNodeMailMailbox,
  createNodeMailManage,
  type KeychainBackend,
} from "@argelanderspace/infra";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  type FakeFolder,
  type FakeMailbox,
  plainMail,
  startFakeMailbox,
} from "../../infra/tests/mail/fake-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "../../infra/tests/mail/fake-servers.js";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { MailAccountService } from "../src/mail-accounts.js";
import { MailCache } from "../src/mail-cache.js";
import { MailManageService } from "../src/mail-manage.js";
import { MailReadService } from "../src/mail-read.js";
import { stubPipelines, stubSources } from "./helpers.js";

let root: string;
let globalData: string;
let globalCache: string;
let keychain: Map<string, string>;
let fake: FakeMailbox;
let app: ReturnType<typeof createApp>;
let cache: MailCache;
const accountId = "acc-0123456789ab";
const started: FakeMailbox[] = [];

const backend = (): KeychainBackend => ({
  get: (a) => keychain.get(a) ?? null,
  set: (a, p) => void keychain.set(a, p),
  delete: (a) => keychain.delete(a),
});

const SECRET_QUERY = "SECRET-SEARCH-TERM-77";
const SECRET_BODY = "SECRET-BODY-TEXT-42";

function folders(): FakeFolder[] {
  const msgs = [];
  for (let uid = 1; uid <= 6; uid++)
    msgs.push(
      plainMail({
        uid,
        subject: `Message ${uid}`,
        from: [
          uid % 2 ? "Ada Lovelace" : "Kofi Mensah",
          uid % 2 ? "ada@fake.test" : "kofi@fake.test",
        ],
        date: `Mon, ${uid} Oct 2026 10:00:00 +0000`,
        body: uid === 5 ? `${SECRET_BODY} ${SECRET_QUERY}` : `Body ${uid}`,
        flags: uid <= 2 ? ["\\Seen"] : [],
      })
    );
  return [
    { path: "INBOX", uidValidity: 11, messages: msgs },
    { path: "Sent", attrs: ["\\Sent"], uidValidity: 12, messages: [] },
    { path: "Archive", attrs: ["\\Archive"], uidValidity: 13, messages: [] },
    {
      path: "Trash",
      attrs: ["\\Trash"],
      uidValidity: 14,
      messages: [
        plainMail({
          uid: 30,
          subject: "Old",
          from: ["News", "news@fake.test"],
          date: "Mon, 1 Jun 2026 08:00:00 +0000",
          body: "old",
          flags: ["\\Seen"],
        }),
      ],
    },
  ];
}

async function setup() {
  fake = await startFakeMailbox(folders());
  started.push(fake);
  const store = createMailAccountStore({ dataDir: globalData });
  const credentials = createCredentialStore({ backend: backend(), dataDir: globalData });
  await credentials.set(accountId, TEST_PASSWORD, { fileFallbackConsent: false });
  await store.update(0, async () => ({
    accounts: [
      {
        id: accountId as never,
        displayName: "Test",
        address: "tester@fake.test",
        preset: "custom",
        imap: { host: "127.0.0.1", port: fake.port, security: "tls" },
        smtp: { host: "127.0.0.1", port: 1, security: "tls" },
        imapUser: TEST_USER,
        smtpUser: TEST_USER,
        credentialRef: accountId as never,
        credentialProtection: "keychain",
      },
    ],
    result: null,
  }));
  cache = new MailCache(() => globalCache);
  const tlsOptions = { timeoutMs: 3000, tls: { rejectUnauthorized: false } };
  const read = new MailReadService({
    accounts: store,
    credentials,
    mailbox: createNodeMailMailbox(tlsOptions),
    cache,
  });
  const manage = new MailManageService({ read, manage: createNodeMailManage(tlsOptions), cache });
  const accounts = new MailAccountService({
    store,
    credentials,
    protocol: {
      verifyImapLogin: async () => ({ ok: true }),
      verifySmtpLogin: async () => ({ ok: true }),
    },
    cacheDir: () => globalCache,
  });
  app = createApp({
    paths: libraryPaths(join(root, "data")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    mailAccounts: accounts,
    mailRead: read,
    mailManage: manage,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-manage-"));
  mkdirSync(root, { recursive: true });
  globalData = join(root, "global");
  globalCache = join(root, "gcache");
  keychain = new Map();
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((f) => f.close()));
  rmSync(root, { recursive: true, force: true });
});

const get = (path: string) => app.request(`/api/mail/accounts/${accountId}${path}`);
const post = (path: string, body: unknown, origin?: string) =>
  app.request(`/api/mail/accounts/${accountId}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
  });
// biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
const json = async (r: Response): Promise<any> => r.json();
const inbox = () => fake.folders.find((f) => f.path === "INBOX") as FakeFolder;
const folder = (p: string) => fake.folders.find((f) => f.path === p) as FakeFolder;
const flagsOf = (uid: number) => [...(inbox().messages.find((m) => m.uid === uid)?.flags ?? [])];
const cacheFiles = () => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of existsSync(d) ? readdirSync(d, { withFileTypes: true }) : []) {
      const p = join(d, e.name);
      e.isDirectory() ? walk(p) : out.push(p);
    }
  };
  walk(join(globalCache, "mail", accountId));
  return out;
};
const cachedUnread = (uid: number) =>
  cache.readHeaders(accountId, "INBOX")?.headers.find((h) => h.uid === uid)?.unread;

// ---- flags ---------------------------------------------------------------------

test("flag: read/unread and star change the server first; the answer and the cached header follow it", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50"); // fill the cache
  expect(cachedUnread(4)).toBe(true);

  const read = await post("/messages/flag", { folder: "INBOX", uid: 4, flag: "seen", value: true });
  expect(read.status).toBe(200);
  expect(await json(read)).toEqual({ uid: 4, unread: false, starred: false });
  expect(flagsOf(4)).toEqual(["\\Seen"]);
  expect(cachedUnread(4)).toBe(false);

  const star = await json(
    await post("/messages/flag", { folder: "INBOX", uid: 4, flag: "flagged", value: true })
  );
  expect(star).toEqual({ uid: 4, unread: false, starred: true });
  expect(cache.readHeaders(accountId, "INBOX")?.headers.find((h) => h.uid === 4)?.starred).toBe(
    true
  );

  const unread = await json(
    await post("/messages/flag", { folder: "INBOX", uid: 4, flag: "seen", value: false })
  );
  expect(unread.unread).toBe(true);
  expect(cachedUnread(4)).toBe(true);
});

test("flag failures: refused, unreachable, unknown uid, wrong generation; the server and cache stay as they were", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50");
  fake.denyStore = true;
  const refused = await post("/messages/flag", {
    folder: "INBOX",
    uid: 4,
    flag: "seen",
    value: true,
  });
  expect(refused.status).toBe(502);
  expect((await json(refused)).code).toBe("refused");
  expect(flagsOf(4)).toEqual([]);
  expect(cachedUnread(4)).toBe(true);
  fake.denyStore = false;

  const changed = await post("/messages/flag", {
    folder: "INBOX",
    uid: 4,
    uidValidity: 999,
    flag: "seen",
    value: true,
  });
  expect(changed.status).toBe(409);
  expect((await json(changed)).code).toBe("message_changed");

  const gone = await post("/messages/flag", {
    folder: "INBOX",
    uid: 99,
    flag: "seen",
    value: true,
  });
  expect(gone.status).toBe(404);
  expect((await json(gone)).code).toBe("message_not_found");

  const missingFolder = await post("/messages/flag", {
    folder: "Nope",
    uid: 1,
    flag: "seen",
    value: true,
  });
  expect(missingFolder.status).toBe(404);
  expect((await json(missingFolder)).code).toBe("folder_not_found");

  fake.dropOn = "UID STORE";
  const lost = await post("/messages/flag", { folder: "INBOX", uid: 4, flag: "seen", value: true });
  expect((await json(lost)).code).toBe("connection_lost");
  fake.dropOn = null;

  await fake.close();
  const down = await post("/messages/flag", { folder: "INBOX", uid: 4, flag: "seen", value: true });
  expect(down.status).toBe(502);
  expect(cachedUnread(4)).toBe(true);
});

test("a flag change on a message another client already removed drops its cached header", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50");
  inbox().messages = inbox().messages.filter((m) => m.uid !== 3); // expunged elsewhere
  const r = await post("/messages/flag", { folder: "INBOX", uid: 3, flag: "seen", value: true });
  expect(r.status).toBe(404);
  expect(cache.readHeaders(accountId, "INBOX")?.headers.some((h) => h.uid === 3)).toBe(false);
});

// ---- move and delete --------------------------------------------------------------

test("move: the server moves it, the cache forgets it in the source, the new position allows an undo", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50");
  await post("/messages/open", { folder: "INBOX", uid: 4, uidValidity: 11, unread: true });
  expect(cacheFiles().some((f) => f.endsWith("4.json"))).toBe(true);

  const r = await post("/messages/move", {
    folder: "INBOX",
    uid: 4,
    uidValidity: 11,
    destination: "Archive",
  });
  expect(r.status).toBe(200);
  const moved = await json(r);
  expect(moved).toEqual({ destination: "Archive", uid: 1, uidValidity: 13 });
  expect(inbox().messages.some((m) => m.uid === 4)).toBe(false);
  expect(folder("Archive").messages.map((m) => m.uid)).toEqual([1]);
  expect(cache.readHeaders(accountId, "INBOX")?.headers.some((h) => h.uid === 4)).toBe(false);
  expect(cache.readMessage(accountId, "INBOX", 11, 4)).toBeNull();

  // Undo = move the message back from where it now is.
  const back = await post("/messages/move", {
    folder: "Archive",
    uid: moved.uid,
    uidValidity: moved.uidValidity,
    destination: "INBOX",
  });
  expect(back.status).toBe(200);
  expect(inbox().messages.map((m) => m.uid)).toContain(7);
  expect(folder("Archive").messages).toHaveLength(0);
});

test("move failures leave server and cache alone: missing destination, same folder, refused", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50");
  const missing = await post("/messages/move", { folder: "INBOX", uid: 4, destination: "Nowhere" });
  expect(missing.status).toBe(404);
  expect((await json(missing)).code).toBe("destination_not_found");
  const same = await post("/messages/move", { folder: "INBOX", uid: 4, destination: "INBOX" });
  expect(same.status).toBe(400);
  fake.denyMove = true;
  const refused = await post("/messages/move", { folder: "INBOX", uid: 4, destination: "Archive" });
  expect((await json(refused)).code).toBe("refused");
  expect(inbox().messages.some((m) => m.uid === 4)).toBe(true);
  expect(cache.readHeaders(accountId, "INBOX")?.headers.some((h) => h.uid === 4)).toBe(true);
});

test("delete moves into Trash; in Trash it needs permanent:true, and that only works there", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50");
  const r = await post("/messages/delete", { folder: "INBOX", uid: 3 });
  expect(await json(r)).toEqual({
    outcome: "trashed",
    destination: "Trash",
    uid: 31,
    uidValidity: 14,
  });
  expect(folder("Trash").messages.map((m) => m.uid)).toEqual([30, 31]);
  expect(cache.readHeaders(accountId, "INBOX")?.headers.some((h) => h.uid === 3)).toBe(false);

  const ask = await post("/messages/delete", { folder: "Trash", uid: 31 });
  expect(ask.status).toBe(409);
  expect((await json(ask)).code).toBe("confirmation_required");
  expect(folder("Trash").messages.map((m) => m.uid)).toEqual([30, 31]);

  const outside = await post("/messages/delete", {
    folder: "INBOX",
    uid: 2,
    uidValidity: 11,
    permanent: true,
  });
  expect(outside.status).toBe(409);
  expect((await json(outside)).code).toBe("not_in_trash");
  expect(inbox().messages.some((m) => m.uid === 2)).toBe(true);

  const gone = await post("/messages/delete", {
    folder: "Trash",
    uid: 31,
    uidValidity: 14,
    permanent: true,
  });
  expect(await json(gone)).toEqual({
    outcome: "deleted",
    destination: null,
    uid: null,
    uidValidity: null,
  });
  expect(folder("Trash").messages.map((m) => m.uid)).toEqual([30]);
});

test("delete with a server that refuses the move reports it and removes nothing", async () => {
  await setup();
  fake.denyMove = true;
  const r = await post("/messages/delete", { folder: "INBOX", uid: 3 });
  expect(r.status).toBe(502);
  expect((await json(r)).code).toBe("refused");
  expect(inbox().messages.some((m) => m.uid === 3)).toBe(true);
});

// ---- search --------------------------------------------------------------------------

test("search runs on the server, pages newest first, and is never cached", async () => {
  await setup();
  const before = cacheFiles().length;
  const r = await post("/messages/search", {
    folder: "INBOX",
    criteria: { from: "ada" },
    limit: 2,
  });
  expect(r.status).toBe(200);
  const p1 = await json(r);
  expect(p1).toMatchObject({
    accountId,
    folder: "INBOX",
    uidValidity: 11,
    matches: 3,
    nextBefore: 3,
  });
  expect(p1.headers.map((h: { uid: number }) => h.uid)).toEqual([5, 3]);
  const p2 = await json(
    await post("/messages/search", {
      folder: "INBOX",
      criteria: { from: "ada" },
      limit: 2,
      before: p1.nextBefore,
    })
  );
  expect(p2.headers.map((h: { uid: number }) => h.uid)).toEqual([1]);
  expect(p2.nextBefore).toBeNull();
  expect(cacheFiles().length).toBe(before);

  const body = await json(
    await post("/messages/search", { folder: "INBOX", criteria: { text: SECRET_QUERY } })
  );
  expect(body.headers.map((h: { uid: number }) => h.uid)).toEqual([5]);
  // Searching reads only: nothing became read on the server.
  expect(flagsOf(5)).toEqual([]);
});

test("search failures: refused, unreachable, bad criteria; error bodies never echo the query", async () => {
  await setup();
  fake.denySearch = true;
  const refused = await post("/messages/search", {
    folder: "INBOX",
    criteria: { text: SECRET_QUERY },
  });
  expect(refused.status).toBe(502);
  const text = await refused.text();
  expect(JSON.parse(text).code).toBe("refused");
  expect(text).not.toContain(SECRET_QUERY);
  expect(text).not.toContain(TEST_PASSWORD);
  fake.denySearch = false;

  const empty = await post("/messages/search", { folder: "INBOX", criteria: {} });
  expect(empty.status).toBe(400);
  const badDate = await post("/messages/search", {
    folder: "INBOX",
    criteria: { since: "yesterday" },
  });
  expect(badDate.status).toBe(400);
  const leak = await badDate.text();
  expect(leak).not.toContain("yesterday");

  await fake.close();
  const down = await post("/messages/search", { folder: "INBOX", criteria: { from: "ada" } });
  expect(down.status).toBe(502);
});

// ---- cache consistency ------------------------------------------------------------------

test("a fresh listing drops cached headers the server no longer has (moved or expunged elsewhere)", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50");
  expect(cache.readHeaders(accountId, "INBOX")?.headers).toHaveLength(6);
  inbox().messages = inbox().messages.filter((m) => m.uid !== 2 && m.uid !== 6);
  await get("/messages?folder=INBOX&limit=50");
  expect(cache.readHeaders(accountId, "INBOX")?.headers.map((h) => h.uid)).toEqual([5, 4, 3, 1]);
});

// ---- guards ---------------------------------------------------------------------------------

test("management routes validate input and leak nothing", async () => {
  await setup();
  const bad = await post("/messages/flag", { folder: "INBOX", uid: 0, flag: "seen", value: true });
  expect(bad.status).toBe(400);
  const extra = await post("/messages/flag", {
    folder: "INBOX",
    uid: 1,
    flag: "deleted",
    value: true,
  });
  expect(extra.status).toBe(400);
  const ctl = await post("/messages/move", { folder: "IN\nBOX", uid: 1, destination: "Archive" });
  expect(ctl.status).toBe(400);

  const unknown = await app.request("/api/mail/accounts/acc-ffffffffffff/messages/flag", {
    method: "POST",
    body: JSON.stringify({ folder: "INBOX", uid: 1, flag: "seen", value: true }),
    headers: { "Content-Type": "application/json" },
  });
  expect(unknown.status).toBe(404);
  expect((await json(unknown)).code).toBe("account_not_found");
});

// ---- review round 1 ----------------------------------------------------------------------

test("a refused SEARCH while listing is a failure: the cached headers are kept (served as stale), never pruned away", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50");
  expect(cache.readHeaders(accountId, "INBOX")?.headers).toHaveLength(6);
  fake.denySearch = true;
  const r = await get("/messages?folder=INBOX&limit=50");
  expect(r.status).toBe(200);
  const body = await json(r);
  expect(body.stale).toBe(true);
  expect(body.headers).toHaveLength(6);
  expect(cache.readHeaders(accountId, "INBOX")?.headers).toHaveLength(6);
  // with no cache there is nothing to fall back on: an error, not an empty folder
  rmSync(join(globalCache, "mail"), { recursive: true, force: true });
  const bare = await get("/messages?folder=INBOX&limit=50");
  expect(bare.status).toBe(502);
});

test("a permanent delete must name the uid generation: without it nothing is sent to the server", async () => {
  await setup();
  const r = await post("/messages/delete", { folder: "Trash", uid: 30, permanent: true });
  expect(r.status).toBe(400);
  expect((await json(r)).fields).toContain("uidValidity");
  expect(folder("Trash").messages).toHaveLength(1);
  expect(fake.commands).not.toContain("UID EXPUNGE");
  // a stale generation is refused by the server: the same uid would be another message
  const stale = await post("/messages/delete", {
    folder: "Trash",
    uid: 30,
    uidValidity: 999,
    permanent: true,
  });
  expect(stale.status).toBe(409);
  expect((await json(stale)).code).toBe("message_changed");
  expect(folder("Trash").messages).toHaveLength(1);
  const ok = await post("/messages/delete", {
    folder: "Trash",
    uid: 30,
    uidValidity: 14,
    permanent: true,
  });
  expect(ok.status).toBe(200);
  expect(folder("Trash").messages).toHaveLength(0);
});

test("a cache that fails AFTER the server changed the mailbox does not turn the change into an error", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=50");
  cache.patchHeader = () => {
    throw new Error("disk full");
  };
  cache.removeHeader = () => {
    throw new Error("disk full");
  };
  const flag = await post("/messages/flag", { folder: "INBOX", uid: 4, flag: "seen", value: true });
  expect(flag.status).toBe(200);
  expect(flagsOf(4)).toEqual(["\\Seen"]);
  const moved = await post("/messages/move", { folder: "INBOX", uid: 3, destination: "Archive" });
  expect(moved.status).toBe(200);
  expect(folder("Archive").messages).toHaveLength(1);
});

test("folder roles: a guessed role is only believed at the top level or directly under INBOX", async () => {
  await setup();
  fake.folders.push({ path: "Projects/Deleted", uidValidity: 40, messages: [] });
  const b = await json(await get("/folders"));
  const role = (path: string) => b.folders.find((f: { path: string }) => f.path === path)?.role;
  expect(role("Projects/Deleted")).toBe("custom"); // not a Trash: deleting there cannot be "permanent"
  expect(role("Trash")).toBe("trash");
});

test("a move without MOVE whose expunge is refused is reported as partial (502), original intact", async () => {
  await setup();
  fake.moveCapability = false;
  fake.denyExpunge = true;
  const r = await post("/messages/move", { folder: "INBOX", uid: 4, destination: "Archive" });
  expect(r.status).toBe(502);
  expect((await json(r)).code).toBe("partial");
  expect(inbox().messages.some((m) => m.uid === 4)).toBe(true);
  expect(flagsOf(4)).toEqual([]);
  expect(folder("Archive").messages).toHaveLength(1);
});
