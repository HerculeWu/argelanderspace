/**
 * The document-annotation store (`<dataDir>/annotations/<doc_id>/`) — Stage 8
 * MS1. Locked design: `.kimi-code/memory/2026-09-10-stage8-roadmap.md` §2
 * (storage), §3 (content fingerprint), §4 (invalidation/archive).
 *
 * Layout per doc: `current.json` (the live annotations, bound to the exact
 * document content via `content_fingerprint`) plus `archive/` (previous
 * currents, moved aside verbatim on content replacement). The file is the
 * single source of truth for the reader and the agent surface, so it is
 * pretty-printed (2 spaces) and written atomically (tmp + rename, same
 * pattern as `plans/store.ts` and `library/store.ts`).
 *
 * `rev` is the persisted optimistic-lock version: the PUT path (MS2) checks
 * `body.rev === current.rev` and saves with `{ bumpRev: true }`. A new
 * fingerprint epoch (invalidation) restarts `rev` from 0 — hence the PUT
 * double check (fingerprint AND rev) on the server side.
 *
 * Writes assume the single-user setup with the server serializing mutations
 * (annotationLock, MS2): the fixed tmp name is not safe for concurrent
 * writers.
 *
 * Failure discipline (roadmap §3 三态硬规则): a fingerprint that cannot be
 * computed is a system error, NEVER a mismatch — annotations are left
 * untouched (no archive, no rewrite, no delete). Doc missing →
 * `AnnotationsError` code `not_found` (server maps 404); corrupt IR /
 * corrupt current / fingerprint failure / archive failure → codes
 * `corrupt_ir` / `corrupt_store` / `fingerprint` / `archive` (500).
 *
 * The CRUD helpers are pure: they never mutate the input `AnnotationsFile`,
 * they return a new one, and they never touch `rev` or
 * `content_fingerprint` (both are save-time/epoch concerns). Unknown and
 * duplicate annotation ids throw — a silent no-op would hide a stale
 * client.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Annotation,
  type AnnotationsFile,
  AnnotationsFileSchema,
  type AssetDigest,
  canonicalSegmentsText,
  type DocIr,
  type IrBlock,
  type IrSection,
  type TexDocIr,
  TexDocIrSchema,
} from "@argelanderspace/contracts";

import { assetBytesHash, readAssetBytes, readDocumentAsset } from "./assets.js";

// --------------------------------------------------------------------------- //
// Errors
// --------------------------------------------------------------------------- //

/**
 * The failure channels of `ensureCurrentAnnotations` (roadmap §3 tri-state):
 * `not_found` (doc missing → 404), `corrupt_ir` (doc JSON unparseable /
 * schema-invalid / pre-migration → 500), `corrupt_store` (current.json
 * unparseable / schema-invalid → 500, never silently reset), `fingerprint`
 * (an asset the IR references is missing/unreadable → 500, never treated as
 * a mismatch), `archive` (the old current could not be moved to archive →
 * 500, the original current is left untouched).
 */
export type AnnotationsErrorCode =
  | "not_found"
  | "corrupt_ir"
  | "corrupt_store"
  | "fingerprint"
  | "archive";

export class AnnotationsError extends Error {
  readonly code: AnnotationsErrorCode;
  constructor(code: AnnotationsErrorCode, message: string) {
    super(message);
    this.name = "AnnotationsError";
    this.code = code;
  }
}

// --------------------------------------------------------------------------- //
// Paths
// --------------------------------------------------------------------------- //

export function annotationsRootDir(dataDir: string): string {
  return join(dataDir, "annotations");
}

export function annotationsDocDir(dataDir: string, docId: string): string {
  return join(annotationsRootDir(dataDir), docId);
}

export function annotationsCurrentPath(dataDir: string, docId: string): string {
  return join(annotationsDocDir(dataDir, docId), "current.json");
}

export function annotationsArchiveDir(dataDir: string, docId: string): string {
  return join(annotationsDocDir(dataDir, docId), "archive");
}

function docDirPath(dataDir: string, docId: string): string {
  return join(dataDir, "output", docId);
}

function docJsonPath(dataDir: string, docId: string): string {
  return join(docDirPath(dataDir, docId), `${docId}.json`);
}

// --------------------------------------------------------------------------- //
// Load / save
// --------------------------------------------------------------------------- //

