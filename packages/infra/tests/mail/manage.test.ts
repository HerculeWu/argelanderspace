import { afterEach, expect, test } from "vitest";
import * as infra from "../../src/index.js";
import { createNodeMailManage, findTrashPath, searchQuery } from "../../src/index.js";
import { type FakeFolder, type FakeMailbox, plainMail, startFakeMailbox } from "./fake-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "./fake-servers.js";

const open: FakeMailbox[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((f) => f.close()));
});

const manage = createNodeMailManage({ timeoutMs: 4000, tls: { rejectUnauthorized: false } });
const login = (port: number, password = TEST_PASSWORD) => ({
  host: "127.0.0.1",
  port,
  security: "tls" as const,
  user: TEST_USER,
  password,
});

function folders(opts: { trash?: boolean } = {}): FakeFolder[] {
  const msgs = [
    plainMail({
      uid: 1,
      subject: "Euclid shear catalogue",
      from: ["Ada Lovelace", "ada@fake.test"],
      date: "Mon, 5 Oct 2026 10:00:00 +0000",
      body: "The weak-lensing results are in.",
      flags: ["\\Seen"],
    }),
    plainMail({
      uid: 2,
      subject: "Lunch on Friday",
      from: ["Kofi Mensah", "kofi@fake.test"],
      date: "Tue, 6 Oct 2026 09:00:00 +0000",
      body: "Mensa at noon? Bring the PSF plots.",
    }),
    plainMail({
      uid: 3,
      subject: "=?UTF-8?B?5L2g5aW9IEhlbGxv?=",
      from: ["Maria", "maria@fake.test"],
      date: "Wed, 7 Oct 2026 08:30:00 +0000",
      body: "日本語の本文 über cosmic shear",
      flags: ["\\Flagged"],
    }),
    plainMail({
      uid: 4,
      subject: "Referee report",
      from: ["Ada Lovelace", "ada@fake.test"],
      date: "Thu, 8 Oct 2026 12:00:00 +0000",
      body: "Please see the comments about Table 2.",
    }),
  ];
  const out: FakeFolder[] = [
    { path: "INBOX", uidValidity: 11, messages: msgs },
    { path: "Sent", attrs: ["\\Sent"], uidValidity: 12, messages: [] },
    { path: "Archive", attrs: ["\\Archive"], uidValidity: 14, messages: [] },
    { path: "Projects/Euclid", uidValidity: 15, messages: [] },
  ];
  if (opts.trash !== false)
    out.push({
      path: "Trash",
      attrs: ["\\Trash"],
      uidValidity: 13,
      messages: [
        plainMail({
          uid: 7,
          subject: "Old newsletter",
          from: ["News", "news@fake.test"],
          date: "Mon, 1 Jun 2026 08:00:00 +0000",
          body: "gone soon",
          flags: ["\\Seen"],
        }),
        // Another client marked this one \Deleted but has not expunged yet: it must survive our delete.
        plainMail({
          uid: 8,
          subject: "Marked by someone else",
          from: ["News", "news@fake.test"],
          date: "Mon, 1 Jun 2026 09:00:00 +0000",
          body: "still here",
          flags: ["\\Deleted"],
        }),
      ],
    });
  return out;
}

async function start(f = folders()) {
  const s = await startFakeMailbox(f);
  open.push(s);
  return s;
}
const uids = (s: FakeMailbox, path: string) =>
  s.folders.find((f) => f.path === path)?.messages.map((m) => m.uid) ?? [];
const flagsOf = (s: FakeMailbox, path: string, uid: number) => [
  ...(s.folders.find((f) => f.path === path)?.messages.find((m) => m.uid === uid)?.flags ?? []),
];

// ---- flags -------------------------------------------------------------------

