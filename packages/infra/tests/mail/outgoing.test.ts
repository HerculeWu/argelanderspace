import { afterEach, expect, test } from "vitest";
import {
  classifySmtpFailure,
  composeMail,
  createNodeMailOutgoing,
  parseMailSource,
  parseRecipients,
} from "../../src/index.js";
import { type FakeFolder, type FakeMailbox, startFakeMailbox } from "./fake-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "./fake-servers.js";
import { type RecordingSmtp, startRecordingSmtp } from "./fake-smtp.js";

const mailboxes: FakeMailbox[] = [];
const smtps: RecordingSmtp[] = [];
afterEach(async () => {
  await Promise.all([...mailboxes.splice(0), ...smtps.splice(0)].map((f) => f.close()));
});

const outgoing = createNodeMailOutgoing({ timeoutMs: 4000, tls: { rejectUnauthorized: false } });
const login = (port: number, password = TEST_PASSWORD) => ({
  host: "127.0.0.1",
  port,
  security: "tls" as const,
  user: TEST_USER,
  password,
});
const ME = { name: "Test Person", address: "tester@fake.test" };
const ID = "<draft-1@fake.test>";

const mail = (over: Partial<Parameters<typeof composeMail>[0]> = {}) =>
  composeMail({
    from: ME,
    to: [{ name: "Ada", address: "ada@fake.test" }],
    cc: [],
    bcc: [{ name: "", address: "hidden@fake.test" }],
    subject: "Hello 世界",
    text: "Body text\n",
    messageId: ID,
    inReplyTo: "<orig@fake.test>",
    references: ["<root@fake.test>", "<orig@fake.test>"],
    attachments: [],
    ...over,
  });

async function boxes(): Promise<{ fake: FakeMailbox; drafts: FakeFolder; sent: FakeFolder }> {
  const drafts: FakeFolder = { path: "Drafts", attrs: ["\\Drafts"], uidValidity: 21, messages: [] };
  const sent: FakeFolder = { path: "Sent", attrs: ["\\Sent"], uidValidity: 22, messages: [] };
  const fake = await startFakeMailbox([
    { path: "INBOX", uidValidity: 20, messages: [] },
    drafts,
    sent,
  ]);
  mailboxes.push(fake);
  return { fake, drafts, sent };
}

test("parseRecipients accepts names, commas and semicolons and rejects non-addresses", () => {
  const ok = parseRecipients('Ada L <a@x.test>, b@y.test; "Doe, Jane" <j@z.test>');
  expect(ok).toEqual({
    ok: true,
    list: [
      { name: "Ada L", address: "a@x.test" },
      { name: "", address: "b@y.test" },
      { name: "Doe, Jane", address: "j@z.test" },
    ],
  });
  expect(parseRecipients("   ")).toEqual({ ok: true, list: [] });
  expect(parseRecipients("not-an-address")).toEqual({ ok: false });
  expect(parseRecipients("a@x.test, bob")).toEqual({ ok: false });
  expect(parseRecipients("a@x.test\r\nBcc: evil@x.test")).toEqual({ ok: false });
});

test("composeMail threads replies, keeps Bcc only in the stored copy and encodes attachments", async () => {
  const c = await mail({
    attachments: [
      { filename: "n.txt", contentType: "text/plain", content: Buffer.from("hi there") },
    ],
  });
  const stored = await parseMailSource(c.raw);
  expect(stored.messageId).toBe("draft-1@fake.test");
  expect(stored.inReplyTo).toBe("<orig@fake.test>");
  expect(stored.references).toEqual(["<root@fake.test>", "<orig@fake.test>"]);
  expect(stored.subject).toBe("Hello 世界");
  expect(stored.bcc.map((a) => a.address)).toEqual(["hidden@fake.test"]);
  expect(stored.attachments.map((a) => [a.filename, Buffer.from(a.content).toString()])).toEqual([
    ["n.txt", "hi there"],
  ]);
  const wire = await parseMailSource(c.wire);
  expect(wire.bcc).toEqual([]);
  expect(c.wire.toString()).not.toContain("hidden@fake.test");
  expect(c.envelope).toEqual({
    from: "tester@fake.test",
    to: ["ada@fake.test", "hidden@fake.test"],
  });
});

