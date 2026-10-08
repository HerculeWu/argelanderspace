import { afterEach, expect, test } from "vitest";
import { createNodeMailMailbox, parseMailSource } from "../../src/index.js";
import {
  attachmentMail,
  type FakeFolder,
  type FakeMailbox,
  type FakeMessage,
  htmlMail,
  plainMail,
  startFakeMailbox,
} from "./fake-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "./fake-servers.js";

const open: FakeMailbox[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const mailbox = createNodeMailMailbox({ timeoutMs: 4000, tls: { rejectUnauthorized: false } });
const login = (port: number, password = TEST_PASSWORD) => ({
  host: "127.0.0.1",
  port,
  security: "tls" as const,
  user: TEST_USER,
  password,
});

function folders(): FakeFolder[] {
  const msgs = [];
  for (let uid = 1; uid <= 7; uid++)
    msgs.push(
      plainMail({
        uid,
        subject: `Message ${uid}`,
        from: ["Ada Lovelace", "ada@fake.test"],
        date: `Mon, ${uid} Oct 2026 10:00:00 +0000`,
        body: `Body number ${uid}`,
        flags: uid <= 4 ? ["\\Seen"] : uid === 6 ? ["\\Flagged"] : [],
      })
    );
  msgs.push(attachmentMail({ uid: 8, subject: "Report", date: "Tue, 6 Oct 2026 08:00:00 +0000" }));
  msgs.push(
    plainMail({
      uid: 9,
      subject: "=?UTF-8?B?5L2g5aW9IEhlbGxv?=",
      from: ["Kofi", "kofi@fake.test"],
      date: "Tue, 6 Oct 2026 09:00:00 +0000",
      body: "你好",
    })
  );
  return [
    { path: "INBOX", uidValidity: 11, messages: msgs },
    { path: "Sent", attrs: ["\\Sent"], uidValidity: 12, messages: [] },
    { path: "Projects/Euclid", uidValidity: 13, messages: [] },
  ];
}

async function start(f = folders()) {
  const s = await startFakeMailbox(f);
  open.push(s);
  return s;
}

test("listFolders: paths, special use, counts", async () => {
  const s = await start();
  const r = await mailbox.listFolders(login(s.port));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const byPath = new Map(r.value.map((f) => [f.path, f]));
  expect(byPath.get("INBOX")).toMatchObject({
    specialUse: "\\Inbox",
    unread: 5,
    total: 9,
    selectable: true,
  });
  expect(byPath.get("Sent")?.specialUse).toBe("\\Sent");
  expect(byPath.get("Projects/Euclid")).toMatchObject({ name: "Euclid", total: 0 });
});

test("bad password -> auth_failed, no folder data", async () => {
  const s = await start();
  expect(await mailbox.listFolders(login(s.port, "nope"))).toEqual({
    ok: false,
    code: "auth_failed",
  });
});

test("listHeaders pages newest first with nextBefore, decodes subjects, flags and attachments", async () => {
  const s = await start();
  const p1 = await mailbox.listHeaders(login(s.port), { folder: "INBOX", limit: 4 });
  expect(p1.ok).toBe(true);
  if (!p1.ok) return;
  expect(p1.value.uidValidity).toBe(11);
  expect(p1.value.total).toBe(9);
  expect(p1.value.headers.map((h) => h.uid)).toEqual([9, 8, 7, 6]);
  expect(p1.value.nextBefore).toBe(6);
  const [h9, h8, h7, h6] = p1.value.headers;
  expect(h9?.subject).toBe("你好 Hello");
  expect(h9?.from).toEqual({ name: "Kofi", address: "kofi@fake.test" });
  expect(h9?.date).toBe("2026-10-06T09:00:00.000Z");
  expect(h9?.unread).toBe(true);
  expect(h8?.hasAttachments).toBe(true);
  expect(h7?.hasAttachments).toBe(false);
  expect(h6?.starred).toBe(true);

  const p2 = await mailbox.listHeaders(login(s.port), { folder: "INBOX", limit: 4, before: 6 });
  if (!p2.ok) throw new Error("page 2");
  expect(p2.value.headers.map((h) => h.uid)).toEqual([5, 4, 3, 2]);
  expect(p2.value.nextBefore).toBe(2);
  const p3 = await mailbox.listHeaders(login(s.port), { folder: "INBOX", limit: 4, before: 2 });
  if (!p3.ok) throw new Error("page 3");
  expect(p3.value.headers.map((h) => h.uid)).toEqual([1]);
  expect(p3.value.nextBefore).toBeNull();
  // Listing is read-only: no flag was changed.
  expect(s.commands.filter((c) => c.startsWith("UID STORE"))).toEqual([]);
  expect(s.commands.filter((c) => c === "SELECT INBOX")).toEqual([]);
});

test("listHeaders: empty folder and missing folder", async () => {
  const s = await start();
  const e = await mailbox.listHeaders(login(s.port), { folder: "Sent", limit: 10 });
  expect(e).toEqual({
    ok: true,
    value: { uidValidity: 12, total: 0, headers: [], nextBefore: null },
  });
  expect(await mailbox.listHeaders(login(s.port), { folder: "Nope", limit: 10 })).toEqual({
    ok: false,
    code: "folder_not_found",
  });
});

const openQ = (over: Partial<Parameters<typeof mailbox.openMessage>[1]> = {}) => ({
  folder: "INBOX",
  uid: 5,
  wantSource: true,
  markSeen: true,
  maxBytes: 1_000_000,
  ...over,
});

test("openMessage fetches the source and sets \\Seen on the server (IMAP semantics)", async () => {
  const s = await start();
  const inbox = s.folders[0] as FakeFolder;
  expect(inbox.messages.find((m) => m.uid === 5)?.flags.has("\\Seen")).toBe(false);
  const r = await mailbox.openMessage(login(s.port), openQ({ uidValidity: 11 }));
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.seen).toBe(true);
  expect(r.value.source?.toString()).toContain("Body number 5");
  expect(inbox.messages.find((m) => m.uid === 5)?.flags.has("\\Seen")).toBe(true);
  expect(s.commands).toContain("SELECT INBOX");
});

