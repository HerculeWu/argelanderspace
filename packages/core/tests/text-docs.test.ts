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
import { afterEach, describe, expect, it } from "vitest";
import { parseTextSource } from "../src/documents/text-codec.js";
import { rebuild } from "../src/library/build.js";
import { emptyWork, type LibraryPaths, LibraryStore } from "../src/library/store.js";
import {
  createTextDoc,
  isTextDoc,
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

function project(): LibraryPaths {
  const root = mkdtempSync(join(tmpdir(), "text-docs-"));
  dirs.push(root);
  const paths = {
    dataDir: root,
    outputDir: join(root, "output"),
    libraryDir: join(root, "library"),
    libraryJson: join(root, "library", "library.json"),
    libraryBib: join(root, "library", "library.bib"),
    cacheDir: join(root, "library", "cache"),
    graphJson: join(root, "library", "graph.json"),
  } as LibraryPaths;
  const w1 = { ...emptyWork("work:1"), title: "Work one", doc_ids: ["latex-main"] };
  new LibraryStore([w1, emptyWork("work:2")]).save(paths);
  return paths;
}

describe("text Doc creation (ticket 25)", () => {
  it("appends a new text-UUID Doc to the existing Work and keeps the main Doc", () => {
    const paths = project();
    const result = createTextDoc(paths, { operationId: "op-aaaaaaaa", workId: "work:1" });
    expect(result.created).toBe(true);
    expect(result.docId).toMatch(/^text-[0-9a-f-]{36}$/);
    expect(LibraryStore.load(paths).get("work:1")?.doc_ids).toEqual(["latex-main", result.docId]);
    expect(LibraryStore.load(paths).get("work:2")?.doc_ids).toEqual([]);
    expect(isTextDoc(paths, result.docId)).toBe(true);
    // the source starts empty and there is no reading IR (a legitimate draft)
    expect(readTextSource(paths, result.docId)).toMatchObject({ rev: 0, markdown: "", assets: [] });
    expect(readPublishedTextIr(paths, result.docId)).toBeNull();
  });

  it("becomes the main Doc of a Work that has none", () => {
    const paths = project();
    const { docId } = createTextDoc(paths, { operationId: "op-bbbbbbbb", workId: "work:2" });
    expect(LibraryStore.load(paths).get("work:2")?.doc_ids).toEqual([docId]);
  });

  it("a retry of the same operation returns the same Doc and never creates a second one", () => {
    const paths = project();
    const first = createTextDoc(paths, { operationId: "op-cccccccc", workId: "work:1" });
    const again = createTextDoc(paths, { operationId: "op-cccccccc", workId: "work:1" });
    expect(again).toMatchObject({ created: false, docId: first.docId });
    expect(readdirSync(paths.outputDir).filter((n) => n.startsWith("text-"))).toEqual([
      first.docId,
    ]);
    expect(LibraryStore.load(paths).get("work:1")?.doc_ids).toEqual(["latex-main", first.docId]);
    expect(() => createTextDoc(paths, { operationId: "op-cccccccc", workId: "work:2" })).toThrow(
      /different request/
    );
  });

  it("an interrupted operation (Doc made, link missing) is completed on retry without a new Doc", () => {
    const paths = project();
    const first = createTextDoc(paths, { operationId: "op-dddddddd", workId: "work:1" });
    // simulate a crash between the rename and the Work link: drop the link, keep the directory
    const store = LibraryStore.load(paths);
    const work = store.get("work:1");
    if (work) work.doc_ids = ["latex-main"];
    store.save(paths);
    const again = createTextDoc(paths, { operationId: "op-dddddddd", workId: "work:1" });
    expect(again).toMatchObject({ created: false, docId: first.docId });
    expect(LibraryStore.load(paths).get("work:1")?.doc_ids).toEqual(["latex-main", first.docId]);
  });

  it("does not recreate a Doc that its operation made and the user deleted", () => {
    const paths = project();
    const { docId } = createTextDoc(paths, { operationId: "op-eeeeeeee", workId: "work:1" });
    rmSync(join(paths.outputDir, docId), { recursive: true });
    expect(() => createTextDoc(paths, { operationId: "op-eeeeeeee", workId: "work:1" })).toThrow(
      TextDocError
    );
    expect(readdirSync(paths.outputDir).filter((n) => n.startsWith("text-"))).toEqual([]);
  });

  it("an unknown Work creates nothing visible", () => {
    const paths = project();
    expect(() => createTextDoc(paths, { operationId: "op-ffffffff", workId: "work:404" })).toThrow(
      /Work not found/
    );
    expect(existsSync(paths.outputDir) ? readdirSync(paths.outputDir) : []).toEqual([]);
  });

  it("a failing Work link rolls back the directory this call made, leaving no half Doc", () => {
    const paths = project();
    const before = readFileSync(paths.libraryJson, "utf8");
    // library.json.tmp as a directory makes the narrow link write fail for real
    mkdirSync(join(paths.libraryDir, "library.json.tmp"));
    expect(() => createTextDoc(paths, { operationId: "op-gggggggg", workId: "work:1" })).toThrow();
    expect(readdirSync(paths.outputDir)).toEqual([]);
    expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
  });

  it("a staging failure (output is a file) leaves library.json untouched", () => {
    const paths = project();
    const before = readFileSync(paths.libraryJson, "utf8");
    writeFileSync(paths.outputDir, "not a directory");
    expect(() => createTextDoc(paths, { operationId: "op-hhhhhhhh", workId: "work:1" })).toThrow();
    expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
  });
});

describe("text source saving (ticket 25)", () => {
  function draft() {
    const paths = project();
    const { docId } = createTextDoc(paths, { operationId: "op-save0001", workId: "work:1" });
    return { paths, docId };
  }

  it("round-trips arbitrary text byte for byte, including unclosed syntax", () => {
    const { paths, docId } = draft();
    const text = "﻿# T\r\n\r\n```\nunclosed $x\ttab é中文 😀 lone\ud800\n";
    const saved = saveTextSource(paths, docId, { expectedRev: 0, markdown: text });
    expect(saved.kind).toBe("saved");
    expect(readTextSource(paths, docId).markdown).toBe(text);
    expect(readTextSource(paths, docId).rev).toBe(1);
  });

  it("rejects a stale expectedRev and writes nothing", () => {
    const { paths, docId } = draft();
    saveTextSource(paths, docId, { expectedRev: 0, markdown: "one" });
    const file = join(paths.outputDir, docId, "text-source.json");
    const before = readFileSync(file);
    const stale = saveTextSource(paths, docId, { expectedRev: 0, markdown: "two" });
    expect(stale.kind).toBe("conflict");
    expect(stale.source.markdown).toBe("one");
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("a failing write keeps the previous bytes (atomic replace)", () => {
    const { paths, docId } = draft();
    saveTextSource(paths, docId, { expectedRev: 0, markdown: "kept" });
    const file = join(paths.outputDir, docId, "text-source.json");
    const before = readFileSync(file);
    mkdirSync(`${file}.tmp`); // a directory where the temp file must go
    expect(() => saveTextSource(paths, docId, { expectedRev: 1, markdown: "lost" })).toThrow();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("a damaged source is reported, never replaced by an empty one", () => {
    const { paths, docId } = draft();
    const file = join(paths.outputDir, docId, "text-source.json");
    writeFileSync(file, "{ not json");
    expect(() => readTextSource(paths, docId)).toThrow(/not valid JSON/);
    expect(() => saveTextSource(paths, docId, { expectedRev: 0, markdown: "x" })).toThrow();
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });
});

describe("publishing and library rebuild (ticket 25)", () => {
  it("publishes the IR atomically and keeps the old IR when the write fails", () => {
    const paths = project();
    const { docId } = createTextDoc(paths, { operationId: "op-pub00001", workId: "work:1" });
    const one = parseTextSource("# One\n\nbody\n", { docId, sourceRev: 1 }).ir;
    const two = parseTextSource("# Two\n\nbody\n", { docId, sourceRev: 2 }).ir;
    if (!one || !two) throw new Error("fixture");
    publishTextIr(paths, docId, one);
    expect(readPublishedTextIr(paths, docId)?.title).toBe("One");
    const file = join(paths.outputDir, docId, `${docId}.json`);
    const before = readFileSync(file);
    mkdirSync(`${file}.tmp`);
    expect(() => publishTextIr(paths, docId, two)).toThrow();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("a corrupt published IR is an error, not 'no IR yet'", () => {
    const paths = project();
    const { docId } = createTextDoc(paths, { operationId: "op-pub00002", workId: "work:1" });
    writeFileSync(join(paths.outputDir, docId, `${docId}.json`), "{broken");
    expect(() => readPublishedTextIr(paths, docId)).toThrow(/not valid JSON/);
    expect(readFileSync(join(paths.outputDir, docId, `${docId}.json`), "utf8")).toBe("{broken");
  });

  it("rebuild keeps a draft and a published text Doc linked and does not reseed a Work from the title", async () => {
    const paths = project();
    const draft = createTextDoc(paths, { operationId: "op-reb00001", workId: "work:1" });
    const published = createTextDoc(paths, { operationId: "op-reb00002", workId: "work:2" });
    const ir = parseTextSource("# Transcribed title\n\nbody\n", {
      docId: published.docId,
      sourceRev: 0,
    }).ir;
    if (!ir) throw new Error("fixture");
    publishTextIr(paths, published.docId, ir);
    const sources = {
      ads: { status: "disabled", resolve: async () => null, exportBibtex: async () => null },
      crossref: { resolve: async () => null },
      oa: { resolve: async () => null },
    } as unknown as Parameters<typeof rebuild>[1]["sources"];
    await rebuild(paths, { sources });
    const store = LibraryStore.load(paths);
    expect(store.works.map((w) => w.id).sort()).toEqual(["work:1", "work:2"]);
    expect(store.get("work:1")?.doc_ids).toEqual([draft.docId]);
    expect(store.get("work:2")?.doc_ids).toEqual([published.docId]);
  });
});
