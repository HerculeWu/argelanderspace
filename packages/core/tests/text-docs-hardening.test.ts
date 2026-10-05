import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseTextSource } from "../src/documents/text-codec.js";
import { rebuild } from "../src/library/build.js";
import { findDamagedTextDocs, seedFromOutput } from "../src/library/seed.js";
import { emptyWork, type LibraryPaths, LibraryStore, libraryPaths } from "../src/library/store.js";
import {
  createTextDoc,
  publishTextIr,
  readPublishedTextIr,
  readTextSource,
  saveTextSource,
  TextDocError,
} from "../src/text-docs.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function project(options: { symlinked?: boolean } = {}): LibraryPaths {
  const base = mkdtempSync(join(tmpdir(), "text-hard-"));
  dirs.push(base);
  const root = join(base, "data");
  if (options.symlinked) {
    // the user's dataDir is a symlink to the real directory
    const real = join(base, "real-data");
    mkdirSync(real);
    symlinkSync(real, root);
  } else mkdirSync(root);
  const paths = libraryPaths(root);
  mkdirSync(paths.libraryDir, { recursive: true });
  new LibraryStore([
    { ...emptyWork("work:1"), title: "Work one", doc_ids: ["latex-main"] },
    emptyWork("work:2"),
  ]).save(paths);
  return paths;
}
const stubSources = {
  ads: { status: "disabled", resolve: async () => null, exportBibtex: async () => null },
  crossref: { resolve: async () => null },
  oa: { resolve: async () => null },
} as unknown as Parameters<typeof rebuild>[1]["sources"];

describe("a symlinked dataDir is a legitimate layout", () => {
  it("creates, reads, saves and publishes a text Doc through the symlink", () => {
    const paths = project({ symlinked: true });
    const made = createTextDoc(paths, { operationId: "op-link-0001", workId: "work:1" });
    expect(made.created).toBe(true);
    // the Doc that was committed is readable: create never links a Doc it cannot describe
    expect(readTextSource(paths, made.docId).rev).toBe(0);
    expect(saveTextSource(paths, made.docId, { expectedRev: 0, markdown: "# T\n\nx" }).kind).toBe(
      "saved"
    );
    const ir = parseTextSource("# T\n\nx", { docId: made.docId, sourceRev: 1 }).ir;
    if (!ir) throw new Error("fixture");
    publishTextIr(paths, made.docId, ir);
    expect(readPublishedTextIr(paths, made.docId)?.title).toBe("T");
    // a retry finds the same Doc
    expect(createTextDoc(paths, { operationId: "op-link-0001", workId: "work:1" })).toMatchObject({
      created: false,
      docId: made.docId,
    });
  });

  it("a symlinked Doc directory or source file inside output/ is still refused", () => {
    const paths = project();
    const made = createTextDoc(paths, { operationId: "op-link-0002", workId: "work:1" });
    const dir = join(paths.outputDir, made.docId);
    const elsewhere = join(paths.dataDir, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "text-source.json"), readFileSync(join(dir, "text-source.json")));
    rmSync(dir, { recursive: true });
    symlinkSync(elsewhere, dir);
    expect(() => readTextSource(paths, made.docId)).toThrow(TextDocError);
  });
});

describe("operation record", () => {
  it("a retry after a deleted Doc never recreates it, even when the done mark cannot be trusted", () => {
    const paths = project();
    const made = createTextDoc(paths, { operationId: "op-gone-0001", workId: "work:1" });
    rmSync(join(paths.outputDir, made.docId), { recursive: true });
    const store = LibraryStore.load(paths);
    const work = store.get("work:1");
    if (work) work.doc_ids = work.doc_ids.filter((d) => d !== made.docId);
    store.save(paths);
    expect(() => createTextDoc(paths, { operationId: "op-gone-0001", workId: "work:1" })).toThrow(
      /no longer exists/
    );
    expect(readdirSync(paths.outputDir).filter((n) => n.startsWith("text-"))).toEqual([]);
  });

  it("a failed commit before the link rolls back and the SAME operation can then complete", () => {
    const paths = project();
    mkdirSync(join(paths.libraryDir, "library.json.tmp")); // the link write fails
    expect(() =>
      createTextDoc(paths, { operationId: "op-retry-0001", workId: "work:1" })
    ).toThrow();
    expect(readdirSync(paths.outputDir)).toEqual([]);
    rmSync(join(paths.libraryDir, "library.json.tmp"), { recursive: true });
    const done = createTextDoc(paths, { operationId: "op-retry-0001", workId: "work:1" });
    expect(done.created).toBe(true);
    expect(LibraryStore.load(paths).get("work:1")?.doc_ids).toContain(done.docId);
  });

  it("completing a lost link reports that library.json changed", () => {
    const paths = project();
    const made = createTextDoc(paths, { operationId: "op-relink-001", workId: "work:1" });
    expect(made.libraryChanged).toBe(true);
    const store = LibraryStore.load(paths);
    const work = store.get("work:1");
    if (work) work.doc_ids = ["latex-main"];
    store.save(paths);
    const again = createTextDoc(paths, { operationId: "op-relink-001", workId: "work:1" });
    expect(again).toMatchObject({ created: false, libraryChanged: true });
    expect(
      createTextDoc(paths, { operationId: "op-relink-001", workId: "work:1" }).libraryChanged
    ).toBe(false);
  });

  it("a damaged record file is a clear error and is never overwritten (no record is lost)", () => {
    const paths = project();
    createTextDoc(paths, { operationId: "op-keep-00001", workId: "work:1" });
    const file = join(paths.libraryDir, "text-doc-operations.json");
    for (const bad of [
      "{ not json",
      JSON.stringify({ version: 2, operations: {} }),
      JSON.stringify({ version: 1, operations: { x: { docId: 5 } } }),
    ]) {
      writeFileSync(file, bad);
      expect(() =>
        createTextDoc(paths, { operationId: "op-new-000001", workId: "work:2" })
      ).toThrow(/operation record .* unreadable/);
      expect(readFileSync(file, "utf8")).toBe(bad);
    }
    try {
      createTextDoc(paths, { operationId: "op-new-000002", workId: "work:2" });
    } catch (error) {
      expect((error as TextDocError).code).toBe("corrupt_operations");
    }
  });
});

