/**
 * Acquisition executor: fetch full text for ready works per their plan
 * (bibgraph/acquire/execute.py).
 *
 * The planner decided *where* to read each paper; the executor *does* it, routing
 * each ready work to the matching ingestion pipeline:
 * - `journal_html` → `ingestHtml` (DOI → publisher page → reader Document);
 * - `arxiv_latex`  → `ingestLatex` (arXiv id → e-print LaTeX → reader Document);
 * - `journal_pdf` / `ads_scan` → PDF fetch + MinerU OCR ({@link arxivPdfDoc} /
 *   {@link adsScanDoc}).
 *
 * It only touches works whose chosen tier is `ready` (an adapter/fetcher exists)
 * and that don't already have a reader rendering. Each result reports the produced
 * `doc_id` and block count so a hollow page (old template, paywall) is visible.
 * After fetching, the caller rebuilds the library so the new docs link back to
 * their works via `doc_ids`.
 *
 * Port notes (bug-for-bug):
 * - The pipelines are the M2/M3 {@link IngestPipelines} port; `PipelineConfig()`
 *   is constructed per attempt in Python — the TS ports carry their own config,
 *   so the executor just calls them.
 * - Python stringifies exceptions with `str(e)` (the bare message); the port
 *   uses `e.message` for `Error`s to the same effect.
 * - Result dicts keep Python's key order and explicit `null`s
 *   (`sections`/`figures`/`refs` are present even when unknown).
 */

import type { Document } from "@argelanderspace/contracts";
import { pyOr } from "../documents/pyregex.js";
import { iterBlocks } from "../documents/traverse.js";
import type { LibraryStore, Work } from "../library/store.js";
import { adsScanDoc, arxivPdfDoc, type PdfFetchDeps } from "./fetch-pdf.js";
import type { IngestPipelines } from "./pipelines.js";

/** tiers the executor can fetch without MinerU (free, no OCR budget) */
export const FREE_TIERS: readonly string[] = ["journal_html", "arxiv_latex"];

/** One per-work outcome of a fetch pass (the Python result dicts). */
export type FetchResult = Record<string, unknown>;

function ingestFor(w: Work, pipelines: IngestPipelines): Promise<Document> {
  const tier = ((w.acquisition ?? {}) as Record<string, unknown>).chosen;
  if (tier === "journal_html") {
    if (!w.doi) throw new Error("journal_html chosen but work has no DOI");
    return pipelines.ingestHtml(w.doi);
  }
  if (tier === "arxiv_latex") {
    if (!w.arxiv_id) throw new Error("arxiv_latex chosen but work has no arXiv id");
    return pipelines.ingestLatex(w.arxiv_id);
  }
  const repr = typeof tier === "string" ? `'${tier}'` : "None";
  throw new Error(`tier ${repr} is not auto-fetchable here (needs Phase-3 OCR)`);
}

/** Python `str(e)`: the bare message for Error instances. */
function strOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Ingest full text for every ready, not-yet-ingested work in *tiers*. */
export async function fetchReadyFulltext(
  store: LibraryStore,
  deps: { pipelines: IngestPipelines; tiers?: readonly string[]; limit?: number | null }
): Promise<FetchResult[]> {
  const tiers = deps.tiers ?? FREE_TIERS;
  const limit = deps.limit ?? null;
  const results: FetchResult[] = [];
  let n = 0;
  for (const w of store.works) {
    const acq = (w.acquisition ?? {}) as Record<string, unknown>;
    if (acq.ingested_doc) continue;
    if (acq.status !== "ready" || !tiers.includes(acq.chosen as string)) continue;
    if (limit !== null && n >= limit) break;
    n += 1;
    const tier = acq.chosen as string;
    const loc = tier === "journal_html" ? w.doi : w.arxiv_id;
    try {
      const doc = await ingestFor(w, deps.pipelines);
      const blocks = [...iterBlocks(doc)].length;
      const stats = doc.stats ?? {};
      results.push({
        id: w.id,
        tier,
        loc,
        doc_id: doc.doc_id,
        blocks,
        ok: blocks > 0,
        title: ((pyOr(doc.meta?.title) as string | undefined) ?? "").slice(0, 48),
        sections: stats.n_sections ?? null,
        figures: stats.n_figures ?? null,
        refs: stats.n_references ?? null,
      });
    } catch (e) {
      // one failure must not abort the batch
      results.push({ id: w.id, tier, loc, ok: false, error: strOf(e).slice(0, 200) });
    }
  }
  return results;
}

/**
 * Fallback chain for pending works whose primary source failed/blocked:
 * free **arXiv LaTeX** → **arXiv PDF** (MinerU) → **ADS scan** (MinerU OCR).
 *
 * Used after {@link fetchReadyFulltext} for the stragglers (old-template
 * journal pages, AASTeX papers pandoc can't parse, legacy scans).
 */
export async function fetchRemaining(
  store: LibraryStore,
  deps: PdfFetchDeps & { skip?: Iterable<string>; limit?: number | null }
): Promise<FetchResult[]> {
  const skip = new Set(deps.skip ?? []);
  const limit = deps.limit ?? null;
  const results: FetchResult[] = [];
  let n = 0;
  for (const w of store.works) {
    const acq = (w.acquisition ?? {}) as Record<string, unknown>;
    if (acq.ingested_doc || skip.has(w.id)) continue;
    if (limit !== null && n >= limit) break;
    n += 1;
    let doc: Document | null = null;
    let via: string | null = null;
    const errs: string[] = [];
    const attempts: [string, () => Promise<Document>][] = [];
    if (w.arxiv_id) {
      const arxivId = w.arxiv_id;
      attempts.push(["arxiv_latex", () => deps.pipelines.ingestLatex(arxivId)]);
      attempts.push(["arxiv_pdf", () => arxivPdfDoc(w, deps)]);
    }
    if (w.bibcode) {
      attempts.push(["ads_scan", () => adsScanDoc(w, deps)]);
    }
    for (const [name, fn] of attempts) {
      try {
        doc = await fn();
        via = name;
        break;
      } catch (e) {
        errs.push(`${name}: ${strOf(e).slice(0, 90)}`);
      }
    }
    if (doc !== null) {
      const blocks = [...iterBlocks(doc)].length;
      results.push({
        id: w.id,
        via,
        doc_id: doc.doc_id,
        blocks,
        ok: blocks > 0,
        title: (w.title || "").slice(0, 46),
      });
    } else {
      results.push({
        id: w.id,
        ok: false,
        error: errs.join("; "),
        title: (w.title || "").slice(0, 46),
      });
    }
  }
  return results;
}