test("saveDraft stores one copy, replaces older copies and never leaves zero", async () => {
  const { fake, drafts } = await boxes();
  const first = await mail({ subject: "v1" });
  const r1 = await outgoing.saveDraft(login(fake.port), { raw: first.raw, messageId: ID });
  expect(r1).toEqual({ ok: true, value: { folder: "Drafts", uid: 1 } });
  expect(drafts.messages[0]?.flags.has("\\Draft")).toBe(true);

  const second = await mail({ subject: "v2" });
  const r2 = await outgoing.saveDraft(login(fake.port), { raw: second.raw, messageId: ID });
  expect(r2).toEqual({ ok: true, value: { folder: "Drafts", uid: 2 } });
  expect(drafts.messages.map((m) => [m.uid, m.subject])).toEqual([[2, "v2"]]);

  // Two racing saves of the same draft: the newest copy survives, never zero.
  const [a, b] = await Promise.all([
    mail({ subject: "v3" }).then((m) =>
      outgoing.saveDraft(login(fake.port), { raw: m.raw, messageId: ID })
    ),
    mail({ subject: "v4" }).then((m) =>
      outgoing.saveDraft(login(fake.port), { raw: m.raw, messageId: ID })
    ),
  ]);
  expect(a.ok && b.ok).toBe(true);
  expect(drafts.messages).toHaveLength(1);
  expect(drafts.messages[0]?.uid).toBe(Math.max(...drafts.messages.map((m) => m.uid)));

  // Another draft in the folder is never touched.
  const other = await mail({ messageId: "<other@fake.test>", subject: "other" });
  await outgoing.saveDraft(login(fake.port), { raw: other.raw, messageId: "<other@fake.test>" });
  const third = await mail({ subject: "v5" });
  await outgoing.saveDraft(login(fake.port), { raw: third.raw, messageId: ID });
  expect(drafts.messages.map((m) => m.subject).sort()).toEqual(["other", "v5"]);
});

test("saveDraft finds its own copy when the server does not report APPENDUID", async () => {
  const { fake, drafts } = await boxes();
  fake.hideAppendUid = true;
  const a = await mail({ subject: "a" });
  const r = await outgoing.saveDraft(login(fake.port), { raw: a.raw, messageId: ID });
  expect(r).toEqual({ ok: true, value: { folder: "Drafts", uid: 1 } });
  const b = await mail({ subject: "b" });
  await outgoing.saveDraft(login(fake.port), { raw: b.raw, messageId: ID });
  expect(drafts.messages.map((m) => m.subject)).toEqual(["b"]);
});

test("saveDraft reports failures as codes: refused APPEND, no Drafts folder, bad password", async () => {
  const { fake } = await boxes();
  const m = await mail();
  fake.denyAppend = true;
  const refused = await outgoing.saveDraft(login(fake.port), { raw: m.raw, messageId: ID });
  expect(refused.ok).toBe(false);
  fake.denyAppend = false;
  expect(
    await outgoing.saveDraft(login(fake.port, "wrong"), { raw: m.raw, messageId: ID })
  ).toEqual({
    ok: false,
    code: "auth_failed",
  });
  const bare = await startFakeMailbox([{ path: "INBOX", uidValidity: 1, messages: [] }]);
  mailboxes.push(bare);
  expect(await outgoing.saveDraft(login(bare.port), { raw: m.raw, messageId: ID })).toEqual({
    ok: false,
    code: "drafts_unavailable",
  });
});

test("deleteDraft removes every copy of one draft and succeeds when there is none", async () => {
  const { fake, drafts } = await boxes();
  const m = await mail();
  await outgoing.saveDraft(login(fake.port), { raw: m.raw, messageId: ID });
  const other = await mail({ messageId: "<other@fake.test>" });
  await outgoing.saveDraft(login(fake.port), { raw: other.raw, messageId: "<other@fake.test>" });
  expect(await outgoing.deleteDraft(login(fake.port), { messageId: ID })).toEqual({
    ok: true,
    value: { removed: 1 },
  });
  expect(drafts.messages).toHaveLength(1);
  expect(await outgoing.deleteDraft(login(fake.port), { messageId: ID })).toEqual({
    ok: true,
    value: { removed: 0 },
  });
});

test("appendSent writes the full message into the Sent folder", async () => {
  const { fake, sent } = await boxes();
  const m = await mail();
  expect(await outgoing.appendSent(login(fake.port), { raw: m.raw })).toEqual({
    ok: true,
    value: { folder: "Sent" },
  });
  expect(sent.messages).toHaveLength(1);
  expect(sent.messages[0]?.flags.has("\\Seen")).toBe(true);
  expect(sent.messages[0]?.source).toContain("Message-ID: <draft-1@fake.test>");
});

