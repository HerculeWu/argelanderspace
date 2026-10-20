import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryPaths } from "@argelanderspace/core";
import {
  createCredentialStore,
  createMailAccountStore,
  createNodeMailMailbox,
  type KeychainBackend,
} from "@argelanderspace/infra";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  attachmentMail,
  type FakeFolder,
  type FakeMailbox,
  htmlMail,
  plainMail,
  startFakeMailbox,
} from "../../infra/tests/mail/fake-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "../../infra/tests/mail/fake-servers.js";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { MailAccountService } from "../src/mail-accounts.js";
import { MailCache } from "../src/mail-cache.js";
import { MailReadService } from "../src/mail-read.js";
import { stubPipelines, stubSources } from "./helpers.js";

let root: string;
let globalData: string;
let globalCache: string;
let keychain: Map<string, string>;
let fake: FakeMailbox;
let app: ReturnType<typeof createApp>;
let accountId: string;
const started: FakeMailbox[] = [];

const backend = (): KeychainBackend => ({
  get: (a) => keychain.get(a) ?? null,
  set: (a, p) => void keychain.set(a, p),
  delete: (a) => keychain.delete(a),
});

const SECRET_BODY = "SECRET-BODY-TEXT-42";
const EVIL_HTML =
  '<p onclick="x()">hi</p><script>alert(1)</script><img src="http://tracker.test/p.gif"><img src="cid:logo@fake.test">';

function folders() {
  const msgs = [];
  for (let uid = 1; uid <= 6; uid++)
    msgs.push(
      plainMail({
        uid,
        subject: `Message ${uid}`,
        from: ["Ada Lovelace", "ada@fake.test"],
        date: `Mon, ${uid} Oct 2026 10:00:00 +0000`,
        body: uid === 5 ? SECRET_BODY : `Body ${uid}`,
        flags: uid <= 2 ? ["\\Seen"] : [],
      })
    );
  msgs.push(attachmentMail({ uid: 7, subject: "Report", date: "Tue, 6 Oct 2026 08:00:00 +0000" }));
  msgs.push(
    htmlMail({ uid: 8, subject: "News", date: "Tue, 6 Oct 2026 09:00:00 +0000", html: EVIL_HTML })
  );
  return [
    { path: "INBOX", uidValidity: 11, messages: msgs },
    { path: "Sent", attrs: ["\\Sent"], uidValidity: 12, messages: [] },
    { path: "Archive", attrs: ["\\Archive"], uidValidity: 13, messages: [] },
  ];
}

async function setup(password = TEST_PASSWORD) {
  fake = await startFakeMailbox(folders());
  started.push(fake);
  await setupWith(fake, password);
}

