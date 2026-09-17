/**
 * NASA ADS discovery client (Stage 14): the infra adapter behind core's
 * `AdsDiscoverySource` port — exact seed lookup, `similar()`, and `useful()`
 * Solr queries against the ADS search API.
 *
 * Boundary rules (stage plan §3/§4): this class owns ADS URLs, Solr query
 * construction/escaping, token handling, HTTP status mapping, response JSON
 * shape, and the dedicated TTL cache. It knows nothing about Library UI and
 * never mutates Library state.
 *
 * Cache: a SEPARATE namespace from the metadata `<cacheDir>/ads` cache —
 * `<dataDir>/library/cache/ads-discovery/` — caching raw provider `docs`
 * (not assembled DiscoveryGraphs) as `{fetchedAt, data}` entries with a 24h
 * TTL. The key covers every input that can change the provider response
 * (query text, fields, rows, sort). Errors and aborted requests are never
 * written. The metadata `AdsClient`'s cache semantics are untouched.
 *
 * Unlike the metadata chain (which degrades silently), discovery is explicit:
 * failures raise {@link AdsDiscoveryError} with a machine-readable `kind`
 * that the server maps to HTTP status codes.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdsDiscoveryRecord, AdsDiscoverySource } from "@argelanderspace/core";
import { normArxiv, normDoi } from "@argelanderspace/core";
import { type FetchImpl, withQuery } from "../lib/http.js";
import { readAdsToken } from "./ads.js";
import { sha1Hex } from "./cache.js";

const BASE = "https://api.adsabs.harvard.edu/v1/search/query";
/** Bibliographic + edge-derivation fields requested in one response per query. */
const FL = "bibcode,title,author,year,citation_count,pub,doi,abstract,reference,identifier";
const TIMEOUT = 30;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// --------------------------------------------------------------------------- //
// Errors (server maps kind → HTTP status)
// --------------------------------------------------------------------------- //

export type AdsDiscoveryErrorKind =
  | "no-token" // missing token or disabled → 503
  | "unauthorized" // token rejected → 503
  | "rate-limited" // 429 (+ Retry-After when ADS sends one)
  | "upstream" // timeout/network/5xx → 502
  | "invalid-response"; // unparseable top-level response → 502

export class AdsDiscoveryError extends Error {
  constructor(
    public readonly kind: AdsDiscoveryErrorKind,
    message: string,
    public readonly retryAfter?: string
  ) {
    super(message);
    this.name = "AdsDiscoveryError";
  }
}

// --------------------------------------------------------------------------- //
// Query construction (bibcodes are identifiers, never raw query strings)
// --------------------------------------------------------------------------- //

