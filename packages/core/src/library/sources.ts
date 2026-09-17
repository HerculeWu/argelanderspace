/**
 * Port interfaces for the citation-metadata sources (bibgraph/library/sources/
 * {ads,crossref,openalex}.py) — the `MetadataSource` seam between core and infra.
 *
 * The three HTTP clients themselves are M2 (packages/infra): disk-cached,
 * throttled, token/key-aware wrappers around the ADS / Crossref / OpenAlex APIs.
 * What core owns here is (a) the *shape* of the normalized records the clients
 * return (snake_case, identical to the Python dicts — the resolution chain and
 * the graph consume these keys) and (b) the pure `normalizeCrossref` message
 * normalizer, ported because `tests/run_tests.py::test_crossref_normalize`
 * pins it. The ADS / OpenAlex normalizers stay with their M2 clients (no test
 * pins them).
 *
 * All network methods return Promises: the Python clients are synchronous
 * (`requests`), but the M2 TS implementations sit on native `fetch` (decision:
 * 原生 fetch 自封装重试/节流/缓存), so the port is async end-to-end.
 */

import { pyOr } from "../documents/pyregex.js";
import { normDoi } from "./store.js";

// --------------------------------------------------------------------------- //
// Normalized records (the Python dict shapes, verbatim)
// --------------------------------------------------------------------------- //

/** `ADS.normalize(doc)` — authoritative astro counts + reference list (bibcodes). */
export interface AdsResolution {
  bibcode: string | null;
  doi: string | null;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  citation_count: number | null;
  abstract: string | null;
  /** bibcodes this work cites */
  references: string[];
}

/** One publisher full-text link (`Crossref.normalize` `links` items). */
export interface CrossrefLink {
  url: string;
  content_type: string;
  intended: string;
}

/** `Crossref.normalize(w)` — DOI metadata, count, reference DOIs, full-text links. */
export interface CrossrefResolution {
  doi: string | null;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  /** article | conf */
  type: string;
  cited_by_count: number | null;
  reference_dois: string[];
  n_references: number;
  abstract: string | null;
  resource_url: string | null;
  links: CrossrefLink[];
}

/** `OpenAlex.normalize(w)` — the graph's ids + last-resort count. */
export interface OpenAlexResolution {
  openalex_id: string | null;
  doi: string | null;
  title: string;
  authors: string[];
  year: number | null;
  venue: string | null;
  /** article | conf */
  type: string;
  cited_by_count: number | null;
  /** openalex short ids this work cites */
  referenced_works: string[];
  abstract: string | null;
  arxiv_id: string | null;
}

// --------------------------------------------------------------------------- //
// Source ports
// --------------------------------------------------------------------------- //

/** `ADS.status` — token health; `"ok" | "no-token" | "unauthorized" | "error"`. */
export type AdsStatus = "ok" | "no-token" | "unauthorized" | "error";

/** NASA ADS client (token-gated; degrades to a no-op without a valid token). */
export interface AdsSource {
  readonly status: AdsStatus;
  /** `ADS.resolve(doi=, arxiv=, title=)`; null when disabled / no match. */
  resolve(query: {
    doi?: string | null;
    arxiv?: string | null;
    title?: string | null;
  }): Promise<AdsResolution | null>;
  /**
   * ADS BibTeX export (Stage 12): one batched POST → the raw multi-entry
   * export text (parsing happens in core, which owns the BibTeX parser
   * dependency). null when disabled/offline/failed — callers keep the
   * generated fallback and retry on the next build.
   */
  exportBibtex(bibcodes: readonly string[]): Promise<string | null>;
}

/** Crossref client (keyless; DOI lookup then guarded title search). */
export interface CrossrefSource {
  /**
   * `Crossref.resolve(doi=, title=, year=, journal=, first_author=,
   * expect_prefixes=)`. `expectPrefixes` carries the expected publisher DOI
   * prefixes so a title-only search can't match a different journal's record.
   */
  resolve(query: {
    doi?: string | null;
    title?: string | null;
    year?: number | null;
    journal?: string | null;
    firstAuthor?: string | null;
    expectPrefixes?: readonly string[];
  }): Promise<CrossrefResolution | null>;
}

