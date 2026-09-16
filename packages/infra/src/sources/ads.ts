/**
 * NASA ADS client (`bibgraph/library/sources/ads.py`): authoritative astronomy
 * citation metrics, token-gated. Without a valid token the client degrades to
 * a no-op (`status` records why) so the rest of the library keeps working.
 *
 * Token: `$ADS_DEV_KEY`, else config `ads_dev_key`, else `~/.ads/dev_key`.
 *
 * Parity notes:
 * - The disk cache key is `sha1(query-string)`, byte-identical to Python.
 * - Python's `time.sleep(delay)` before each request is a fixed sleep, not a
 *   since-last-request throttle — reproduced exactly.
 * - requests sends no explicit User-Agent here (its default); undici sends
 *   `undici`/`node`. ADS keys auth off the Authorization header only.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AdsResolution, AdsSource, AdsStatus } from "@argelanderspace/core";
import { normDoi, normTitle } from "@argelanderspace/core";
import { type AppConfig, getConfig } from "../config.js";
import { type FetchImpl, fetchText, HttpError, sleep, withQuery } from "../lib/http.js";
import { SourceCache, sha1Hex } from "./cache.js";

const BASE = "https://api.adsabs.harvard.edu/v1/search/query";
const EXPORT_BASE = "https://ui.adsabs.harvard.edu/v1/export/bibtex";
const FL = "bibcode,title,author,year,citation_count,pub,doi,abstract,reference";
const TIMEOUT = 30;

/** `_read_token`: `$ADS_DEV_KEY`, else config `ads_dev_key`, else `~/.ads/dev_key` — stripped. */
export function readAdsToken(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  config: AppConfig = getConfig()
): string | null {
  const tok = env.ADS_DEV_KEY;
  if (tok?.trim()) return tok.trim();
  const fromConfig = config.ads_dev_key?.trim();
  if (fromConfig) return fromConfig;
  try {
    return readFileSync(join(home, ".ads", "dev_key"), "utf-8").trim() || null;
  } catch {
    return null;
  }
}

export interface AdsClientOptions {
  /** Disk cache dir (Python `CACHE_DIR / "ads"` = `<dataDir>/library/cache/ads`). */
  cacheDir: string;
  /** Explicit token override; defaults to {@link readAdsToken}. */
  token?: string | null;
  /** Fixed pre-request sleep in seconds (Python default 0.25). */
  delay?: number;
  /** false = disk cache only, no network (mirrors CrossrefClient.enabled). */
  enabled?: boolean;
  fetchImpl?: FetchImpl;
  log?: (msg: string) => void;
}

/** `ADS.normalize(doc)` — authoritative astro counts + reference bibcodes. */
export function normalizeAdsDoc(doc: Record<string, unknown>): AdsResolution {
  const rawAuthors = Array.isArray(doc.author) ? doc.author : [];
  const authors = rawAuthors.map(
    (a) =>
      String(a ?? "")
        .split(",")[0]
        ?.trim() ?? ""
  );
  const rawTitle = doc.title || [""]; // Python `or`: ""/[] fall through to [""]
  const title = Array.isArray(rawTitle)
    ? ((rawTitle[0] as string | undefined) ?? "")
    : (rawTitle as string);
  const rawDoi = Array.isArray(doc.doi) ? doc.doi[0] : null;
  let year: number | null = null;
  if (doc.year) {
    // int(doc["year"]) — truncation toward zero like Python's int().
    const y =
      typeof doc.year === "number" ? Math.trunc(doc.year) : Number.parseInt(String(doc.year), 10);
    year = Number.isNaN(y) ? null : y;
  }
  return {
    bibcode: (doc.bibcode as string | undefined) ?? null,
    doi: normDoi(typeof rawDoi === "string" ? rawDoi : null),
    title,
    authors,
    year,
    venue: (doc.pub as string | undefined) ?? null,
    citation_count: typeof doc.citation_count === "number" ? doc.citation_count : null,
    abstract: (doc.abstract as string | undefined) ?? null,
    references: Array.isArray(doc.reference) ? (doc.reference as string[]) : [],
  };
}

