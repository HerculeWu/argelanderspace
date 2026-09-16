/**
 * Citation-resolution chain: NASA-ADS ▸ Crossref ▸ OpenAlex(title-match)
 * (bibgraph/acquire/resolve.py).
 *
 * The user's resolution priority for a work's citation metadata:
 *
 *   1. NASA / ADS        — the astronomy gold standard (authoritative counts +
 *                          reference lists), token-gated; no-op without a token.
 *   2. Crossref          — keyless DOI metadata + `is-referenced-by-count` +
 *                          reference DOIs + publisher full-text links.
 *   3. OpenAlex (match)  — title/DOI match; the only source of the *OpenAlex ids*
 *                          the citation graph is built on (referenced_works).
 *
 * All three are consulted (OpenAlex always runs because the graph needs its ids),
 * but the **citation count** is taken from the first source in priority order that
 * supplies one, and every work records the provenance in `Work.resolution`::
 *
 *   {"count": "ads", "providers": ["ads","crossref","openalex"],
 *    "n_refs": {"ads": 56, "crossref": 60, "openalex": 58}, "links": 2}
 *
 * Port notes (bug-for-bug):
 * - The chain is `async` because the source ports are (Python was synchronous).
 * - The provenance dict's key order matches Python's (`providers`, `n_refs`,
 *   optional `links`, `count`).
 * - Python's `log.info` line is dropped.
 */

import { pyOr } from "../documents/pyregex.js";
import type { MetadataSources } from "../library/sources.js";
import { arxivFromDoi, type Work } from "../library/store.js";
import { classify } from "./planner.js";

/** The `Work.resolution` provenance record. */
export interface ResolutionProvenance {
  providers: string[];
  n_refs: Record<string, number>;
  links?: number;
  count: string | null;
}

/** Fill only blank scalar fields (earlier, higher-priority sources win). */
function fill(
  w: Work,
  vals: {
    title?: string;
    year?: number | null;
    venue?: string | null;
    authors?: string[];
    abstract?: string | null;
  }
): void {
  // title: ingested/bib works always carry one, so this only ever fills the
  // blank title of a manually created stub (Stage 13) — first source in the
  // resolution priority order that supplies one wins.
  if (!w.title && vals.title) w.title = vals.title;
  if (w.year === null && vals.year) w.year = vals.year;
  if (!w.venue && vals.venue) w.venue = vals.venue;
  if (w.authors.length === 0 && vals.authors && vals.authors.length > 0) {
    w.authors = [...vals.authors];
  }
  if (!w.abstract && vals.abstract) w.abstract = vals.abstract;
}

/**
 * Adopt a resolved DOI — but route an arXiv DataCite DOI to `arxiv_id`
 * instead of `doi` so it never poses as a journal DOI.
 */
function acceptDoi(w: Work, doi: string | null | undefined): void {
  if (!doi) return;
  const aid = arxivFromDoi(doi);
  if (aid) {
    w.arxiv_id = w.arxiv_id || aid;
    return;
  }
  if (!w.doi) w.doi = doi;
}

/** Resolve one work's citation metadata through the chain. Mutates *w*. */
export async function resolveWork(
  w: Work,
  sources: MetadataSources
): Promise<ResolutionProvenance> {
  // Built in Python's insertion order: providers, n_refs, [links], count.
  const prov: Record<string, unknown> = {
    providers: [] as string[],
    n_refs: {} as Record<string, number>,
  };
  const providers = prov.providers as string[];
  const nRefs = prov.n_refs as Record<string, number>;
  let count: number | null = null;
  let countSrc: string | null = null;

  // Scrub a previously-stored arXiv DOI masquerading as a journal DOI (makes
  // re-runs over an older library.json idempotent).
  const stale = arxivFromDoi(w.doi);
  if (stale) {
    w.arxiv_id = w.arxiv_id || stale;
    w.doi = null;
  }

  // 1) NASA / ADS — authoritative astro counts + reference list (bibcodes).
  const a = await sources.ads.resolve({ doi: w.doi, arxiv: w.arxiv_id, title: w.title });
  if (a) {
    providers.push("ads");
    w.bibcode = (pyOr(w.bibcode, a.bibcode) as string | undefined) ?? null;
    acceptDoi(w, a.doi);
    fill(w, {
      title: a.title,
      year: a.year,
      venue: a.venue,
      authors: a.authors,
      abstract: a.abstract,
    });
    if (a.citation_count !== null && a.citation_count !== undefined) {
      count = a.citation_count;
      countSrc = "ads";
    }
    if (a.references && a.references.length > 0) {
      nRefs.ads = a.references.length;
    }
  }

  // 2) Crossref — DOI metadata, count, reference DOIs, publisher full-text links.
  //    Pass the expected publisher prefixes so a title-only search can't match
  //    a different journal's record (false positives corrupt identity + graph).
  const [epub] = classify(null, w.journal || w.venue);
  const c = await sources.crossref.resolve({
    doi: w.doi,
    title: w.title,
    year: w.year,
    journal: w.journal || w.venue,
    firstAuthor: w.authors.length > 0 ? w.authors[0] : null,
    expectPrefixes: epub ? epub.doiPrefixes : [],
  });
  if (c) {
    providers.push("crossref");
    acceptDoi(w, c.doi);
    fill(w, {
      title: c.title,
      year: c.year,
      venue: c.venue,
      authors: c.authors,
      abstract: c.abstract,
    });
    if (c.type === "conf" && w.type === "article") w.type = "conf";
    if (count === null && c.cited_by_count !== null && c.cited_by_count !== undefined) {
      count = c.cited_by_count;
      countSrc = "crossref";
    }
    if (c.reference_dois && c.reference_dois.length > 0) {
      nRefs.crossref = c.reference_dois.length;
    }
    if (c.links && c.links.length > 0) {
      prov.links = c.links.length;
    }
  }

  // 3) OpenAlex — always: it is the only source of the graph's referenced_works
  //    ids and a reliable last-resort count.
  const r = await sources.oa.resolve({
    doi: w.doi,
    arxiv: w.arxiv_id,
    title: w.title,
    year: w.year,
  });
  if (r) {
    providers.push("openalex");
    w.openalex_id = (pyOr(w.openalex_id, r.openalex_id) as string | undefined) ?? null;
    if (r.arxiv_id) {
      // recovered from OA locations
      w.arxiv_id = (pyOr(w.arxiv_id, r.arxiv_id) as string | undefined) ?? null;
    }
    acceptDoi(w, r.doi);
    fill(w, {
      title: r.title,
      year: r.year,
      venue: r.venue,
      authors: r.authors,
      abstract: r.abstract,
    });
    if (r.type && w.type === "article") w.type = r.type;
    if (r.referenced_works && r.referenced_works.length > 0) {
      w.referenced_works = r.referenced_works;
      nRefs.openalex = r.referenced_works.length;
    }
    if (count === null && r.cited_by_count !== null && r.cited_by_count !== undefined) {
      count = r.cited_by_count;
      countSrc = "openalex";
    }
  }

  if (count !== null) w.cited_by_count = count;
  prov.count = countSrc;
  w.resolution = prov;
  return prov as unknown as ResolutionProvenance;
}
