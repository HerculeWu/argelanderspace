/**
 * The Doc global delete as its own module (ticket 45): `DELETE /api/paper/:doc_id`'s handler and the delete dialog's
 * description, tested without the app. Two real AsyncLocks, a real DocMutationRegistry, a recording `onDeleted`, a
 * fake text service, synthetic data under a temp dir (docs/contracts.md "删除生命周期").
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Annotation } from "@argelanderspace/contracts";
import {
  annotationsArchiveDir,
  annotationsDocDir,
  type LibraryPaths,
  libraryPaths,
  publishPdfDoc,
  readAnnotationRisk,
  saveAnnotationsFile,
} from "@argelanderspace/core";
import { beforeEach, expect, test, vi } from "vitest";
import { createDocDeletion } from "../src/doc-delete.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { AsyncLock } from "../src/lock.js";

const PDF_FIXTURE = new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url);
const DOC = "arxiv-2603.00201";
const OTHER = "arxiv-2603.00202";
const SECOND = "arxiv-2603.00203";
const TEXT = "text-draft-1";
const W_A = "doi:10.1000/a";
const W_B = "doi:10.1000/b";
const W_PDF = "arxiv:2603.00204";
const NOTE: Annotation = {
  id: "a_12345678",
  target: { type: "document" },
  body: "keep me",
  created_at: "2026-09-10T10:00:00.000Z",
  updated_at: "2026-09-10T10:00:00.000Z",
};

/** A lock that says whether a section is running on it. */
class WatchedLock extends AsyncLock {
  held = false;
  override run<T>(fn: () => Promise<T> | T): Promise<T> {
    return super.run(async () => {
      this.held = true;
      try {
        return await fn();
      } finally {
        this.held = false;
      }
    });
  }
}

let paths: LibraryPaths;
let libraryLock: WatchedLock;
let annotationLock: WatchedLock;
let registry: DocMutationRegistry;
let textDocs: Set<string>;
let draft:
  | { generated: true }
  | { generated: false; annotations: { state: "known"; count: number } | { state: "unknown" } };
/** Registry slot releases and notifications, in order, with what held at the time. */
let events: {
  what: "endDelete" | "onDeleted";
  docId?: string;
  libraryHeld: boolean;
  deleting: boolean;
}[];
let deletion: ReturnType<typeof createDocDeletion>;

const work = (id: string, docIds: string[], extra: object = {}) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "arXiv",
  type: "article",
  doi: id.startsWith("doi:") ? id.slice(4) : undefined,
  arxiv_id: id.startsWith("arxiv:") ? id.slice(6) : undefined,
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: docIds,
  ...extra,
});
const seedLibrary = () => ({
  version: 1,
  project: { name: "Synthetic", short: "S", field: "", x_project: "keep" },
  works: [work(W_A, [DOC, OTHER], { x_work: "keep-a" }), work(W_B, [SECOND, DOC]), work(W_PDF, [])],
});
const docIr = (docId: string) => ({
  version: 1,
  docId,
  sections: [
    {
      id: "sec-1",
      level: 1,
      number: "1",
      heading: "Introduction",
      blocks: [{ id: "p-1", type: "paragraph", segments: [{ type: "text", text: "Hello" }] }],
      children: [],
    },
  ],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
  source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex" },
  meta: { title: `Doc ${docId}` },
});
const docDir = (docId: string) => join(paths.outputDir, docId);
function writeDoc(docId: string) {
  mkdirSync(docDir(docId), { recursive: true });
  writeFileSync(join(docDir(docId), `${docId}.json`), JSON.stringify(docIr(docId)));
}
const writeLibrary = (file: unknown = seedLibrary()) =>
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2));
const libraryBytes = () => readFileSync(paths.libraryJson, "utf8");
const docIdsOf = (id: string): string[] =>
  JSON.parse(libraryBytes()).works.find((w: { id: string }) => w.id === id).doc_ids;
