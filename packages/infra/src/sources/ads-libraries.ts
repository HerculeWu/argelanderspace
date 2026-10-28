/**
 * NASA ADS libraries client (project intake ticket 02, contracts "项目迁入" / "ADS libraries"): the user's own
 * libraries on ADS, read through the biblib service. READ ONLY: this file issues GET requests and nothing else, and
 * has no code path that creates, changes or deletes a library (the same guarantee the contract states).
 *
 * Interface (verified 2026-10-26 against the biblib-service source, adsabs/biblib-service on GitHub; see the ticket
 * comments for what could and could not be checked):
 * - `GET https://api.adsabs.harvard.edu/v1/biblib/libraries[?start&rows&sort&order&access_type]` answers
 *   `{count, libraries:[{id, name, description, num_documents, date_created, date_last_modified, permission, public,
 *   num_users, owner}]}`; with no `rows` it returns every library.
 * - `GET .../biblib/libraries/<id>?start&rows&raw=true` answers `{documents:[bibcode…], metadata:{…, num_documents},
 *   solr, updates}`; `raw=true` skips the Solr join, so the page is the stored bibcode list sorted alphabetically and
 *   sliced by `start`/`rows` (`process_raw_library` takes neither `sort` nor `fl`: `sort=time asc` only applies
 *   without `raw`, so it is not sent). `rows` is capped by the service (100 by default, multiplied by the gateway's
 *   rate-limit level), so a window of up to 200 bibcodes is one to a few requests whatever the library's size.
 * - Errors: 401 token missing or rejected by the gateway, 403 no permission, 429 rate limit, 410 library gone, 400
 *   bad id / parameters.
 *
 * The token is handed in (the composition reads it from the credential store at each use); it goes in the
 * Authorization header only and appears in no result, error or log line.
 */

import { type FetchImpl, withQuery } from "../lib/http.js";

const BASE = "https://api.adsabs.harvard.edu/v1/biblib/libraries";
const PAGE_ROWS = 100;
const REQUEST_TIMEOUT_MS = 30_000;

/** At most this many libraries are listed. */
export const ADS_LIBRARIES_MAX_LISTED = 500;
/** One window is read in at most this many requests (a service that caps `rows` lower returns a shorter window). */
const MAX_WINDOW_REQUESTS = 3;

/** Why a read did not give an answer; each one is told apart on purpose. */
export type AdsLibrariesFailure =
  | "no_token" // nothing saved in the credential store
  | "unauthorized" // 401: the token is rejected
  | "forbidden" // 403: the token is known but may not read this
  | "rate_limited" // 429
  | "not_found" // 410 / 404 / 400 for a library id: no such library
  | "timeout" // a request ran out of time
  | "unreachable" // network failure or a 5xx
  | "invalid_response"; // an answer that is not the documented shape

export interface AdsLibrariesError {
  ok: false;
  reason: AdsLibrariesFailure;
  /** HTTP status when the failure was an HTTP answer. */
  http?: number;
  /** `Retry-After` of a 429, as sent. */
  retryAfter?: string;
}

export interface AdsLibrarySummary {
  id: string;
  name: string;
  /** Number of bibcodes ADS says the library holds. */
  numDocuments: number;
  description?: string;
  /** The user's role on it: owner, admin, write or read. */
  permission?: string;
  public?: boolean;
  owner?: string;
}

export type AdsLibraryList =
  | { ok: true; libraries: AdsLibrarySummary[]; total: number; truncated: boolean }
  | AdsLibrariesError;

export type AdsLibraryWindow =
  | {
      ok: true;
      library: AdsLibrarySummary;
      /** The library's size as ADS reported it with this window (`num_documents`). */
      total: number;
      /** Where this window starts. */
      offset: number;
      /** The bibcodes at `offset…`, in the service's order (alphabetical); fewer than asked only at the end or when
       *  the service caps a page below what the window needs. */
      bibcodes: string[];
    }
  | AdsLibrariesError;

export interface AdsLibrariesSource {
  list(signal?: AbortSignal): Promise<AdsLibraryList>;
  /** One window of a library: `limit` (1–200) bibcodes from `offset`; the request count does not depend on the library's size. */
  readWindow(
    libraryId: string,
    offset: number,
    limit: number,
    signal?: AbortSignal
  ): Promise<AdsLibraryWindow>;
}

export interface AdsLibrariesClientOptions {
  /** The token (the composition reads it with `readAdsToken`); absent = no token. */
  token?: string | null;
  fetchImpl?: FetchImpl;
  /** Per-request timeout; default 30 s. */
  requestTimeoutMs?: number;
}

type Get = { ok: true; json: unknown } | AdsLibrariesError;

/** A library id as biblib prints it (a URL-safe slug); anything else is never put in a URL. */
export function validAdsLibraryId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

export class AdsLibrariesClient implements AdsLibrariesSource {
  private readonly token: string | null;
  private readonly fetchImpl: FetchImpl;
  private readonly requestTimeoutMs: number;

