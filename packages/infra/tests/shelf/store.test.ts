import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shelfAnnotationCount } from "@argelanderspace/contracts";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resolveGlobalDirs } from "../../src/global-dirs.js";
import {
  createShelfStore,
  resolveShelfDir,
  SHELF_LOCK,
  SHELF_MANIFEST_FILE,
  ShelfInputError,
  ShelfIoError,
  type ShelfPutInput,
  type ShelfPutResult,
  shelfIdentityOf,
} from "../../src/shelf/store.js";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "shelf-store-")), "shelf");
});

const enc = (s: string) => Buffer.from(s, "utf8");
const annotations = (n: number) =>
  enc(
    JSON.stringify({
      version: 1,
      rev: 3,
      annotations: Array.from({ length: n }, (_, i) => ({ id: `a${i}` })),
    })
  );
const realWrite = (path: string, bytes: Uint8Array) => writeFile(path, bytes, { flag: "wx" });

/** A Work with a LaTeX Doc (with an asset and two annotations), a PDF Doc, an argument graph and a note. */
function input(over: Partial<ShelfPutInput> = {}, title = "A paper"): ShelfPutInput {
  return {
    bibliography: {
      title,
      authors: ["Hubble"],
      year: 1929,
      doi: "10.1073/PNAS.15.3.168",
      arxiv_id: null,
      venue: "PNAS",
    },
    source: { project: "/home/u/projects/one", workId: "doi:10.1073/pnas.15.3.168" },
    docs: [
      {
        docId: "arxiv-1234.5678",
        kind: "latex",
        files: [
          { path: "arxiv-1234.5678.json", bytes: enc('{"version":1}') },
          { path: "assets/fig1.svg", bytes: enc("<svg/>") },
        ],
        annotations: { count: 2, bytes: annotations(2) },
      },
      {
        docId: "pdf-1",
        kind: "pdf",
        files: [
          { path: "pdf-1.json", bytes: enc('{"format":"pdf"}') },
          { path: "original.pdf", bytes: enc("%PDF-1.7 …") },
        ],
        annotations: null,
      },
    ],
    argumentGraph: enc('{"version":1,"work_id":"doi:10.1073/pnas.15.3.168","arguments":[]}'),
    note: "my note",
    ...over,
  };
}

/** A Work with only these identifiers (or none) and no Docs. */
function bare(title: string, ids: { doi?: string; arxiv_id?: string; openalex_id?: string } = {}) {
  return input({
    docs: [],
    argumentGraph: null,
    note: null,
    bibliography: { title, authors: [], year: null, ...ids },
  });
}

function ok(r: ShelfPutResult) {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.entry;
}

/** Everything under the Shelf directory except the lock, as relative paths. */
function tree(root = dir): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    for (const d of readdirSync(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (r === SHELF_LOCK) continue;
      if (d.isDirectory()) {
        out.push(`${r}/`);
        visit(r);
      } else out.push(r);
    }
  };
  if (existsSync(root)) visit("");
  return out.sort();
}
const leftovers = () => tree().filter((p) => /^(staging|trash)\/./.test(p));