/** Every file under a directory with its bytes, to prove a refusal left the disk alone. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    out[full] = readFileSync(full, "base64");
  }
  return out;
}
const everything = () => ({
  library: libraryBytes(),
  output: snapshot(docDir(DOC)),
  annotations: snapshot(annotationsDocDir(paths.dataDir, DOC)),
});

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "doc-deletion-module-"));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  writeLibrary();
  for (const docId of [DOC, OTHER, SECOND]) writeDoc(docId);
  // One current note bound to the Doc's content, and one archived batch: both go with the Doc.
  const risk = readAnnotationRisk(paths.dataDir, DOC);
  if (risk.state !== "known" || risk.fingerprint === null)
    throw new Error("synthetic Doc has no fingerprint");
  saveAnnotationsFile(paths.dataDir, DOC, {
    version: 1,
    rev: 3,
    content_fingerprint: risk.fingerprint,
    annotations: [NOTE],
  });
  mkdirSync(annotationsArchiveDir(paths.dataDir, DOC), { recursive: true });
  writeFileSync(join(annotationsArchiveDir(paths.dataDir, DOC), "old.json"), "{}");

  libraryLock = new WatchedLock();
  annotationLock = new WatchedLock();
  registry = new DocMutationRegistry();
  textDocs = new Set();
  draft = { generated: false, annotations: { state: "known", count: 0 } };
  events = [];
  const endDelete = registry.endDelete.bind(registry);
  vi.spyOn(registry, "endDelete").mockImplementation((docId: string) => {
    events.push({
      what: "endDelete",
      docId,
      libraryHeld: libraryLock.held,
      deleting: registry.isDeleting(docId),
    });
    endDelete(docId);
  });
  deletion = createDocDeletion({
    paths,
    outputDir: paths.outputDir,
    libraryLock,
    annotationLock,
    docMutations: registry,
    text: { has: (docId) => textDocs.has(docId), draftAnnotationImpact: () => draft },
    onDeleted: () =>
      events.push({
        what: "onDeleted",
        libraryHeld: libraryLock.held,
        deleting: registry.isDeleting(DOC),
      }),
  });
});

// ---- delete ------------------------------------------------------------------------------------------------- //

test("success: both directories go (archive included), every Work drops the Doc, the main Doc succeeds", async () => {
  const outcome = await deletion.delete(DOC);
  expect(outcome).toEqual({
    kind: "deleted",
    works: expect.arrayContaining([
      expect.objectContaining({ id: W_A }),
      expect.objectContaining({ id: W_B }),
    ]),
  });
  expect(existsSync(docDir(DOC))).toBe(false);
  expect(existsSync(annotationsDocDir(paths.dataDir, DOC))).toBe(false);
  expect(docIdsOf(W_A)).toEqual([OTHER]);
  expect(docIdsOf(W_B)).toEqual([SECOND]);
  // narrow library step: unknown keys stay
  expect(JSON.parse(libraryBytes()).works[0].x_work).toBe("keep-a");
  expect(existsSync(docDir(OTHER))).toBe(true);
});

test("success: the slot is released first, then onDeleted runs once, outside the library lock", async () => {
  await deletion.delete(DOC);
  expect(events).toEqual([
    { what: "endDelete", docId: DOC, libraryHeld: false, deleting: true },
    { what: "onDeleted", libraryHeld: false, deleting: false },
  ]);
});

test("the physical delete and the library step run inside the library lock, after the slot is claimed", async () => {
  let release!: () => void;
  const blocker = libraryLock.run(() => new Promise<void>((resolve) => (release = resolve)));
  const pending = deletion.delete(DOC);
  // the slot is claimed synchronously, before anything is touched; the delete waits for the lock
  expect(registry.isDeleting(DOC)).toBe(true);
  await Promise.resolve();
  expect(existsSync(docDir(DOC))).toBe(true);
  expect(docIdsOf(W_A)).toEqual([DOC, OTHER]);
  // a description started now sees the delete and says busy (no card worth showing)
  await expect(deletion.describe(DOC)).resolves.toEqual({ kind: "busy" });
  release();
  await blocker;
  expect((await pending).kind).toBe("deleted");
});

test("expect.holders that no longer match: changed, zero writes, slot released, no notification", async () => {
  const shown = await deletion.describe(DOC);
  if (shown.kind !== "ready") throw new Error(`expected ready, got ${shown.kind}`);
  const file = seedLibrary();
  const first = file.works[0];
  if (first) first.doc_ids = [OTHER, DOC];
  writeLibrary(file);
  const before = everything();
  expect(await deletion.delete(DOC, { holders: shown.holders })).toEqual({ kind: "changed" });
  expect(everything()).toEqual(before);
  expect(events).toEqual([{ what: "endDelete", docId: DOC, libraryHeld: false, deleting: true }]);
  expect(registry.isDeleting(DOC)).toBe(false);
});

test("expect.holders that still match: the delete goes ahead", async () => {
  const shown = await deletion.describe(DOC);
  if (shown.kind !== "ready") throw new Error(`expected ready, got ${shown.kind}`);
  expect((await deletion.delete(DOC, { holders: shown.holders })).kind).toBe("deleted");
});

test.each([
  ["a writer pin", (r: DocMutationRegistry) => r.pinWriter(DOC)],
  ["a refresh pin", (r: DocMutationRegistry) => r.pinRefresh()],
  ["a delete already running", (r: DocMutationRegistry) => r.tryBeginDelete(DOC)],
])("busy under %s: nothing touched, another's slot is not released", async (_, claim) => {
  claim(registry);
  const before = everything();
  expect(await deletion.delete(DOC)).toEqual({ kind: "busy" });
  expect(everything()).toEqual(before);
  expect(events).toEqual([]);
  expect(registry.isBusy(DOC) || registry.isDeleting(DOC)).toBe(true);
});

test("a library file that is not an object with works: failed, nothing removed, slot released, no notification", async () => {
  for (const bad of [[], { works: {} }, null]) {
    writeLibrary(bad);
    events = [];
    const before = everything();
    const outcome = await deletion.delete(DOC);
    expect(outcome).toEqual({ kind: "failed", message: "library.json is not a library file" });
    expect(everything()).toEqual(before);
    expect(events).toEqual([{ what: "endDelete", docId: DOC, libraryHeld: false, deleting: true }]);
  }
});

test("an unparsable library file: failed before anything is removed", async () => {
  writeFileSync(paths.libraryJson, "{");
  const outcome = await deletion.delete(DOC);
  expect(outcome.kind).toBe("failed");
  expect(existsSync(docDir(DOC))).toBe(true);
  expect(existsSync(annotationsDocDir(paths.dataDir, DOC))).toBe(true);
  expect(events.map((e) => e.what)).toEqual(["endDelete"]);
});

test("bad ids and missing output directories are refused before the slot is claimed", async () => {
  for (const id of ["", "  ", "../x", "a/b", "a\\b", ".hidden"])
    expect(await deletion.delete(id)).toEqual({ kind: "bad_id" });
  expect(await deletion.delete("arxiv-0000.00000")).toEqual({ kind: "not_found" });
  writeFileSync(join(paths.outputDir, "plain-file"), "x");
  expect(await deletion.delete("plain-file")).toEqual({ kind: "not_found" });
  expect(events).toEqual([]);
});

test("a hollow output directory (no IR) is still deletable; a text Doc's files go with its directory", async () => {
  mkdirSync(join(docDir(TEXT), "assets"), { recursive: true });
  writeFileSync(join(docDir(TEXT), "text-source.json"), "{}");
  writeFileSync(join(docDir(TEXT), "assets", "fig.png"), "png");
  const file = seedLibrary();
  file.works.push(work("doi:10.1000/t", [TEXT]));
  writeLibrary(file);
  expect((await deletion.delete(TEXT)).kind).toBe("deleted");
  expect(existsSync(docDir(TEXT))).toBe(false);
  expect(docIdsOf("doi:10.1000/t")).toEqual([]);
});

// ---- describe ----------------------------------------------------------------------------------------------- //

test("describe a LaTeX Doc: every holder, the current count and revision, and the digest the card binds", async () => {
  const shown = await deletion.describe(DOC);
  const risk = readAnnotationRisk(paths.dataDir, DOC);
  if (risk.state !== "known") throw new Error("expected a known risk");
  const held = [
    { id: W_A, title: `Work ${W_A}`, docIds: [DOC, OTHER] },
    { id: W_B, title: `Work ${W_B}`, docIds: [SECOND, DOC] },
  ];
  const impact = { annotations: "known", count: 1 };
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        docId: DOC,
        format: "latex",
        works: held,
        impact,
        rev: 3,
        stale: false,
        fingerprint: risk.fingerprint,
      })
    )
    .digest("hex");
  expect(shown).toEqual({
    kind: "ready",
    docId: DOC,
    format: "latex",
    works: [
      { id: W_A, title: `Work ${W_A}`, main: true, remaining: 1 },
      { id: W_B, title: `Work ${W_B}`, main: false, remaining: 1 },
    ],
    impact,
    rev: 3,
    digest,
    holders: JSON.stringify(held.map(({ id, docIds }) => ({ id, docIds }))),
  });
  // describe writes nothing
  expect(events).toEqual([]);
});

test("describe runs its reads inside the annotation lock", async () => {
  let release!: () => void;
  const blocker = annotationLock.run(() => new Promise<void>((resolve) => (release = resolve)));
  let settled = false;
  const pending = deletion.describe(DOC).then((d) => {
    settled = true;
    return d;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false);
  release();
  await blocker;
  expect((await pending).kind).toBe("ready");
});

test("describe a never-generated text Doc: format text, the draft impact the text service reports", async () => {
  mkdirSync(docDir(TEXT), { recursive: true });
  writeFileSync(join(docDir(TEXT), "text-source.json"), "{}");
  const file = seedLibrary();
  file.works.push(work("doi:10.1000/t", [TEXT]));
  writeLibrary(file);
  textDocs.add(TEXT);
  const known = await deletion.describe(TEXT);
  expect(known).toMatchObject({
    kind: "ready",
    format: "text",
    impact: { annotations: "known", count: 0 },
    rev: 0,
  });
  draft = { generated: false, annotations: { state: "unknown" } };
  const unknown = await deletion.describe(TEXT);
  expect(unknown).toMatchObject({
    kind: "ready",
    format: "text",
    impact: { annotations: "unknown" },
    rev: 0,
  });
  if (known.kind !== "ready" || unknown.kind !== "ready") throw new Error("expected ready");
  expect(known.digest).not.toBe(unknown.digest);
});

test("describe a generated text Doc: format text, counted the LaTeX way", async () => {
  textDocs.add(DOC);
  expect(await deletion.describe(DOC)).toMatchObject({
    kind: "ready",
    format: "text",
    impact: { annotations: "known", count: 1 },
    rev: 3,
  });
});

test("describe a PDF Doc: format pdf with the verified sidecar count; two owners make the count unknown", async () => {
  const published = publishPdfDoc(paths, {
    workId: W_PDF,
    filename: "mine.pdf",
    bytes: readFileSync(PDF_FIXTURE),
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });
  const pdfDoc = published.doc_id;
  expect(await deletion.describe(pdfDoc)).toMatchObject({
    kind: "ready",
    format: "pdf",
    impact: { annotations: "known", count: 0 },
    rev: 0,
    works: [{ id: W_PDF, main: true, remaining: 0 }],
  });
  const file = JSON.parse(libraryBytes());
  file.works.find((w: { id: string }) => w.id === W_B).doc_ids.push(pdfDoc);
  writeLibrary(file);
  expect(await deletion.describe(pdfDoc)).toMatchObject({
    kind: "ready",
    format: "pdf",
    impact: { annotations: "unknown" },
    rev: 0,
  });
  // and the delete takes the original, metadata and sidecars with the directory
  expect((await deletion.delete(pdfDoc)).kind).toBe("deleted");
  expect(existsSync(docDir(pdfDoc))).toBe(false);
});

test("describe refusals: bad id, not found, busy, orphan, unreadable library", async () => {
  expect(await deletion.describe("")).toEqual({ kind: "bad_id" });
  expect(await deletion.describe("../x")).toEqual({ kind: "bad_id" });
  expect(await deletion.describe("arxiv-0000.00000")).toEqual({ kind: "not_found" });
  registry.pinWriter(DOC);
  expect(await deletion.describe(DOC)).toEqual({ kind: "busy" });
  registry.unpinWriter(DOC);
  registry.pinRefresh();
  expect(await deletion.describe(DOC)).toEqual({ kind: "busy" });
  registry.unpinRefresh();
  writeDoc("arxiv-2603.00299");
  expect(await deletion.describe("arxiv-2603.00299")).toEqual({ kind: "orphan" });
  writeFileSync(paths.libraryJson, "{");
  expect(await deletion.describe(DOC)).toEqual({
    kind: "error",
    detail: "the library could not be read",
  });
});