export class AdsClient implements AdsSource {
  readonly token: string | null;
  status: AdsStatus;
  private readonly delay: number;
  private readonly enabled: boolean;
  private readonly cache: SourceCache;
  private readonly fetchImpl: FetchImpl;
  private readonly log?: (msg: string) => void;

  constructor(opts: AdsClientOptions) {
    this.token = opts.token !== undefined ? opts.token : readAdsToken();
    this.delay = opts.delay ?? 0.25;
    this.enabled = opts.enabled ?? true;
    this.status = this.token ? "ok" : "no-token";
    this.cache = new SourceCache(opts.cacheDir);
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  /** `ADS._query`: disk-cached search; null when disabled/failed. */
  private async query(q: string): Promise<Array<Record<string, unknown>> | null> {
    const key = sha1Hex(q);
    const hit = this.cache.read(key);
    if (hit !== undefined) return hit as Array<Record<string, unknown>>;
    if (!this.token || this.status !== "ok" || !this.enabled) return null;
    try {
      await sleep(this.delay); // Python: fixed sleep, not a throttle
      const { text } = await fetchText(this.fetchImpl, withQuery(BASE, { q, fl: FL, rows: 1 }), {
        headers: { Authorization: `Bearer ${this.token}` },
        timeout: TIMEOUT,
      });
      const docs = ((JSON.parse(text) as { response?: { docs?: unknown[] } }).response?.docs ??
        []) as Array<Record<string, unknown>>;
      this.cache.write(key, docs);
      return docs;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        this.status = "unauthorized";
        this.log?.(`ADS token rejected (${e.status}) — ADS enrichment disabled`);
        return null;
      }
      this.status = "error";
      this.log?.(`ADS query failed: ${String(e)}`);
      return null;
    }
  }

  /** `ADS.resolve(doi=, arxiv=, title=)`. */
  async resolve(query: {
    doi?: string | null;
    arxiv?: string | null;
    title?: string | null;
  }): Promise<AdsResolution | null> {
    const d = normDoi(query.doi);
    if (d) {
      const docs = await this.query(`doi:${d}`);
      if (docs?.[0]) return normalizeAdsDoc(docs[0]);
    }
    if (query.arxiv) {
      const docs = await this.query(`arxiv:${query.arxiv}`);
      if (docs?.[0]) return normalizeAdsDoc(docs[0]);
    }
    if (query.title) {
      const safe = query.title.replaceAll('"', " ");
      const docs = await this.query(`title:"${safe}"`);
      if (docs?.[0]) {
        const n = normalizeAdsDoc(docs[0]);
        // the title query is fuzzy — confirm it really is the same paper
        if (titleMatches(query.title, n.title)) return n;
      }
    }
    return null;
  }

  /**
   * ADS BibTeX export (Stage 12): one batched POST for all bibcodes; returns
   * the raw multi-entry export text (parsing happens in core, which owns the
   * BibTeX parser dependency). null when disabled/offline/failed — callers
   * keep the generated fallback and retry on the next build.
   */
  async exportBibtex(bibcodes: readonly string[]): Promise<string | null> {
    if (!bibcodes.length) return null;
    if (!this.token || this.status !== "ok" || !this.enabled) return null;
    try {
      await sleep(this.delay);
      const { text } = await fetchText(this.fetchImpl, EXPORT_BASE, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ bibcode: [...bibcodes] }),
        timeout: TIMEOUT,
      });
      const out = (JSON.parse(text) as { export?: string }).export;
      return typeof out === "string" && out.trim() ? out : null;
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        this.status = "unauthorized";
        this.log?.(`ADS token rejected (${e.status}) — ADS enrichment disabled`);
        return null;
      }
      this.status = "error";
      this.log?.(`ADS bibtex export failed: ${String(e)}`);
      return null;
    }
  }
}

/** `_title_matches`: normalized equality or ≥0.7 token Jaccard. */
export function titleMatches(a: string, b: string): boolean {
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const sa = new Set(pySplit(na));
  const sb = new Set(pySplit(nb));
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  return inter / (sa.size + sb.size - inter) >= 0.7;
}

/** Python `str.split()` — whitespace runs, no empty tokens. */
function pySplit(s: string): string[] {
  return s.split(/\s+/u).filter((t) => t !== "");
}
