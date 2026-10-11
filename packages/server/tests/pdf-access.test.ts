/**
 * The PDF access path as its own module (ticket 39): owners, the verified source, the Copilot's workbench annotation
 * writes and the two failure maps, tested without the app (docs/contracts.md "本地 PDF Doc"). A real AsyncLock, a
 * real DocMutationRegistry, a recording `onChanged`, synthetic data under a temp dir.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PdfAnnotationOperation } from "@argelanderspace/contracts";
import { type LibraryPaths, libraryPaths, publishPdfDoc } from "@argelanderspace/core";
import { beforeEach, expect, test } from "vitest";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { AsyncLock } from "../src/lock.js";
import { createPdfAccess } from "../src/pdf-access.js";
import {
  PdfMaterialContentError,
  PdfMaterialInputError,
  PdfMaterialResourceError,
  PdfQueueFullError,
} from "../src/pdf-material.js";
import { syntheticPdf } from "./pdf-fixture.js";

const W1 = "doi:10.1000/w1";
const W2 = "doi:10.1000/w2";
const PAGES = [
  { width: 360, height: 480, rotation: 0 },
  { width: 400, height: 240, rotation: 90 },
  { width: 280, height: 280, rotation: 0 },
];
const SCOPE = { conversationId: "conv-1" };
const OTHER_SHA = "0".repeat(64);

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
let lock: WatchedLock;
let registry: DocMutationRegistry;
let changes: { docId: string; kind: "put" | "invalidate"; inLock: boolean; rev: number }[];
let access: ReturnType<typeof createPdfAccess>;
let doc: string;
let sha: string;
let bytes: Buffer;

const work = (id: string, docIds: string[]) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "MNRAS",
  type: "article",
  doi: id.slice(4),
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: docIds,
});
const library = () => JSON.parse(readFileSync(paths.libraryJson, "utf8"));
const writeLibrary = (file: unknown) =>
  writeFileSync(paths.libraryJson, JSON.stringify(file, null, 2));
/** Add a Doc id to a Work's `doc_ids` (a second owner, or an owned id with no files). */
function own(workId: string, docId: string) {
  const file = library();
  file.works.find((w: { id: string }) => w.id === workId).doc_ids.push(docId);
  writeLibrary(file);
}
const docPath = (docId: string, name: string) => join(paths.outputDir, docId, name);
const sidecar = () => JSON.parse(readFileSync(docPath(doc, "annotations.json"), "utf8"));
const createOp = (over: Partial<PdfAnnotationOperation> = {}): PdfAnnotationOperation =>
  ({
    action: "create_pdf_annotation",
    docId: doc,
    sha256: sha,
    rev: 0,
    kind: "document_comment",
    body: "a note",
    ...over,
  }) as PdfAnnotationOperation;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "pdf-access-"));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  mkdirSync(paths.outputDir, { recursive: true });
  writeLibrary({
    version: 1,
    project: { name: "Synthetic", short: "S", field: "" },
    works: [work(W1, []), work(W2, [])],
  });
  bytes = syntheticPdf();
  const metadata = publishPdfDoc(paths, {
    workId: W1,
    filename: "synthetic.pdf",
    bytes,
    pages: PAGES,
  });
  doc = metadata.doc_id;
  sha = metadata.sha256;
  lock = new WatchedLock();
  registry = new DocMutationRegistry();
  changes = [];
  access = createPdfAccess({
    paths,
    docMutations: registry,
    lock,
    onChanged: (docId, kind) =>
      changes.push({ docId, kind, inLock: lock.held, rev: sidecar().rev as number }),
  });
});

// ---- owners --------------------------------------------------------------------------------------------------- //

test("owners: none, one and several Works that list the Doc, read fresh each call", () => {
  expect(access.owners("pdf-unknown")).toEqual([]);
  expect(access.owners(doc).map((w) => w.id)).toEqual([W1]);
  own(W2, doc);
  expect(access.owners(doc).map((w) => w.id)).toEqual([W1, W2]);
});

// ---- source --------------------------------------------------------------------------------------------------- //

test("source: a bad id is bad_id before anything else, even while busy", () => {
  for (const id of ["", "  ", "../x", "a/b", "a\\b", ".hidden"]) {
    registry.pinWriter(id);
    expect(access.source(id).kind).toBe("bad_id");
  }
});

test("source: busy comes before ownership (an unowned busy id is busy, not not_found)", () => {
  registry.pinWriter("pdf-unknown");
  expect(access.source("pdf-unknown").kind).toBe("busy");
  registry.pinWriter(doc);
  expect(access.source(doc).kind).toBe("busy");
  registry.unpinWriter(doc);
  expect(registry.tryBeginDelete(doc)).toBe(true);
  expect(access.source(doc).kind).toBe("busy");
});

test("source: unowned is not_found, more than one owner is inconsistent before the Doc's own data is read", () => {
  expect(access.source("pdf-unknown").kind).toBe("not_found");
  own(W2, doc);
  expect(access.source(doc).kind).toBe("inconsistent");
  rmSync(docPath(doc, `${doc}.json`));
  expect(access.source(doc).kind).toBe("inconsistent");
});

