/**
 * Crossref client (`bibgraph/library/sources/crossref.py`): DOI metadata,
 * citation counts, reference lists, and publisher full-text links. Keyless;
 * the polite pool is joined with a `mailto` param + a descriptive User-Agent.
 *
 * The message normalizer is NOT here — it is test-pinned, so M1b put
 * `normalizeCrossref` in core (`library/sources.ts`). This module is the
 * cached/throttled HTTP client + the guarded title search.
 *
 * Parity: cache key `sha1(path + "?" + json.dumps(params, sort_keys=True))`
 * is byte-identical (lib/pyjson.ts); a 404 is cached as the
 * `{"__notfound__": true}` sentinel exactly like Python so misses aren't
 * re-fetched.
 */

import type { CrossrefResolution, CrossrefSource } from "@argelanderspace/core";
import { arxivFromDoi, normalizeCrossref, normDoi, normTitle } from "@argelanderspace/core";
import { type FetchImpl, fetchText, HttpError, sleep, withQuery } from "../lib/http.js";
import { pyJsonStable } from "../lib/pyjson.js";
import { SourceCache, sha1Hex } from "./cache.js";

const BASE = "https://api.crossref.org";
const TIMEOUT = 30;
const NOT_FOUND = { __notfound__: true };

function defaultMailto(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENALEX_MAILTO ?? "wuwenjiegogo@gmail.com";
}

export interface CrossrefClientOptions {
  cacheDir: string;
  delay?: number; // 0.15
  enabled?: boolean; // true
  mailto?: string; // default $OPENALEX_MAILTO or the Python default
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}

type Json = Record<string, unknown>;

export class CrossrefClient implements CrossrefSource {
  private readonly delay: number;
  private readonly enabled: boolean;
  private readonly mailto: string;
  private readonly userAgent: string;
  private readonly cache: SourceCache;
  private readonly fetchImpl: FetchImpl;
  private readonly log?: (msg: string) => void;

  constructor(opts: CrossrefClientOptions) {
    this.delay = opts.delay ?? 0.15;
    this.enabled = opts.enabled ?? true;
    this.mailto = opts.mailto ?? defaultMailto();
    // Descriptive UA for the polite pool (renamed from the Python
    // `HubbleSpace/0.1` in Stage 7 MS1).
    this.userAgent = `ArgelanderSpace/0.1 (https://github.com/; mailto:${this.mailto})`;
    this.cache = new SourceCache(opts.cacheDir);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  /** `Crossref._get`: disk-cached GET; null on any network/parse failure. */
  private async get(
    path: string,
    params: Record<string, string | number> = {}
  ): Promise<Json | null> {
    const withMailto: Record<string, string | number> = { ...params, mailto: this.mailto };
    const key = sha1Hex(`${path}?${pyJsonStable(withMailto)}`);
    const hit = this.cache.read(key);
    if (hit !== undefined) return hit as Json;
    if (!this.enabled) return null;
    try {
      await sleep(this.delay); // Python: fixed sleep, not a throttle
      const { text } = await fetchText(this.fetchImpl, withQuery(BASE + path, withMailto), {
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
      this.log?.(`crossref GET ${path} failed: ${String(e)}`);
      return null;
    }
  }

  /** `Crossref.resolve(doi=, title=, year=, journal=, first_author=, expect_prefixes=)`. */
  async resolve(query: {
    doi?: string | null;
    title?: string | null;
    year?: number | null;
    journal?: string | null;
    firstAuthor?: string | null;
    expectPrefixes?: readonly string[];
  }): Promise<CrossrefResolution | null> {
    const d = normDoi(query.doi);
    if (d) {
      const w = await this.get(`/works/${d}`);
      if (w && !w.__notfound__) {
        const msg = w.message as Json | undefined;
        if (msg) return normalizeCrossref(msg);
      }
    }
    return this.search(
      query.title ?? null,
      query.year ?? null,
      query.firstAuthor ?? null,
      query.expectPrefixes ?? []
    );
  }

  /**
   * `Crossref._search` — title-only search, biased hard toward returning
   * nothing over a wrong record: near-exact title, compatible year, expected
   * publisher prefix (when known), first author present.
   */
  private async search(
    title: string | null,
    year: number | null,
    firstAuthor: string | null,
    expectPrefixes: readonly string[]
  ): Promise<CrossrefResolution | null> {
    if (!title) return null;
    const data = await this.get("/works", {
      "query.bibliographic": title,
      rows: 5,
      select:
        "DOI,title,author,container-title,issued,published-print,type," +
        "is-referenced-by-count,references-count",
    });
    const items = ((data?.message as Json | undefined)?.items as Json[] | undefined) ?? [];
    const want = normTitle(title);
    const fa = firstAuthor ? normTitle(firstAuthor) : null;
    let best: CrossrefResolution | null = null;
    let bestScore = 0.0;
    for (const it of items) {
      const n = normalizeCrossref(it);
      const nt = normTitle(n.title);
      if (!nt) continue;
      const ov = overlap(want, nt);
      const substr =
        (want.includes(nt) || nt.includes(want)) && Math.min(pyLen(want), pyLen(nt)) >= 20;
      if (!(nt === want || ov >= 0.85 || substr)) continue;
      if (year && n.year && Math.abs(n.year - year) > 1) continue;
      // publisher gate: a title hit into a *different* journal is a false positive
      const nd = (n.doi ?? "").toLowerCase();
      if (expectPrefixes.length > 0 && nd && !arxivFromDoi(nd)) {
        if (!expectPrefixes.some((p) => nd.startsWith(p))) continue;
      }
      // the first author's surname must appear among the matched authors
      if (fa && n.authors.length > 0) {
        const ok = n.authors.some((au) => {
          const na = normTitle(au);
          return fa.includes(na) || na.includes(fa);
        });
        if (!ok) continue;
      }
      let score = nt === want ? 1.0 : ov;
      if (year && n.year) score -= Math.min(3, Math.abs(n.year - year)) * 0.05;
      if (score > bestScore) {
        best = n;
        bestScore = score;
      }
    }
    return best;
  }
}

/** `_overlap`: token Jaccard over whitespace-split sets. */
function overlap(a: string, b: string): number {
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