/** Quote one bibcode for embedding in a Solr query (escape `\` and `"`). */
export function quoteBibcode(bibcode: string): string {
  return `"${bibcode.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function seedQuery(bibcode: string): string {
  return `bibcode:${quoteBibcode(bibcode)}`;
}

export function similarQuery(bibcode: string): string {
  return `similar(bibcode:${quoteBibcode(bibcode)})`;
}

/** Explicit OR of individually quoted bibcodes inside the useful() operator. */
export function usefulQuery(bibcodes: readonly string[]): string {
  return `useful(${bibcodes.map((b) => `bibcode:${quoteBibcode(b)}`).join(" OR ")})`;
}

// --------------------------------------------------------------------------- //
// Normalization (raw ADS doc → port record; null = malformed, caller skips)
// --------------------------------------------------------------------------- //

export function normalizeDiscoveryDoc(doc: Record<string, unknown>): AdsDiscoveryRecord | null {
  const bibcode = typeof doc.bibcode === "string" && doc.bibcode.trim() !== "" ? doc.bibcode : null;
  if (!bibcode) return null; // no usable bibcode → the record is worthless for discovery

  const rawTitle = doc.title || [""];
  const title = Array.isArray(rawTitle)
    ? ((rawTitle[0] as string | undefined) ?? "")
    : String(rawTitle);

  // ADS author entries are display strings ("Hunt, E. L.") — preserved as-is,
  // NOT reduced to family names (stage plan §4).
  const authors = Array.isArray(doc.author)
    ? doc.author.filter((a): a is string => typeof a === "string")
    : [];

  let year: number | null = null;
  if (doc.year) {
    const y =
      typeof doc.year === "number" ? Math.trunc(doc.year) : Number.parseInt(String(doc.year), 10);
    year = Number.isNaN(y) ? null : y;
  }

  const rawDoi = Array.isArray(doc.doi) ? doc.doi[0] : null;

  return {
    bibcode,
    title,
    authors,
    year,
    venue: typeof doc.pub === "string" ? doc.pub : null,
    abstract: typeof doc.abstract === "string" ? doc.abstract : null,
    citation_count: typeof doc.citation_count === "number" ? Math.trunc(doc.citation_count) : null,
    doi: normDoi(typeof rawDoi === "string" ? rawDoi : null),
    arxiv_id: arxivFromIdentifier(doc.identifier),
    references: Array.isArray(doc.reference)
      ? doc.reference.filter((r): r is string => typeof r === "string")
      : [],
  };
}

/** arXiv id from the ADS `identifier` list (`"arXiv:2306.12345"` entries). */
function arxivFromIdentifier(ids: unknown): string | null {
  if (!Array.isArray(ids)) return null;
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const m = /^arxiv:(.+)$/i.exec(raw.trim());
    if (m?.[1]) return normArxiv(m[1]);
  }
  return null;
}

// --------------------------------------------------------------------------- //
// TTL cache ({fetchedAt, data} entries; raw provider docs)
// --------------------------------------------------------------------------- //

interface DiscoveryCacheEntry {
  fetchedAt: string;
  data: unknown;
}

class DiscoveryCache {
  constructor(
    public readonly dir: string,
    private readonly ttlMs: number,
    private readonly now: () => number
  ) {
    mkdirSync(dir, { recursive: true });
  }

  /** Cached provider docs when present AND inside the TTL; else undefined. */
  read(key: string): Array<Record<string, unknown>> | undefined {
    try {
      const entry = JSON.parse(
        readFileSync(join(this.dir, `${key}.json`), "utf-8")
      ) as DiscoveryCacheEntry;
      if (!Array.isArray(entry?.data)) return undefined;
      const at = Date.parse(entry.fetchedAt);
      if (Number.isNaN(at) || this.now() - at > this.ttlMs) return undefined;
      return entry.data as Array<Record<string, unknown>>;
    } catch {
      return undefined; // absent or corrupt → miss
    }
  }

  write(key: string, docs: Array<Record<string, unknown>>): void {
    const entry: DiscoveryCacheEntry = {
      fetchedAt: new Date(this.now()).toISOString(),
      data: docs,
    };
    writeFileSync(join(this.dir, `${key}.json`), JSON.stringify(entry), "utf-8");
  }
}

// --------------------------------------------------------------------------- //
// Client
// --------------------------------------------------------------------------- //

export interface AdsDiscoveryClientOptions {
  /** `<dataDir>/library/cache/ads-discovery` — the dedicated namespace. */
  cacheDir: string;
  /** Explicit token override; defaults to {@link readAdsToken}. */
  token?: string | null;
  /** false = unavailable (cache stays readable; network attempts raise no-token). */
  enabled?: boolean;
  fetchImpl?: FetchImpl;
  /** Provider-response TTL; default 24h. */
  ttlMs?: number;
  /** Clock seam for TTL tests. */
  now?: () => number;
  log?: (msg: string) => void;
}

export class AdsDiscoveryClient implements AdsDiscoverySource {
  private readonly token: string | null;
  private readonly enabled: boolean;
  private readonly cache: DiscoveryCache;
  private readonly fetchImpl: FetchImpl;
  private readonly log?: (msg: string) => void;

  constructor(opts: AdsDiscoveryClientOptions) {
    this.token = opts.token !== undefined ? opts.token : readAdsToken();
    this.enabled = opts.enabled ?? true;
    this.cache = new DiscoveryCache(
      opts.cacheDir,
      opts.ttlMs ?? DEFAULT_TTL_MS,
      opts.now ?? Date.now
    );
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.log;
  }

  async getByBibcode(bibcode: string, signal?: AbortSignal): Promise<AdsDiscoveryRecord | null> {
    const docs = await this.request({ q: seedQuery(bibcode), fl: FL, rows: 1 }, signal);
    if (docs.length === 0) return null; // ADS has no such record
    const first = docs[0] as Record<string, unknown>;
    const normalized = normalizeDiscoveryDoc(first);
    if (!normalized) {
      // seed identity is required — a malformed seed result is a provider failure
      throw new AdsDiscoveryError("invalid-response", "ADS seed record has no usable bibcode");
    }
    return normalized;
  }

  async similar(
    bibcode: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<AdsDiscoveryRecord[]> {
    const docs = await this.request(
      { q: similarQuery(bibcode), fl: FL, rows: limit, sort: "score desc" },
      signal
    );
    return docs
      .map((d) => normalizeDiscoveryDoc(d))
      .filter((r): r is AdsDiscoveryRecord => r !== null);
  }

  async useful(
    bibcodes: readonly string[],
    limit: number,
    signal?: AbortSignal
  ): Promise<AdsDiscoveryRecord[]> {
    const docs = await this.request(
      { q: usefulQuery(bibcodes), fl: FL, rows: limit, sort: "score desc" },
      signal
    );
    return docs
      .map((d) => normalizeDiscoveryDoc(d))
      .filter((r): r is AdsDiscoveryRecord => r !== null);
  }

  /**
   * One disk-cached Solr request. Cache hit answers without a token; a miss
   * requires token + enabled. Provider errors are never cached; an aborted
   * request neither resolves nor writes.
   */
  private async request(
    params: { q: string; fl: string; rows: number; sort?: string },
    signal?: AbortSignal
  ): Promise<Array<Record<string, unknown>>> {
    // the key covers every input that can change the provider response
    const key = sha1Hex(JSON.stringify(params));
    const hit = this.cache.read(key);
    if (hit !== undefined) return hit;

    if (!this.token) throw new AdsDiscoveryError("no-token", "ADS token is not configured");
    if (!this.enabled) throw new AdsDiscoveryError("no-token", "ADS access is disabled");

    const url = withQuery(BASE, params);
    const signals = [AbortSignal.timeout(TIMEOUT * 1000)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (signal?.aborted || (e instanceof Error && e.name === "AbortError")) throw e; // caller cancel: propagate, never cache
      if (e instanceof Error && e.name === "TimeoutError") {
        throw new AdsDiscoveryError("upstream", `ADS request timed out after ${TIMEOUT}s`);
      }
      throw new AdsDiscoveryError("upstream", `ADS request failed: ${String(e)}`);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 401 || res.status === 403) {
        throw new AdsDiscoveryError("unauthorized", `ADS token rejected (HTTP ${res.status})`);
      }
      if (res.status === 429) {
        throw new AdsDiscoveryError(
          "rate-limited",
          "ADS rate limit exceeded",
          res.headers.get("retry-after") ?? undefined
        );
      }
      throw new AdsDiscoveryError("upstream", `ADS HTTP ${res.status}: ${detail}`);
    }

    let docs: unknown;
    try {
      docs = (JSON.parse(await res.text()) as { response?: { docs?: unknown } })?.response?.docs;
    } catch {
      throw new AdsDiscoveryError("invalid-response", "ADS response is not valid JSON");
    }
    if (!Array.isArray(docs)) {
      throw new AdsDiscoveryError("invalid-response", "ADS response.response.docs is not an array");
    }

    const out = docs as Array<Record<string, unknown>>;
    try {
      this.cache.write(key, out); // successful responses cache even when empty
    } catch (e) {
      this.log?.(`ads-discovery cache write failed: ${String(e)}`); // best-effort cache
    }
    return out;
  }
}
