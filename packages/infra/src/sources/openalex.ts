/**
 * OpenAlex client (`bibgraph/library/sources/openalex.py`): resolve a work,
 * fetch metadata in batches, disk-cached. Free; the polite pool via a contact
 * email (config `contact_email`, desktop-app ticket 11) in the `mailto` param
 * and the User-Agent — without one, no address is sent at all (there is no
 * default address and no environment variable).
 *
 * Deliberate divergence (approved): when `$OPENALEX_API_KEY` (or the config
 * file's `openalex_api_key`, decision 23) is set it is sent
 * as the `api_key` query param on every request — the Python client ignores
 * the key entirely (OpenAlex's premium pool needs it). The key is NOT part of
 * the disk-cache key: the response content is key-independent. Nor is the
 * contact email (since desktop-app ticket 11); entries keyed the old way, with
 * the `mailto` param, are still found through the legacy-key fallback
 * (`readKeyed` in cache.ts, user decision 2026-10-14).
 *
 * Resolution gotcha (from the Python docstring, preserved): an arXiv-DOI
 * lookup returns a bare stub (cited_by 0, no references) — the *published*
 * record is found by title search. So DOI lookup is used for journal DOIs,
 * title+year search otherwise, arXiv preprint stub as last resort.
 */

import type { OpenAlexResolution, OpenAlexSource } from "@argelanderspace/core";
import { normArxiv, normDoi, normTitle } from "@argelanderspace/core";
import { type AppConfig, getConfig, readContactEmail } from "../config.js";
import { type FetchImpl, fetchText, HttpError, sleep, withQuery } from "../lib/http.js";
import { readKeyed, SourceCache } from "./cache.js";

const BASE = "https://api.openalex.org";
const TIMEOUT = 30;
const NOT_FOUND = { __notfound__: true };
const ARXIV_LOC_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i;

type Json = Record<string, unknown>;

/**
 * The API key: `$OPENALEX_API_KEY`, else config `openalex_api_key`, else none. `config` defaults to the strict reading
 * (the commands); the server hands in its lenient reading.
 */
export function readOpenAlexApiKey(
  env: NodeJS.ProcessEnv = process.env,
  config?: AppConfig
): string | null {
  return env.OPENALEX_API_KEY ?? (config ?? getConfig()).openalex_api_key ?? null;
}

/** The User-Agent of the requests: the address is in it only when there is one. */
export function openAlexUserAgent(mailto: string | null): string {
  return mailto === null ? "ArgelanderSpace/0.1" : `ArgelanderSpace/0.1 (mailto:${mailto})`;
}

/** `_short_id`: "https://openalex.org/W123" → "W123". */
function shortId(oid: string | null | undefined): string | null {
  if (!oid) return null;
  return oid.split("/").pop() ?? null;
}

/** `_reconstruct_abstract`: inverted index → plain text, capped at 2500 chars. */
function reconstructAbstract(inv: unknown): string | null {
  if (!inv || typeof inv !== "object") return null;
  const pos = new Map<number, string>();
  for (const [word, idxs] of Object.entries(inv as Record<string, unknown>)) {
    if (!Array.isArray(idxs)) continue;
    for (const i of idxs) {
      if (typeof i === "number") pos.set(i, word);
    }
  }
  if (pos.size === 0) return null;
  const out = [...pos.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, w]) => w)
    .join(" ");
  return out.slice(0, 2500) || null;
}

/** `OpenAlex._arxiv_from_locations`: recover the arXiv id from any hosting location. */
function arxivFromLocations(w: Json): string | null {
  const locations = Array.isArray(w.locations) ? (w.locations as Json[]) : [];
  for (const loc of locations) {
    for (const u of [loc.landing_page_url, loc.pdf_url]) {
      const m = ARXIV_LOC_RE.exec(typeof u === "string" ? u : "");
      if (m?.[1]) return normArxiv(m[1]);
    }
  }
  return null;
}

/** `OpenAlex.normalize(w)` — the graph's ids + last-resort count. */
export function normalizeOpenAlex(w: Json): OpenAlexResolution {
  const primary = (w.primary_location ?? {}) as Json;
  const source = (primary.source ?? {}) as Json;
  const oaType = (w.type as string | undefined) || "article"; // Python `or`: "" → "article"
  const kind =
    oaType === "proceedings-article" || oaType === "proceedings" || oaType === "book-chapter"
      ? "conf"
      : "article";
  const authors: string[] = [];
  const authorships = Array.isArray(w.authorships) ? (w.authorships as Json[]) : [];
  for (const a of authorships) {
    const author = (a.author ?? {}) as Json;
    const display = author.display_name;
    if (typeof display === "string" && display !== "") {
      // Python `display_name.split()[-1]` — whitespace-run split; a
      // whitespace-only name would IndexError in Python, defended to "" here.
      authors.push(display.split(/\s+/u).filter(Boolean).pop() ?? "");
    }
  }
  const referenced = Array.isArray(w.referenced_works) ? w.referenced_works : [];
  return {
    openalex_id: shortId(w.id as string | undefined),
    doi: normDoi(w.doi as string | null),
    title: (w.display_name as string | undefined) || (w.title as string | undefined) || "",
    authors,
    year: typeof w.publication_year === "number" ? w.publication_year : null,
    venue: (source.display_name as string | undefined) ?? null,
    type: kind,
    cited_by_count: typeof w.cited_by_count === "number" ? w.cited_by_count : null,
    referenced_works: referenced.map((x) => shortId(x as string | undefined) ?? ""),
    abstract: reconstructAbstract(w.abstract_inverted_index),
    arxiv_id: arxivFromLocations(w),
  };
}