test("setFlag: read and unread, star and unstar, reported from the server's own flags", async () => {
  const s = await start();
  const t = login(s.port);
  const read = await manage.setFlag(t, { folder: "INBOX", uid: 2, flag: "seen", value: true });
  expect(read).toEqual({ ok: true, value: { uidValidity: 11, unread: false, starred: false } });
  expect(flagsOf(s, "INBOX", 2)).toEqual(["\\Seen"]);

  const unread = await manage.setFlag(t, { folder: "INBOX", uid: 2, flag: "seen", value: false });
  expect(unread).toMatchObject({ ok: true, value: { unread: true } });
  expect(flagsOf(s, "INBOX", 2)).toEqual([]);

  const star = await manage.setFlag(t, { folder: "INBOX", uid: 2, flag: "flagged", value: true });
  expect(star).toMatchObject({ ok: true, value: { starred: true, unread: true } });
  const unstar = await manage.setFlag(t, {
    folder: "INBOX",
    uid: 3,
    flag: "flagged",
    value: false,
  });
  expect(unstar).toMatchObject({ ok: true, value: { starred: false } });
  expect(flagsOf(s, "INBOX", 3)).toEqual([]);
  // The mailbox was opened read-write, never EXAMINEd, for these changes.
  expect(s.commands).toContain("SELECT INBOX");
  expect(s.commands).not.toContain("EXAMINE INBOX");
});

test("setFlag failures: refused, wrong generation, unknown uid, missing folder, bad password, lost connection", async () => {
  const s = await start();
  const t = login(s.port);
  s.denyStore = true;
  expect(await manage.setFlag(t, { folder: "INBOX", uid: 2, flag: "seen", value: true })).toEqual({
    ok: false,
    code: "refused",
  });
  expect(flagsOf(s, "INBOX", 2)).toEqual([]);
  s.denyStore = false;

  expect(
    await manage.setFlag(t, {
      folder: "INBOX",
      uid: 2,
      uidValidity: 999,
      flag: "seen",
      value: true,
    })
  ).toEqual({ ok: false, code: "message_changed" });
  expect(await manage.setFlag(t, { folder: "INBOX", uid: 99, flag: "seen", value: true })).toEqual({
    ok: false,
    code: "message_not_found",
  });
  expect(await manage.setFlag(t, { folder: "Nope", uid: 2, flag: "seen", value: true })).toEqual({
    ok: false,
    code: "folder_not_found",
  });
  expect(
    await manage.setFlag(login(s.port, "wrong"), {
      folder: "INBOX",
      uid: 2,
      flag: "seen",
      value: true,
    })
  ).toEqual({ ok: false, code: "auth_failed" });

  s.dropOn = "UID STORE";
  const lost = await manage.setFlag(t, { folder: "INBOX", uid: 2, flag: "seen", value: true });
  expect(lost).toEqual({ ok: false, code: "connection_lost" });
});

// ---- move --------------------------------------------------------------------

test("move: the message leaves the source, arrives with its flags and the new uid is reported", async () => {
  const s = await start();
  const r = await manage.move(login(s.port), {
    folder: "INBOX",
    uid: 3,
    uidValidity: 11,
    destination: "Archive",
  });
  expect(r).toEqual({
    ok: true,
    value: { uidValidity: 11, destination: "Archive", uid: 1, destinationUidValidity: 14 },
  });
  expect(uids(s, "INBOX")).toEqual([1, 2, 4]);
  expect(uids(s, "Archive")).toEqual([1]);
  expect(flagsOf(s, "Archive", 1)).toEqual(["\\Flagged"]);
  expect(s.commands).toContain("UID MOVE");
});

test("move failures leave the message where it was: missing destination, refused, lost connection", async () => {
  const s = await start();
  const t = login(s.port);
  expect(await manage.move(t, { folder: "INBOX", uid: 2, destination: "Nowhere" })).toEqual({
    ok: false,
    code: "destination_not_found",
  });
  s.denyMove = true;
  expect(await manage.move(t, { folder: "INBOX", uid: 2, destination: "Archive" })).toEqual({
    ok: false,
    code: "refused",
  });
  s.denyMove = false;
  s.dropOn = "UID MOVE";
  expect(await manage.move(t, { folder: "INBOX", uid: 2, destination: "Archive" })).toEqual({
    ok: false,
    code: "connection_lost",
  });
  s.dropOn = null;
  expect(uids(s, "INBOX")).toEqual([1, 2, 3, 4]);
  expect(uids(s, "Archive")).toEqual([]);
  expect(await manage.move(t, { folder: "INBOX", uid: 77, destination: "Archive" })).toEqual({
    ok: false,
    code: "message_not_found",
  });
  expect(await manage.move(t, { folder: "Gone", uid: 2, destination: "Archive" })).toEqual({
    ok: false,
    code: "folder_not_found",
  });
});

