/**
 * Acquisition executor: fetch full text for ready works per their plan
 * (bibgraph/acquire/execute.py).
 *
 * The planner decided *where* to read each paper; the executor *does* it,
 * routing each ready work to the matching ingestion pipeline. On main the only
 * auto-fetchable tier is `arxiv_latex` → `ingestLatex` (arXiv id → e-print
 * LaTeX → reader Document); the PDF/OCR tiers (`arxiv_pdf`, `ads_scan`) and
 * publisher HTML left with the `ocr-features` branch.
 *
 * It only touches works whose chosen tier is `ready` and that don't already
 * have a reader rendering. Each result reports the produced `doc_id` and block
 * count so a hollow page is visible. After fetching, the caller rebuilds the
 * library so the new docs link back to their works via `doc_ids`.
 *
 * Port notes (bug-for-bug):
 * - The pipeline is the {@link IngestPipelines} port; `PipelineConfig()` is
 *   constructed per attempt in Python — the TS port carries its own config,
 *   so the executor just calls it.
 * - Python stringifies exceptions with `str(e)` (the bare message); the port
 *   uses `e.message` for `Error`s to the same effect.
 * - Result dicts keep Python's key order and explicit `null`s
 *   (`sections`/`figures`/`refs` are present even when unknown).
 */

import type { Document } from "@argelanderspace/contracts";
import { pyOr } from "../documents/pyregex.js";
import { iterBlocks } from "../documents/traverse.js";
import type { LibraryStore, Work } from "../library/store.js";
import type { IngestPipelines } from "./pipelines.js";

/** tiers the executor can fetch automatically */
export const FREE_TIERS: readonly string[] = ["arxiv_latex"];

/** One per-work outcome of a fetch pass (the Python result dicts). */
export type FetchResult = Record<string, unknown>;

function ingestFor(w: Work, pipelines: IngestPipelines): Promise<Document> {
  const tier = ((w.acquisition ?? {}) as Record<string, unknown>).chosen;
  if (tier === "arxiv_latex") {
    if (!w.arxiv_id) throw new Error("arxiv_latex chosen but work has no arXiv id");
    return pipelines.ingestLatex(w.arxiv_id);
  }
  const repr = typeof tier === "string" ? `'${tier}'` : "None";
  throw new Error(`tier ${repr} is not auto-fetchable (main ingests arXiv LaTeX only)`);
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
    const loc = w.arxiv_id;
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
 * Fallback for pending works whose planned source failed/blocked: retry via
 * free **arXiv LaTeX** (the only auto-fetchable tier on main; the arXiv-PDF /
 * ADS-scan rungs of the Python chain are archived on `ocr-features`).
 *
 * Used after {@link fetchReadyFulltext} for the stragglers (works whose plan
 * never marked an arXiv tier ready).
 */
export async function fetchRemaining(
  store: LibraryStore,
  deps: { pipelines: IngestPipelines; skip?: Iterable<string>; limit?: number | null }
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
    let err: string | null = null;
    if (w.arxiv_id) {
      try {
        doc = await deps.pipelines.ingestLatex(w.arxiv_id);
        via = "arxiv_latex";
      } catch (e) {
        err = `arxiv_latex: ${strOf(e).slice(0, 90)}`;
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
        error: err ?? "no arXiv id",
        title: (w.title || "").slice(0, 46),
      });
    }
  }
  return results;
}
