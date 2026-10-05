/**
 * Text Doc storage (copilot ticket 25): `<dataDir>/output/<docId>/text-source.json` is the single source state file
 * (the whole Markdown, a monotonic `rev`, the asset list); `<docId>.json` beside it is the LAST SUCCESSFULLY
 * GENERATED reading IR and may be absent (a first draft is legitimate, not damage).
 *
 * Locks belong to the caller (the server holds `libraryLock` for creation and its own short text lock for saves and
 * publishing); these functions only keep each file whole: every write is a same-directory temporary file plus a
 * rename, so a failed write leaves the previous bytes. An existing source is never rewritten by a failed attempt.
 */

import { randomUUID } from "node:crypto";
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
  TEXT_DOC_ID_PATTERN,
  TEXT_INPUT_VERSION,
  type TextDocIr,
  TextDocIrSchema,
  type TextDocSource,
  TextDocSourceSchema,
  type TextSourcePdf,
} from "@argelanderspace/contracts";
import { appendDocIdNarrow } from "./library/patch.js";
import type { LibraryPaths } from "./library/store.js";
import { LibraryStore } from "./library/store.js";

export type TextDocErrorCode =
  | "bad_id"
  | "not_found"
  | "corrupt_source"
  | "corrupt_ir"
  | "unsafe"
  | "work_not_found"
  | "operation_mismatch"
  | "operation_gone";

export class TextDocError extends Error {
  readonly code: TextDocErrorCode;
  constructor(code: TextDocErrorCode, message: string) {
    super(message);
    this.name = "TextDocError";
    this.code = code;
  }
}

export const TEXT_SOURCE_FILE = "text-source.json";

/** The canonical new text Doc id. */
export function newTextDocId(): string {
  return `text-${randomUUID()}`;
}

export function isTextDocId(docId: string): boolean {
  return TEXT_DOC_ID_PATTERN.test(docId);
}

function docDirFor(paths: LibraryPaths, docId: string): string {
  if (!isTextDocId(docId)) throw new TextDocError("bad_id", "invalid text Doc id");
  return join(paths.outputDir, docId);
}

/** Whether a Doc directory holds a text source: the explicit marker that tells a draft from damage. */
export function isTextDoc(paths: LibraryPaths, docId: string): boolean {
  if (!isTextDocId(docId)) return false;
  try {
    return lstatSync(join(docDirFor(paths, docId), TEXT_SOURCE_FILE)).isFile();
  } catch {
    return false;
  }
}

function readRegular(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new TextDocError("unsafe", `unsafe text Doc file: ${path}`);
  return readFileSync(path);
}

/** Atomic same-directory replace. A fixed `.tmp` name is safe because writers are serialized by the caller. */
function replaceFile(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* keep the original error */
    }
    throw error;
  }
}

export function readTextSource(paths: LibraryPaths, docId: string): TextDocSource {
  const dir = docDirFor(paths, docId);
  const file = join(dir, TEXT_SOURCE_FILE);
  if (!existsSync(file)) throw new TextDocError("not_found", `text Doc "${docId}" not found`);
  let raw: unknown;
  try {
    raw = JSON.parse(readRegular(file).toString("utf8"));
  } catch (error) {
    if (error instanceof TextDocError) throw error;
    throw new TextDocError("corrupt_source", `text source of "${docId}" is not valid JSON`);
  }
  const parsed = TextDocSourceSchema.safeParse(raw);
  if (!parsed.success || parsed.data.doc_id !== docId)
    throw new TextDocError("corrupt_source", `text source of "${docId}" is invalid`);
  return parsed.data;
}

export type SaveTextSourceResult =
  | { kind: "saved"; source: TextDocSource }
  | { kind: "conflict"; source: TextDocSource };

/**
 * Replace the Markdown when `expectedRev` is the stored revision (the caller holds the Doc's text lock, so the
 * re-read and the write are one critical section). Any text, however malformed, is stored. A stale revision answers
 * `conflict` with the stored source and writes nothing.
 */
export function saveTextSource(
  paths: LibraryPaths,
  docId: string,
  input: { expectedRev: number; markdown: string },
  now: Date = new Date()
): SaveTextSourceResult {
  const current = readTextSource(paths, docId);
  if (current.rev !== input.expectedRev) return { kind: "conflict", source: current };
  const next: TextDocSource = {
    ...current,
    rev: current.rev + 1,
    markdown: input.markdown,
    updated_at: now.toISOString(),
  };
  const gate = TextDocSourceSchema.parse(next);
  replaceFile(
    join(docDirFor(paths, docId), TEXT_SOURCE_FILE),
    `${JSON.stringify(gate, null, 2)}\n`
  );
  return { kind: "saved", source: gate };
}

// --------------------------------------------------------------------------- //
// The published reading IR
// --------------------------------------------------------------------------- //

export function textIrPath(paths: LibraryPaths, docId: string): string {
  return join(docDirFor(paths, docId), `${docId}.json`);
}

/** The last generated IR, `null` when none exists yet; a present but unreadable file is an error, never `null`. */
export function readPublishedTextIr(paths: LibraryPaths, docId: string): TextDocIr | null {
  const file = textIrPath(paths, docId);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readRegular(file).toString("utf8"));
  } catch (error) {
    if (error instanceof TextDocError) throw error;
    throw new TextDocError("corrupt_ir", `the reading text of "${docId}" is not valid JSON`);
  }
  const parsed = TextDocIrSchema.safeParse(raw);
  if (!parsed.success || parsed.data.docId !== docId)
    throw new TextDocError("corrupt_ir", `the reading text of "${docId}" is invalid`);
  return parsed.data;
}