/** The empty document for a fresh fingerprint epoch (rev restarts from 0). */
export function emptyAnnotationsFile(contentFingerprint: string): AnnotationsFile {
  return { version: 1, rev: 0, content_fingerprint: contentFingerprint, annotations: [] };
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/**
 * Read `annotations/<docId>/current.json`. A missing file yields `null` —
 * NOT the empty document: an empty file still needs a content fingerprint,
 * which this layer cannot compute (see {@link ensureCurrentAnnotations}).
 * Corrupt JSON or a schema-invalid document throws (never silently reset —
 * the file may be the user's only copy).
 */
export function loadAnnotationsFile(dataDir: string, docId: string): AnnotationsFile | null {
  const file = annotationsCurrentPath(dataDir, docId);
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new AnnotationsError(
      "corrupt_store",
      `annotations store: ${file} is not valid JSON: ${(err as Error).message}`
    );
  }
  const result = AnnotationsFileSchema.safeParse(data);
  if (!result.success) {
    throw new AnnotationsError(
      "corrupt_store",
      `annotations store: ${file} failed schema validation: ${formatIssues(result.error)}`
    );
  }
  return result.data;
}

export interface SaveAnnotationsOptions {
  /** Persist `file.rev + 1` instead of `file.rev` (the PUT optimistic-lock path). */
  bumpRev?: boolean;
}

/**
 * Write `annotations/<docId>/current.json` atomically (tmp + rename,
 * 2-space pretty print), creating the doc dir if needed. Refuses to write a
 * document that doesn't validate against `AnnotationsFileSchema`.
 */
export function saveAnnotationsFile(
  dataDir: string,
  docId: string,
  file: AnnotationsFile,
  opts: SaveAnnotationsOptions = {}
): void {
  const out: AnnotationsFile = opts.bumpRev ? { ...file, rev: file.rev + 1 } : file;
  const result = AnnotationsFileSchema.safeParse(out);
  if (!result.success) {
    throw new Error(
      `annotations store: refusing to write an invalid AnnotationsFile: ${formatIssues(result.error)}`
    );
  }
  mkdirSync(annotationsDocDir(dataDir, docId), { recursive: true });
  const file_ = annotationsCurrentPath(dataDir, docId);
  const tmp = file_.replace(/\.json$/, ".json.tmp");
  writeFileSync(tmp, JSON.stringify(result.data, null, 2), "utf8");
  renameSync(tmp, file_);
}

// --------------------------------------------------------------------------- //
// Id generation
// --------------------------------------------------------------------------- //

/** `a_<8 hex>` annotation id (crypto.randomBytes). */
export function newAnnotationId(): string {
  return `a_${randomBytes(4).toString("hex")}`;
}

// --------------------------------------------------------------------------- //
// CRUD helpers (pure: input untouched, new AnnotationsFile returned)
// --------------------------------------------------------------------------- //

function annotationIndex(file: AnnotationsFile, id: string): number {
  const i = file.annotations.findIndex((a) => a.id === id);
  if (i < 0) throw new Error(`annotations store: no annotation with id ${id}`);
  return i;
}

/** Append *annotation*; throws on a duplicate annotation id. */
export function addAnnotation(file: AnnotationsFile, annotation: Annotation): AnnotationsFile {
  if (file.annotations.some((a) => a.id === annotation.id)) {
    throw new Error(`annotations store: duplicate annotation id ${annotation.id}`);
  }
  return { ...file, annotations: [...file.annotations, annotation] };
}

/**
 * Replace the body of the named annotation. `updated_at` bumps ONLY when the
 * body bytes actually differ (an identical body returns the input file
 * unchanged); `target`/`snapshot`/`created_at` are immutable. A trim-empty
 * body is rejected here (fail fast) — it could never be saved anyway.
 */
export function updateAnnotationBody(
  file: AnnotationsFile,
  id: string,
  body: string,
  now: string = new Date().toISOString()
): AnnotationsFile {
  const i = annotationIndex(file, id);
  const current = file.annotations[i] as Annotation;
  if (current.body === body) return file;
  if (body.trim() === "") {
    throw new Error(`annotations store: body must not be empty (annotation ${id})`);
  }
  const annotations = [...file.annotations];
  annotations[i] = { ...current, body, updated_at: now };
  return { ...file, annotations };
}

