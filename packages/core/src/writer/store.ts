/**
 * The Writer store (Stage 10 M2a) — manuscripts and user templates under the
 * effective data dir:
 *
 *   <dataDir>/manuscripts/m_<8hex>/manuscript.json   (+ assets/ for figures)
 *   <dataDir>/templates/<id>.json                    (user/agent template files)
 *
 * Mirrors the literature per-entry layout (`output/<doc_id>/<doc_id>.json`)
 * and the plans store's conventions: pretty 2-space JSON (git-diff/agent
 * friendly), atomic tmp+rename writes, a persisted `rev` optimistic lock the
 * server bumps on accepted PUTs, and NEVER a silent reset — a corrupt
 * `manuscript.json` throws, so the file (possibly the user's only copy) is
 * left untouched.
 *
 * Every writer schema is a looseObject, so unknown keys written by future
 * agents round-trip through load/save untouched (the I010 plans.json strip
 * regret must not repeat in this domain).
 *
 * Writes assume the single-user setup with the server serializing mutations
 * (writerLock): the fixed tmp name is not safe for concurrent writers.
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  BUILTIN_WRITER_TEMPLATES,
  ManuscriptSchema,
  type ManuscriptSummary,
  ManuscriptSummarySchema,
  type WriterManuscript,
  type WriterTemplate,
  WriterTemplateSchema,
} from "@argelanderspace/contracts";

// --------------------------------------------------------------------------- //
// Paths / ids
// --------------------------------------------------------------------------- //

export function manuscriptsDir(dataDir: string): string {
  return join(dataDir, "manuscripts");
}

export function templatesDir(dataDir: string): string {
  return join(dataDir, "templates");
}

export function manuscriptDir(dataDir: string, id: string): string {
  return join(manuscriptsDir(dataDir), id);
}

export function manuscriptJsonPath(dataDir: string, id: string): string {
  return join(manuscriptDir(dataDir, id), "manuscript.json");
}

function hex8(): string {
  return randomBytes(4).toString("hex");
}

export function newManuscriptId(): string {
  return `m_${hex8()}`;
}

// --------------------------------------------------------------------------- //
// Load / save
// --------------------------------------------------------------------------- //

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
}

/**
 * Read `manuscripts/<id>/manuscript.json`. A missing file yields `null`;
 * corrupt JSON or a schema-invalid document THROWS (never silently reset).
 */
export function loadManuscript(dataDir: string, id: string): WriterManuscript | null {
  const file = manuscriptJsonPath(dataDir, id);
  if (!existsSync(file)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`writer store: ${file} is not valid JSON: ${(err as Error).message}`);
  }
  const result = ManuscriptSchema.safeParse(data);
  if (!result.success) {
    throw new Error(
      `writer store: ${file} failed schema validation: ${formatIssues(result.error)}`
    );
  }
  return result.data;
}

export interface SaveManuscriptOptions {
  /** Persist `doc.rev + 1` instead of `doc.rev` (the PUT optimistic-lock path). */
  bumpRev?: boolean;
}

/**
 * Write `manuscripts/<id>/manuscript.json` atomically (tmp + rename, 2-space
 * pretty print), creating the manuscript dir if needed. With `bumpRev` the
 * stored document carries rev+1 and a fresh `updated_at`. Refuses to write a
 * document that doesn't validate against `ManuscriptSchema`. Returns the
 * stored document.
 */
export function saveManuscript(
  dataDir: string,
  doc: WriterManuscript,
  opts: SaveManuscriptOptions = {}
): WriterManuscript {
  const out: WriterManuscript = opts.bumpRev
    ? { ...doc, rev: doc.rev + 1, updated_at: new Date().toISOString() }
    : doc;
  const result = ManuscriptSchema.safeParse(out);
  if (!result.success) {
    throw new Error(
      `writer store: refusing to write an invalid manuscript: ${formatIssues(result.error)}`
    );
  }
  const dir = manuscriptDir(dataDir, result.data.id);
  mkdirSync(dir, { recursive: true });
  const file = manuscriptJsonPath(dataDir, result.data.id);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(result.data, null, 2), "utf8");
  renameSync(tmp, file);
  return result.data;
}

/**
 * Create a new manuscript (fresh id, rev 0, schema defaults) and persist it.
 * `template` is not validated here — the route checks it against
 * {@link loadTemplates} first.
 */
export function createManuscript(
  dataDir: string,
  input: { template: string; title?: string }
): WriterManuscript {
  const now = new Date().toISOString();
  const doc = ManuscriptSchema.parse({
    version: 1,
    id: newManuscriptId(),
    rev: 0,
    template: input.template,
    title: input.title?.trim() || "Untitled manuscript",
    created_at: now,
    updated_at: now,
  });
  return saveManuscript(dataDir, doc);
}

/**
 * Physically remove the whole `manuscripts/<id>/` directory (manuscript.json
 * AND assets/). Returns false when the id doesn't exist.
 */