test("sendSmtp delivers the wire form to every recipient and reports refusals as codes", async () => {
  const smtp = await startRecordingSmtp();
  smtps.push(smtp);
  const c = await mail();
  const ok = await outgoing.sendSmtp(login(smtp.port), {
    from: c.envelope.from,
    to: c.envelope.to,
    raw: c.wire,
  });
  expect(ok).toEqual({ ok: true, value: { accepted: 2, rejected: 0 } });
  expect(smtp.messages).toHaveLength(1);
  expect(smtp.messages[0]?.to.sort()).toEqual(["ada@fake.test", "hidden@fake.test"]);
  expect(smtp.messages[0]?.raw).not.toContain("hidden@fake.test"); // Bcc is only in the envelope

  // One refused recipient among accepted ones: the message went out, the refusal is counted.
  smtp.behavior.rejectRecipients = ["hidden@fake.test"];
  const partial = await outgoing.sendSmtp(login(smtp.port), {
    from: c.envelope.from,
    to: c.envelope.to,
    raw: c.wire,
  });
  expect(partial).toEqual({ ok: true, value: { accepted: 1, rejected: 1 } });

  // All refused: nothing sent.
  smtp.behavior.rejectRecipients = ["ada@fake.test", "hidden@fake.test"];
  const before = smtp.messages.length;
  expect(
    await outgoing.sendSmtp(login(smtp.port), {
      from: c.envelope.from,
      to: c.envelope.to,
      raw: c.wire,
    })
  ).toEqual({
    ok: false,
    code: "recipient_rejected",
  });
  expect(smtp.messages).toHaveLength(before);

  smtp.behavior.rejectRecipients = [];
  smtp.behavior.rejectData = 552;
  expect(
    await outgoing.sendSmtp(login(smtp.port), {
      from: c.envelope.from,
      to: c.envelope.to,
      raw: c.wire,
    })
  ).toEqual({
    ok: false,
    code: "message_too_large",
  });
  smtp.behavior.rejectData = null;
  expect(
    await outgoing.sendSmtp(login(smtp.port, "wrong"), {
      from: c.envelope.from,
      to: c.envelope.to,
      raw: c.wire,
    })
  ).toEqual({
    ok: false,
    code: "auth_failed",
  });
});

test("sendSmtp marks a connection lost after the data as ambiguous, never as plainly failed", async () => {
  const smtp = await startRecordingSmtp();
  smtps.push(smtp);
  smtp.behavior.dropAfterData = true;
  const c = await mail();
  const r = await outgoing.sendSmtp(login(smtp.port), {
    from: c.envelope.from,
    to: c.envelope.to,
    raw: c.wire,
  });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.ambiguous).toBe(true);
  expect(smtp.dataStarted.count).toBe(1);
});

test("sendSmtp to a closed port is a definite failure (nothing was handed over)", async () => {
  const c = await mail();
  const r = await outgoing.sendSmtp(login(1), {
    from: c.envelope.from,
    to: c.envelope.to,
    raw: c.wire,
  });
  expect(r).toEqual({ ok: false, code: "connection_refused" });
});

test("sendSmtp: a connection lost after RCPT (before the body was accepted) is definite, never ambiguous", async () => {
  const smtp = await startRecordingSmtp();
  smtps.push(smtp);
  smtp.behavior.dropAfterRcpt = true;
  const c = await mail();
  const r = await outgoing.sendSmtp(login(smtp.port), {
    from: c.envelope.from,
    to: c.envelope.to,
    raw: c.wire,
  });
  expect(r.ok).toBe(false);
  expect(r.ok === false && r.ambiguous).toBeUndefined();
  expect(smtp.dataStarted.count).toBe(0);
  expect(smtp.messages).toHaveLength(0);
});

test("classifySmtpFailure: once DATA went out, any failure without a server answer is ambiguous; before, never", () => {
  const lost = Object.assign(new Error("Connection closed unexpectedly"), { code: "ECONNECTION" });
  const tls = Object.assign(new Error("write EPROTO SSL routines"), { code: "ESOCKET" });
  const refused = Object.assign(new Error("554 no"), { code: "EMESSAGE", responseCode: 554 });
  expect(classifySmtpFailure(lost, true).ambiguous).toBe(true);
  expect(classifySmtpFailure(tls, true).ambiguous).toBe(true); // even a TLS error text
  expect(classifySmtpFailure(refused, true).ambiguous).toBe(false); // the server answered: definite
  expect(classifySmtpFailure(lost, false).ambiguous).toBe(false);
  expect(classifySmtpFailure(tls, false).ambiguous).toBe(false);
});