export function deleteAnnotation(file: AnnotationsFile, id: string): AnnotationsFile {
  const i = annotationIndex(file, id);
  return { ...file, annotations: file.annotations.filter((_, j) => j !== i) };
}

// --------------------------------------------------------------------------- //
// Content fingerprint (roadmap §3)
// --------------------------------------------------------------------------- //

/** Context the fingerprint needs beyond the IR: where the doc lives on disk
 *  (figure/table asset bytes are hashed from `docDir`). */
export interface DocContentContext {
  /** `<dataDir>/output/<docId>`. */
  docDir: string;
}

/**
 * sha256 of a block asset's bytes. `imgPath` resolution mirrors the server's
 * `/images` routes exactly: a bare filename lives under `<docDir>/assets/`
 * (the Stage-5 tex pipeline convention, `app.ts` single-segment route); a
 * value carrying a subdirectory is doc-dir relative verbatim (`app.ts`
 * multi-segment route), guarded by the same traversal rule as that route
 * (`badImagePath`: no backslash, no empty/`..`/leading-dot segments) so a
 * hostile or corrupt IR can never make the fingerprint read outside the doc
 * dir. A present-but-unreadable asset THROWS (fingerprint failure, never a
 * mismatch) — the caller must not touch annotations then.
 */
function assetContentHash(docDir: string, imgPath: string): string {
  if (
    imgPath.includes("\\") ||
    imgPath.split("/").some((s) => s === "" || s === ".." || s.startsWith("."))
  ) {
    throw new AnnotationsError(
      "fingerprint",
      `annotations fingerprint: refusing unsafe asset path "${imgPath}"`
    );
  }
  const p = imgPath.includes("/") ? join(docDir, imgPath) : join(docDir, "assets", imgPath);
  let bytes: Buffer;
  try {
    bytes = readAssetBytes(p);
  } catch (err) {
    throw new AnnotationsError(
      "fingerprint",
      `annotations fingerprint: cannot read asset "${imgPath}" (${p}): ${(err as Error).message}`
    );
  }
  return assetBytesHash(bytes);
}

function captionProjection(segments: Parameters<typeof canonicalSegmentsText>[0] | undefined) {
  return segments === undefined ? null : canonicalSegmentsText(segments);
}

function blockProjection(b: IrBlock, assetHash: (imgPath: string) => string): unknown[] {
  switch (b.type) {
    case "paragraph":
      return ["paragraph", b.id, canonicalSegmentsText(b.segments)];
    case "list":
      // item boundaries are the array itself; each item's canonical text is
      // one entry, so inserting/deleting an item shifts the projection.
      return ["list", b.id, b.ordered, b.items.map((item) => canonicalSegmentsText(item.segments))];
    case "equation":
      return ["equation", b.id, b.number ?? null, b.label ?? null, b.latex];
    case "figure":
      return [
        "figure",
        b.id,
        b.number ?? null,
        b.label ?? null,
        captionProjection(b.captionSegments),
        b.footnote ?? null,
        b.imgPath === undefined ? null : assetHash(b.imgPath),
      ];
    case "table":
      return [
        "table",
        b.id,
        b.number ?? null,
        b.label ?? null,
        captionProjection(b.captionSegments),
        b.footnote ?? null,
        b.tableBody ?? null,
        b.imgPath === undefined ? null : assetHash(b.imgPath),
      ];
    case "code":
      return [
        "code",
        b.id,
        b.number ?? null,
        b.label ?? null,
        captionProjection(b.captionSegments),
        b.lang ?? null,
        b.body ?? null,
      ];
    case "algorithm":
      return [
        "algorithm",
        b.id,
        b.number ?? null,
        b.label ?? null,
        captionProjection(b.captionSegments),
        b.body ?? null,
      ];
  }
}

/**
 * The canonical projection of a document's annotation-addressable content
 * (roadmap §3): one entry per section/block in document order (section
 * heading, then its blocks, then children — the renderer's order), each
 * binding the persistent id to its content. EXCLUDED by design: `source`,
 * top-level `title`/`meta`, `refsManifest`, `bib`, `references`,
 * `citationsByBlock`, `imgWidth`/`imgHeight` (provenance/display facts, and
 * references are not annotation targets). Section headings ARE included
 * (they live inside the addressable tree).
 *
 * Deterministic by construction (nested arrays, `null` for absent fields),
 * so `JSON.stringify(projection)` is a stable serialization.
 */