/** The publication boundary: one atomic rename. A failure leaves the previous IR (or none) untouched. */
export function publishTextIr(paths: LibraryPaths, docId: string, ir: TextDocIr): void {
  const gate = TextDocIrSchema.parse(ir);
  replaceFile(textIrPath(paths, docId), `${JSON.stringify(gate, null, 2)}\n`);
}

// --------------------------------------------------------------------------- //
// Creation
// --------------------------------------------------------------------------- //

interface OperationRecord {
  docId: string;
  workId: string;
  sourcePdfDocId: string | null;
  done: boolean;
}
type OperationFile = { version: 1; operations: Record<string, OperationRecord> };

function operationsPath(paths: LibraryPaths): string {
  return join(paths.libraryDir, "text-doc-operations.json");
}

function readOperations(paths: LibraryPaths): OperationFile {
  const file = operationsPath(paths);
  if (!existsSync(file)) return { version: 1, operations: {} };
  const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (
    raw === null ||
    typeof raw !== "object" ||
    (raw as { version?: unknown }).version !== 1 ||
    typeof (raw as { operations?: unknown }).operations !== "object"
  )
    throw new TextDocError("corrupt_source", "text Doc operation record is invalid");
  return raw as OperationFile;
}

function writeOperations(paths: LibraryPaths, data: OperationFile): void {
  mkdirSync(paths.libraryDir, { recursive: true });
  replaceFile(operationsPath(paths), `${JSON.stringify(data, null, 2)}\n`);
}

export interface CreateTextDocInput {
  operationId: string;
  workId: string;
  sourcePdf?: TextSourcePdf;
}

/**
 * Create an empty text source under an existing Work and append the new Doc to that Work's `doc_ids` (a narrow
 * append: an existing main Doc stays main, other Works and unknown keys are untouched). The caller holds the library
 * lock and has validated `sourcePdf` against the Work.
 *
 * The operation record binds `operationId` to the new Doc id BEFORE anything is created, so a retry (or a retry after
 * a restart that left the result unknown) finds the same Doc: an existing source is completed (link re-checked), never
 * duplicated. The files are built in a hidden staging directory and renamed into place; only a directory this call
 * itself created is rolled back, and a failure leaves no visible half Doc. A Doc created by an earlier call of the same
 * operation and since deleted is NOT recreated (`operation_gone`).
 */
export function createTextDoc(
  paths: LibraryPaths,
  input: CreateTextDocInput,
  now: Date = new Date()
): { created: boolean; docId: string; source: TextDocSource } {
  const store = LibraryStore.load(paths);
  if (!store.get(input.workId)) throw new TextDocError("work_not_found", "Work not found");
  const ops = readOperations(paths);
  const existing = ops.operations[input.operationId];
  const pdfId = input.sourcePdf?.doc_id ?? null;
  if (existing && (existing.workId !== input.workId || existing.sourcePdfDocId !== pdfId))
    throw new TextDocError("operation_mismatch", "operation id was used for a different request");
  const docId = existing?.docId ?? newTextDocId();
  if (!existing) {
    ops.operations[input.operationId] = {
      docId,
      workId: input.workId,
      sourcePdfDocId: pdfId,
      done: false,
    };
    writeOperations(paths, ops);
  }
  const dir = docDirFor(paths, docId);
  if (existsSync(dir)) {
    // an earlier call made the Doc: make sure the Work link exists and report the same result
    const source = readTextSource(paths, docId);
    if (appendDocIdNarrow(paths, input.workId, docId) === "not_found")
      throw new TextDocError("work_not_found", "Work not found");
    if (!existing?.done) {
      ops.operations[input.operationId] = {
        docId,
        workId: input.workId,
        sourcePdfDocId: pdfId,
        done: true,
      };
      writeOperations(paths, ops);
    }
    return { created: false, docId, source };
  }
  if (existing?.done)
    throw new TextDocError("operation_gone", "the document of this operation was deleted");

  const source: TextDocSource = TextDocSourceSchema.parse({
    version: 1,
    doc_id: docId,
    rev: 0,
    input_version: TEXT_INPUT_VERSION,
    markdown: "",
    assets: [],
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...(input.sourcePdf ? { source_pdf: input.sourcePdf } : {}),
  });
  mkdirSync(paths.outputDir, { recursive: true });
  const stage = join(paths.outputDir, `.text-stage-${randomUUID()}`);
  mkdirSync(stage);
  let placed = false;
  try {
    writeFileSync(join(stage, TEXT_SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(stage, dir);
    placed = true;
    if (appendDocIdNarrow(paths, input.workId, docId) === "not_found")
      throw new TextDocError("work_not_found", "Work not found");
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (placed) rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  ops.operations[input.operationId] = {
    docId,
    workId: input.workId,
    sourcePdfDocId: pdfId,
    done: true,
  };
  try {
    writeOperations(paths, ops);
  } catch {
    // The Doc exists and is linked; a missing `done` mark only makes a retry re-verify it.
  }
  return { created: true, docId, source };
}
