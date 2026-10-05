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
  | "operation_gone"
  | "corrupt_operations";

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

/** The output directory as the filesystem really has it (a symlinked dataDir or `output/` is a legitimate layout). */
function outputBase(paths: LibraryPaths): string {
  try {
    return realpathSync(paths.outputDir);
  } catch {
    return paths.outputDir; // not created yet
  }
}

function docDirFor(paths: LibraryPaths, docId: string): string {
  if (!isTextDocId(docId)) throw new TextDocError("bad_id", "invalid text Doc id");
  return join(outputBase(paths), docId);
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

/** A regular file inside a real (non-symlink) Doc directory; `path` must come from {@link docDirFor}. */
function readRegular(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path)
    throw new TextDocError("unsafe", `unsafe text Doc file: ${path}`);
  const dir = lstatSync(join(path, ".."));
  if (!dir.isDirectory() || dir.isSymbolicLink())
    throw new TextDocError("unsafe", `unsafe text Doc directory: ${path}`);
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

/**
 * `<dataDir>/library/text-doc-operations.json`: the durable record that binds a caller's `operationId` to the Doc id
 * a creation will make, so a retry (after a lost response, an error or a restart) finds the same Doc instead of
 * making another. It lives beside library.json because it is created and read under the same library lock. Entries
 * are small and never pruned automatically. A file that is not valid is a data error (`corrupt_operations`): it is
 * never replaced, so no record is lost.
 */
interface OperationRecord {
  docId: string;
  workId: string;
  sourcePdfDocId: string | null;
  /** The Doc was committed (directory placed) by this operation; a missing directory afterwards means deleted. */
  done: boolean;
}
type OperationFile = { version: 1; operations: Record<string, OperationRecord> };

function operationsPath(paths: LibraryPaths): string {
  return join(paths.libraryDir, "text-doc-operations.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validOperation(value: unknown): value is OperationRecord {
  return (
    isRecord(value) &&
    typeof value.docId === "string" &&
    isTextDocId(value.docId) &&
    typeof value.workId === "string" &&
    (value.sourcePdfDocId === null || typeof value.sourcePdfDocId === "string") &&
    typeof value.done === "boolean"
  );
}

function readOperations(paths: LibraryPaths): OperationFile {
  const file = operationsPath(paths);
  if (!existsSync(file)) return { version: 1, operations: {} };
  const bad = (why: string) =>
    new TextDocError(
      "corrupt_operations",
      `the text document operation record (library/text-doc-operations.json) is unreadable: ${why}; it was left as it is`
    );
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw bad("not valid JSON");
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.operations))
    throw bad("unknown structure");
  for (const [id, record] of Object.entries(raw.operations))
    if (!validOperation(record)) throw bad(`record "${id}" is invalid`);
  return raw as unknown as OperationFile;
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

export interface CreatedTextDoc {
  created: boolean;
  docId: string;
  source: TextDocSource;
  /** The Work's `doc_ids` in library.json changed in this call (a new Doc, or a link that had been lost). */
  libraryChanged: boolean;
}

/**
 * Create an empty text source under an existing Work and append the new Doc to that Work's `doc_ids` (a narrow
 * append: an existing main Doc stays main, other Works and unknown keys are untouched). The caller holds the library
 * lock and has validated `sourcePdf` against the Work.
 *
 * The operation record binds `operationId` to the new Doc id BEFORE anything is created, so a retry (or a retry after
 * a restart that left the result unknown) finds the same Doc: an existing source is completed (link re-checked), never
 * duplicated. The commit order is: stage the files hidden, rename into place, record `done`, link the Work. Only a
 * directory this call itself placed is rolled back, and a failure before the link leaves no visible half Doc. Once the
 * link is written the call reports success whatever follows. A Doc made by an earlier call of the same operation and
 * since deleted is never recreated (`operation_gone`), independent of whether the Work still lists it.
 */
export function createTextDoc(
  paths: LibraryPaths,
  input: CreateTextDocInput,
  now: Date = new Date()
): CreatedTextDoc {
  const store = LibraryStore.load(paths);
  if (!store.get(input.workId)) throw new TextDocError("work_not_found", "Work not found");
  const ops = readOperations(paths);
  const existing = ops.operations[input.operationId];
  const pdfId = input.sourcePdf?.doc_id ?? null;
  if (existing && (existing.workId !== input.workId || existing.sourcePdfDocId !== pdfId))
    throw new TextDocError("operation_mismatch", "operation id was used for a different request");
  const docId = existing?.docId ?? newTextDocId();
  const record = (done: boolean): void => {
    ops.operations[input.operationId] = {
      docId,
      workId: input.workId,
      sourcePdfDocId: pdfId,
      done,
    };
    writeOperations(paths, ops);
  };
  if (!existing) record(false);
  const dir = docDirFor(paths, docId);
  if (existsSync(dir)) {
    // an earlier call placed the Doc: make sure the Work link exists and report the same result
    const source = readTextSource(paths, docId);
    const linked = appendDocIdNarrow(paths, input.workId, docId);
    if (linked === "not_found") throw new TextDocError("work_not_found", "Work not found");
    if (!existing?.done) {
      try {
        record(true);
      } catch {
        /* the Doc exists and is linked; the mark is retried by the next call */
      }
    }
    return { created: false, docId, source, libraryChanged: linked === "ok" };
  }
  if (existing?.done)
    throw new TextDocError(
      "operation_gone",
      "the document of this operation no longer exists; start the creation again"
    );

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
  const base = outputBase(paths);
  const target = join(base, docId);
  const stage = join(base, `.text-stage-${randomUUID()}`);
  mkdirSync(stage);
  let placed = false;
  try {
    writeFileSync(join(stage, TEXT_SOURCE_FILE), `${JSON.stringify(source, null, 2)}\n`, {
      flag: "wx",
    });
    renameSync(stage, target);
    placed = true;
    record(true); // before the link: a Doc that is later deleted can never be recreated by a retry
    if (appendDocIdNarrow(paths, input.workId, docId) === "not_found")
      throw new TextDocError("work_not_found", "Work not found");
  } catch (error) {
    rmSync(stage, { recursive: true, force: true });
    if (placed) {
      rmSync(target, { recursive: true, force: true });
      try {
        record(false); // nothing was committed: a retry may complete the same operation
      } catch {
        /* a retry then reports operation_gone and the caller starts over */
      }
    }
    throw error;
  }
  return { created: true, docId, source, libraryChanged: true };
}