/** OpenAlex client (keyless; resolve by DOI/title + batch metadata fetch). */
export interface OpenAlexSource {
  /** `OpenAlex.resolve(doi=, arxiv=, title=, year=)`. */
  resolve(query: {
    doi?: string | null;
    arxiv?: string | null;
    title?: string | null;
    year?: number | null;
  }): Promise<OpenAlexResolution | null>;
}

/** The three sources the resolution chain consults, in priority order. */
export interface MetadataSources {
  ads: AdsSource;
  crossref: CrossrefSource;
  oa: OpenAlexSource;
}

// --------------------------------------------------------------------------- //
// Crossref message normalization (Crossref.normalize — pure, test-pinned)
// --------------------------------------------------------------------------- //

/** `_strip_jats`: JATS/XML abstract → plain text, capped at 2500 chars. */
export function stripJats(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = s
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2500);
  return out || null;
}

/** `Crossref.normalize(w)` — a raw Crossref API work message → normalized record. */
export function normalizeCrossref(w: Record<string, unknown>): CrossrefResolution {
  let title: unknown = pyOr(w.title, [""]);
  title = Array.isArray(title) && title.length > 0 ? title[0] : (pyOr(title) ?? "");
  let venue: unknown = pyOr(w["container-title"], []);
  venue = Array.isArray(venue) && venue.length > 0 ? venue[0] : (pyOr(venue) ?? null);
  const authors: string[] = [];
  const rawAuthors = Array.isArray(w.author) ? w.author : [];
  for (const a of rawAuthors) {
    const rec = (a ?? {}) as Record<string, unknown>;
    const fam = pyOr(rec.family, rec.name);
    if (fam) authors.push(fam as string);
  }
  let year: number | null = null;
  for (const k of ["published-print", "published-online", "published", "issued", "created"]) {
    const dated = (pyOr(w[k]) ?? {}) as Record<string, unknown>;
    const parts = (pyOr(dated["date-parts"]) ?? [[null]]) as unknown[][];
    const first = parts[0];
    if (parts.length > 0 && Array.isArray(first) && first.length > 0 && first[0]) {
      year = first[0] as number;
      break;
    }
  }
  const refDois: string[] = [];
  const rawRefs = Array.isArray(w.reference) ? w.reference : [];
  for (const r of rawRefs) {
    const d = normDoi((r as Record<string, unknown> | null)?.DOI as string | null);
    if (d) refDois.push(d);
  }
  const ctype = (pyOr(w.type) ?? "journal-article") as string;
  const kind = ctype.includes("proceedings") ? "conf" : "article";
  // full-text links: publisher HTML / PDF (intended-application=text-mining)
  const links: CrossrefLink[] = [];
  const rawLinks = Array.isArray(w.link) ? w.link : [];
  for (const ln of rawLinks) {
    const rec = (ln ?? {}) as Record<string, unknown>;
    const url = rec.URL;
    if (url) {
      links.push({
        url: url as string,
        content_type: (pyOr(rec["content-type"]) ?? "") as string,
        intended: (pyOr(rec["intended-application"]) ?? "") as string,
      });
    }
  }
  const resource = (pyOr(w.resource) ?? {}) as Record<string, unknown>;
  const primary = (pyOr(resource.primary) ?? {}) as Record<string, unknown>;
  return {
    doi: normDoi(w.DOI as string | null),
    title: title as string,
    authors,
    year,
    venue: venue as string | null,
    type: kind,
    cited_by_count:
      typeof w["is-referenced-by-count"] === "number" ? w["is-referenced-by-count"] : null,
    reference_dois: refDois,
    n_references: (pyOr(w["references-count"]) ?? refDois.length) as number,
    abstract: stripJats(w.abstract as string | null),
    resource_url: (primary.URL as string | undefined) ?? null,
    links,
  };
}
