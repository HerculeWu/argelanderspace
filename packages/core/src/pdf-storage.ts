import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  PDF_MAX_BYTES,
  PDF_MAX_PAGES,
  type PdfAnnotationsFile,
  PdfAnnotationsFileSchema,
  type PdfDocMetadata,
  PdfDocMetadataSchema,
  PdfReadingPositionSchema,
} from "@argelanderspace/contracts";
import type { LibraryPaths } from "./library/store.js";
import { LibraryStore } from "./library/store.js";

export class PdfContentChangedError extends Error {
  constructor() {
    super("PDF content changed");
    this.name = "PdfContentChangedError";
  }
}

export class PdfAnnotationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfAnnotationValidationError";
  }
}

export class PdfAnnotationConflictError extends Error {
  constructor(readonly conflict: "rev" | "content" | "busy") {
    super(
      conflict === "rev"
        ? "rev mismatch"
        : conflict === "content"
          ? "document changed"
          : "document busy"
    );
    this.name = "PdfAnnotationConflictError";
  }
}

export interface PublishPdfDocInput {
  docId?: string;
  workId: string;
  filename: string;
  bytes: Buffer;
  pages: Array<{ width: number; height: number; rotation: number }>;
  acquiredVia?: "user_pdf_upload" | "arxiv_pdf";
  arxivId?: string;
  deduplicate?: boolean;
}

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeDocDir(paths: LibraryPaths, docId: string): string {
  if (!idPattern.test(docId)) throw new Error("invalid PDF Doc id");
  const outputDir = realpathSync(paths.outputDir);
  if (!lstatSync(paths.outputDir).isDirectory()) throw new Error("invalid output directory");
  const dir = join(outputDir, docId);
  if (existsSync(dir)) {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(dir) !== dir)
      throw new Error("unsafe PDF Doc directory");
  }
  return dir;
}

function readRegularFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new Error("unsafe PDF Doc file");
  return readFileSync(path);
}