async function setupWith(fake: FakeMailbox, password = TEST_PASSWORD) {
  const store = createMailAccountStore({ dataDir: globalData });
  const credentials = createCredentialStore({ backend: backend(), dataDir: globalData });
  accountId = "acc-0123456789ab";
  await credentials.set(accountId, password, { fileFallbackConsent: false });
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
  const read = new MailReadService({
    accounts: store,
    credentials,
    mailbox: createNodeMailMailbox({ timeoutMs: 3000, tls: { rejectUnauthorized: false } }),
    cache: new MailCache(() => globalCache),
  });
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
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-read-"));
  globalData = join(root, "global");
  globalCache = join(root, "gcache");
  keychain = new Map();
});
afterEach(async () => {
  await Promise.all(started.splice(0).map((f) => f.close()));
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

test("folders: standard roles first in order, counts from the server, cache written", async () => {
  await setup();
  const r = await get("/folders");
  expect(r.status).toBe(200);
  const b = await json(r);
  expect(b.stale).toBe(false);
  expect(b.folders.map((f: { path: string }) => f.path)).toEqual(["INBOX", "Sent", "Archive"]);
  expect(b.folders[0]).toMatchObject({ role: "inbox", unread: 6, total: 8 });
  expect(b.folders[1].role).toBe("sent");
  expect(cacheFiles().some((f) => f.endsWith("folders.json"))).toBe(true);
});

test("messages: newest first, paged with before/nextBefore, flags and attachment marker", async () => {
  await setup();
  const p1 = await json(await get("/messages?folder=INBOX&limit=3"));
  expect(p1.headers.map((h: { uid: number }) => h.uid)).toEqual([8, 7, 6]);
  expect(p1.nextBefore).toBe(6);
  expect(p1.uidValidity).toBe(11);
  expect(p1.headers[1]).toMatchObject({ subject: "Report", hasAttachments: true, unread: true });
  const p2 = await json(await get("/messages?folder=INBOX&limit=3&before=6"));
  expect(p2.headers.map((h: { uid: number }) => h.uid)).toEqual([5, 4, 3]);
  const p3 = await json(await get("/messages?folder=INBOX&limit=3&before=3"));
  expect(p3.headers.map((h: { uid: number }) => h.uid)).toEqual([2, 1]);
  expect(p3.nextBefore).toBeNull();
  expect(p3.headers[0].unread).toBe(false);
});

test("opening an unread message sets \\Seen on the server; reopening a read one is served from the cache without connecting", async () => {
  await setup();
  const inbox = fake.folders[0] as FakeFolder;
  const r = await post("/messages/open", {
    folder: "INBOX",
    uid: 5,
    uidValidity: 11,
    unread: true,
  });
  expect(r.status).toBe(200);
  const b = await json(r);
  expect(b.seen).toBe(true);
  expect(b.message.text).toContain(SECRET_BODY);
  expect(b.message.subject).toBe("Message 5");
  expect(inbox.messages.find((m) => m.uid === 5)?.flags.has("\\Seen")).toBe(true);
  const before = fake.commands.length;
  const again = await json(
    await post("/messages/open", { folder: "INBOX", uid: 5, uidValidity: 11, unread: false })
  );
  expect(again.message.text).toContain(SECRET_BODY);
  expect(fake.commands.length).toBe(before); // no connection at all
});

test("opening with unread:false does not touch flags (EXAMINE only)", async () => {
  await setup();
  const r = await post("/messages/open", {
    folder: "INBOX",
    uid: 4,
    uidValidity: 11,
    unread: false,
  });
  expect(r.status).toBe(200);
  expect(
    (fake.folders[0] as FakeFolder).messages.find((m) => m.uid === 4)?.flags.has("\\Seen")
  ).toBe(false);
  expect(fake.commands.filter((c) => c.startsWith("UID STORE"))).toEqual([]);
});

test("HTML is delivered raw and untrusted; the server neither sanitises nor trusts it, attachments are listed", async () => {
  await setup();
  const b = await json(
    await post("/messages/open", { folder: "INBOX", uid: 8, uidValidity: 11, unread: true })
  );
  expect(b.message.html).toContain("<script>");
  expect(b.message.attachments).toEqual([
    expect.objectContaining({
      part: 0,
      contentType: "image/png",
      contentId: "logo@fake.test",
      inline: true,
    }),
  ]);
  const pdf = await json(
    await post("/messages/open", { folder: "INBOX", uid: 7, uidValidity: 11, unread: true })
  );
  expect(pdf.message.attachments).toEqual([
    expect.objectContaining({
      filename: "report.pdf",
      contentType: "application/pdf",
      inline: false,
    }),
  ]);
});

test("attachment download: octet-stream + nosniff + attachment disposition; only safe images inline", async () => {
  await setup();
  const dl = await get("/attachment?folder=INBOX&uid=7&uidValidity=11&part=0");
  expect(dl.status).toBe(200);
  expect(dl.headers.get("content-type")).toBe("application/octet-stream");
  expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="report.pdf"/);
  expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
  expect(dl.headers.get("content-security-policy")).toContain("sandbox");
  expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe("%PDF-synthetic-attachment");
  // inline=1 on a PDF is still a download
  const pdfInline = await get("/attachment?folder=INBOX&uid=7&uidValidity=11&part=0&inline=1");
  expect(pdfInline.headers.get("content-type")).toBe("application/octet-stream");
  // a PNG referenced by cid: may be inline
  const png = await get("/attachment?folder=INBOX&uid=8&uidValidity=11&part=0&inline=1");
  expect(png.headers.get("content-type")).toBe("image/png");
  expect(png.headers.get("content-disposition")).toMatch(/^inline/);
  expect((await get("/attachment?folder=INBOX&uid=8&uidValidity=11&part=9")).status).toBe(404);
});

test("cache deleted or corrupted: everything is fetched again, no data error", async () => {
  await setup();
  const open = () =>
    post("/messages/open", { folder: "INBOX", uid: 7, uidValidity: 11, unread: false });
  await get("/folders");
  await get("/messages?folder=INBOX&limit=5");
  expect((await json(await open())).message.subject).toBe("Report");
  expect(cacheFiles().length).toBeGreaterThanOrEqual(4);

  // 1. whole cache directory gone
  rmSync(join(globalCache), { recursive: true, force: true });
  expect((await json(await open())).message.subject).toBe("Report");
  expect((await get("/folders")).status).toBe(200);
  const dl = await get("/attachment?folder=INBOX&uid=7&uidValidity=11&part=0");
  expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe("%PDF-synthetic-attachment");

  // 2. every cache file garbled (truncated JSON, junk, empty)
  await get("/messages?folder=INBOX&limit=5");
  const files = cacheFiles();
  expect(files.length).toBeGreaterThanOrEqual(4);
  for (const [i, f] of files.entries()) writeFileSync(f, i % 2 ? "{ trunc" : "");
  expect((await json(await open())).message.subject).toBe("Report");
  expect((await json(await get("/messages?folder=INBOX&limit=5"))).headers).toHaveLength(5);
  expect((await json(await get("/folders"))).folders.length).toBe(3);
  const dl2 = await get("/attachment?folder=INBOX&uid=7&uidValidity=11&part=0");
  expect(Buffer.from(await dl2.arrayBuffer()).toString()).toBe("%PDF-synthetic-attachment");

  // 2b. valid message JSON but a damaged source file: the attachment is re-fetched
  const eml = cacheFiles().find((f) => f.endsWith(".eml"));
  expect(eml).toBeDefined();
  writeFileSync(eml as string, "garbage, not the mail");
  const dl3 = await get("/attachment?folder=INBOX&uid=7&uidValidity=11&part=0");
  expect(Buffer.from(await dl3.arrayBuffer()).toString()).toBe("%PDF-synthetic-attachment");

  // 3. cache path occupied by a file where a directory is needed: writes fail silently
  rmSync(join(globalCache), { recursive: true, force: true });
  mkdirSync(globalCache, { recursive: true });
  writeFileSync(join(globalCache, "mail"), "not a directory");
  expect((await json(await open())).message.subject).toBe("Report");
});

test("server unreachable: cached copies are served as stale, uncached requests fail with a code", async () => {
  await setup();
  await get("/folders");
  await get("/messages?folder=INBOX&limit=5");
  await post("/messages/open", { folder: "INBOX", uid: 7, uidValidity: 11, unread: true });
  await fake.close();
  const f = await json(await get("/folders"));
  expect(f.stale).toBe(true);
  expect(f.folders[0].path).toBe("INBOX");
  const h = await json(await get("/messages?folder=INBOX&limit=5"));
  expect(h.stale).toBe(true);
  expect(h.headers.length).toBeGreaterThan(0);
  // unread hint true + cached body + server down: still shown, flagged stale and not marked read
  const o = await json(
    await post("/messages/open", { folder: "INBOX", uid: 7, uidValidity: 11, unread: true })
  );
  expect(o).toMatchObject({ stale: true, seen: false });
  const miss = await post("/messages/open", {
    folder: "INBOX",
    uid: 3,
    uidValidity: 11,
    unread: true,
  });
  expect(miss.status).toBe(502);
  expect((await json(miss)).code).toBe("connection_refused");
});

test("wrong password is reported as auth_failed even when a cache exists (never masked as stale)", async () => {
  await setup();
  await get("/folders");
  keychain.set(accountId, "changed-elsewhere");
  const r = await get("/folders");
  expect(r.status).toBe(502);
  expect((await json(r)).code).toBe("auth_failed");
});

test("changed UIDVALIDITY: the uid no longer names the same message (409) and its cache entry is dropped", async () => {
  await setup();
  await post("/messages/open", { folder: "INBOX", uid: 5, uidValidity: 11, unread: true });
  (fake.folders[0] as FakeFolder).uidValidity = 99;
  const r = await post("/messages/open", {
    folder: "INBOX",
    uid: 5,
    uidValidity: 11,
    unread: true,
  });
  expect(r.status).toBe(409);
  expect((await json(r)).code).toBe("message_changed");
  const fresh = await json(await get("/messages?folder=INBOX&limit=2"));
  expect(fresh.uidValidity).toBe(99);
  expect(
    cacheFiles().filter(
      (f) => f.includes(`${join("", "11")}`) && f.endsWith(".json") && !f.endsWith("headers.json")
    )
  ).toEqual([]);
});

test("errors: unknown account/folder/uid, bad input; bodies never carry credentials or mail text", async () => {
  await setup();
  expect((await app.request("/api/mail/accounts/acc-ffffffffffff/folders")).status).toBe(404);
  expect((await app.request("/api/mail/accounts/..%2F..%2Fx/folders")).status).toBe(404);
  expect((await get("/messages")).status).toBe(400);
  expect((await get("/messages?folder=INBOX&limit=abc")).status).toBe(400);
  expect((await get("/messages?folder=Nope&limit=5")).status).toBe(404);
  const nf = await post("/messages/open", { folder: "INBOX", uid: 4242, unread: true });
  expect(nf.status).toBe(404);
  expect((await post("/messages/open", { folder: "INBOX", uid: 0, unread: true })).status).toBe(
    400
  );
  const text = JSON.stringify(await nf.clone().json());
  expect(text).not.toContain(TEST_PASSWORD);
  expect(text).not.toContain(SECRET_BODY);
});

test("a too large message is refused before download", async () => {
  await setup();
  const read = new MailReadService({
    accounts: createMailAccountStore({ dataDir: globalData }),
    credentials: createCredentialStore({ backend: backend(), dataDir: globalData }),
    mailbox: createNodeMailMailbox({ timeoutMs: 3000, tls: { rejectUnauthorized: false } }),
    cache: new MailCache(() => globalCache),
    maxMessageBytes: 50,
  });
  await expect(
    read.open(accountId, { folder: "INBOX", uid: 5, unread: false })
  ).rejects.toMatchObject({
    code: "too_large",
  });
});

test("deleting the account removes its mail cache (ticket 04 contract) and nothing on the server", async () => {
  await setup();
  await get("/folders");
  await post("/messages/open", { folder: "INBOX", uid: 5, uidValidity: 11, unread: true });
  expect(cacheFiles().length).toBeGreaterThan(0);
  const before = JSON.stringify(fake.folders.map((f) => f.messages.length));
  const rev = JSON.parse(readFileSync(join(globalData, "mail", "accounts.json"), "utf8")).rev;
  const del = await app.request(`/api/mail/accounts/${accountId}?rev=${rev}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  expect(cacheFiles()).toEqual([]);
  expect(JSON.stringify(fake.folders.map((f) => f.messages.length))).toBe(before);
});

test("folder tree: subfolders sit under their parent with the right depth", async () => {
  fake = await startFakeMailbox([
    { path: "INBOX", uidValidity: 1, messages: [] },
    { path: "INBOX/Projects", uidValidity: 2, messages: [] },
    { path: "Sent", attrs: ["\\Sent"], uidValidity: 3, messages: [] },
    { path: "Sent/2024", uidValidity: 4, messages: [] },
    { path: "Zeta", uidValidity: 5, messages: [] },
    { path: "Zeta/A/B", uidValidity: 6, messages: [] },
  ]);
  started.push(fake);
  await setupWith(fake);
  const b = await json(await get("/folders"));
  expect(b.folders.map((f: { path: string; depth: number }) => [f.path, f.depth])).toEqual([
    ["INBOX", 0],
    ["INBOX/Projects", 1],
    ["Sent", 0],
    ["Sent/2024", 1],
    ["Zeta", 0],
    ["Zeta/A/B", 1],
  ]);
});

test("a truncated cached source never yields partial attachment bytes", async () => {
  await setup();
  await post("/messages/open", { folder: "INBOX", uid: 7, uidValidity: 11, unread: false });
  const eml = cacheFiles().find((f) => f.endsWith("7.eml")) as string;
  const full = readFileSync(eml);
  writeFileSync(eml, full.subarray(0, full.length - 40)); // cuts into the base64 attachment
  const dl = await get("/attachment?folder=INBOX&uid=7&uidValidity=11&part=0");
  expect(Buffer.from(await dl.arrayBuffer()).toString()).toBe("%PDF-synthetic-attachment");
});

test("attachment filenames are RFC 5987 encoded, including ' ( ) *", async () => {
  fake = await startFakeMailbox([
    {
      path: "INBOX",
      uidValidity: 1,
      messages: [
        attachmentMail({
          uid: 1,
          subject: "x",
          date: "Tue, 6 Oct 2026 08:00:00 +0000",
          filename: "a'b(1)*.pdf",
        }),
      ],
    },
  ]);
  started.push(fake);
  await setupWith(fake);
  const dl = await get("/attachment?folder=INBOX&uid=1&uidValidity=1&part=0");
  expect(dl.headers.get("content-disposition")).toContain("filename*=UTF-8''a%27b%281%29%2A.pdf");
});

test("the server is asked with the cached generation when the client omits uidValidity", async () => {
  await setup();
  await get("/messages?folder=INBOX&limit=3"); // caches uidValidity 11
  (fake.folders[0] as FakeFolder).uidValidity = 99; // the mailbox was rebuilt behind our back
  const r = await post("/messages/open", { folder: "INBOX", uid: 5, unread: true });
  expect(r.status).toBe(409);
  expect(
    (fake.folders[0] as FakeFolder).messages.find((m) => m.uid === 5)?.flags.has("\\Seen")
  ).toBe(false);
});

test("an account deleted while a fetch is in flight does not get its cache recreated", async () => {
  await setup();
  const store = createMailAccountStore({ dataDir: globalData });
  const real = createNodeMailMailbox({ timeoutMs: 3000, tls: { rejectUnauthorized: false } });
  const removeAccount = async () => {
    const cur = store.read();
    await store.update(cur.rev, async () => ({ accounts: [], result: null }));
    rmSync(join(globalCache, "mail", accountId), { recursive: true, force: true });
  };
  const racing = new MailReadService({
    accounts: store,
    credentials: createCredentialStore({ backend: backend(), dataDir: globalData }),
    cache: new MailCache(() => globalCache),
    mailbox: {
      listFolders: async (t) => {
        const r = await real.listFolders(t);
        await removeAccount();
        return r;
      },
      listHeaders: real.listHeaders,
      openMessage: real.openMessage,
    },
  });
  await racing.folders(accountId);
  expect(cacheFiles()).toEqual([]);
  expect(existsSync(join(globalCache, "mail", accountId))).toBe(false);
});

test("deleting the account during headers/open/attachment fetches also leaves no cache", async () => {
  for (const op of ["headers", "open", "attachment"] as const) {
    await setup();
    const store = createMailAccountStore({ dataDir: globalData });
    const real = createNodeMailMailbox({ timeoutMs: 3000, tls: { rejectUnauthorized: false } });
    const removeAccount = async () => {
      await store.update(store.read().rev, async () => ({ accounts: [], result: null }));
    };
    const racing = new MailReadService({
      accounts: store,
      credentials: createCredentialStore({ backend: backend(), dataDir: globalData }),
      cache: new MailCache(() => globalCache),
      mailbox: {
        listFolders: real.listFolders,
        listHeaders: async (t, q) => {
          const r = await real.listHeaders(t, q);
          await removeAccount();
          return r;
        },
        openMessage: async (t, q) => {
          const r = await real.openMessage(t, q);
          await removeAccount();
          return r;
        },
      },
    });
    if (op === "headers") await racing.headers(accountId, "INBOX", undefined, 5);
    if (op === "open")
      await racing.open(accountId, { folder: "INBOX", uid: 5, uidValidity: 11, unread: true });
    if (op === "attachment")
      await racing.attachment(accountId, { folder: "INBOX", uid: 7, uidValidity: 11, part: 0 });
    expect(cacheFiles(), op).toEqual([]);
    await fake.close();
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "mail-read-"));
    globalData = join(root, "global");
    globalCache = join(root, "gcache");
    keychain = new Map();
  }
});