describe("a text Doc is never seeded by title (seed and rebuild)", () => {
  it("skips a text IR even when its source file is gone, and a text- id without any file", async () => {
    const paths = project();
    const made = createTextDoc(paths, { operationId: "op-seed-00001", workId: "work:1" });
    const ir = parseTextSource("# Transcribed title\n\nbody", {
      docId: made.docId,
      sourceRev: 0,
    }).ir;
    if (!ir) throw new Error("fixture");
    publishTextIr(paths, made.docId, ir);
    rmSync(join(paths.outputDir, made.docId, "text-source.json")); // damaged: IR without its source
    const orphan = "text-33333333-3333-4333-8333-333333333333";
    mkdirSync(join(paths.outputDir, orphan));
    writeFileSync(
      join(paths.outputDir, orphan, `${orphan}.json`),
      JSON.stringify({
        ...ir,
        docId: orphan,
        source: { ...ir.source, type: "latex" },
        meta: { title: "Another title" },
      })
    );
    const store = LibraryStore.load(paths);
    const before = store.works.map((w) => w.id).sort();
    seedFromOutput(store, paths.outputDir);
    expect(store.works.map((w) => w.id).sort()).toEqual(before);
    expect(findDamagedTextDocs(paths.outputDir)).toEqual([made.docId, orphan].sort());
    const summary = await rebuild(paths, { sources: stubSources });
    expect(summary.damaged_text_docs).toEqual([made.docId, orphan].sort());
    expect(LibraryStore.load(paths).get("work:1")?.doc_ids).toContain(made.docId);
  });

  it("a text IR under any directory name is not seeded by its title either", () => {
    const paths = project();
    const ir = parseTextSource("# Odd place\n\nbody", { docId: "odd-name", sourceRev: 0 }).ir;
    if (!ir) throw new Error("fixture");
    mkdirSync(join(paths.outputDir, "odd-name"), { recursive: true });
    writeFileSync(join(paths.outputDir, "odd-name", "odd-name.json"), JSON.stringify(ir));
    const store = LibraryStore.load(paths);
    const before = store.works.length;
    seedFromOutput(store, paths.outputDir);
    expect(store.works).toHaveLength(before);
  });

  it("a draft that lost its source (no IR, no source file) keeps its Work link and is reported, not pruned", async () => {
    const paths = project();
    const made = createTextDoc(paths, { operationId: "op-draft-lost-1", workId: "work:1" });
    rmSync(join(paths.outputDir, made.docId, "text-source.json"));
    expect(existsSync(join(paths.outputDir, made.docId, `${made.docId}.json`))).toBe(false);
    const summary = await rebuild(paths, { sources: stubSources });
    expect(LibraryStore.load(paths).get("work:1")?.doc_ids).toContain(made.docId);
    expect(summary.damaged_text_docs).toEqual([made.docId]);
  });

  it("a symlinked text-source.json inside a real Doc directory is refused", () => {
    const paths = project();
    const made = createTextDoc(paths, { operationId: "op-file-link-1", workId: "work:1" });
    const file = join(paths.outputDir, made.docId, "text-source.json");
    const elsewhere = join(paths.dataDir, "elsewhere.json");
    writeFileSync(elsewhere, readFileSync(file));
    rmSync(file);
    symlinkSync(elsewhere, file);
    expect(() => readTextSource(paths, made.docId)).toThrow(TextDocError);
    expect(() => saveTextSource(paths, made.docId, { expectedRev: 0, markdown: "x" })).toThrow(
      TextDocError
    );
  });

  it("a healthy library reports no damaged text Docs", async () => {
    const paths = project();
    createTextDoc(paths, { operationId: "op-seed-00002", workId: "work:1" });
    const summary = await rebuild(paths, { sources: stubSources });
    expect(summary.damaged_text_docs).toBeUndefined();
    expect(existsSync(join(paths.outputDir))).toBe(true);
  });
});