export function readPdfMetadataIfPresent(
  paths: LibraryPaths,
  docId: string
): PdfDocMetadata | null {
  if (!docId || docId.includes("/") || docId.includes("\\") || docId.startsWith(".")) return null;
  const outputDir = realpathSync(paths.outputDir);
  if (!lstatSync(paths.outputDir).isDirectory()) throw new Error("invalid output directory");
  const dir = join(outputDir, docId);
  if (!existsSync(dir)) return null;
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || realpathSync(dir) !== dir)
    throw new Error("unsafe PDF Doc directory");
  const path = join(dir, `${docId}.json`);
  const pdfMarkers = [
    path,
    join(dir, "original.pdf"),
    join(dir, "annotations.json"),
    join(dir, "reading-position.json"),
  ];
  const markerExists = pdfMarkers.some(existsSync);
  if (!existsSync(path)) {
    if (markerExists) throw new Error("PDF metadata missing");
    return null;
  }
  const raw = JSON.parse(readRegularFile(path).toString("utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("invalid Doc metadata");
  if ((raw as Record<string, unknown>).format !== "pdf") {
    if (pdfMarkers.slice(1).some(existsSync)) throw new Error("PDF metadata format is invalid");
    return null;
  }
  const metadata = PdfDocMetadataSchema.parse(raw);
  if (metadata.doc_id !== docId) throw new Error("PDF metadata identity mismatch");
  return metadata;
}

function atomicWrite(path: string, content: string | Buffer): void {
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    writeFileSync(temp, content, { flag: "wx" });
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Publish a complete immutable PDF bundle, then attach its unique Doc to Work. */
export function findMatchingPdfDoc(
  paths: LibraryPaths,
  workId: string,
  bytes: Buffer,
  isBusy: (docId: string) => boolean = () => false
): PdfDocMetadata | null {
  const store = LibraryStore.load(paths);
  const work = store.get(workId);
  if (!work) throw new Error("Work not found");
  const sha256 = digest(bytes);
  for (const docId of work.doc_ids) {
    const metadata = readPdfMetadataIfPresent(paths, docId);
    if (!metadata || metadata.sha256 !== sha256) continue;
    if (isBusy(docId)) throw new Error("document busy");
    const owners = store.works.filter((candidate) => candidate.doc_ids.includes(docId));
    if (owners.length !== 1) throw new Error("PDF Doc has inconsistent Work ownership");
    const existingBytes = readVerifiedPdf(paths, docId);
    if (existingBytes.equals(bytes)) return metadata;
  }
  return null;
}

export function publishPdfDoc(paths: LibraryPaths, input: PublishPdfDocInput): PdfDocMetadata {
  const docId = input.docId ?? `pdf-${randomUUID()}`;
  if (input.bytes.length === 0 || input.bytes.length > PDF_MAX_BYTES)
    throw new Error("PDF size is outside the supported limit");
  if (input.pages.length < 1 || input.pages.length > PDF_MAX_PAGES)
    throw new Error("PDF page count is outside the supported limit");
  if (!existsSync(paths.outputDir)) mkdirSync(paths.outputDir, { recursive: true });
  const docDir = safeDocDir(paths, docId);
  if (existsSync(docDir)) throw new Error("PDF Doc already exists");

  const store = LibraryStore.load(paths);
  const work = store.get(input.workId);
  if (!work) throw new Error("Work not found");

  if (input.deduplicate !== false) {
    const duplicate = findMatchingPdfDoc(paths, input.workId, input.bytes);
    if (duplicate) return duplicate;
  }
  const sha256 = digest(input.bytes);
  const metadata = PdfDocMetadataSchema.parse({
    version: 1,
    doc_id: docId,
    format: "pdf",
    display_name: input.filename,
    original_filename: input.filename,
    acquired_via: input.acquiredVia ?? "user_pdf_upload",
    ...(input.acquiredVia === "arxiv_pdf" && input.arxivId ? { arxiv_id: input.arxivId } : {}),
    acquired_at: new Date().toISOString(),
    byte_length: input.bytes.length,
    sha256,
    page_count: input.pages.length,
    pages: input.pages,
  });

  const stage = join(paths.outputDir, `.pdf-stage-${randomUUID()}`);
  mkdirSync(stage, { recursive: false });
  try {
    atomicWrite(join(stage, "original.pdf"), input.bytes);
    atomicWrite(join(stage, `${docId}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
    atomicWrite(
      join(stage, "annotations.json"),
      `${JSON.stringify(PdfAnnotationsFileSchema.parse({ version: 1, doc_id: docId, content_sha256: sha256, rev: 0, annotations: [] }), null, 2)}\n`
    );
    atomicWrite(
      join(stage, "reading-position.json"),
      `${JSON.stringify(PdfReadingPositionSchema.parse({ version: 1, doc_id: docId, content_sha256: sha256, rev: 0, position: null }), null, 2)}\n`
    );
    renameSync(stage, docDir);
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  // The metadata and all required sidecars are complete before Library makes the Doc visible.
  const latestStore = LibraryStore.load(paths);
  const latestWork = latestStore.get(input.workId);
  if (!latestWork) throw new Error("Work not found");
  latestWork.doc_ids = [...latestWork.doc_ids, docId];
  // A Doc association is deliberately absent from the BibTeX projection, so
  // publishing a PDF must not rewrite this derived sidecar or fail after the
  // source-of-truth association has already committed.
  latestStore.saveJson(paths);
  return metadata;
}

/** Read exactly one byte buffer and validate it against the immutable binding. */
export function readVerifiedPdf(paths: LibraryPaths, docId: string): Buffer {
  const docDir = safeDocDir(paths, docId);
  const metadata = readPdfMetadataIfPresent(paths, docId);
  if (!metadata) throw new Error("PDF metadata missing");
  const bytes = readRegularFile(join(docDir, "original.pdf"));
  if (bytes.length !== metadata.byte_length || digest(bytes) !== metadata.sha256) {
    throw new PdfContentChangedError();
  }
  return bytes;
}

export function readPdfAnnotationsFile(paths: LibraryPaths, docId: string) {
  const dir = safeDocDir(paths, docId);
  const metadata = readPdfMetadataIfPresent(paths, docId);
  if (!metadata) throw new Error("PDF metadata missing");
  const file = PdfAnnotationsFileSchema.parse(
    JSON.parse(readRegularFile(join(dir, "annotations.json")).toString("utf8")) as unknown
  );
  if (file.doc_id !== docId || file.content_sha256 !== metadata.sha256)
    throw new Error("PDF annotations binding mismatch");
  try {
    validatePdfAnnotationsPageBounds(file.annotations, metadata.page_count);
  } catch {
    throw new Error("stored PDF annotation page is outside the document");
  }
  return file;
}

function validatePdfAnnotationsPageBounds(
  annotations: PdfAnnotationsFile["annotations"],
  pageCount: number
) {
  for (const annotation of annotations) {
    const pageIndexes: number[] =
      "page_index" in annotation
        ? [Number(annotation.page_index)]
        : "target" in annotation &&
            annotation.target &&
            typeof annotation.target === "object" &&
            "fragments" in annotation.target
          ? (annotation.target as { fragments: Array<{ page_index: number }> }).fragments.map(
              (fragment) => Number(fragment.page_index)
            )
          : [];
    if (pageIndexes.some((pageIndex) => pageIndex >= pageCount))
      throw new PdfAnnotationValidationError("PDF annotation page is outside the document");
  }
}

/** Persist an expected-revision edit without stripping unknown additive fields. */
export function savePdfAnnotationsFile(
  paths: LibraryPaths,
  docId: string,
  contentSha256: string,
  expectedRev: number,
  candidate: unknown,
  isBusy: (docId: string) => boolean = () => false
) {
  if (isBusy(docId)) throw new PdfAnnotationConflictError("busy");
  const metadata = readPdfMetadataIfPresent(paths, docId);
  if (!metadata) throw new Error("PDF metadata missing");
  let actualBytes: Buffer;
  try {
    actualBytes = readVerifiedPdf(paths, docId);
  } catch (error) {
    if (error instanceof PdfContentChangedError) throw new PdfAnnotationConflictError("content");
    throw error;
  }
  if (digest(actualBytes) !== metadata.sha256 || contentSha256 !== metadata.sha256)
    throw new PdfAnnotationConflictError("content");
  const current = readPdfAnnotationsFile(paths, docId);
  if (current.rev !== expectedRev) throw new PdfAnnotationConflictError("rev");
  const submitted = PdfAnnotationsFileSchema.parse(candidate);
  if (
    submitted.doc_id !== docId ||
    submitted.content_sha256 !== metadata.sha256 ||
    submitted.rev !== expectedRev
  )
    throw new Error("PDF annotation identity or binding mismatch");
  validatePdfAnnotationsPageBounds(submitted.annotations, metadata.page_count);

  const previousById = new Map(
    current.annotations.map((annotation) => [annotation.id, annotation])
  );
  const mergedAnnotations = submitted.annotations.map((annotation) => {
    const previous = previousById.get(annotation.id);
    if (!previous) return annotation;
    if (
      previous.kind !== annotation.kind ||
      previous.created_at !== annotation.created_at ||
      ("page_index" in previous &&
        (typeof previous.page_index !== "number" ||
          previous.page_index !==
            ("page_index" in annotation && typeof annotation.page_index === "number"
              ? annotation.page_index
              : -1))) ||
      ("target" in previous &&
        JSON.stringify(previous.target) !==
          JSON.stringify("target" in annotation ? annotation.target : null))
    ) {
      throw new Error("PDF annotation immutable target changed");
    }
    const merged = { ...previous } as Record<string, unknown>;
    const before = JSON.stringify([
      previous.body,
      "rectangle" in previous ? previous.rectangle : null,
      "style" in previous ? previous.style : null,
    ]);
    for (const key of ["body", "page_index", "rectangle", "style"])
      if (key in annotation) merged[key] = annotation[key];
    const after = JSON.stringify([merged.body, merged.rectangle ?? null, merged.style ?? null]);
    merged.updated_at = before === after ? previous.updated_at : new Date().toISOString();
    return merged as PdfAnnotationsFile["annotations"][number];
  });
  const changed = JSON.stringify(current.annotations) !== JSON.stringify(mergedAnnotations);
  const saved = PdfAnnotationsFileSchema.parse({
    ...current,
    rev: current.rev + (changed ? 1 : 0),
    annotations: mergedAnnotations,
  });
  if (changed)
    atomicWrite(
      join(safeDocDir(paths, docId), "annotations.json"),
      `${JSON.stringify(saved, null, 2)}\n`
    );
  return saved;
}

export function readPdfReadingPosition(paths: LibraryPaths, docId: string) {
  const dir = safeDocDir(paths, docId);
  const metadata = readPdfMetadataIfPresent(paths, docId);
  if (!metadata) throw new Error("PDF metadata missing");
  const file = PdfReadingPositionSchema.parse(
    JSON.parse(readRegularFile(join(dir, "reading-position.json")).toString("utf8")) as unknown
  );
  if (file.doc_id !== docId || file.content_sha256 !== metadata.sha256)
    throw new Error("PDF reading-position binding mismatch");
  if (file.position && file.position.page_index >= metadata.page_count)
    throw new Error("PDF reading-position page is outside the document");
  return file;
}

export class PdfReadingPositionConflictError extends Error {
  constructor(readonly currentRev: number) {
    super("reading position revision mismatch");
    this.name = "PdfReadingPositionConflictError";
  }
}

/** Persist the independent, content-bound reading position with its own rev. */
export function savePdfReadingPosition(
  paths: LibraryPaths,
  docId: string,
  candidate: unknown,
  expectedRev: number
) {
  const metadata = readPdfMetadataIfPresent(paths, docId);
  if (!metadata) throw new Error("PDF metadata missing");
  const bytes = readVerifiedPdf(paths, docId);
  if (digest(bytes) !== metadata.sha256) throw new PdfContentChangedError();
  const current = readPdfReadingPosition(paths, docId);
  if (current.rev !== expectedRev) throw new PdfReadingPositionConflictError(current.rev);
  const parsed = PdfReadingPositionSchema.parse(candidate);
  if (parsed.doc_id !== docId || parsed.rev !== expectedRev)
    throw new Error("PDF reading-position identity mismatch");
  if (parsed.content_sha256 !== metadata.sha256) throw new PdfAnnotationConflictError("content");
  if (parsed.position && parsed.position.page_index >= metadata.page_count)
    throw new PdfAnnotationValidationError("PDF reading-position page is outside the document");
  const saved = PdfReadingPositionSchema.parse({ ...parsed, rev: current.rev + 1 });
  atomicWrite(
    join(safeDocDir(paths, docId), "reading-position.json"),
    `${JSON.stringify(saved, null, 2)}\n`
  );
  return saved;
}
