import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryPaths } from "@argelanderspace/core";
import {
  createCredentialStore,
  createMailAccountStore,
  createNodeMailMailbox,
  createNodeMailOutgoing,
  type KeychainBackend,
  resolveGlobalDirs,
} from "@argelanderspace/infra";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  attachmentMail,
  type FakeFolder,
  type FakeMailbox,
  plainMail,
  startFakeMailbox,
} from "../../infra/tests/mail/fake-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "../../infra/tests/mail/fake-servers.js";
import { type RecordingSmtp, startRecordingSmtp } from "../../infra/tests/mail/fake-smtp.js";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { MailAccountService } from "../src/mail-accounts.js";
import { MailComposeService } from "../src/mail-compose.js";
import type { MailComposeServices } from "../src/mail-compose-routes.js";
import { MailOutbox } from "../src/mail-outbox.js";
import { disposeMailSendServices, MailSendService } from "../src/mail-send.js";
import { ProviderSettings } from "../src/providers.js";
import { isolatedGlobalDirs, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const ACC = "acc-0123456789ab";
const ME = "tester@fake.test";
const SECRET_SUBJECT = "SECRET-SUBJECT-77";
const SECRET_BODY = "SECRET-BODY-TEXT-99";
const UNDO = 250;

let root: string;
let globalData: string;
let globalCache: string;
let keychain: Map<string, string>;
let imap: FakeMailbox;
let smtp: RecordingSmtp;
let drafts: FakeFolder;
let sent: FakeFolder;
const keep: { close(): Promise<void> }[] = [];

const backend = (): KeychainBackend => ({
  get: (a) => keychain.get(a) ?? null,
  set: (a, p) => void keychain.set(a, p),
  delete: (a) => keychain.delete(a),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON
const json = async (r: Response): Promise<any> => r.json();
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid as number;

function mailboxes(): FakeFolder[] {
  drafts = { path: "Drafts", attrs: ["\\Drafts"], uidValidity: 31, messages: [] };
  sent = { path: "Sent", attrs: ["\\Sent"], uidValidity: 32, messages: [] };
  const original = plainMail({
    uid: 1,
    subject: "Telecon minutes",
    from: ["Ada Lovelace", "ada@fake.test"],
    to: [
      ["Tester", ME],
      ["Kofi", "kofi@fake.test"],
    ],
    date: "Thu, 1 Oct 2026 09:00:00 +0000",
    body: `Line one ${SECRET_BODY}\nLine two`,
  });
  original.source = original.source.replace(
    "Message-ID: <m1@fake.test>",
    "Message-ID: <orig-1@fake.test>\r\nReferences: <root-0@fake.test>\r\nCc: Maria <maria@fake.test>"
  );
  const mine = plainMail({
    uid: 3,
    subject: "Our question",
    from: ["Maria", ME],
    to: [["Ada Lovelace", "ada@fake.test"]],
    date: "Sat, 3 Oct 2026 08:00:00 +0000",
    body: "Could you check?",
  });
  mine.source = mine.source.replace(
    "Message-ID: <m3@fake.test>",
    "Message-ID: <mine-3@fake.test>\r\nIn-Reply-To: <earlier-9@fake.test>"
  );
  const withFile = attachmentMail({
    uid: 2,
    subject: "Report",
    date: "Fri, 2 Oct 2026 08:00:00 +0000",
  });
  return [{ path: "INBOX", uidValidity: 30, messages: [original, withFile, mine] }, drafts, sent];
}

interface Rig {
  store: ReturnType<typeof createMailAccountStore>;
  cache: string;
  app: ReturnType<typeof createApp>;
  compose: MailComposeService;
  send: MailSendService;
  outbox: MailOutbox;
  makeSend(opts?: {
    pid?: number;
    alive?: (pid: number) => boolean;
    undoMs?: number;
  }): MailSendService;
}

async function rig(
  preset: "custom" | "gmail" = "custom",
  windowMs = UNDO,
  extra: { serverSavesSent?: boolean } = {}
): Promise<Rig> {
  const cache = globalCache; // captured: a leaked timer of an earlier test must not write into the next test's cache
  imap = await startFakeMailbox(mailboxes());
  smtp = await startRecordingSmtp();
  keep.push(imap, smtp);
  const store = createMailAccountStore({ dataDir: globalData });
  const credentials = createCredentialStore({ backend: backend(), dataDir: globalData });
  await credentials.set(ACC, TEST_PASSWORD, { fileFallbackConsent: false });
  await store.update(0, async () => ({
    accounts: [
      {
        id: ACC as never,
        displayName: "Test Person",
        address: ME,
        preset,
        imap: { host: "127.0.0.1", port: imap.port, security: "tls" },
        smtp: { host: "127.0.0.1", port: smtp.port, security: "tls" },
        imapUser: TEST_USER,
        smtpUser: TEST_USER,
        credentialRef: ACC as never,
        credentialProtection: "keychain",
        ...extra,
      },
    ],
    result: null,
  }));
  const tls = { rejectUnauthorized: false };
  const outgoing = createNodeMailOutgoing({ timeoutMs: 3000, tls });
  const compose = new MailComposeService({
    accounts: store,
    credentials,
    mailbox: createNodeMailMailbox({ timeoutMs: 3000, tls }),
    outgoing,
    cacheDir: () => cache,
  });
  const makeSend = (o: { pid?: number; alive?: (pid: number) => boolean; undoMs?: number } = {}) =>
    new MailSendService({
      compose,
      outgoing,
      outbox: new MailOutbox(() => cache, o.alive),
      undoMs: o.undoMs ?? windowMs,
      ...(o.pid !== undefined ? { pid: o.pid } : {}),
    });
  const send = makeSend();
  const services: MailComposeServices = { compose, send };
  const accounts = new MailAccountService({
    store,
    credentials,
    protocol: {
      verifyImapLogin: async () => ({ ok: true }),
      verifySmtpLogin: async () => ({ ok: true }),
    },
    cacheDir: () => cache,
  });
  const app = createApp({
    paths: libraryPaths(join(root, "data")),
    statusDir: join(root, "status"),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(root, "jobs") }),
    mailAccounts: accounts,
    mailCompose: services,
  });
  return { store, cache, app, compose, send, outbox: new MailOutbox(() => cache), makeSend };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mail-send-"));
  globalData = join(root, "global");
  globalCache = join(root, "gcache");
  keychain = new Map();
});
afterEach(async () => {
  await Promise.all(keep.splice(0).map((f) => f.close()));
});