  constructor(opts: AdsLibrariesClientOptions = {}) {
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async list(signal?: AbortSignal): Promise<AdsLibraryList> {
    const got = await this.get(BASE, signal, this.requestTimeoutMs);
    if (!got.ok) {
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      return got;
    }
    const raw = (got.json as { libraries?: unknown } | null)?.libraries;
    if (!Array.isArray(raw)) return { ok: false, reason: "invalid_response" };
    const libraries: AdsLibrarySummary[] = [];
    for (const entry of raw) {
      const summary = summaryOf(entry);
      if (!summary) return { ok: false, reason: "invalid_response" };
      libraries.push(summary);
    }
    return {
      ok: true,
      libraries: libraries.slice(0, ADS_LIBRARIES_MAX_LISTED),
      total: libraries.length,
      truncated: libraries.length > ADS_LIBRARIES_MAX_LISTED,
    };
  }

  async readWindow(
    libraryId: string,
    offset: number,
    limit: number,
    signal?: AbortSignal
  ): Promise<AdsLibraryWindow> {
    if (!validAdsLibraryId(libraryId)) return { ok: false, reason: "not_found" };
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1)
      return { ok: false, reason: "invalid_response" };
    const bibcodes: string[] = [];
    const seen = new Set<string>();
    let library: AdsLibrarySummary | null = null;
    let start = offset;
    for (let request = 0; request < MAX_WINDOW_REQUESTS; request++) {
      // The first request does not know the size yet; later ones never ask past the end or past the window.
      const rows = library
        ? Math.min(PAGE_ROWS, limit - bibcodes.length, library.numDocuments - start)
        : Math.min(PAGE_ROWS, limit);
      if (rows <= 0) break;
      const url = withQuery(`${BASE}/${libraryId}`, { start, rows, raw: "true" });
      const got = await this.get(url, signal, this.requestTimeoutMs, "library");
      if (!got.ok) {
        if (signal?.aborted) throw new DOMException("aborted", "AbortError"); // the caller's own cancel
        return got;
      }
      const body = got.json as { documents?: unknown; metadata?: unknown } | null;
      if (!body || !Array.isArray(body.documents)) return { ok: false, reason: "invalid_response" };
      // The requested id is the library's id: whatever id the metadata carries never replaces it.
      const seenSummary = summaryOf({ ...(body.metadata as object), id: libraryId });
      if (!seenSummary) return { ok: false, reason: "invalid_response" };
      // The library changing between two requests of one window would shift the slice: not an answer to trust.
      if (library && seenSummary.numDocuments !== library.numDocuments)
        return { ok: false, reason: "invalid_response" };
      library = seenSummary;
      const page = body.documents;
      // A service that ignores `start`/`rows`, repeats a page, or disagrees with its own count gives no usable window.
      // An empty page is judged below (past the end is an empty window); only a non-empty page can overrun the count.
      if (page.length > rows || (page.length > 0 && start + page.length > library.numDocuments))
        return { ok: false, reason: "invalid_response" };
      if (page.length === 0) {
        if (start < library.numDocuments) return { ok: false, reason: "invalid_response" };
        break;
      }
      for (const b of page) {
        if (typeof b !== "string" || b === "" || seen.has(b))
          return { ok: false, reason: "invalid_response" };
        seen.add(b);
        bibcodes.push(b);
      }
      start += page.length;
      if (bibcodes.length >= limit || start >= library.numDocuments) break;
    }
    if (library === null) return { ok: false, reason: "invalid_response" };
    return { ok: true, library, total: library.numDocuments, offset, bibcodes };
  }

  /** One GET. Never throws for an ADS-side outcome; a caller abort is rethrown by the caller that owns the signal. */
  private async get(
    url: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    what: "list" | "library" = "list"
  ): Promise<Get> {
    if (!this.token) return { ok: false, reason: "no_token" };
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.any(signals),
      });
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout" };
      return { ok: false, reason: "unreachable" }; // the message may quote the request; discarded
    }
    const status = res.status;
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined); // drained, never kept
      if (status === 401) return { ok: false, reason: "unauthorized", http: status };
      if (status === 403) return { ok: false, reason: "forbidden", http: status };
      if (status === 429) {
        const retryAfter = res.headers.get("retry-after");
        return {
          ok: false,
          reason: "rate_limited",
          http: status,
          ...(retryAfter ? { retryAfter } : {}),
        };
      }
      if (what === "library" && (status === 410 || status === 404 || status === 400))
        return { ok: false, reason: "not_found", http: status };
      return { ok: false, reason: "unreachable", http: status };
    }
    try {
      return { ok: true, json: JSON.parse(await res.text()) };
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      if (name === "TimeoutError" || name === "AbortError") return { ok: false, reason: "timeout" };
      return { ok: false, reason: "invalid_response" };
    }
  }
}

function summaryOf(entry: unknown): AdsLibrarySummary | null {
  if (typeof entry !== "object" || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== "string" || e.id === "") return null;
  const count = e.num_documents;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) return null;
  return {
    id: e.id,
    name: typeof e.name === "string" ? e.name : "",
    numDocuments: Math.trunc(count),
    ...(typeof e.description === "string" && e.description !== ""
      ? { description: e.description }
      : {}),
    ...(typeof e.permission === "string" ? { permission: e.permission } : {}),
    ...(typeof e.public === "boolean" ? { public: e.public } : {}),
    ...(typeof e.owner === "string" ? { owner: e.owner } : {}),
  };
}