describe("new, replace, delete", () => {
  test("a new entry is listed with its size, read back byte for byte and verified", async () => {
    const s = createShelfStore({ dir });
    expect(await s.list()).toEqual([]);
    const e = ok(await s.put(input(), { mode: "new" }));
    expect(e.rev).toBe(1);
    expect(e.entryId).toMatch(/^[0-9a-f]{32}$/);
    const m = e.manifest;
    expect(m.format).toBe(1);
    expect(m.identity).toEqual({ doi: "10.1073/pnas.15.3.168", arxiv: null, openalex: null });
    expect(m.source).toEqual({
      project: "/home/u/projects/one",
      work_id: "doi:10.1073/pnas.15.3.168",
    });
    expect(m.docs.map((d) => [d.doc_id, d.kind, d.annotations?.count ?? null])).toEqual([
      ["arxiv-1234.5678", "latex", 2],
      ["pdf-1", "pdf", null],
    ]);
    expect(shelfAnnotationCount(m)).toBe(2);
    expect(m.argument_graph).not.toBeNull();
    expect(m.note).not.toBeNull();

    const listed = await s.list();
    expect(listed).toHaveLength(1);
    const item = listed[0];
    if (item?.status !== "ok") throw new Error("not ok");
    const manifestSize = readFileSync(
      join(dir, "entries", `${e.entryId}.r1`, SHELF_MANIFEST_FILE)
    ).length;
    const files = input();
    const payload =
      files.docs
        .flatMap((d) => [...d.files.map((f) => f.bytes.length), d.annotations?.bytes.length ?? 0])
        .reduce((a, b) => a + b, 0) +
      (files.argumentGraph?.length ?? 0) +
      enc("my note").length;
    expect(item.bytes).toBe(manifestSize + payload);
    expect(item.bytes).toBe(e.bytes);

    expect((await s.verify(e.entryId)).status).toBe("ok");
    const read = await s.read(e.entryId);
    if (read.status !== "ok") throw new Error(read.status);
    expect(read.docs[0]?.files.map((f) => [f.path, f.bytes.toString()])).toEqual([
      ["arxiv-1234.5678.json", '{"version":1}'],
      ["assets/fig1.svg", "<svg/>"],
    ]);
    expect(read.docs[0]?.annotations?.count).toBe(2);
    expect(read.docs[0]?.annotations?.bytes.equals(annotations(2))).toBe(true);
    expect(read.docs[1]?.annotations).toBeNull();
    expect(read.argumentGraph?.toString()).toContain('"arguments":[]');
    expect(read.note).toBe("my note");
    expect(leftovers()).toEqual([]);
    expect(existsSync(join(dir, SHELF_LOCK))).toBe(false); // released
  });

  test("replace at the current rev swaps the whole entry; a stale rev changes nothing", async () => {
    const s = createShelfStore({ dir });
    const id = ok(await s.put(input(), { mode: "new" })).entryId;
    const smaller = input({ docs: [], argumentGraph: null, note: null }, "Replaced");
    const e = ok(await s.put(smaller, { mode: "replace", targets: [{ entryId: id, rev: 1 }] }));
    expect(e.entryId).toBe(id);
    expect(e.rev).toBe(2);
    expect(readdirSync(join(dir, "entries"))).toEqual([`${id}.r2`]);
    const read = await s.read(id);
    if (read.status !== "ok") throw new Error(read.status);
    expect(read.entry.manifest.bibliography.title).toBe("Replaced");
    expect(read.docs).toEqual([]);
    expect(read.note).toBeNull();

    const before = tree();
    expect(await s.put(input(), { mode: "replace", targets: [{ entryId: id, rev: 1 }] })).toEqual({
      ok: false,
      reason: "rev_mismatch",
      entryId: id,
      currentRev: 2,
    });
    const nobody = "0".repeat(32);
    expect(
      await s.put(input(), { mode: "replace", targets: [{ entryId: nobody, rev: 1 }] })
    ).toEqual({
      ok: false,
      reason: "not_found",
      entryId: nobody,
    });
    expect(tree()).toEqual(before);
    expect(await s.read(id, { rev: 1 })).toEqual({ status: "changed", rev: 2 });
    await expect(s.put(input(), { mode: "replace", targets: [] })).rejects.toBeInstanceOf(
      ShelfInputError
    );
  });

  test("delete at the current rev removes the entry; a stale rev or unknown id changes nothing", async () => {
    const s = createShelfStore({ dir });
    const e = ok(await s.put(input(), { mode: "new" }));
    const before = tree();
    expect(await s.delete(e.entryId, 7)).toEqual({
      ok: false,
      reason: "rev_mismatch",
      currentRev: 1,
    });
    expect(await s.delete("f".repeat(32), 1)).toEqual({ ok: false, reason: "not_found" });
    expect(tree()).toEqual(before);
    expect(await s.delete(e.entryId, 1)).toEqual({ ok: true });
    expect(await s.list()).toEqual([]);
    expect(await s.read(e.entryId)).toEqual({ status: "not_found" });
    expect(tree()).toEqual(["entries/", "staging/", "trash/"]);
  });

  test("the same paper cannot be added twice: a new put names the entry to replace, with its rev", async () => {
    const s = createShelfStore({ dir });
    const e = ok(await s.put(input(), { mode: "new" }));
    const again = input();
    again.bibliography = { ...again.bibliography, doi: "https://doi.org/10.1073/pnas.15.3.168" };
    expect(await s.put(again, { mode: "new" })).toEqual({
      ok: false,
      reason: "identity_taken",
      entries: [{ entryId: e.entryId, rev: 1 }],
    });
    // Without DOI, arXiv or OpenAlex id there is no "same paper": each add is a new entry (spec, split note a).
    ok(await s.put(bare("A paper"), { mode: "new" }));
    ok(await s.put(bare("A paper"), { mode: "new" }));
    expect(await s.list()).toHaveLength(3);
  });

  test("a Work that is the same paper as two entries replaces both at once, and only both", async () => {
    const s = createShelfStore({ dir });
    const a = ok(await s.put(bare("A", { doi: "10.1/x" }), { mode: "new" }));
    const b = ok(await s.put(bare("B", { arxiv_id: "2401.00001v2" }), { mode: "new" }));
    const other = ok(await s.put(bare("Other", { doi: "10.9/other" }), { mode: "new" }));
    const both = bare("Both", { doi: "10.1/X", arxiv_id: "2401.00001" });
    const taken = await s.put(both, { mode: "new" });
    if (taken.ok || taken.reason !== "identity_taken") throw new Error(JSON.stringify(taken));
    const sorted = (refs: { entryId: string; rev: number }[]) =>
      [...refs].sort((x, y) => (x.entryId < y.entryId ? -1 : 1));
    expect(sorted(taken.entries)).toEqual(
      sorted([
        { entryId: a.entryId, rev: 1 },
        { entryId: b.entryId, rev: 1 },
      ])
    );
    const before = tree();
    // Only one of them, or one too many: refused with the set as it is.
    for (const targets of [
      [{ entryId: a.entryId, rev: 1 }],
      [
        { entryId: a.entryId, rev: 1 },
        { entryId: b.entryId, rev: 1 },
        { entryId: other.entryId, rev: 1 },
      ],
    ]) {
      const r = await s.put(both, { mode: "replace", targets });
      expect(r.ok === false && r.reason === "identity_taken" && sorted(r.entries)).toEqual(
        sorted(taken.entries)
      );
    }
    expect(tree()).toEqual(before);

    const e = ok(
      await s.put(both, {
        mode: "replace",
        targets: [
          { entryId: a.entryId, rev: 1 },
          { entryId: b.entryId, rev: 1 },
        ],
      })
    );
    expect([e.entryId, e.rev]).toEqual([a.entryId, 2]);
    expect((await s.list()).map((i) => i.entryId).sort()).toEqual(
      [a.entryId, other.entryId].sort()
    );
    expect(await s.read(b.entryId)).toEqual({ status: "not_found" });
    expect(readdirSync(join(dir, "entries")).sort()).toEqual(
      [`${a.entryId}.r2`, `${other.entryId}.r1`].sort()
    );
  });

  test("put rejects input that is not an entry and writes nothing", async () => {
    const s = createShelfStore({ dir });
    const doc = (
      docId: string,
      kind: "latex" | "pdf" | "text",
      files: string[],
      ann?: ShelfPutInput["docs"][number]["annotations"]
    ) =>
      input({
        docs: [
          {
            docId,
            kind,
            files: files.map((path) => ({ path, bytes: enc("{}") })),
            annotations: ann ?? null,
          },
        ],
      });
    const bad: ShelfPutInput[] = [
      input({ bibliography: { title: "x", authors: [], year: null, tags: ["mine"] } as never }),
      input({ bibliography: { title: "x", authors: [], year: null, origin: "manual" } as never }),
      doc("arxiv-1", "latex", ["build/main.aux", "arxiv-1.json"]),
      doc("arxiv-1", "latex", ["src/main.tex", "arxiv-1.json"]),
      doc("pdf-2", "pdf", ["pdf-2.json"]),
      doc("pdf-2", "pdf", ["pdf-2.json", "original.pdf", "reading-position.json"]),
      doc("../x", "text", ["text-source.json"]),
      doc("text-1", "text", ["assets/../../x", "text-source.json"]),
      doc("text-1", "text", ["text-source.json"], { count: 3, bytes: annotations(2) }),
      input({ argumentGraph: enc("{not json") }),
    ];
    for (const b of bad)
      await expect(s.put(b, { mode: "new" })).rejects.toBeInstanceOf(ShelfInputError);
    expect(await s.list()).toEqual([]);
    // A text Doc without its generated reading text (a draft) is a legal entry.
    ok(await s.put(doc("text-1", "text", ["text-source.json", "assets/a.png"]), { mode: "new" }));
  });
});