export function docContentProjection(ir: DocIr, ctx: DocContentContext): unknown[] {
  return contentProjection(ir, (imgPath) => assetContentHash(ctx.docDir, imgPath));
}

/** Shared pure projection; reader policy does not change its serialization. */
function contentProjection(ir: DocIr, assetHash: (imgPath: string) => string): unknown[] {
  const out: unknown[] = [];
  const walk = (sections: IrSection[]): void => {
    for (const s of sections) {
      out.push(["section", s.id, s.level, s.number ?? null, s.heading ?? null]);
      for (const b of s.blocks) out.push(blockProjection(b, assetHash));
      walk(s.children);
    }
  };
  walk(ir.sections);
  return out;
}

/** sha256 hex over the deterministic serialization of the projection. */
export function docContentFingerprint(ir: DocIr, ctx: DocContentContext): string {
  return createHash("sha256")
    .update(JSON.stringify(docContentProjection(ir, ctx)))
    .digest("hex");
}

// --------------------------------------------------------------------------- //
// ensureCurrentAnnotations (roadmap §3 tri-state + §4 archive semantics)
// --------------------------------------------------------------------------- //

export interface EnsureCurrentAnnotationsResult {
  file: AnnotationsFile;
  /** True when a fingerprint mismatch archived the old current and started a
   *  new empty epoch (the server broadcasts `invalidate` only after this new
   *  current exists — MS2's job, not this layer's). */
  invalidated: boolean;
}

/**
 * Load the stored render IR (`output/<docId>/<docId>.json`) with the CLI's
 * `loadDocIr` discipline: missing → `not_found`; unparseable → `corrupt_ir`;
 * no `version` marker → pre-migration document, `corrupt_ir`; schema-invalid
 * → `corrupt_ir`.
 */