export interface OpenAlexClientOptions {
  cacheDir: string;
  delay?: number; // 0.12
  enabled?: boolean; // true
  /** The contact email; `null` sends none. Default: `readContactEmail()` (config `contact_email`, read strictly). */
  mailto?: string | null;
  /** Explicit key override; defaults to `$OPENALEX_API_KEY` (see divergence note). */
  apiKey?: string | null;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}

export class OpenAlexClient implements OpenAlexSource {
  private readonly delay: number;
  private readonly enabled: boolean;
  private readonly mailto: string | null;
  private readonly apiKey: string | null;
  private readonly userAgent: string;
  private readonly cache: SourceCache;
  private readonly fetchImpl: FetchImpl;
  private readonly log?: (msg: string) => void;

  constructor(opts: OpenAlexClientOptions) {
    this.delay = opts.delay ?? 0.12;
    this.enabled = opts.enabled ?? true;
    this.mailto = opts.mailto !== undefined ? opts.mailto : readContactEmail();
    this.apiKey = opts.apiKey !== undefined ? opts.apiKey : readOpenAlexApiKey();
    // Descriptive UA (renamed from the Python `HubbleSpace/0.1` in Stage 7 MS1).
    this.userAgent = openAlexUserAgent(this.mailto);
    this.cache = new SourceCache(opts.cacheDir);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  /**
   * `OpenAlex._get`: disk-cached GET. The cache key covers only the request's
   * own params; `mailto` and `api_key` go on the wire but not into the key
   * (with the legacy `mailto` key as a fallback, see cache.ts).
   */
  private async get(
    path: string,
    params: Record<string, string | number> = {}
  ): Promise<Json | null> {
    const { key, hit } = readKeyed(this.cache, path, params, this.mailto);
    if (hit !== undefined) return hit as Json;
    if (!this.enabled) return null;
    const wireParams: Record<string, string | number> = { ...params };
    if (this.mailto !== null) wireParams.mailto = this.mailto;
    if (this.apiKey) wireParams.api_key = this.apiKey;
    try {
      await sleep(this.delay); // Python: fixed sleep, not a throttle
      const { text } = await fetchText(this.fetchImpl, withQuery(BASE + path, wireParams), {
        headers: { "User-Agent": this.userAgent },
        timeout: TIMEOUT,
      });
      const data: Json = JSON.parse(text);
      this.cache.write(key, data);
      return data;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        this.cache.write(key, NOT_FOUND);
        return NOT_FOUND as Json;
      }
      this.log?.(`openalex GET ${path} failed: ${String(e)}`);
      return null;
    }
  }

  /** `OpenAlex.resolve(doi=, arxiv=, title=, year=)`. */
  async resolve(query: {
    doi?: string | null;
    arxiv?: string | null;
    title?: string | null;
    year?: number | null;
  }): Promise<OpenAlexResolution | null> {
    const d = normDoi(query.doi);
    if (d) {
      const w = await this.get(`/works/https://doi.org/${d}`);
      if (w && !w.__notfound__) {
        const norm = normalizeOpenAlex(w);
        // a journal DOI record is authoritative; use it
        if (norm.referenced_works.length > 0 || norm.cited_by_count) return norm;
        // otherwise fall through to title search for the enriched record
      }
    }
    const hit = await this.search(query.title ?? null, query.year ?? null);
    if (hit) return hit;
    // last resort: the arXiv preprint record (thin, but carries real ids)
    const a = normArxiv(query.arxiv);
    if (a) {
      const w = await this.get(`/works/https://doi.org/10.48550/arXiv.${a}`);
      if (w && !w.__notfound__) return normalizeOpenAlex(w);
    }
    return null;
  }

  /**
   * `OpenAlex._search`: title.search is tokenized; re-rank so the TITLE
   * itself must match well — the reference-count bonus is only a tiebreaker
   * and cannot rescue a weak title.
   */
  private async search(
    title: string | null,
    year: number | null
  ): Promise<OpenAlexResolution | null> {
    if (!title) return null;
    const data = await this.get("/works", {
      filter: `title.search:${title.replace(/[^A-Za-z0-9 ]/g, " ")}`,
      "per-page": 8,
    });
    const results = (data?.results as Json[] | undefined) ?? [];
    if (results.length === 0) return null;
    const want = normTitle(title);
    let best: OpenAlexResolution | null = null;
    let bestTotal = -1.0;
    for (const w of results) {
      const n = normalizeOpenAlex(w);
      const nt = normTitle(n.title);
      const ov = tokenOverlap(want, nt);
      let tscore: number;
      if (nt === want) tscore = 10.0;
      else if (
        (want.includes(nt) || nt.includes(want)) &&
        Math.min(pyLen(want), pyLen(nt)) >= 16 &&
        ov >= 0.6
      ) {
        tscore = 6.0;
      } else {
        tscore = ov * 6.0;
      }
      if (tscore < 5.0) continue; // the title itself must be a strong match
      let total = tscore;
      if (year && n.year) total -= Math.min(3, Math.abs(n.year - year)) * 0.5;
      total += Math.min(2.0, n.referenced_works.length / 30.0); // tiebreaker only
      if (total > bestTotal) {
        best = n;
        bestTotal = total;
      }
    }
    return best;
  }
}

/** `_token_overlap`: token Jaccard over whitespace-split sets. */
function tokenOverlap(a: string, b: string): number {
  const sa = new Set(a.split(/\s+/u).filter(Boolean));
  const sb = new Set(b.split(/\s+/u).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0.0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/** Python `len(str)` — code points, not UTF-16 units. */
function pyLen(s: string): number {
  return Array.from(s).length;
}