describe("identity", () => {
  test("only DOI, arXiv without its version and OpenAlex id are matched", async () => {
    expect(
      shelfIdentityOf({
        doi: "doi:10.1/AbC",
        arxiv_id: "arXiv:2401.01234v3",
        openalex_id: "https://openalex.org/w42",
      })
    ).toEqual({ doi: "10.1/abc", arxiv: "2401.01234", openalex: "W42" });
    // An arXiv DataCite DOI is the arXiv id.
    expect(shelfIdentityOf({ doi: "10.48550/arXiv.2401.01234" })).toEqual({
      doi: null,
      arxiv: "2401.01234",
      openalex: null,
    });

    const s = createShelfStore({ dir });
    const e = ok(
      await s.put(bare("Same title", { arxiv_id: "2401.01234v1", openalex_id: "W7" }), {
        mode: "new",
      })
    );
    expect(
      (await s.findByIdentity({ arxiv: "2401.01234v2" })).map((x) => [x.entryId, x.matchedOn])
    ).toEqual([[e.entryId, ["arxiv"]]]);
    expect(
      (await s.findByIdentity({ doi: "10.48550/arxiv.2401.01234", openalex: "w7" }))[0]?.matchedOn
    ).toEqual(["arxiv", "openalex"]);
    expect(await s.findByIdentity({ doi: "10.9/other" })).toEqual([]);
    expect(await s.findByIdentity({})).toEqual([]);
  });
});

