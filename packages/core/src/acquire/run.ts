/**
 * Glue the acquisition layer onto the library store (bibgraph/acquire/run.py).
 *
 * - {@link addBibRecords} — turn parsed `.bib` entries into library works
 *   (upserted, so they merge with already-ingested papers by DOI/arXiv/title).
 * - {@link enrichAndPlan} — run every work through the resolution chain
 *   (ADS▸Crossref▸OpenAlex) and the source planner, stamping `Work.resolution`
 *   and `Work.acquisition`.
 *
 * The top-level `acquireReferences` orchestration (load → seed → add bib →
 * enrich+plan → graph → save) lives in `library/build.ts` so it can reuse the
 * store's paths and graph cache.
 *
 * Port note: {@link enrichAndPlan} is async because the source ports are
 * (Python was synchronous); `log.info` lines are not ported.
 */

import { pyOr } from "../documents/pyregex.js";
import { citeKey } from "../library/graph.js";
import type { MetadataSources } from "../library/sources.js";
import { canonicalId, emptyWork, type LibraryStore, type Work } from "../library/store.js";
import type { BibRecord } from "./bibtex.js";
import { isConf } from "./bibtex.js";
import { type AcquisitionPlan, classify, planSources, planToDict } from "./planner.js";
import { resolveWork } from "./resolve.js";

/** Build a library {@link Work} from one parsed `.bib` entry. */
export function workFromBibrecord(rec: BibRecord): Work {
  const [, label] = classify(rec.doi, rec.journal);
  const venue = (pyOr(label, rec.journal) as string | undefined) ?? null;
  return {
    ...emptyWork(
      canonicalId({ doi: rec.doi, arxiv: rec.arxivId, title: rec.title, year: rec.year })
    ),
    title: rec.title,
    authors: [...rec.authors],
    year: rec.year,
    venue,
    journal: (pyOr(label) as string | undefined) ?? null,
    type: isConf(rec) ? "conf" : "article",
    doi: rec.doi,
    arxiv_id: rec.arxivId,
    origin: "bib",
  };
}

/** Upsert each record (merges with existing works on shared identity keys). */
export function addBibRecords(store: LibraryStore, records: readonly BibRecord[]): Work[] {
  const out: Work[] = [];
  for (const rec of records) {
    out.push(store.upsert(workFromBibrecord(rec)));
  }
  return out;
}

/** Compute the acquisition plan for a (resolved) work. */
export function planFor(w: Work): AcquisitionPlan {
  return planSources({
    doi: w.doi,
    arxivId: w.arxiv_id,
    bibcode: w.bibcode,
    title: w.title,
    year: w.year,
    journal: w.journal,
    venue: w.venue,
  });
}

/** Resolve metadata + compute the source plan for every saved work. */
export async function enrichAndPlan(
  store: LibraryStore,
  sources: MetadataSources
): Promise<LibraryStore> {
  // cite_key is assign-only (Stage 7 MS1): an existing user-visible key is
  // never rewritten; new works are assigned keys that avoid every key
  // already in the store.
  const usedKeys = new Set<string>();
  for (const w of store.works) {
    if (w.cite_key) usedKeys.add(w.cite_key);
  }
  for (const w of store.works) {
    await resolveWork(w, sources);
    // backfill the short journal label now that resolution may have found a
    // DOI (e.g. an arXiv-only ApJS work gains its 10.3847 DOI → "ApJS").
    const [pub, label] = classify(w.doi, w.journal || w.venue);
    if (pub && label && !w.journal) w.journal = label;
    if (!w.cite_key) w.cite_key = citeKey(w, usedKeys);
    const acq = planToDict(planFor(w));
    if (w.doc_ids.length > 0) {
      // already has a reader rendering
      acq.ingested_doc = w.doc_ids[0];
    }
    w.acquisition = acq;
  }
  return store;
}