test("move without the MOVE extension falls back to copy + uid expunge; without UIDPLUS it refuses", async () => {
  const s = await start();
  s.moveCapability = false;
  const t = login(s.port);
  const r = await manage.move(t, { folder: "INBOX", uid: 2, destination: "Archive" });
  expect(r).toMatchObject({ ok: true, value: { destination: "Archive", uid: 1 } });
  expect(uids(s, "INBOX")).toEqual([1, 3, 4]);
  expect(s.commands).toContain("UID COPY");
  expect(s.commands).toContain("UID EXPUNGE");

  s.uidplus = false;
  const refused = await manage.move(t, { folder: "INBOX", uid: 3, destination: "Archive" });
  expect(refused).toEqual({ ok: false, code: "unsupported" });
  expect(uids(s, "INBOX")).toEqual([1, 3, 4]);
});

// ---- delete ------------------------------------------------------------------

test("remove moves into Trash; in Trash it asks for confirmation instead of deleting", async () => {
  const s = await start();
  const t = login(s.port);
  const r = await manage.remove(t, { folder: "INBOX", uid: 2, permanent: false });
  expect(r).toEqual({
    ok: true,
    value: {
      uidValidity: 11,
      outcome: "trashed",
      destination: "Trash",
      uid: 9,
      destinationUidValidity: 13,
    },
  });
  expect(uids(s, "INBOX")).toEqual([1, 3, 4]);
  expect(uids(s, "Trash")).toEqual([7, 8, 9]);

  expect(await manage.remove(t, { folder: "Trash", uid: 9, permanent: false })).toEqual({
    ok: false,
    code: "confirmation_required",
  });
  expect(uids(s, "Trash")).toEqual([7, 8, 9]);
});

test("permanent delete: only inside Trash, by uid, leaving other \\Deleted messages alone", async () => {
  const s = await start();
  const t = login(s.port);
  expect(await manage.remove(t, { folder: "INBOX", uid: 2, permanent: true })).toEqual({
    ok: false,
    code: "not_in_trash",
  });
  expect(uids(s, "INBOX")).toEqual([1, 2, 3, 4]);

  const r = await manage.remove(t, { folder: "Trash", uid: 7, permanent: true });
  expect(r).toEqual({
    ok: true,
    value: {
      uidValidity: 13,
      outcome: "deleted",
      destination: null,
      uid: null,
      destinationUidValidity: null,
    },
  });
  expect(uids(s, "Trash")).toEqual([8]);
  expect(flagsOf(s, "Trash", 8)).toEqual(["\\Deleted"]);
  expect(s.commands).toContain("UID EXPUNGE");
  expect(s.commands).not.toContain("EXPUNGE");
});

test("permanent delete refuses on a server without UIDPLUS, and clears \\Deleted when the expunge is refused", async () => {
  const s = await start();
  const t = login(s.port);
  s.uidplus = false;
  expect(await manage.remove(t, { folder: "Trash", uid: 7, permanent: true })).toEqual({
    ok: false,
    code: "unsupported",
  });
  expect(uids(s, "Trash")).toEqual([7, 8]);
  expect(flagsOf(s, "Trash", 7)).toEqual(["\\Seen"]);
  s.uidplus = true;

  s.denyExpunge = true;
  expect(await manage.remove(t, { folder: "Trash", uid: 7, permanent: true })).toEqual({
    ok: false,
    code: "refused",
  });
  expect(uids(s, "Trash")).toEqual([7, 8]);
  expect(flagsOf(s, "Trash", 7)).toEqual(["\\Seen"]); // the \Deleted mark was taken back
});