const base = `/api/mail/compose/accounts/${ACC}`;
const call = async (
  r: Rig,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
) =>
  r.app.request(`${base}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : {
          body:
            typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body),
        }),
    headers: {
      ...(typeof body === "object" && !(body instanceof Uint8Array)
        ? { "Content-Type": "application/json" }
        : {}),
      ...headers,
    },
  });

const draftBody = (over: Record<string, unknown> = {}) => ({
  messageId: "<draft-aaa@fake.test>",
  inReplyTo: null,
  references: [],
  to: "Ada <ada@fake.test>",
  cc: "",
  bcc: "hidden@fake.test",
  subject: SECRET_SUBJECT,
  text: SECRET_BODY,
  attachments: [] as string[],
  ...over,
});
const startSend = (r: Rig, draft = draftBody(), sendId = uuid()) =>
  call(r, "POST", "/send", { sendId, draft });
const getStatus = async (r: Rig, id: string) => json(await call(r, "GET", `/sends/${id}`));

// ---- initial content --------------------------------------------------------

test("reply threads to the original, quotes it and leaves the sender out of reply-all", async () => {
  const r = await rig();
  const init = (mode: string, locale = "en") =>
    call(r, "POST", "/init", { mode, folder: "INBOX", uid: 1, locale }).then(json);

  const reply = (await init("reply")).draft;
  expect(reply.to).toBe("Ada Lovelace <ada@fake.test>");
  expect(reply.cc).toBe("");
  expect(reply.subject).toBe("Re: Telecon minutes");
  expect(reply.inReplyTo).toBe("<orig-1@fake.test>");
  expect(reply.references).toEqual(["<root-0@fake.test>", "<orig-1@fake.test>"]);
  expect(reply.text).toMatch(/^\n\nOn .*Ada Lovelace <ada@fake\.test> wrote:\n> Line one /);
  expect(reply.text).toContain("> Line two");
  expect(reply.messageId).toMatch(/^<[0-9a-f-]{36}@fake\.test>$/);

  const all = (await init("replyAll", "zh-CN")).draft;
  expect(all.to).toBe("Ada Lovelace <ada@fake.test>, Kofi <kofi@fake.test>"); // not tester@fake.test
  expect(all.cc).toBe("Maria <maria@fake.test>");
  expect(all.text).toContain("写道：");

  const fwd = await init("forward");
  expect(fwd.draft.subject).toBe("Fwd: Telecon minutes");
  expect(fwd.draft.to).toBe("");
  expect(fwd.draft.inReplyTo).toBeNull();
  expect(fwd.draft.text).toContain("---------- Forwarded message ----------");
  expect(fwd.draft.text).toContain("Subject: Telecon minutes");
  expect(fwd.draft.text).toContain(SECRET_BODY);

  // A subject that already starts with Re: is not prefixed twice.
  const sameFamily = await call(r, "POST", "/init", {
    mode: "reply",
    folder: "INBOX",
    uid: 2,
    locale: "en",
  }).then(json);
  expect(sameFamily.draft.subject).toBe("Re: Report");
});

test("forwarding stages the original's attachments and they go out with the message", async () => {
  const r = await rig();
  const fwd = await call(r, "POST", "/init", {
    mode: "forward",
    folder: "INBOX",
    uid: 2,
    locale: "en",
  }).then(json);
  expect(fwd.attachments).toHaveLength(1);
  expect(fwd.attachments[0]).toMatchObject({
    filename: "report.pdf",
    contentType: "application/pdf",
  });
  expect(fwd.draft.attachments).toEqual([fwd.attachments[0].id]);
  const res = await startSend(r, { ...fwd.draft, to: "ada@fake.test", bcc: "" });
  expect(res.status).toBe(202);
  await r.send.settled((await json(res)).sendId);
  expect(smtp.messages).toHaveLength(1);
  expect(smtp.messages[0]?.raw).toMatch(/filename="?report\.pdf"?/);
  expect(smtp.messages[0]?.raw).toContain(
    Buffer.from("%PDF-synthetic-attachment").toString("base64")
  );
});

test("editing a draft restores its recipients (Bcc included), body and thread", async () => {
  const r = await rig();
  const up = await json(
    await call(r, "POST", "/attachments", new Uint8Array([9, 8, 7]), {
      "X-Mail-Filename": "kept.bin",
      "Content-Type": "application/octet-stream",
    })
  );
  const saved = await call(
    r,
    "PUT",
    "/draft",
    draftBody({
      inReplyTo: "<orig-1@fake.test>",
      references: ["<orig-1@fake.test>"],
      attachments: [up.id],
    })
  );
  expect(saved.status).toBe(200);
  const uid = (await json(saved)).uid;
  const init = await call(r, "POST", "/init", {
    mode: "draft",
    folder: "Drafts",
    uid,
    locale: "en",
  }).then(json);
  expect(init.draft).toMatchObject({
    messageId: "<draft-aaa@fake.test>",
    to: "Ada <ada@fake.test>",
    bcc: "hidden@fake.test",
    subject: SECRET_SUBJECT,
    inReplyTo: "<orig-1@fake.test>",
    references: ["<orig-1@fake.test>"],
  });
  expect(init.draft.text.trim()).toBe(SECRET_BODY);
  // The draft's attachment comes back staged, so saving the edited draft keeps it.
  expect(init.attachments).toHaveLength(1);
  expect(init.attachments[0]).toMatchObject({ filename: "kept.bin", size: 3 });
  expect(init.draft.attachments).toEqual([init.attachments[0].id]);
  expect((await call(r, "PUT", "/draft", init.draft)).status).toBe(200);
  expect(drafts.messages).toHaveLength(1);
});

// ---- drafts ---------------------------------------------------------------------

test("saving a draft twice leaves exactly one copy in the server's Drafts folder, with attachments", async () => {
  const r = await rig();
  const up = await call(r, "POST", "/attachments", new Uint8Array([1, 2, 3, 4]), {
    "X-Mail-Filename": encodeURIComponent("数据 file.bin"),
    "Content-Type": "application/octet-stream",
  });
  expect(up.status).toBe(201);
  const att = await json(up);
  expect(att).toMatchObject({ filename: "数据 file.bin", size: 4 });
  expect((await call(r, "PUT", "/draft", draftBody({ attachments: [att.id] }))).status).toBe(200);
  expect(
    (await call(r, "PUT", "/draft", draftBody({ subject: "second", attachments: [att.id] }))).status
  ).toBe(200);
  expect(drafts.messages.map((m) => m.subject)).toEqual(["second"]);
  expect(drafts.messages[0]?.flags.has("\\Draft")).toBe(true);
  expect(drafts.messages[0]?.source).toContain("Bcc: hidden@fake.test");
  expect(smtp.messages).toHaveLength(0);

  const gone = await call(r, "POST", "/draft/discard", draftBody({ attachments: [att.id] }));
  expect(gone.status).toBe(200);
  expect(drafts.messages).toHaveLength(0);
  expect(r.compose.readStaged(ACC, att.id)).toBeNull();
});

test("a failing draft save reports a code and nothing leaks into the response", async () => {
  const r = await rig();
  imap.denyAppend = true;
  const res = await call(r, "PUT", "/draft", draftBody());
  expect(res.status).toBeGreaterThanOrEqual(400);
  const text = await res.text();
  expect(text).not.toContain(SECRET_SUBJECT);
  expect(text).not.toContain(SECRET_BODY);
  expect(text).not.toContain(TEST_PASSWORD);
});

test("attachments: oversized upload refused, a missing staged file stops the send before any window opens", async () => {
  const r = await rig();
  const big = await call(r, "POST", "/attachments", new Uint8Array(41 * 1024 * 1024), {
    "Content-Type": "application/octet-stream",
  });
  expect(big.status).toBe(413);
  const missing = await startSend(r, draftBody({ attachments: ["0".repeat(32)] }));
  expect(missing.status).toBe(409);
  expect((await json(missing)).code).toBe("attachment_missing");
  expect(drafts.messages).toHaveLength(0);
});

// ---- sending -----------------------------------------------------------------------

test("send: the window keeps SMTP idle, the final message sits in Drafts, then it is sent once, copied to Sent and the draft removed", async () => {
  const r = await rig();
  const res = await startSend(r);
  expect(res.status).toBe(202);
  const st = await json(res);
  expect(st).toMatchObject({ state: "pending", ownedElsewhere: false });
  expect(st.remainingMs).toBeGreaterThan(0);
  expect(st.remainingMs).toBeLessThanOrEqual(UNDO);
  // Inside the window: safe on the server, nothing sent.
  expect(drafts.messages).toHaveLength(1);
  expect(smtp.messages).toHaveLength(0);
  expect(smtp.dataStarted.count).toBe(0);

  await r.send.settled(st.sendId);
  const done = await getStatus(r, st.sendId);
  expect(done).toMatchObject({ state: "sent", sentCopy: "saved", draftKept: false, rejected: 0 });
  expect(smtp.messages).toHaveLength(1);
  expect(smtp.messages[0]?.to.sort()).toEqual(["ada@fake.test", "hidden@fake.test"]);
  expect(smtp.messages[0]?.raw).not.toContain("hidden@fake.test");
  expect(smtp.messages[0]?.raw).toContain("Message-ID: <draft-aaa@fake.test>");
  expect(drafts.messages).toHaveLength(0);
  expect(sent.messages).toHaveLength(1);
  expect(sent.messages[0]?.source).toContain("Bcc: hidden@fake.test");
  expect(r.outbox.hasClaim(ACC, "<draft-aaa@fake.test>")).toBe(false);
});

test("a provider that saves Sent itself (Gmail) gets no second copy", async () => {
  const r = await rig("gmail");
  const st = await json(await startSend(r));
  await r.send.settled(st.sendId);
  expect(await getStatus(r, st.sendId)).toMatchObject({
    state: "sent",
    sentCopy: "by_server",
    draftKept: false,
  });
  expect(smtp.messages).toHaveLength(1);
  expect(sent.messages).toHaveLength(0);
  expect(imap.commands.filter((c) => c.startsWith("APPEND Sent"))).toEqual([]);
});

test("undo inside the window: nothing is ever sent, the draft is intact, and the same draft can then be sent exactly once", async () => {
  const r = await rig();
  const st = await json(await startSend(r));
  const undo = await call(r, "POST", `/sends/${st.sendId}/undo`);
  expect(undo.status).toBe(200);
  expect((await json(undo)).state).toBe("cancelled");
  await sleep(UNDO + 200);
  expect(smtp.dataStarted.count).toBe(0);
  expect(smtp.messages).toHaveLength(0);
  expect(drafts.messages).toHaveLength(1);
  expect(sent.messages).toHaveLength(0);
  // Undo twice, or after the fact, is refused.
  expect((await call(r, "POST", `/sends/${st.sendId}/undo`)).status).toBe(409);

  const again = await json(await startSend(r)); // a new send id for the same draft
  await r.send.settled(again.sendId);
  expect(smtp.messages).toHaveLength(1);
  expect(drafts.messages).toHaveLength(0);
});

test("undo after the window closed is refused; it cannot stop a send that already started", async () => {
  const r = await rig();
  smtp.behavior.dataDelayMs = 600;
  const st = await json(await startSend(r));
  await sleep(UNDO + 150);
  expect((await getStatus(r, st.sendId)).state).toBe("sending");
  const late = await call(r, "POST", `/sends/${st.sendId}/undo`);
  expect(late.status).toBe(409);
  expect((await json(late)).code).toBe("not_pending");
  await r.send.settled(st.sendId);
  expect(smtp.messages).toHaveLength(1);
});

test("no duplicate send: a repeated sendId is the same send, a second send id for the pending draft is refused", async () => {
  const r = await rig();
  const id = uuid();
  const [a, b] = await Promise.all([startSend(r, draftBody(), id), startSend(r, draftBody(), id)]);
  expect([a.status, b.status]).toEqual([202, 202]);
  expect((await json(a)).sendId).toBe(id);
  const rival = await startSend(r, draftBody(), uuid());
  expect(rival.status).toBe(409);
  expect((await json(rival)).code).toBe("already_pending");
  await r.send.settled(id);
  expect(smtp.messages).toHaveLength(1);
  expect(smtp.dataStarted.count).toBe(1);
});

test("SMTP refuses: the send fails with a code, the draft stays in Drafts, no Sent copy, nothing leaks, and a retry works", async () => {
  const r = await rig();
  smtp.behavior.rejectRecipients = ["ada@fake.test", "hidden@fake.test"];
  const st = await json(await startSend(r));
  await r.send.settled(st.sendId);
  const failed = await getStatus(r, st.sendId);
  expect(failed).toMatchObject({ state: "failed", code: "recipient_rejected", draftKept: true });
  expect(drafts.messages).toHaveLength(1);
  expect(sent.messages).toHaveLength(0);
  expect(smtp.messages).toHaveLength(0);
  expect(JSON.stringify(failed)).not.toContain(SECRET_BODY);
  expect(JSON.stringify(failed)).not.toContain(TEST_PASSWORD);
  // It is listed as needing attention, and the claim was released so the user can fix and resend.
  const listed = await json(await r.app.request("/api/mail/compose/outbox"));
  expect(listed.sends.map((s: { sendId: string; state: string }) => [s.sendId, s.state])).toEqual([
    [st.sendId, "failed"],
  ]);
  smtp.behavior.rejectRecipients = [];
  const retry = await json(await startSend(r));
  await r.send.settled(retry.sendId);
  expect(smtp.messages).toHaveLength(1);
});

test("a connection lost after the message was handed over is reported as unknown, never retried", async () => {
  const r = await rig();
  smtp.behavior.dropAfterData = true;
  const st = await json(await startSend(r));
  await r.send.settled(st.sendId);
  const s = await getStatus(r, st.sendId);
  expect(s.state).toBe("unknown");
  expect(s.code).toBe("outcome_unknown");
  expect(s.draftKept).toBe(true);
  expect(drafts.messages).toHaveLength(1);
  await sleep(300);
  expect(smtp.dataStarted.count).toBe(1);
});

test("invalid input is refused before anything is stored: no recipient, bad address", async () => {
  const r = await rig();
  const none = await startSend(r, draftBody({ to: "", bcc: "" }));
  expect(none.status).toBe(400);
  expect((await json(none)).code).toBe("no_recipients");
  const bad = await startSend(r, draftBody({ to: "not-an-address" }));
  expect((await json(bad)).code).toBe("invalid_recipient");
  expect(drafts.messages).toHaveLength(0);
  expect(r.outbox.accountIds()).toEqual([]);
});

test("no window is opened when the draft cannot be stored on the server", async () => {
  const r = await rig();
  imap.denyAppend = true;
  const res = await startSend(r);
  expect(res.status).toBeGreaterThanOrEqual(400);
  await sleep(UNDO + 150);
  expect(smtp.dataStarted.count).toBe(0);
  expect(r.outbox.hasClaim(ACC, "<draft-aaa@fake.test>")).toBe(false);
});

// ---- restart and several server processes ---------------------------------------

test("the server exits inside the window: back in Drafts, honestly reported after restart, never sent", async () => {
  const r = await rig();
  // The first "process" has a pid that no longer exists once it is gone.
  const dead = deadPid();
  const first = r.makeSend({ pid: dead, undoMs: 300 });
  const st = await first.start(ACC, { sendId: uuid(), draft: draftBody() as never });
  expect(st.state).toBe("pending");
  first.dispose(); // the process ends: its timer never fires

  // "Restart": a fresh service over the same global cache.
  const second = r.makeSend();
  const after = second.status(ACC, st.sendId);
  expect(after).toMatchObject({ state: "interrupted", draftKept: true, ownedElsewhere: false });
  expect(second.list().map((s) => s.state)).toEqual(["interrupted"]);
  expect(() => second.cancel(ACC, st.sendId)).toThrowError(/not_pending/);
  await sleep(500);
  expect(smtp.dataStarted.count).toBe(0); // no automatic resend
  expect(drafts.messages).toHaveLength(1); // the mail is in Drafts
  expect(sent.messages).toHaveLength(0);

  // The stale claim of the dead process does not block sending the draft again, which then happens once.
  const again = await second.start(ACC, { sendId: uuid(), draft: draftBody() as never });
  await second.settled(again.sendId);
  expect(smtp.messages).toHaveLength(1);
  second.dismiss(ACC, st.sendId);
  // Only the later, completed send is still listed (a finished send stays until acknowledged).
  expect(second.list().map((s) => s.state)).toEqual(["sent"]);
});

test("the server dies after the window closed: reported as outcome unknown, still not resent", async () => {
  const r = await rig();
  const dead = deadPid();
  const first = r.makeSend({ pid: dead, undoMs: 50 });
  smtp.behavior.dataDelayMs = 5000; // the SMTP answer never comes within the test
  const st = await first.start(ACC, { sendId: uuid(), draft: draftBody() as never });
  await sleep(250);
  expect(first.status(ACC, st.sendId).state).toBe("sending");
  const second = r.makeSend();
  const after = second.status(ACC, st.sendId);
  expect(after).toMatchObject({ state: "unknown", draftKept: true });
  expect(smtp.dataStarted.count).toBe(1);
  smtp.behavior.dataDelayMs = 0;
});

test("two server processes: only the owner can undo or send; the other can only watch and cannot start the same draft", async () => {
  const r = await rig();
  // The owner is a different (live) process: the parent of this test worker.
  const a = r.makeSend({ pid: process.ppid, undoMs: UNDO });
  const b = r.makeSend({ undoMs: UNDO });
  const st = await a.start(ACC, { sendId: uuid(), draft: draftBody() as never });
  const watching = b.status(ACC, st.sendId);
  expect(watching).toMatchObject({ state: "pending", ownedElsewhere: true });
  expect(() => b.cancel(ACC, st.sendId)).toThrowError(/owned_elsewhere/);
  expect(() => b.dismiss(ACC, st.sendId)).toThrowError(/owned_elsewhere/);
  await expect(b.start(ACC, { sendId: uuid(), draft: draftBody() as never })).rejects.toMatchObject(
    {
      code: "already_pending",
    }
  );
  await a.settled(st.sendId);
  expect(smtp.messages).toHaveLength(1);
  expect(b.status(ACC, st.sendId).state).toBe("sent");
});

test("deleting the account's cache while a send is pending does not lose or duplicate the mail", async () => {
  const r = await rig();
  const st = await json(await startSend(r));
  rmSync(join(globalCache, "mail"), { recursive: true, force: true });
  await r.send.settled(st.sendId);
  expect(smtp.messages).toHaveLength(1);
  expect(drafts.messages).toHaveLength(0);
});

// ---- review round 1 -----------------------------------------------------------------

test("graceful shutdown: a window that is still open never ends into a send, the mail is interrupted and back in Drafts", async () => {
  const r = await rig();
  const st = await json(await startSend(r));
  r.send.dispose();
  // Immediately interrupted, not "pending until the process is gone".
  expect(await getStatus(r, st.sendId)).toMatchObject({ state: "interrupted", draftKept: true });
  await sleep(UNDO + 200);
  expect(smtp.dataStarted.count).toBe(0);
  expect(drafts.messages).toHaveLength(1);
  expect(r.outbox.hasClaim(ACC, "<draft-aaa@fake.test>")).toBe(false);
  // A stopped service takes no new sends either.
  const again = await startSend(r, draftBody(), uuid());
  expect(again.status).toBeGreaterThanOrEqual(400);
  expect(smtp.dataStarted.count).toBe(0);
});

test("server.close() disposes the default mail services first, synchronously, before slower shutdown steps finish", async () => {
  const r = await rig();
  const registered = new MailSendService({
    compose: r.compose,
    outgoing: createNodeMailOutgoing({ timeoutMs: 3000, tls: { rejectUnauthorized: false } }),
    outbox: new MailOutbox(() => r.cache),
    undoMs: 400,
    registerForShutdown: true,
  });
  const st = await registered.start(ACC, { sendId: uuid(), draft: draftBody() as never });
  const { createServer } = await import("../src/server.js");
  const server = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir: makeDataDir(),
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    providerSettings: new ProviderSettings(),
    deps: { makeSources: () => stubSources() },
  });
  await server.ready();
  const closing = server.close(); // not awaited: the window below ends while the rest is still shutting down
  expect(registered.status(ACC, st.sendId).state).toBe("interrupted");
  await closing;
  await sleep(600);
  expect(smtp.dataStarted.count).toBe(0);
  expect(drafts.messages).toHaveLength(1);
  disposeMailSendServices();
});

test("a draft in its undo window is frozen: saving, discarding and opening it are refused until it is undone", async () => {
  const r = await rig("custom", 5000);
  const st = await json(await startSend(r));
  const save = await call(r, "PUT", "/draft", draftBody({ subject: "newer edit" }));
  expect(save.status).toBe(409);
  expect((await json(save)).code).toBe("already_pending");
  expect((await call(r, "POST", "/draft/discard", draftBody())).status).toBe(409);
  const open = await call(r, "POST", "/init", {
    mode: "draft",
    folder: "Drafts",
    uid: drafts.messages[0]?.uid,
    locale: "en",
  });
  expect(open.status).toBe(409);
  expect(drafts.messages.map((m) => m.subject)).toEqual([SECRET_SUBJECT]); // the version being sent is intact
  const undone = await call(r, "POST", `/sends/${st.sendId}/undo`);
  expect([undone.status, await undone.text()]).toEqual([200, expect.any(String)]);
  expect((await call(r, "PUT", "/draft", draftBody({ subject: "newer edit" }))).status).toBe(200);
  expect(drafts.messages.map((m) => m.subject)).toEqual(["newer edit"]);
});

test("if the `sending` marker cannot be written, nothing is sent", async () => {
  const r = await rig();
  class NoSendingMarker extends MailOutbox {
    override writeStrict(m: Parameters<MailOutbox["writeStrict"]>[0]): void {
      if (m.state === "sending") throw new Error("disk full");
      super.writeStrict(m);
    }
  }
  const cache = r.cache;
  const svc = new MailSendService({
    compose: r.compose,
    outgoing: createNodeMailOutgoing({ timeoutMs: 3000, tls: { rejectUnauthorized: false } }),
    outbox: new NoSendingMarker(() => cache),
    undoMs: 100,
  });
  const st = await svc.start(ACC, { sendId: uuid(), draft: draftBody() as never });
  await svc.settled(st.sendId);
  expect(svc.status(ACC, st.sendId)).toMatchObject({
    state: "failed",
    code: "storage",
    draftKept: true,
  });
  expect(smtp.dataStarted.count).toBe(0);
  expect(drafts.messages).toHaveLength(1);
});

test("claim files: a fresh unreadable claim is presumed to be mid-creation, an old one is garbage; the in-process guard survives a deleted cache", async () => {
  const r = await rig();
  const id = "<draft-aaa@fake.test>";
  const claimFile = join(
    globalCache,
    "mail",
    ACC,
    "outbox",
    `claim-${createHash("sha256").update(id).digest("hex").slice(0, 32)}.json`
  );
  mkdirSync(join(claimFile, ".."), { recursive: true });
  writeFileSync(claimFile, ""); // another process created it a moment ago and has not written yet
  const blocked = await startSend(r);
  expect(blocked.status).toBe(409);
  const old = new Date(Date.now() - 60_000);
  utimesSync(claimFile, old, old);
  const ok = await json(await startSend(r));
  expect(ok.state).toBe("pending");
  // The cache directory is wiped while the window is open: the claim file is gone, the guard in memory is not.
  rmSync(join(globalCache, "mail"), { recursive: true, force: true });
  const second = await startSend(r, draftBody(), uuid());
  expect(second.status).toBe(409);
  await r.send.settled(ok.sendId);
  expect(smtp.messages).toHaveLength(1);
});

test("a send that finished while nobody was looking is still reported, then forgotten once acknowledged", async () => {
  const r = await rig();
  const st = await json(await startSend(r));
  await r.send.settled(st.sendId);
  const listed = await json(await r.app.request("/api/mail/compose/outbox"));
  expect(listed.sends.map((x: { sendId: string; state: string }) => [x.sendId, x.state])).toEqual([
    [st.sendId, "sent"],
  ]);
  expect((await call(r, "DELETE", `/sends/${st.sendId}`)).status).toBe(200);
  expect(r.send.list()).toEqual([]);
});

test("a pid that was reused by another life of this process does not make a dead owner look alive", async () => {
  const r = await rig();
  const stale = r.makeSend({ pid: process.pid });
  const marker = {
    version: 1 as const,
    sendId: uuid(),
    accountId: ACC as never,
    messageId: "<ghost@fake.test>",
    subject: "ghost",
    state: "pending" as const,
    createdAt: Date.now(),
    deadlineAt: Date.now() + 5000,
    ownerPid: process.pid,
    ownerBoot: "an-earlier-life",
    code: null,
    ambiguous: false,
    sentCopy: null,
    draftKept: true,
    rejected: 0,
  };
  r.outbox.writeStrict(marker);
  expect(stale.status(ACC, marker.sendId).state).toBe("interrupted"); // same pid, different boot id
});

test("an account deleted while a send is being prepared gets neither a marker nor its cache directory back", async () => {
  const r = await rig();
  await r.store.update(1, async () => ({ accounts: [], result: null }));
  const res = await startSend(r);
  expect(res.status).toBe(404);
  expect(r.outbox.accountIds()).toEqual([]);
  expect(smtp.dataStarted.count).toBe(0);
});

test("replying to a message we sent goes to its recipients; References fall back to In-Reply-To", async () => {
  const r = await rig();
  const init = await call(r, "POST", "/init", {
    mode: "reply",
    folder: "INBOX",
    uid: 3,
    locale: "en",
  }).then(json);
  expect(init.draft.to).toBe("Ada Lovelace <ada@fake.test>");
  expect(init.draft.inReplyTo).toBe("<mine-3@fake.test>");
  expect(init.draft.references).toEqual(["<earlier-9@fake.test>", "<mine-3@fake.test>"]);
});

test("input checks: control characters in a folder name or Message-ID are refused", async () => {
  const r = await rig();
  expect(
    (
      await call(r, "POST", "/init", {
        mode: "reply",
        folder: "INBOX\u0000x",
        uid: 1,
        locale: "en",
      })
    ).status
  ).toBe(400);
  expect(
    (await call(r, "PUT", "/draft", draftBody({ messageId: "<a\u0001b@fake.test>" }))).status
  ).toBe(400);
});

test("createServer never sweeps a global cache by itself; the sweep runs only when a directory is passed in explicitly", async () => {
  // The place the product resolves as the global cache by default (a throwaway one in tests): the default server
  // leaves even that alone.
  const cache = resolveGlobalDirs().cacheDir;
  const staged = join(cache, "mail", "_staged");
  mkdirSync(staged, { recursive: true });
  const old = join(staged, `${"b".repeat(32)}.bin`);
  writeFileSync(old, "x");
  const ancient = new Date(Date.now() - 30 * 24 * 3600 * 1000);
  utimesSync(old, ancient, ancient);
  const { createServer } = await import("../src/server.js");
  const opts = {
    globalDirs: isolatedGlobalDirs(),
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    providerSettings: new ProviderSettings(),
    deps: { makeSources: () => stubSources() },
  };
  const plain = createServer({ ...opts, dataDir: makeDataDir() });
  await plain.ready();
  await plain.close();
  expect(existsSync(old)).toBe(true);
  const swept = createServer({ ...opts, dataDir: makeDataDir(), sweepMailStagingIn: cache });
  await swept.ready();
  await swept.close();
  expect(existsSync(old)).toBe(false);
});

// ---- review round 2 -----------------------------------------------------------------

test("the same sendId is answered from the disk marker too, not only from this process's memory", async () => {
  const r = await rig("custom", 3000);
  const a = r.makeSend({ pid: process.ppid });
  const b = r.makeSend({ undoMs: 3000 });
  const id = uuid();
  await a.start(ACC, { sendId: id, draft: draftBody() as never });
  const again = await b.start(ACC, { sendId: id, draft: draftBody() as never });
  expect(again).toMatchObject({ sendId: id, state: "pending", ownedElsewhere: true });
  a.dispose();
  expect(smtp.dataStarted.count).toBe(0);
});

test("a sent mail with news for the user outlives the plain sweep; a plain one does not", async () => {
  const r = await rig();
  const mk = (over: Record<string, unknown>) => ({
    version: 1 as const,
    sendId: uuid(),
    accountId: ACC as never,
    messageId: "<x@fake.test>",
    subject: "s",
    state: "sent" as const,
    createdAt: Date.now() - 3 * 3600 * 1000,
    deadlineAt: Date.now() - 3 * 3600 * 1000,
    ownerPid: process.pid,
    ownerBoot: "b",
    code: null,
    ambiguous: false,
    sentCopy: "saved" as const,
    draftKept: false,
    rejected: 0,
    ...over,
  });
  const plain = mk({});
  const noCopy = mk({ sentCopy: "failed", draftKept: true });
  const refused = mk({ rejected: 2 });
  const leftover = mk({ draftKept: true });
  for (const m of [plain, noCopy, refused, leftover]) r.outbox.writeStrict(m);
  r.outbox.sweep(ACC, 3600 * 1000, 30 * 24 * 3600 * 1000, { pid: process.pid, boot: "me" });
  const left = r.outbox
    .list(ACC)
    .map((m) => m.sendId)
    .sort();
  expect(left).toEqual([noCopy.sendId, refused.sendId, leftover.sendId].sort());
});

test("shutdown that begins while the draft is being stored opens no window and says interrupted", async () => {
  const r = await rig();
  const real = createNodeMailOutgoing({ timeoutMs: 3000, tls: { rejectUnauthorized: false } });
  let enter: () => void = () => {};
  const entered = new Promise<void>((res) => {
    enter = res;
  });
  let proceed: () => void = () => {};
  const gate = new Promise<void>((res) => {
    proceed = res;
  });
  const slow = {
    ...real,
    saveDraft: async (
      t: Parameters<typeof real.saveDraft>[0],
      q: Parameters<typeof real.saveDraft>[1]
    ) => {
      enter();
      await gate;
      return real.saveDraft(t, q);
    },
  };
  const svc = new MailSendService({
    compose: r.compose,
    outgoing: slow,
    outbox: new MailOutbox(() => r.cache),
    undoMs: 100,
  });
  const started = svc.start(ACC, { sendId: uuid(), draft: draftBody() as never });
  await entered;
  svc.dispose();
  proceed();
  const st = await started;
  expect(st.state).toBe("interrupted");
  expect(r.outbox.hasClaim(ACC, "<draft-aaa@fake.test>")).toBe(false);
  await sleep(300);
  expect(smtp.dataStarted.count).toBe(0);
  expect(drafts.messages).toHaveLength(1); // stored, safe, never sent
});

// ---- review round 3 -----------------------------------------------------------------

test("a Message-ID that went out cannot go out again: a new send id is refused (also from another process and after the result was acknowledged), and it cannot be saved back into Drafts", async () => {
  const r = await rig();
  const first = await json(await startSend(r));
  await r.send.settled(first.sendId);
  expect(smtp.messages).toHaveLength(1);
  // The page acknowledged the result: the marker is gone, the guard is not.
  expect((await call(r, "DELETE", `/sends/${first.sendId}`)).status).toBe(200);

  // The answer to the first request was lost; the user edits a word and presses Send again.
  const again = await startSend(r, draftBody({ text: `${SECRET_BODY} (typo fixed)` }), uuid());
  expect(again.status).toBe(409);
  const body = await json(again);
  expect(body.code).toBe("already_sent");
  expect(JSON.stringify(body)).not.toContain(SECRET_BODY);
  // Another server process (its own outbox, no shared memory) refuses it as well.
  const other = r.makeSend({ pid: process.ppid });
  await expect(
    other.start(ACC, { sendId: uuid(), draft: draftBody() as never })
  ).rejects.toMatchObject({
    code: "already_sent",
  });
  // An open composer in another tab cannot put the sent message back into Drafts.
  const save = await call(r, "PUT", "/draft", draftBody());
  expect(save.status).toBe(409);
  expect((await json(save)).code).toBe("already_sent");
  expect(drafts.messages).toHaveLength(0);
  await sleep(UNDO + 200);
  expect(smtp.dataStarted.count).toBe(1);
  expect(smtp.messages).toHaveLength(1);
  // A different message is not affected; the claim of the refused attempts was released.
  expect(r.outbox.hasClaim(ACC, "<draft-aaa@fake.test>")).toBe(false);
  const fresh = await json(await startSend(r, draftBody({ messageId: "<draft-bbb@fake.test>" })));
  await r.send.settled(fresh.sendId);
  expect(smtp.messages).toHaveLength(2);
});

test("the sent guard survives a deleted cache inside the process, and only a failed or undone send leaves the Message-ID sendable", async () => {
  const r = await rig();
  smtp.behavior.rejectRecipients = ["ada@fake.test", "hidden@fake.test"];
  const failed = await json(await startSend(r));
  await r.send.settled(failed.sendId);
  smtp.behavior.rejectRecipients = [];
  const ok = await json(await startSend(r)); // a definite failure leaves it sendable
  await r.send.settled(ok.sendId);
  expect(smtp.messages).toHaveLength(1);
  rmSync(join(globalCache, "mail"), { recursive: true, force: true });
  const res = await startSend(r);
  expect(res.status).toBe(409);
  expect((await json(res)).code).toBe("already_sent");
  expect(smtp.messages).toHaveLength(1);
});

test("the sent guard is kept for a week and then swept with the other old markers", async () => {
  const r = await rig();
  const self = { pid: process.pid, boot: "me" };
  let now = Date.now();
  const outbox = new MailOutbox(
    () => r.cache,
    undefined,
    () => now
  );
  mkdirSync(join(r.cache, "mail", ACC, "outbox"), { recursive: true }); // a real send has its marker there
  outbox.markSent(ACC, "<old@fake.test>", uuid());
  const fresh = new MailOutbox(
    () => r.cache,
    undefined,
    () => now
  );
  expect(fresh.sentRecently(ACC, "<old@fake.test>")).toBe(true);
  now += 6 * 24 * 3600 * 1000;
  fresh.sweep(ACC, 3600 * 1000, 30 * 24 * 3600 * 1000, self);
  expect(fresh.sentRecently(ACC, "<old@fake.test>")).toBe(true);
  now += 2 * 24 * 3600 * 1000;
  expect(fresh.sentRecently(ACC, "<old@fake.test>")).toBe(false);
  fresh.sweep(ACC, 3600 * 1000, 30 * 24 * 3600 * 1000, self);
  const left = existsSync(join(r.cache, "mail", ACC, "outbox"))
    ? (await import("node:fs")).readdirSync(join(r.cache, "mail", ACC, "outbox"))
    : [];
  expect(left.filter((n) => n.startsWith("sent-"))).toEqual([]);
});

// ---- review round 4 -----------------------------------------------------------------

test("opening the copy a sent mail left in Drafts says it went out, and whether that copy is its only record", async () => {
  const r = await rig();
  const st = await json(await startSend(r));
  imap.denyAppend = true; // the Sent copy will fail, so the Drafts copy is kept as the only record
  await r.send.settled(st.sendId);
  imap.denyAppend = false;
  expect(await getStatus(r, st.sendId)).toMatchObject({
    state: "sent",
    sentCopy: "failed",
    draftKept: true,
  });
  expect(drafts.messages).toHaveLength(1);
  const uid = (drafts.messages[0] as { uid: number }).uid;
  const init = await call(r, "POST", "/init", {
    mode: "draft",
    folder: "Drafts",
    uid,
    locale: "en",
  }).then(json);
  expect(init.draft.messageId).toBe("<draft-aaa@fake.test>");
  expect(init.sent).toEqual({ sentCopy: "failed" });
  // Another process sees the same record on disk.
  const other = new MailOutbox(() => r.cache);
  expect(other.sentInfo(ACC, "<draft-aaa@fake.test>")).toEqual({ sentCopy: "failed" });
  // An ordinary draft carries no such flag.
  const saved = await call(
    r,
    "PUT",
    "/draft",
    draftBody({ messageId: "<draft-ccc@fake.test>" })
  ).then(json);
  const plain = await call(r, "POST", "/init", {
    mode: "draft",
    folder: "Drafts",
    uid: saved.uid,
    locale: "en",
  }).then(json);
  expect(plain.sent).toBeUndefined();
});

// ---- review round 5 -----------------------------------------------------------------

test("the sent guard is in place as soon as SMTP accepted: a process that takes over the claim during cleanup cannot send again", async () => {
  const r = await rig();
  const real = createNodeMailOutgoing({ timeoutMs: 3000, tls: { rejectUnauthorized: false } });
  let inCleanup: () => void = () => {};
  const cleanupStarted = new Promise<void>((res) => {
    inCleanup = res;
  });
  let finishCleanup: () => void = () => {};
  const gate = new Promise<void>((res) => {
    finishCleanup = res;
  });
  // The Sent copy (cleanup, after SMTP accepted) hangs, like a process stuck or dying right there.
  const slow = {
    ...real,
    appendSent: async (
      t: Parameters<typeof real.appendSent>[0],
      q: Parameters<typeof real.appendSent>[1]
    ) => {
      inCleanup();
      await gate;
      return real.appendSent(t, q);
    },
  };
  const owner = new MailSendService({
    compose: r.compose,
    outgoing: slow,
    outbox: new MailOutbox(() => r.cache),
    undoMs: 100,
  });
  const st = await owner.start(ACC, { sendId: uuid(), draft: draftBody() as never });
  await cleanupStarted;
  expect(smtp.messages).toHaveLength(1);
  // Another process that judges the owner dead (its claim stale) takes the claim over.
  const other = r.makeSend({ pid: process.ppid, alive: () => false });
  await expect(
    other.start(ACC, { sendId: uuid(), draft: draftBody() as never })
  ).rejects.toMatchObject({
    code: "already_sent",
  });
  finishCleanup();
  await owner.settled(st.sendId);
  await sleep(300);
  expect(smtp.dataStarted.count).toBe(1);
});

// ---- closing review B2: whose send is it ------------------------------------------------------

test("a send records who started it; the HTTP route always starts as the Mail page; a gone marker is answered by the sent guard", async () => {
  const r = await rig();
  const viaRoute = await json(
    await call(r, "POST", "/send", { sendId: uuid(), draft: draftBody(), origin: "copilot" })
  );
  expect(viaRoute.origin).toBe("mail"); // a client cannot claim to be the Copilot
  await r.send.settled(viaRoute.sendId);

  const copilotId = uuid();
  const st = await r.send.start(ACC, {
    sendId: copilotId,
    draft: draftBody({ messageId: "<draft-copilot@fake.test>" }) as never,
    origin: "copilot",
  });
  expect(st.origin).toBe("copilot");
  await r.send.settled(copilotId);
  expect(r.send.list().find((x) => x.sendId === copilotId)?.origin).toBe("copilot");

  // Its marker is removed (swept, or acknowledged by whoever): the answer is still "sent", never "not found".
  r.send.dismiss(ACC, copilotId);
  expect(r.outbox.read(ACC, copilotId)).toBeNull();
  const after = r.send.status(ACC, copilotId);
  expect(after).toMatchObject({
    state: "sent",
    origin: "copilot",
    messageId: "<draft-copilot@fake.test>",
    // What the guard recorded after cleanup, not a fixed guess.
    draftKept: false,
    rejected: 0,
  });
  // Another process (no shared memory) reads the same from the guard file.
  expect(r.makeSend({ pid: process.ppid }).status(ACC, copilotId)).toMatchObject({ state: "sent" });
  // An id the guard never saw is still not found.
  expect(() => r.send.status(ACC, uuid())).toThrow(expect.objectContaining({ code: "not_found" }));
});

test("the sent guard answers only what it recorded: refused recipients and a kept Drafts copy survive a gone marker", () => {
  const cache = mkdtempSync(join(tmpdir(), "mail-guard-"));
  try {
    const outbox = new MailOutbox(() => cache);
    mkdirSync(join(cache, "mail", ACC, "outbox"), { recursive: true });
    outbox.markSent(ACC, "<g1@fake.test>", "send-g1", "failed", "copilot", {
      rejected: 2,
      draftKept: true,
    });
    expect(outbox.sentBySendId(ACC, "send-g1")).toMatchObject({ rejected: 2, draftKept: true });
    // Another process reads the guard file.
    expect(new MailOutbox(() => cache).sentBySendId(ACC, "send-g1")).toMatchObject({
      rejected: 2,
      draftKept: true,
      sentCopy: "failed",
    });
    // A guard file written before these fields existed: the conservative reading (a Drafts copy may remain).
    const legacy = new MailOutbox(() => cache);
    legacy.markSent(ACC, "<g2@fake.test>", "send-g2", "saved", "mail");
    const files = readdirSync(join(cache, "mail", ACC, "outbox")).filter((n: string) =>
      n.startsWith("sent-")
    );
    for (const name of files) {
      const path = join(cache, "mail", ACC, "outbox", name);
      const v = JSON.parse(readFileSync(path, "utf8"));
      if (v.sendId !== "send-g2") continue;
      delete v.rejected;
      delete v.draftKept;
      writeFileSync(path, JSON.stringify(v));
    }
    expect(new MailOutbox(() => cache).sentBySendId(ACC, "send-g2")).toMatchObject({
      rejected: 0,
      draftKept: true,
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

// ---- closing review U1: the account decides whether we append the Sent copy -------------------

test("the account's own setting beats the preset: a custom server that saves Sent itself gets no copy", async () => {
  const a = await rig("custom", UNDO, { serverSavesSent: true });
  const one = await json(await startSend(a));
  await a.send.settled(one.sendId);
  expect(await getStatus(a, one.sendId)).toMatchObject({ state: "sent", sentCopy: "by_server" });
  expect(sent.messages).toHaveLength(0);
});

test("the account's own setting beats the preset: a Gmail account told to keep its own copy appends it", async () => {
  const b = await rig("gmail", UNDO, { serverSavesSent: false });
  const two = await json(await startSend(b));
  await b.send.settled(two.sendId);
  expect(await getStatus(b, two.sendId)).toMatchObject({ state: "sent", sentCopy: "saved" });
  expect(sent.messages).toHaveLength(1);
});