function loadStoredDocIr(dataDir: string, docId: string): TexDocIr {
  const p = docJsonPath(dataDir, docId);
  if (!existsSync(p) || !statSync(p).isFile()) {
    throw new AnnotationsError("not_found", `annotations: doc "${docId}" not found (${p})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new AnnotationsError(
      "corrupt_ir",
      `annotations: ${p} is not valid JSON: ${(err as Error).message}`
    );
  }
  if (
    raw === null ||
    typeof raw !== "object" ||
    typeof (raw as Record<string, unknown>).version !== "number"
  ) {
    throw new AnnotationsError(
      "corrupt_ir",
      `annotations: doc "${docId}" is a pre-migration document — re-ingest it`
    );
  }
  const result = TexDocIrSchema.safeParse(raw);
  if (!result.success) {
    throw new AnnotationsError(
      "corrupt_ir",
      `annotations: ${p} failed schema validation: ${formatIssues(result.error)}`
    );
  }
  return result.data;
}

/** `YYYYMMDDTHHmmssSSSZ` (UTC, millisecond precision, fixed width — so the
 *  names sort lexicographically and stay filesystem-safe). */
function archiveStamp(d: Date): string {
  const p = (n: number, w: number) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1, 2)}${p(d.getUTCDate(), 2)}` +
    `T${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}${p(d.getUTCSeconds(), 2)}` +
    `${p(d.getUTCMilliseconds(), 3)}Z`
  );
}

/**
 * Move the old current into `archive/` BYTE-VERBATIM (roadmap §4: 原样移入 —
 * the raw file bytes, not a re-serialization of the parsed value, so keys an
 * external editor or a future schema version added survive), as
 * `<stamp>-<oldFp8>.json`; on a name collision `-2`/`-3`… is appended —
 * existing archives are never overwritten. Atomic (tmp + rename). Any
 * failure throws `AnnotationsError` code `archive`; the live current is not
 * touched by this function at all (the caller replaces it only after the
 * archive exists). The caller must have schema-validated the current already
 * (this function trusts `current` only for the fingerprint in the filename).
 */
function archiveCurrentAnnotations(
  dataDir: string,
  docId: string,
  current: AnnotationsFile,
  now: Date
): string {
  const dir = annotationsArchiveDir(dataDir, docId);
  const base = `${archiveStamp(now)}-${current.content_fingerprint.slice(0, 8)}`;
  try {
    const raw = readFileSync(annotationsCurrentPath(dataDir, docId));
    mkdirSync(dir, { recursive: true });
    let name = `${base}.json`;
    for (let n = 2; existsSync(join(dir, name)); n += 1) name = `${base}-${n}.json`;
    const target = join(dir, name);
    const tmp = `${target}.tmp`;
    writeFileSync(tmp, raw);
    renameSync(tmp, target);
    return target;
  } catch (err) {
    throw new AnnotationsError(
      "archive",
      `annotations store: failed to archive the old current for doc "${docId}": ${(err as Error).message}`
    );
  }
}

export interface EnsureCurrentAnnotationsOptions {
  /** Clock override for the archive filename (tests). */
  now?: Date;
}

/**
 * The idempotent access-path guard (roadmap §3/§4): compute the document's
 * content fingerprint, then —
 * - doc missing / IR corrupt / fingerprint uncomputable → typed
 *   `AnnotationsError`; annotations are NEVER touched in these cases;
 * - `current.json` missing → return an EPHEMERAL empty file bound to the
 *   fresh fingerprint (persisted only on the first PUT; a leftover archive/
 *   dir from a crash mid-invalidation is fine), `invalidated: false`;
 * - `current.json` corrupt → throw (never silently reset);
 * - fingerprint match → `{file: current, invalidated: false}`;
 * - mismatch → archive the old current verbatim FIRST (failure → throw, the
 *   old current stays), then save a new empty current bound to the fresh
 *   fingerprint (rev 0). If the archive succeeded but the new-current write
 *   failed, the next call recovers through the paths above.
 */
export function ensureCurrentAnnotations(
  dataDir: string,
  docId: string,
  opts: EnsureCurrentAnnotationsOptions = {}
): EnsureCurrentAnnotationsResult {
  const ir = loadStoredDocIr(dataDir, docId);
  const fingerprint = docContentFingerprint(ir, { docDir: docDirPath(dataDir, docId) });
  return ensureForFingerprint(dataDir, docId, fingerprint, opts);
}

/** Server annotations access only: validate identity and hash each declared
 * path once, deriving the manifest from the exact projection reads. */
export function ensureCurrentAnnotationsWithDocument(
  dataDir: string,
  docId: string,
  opts: EnsureCurrentAnnotationsOptions = {}
): EnsureCurrentAnnotationsResult & { ir: TexDocIr; assets: AssetDigest[] } {
  const ir = loadStoredDocIr(dataDir, docId);
  if (ir.docId !== docId) {
    throw new AnnotationsError("corrupt_ir", `annotations: doc id mismatch for "${docId}"`);
  }
  const digests = new Map<string, string>();
  const projection = contentProjection(ir, (imgPath) => {
    const known = digests.get(imgPath);
    if (known !== undefined) return known;
    try {
      const { sha256 } = readDocumentAsset(docDirPath(dataDir, docId), imgPath);
      digests.set(imgPath, sha256);
      return sha256;
    } catch (err) {
      throw new AnnotationsError(
        "fingerprint",
        `annotations fingerprint: ${(err as Error).message}`
      );
    }
  });
  const fingerprint = createHash("sha256").update(JSON.stringify(projection)).digest("hex");
  const assets = Array.from(digests, ([imgPath, sha256]) => ({ imgPath, sha256 }));
  return { ir, assets, ...ensureForFingerprint(dataDir, docId, fingerprint, opts) };
}

// Private: no caller can supply a client fingerprint to authorize archival.
function ensureForFingerprint(
  dataDir: string,
  docId: string,
  fingerprint: string,
  opts: EnsureCurrentAnnotationsOptions
): EnsureCurrentAnnotationsResult {
  const current = loadAnnotationsFile(dataDir, docId);
  if (current === null) {
    return { file: emptyAnnotationsFile(fingerprint), invalidated: false };
  }
  if (current.content_fingerprint === fingerprint) {
    return { file: current, invalidated: false };
  }
  archiveCurrentAnnotations(dataDir, docId, current, opts.now ?? new Date());
  const next = emptyAnnotationsFile(fingerprint);
  saveAnnotationsFile(dataDir, docId, next);
  return { file: next, invalidated: true };
}