test("delete without a Trash folder fails and never turns into a permanent delete", async () => {
  const s = await start(folders({ trash: false }));
  const t = login(s.port);
  expect(await manage.remove(t, { folder: "INBOX", uid: 2, permanent: false })).toEqual({
    ok: false,
    code: "trash_not_found",
  });
  expect(uids(s, "INBOX")).toEqual([1, 2, 3, 4]);
  expect(s.commands).not.toContain("UID EXPUNGE");
});

test("findTrashPath prefers special-use and falls back to conventional names at the top level or under INBOX only", () => {
  const f = (
    path: string,
    name: string,
    opts: { specialUse?: string; source?: string; flags?: string[]; parent?: string[] } = {}
  ) => ({
    path,
    name,
    parent: opts.parent ?? [],
    specialUse: opts.specialUse,
    specialUseSource: opts.source,
    flags: new Set(opts.flags ?? []),
  });
  expect(findTrashPath([f("INBOX", "INBOX"), f("Deleted Items", "Deleted Items")])).toBe(
    "Deleted Items"
  );
  expect(
    findTrashPath([f("Trash", "Trash"), f("[Gmail]/Bin", "Bin", { specialUse: "\\Trash" })])
  ).toBe("[Gmail]/Bin");
  expect(findTrashPath([f("Trash", "Trash", { flags: ["\\Noselect"] })])).toBeNull();
  expect(findTrashPath([f("INBOX", "INBOX")])).toBeNull();
  // Dovecot-style INBOX.Trash is a direct child of INBOX: accepted
  expect(findTrashPath([f("INBOX/Trash", "Trash", { parent: ["INBOX"] })])).toBe("INBOX/Trash");
  // a custom folder that merely has a trash-like name deeper in the tree is NOT the Trash
  expect(findTrashPath([f("Projects/Deleted", "Deleted", { parent: ["Projects"] })])).toBeNull();
  expect(
    findTrashPath([f("Archive/2024/Trash", "Trash", { parent: ["Archive", "2024"] })])
  ).toBeNull();
  // imapflow guesses "\\Trash" from the name of Projects/Deleted: a guess does not count there
  expect(
    findTrashPath([
      f("Projects/Deleted", "Deleted", {
        parent: ["Projects"],
        specialUse: "\\Trash",
        source: "name",
      }),
    ])
  ).toBeNull();
  // ...but what the server declared counts at any depth
  expect(
    findTrashPath([
      f("Mail/Bin", "Bin", { parent: ["Mail"], specialUse: "\\Trash", source: "extension" }),
    ])
  ).toBe("Mail/Bin");
  // ...even next to a real one, and special-use still wins
  expect(
    findTrashPath([f("Projects/Trash", "Trash", { parent: ["Projects"] }), f("Bin", "Bin")])
  ).toBe("Bin");
});

test("a nested custom folder named Deleted is never used as the Trash", async () => {
  const f = folders({ trash: false });
  f.push({ path: "Projects/Deleted", uidValidity: 21, messages: [] });
  const s = await start(f);
  expect(await manage.remove(login(s.port), { folder: "INBOX", uid: 2, permanent: false })).toEqual(
    { ok: false, code: "trash_not_found" }
  );
  expect(uids(s, "INBOX")).toEqual([1, 2, 3, 4]);
  expect(uids(s, "Projects/Deleted")).toEqual([]);
});

test("no MOVE and the expunge is refused: the original stays unmarked, the copy is reported as partial", async () => {
  const s = await start();
  s.moveCapability = false;
  s.denyExpunge = true;
  const r = await manage.move(login(s.port), { folder: "INBOX", uid: 2, destination: "Archive" });
  expect(r).toEqual({ ok: false, code: "partial" });
  expect(uids(s, "INBOX")).toEqual([1, 2, 3, 4]);
  expect(flagsOf(s, "INBOX", 2)).toEqual([]); // \Deleted was taken back
  expect(uids(s, "Archive")).toEqual([1]); // the copy exists: the outcome is not "nothing happened"
});

