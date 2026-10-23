/**
 * Seed the library from already-ingested reader documents
 * (bibgraph/library/seed.py).
 *
 * Every processed paper under `data/output/` becomes a library *work*. The PDF /
 * LaTeX / HTML renderings of one paper collapse into a single work (matched by
 * DOI, arXiv id, or normalized title) that lists all of them in `doc_ids` — so
 * "open in 文档" can jump straight to whichever rendering the reader has.
 *
 * Port notes (bug-for-bug):
 * - Python's module constant `OUTPUT_DIR` becomes the injected *outputDir*.
 * - Non-object / null `source` / `meta` / `references` values are treated as
 *   missing (Python would crash with AttributeError/TypeError; the TS port is
 *   defensive, matching the M1a convention for unreachable input classes).
 * - Non-string `doi` / `arxiv_id` / `title` values coerce to undefined/""
 *   (same defensiveness rationale).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pyOr } from "../documents/pyregex.js";
import { canonicalId, emptyWork, type LibraryStore, type Work } from "./store.js";

const ARXIV_RE = /^\d{4}\.\d{4,5}$/;

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function iterDocs(outputDir: string): [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [];
  let names: string[];
  try {
    names = readdirSync(outputDir);
  } catch {
    return out; // not a directory (Python: `if not OUTPUT_DIR.is_dir(): return`)
  }
  names.sort();
  for (const name of names) {
    const dir = join(outputDir, name);
    const jf = join(dir, `${name}.json`);
    try {
      if (!statSync(dir).isDirectory() || !existsSync(jf)) continue;
      out.push([name, JSON.parse(readFileSync(jf, "utf8")) as Record<string, unknown>]);
    } catch {}
  }
  return out;
}

/**
 * A text Doc is never seeded by title: its Work is the one the user created it under. Recognized by any of its explicit
 * marks (a source file, a text IR, the `text-` id), so a damaged or half-removed text Doc cannot become a new Work.
 */
function isTextDocEntry(docId: string, doc: Record<string, unknown>, docDir: string): boolean {
  return (
    docId.startsWith("text-") ||
    asRecord(doc.source).type === "text" ||
    existsSync(join(docDir, "text-source.json"))
  );
}

function isTextDocDir(outputDir: string, docId: string): boolean {
  if (!docId.startsWith("text-")) return false;
  try {
    return statSync(join(outputDir, docId)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Text Doc directories whose files cannot be read as a text Doc (source missing or not JSON, reading text not JSON).
 * Rebuild keeps their Work links and reports them; it never repairs, deletes or reseeds them.
 */
export function findDamagedTextDocs(outputDir: string): string[] {
  const bad: string[] = [];
  let names: string[];
  try {
    names = readdirSync(outputDir).sort();
  } catch {
    return bad;
  }
  const unreadable = (path: string): boolean => {
    try {
      const v: unknown = JSON.parse(readFileSync(path, "utf8"));
      return v === null || typeof v !== "object" || Array.isArray(v);
    } catch {
      return true;
    }
  };
  for (const name of names) {
    if (!name.startsWith("text-")) continue;
    const dir = join(outputDir, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const source = join(dir, "text-source.json");
    const ir = join(dir, `${name}.json`);
    if (!existsSync(source) || unreadable(source) || (existsSync(ir) && unreadable(ir)))
      bad.push(name);
  }
  return bad;
}

/**
 * The Work the library build seeds for one ingested Doc (its stored JSON `doc`, its directory `docDir`), or null when
 * the build never seeds that Doc (a PDF or a text Doc: their Work is the one the Library lists them under). The build
 * `upsert`s this Work, so it lands in whichever stored Work shares an identity key with it, or becomes a new one.
 * Exported so a writer that places a Doc (the Shelf take, shelf ticket 04) can tell beforehand where the next build
 * puts it.
 */
export function seedWorkFor(
  docId: string,
  doc: Record<string, unknown>,
  docDir: string
): Work | null {
  // PDF identity/ownership is sourced only from Library associations, never
  // title-based seeding. The bundle markers keep corrupt/partial metadata from
  // being reinterpreted as a first-time LaTeX Doc.
  // A text Doc's Work relation is the user's explicit choice (the source it was created under), never its title.
  if (
    doc.format === "pdf" ||
    isTextDocEntry(docId, doc, docDir) ||
    existsSync(join(docDir, "original.pdf")) ||
    existsSync(join(docDir, "annotations.json")) ||
    existsSync(join(docDir, "reading-position.json"))
  )
    return null;
  const src = asRecord(doc.source);
  const meta = asRecord(doc.meta);
  const title = ((pyOr(meta.title) as string | undefined) ?? "").trim();
  const doi = asStr(src.doi);
  let arxiv = asStr(src.arxiv_id);
  // the PDF pipeline names the dir by the arXiv id itself
  if (!arxiv && ARXIV_RE.test(docId)) arxiv = docId;
  const venue =
    src.publisher === "aanda" || (doi ?? "").startsWith("10.1051/0004-6361") ? "A&A" : null;

  const wid = canonicalId({ doi, arxiv, title });
  return {
    ...emptyWork(wid),
    title,
    doi: doi ?? null,
    arxiv_id: arxiv ?? null,
    venue,
    doc_ids: [docId],
    origin: "ingested",
  };
}

/** Create/merge a work per ingested paper. Idempotent (re-runnable). */
export function seedFromOutput(store: LibraryStore, outputDir: string): LibraryStore {
  for (const [docId, doc] of iterDocs(outputDir)) {
    const w = seedWorkFor(docId, doc, join(outputDir, docId));
    if (w !== null) store.upsert(w);
  }
  pruneMissingDocs(store, outputDir);
  return store;
}

/**
 * Drop `doc_ids` whose output dir no longer exists (e.g. a hollow doc that
 * was removed) so a deleted/failed ingest stops masquerading as coverage.
 */
function pruneMissingDocs(store: LibraryStore, outputDir: string): void {
  for (const w of store.works) {
    const kept = w.doc_ids.filter(
      (d) =>
        existsSync(join(outputDir, d, `${d}.json`)) ||
        existsSync(join(outputDir, d, "original.pdf")) ||
        // any existing text Doc directory is kept, readable or not: rebuild reports a damaged one
        // (`findDamagedTextDocs`) and never drops the only link the page has to reach and delete it
        isTextDocDir(outputDir, d) ||
        // a text draft has a source and no reading IR yet; that is a legitimate Doc, not a hollow one
        existsSync(join(outputDir, d, "text-source.json"))
    );
    if (kept.length !== w.doc_ids.length || kept.some((d, i) => d !== w.doc_ids[i])) {
      w.doc_ids = kept;
    }
  }
}

/** The reference records of one ingested doc (for offline edge matching). */
export function docReferenceIds(docId: string, outputDir: string): Record<string, unknown>[] {
  const jf = join(outputDir, docId, `${docId}.json`);
  if (!existsSync(jf)) return [];
  try {
    const doc = JSON.parse(readFileSync(jf, "utf8")) as Record<string, unknown>;
    const refs = doc.references;
    return Array.isArray(refs) ? (refs as Record<string, unknown>[]) : [];
  } catch {
    return []; // ValueError | OSError
  }
}
