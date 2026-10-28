/**
 * NASA ADS search client (release-0.2 ticket 09, contracts "操作目录与外部 agent" / ADS 只读搜索): one query against
 * the ADS search API, answered as a short list of records. READ ONLY: this file issues `GET` requests and nothing else,
 * writes no cache and no file, and has no code path that changes anything on ADS.
 *
 * `GET https://api.adsabs.harvard.edu/v1/search/query?q=<query>&fl=<fields>&rows=<n>` answers
 * `{responseHeader, response:{numFound, start, docs:[…]}}`; 401 token missing or rejected, 429 rate limit, 400 a
 * query ADS cannot parse.
 *
 * The token is handed in (the composition reads it from the credential store at each use); it goes in the
 * Authorization header only and appears in no result, error or log line. Failures never throw an ADS-side error:
 * each is a distinguishable `reason`, and nothing of the response body or of a lower-level error message is kept.
 */

import { type FetchImpl, withQuery } from "../lib/http.js";

const BASE = "https://api.adsabs.harvard.edu/v1/search/query";
const REQUEST_TIMEOUT_MS = 30_000;

/** At most this many records come back from one search. */
export const ADS_SEARCH_MAX_ROWS = 50;
export const ADS_SEARCH_DEFAULT_ROWS = 10;
/** An abstract longer than this is cut (the record says so) so one search cannot fill a context window. */
export const ADS_SEARCH_ABSTRACT_MAX = 1500;
/** At most this many authors are listed per record; `authorCount` always carries the real number. */
export const ADS_SEARCH_AUTHORS_MAX = 10;

/** The fields a caller may ask for (`bibcode` is always there). */
export const ADS_SEARCH_FIELDS = [
  "title",
  "author",
  "year",
  "pub",
  "citation_count",
  "doi",
  "arxiv_id",
  "abstract",
] as const;
export type AdsSearchField = (typeof ADS_SEARCH_FIELDS)[number];
export const ADS_SEARCH_DEFAULT_FIELDS: readonly AdsSearchField[] = [
  "title",
  "author",
  "year",
  "pub",
  "citation_count",
  "doi",
];

/** Why a search did not give an answer; each one is told apart on purpose. */
export type AdsSearchFailure =
  | "no_token" // nothing saved in the credential store; no request was made
  | "unauthorized" // 401: the token is rejected
  | "rate_limited" // 429
  | "bad_query" // 400: ADS could not parse the query
  | "timeout" // the request ran out of time
  | "unreachable" // network failure or a 5xx / other HTTP status
  | "invalid_response"; // an answer that is not the documented shape

export interface AdsSearchError {
  ok: false;
  reason: AdsSearchFailure;
  /** HTTP status when the failure was an HTTP answer. */
  http?: number;
  /** `Retry-After` of a 429, as sent. */
  retryAfter?: string;
}

export interface AdsSearchRecord {
  bibcode: string;
  title?: string;
  /** The first {@link ADS_SEARCH_AUTHORS_MAX} authors as ADS displays them ("Hunt, E. L."). */
  authors?: string[];
  /** How many authors ADS lists (with `authors`). */
  authorCount?: number;
  year?: number;
  venue?: string;
  citationCount?: number;
  doi?: string;
  arxivId?: string;
  abstract?: string;
  /** The abstract was cut at {@link ADS_SEARCH_ABSTRACT_MAX} characters. */
  abstractTruncated?: true;
}

export type AdsSearchResult =
  | {
      ok: true;
      /** How many records match in ADS (not how many came back). */
      numFound: number;
      records: AdsSearchRecord[];
    }
  | AdsSearchError;

export interface AdsSearchRequest {
  /** The ADS query string, passed as is. */
  query: string;
  /** 1…{@link ADS_SEARCH_MAX_ROWS}. */
  rows: number;
  fields: readonly AdsSearchField[];
}

export interface AdsSearchSource {
  search(request: AdsSearchRequest, signal?: AbortSignal): Promise<AdsSearchResult>;
}

export interface AdsSearchClientOptions {
  /** The token (the composition reads it with `readAdsToken`); absent = no token. */
  token?: string | null;
  fetchImpl?: FetchImpl;
  /** Per-request timeout; default 30 s. */
  requestTimeoutMs?: number;
}

/** The ADS `fl` for the requested fields: what the record needs, nothing else. */
function flOf(fields: readonly AdsSearchField[]): string {
  const fl = new Set<string>(["bibcode"]);
  for (const field of fields) fl.add(field === "arxiv_id" ? "identifier" : field);
  return [...fl].join(",");
}