test("an error after a change was sent is connection_lost (outcome unknown), never timeout/unknown", async () => {
  const s = await start();
  const t = login(s.port);
  // the read-back after STORE is the second UID FETCH of the session
  s.dropOn = "UID FETCH";
  s.dropSkip = 1;
  expect(await manage.setFlag(t, { folder: "INBOX", uid: 2, flag: "seen", value: true })).toEqual({
    ok: false,
    code: "connection_lost",
  });
  expect(flagsOf(s, "INBOX", 2)).toEqual(["\\Seen"]); // it did happen: the caller must not claim it did not
  // the same drop BEFORE any change is an ordinary failure
  s.dropOn = "UID FETCH";
  s.dropSkip = 0;
  const before = await manage.setFlag(t, { folder: "INBOX", uid: 3, flag: "seen", value: true });
  expect(before.ok).toBe(false);
  expect(before.ok === false && before.code).not.toBe("connection_lost");
});

// ---- search ------------------------------------------------------------------

test("search: sender, subject, body and dates, with newest-first paging and a match count", async () => {
  const s = await start();
  const t = login(s.port);
  const from = await manage.search(t, { folder: "INBOX", criteria: { from: "ada" }, limit: 10 });
  expect(from).toMatchObject({
    ok: true,
    value: { uidValidity: 11, matches: 2, nextBefore: null },
  });
  if (from.ok) expect(from.value.headers.map((h) => h.uid)).toEqual([4, 1]);

  const subject = await manage.search(t, {
    folder: "INBOX",
    criteria: { subject: "lunch" },
    limit: 10,
  });
  if (!subject.ok) throw new Error("subject");
  expect(subject.value.headers.map((h) => h.uid)).toEqual([2]);

  const body = await manage.search(t, {
    folder: "INBOX",
    criteria: { body: "psf plots" },
    limit: 10,
  });
  if (!body.ok) throw new Error("body");
  expect(body.value.headers.map((h) => h.uid)).toEqual([2]);

  // since is inclusive, before exclusive
  const dates = await manage.search(t, {
    folder: "INBOX",
    criteria: { since: "2026-10-06", before: "2026-10-08" },
    limit: 10,
  });
  if (!dates.ok) throw new Error("dates");
  expect(dates.value.headers.map((h) => h.uid)).toEqual([3, 2]);

  // free text means sender OR subject OR body
  const text = await manage.search(t, { folder: "INBOX", criteria: { text: "ada" }, limit: 10 });
  if (!text.ok) throw new Error("text");
  expect(text.value.headers.map((h) => h.uid)).toEqual([4, 1]);
  const text2 = await manage.search(t, {
    folder: "INBOX",
    criteria: { text: "table 2" },
    limit: 10,
  });
  if (!text2.ok) throw new Error("text2");
  expect(text2.value.headers.map((h) => h.uid)).toEqual([4]);

  // terms combine with AND
  const both = await manage.search(t, {
    folder: "INBOX",
    criteria: { from: "ada", subject: "referee" },
    limit: 10,
  });
  if (!both.ok) throw new Error("both");
  expect(both.value.headers.map((h) => h.uid)).toEqual([4]);

  const page1 = await manage.search(t, {
    folder: "INBOX",
    criteria: { since: "2026-01-01" },
    limit: 3,
  });
  if (!page1.ok) throw new Error("page1");
  expect(page1.value).toMatchObject({ matches: 4, nextBefore: 2 });
  expect(page1.value.headers.map((h) => h.uid)).toEqual([4, 3, 2]);
  const page2 = await manage.search(t, {
    folder: "INBOX",
    criteria: { since: "2026-01-01" },
    before: 2,
    limit: 3,
  });
  if (!page2.ok) throw new Error("page2");
  expect(page2.value.headers.map((h) => h.uid)).toEqual([1]);
  expect(page2.value.nextBefore).toBeNull();
});