export function deleteManuscript(dataDir: string, id: string): boolean {
  const dir = manuscriptDir(dataDir, id);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

// --------------------------------------------------------------------------- //
// List
// --------------------------------------------------------------------------- //

export interface ListManuscriptsResult {
  manuscripts: ManuscriptSummary[];
  /** One entry per skipped corrupt/unreadable manuscript dir. */
  warnings: string[];
}

/**
 * Scan `manuscripts/m_*​/manuscript.json` into summaries sorted by
 * `updated_at` descending. A corrupt or schema-invalid entry is SKIPPED with
 * a warning (one bad dir must not hide the rest of the list); an unreadable
 * or missing `manuscripts/` root yields an empty list.
 */
export function listManuscripts(dataDir: string): ListManuscriptsResult {
  const root = manuscriptsDir(dataDir);
  let names: string[] = [];
  try {
    names = readdirSync(root).sort();
  } catch {
    names = []; // missing root: empty library of manuscripts
  }
  const manuscripts: ManuscriptSummary[] = [];
  const warnings: string[] = [];
  for (const name of names) {
    if (!/^m_[0-9a-f]{8}$/.test(name)) continue;
    try {
      const doc = loadManuscript(dataDir, name);
      if (!doc) {
        warnings.push(`${name}: manuscript.json missing`);
        continue;
      }
      const parsed = ManuscriptSummarySchema.parse({
        id: doc.id,
        title: doc.title,
        template: doc.template,
        rev: doc.rev,
        created_at: doc.created_at,
        updated_at: doc.updated_at,
      });
      manuscripts.push(parsed);
    } catch (err) {
      warnings.push(`${name}: ${(err as Error).message}`);
    }
  }
  manuscripts.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return { manuscripts, warnings };
}

// --------------------------------------------------------------------------- //
// Templates
// --------------------------------------------------------------------------- //

export interface LoadTemplatesResult {
  /** Built-ins plus user files (user files override built-ins of the same id). */
  templates: WriterTemplate[];
  /** One entry per skipped unreadable/invalid user template file. */
  warnings: string[];
}

/**
 * Merge the contracts built-ins (aa/report/letter) with user/agent files from
 * `<dataDir>/templates/<id>.json`: a user file whose parsed id matches a
 * built-in's REPLACES that built-in (and also a file whose *name* matches,
 * even if its inner id differs). Unreadable JSON, schema-invalid files, or
 * an id/name mismatch are collected into `warnings` and skipped — a bad
 * template never blocks the editor. Sorted by label.
 */
export function loadTemplates(dataDir: string): LoadTemplatesResult {
  const warnings: string[] = [];
  const byId = new Map<string, WriterTemplate>();
  for (const t of BUILTIN_WRITER_TEMPLATES) byId.set(t.id, t);
  const dir = templatesDir(dataDir);
  let names: string[] = [];
  try {
    names = readdirSync(dir)
      .filter((n) => n.endsWith(".json"))
      .sort();
  } catch {
    names = []; // missing dir: built-ins only
  }
  for (const name of names) {
    const file = join(dir, name);
    const stem = name.replace(/\.json$/, "");
    try {
      const data: unknown = JSON.parse(readFileSync(file, "utf8"));
      const parsed = WriterTemplateSchema.parse(data);
      if (parsed.id !== stem) {
        warnings.push(`${name}: template id '${parsed.id}' does not match the file name`);
        continue;
      }
      byId.set(parsed.id, parsed);
    } catch (err) {
      warnings.push(`${name}: ${(err as Error).message}`);
    }
  }
  return {
    templates: [...byId.values()].sort((a, b) => a.label.localeCompare(b.label)),
    warnings,
  };
}

// --------------------------------------------------------------------------- //
// Assets
// --------------------------------------------------------------------------- //

const ASSET_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

/** Basename-only asset names: reject `..`/absolute/hidden names; backslash path tricks are normalized first. */
function sanitizeAssetName(filename: string): string {
  const normalized = filename.replace(/\\/g, "/");
  const name = basename(normalized);
  if (!name || name !== normalized || name.startsWith(".") || name.includes("\0")) {
    throw new Error(`writer store: bad asset filename ${JSON.stringify(filename)}`);
  }
  return name;
}

/**
 * Store figure bytes under `manuscripts/<id>/assets/`, creating the directory
 * on demand. The extension must be in the allowlist (case-insensitive). A
 * name that already exists is NOT overwritten — `-1`, `-2`, … is appended
 * before the extension. Returns the stored name.
 */
export function writeManuscriptAsset(
  dataDir: string,
  id: string,
  filename: string,
  bytes: Uint8Array
): string {
  const name = sanitizeAssetName(filename);
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  if (!ASSET_EXTENSIONS.has(ext)) {
    throw new Error(
      `writer store: unsupported asset extension ${JSON.stringify(ext || name)} (allowed: ${[...ASSET_EXTENSIONS].join(", ")})`
    );
  }
  const dir = join(manuscriptDir(dataDir, id), "assets");
  mkdirSync(dir, { recursive: true });
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  let candidate = name;
  for (let n = 1; existsSync(join(dir, candidate)); n++) {
    candidate = `${stem}-${n}${ext}`;
  }
  writeFileSync(join(dir, candidate), bytes);
  return candidate;
}

/**
 * Read a stored asset; missing → null. The name goes through the same
 * sanitization as writes (traversal attempts throw instead of escaping).
 */
export function readManuscriptAsset(dataDir: string, id: string, name: string): Buffer | null {
  const safe = sanitizeAssetName(name);
  const file = join(manuscriptDir(dataDir, id), "assets", safe);
  if (!existsSync(file)) return null;
  return readFileSync(file);
}
