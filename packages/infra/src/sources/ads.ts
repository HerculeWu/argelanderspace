/**
 * NASA ADS client (`bibgraph/library/sources/ads.py`): authoritative astronomy
 * citation metrics, token-gated. Without a valid token the client degrades to
 * a no-op (`status` records why) so the rest of the library keeps working.
 *
 * Token: the one saved in the workbench, in the credential store's `ads` purpose
 * (desktop-app ticket 12), read by the composition at each use and handed in.
 * `$ADS_DEV_KEY`, config `ads_dev_key` and `~/.ads/dev_key` are no longer read.
 *
 * Parity notes:
 * - The disk cache key is `sha1(query-string)`, byte-identical to Python.
 * - Python's `time.sleep(delay)` before each request is a fixed sleep, not a
 *   since-last-request throttle — reproduced exactly.
 * - requests sends no explicit User-Agent here (its default); undici sends
 *   `undici`/`node`. ADS keys auth off the Authorization header only.
 */

import type { AdsResolution, AdsSource, AdsStatus } from "@argelanderspace/core";
import { normDoi, normTitle } from "@argelanderspace/core";
import {
  ADS_TOKEN_ID,
  type CredentialStore,
  createAdsCredentialStore,
} from "../credential-store.js";
import { type FetchImpl, fetchText, HttpError, sleep, withQuery } from "../lib/http.js";
import { SourceCache, sha1Hex } from "./cache.js";

const BASE = "https://api.adsabs.harvard.edu/v1/search/query";
const EXPORT_BASE = "https://ui.adsabs.harvard.edu/v1/export/bibtex";
const FL = "bibcode,title,author,year,citation_count,pub,doi,abstract,reference";
const TIMEOUT = 30;

/**
 * How long a read of the ADS token may take (desktop-app ticket 12). A locked keychain can make the Secret Service ask
 * the user to unlock it; a read that has not answered by then counts as "no token", so no request or job waits on it.
 */
export const ADS_TOKEN_READ_TIMEOUT_MS = 5000;

/**
 * The ADS token saved in the workbench (desktop-app ticket 12): the credential store's `ads` purpose, trimmed. Not
 * saved, a keychain that does not answer (or not within {@link ADS_TOKEN_READ_TIMEOUT_MS}) with no fallback file, a
 * damaged file, any failure: no token (null), never an error. Read when it is needed, so a token saved or removed
 * applies without a restart. The environment variable `ADS_DEV_KEY`, config.toml's `ads_dev_key` and `~/.ads/dev_key`
 * are not read.
 *
 * The timeout bounds the wait of the caller, not the store's own work: the timer is cleared once either side settles
 * and never keeps the process alive. (A store whose backend blocks the thread synchronously cannot be interrupted by
 * any timer; the OS keychain backend's calls are such calls.)
 */
export async function readAdsToken(
  store: Pick<CredentialStore, "get"> = createAdsCredentialStore(),
  opts: { timeoutMs?: number } = {}
): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), opts.timeoutMs ?? ADS_TOKEN_READ_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    const read = (async () => {
      const got = await store.get(ADS_TOKEN_ID);
      return got.status === "ok" ? got.password.trim() || null : null;
    })().catch(() => null);
    return await Promise.race([read, timedOut]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface AdsClientOptions {
  /** Disk cache dir (Python `CACHE_DIR / "ads"` = `<dataDir>/library/cache/ads`). */
  cacheDir: string;
  /** The token (the composition reads it with {@link readAdsToken}); absent = no token. */
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
    this.token = opts.token ?? null;
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
