/**
 * The discovery-domain operations of the catalog (release-0.2 ticket 09): the read-only ADS search and the exploration
 * read. Both only GET from ADS and answer data: nothing is stored in the project, no library lock is taken, nothing is
 * broadcast. (The exploration read goes through the same ADS discovery client as the explore page, whose provider
 * responses live in its own TTL cache under `library/cache/ads-discovery`; `search_ads` has no cache at all.)
 *
 * Failures are answers, not exceptions, and each kind is told apart: no token saved, token rejected, rate limited,
 * query not understood, timeout, unreachable, unintelligible answer. No result, detail or error carries the token or a
 * response body.
 */
import {
  DISCOVERY_SEARCH_DEFAULT_FIELDS,
  DISCOVERY_SEARCH_DEFAULT_LIMIT,
  type DiscoverySearchAds,
  parseDiscoverySearchFields,
} from "@argelanderspace/contracts";
import { discoverLiterature, LibraryStore } from "@argelanderspace/core";
import {
  AdsDiscoveryError,
  type AdsSearchFailure,
  type AdsSearchField,
} from "@argelanderspace/infra";
import type { LibraryOpDeps } from "./library-actions.js";

type Reason = AdsSearchFailure | "not_found" | "unavailable" | "stopped";

export type DiscoveryFailure = {
  ok: false;
  status: "error" | "not_found" | "unsupported" | "interrupted";
  reason: Reason;
  detail: string;
  http?: number;
  retryAfter?: string;
};

const FAILURE_TEXT: Record<AdsSearchFailure, string> = {
  no_token:
    "no ADS token is saved in the workbench (Settings, ADS token); nothing was read. Ask the user to add one there; never ask for the token in chat",
  unauthorized:
    "ADS rejected the saved token (HTTP 401); nothing was read. Tell the user to check it in Settings",
  rate_limited:
    "ADS rate limit reached (HTTP 429); nothing was read. Wait and try again later, do not loop",
  bad_query:
    'ADS could not parse the query (HTTP 400); nothing was read. Fix the query syntax (fielded terms look like author:"Hunt, E" year:2020 title:"...") and search again',
  timeout: "ADS did not answer in time; nothing was read. It may be tried again later",
  unreachable: "ADS could not be reached; nothing was read. It may be tried again later",
  invalid_response: "ADS's answer was not understood; nothing was read",
};

const STOPPED: DiscoveryFailure = {
  ok: false,
  status: "interrupted",
  reason: "stopped",
  detail:
    "the user pressed Stop before ADS answered; nothing was read or changed (this action only reads). Do not retry unless the user asks",
};

const UNAVAILABLE: DiscoveryFailure = {
  ok: false,
  status: "unsupported",
  reason: "unavailable",
  detail: "searching ADS is not available in this host",
};

export type SearchAdsOutcome =
  | {
      ok: true;
      status: "ok";
      query: string;
      numFound: number;
      returned: number;
      records: Record<string, unknown>[];
    }
  | DiscoveryFailure;

/** `discovery.search_ads`: one GET to the ADS search API; nothing is stored. */
export async function searchAds(
  deps: LibraryOpDeps,
  params: Omit<DiscoverySearchAds, "action">,
  signal?: AbortSignal
): Promise<SearchAdsOutcome> {
  if (!deps.adsSearch) return UNAVAILABLE;
  const query = params.query.trim();
  if (query === "")
    return {
      ok: false,
      status: "unsupported",
      reason: "bad_query",
      detail: "the query is empty; nothing was read",
    };
  const fields = (
    params.fields === undefined
      ? [...DISCOVERY_SEARCH_DEFAULT_FIELDS]
      : (parseDiscoverySearchFields(params.fields) ?? [...DISCOVERY_SEARCH_DEFAULT_FIELDS])
  ) as AdsSearchField[];
  let got: Awaited<ReturnType<Awaited<ReturnType<NonNullable<typeof deps.adsSearch>>>["search"]>>;
  try {
    got = await (await deps.adsSearch()).search(
      { query, rows: params.limit ?? DISCOVERY_SEARCH_DEFAULT_LIMIT, fields },
      signal
    );
  } catch (e) {
    if (signal?.aborted) return STOPPED; // the caller's own cancel, not an ADS failure
    throw e;
  }
  if (!got.ok)
    return {
      ok: false,
      status: "error",
      reason: got.reason,
      detail: FAILURE_TEXT[got.reason],
      ...(got.http !== undefined ? { http: got.http } : {}),
      ...(got.retryAfter !== undefined ? { retryAfter: got.retryAfter } : {}),
    };
  return {
    ok: true,
    status: "ok",
    query,
    numFound: got.numFound,
    returned: got.records.length,
    records: got.records as unknown as Record<string, unknown>[],
  };
}

/**
 * Bibcodes are identifiers, not ADS query strings: capped length, no whitespace, quotes or control characters (the
 * infra layer additionally quotes and escapes before embedding one in a query). The explore page's route uses it too.
 */
export function badDiscoveryBibcode(v: string): boolean {
  return (
    v.length === 0 ||
    v.length > 64 ||
    ![...v].every((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x20 && code !== 0x7f && ch !== '"' && ch !== "\\";
    })
  );
}

const EXPLORE_REASON = {
  "no-token": "no_token",
  unauthorized: "unauthorized",
  "rate-limited": "rate_limited",
  upstream: "unreachable",
  "invalid-response": "invalid_response",
} as const satisfies Record<AdsDiscoveryError["kind"], AdsSearchFailure>;

/** `discovery.explore`: the explore page's graph for one seed, as data. */
export async function exploreSeed(
  deps: LibraryOpDeps,
  params: { bibcode: string },
  signal?: AbortSignal
) {
  if (!deps.discoverySource) return UNAVAILABLE;
  const bibcode = params.bibcode.trim();
  if (badDiscoveryBibcode(bibcode))
    return {
      ok: false,
      status: "unsupported",
      reason: "bad_query",
      detail: "not a bibcode (no spaces or quotes, at most 64 characters); nothing was read",
    } satisfies DiscoveryFailure;
  try {
    const source = await deps.discoverySource();
    const graph = await discoverLiterature(
      bibcode,
      { ads: source, store: LibraryStore.load(deps.paths) },
      { ...(signal ? { signal } : {}) }
    );
    if (!graph)
      return {
        ok: false,
        status: "not_found",
        reason: "not_found",
        detail: `ADS has no record for bibcode ${bibcode}`,
      } satisfies DiscoveryFailure;
    return { ok: true, status: "ok", graph } as const;
  } catch (e) {
    if (signal?.aborted) return STOPPED;
    if (e instanceof AdsDiscoveryError) {
      const reason = EXPLORE_REASON[e.kind];
      return {
        ok: false,
        status: "error",
        reason,
        detail: FAILURE_TEXT[reason],
        ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
      } satisfies DiscoveryFailure;
    }
    throw e;
  }
}