test("source: an owned Doc without metadata, unreadable metadata or a damaged sidecar is error; nothing is rewritten", () => {
  own(W2, "pdf-ghost");
  expect(access.source("pdf-ghost").kind).toBe("error");
  const sidecarBefore = readFileSync(docPath(doc, "annotations.json"));
  writeFileSync(docPath(doc, "annotations.json"), "{broken");
  expect(access.source(doc).kind).toBe("ok");
  expect(access.source(doc, { annotations: true }).kind).toBe("error");
  expect(readFileSync(docPath(doc, "annotations.json"), "utf8")).toBe("{broken");
  writeFileSync(docPath(doc, "annotations.json"), sidecarBefore);
  writeFileSync(docPath(doc, `${doc}.json`), "{not json");
  expect(access.source(doc).kind).toBe("error");
  rmSync(docPath(doc, `${doc}.json`));
  expect(access.source(doc).kind).toBe("error");
});

test("source: a hash that is not the Doc's, or bytes that no longer match it, is changed; the bytes stay", () => {
  expect(access.source(doc, { expectedHash: OTHER_SHA }).kind).toBe("changed");
  const tampered = Buffer.from(bytes);
  tampered.writeUInt8(tampered.readUInt8(tampered.length - 2) ^ 1, tampered.length - 2);
  writeFileSync(docPath(doc, "original.pdf"), tampered);
  expect(access.source(doc).kind).toBe("changed");
  expect(access.source(doc, { expectedHash: sha }).kind).toBe("changed");
  expect(readFileSync(docPath(doc, "original.pdf")).equals(tampered)).toBe(true);
});

test("source: ok carries the metadata, the verified bytes, the owner's title, and the annotations only on request", () => {
  const plain = access.source(doc, { expectedHash: sha });
  if (plain.kind !== "ok") throw new Error(plain.kind);
  expect(plain.metadata.sha256).toBe(sha);
  expect(plain.bytes.equals(bytes)).toBe(true);
  expect(plain.title).toBe(`Work ${W1}`);
  expect("annotations" in plain).toBe(false);
  const withAnnotations = access.source(doc, { annotations: true });
  if (withAnnotations.kind !== "ok") throw new Error(withAnnotations.kind);
  expect(withAnnotations.annotations?.rev).toBe(0);
  expect(withAnnotations.annotations?.annotations).toEqual([]);
});

// ---- writeAnnotation ------------------------------------------------------------------------------------------ //

test("writeAnnotation: an owned Doc that is not a PDF is unsupported", async () => {
  own(W2, "latex-doc");
  mkdirSync(join(paths.outputDir, "latex-doc"));
  writeFileSync(docPath("latex-doc", "latex-doc.json"), JSON.stringify({ version: 1 }));
  expect(await access.writeAnnotation(createOp({ docId: "latex-doc" }), SCOPE)).toEqual({
    kind: "unsupported",
  });
  own(W2, "pdf-ghost");
  expect(await access.writeAnnotation(createOp({ docId: "pdf-ghost" }), SCOPE)).toEqual({
    kind: "unsupported",
  });
  expect(changes).toEqual([]);
});

test("writeAnnotation: a source failure writes nothing and answers in the tool's terms", async () => {
  const before = readFileSync(docPath(doc, "annotations.json"), "utf8");
  expect(await access.writeAnnotation(createOp({ docId: "pdf-unknown" }), SCOPE)).toEqual({
    kind: "not_found",
  });
  expect(await access.writeAnnotation(createOp({ docId: "../x" }), SCOPE)).toEqual({
    kind: "not_found",
  });
  registry.pinWriter(doc);
  expect(await access.writeAnnotation(createOp(), SCOPE)).toEqual({ kind: "busy" });
  registry.unpinWriter(doc);
  own(W2, doc);
  expect(await access.writeAnnotation(createOp(), SCOPE)).toEqual({
    kind: "error",
    detail: "the PDF or its user data could not be verified; nothing was changed",
  });
  expect(readFileSync(docPath(doc, "annotations.json"), "utf8")).toBe(before);
  expect(changes).toEqual([]);
});

test("writeAnnotation: a hash that is not the Doc's is a document_changed conflict and nothing is written", async () => {
  const before = readFileSync(docPath(doc, "annotations.json"), "utf8");
  expect(await access.writeAnnotation(createOp({ sha256: OTHER_SHA }), SCOPE)).toEqual({
    kind: "conflict",
    reason: "document_changed",
    epoch: { sha256: null, annotationsRev: null },
  });
  expect(readFileSync(docPath(doc, "annotations.json"), "utf8")).toBe(before);
  expect(changes).toEqual([]);
});