test("search handles non-ASCII terms (sent as a literal with CHARSET UTF-8) and decoded subjects", async () => {
  const s = await start();
  const t = login(s.port);
  const body = await manage.search(t, {
    folder: "INBOX",
    criteria: { body: "über cosmic" },
    limit: 10,
  });
  if (!body.ok) throw new Error("body");
  expect(body.value.headers.map((h) => h.uid)).toEqual([3]);
  const subject = await manage.search(t, {
    folder: "INBOX",
    criteria: { subject: "你好" },
    limit: 10,
  });
  if (!subject.ok) throw new Error("subject");
  expect(subject.value.headers.map((h) => h.uid)).toEqual([3]);
  expect(subject.value.headers[0]?.subject).toBe("你好 Hello");
  expect(subject.value.headers[0]?.starred).toBe(true);
});

test("search: no match is an empty success, a failing server is an error, never an empty list", async () => {
  const s = await start();
  const t = login(s.port);
  expect(
    await manage.search(t, { folder: "INBOX", criteria: { from: "nobody@nowhere" }, limit: 10 })
  ).toEqual({ ok: true, value: { uidValidity: 11, matches: 0, headers: [], nextBefore: null } });

  s.denySearch = true;
  expect(await manage.search(t, { folder: "INBOX", criteria: { from: "ada" }, limit: 10 })).toEqual(
    {
      ok: false,
      code: "refused",
    }
  );
  s.denySearch = false;
  expect(await manage.search(t, { folder: "Nope", criteria: { from: "ada" }, limit: 10 })).toEqual({
    ok: false,
    code: "folder_not_found",
  });
  s.dropOn = "UID SEARCH";
  expect(await manage.search(t, { folder: "INBOX", criteria: { from: "ada" }, limit: 10 })).toEqual(
    {
      ok: false,
      code: "connection_lost",
    }
  );
  expect(
    await manage.search(login(s.port, "wrong"), {
      folder: "INBOX",
      criteria: { from: "a" },
      limit: 5,
    })
  ).toEqual({ ok: false, code: "auth_failed" });
});

test("searching never changes a message: the mailbox is only EXAMINEd and flags stay put", async () => {
  const s = await start();
  await manage.search(login(s.port), { folder: "INBOX", criteria: { from: "ada" }, limit: 10 });
  expect(s.commands).toContain("EXAMINE INBOX");
  expect(s.commands).not.toContain("SELECT INBOX");
  expect(s.commands.filter((c) => c.startsWith("UID STORE"))).toEqual([]);
  expect(flagsOf(s, "INBOX", 2)).toEqual([]);
});

test("searchQuery: date-only terms become UTC midnights and text becomes sender OR subject OR body", () => {
  expect(searchQuery({ text: "x", since: "2026-10-06" })).toEqual({
    or: [{ from: "x" }, { subject: "x" }, { body: "x" }],
    sentSince: new Date("2026-10-06T00:00:00.000Z"),
  });
});

test("a slow server-side SEARCH is not cut off by the short connection timeout", async () => {
  const s = await start();
  s.searchDelayMs = 900;
  const slowOk = createNodeMailManage({
    timeoutMs: 300,
    searchTimeoutMs: 3000,
    tls: { rejectUnauthorized: false },
  });
  const r = await slowOk.search(login(s.port), {
    folder: "INBOX",
    criteria: { from: "ada" },
    limit: 10,
  });
  expect(r.ok && r.value.matches).toBe(2);
  // without the longer search timeout the same search times out
  const strict = createNodeMailManage({
    timeoutMs: 300,
    searchTimeoutMs: 0,
    tls: { rejectUnauthorized: false },
  });
  const cut = await strict.search(login(s.port), {
    folder: "INBOX",
    criteria: { from: "ada" },
    limit: 10,
  });
  expect(cut.ok).toBe(false);
});

test("date terms are asked as SENT* (the Date header the list shows), not by arrival time", () => {
  expect(searchQuery({ since: "2026-10-06", before: "2026-10-08" })).toEqual({
    sentSince: new Date("2026-10-06T00:00:00.000Z"),
    sentBefore: new Date("2026-10-08T00:00:00.000Z"),
  });
});

test("the package index hands out no raw IMAP client helpers", () => {
  for (const internal of [
    "imapClient",
    "imapSocketOptions",
    "toHeader",
    "remoteCode",
    "isConventionalPlace",
  ])
    expect(Object.keys(infra)).not.toContain(internal);
});