describe("a write that fails leaves nothing behind and changes no entry", () => {
  test("writing into staging fails", async () => {
    let n = 0;
    const s = createShelfStore({
      dir,
      io: {
        async writeFile(path, bytes) {
          if (++n === 3) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
          await realWrite(path, bytes);
        },
      },
    });
    await expect(s.put(input(), { mode: "new" })).rejects.toThrow("disk full");
    expect(tree()).toEqual(["entries/", "staging/", "trash/"]);
  });

  test("renaming the staged entry into place fails, on a new entry and on a replacement", async () => {
    let failRename = false;
    const s = createShelfStore({
      dir,
      io: {
        async rename(from, to) {
          if (failRename && to.includes("entries"))
            throw Object.assign(new Error("rename refused"), { code: "EXDEV" });
          await rename(from, to);
        },
      },
    });
    failRename = true;
    await expect(s.put(input(), { mode: "new" })).rejects.toThrow("rename refused");
    expect(tree()).toEqual(["entries/", "staging/", "trash/"]);

    failRename = false;
    const e = ok(await s.put(input(), { mode: "new" }));
    const before = tree();
    const bytesBefore = readFileSync(join(dir, "entries", `${e.entryId}.r1`, SHELF_MANIFEST_FILE));
    failRename = true;
    await expect(
      s.put(input({}, "New"), { mode: "replace", targets: [{ entryId: e.entryId, rev: 1 }] })
    ).rejects.toThrow("rename refused");
    expect(tree()).toEqual(before);
    expect(
      readFileSync(join(dir, "entries", `${e.entryId}.r1`, SHELF_MANIFEST_FILE)).equals(bytesBefore)
    ).toBe(true);
    expect((await s.verify(e.entryId)).status).toBe("ok");
  });

  test("removing the old entry after a replacement fails: the new one is the entry, the next write tidies", async () => {
    let failTrash = false;
    const s = createShelfStore({
      dir,
      io: {
        async rename(from, to) {
          if (failTrash && to.includes("trash"))
            throw Object.assign(new Error("busy"), { code: "EBUSY" });
          await rename(from, to);
        },
      },
    });
    const id = ok(await s.put(input(), { mode: "new" })).entryId;
    failTrash = true;
    ok(await s.put(input({}, "New"), { mode: "replace", targets: [{ entryId: id, rev: 1 }] }));
    expect(readdirSync(join(dir, "entries")).sort()).toEqual([`${id}.r1`, `${id}.r2`]);
    const listed = await s.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.rev).toBe(2);
    const read = await s.read(id);
    expect(read.status === "ok" && read.entry.manifest.bibliography.title).toBe("New");
    failTrash = false;
    ok(await s.put(bare("Other"), { mode: "new" }));
    expect(readdirSync(join(dir, "entries")).filter((n) => n.startsWith(id))).toEqual([`${id}.r2`]);
  });
});