test("writeAnnotation: a save bumps the sidecar rev, records history and notifies once after the lock", async () => {
  const saved = await access.writeAnnotation(createOp(), SCOPE);
  if (saved.kind !== "saved") throw new Error(saved.kind);
  expect(saved.epoch).toEqual({ sha256: sha, annotationsRev: 1 });
  expect(saved.history).toEqual({ canUndo: true, canRedo: false });
  expect(saved.annotation?.body).toBe("a note");
  expect(sidecar().rev).toBe(1);
  expect(sidecar().annotations).toHaveLength(1);
  expect(changes).toEqual([{ docId: doc, kind: "put", inLock: false, rev: 1 }]);
  // The history lives in the instance: the same conversation can undo what it did.
  const undone = await access.writeAnnotation(
    { action: "undo_pdf_annotation", docId: doc, sha256: sha, rev: 1 },
    SCOPE
  );
  if (undone.kind !== "saved") throw new Error(undone.kind);
  expect(undone.moved).toBe("undo");
  expect(undone.history).toEqual({ canUndo: false, canRedo: true });
  expect(sidecar().rev).toBe(2);
  expect(sidecar().annotations).toEqual([]);
  expect(changes).toHaveLength(2);
  // Another conversation has nothing to undo.
  expect(
    await access.writeAnnotation(
      { action: "undo_pdf_annotation", docId: doc, sha256: sha, rev: 2 },
      { conversationId: "conv-2" }
    )
  ).toEqual({ kind: "nothing", reason: "nothing", epoch: { sha256: sha, annotationsRev: 2 } });
  expect(changes).toHaveLength(2);
});

test("writeAnnotation: a stale rev is a rev_mismatch conflict carrying the stored rev; nothing is written", async () => {
  await access.writeAnnotation(createOp(), SCOPE);
  const before = readFileSync(docPath(doc, "annotations.json"), "utf8");
  expect(await access.writeAnnotation(createOp({ rev: 0 }), SCOPE)).toEqual({
    kind: "conflict",
    reason: "rev_mismatch",
    epoch: { sha256: sha, annotationsRev: 1 },
  });
  expect(readFileSync(docPath(doc, "annotations.json"), "utf8")).toBe(before);
  expect(changes).toHaveLength(1);
});

test("writeAnnotation: the commit runs on the injected lock (a held section holds the write back)", async () => {
  let release!: () => void;
  const holding = lock.run(() => new Promise<void>((resolve) => (release = resolve)));
  let settled = false;
  const pending = access.writeAnnotation(createOp(), SCOPE).then((outcome) => {
    settled = true;
    return outcome;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(settled).toBe(false);
  expect(sidecar().rev).toBe(0);
  release();
  await holding;
  expect((await pending).kind).toBe("saved");
});

test("writeAnnotation: the two catch texts — a change that breaks the contract vs a damaged sidecar", async () => {
  // A body the stored file's schema refuses: the application's own change, not a damaged file.
  const bad = await access.writeAnnotation(createOp({ body: 12345 as unknown as string }), SCOPE);
  expect(bad).toEqual({
    kind: "error",
    detail:
      "the application could not apply this change (the changed annotations do not satisfy the contract); nothing was written and the stored file was not touched. This is not a damaged file; tell the user",
  });
  writeFileSync(docPath(doc, "annotations.json"), "{broken");
  expect(await access.writeAnnotation(createOp(), SCOPE)).toEqual({
    kind: "error",
    detail:
      "the PDF annotations could not be read or written (the stored file, if damaged, was left as it is); read the Doc again to see what is stored now",
  });
  expect(readFileSync(docPath(doc, "annotations.json"), "utf8")).toBe("{broken");
  expect(changes).toEqual([]);
});

// ---- failure maps --------------------------------------------------------------------------------------------- //

test("materialFailure: every row", () => {
  expect(access.materialFailure(new PdfMaterialInputError("page 9 is outside 0..2"))).toEqual({
    status: 400,
    detail: "page 9 is outside 0..2",
  });
  expect(access.materialFailure(new PdfMaterialContentError())).toEqual({
    status: 409,
    detail: "document changed",
  });
  const resource = new PdfMaterialResourceError();
  expect(access.materialFailure(resource)).toEqual({ status: 503, detail: resource.message });
  const queue = new PdfQueueFullError();
  expect(access.materialFailure(queue)).toEqual({ status: 503, detail: queue.message });
  for (const other of [new Error("boom"), "boom", undefined])
    expect(access.materialFailure(other)).toEqual({
      status: 500,
      detail: "PDF page material could not be produced",
    });
});

test("sourceFailure: every row", () => {
  const id = "pdf-x";
  expect(access.sourceFailure(id, "bad_id")).toEqual({
    body: { detail: "bad doc id" },
    status: 400,
  });
  expect(access.sourceFailure(id, "busy")).toEqual({
    body: { detail: "document busy" },
    status: 409,
  });
  expect(access.sourceFailure(id, "not_found")).toEqual({
    body: { detail: "paper 'pdf-x' not found" },
    status: 404,
  });
  expect(access.sourceFailure(id, "changed")).toEqual({
    body: { detail: "document changed" },
    status: 409,
  });
  expect(access.sourceFailure(id, "inconsistent")).toEqual({
    body: { detail: "PDF document 'pdf-x' has inconsistent Work ownership" },
    status: 500,
  });
  expect(access.sourceFailure(id, "error")).toEqual({
    body: { detail: "PDF document 'pdf-x' cannot be verified" },
    status: 500,
  });
});
