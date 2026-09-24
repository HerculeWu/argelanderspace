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

/** Create/merge a work per ingested paper. Idempotent (re-runnable). */
export function seedFromOutput(store: LibraryStore, outputDir: string): LibraryStore {
  for (const [docId, doc] of iterDocs(outputDir)) {
    // PDF identity/ownership is sourced only from Library associations, never
    // title-based seeding. The bundle markers keep corrupt/partial metadata from
    // being reinterpreted as a first-time LaTeX Doc.
    if (
      doc.format === "pdf" ||
      existsSync(join(outputDir, docId, "original.pdf")) ||
      existsSync(join(outputDir, docId, "annotations.json")) ||
      existsSync(join(outputDir, docId, "reading-position.json"))
    )
      continue;
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
    const w: Work = {
      ...emptyWork(wid),
      title,
      doi: doi ?? null,
      arxiv_id: arxiv ?? null,
      venue,
      doc_ids: [docId],
      origin: "ingested",
    };
    store.upsert(w);
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
        existsSync(join(outputDir, d, "original.pdf"))
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