export class AdsSearchClient implements AdsSearchSource {
  private readonly token: string | null;
  private readonly fetchImpl: FetchImpl;
  private readonly requestTimeoutMs: number;

  constructor(opts: AdsSearchClientOptions = {}) {
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async search(request: AdsSearchRequest, signal?: AbortSignal): Promise<AdsSearchResult> {
    if (!this.token) return { ok: false, reason: "no_token" };
    const rows = Math.min(Math.max(1, Math.trunc(request.rows)), ADS_SEARCH_MAX_ROWS);
    const url = withQuery(BASE, { q: request.query, fl: flOf(request.fields), rows });
    const signals = [AbortSignal.timeout(this.requestTimeoutMs)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError"); // the caller's own cancel
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout" };
      return { ok: false, reason: "unreachable" }; // the message may quote the request; discarded
    }
    const status = res.status;
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined); // drained, never kept
      if (status === 401) return { ok: false, reason: "unauthorized", http: status };
      if (status === 400) return { ok: false, reason: "bad_query", http: status };
      if (status === 429) {
        const retryAfter = res.headers.get("retry-after");
        return {
          ok: false,
          reason: "rate_limited",
          http: status,
          ...(retryAfter ? { retryAfter } : {}),
        };
      }
      return { ok: false, reason: "unreachable", http: status };
    }
    let json: unknown;
    try {
      json = JSON.parse(await res.text());
    } catch (e) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout" };
      return { ok: false, reason: "invalid_response" };
    }
    const response = (json as { response?: { numFound?: unknown; docs?: unknown } } | null)
      ?.response;
    if (
      !response ||
      typeof response.numFound !== "number" ||
      !Number.isFinite(response.numFound) ||
      !Array.isArray(response.docs)
    )
      return { ok: false, reason: "invalid_response" };
    const records: AdsSearchRecord[] = [];
    for (const doc of response.docs.slice(0, rows)) {
      const record = recordOf(doc, request.fields);
      if (record === null) return { ok: false, reason: "invalid_response" };
      records.push(record);
    }
    return { ok: true, numFound: Math.max(0, Math.trunc(response.numFound)), records };
  }
}

function recordOf(doc: unknown, fields: readonly AdsSearchField[]): AdsSearchRecord | null {
  if (typeof doc !== "object" || doc === null) return null;
  const d = doc as Record<string, unknown>;
  if (typeof d.bibcode !== "string" || d.bibcode === "") return null;
  const record: AdsSearchRecord = { bibcode: d.bibcode };
  const want = new Set<string>(fields);
  if (want.has("title")) {
    const t = Array.isArray(d.title) ? d.title[0] : d.title;
    if (typeof t === "string") record.title = t;
  }
  if (want.has("author") && Array.isArray(d.author)) {
    const authors = d.author.filter((a): a is string => typeof a === "string");
    record.authors = authors.slice(0, ADS_SEARCH_AUTHORS_MAX);
    record.authorCount = authors.length;
  }
  if (want.has("year") && d.year !== undefined) {
    const y = typeof d.year === "number" ? Math.trunc(d.year) : Number.parseInt(String(d.year), 10);
    if (Number.isFinite(y)) record.year = y;
  }
  if (want.has("pub") && typeof d.pub === "string") record.venue = d.pub;
  if (want.has("citation_count") && typeof d.citation_count === "number")
    record.citationCount = Math.trunc(d.citation_count);
  if (want.has("doi")) {
    const doi = Array.isArray(d.doi) ? d.doi[0] : d.doi;
    if (typeof doi === "string" && doi !== "") record.doi = doi;
  }
  if (want.has("arxiv_id") && Array.isArray(d.identifier)) {
    for (const raw of d.identifier) {
      const m = typeof raw === "string" ? /^arxiv:(.+)$/i.exec(raw.trim()) : null;
      if (m?.[1]) {
        record.arxivId = m[1];
        break;
      }
    }
  }
  if (want.has("abstract") && typeof d.abstract === "string") {
    if (d.abstract.length > ADS_SEARCH_ABSTRACT_MAX) {
      record.abstract = d.abstract.slice(0, ADS_SEARCH_ABSTRACT_MAX);
      record.abstractTruncated = true;
    } else record.abstract = d.abstract;
  }
  return record;
}