test("openMessage without markSeen leaves the message unread and uses EXAMINE", async () => {
  const s = await start();
  const r = await mailbox.openMessage(login(s.port), openQ({ markSeen: false }));
  expect(r.ok && r.value.seen).toBe(false);
  expect((s.folders[0] as FakeFolder).messages.find((m) => m.uid === 5)?.flags.has("\\Seen")).toBe(
    false
  );
  expect(s.commands).toContain("EXAMINE INBOX");
  expect(s.commands.filter((c) => c.startsWith("UID STORE"))).toEqual([]);
});

test("openMessage: server refuses the flag change -> still returns the message, seen:false", async () => {
  const s = await start();
  s.denyStore = true;
  const r = await mailbox.openMessage(login(s.port), openQ());
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.seen).toBe(false);
  expect(r.value.source).not.toBeNull();
});

test("openMessage failures: changed uidvalidity, unknown uid, too large, missing folder", async () => {
  const s = await start();
  expect(await mailbox.openMessage(login(s.port), openQ({ uidValidity: 99 }))).toEqual({
    ok: false,
    code: "message_changed",
  });
  expect(await mailbox.openMessage(login(s.port), openQ({ uid: 4242 }))).toEqual({
    ok: false,
    code: "message_not_found",
  });
  expect(await mailbox.openMessage(login(s.port), openQ({ maxBytes: 10 }))).toEqual({
    ok: false,
    code: "too_large",
  });
  expect(await mailbox.openMessage(login(s.port), openQ({ folder: "Nope" }))).toEqual({
    ok: false,
    code: "folder_not_found",
  });
});

test("parseMailSource: plain, encoded, attachments and cid images", async () => {
  const s = await start();
  const plain = await parseMailSource(
    Buffer.from(((s.folders[0] as FakeFolder).messages[8] as FakeMessage).source)
  );
  expect(plain.subject).toBe("你好 Hello");
  expect(plain.text?.trim()).toBe("你好");
  expect(plain.from).toEqual({ name: "Kofi", address: "kofi@fake.test" });
  expect(plain.date).toBe("2026-10-06T09:00:00.000Z");

  const withPdf = await parseMailSource(
    Buffer.from(
      attachmentMail({ uid: 1, subject: "R", date: "Tue, 6 Oct 2026 08:00:00 +0000" }).source
    )
  );
  expect(withPdf.attachments).toHaveLength(1);
  expect(withPdf.attachments[0]).toMatchObject({
    part: 0,
    filename: "report.pdf",
    contentType: "application/pdf",
    inline: false,
    contentId: null,
  });
  expect(Buffer.from(withPdf.attachments[0]?.content ?? []).toString()).toBe(
    "%PDF-synthetic-attachment"
  );

  const html = await parseMailSource(
    Buffer.from(
      htmlMail({
        uid: 2,
        subject: "H",
        date: "Tue, 6 Oct 2026 08:00:00 +0000",
        html: '<p>Hi <img src="cid:logo@fake.test"></p>',
      }).source
    )
  );
  expect(html.html).toContain("cid:logo@fake.test");
  expect(html.text).toBe("plain alternative");
  expect(html.attachments[0]).toMatchObject({
    contentId: "logo@fake.test",
    inline: true,
    contentType: "image/png",
  });
});

test("parseMailSource tolerates garbage input", async () => {
  const r = await parseMailSource(Buffer.from("\u0000\u0001 not a mail at all \r\n\r\n\r\n"));
  expect(r.attachments).toEqual([]);
  expect(typeof r.subject).toBe("string");
});

test("listHeaders: a refused SEARCH is a failure, not an empty folder", async () => {
  const s = await start();
  s.denySearch = true;
  expect(await mailbox.listHeaders(login(s.port), { folder: "INBOX", limit: 5 })).toEqual({
    ok: false,
    code: "protocol_error",
  });
});