describe("entries this build cannot use", () => {
  const futureEntry = (id: string, rev: number) => {
    const entry = join(dir, "entries", `${id}.r${rev}`);
    mkdirSync(join(entry, "payload"), { recursive: true });
    writeFileSync(
      join(entry, SHELF_MANIFEST_FILE),
      JSON.stringify({
        format: 2,
        entry_id: id,
        rev,
        bibliography: { title: "From the future" },
        whatever: [1],
      })
    );
    writeFileSync(join(entry, "payload", "blob.bin"), Buffer.alloc(1000));
    return entry;
  };

  test("an entry of a later format is listed, never read, never replaced, and can be deleted", async () => {
    const s = createShelfStore({ dir });
    const id = "a".repeat(32);
    const entry = futureEntry(id, 4);
    const manifestBytes = readFileSync(join(entry, SHELF_MANIFEST_FILE));

    expect(await s.list()).toEqual([
      {
        status: "incompatible",
        entryId: id,
        rev: 4,
        bytes: manifestBytes.length + 1000,
        format: 2,
        title: "From the future",
      },
    ]);
    expect(await s.read(id)).toEqual({ status: "incompatible", rev: 4 });
    expect(await s.verify(id)).toEqual({ status: "incompatible", rev: 4 });
    expect(await s.findByIdentity({ doi: "10.1073/pnas.15.3.168" })).toEqual([]);
    expect(await s.put(input(), { mode: "replace", targets: [{ entryId: id, rev: 4 }] })).toEqual({
      ok: false,
      reason: "incompatible",
      entryId: id,
      currentRev: 4,
    });
    ok(await s.put(bare("Other"), { mode: "new" }));
    expect(readFileSync(join(entry, SHELF_MANIFEST_FILE)).equals(manifestBytes)).toBe(true);
    expect(readdirSync(entry).sort()).toEqual([SHELF_MANIFEST_FILE, "payload"]);

    expect(await s.delete(id, 4)).toEqual({ ok: true });
    expect(existsSync(entry)).toBe(false);
  });

  test("tidying leaves every directory of an id alone when its newest one is of a later format", async () => {
    const s = createShelfStore({ dir });
    const id = ok(await s.put(input(), { mode: "new" })).entryId;
    // A later build replaced it (r2, format 2) and was stopped before removing r1.
    futureEntry(id, 2);
    ok(await s.put(bare("Other"), { mode: "new" })); // a write: it tidies
    expect(
      readdirSync(join(dir, "entries"))
        .filter((n) => n.startsWith(id))
        .sort()
    ).toEqual([`${id}.r1`, `${id}.r2`]);
    expect((await s.list()).find((i) => i.entryId === id)?.status).toBe("incompatible");
  });

  test("a file whose bytes no longer match its hash fails verify and read; list still shows the entry", async () => {
    const s = createShelfStore({ dir });
    const id = ok(await s.put(input(), { mode: "new" })).entryId;
    const fig = join(dir, "entries", `${id}.r1`, "docs", "arxiv-1234.5678", "assets", "fig1.svg");
    writeFileSync(fig, "<svg>");
    expect(await s.verify(id)).toEqual({ status: "damaged", rev: 1, problem: "file_changed" });
    expect(await s.read(id)).toEqual({ status: "damaged", rev: 1, problem: "file_changed" });
    writeFileSync(fig, "<svh/>"); // same length: the hash is what fails
    expect(await s.verify(id)).toEqual({ status: "damaged", rev: 1, problem: "file_changed" });
    expect((await s.list())[0]?.status).toBe("ok"); // the list does not hash; verify does
  });

  test("readPart gives the graph or note bytes of the listed rev, checked; absent, changed or replaced is null", async () => {
    const s = createShelfStore({ dir });
    const e = ok(await s.put(input(), { mode: "new" }));
    const listed = await s.list();
    const item = listed[0];
    if (item?.status !== "ok") throw new Error("not listed");
    expect((await s.readPart(item, "note"))?.toString("utf8")).toBe("my note");
    expect((await s.readPart(item, "argument_graph"))?.toString("utf8")).toContain(
      '"arguments":[]'
    );
    // a part the entry does not carry
    const bareEntry = ok(await s.put(bare("No parts", { doi: "10.1/none" }), { mode: "new" }));
    expect(await s.readPart(bareEntry, "note")).toBeNull();
    expect(await s.readPart(bareEntry, "argument_graph")).toBeNull();
    // a file whose bytes no longer match the manifest is not handed out
    writeFileSync(join(dir, "entries", `${e.entryId}.r1`, "note.md"), "my notf");
    expect(await s.readPart(item, "note")).toBeNull();
    // replaced meanwhile: the old rev's files are gone, never the new rev's bytes
    ok(
      await s.put(input({ note: "newer note" }), {
        mode: "replace",
        targets: [{ entryId: e.entryId, rev: 1 }],
      })
    );
    expect(await s.readPart(item, "argument_graph")).toBeNull();
  });

  test("missing, extra and misplaced files and manifests are damage; damaged entries can only be deleted", async () => {
    const s = createShelfStore({ dir });
    const id = ok(await s.put(input(), { mode: "new" })).entryId;
    const entry = join(dir, "entries", `${id}.r1`);
    writeFileSync(join(entry, "docs", "pdf-1", "reading-position.json"), "{}");
    expect(await s.verify(id)).toEqual({ status: "damaged", rev: 1, problem: "file_unexpected" });

    const notJson = "b".repeat(32);
    mkdirSync(join(dir, "entries", `${notJson}.r1`));
    writeFileSync(join(dir, "entries", `${notJson}.r1`, SHELF_MANIFEST_FILE), "{not json");
    const none = "c".repeat(32);
    mkdirSync(join(dir, "entries", `${none}.r1`));
    const asDir = "d".repeat(32);
    mkdirSync(join(dir, "entries", `${asDir}.r1`, SHELF_MANIFEST_FILE), { recursive: true });
    const statuses = Object.fromEntries(
      (await s.list()).map((i) => [i.entryId, i.status === "damaged" ? i.problem : i.status])
    );
    expect(statuses).toEqual({
      [id]: "ok",
      [notJson]: "manifest_unreadable",
      [none]: "manifest_missing",
      [asDir]: "manifest_not_a_file",
    });
    expect(await s.verify(asDir)).toEqual({
      status: "damaged",
      rev: 1,
      problem: "manifest_not_a_file",
    });
    // Replacing a damaged entry is refused (its identity is unknown, so it is never "the same paper").
    const r = await s.put(bare("Fixed"), { mode: "replace", targets: [{ entryId: none, rev: 1 }] });
    expect(r).toEqual({ ok: false, reason: "damaged", entryId: none, problem: "manifest_missing" });
    expect(await s.delete(notJson, 1)).toEqual({ ok: true });
  });

  test("an entry that cannot be read for a system reason is unreadable, never damaged; read throws", async () => {
    const s = createShelfStore({ dir });
    const id = ok(await s.put(input(), { mode: "new" })).entryId;
    const entry = join(dir, "entries", `${id}.r1`);
    chmodSync(join(entry, SHELF_MANIFEST_FILE), 0o000);
    try {
      expect(await s.list()).toEqual([
        { status: "unreadable", entryId: id, rev: 1, bytes: 0, code: "EACCES" },
      ]);
      await expect(s.read(id)).rejects.toBeInstanceOf(ShelfIoError);
      await expect(s.verify(id)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(join(entry, SHELF_MANIFEST_FILE), 0o600);
    }
    chmodSync(entry, 0o000);
    try {
      expect((await s.list())[0]).toMatchObject({ status: "unreadable", code: "EACCES" });
      await expect(s.read(id)).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(entry, 0o700);
    }
    expect((await s.verify(id)).status).toBe("ok");
  });

  test("adding while another entry cannot be read stops with ShelfIoError instead of treating it as a different paper", async () => {
    const s = createShelfStore({ dir });
    const id = ok(await s.put(input(), { mode: "new" })).entryId;
    const manifest = join(dir, "entries", `${id}.r1`, SHELF_MANIFEST_FILE);
    chmodSync(manifest, 0o000);
    try {
      await expect(s.put(input(), { mode: "new" })).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      chmodSync(manifest, 0o600);
    }
    expect((await s.list()).map((i) => i.entryId)).toEqual([id]);
  });
});

describe("the lock", () => {
  test("waiting too long for another holder is a plain busy result, nothing written", async () => {
    mkdirSync(dir, { recursive: true });
    const release = await lockfile.lock(dir, {
      lockfilePath: join(dir, SHELF_LOCK),
      stale: 15_000,
    });
    try {
      const s = createShelfStore({ dir, lockRetries: 1 });
      expect(await s.put(input(), { mode: "new" })).toEqual({ ok: false, reason: "busy" });
      expect(await s.delete("a".repeat(32), 1)).toEqual({ ok: false, reason: "busy" });
      expect(readdirSync(join(dir, "entries"))).toEqual([]);
    } finally {
      await release();
    }
  });

  test("a write whose timers were held up, but whose lock nobody took, still completes and lets go", async () => {
    let stalled = false;
    const s = createShelfStore({
      dir,
      lockStaleMs: 2000,
      io: {
        async writeFile(path, bytes) {
          if (!stalled) {
            stalled = true;
            const until = Date.now() + 1500; // past half the stale threshold
            while (Date.now() < until) {
              /* blocked */
            }
          }
          await realWrite(path, bytes);
        },
      },
    });
    ok(await s.put(input(), { mode: "new" }));
    expect(existsSync(join(dir, SHELF_LOCK))).toBe(false);
    expect((await s.list())[0]?.status).toBe("ok");
  }, 20_000);
});

describe("across processes", () => {
  const worker = fileURLToPath(new URL("./put-worker.mjs", import.meta.url));
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children) c.kill();
    children.length = 0;
  });
  const run = (args: string[]) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const p = spawn(process.execPath, ["--no-warnings", worker, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.push(p);
      let out = "";
      let err = "";
      p.stdout.on("data", (d) => {
        out += d;
      });
      p.stderr.on("data", (d) => {
        err += d;
      });
      p.on("error", reject);
      p.on("close", () => {
        try {
          resolve(JSON.parse(out.trim()));
        } catch {
          reject(new Error(`worker output: ${out} ${err}`));
        }
      });
    });
  const waitFor = async (cond: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > until) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  test("processes adding the same paper at once: one entry, whole; the others are told to replace it", async () => {
    const results = await Promise.all([1, 2, 3, 4].map((n) => run(["new", dir, String(n)])));
    expect(results.filter((r) => r.ok === true)).toHaveLength(1);
    expect(results.filter((r) => r.reason === "identity_taken")).toHaveLength(3);
    const s = createShelfStore({ dir });
    const listed = await s.list();
    expect(listed).toHaveLength(1);
    expect((await s.verify(listed[0]?.entryId as string)).status).toBe("ok");
    expect(leftovers()).toEqual([]);
  }, 60_000);

  test("processes replacing the same entry at the same rev: exactly one wins, the entry stays whole", async () => {
    const s = createShelfStore({ dir });
    const seed = await run(["new", dir, "0"]);
    const id = seed.entryId as string;
    const results = await Promise.all([1, 2, 3].map(() => run(["replace", dir, id, "1"])));
    expect(results.filter((r) => r.ok === true)).toEqual([{ ok: true, rev: 2, entryId: id }]);
    expect(results.filter((r) => r.reason === "rev_mismatch")).toHaveLength(2);
    const v = await s.read(id);
    if (v.status !== "ok") throw new Error(v.status);
    expect(v.entry.rev).toBe(2);
    expect(readdirSync(join(dir, "entries"))).toEqual([`${id}.r2`]);
  }, 60_000);

  test("a process that stalls past the stale threshold loses the lock: it writes nothing and leaves the new holder's lock", async () => {
    const marker = join(dir, "..", "stalled");
    const stalled = run(["stall", dir, marker]);
    await waitFor(() => existsSync(marker), 20_000);
    // This process takes the lock over once it is stale, and holds it while the stalled one wakes up and ends.
    let wokeUp = false;
    const holder = createShelfStore({
      dir,
      lockStaleMs: 2000,
      io: {
        async writeFile(path, bytes) {
          if (!wokeUp) {
            await stalled;
            wokeUp = true;
            expect(
              existsSync(join(dir, SHELF_LOCK)),
              "the stalled process removed a lock not its own"
            ).toBe(true);
          }
          await realWrite(path, bytes);
        },
      },
    });
    const mine = await holder.put(input(), { mode: "new" });
    expect(await stalled).toEqual({ ok: false, reason: "lock_lost", written: null });
    ok(mine);
    const listed = await holder.list();
    expect(listed.map((i) => i.status)).toEqual(["ok"]);
    expect(leftovers()).toEqual([]);
  }, 60_000);
});

test("the default Shelf directory is in the global data directory", () => {
  expect(resolveShelfDir()).toBe(join(resolveGlobalDirs().dataDir, "shelf"));
  expect(resolveShelfDir({ config: { global_dir: "/x/g" } as never })).toBe(join("/x/g", "shelf"));
});
