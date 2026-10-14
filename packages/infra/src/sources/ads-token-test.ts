/**
 * Testing an ADS token (desktop-app ticket 12): one minimal search request (no rows asked for), its answer reduced to
 * one of four results. The token goes in the Authorization header only. Nothing of the answer is kept or returned —
 * not its body, not an error message — and nothing is cached.
 */

import type { FetchImpl } from "../lib/http.js";
import { withQuery } from "../lib/http.js";

export const ADS_TOKEN_TEST_RESULTS = ["valid", "rejected", "unreachable", "rate_limited"] as const;
export type AdsTokenTestResult = (typeof ADS_TOKEN_TEST_RESULTS)[number];

const URL = withQuery("https://api.adsabs.harvard.edu/v1/search/query", {
  q: "bibcode:2016ApJ...818...46F",
  fl: "bibcode",
  rows: 0,
});

export interface AdsTokenTestOptions {
  fetchImpl?: FetchImpl;
  /** Default 15 s. */
  timeoutMs?: number;
}

/** 2xx → valid; 401 / 403 → rejected; 429 → rate_limited; anything else, a network failure or a timeout → unreachable. */
export async function testAdsToken(
  token: string,
  opts: AdsTokenTestOptions = {}
): Promise<AdsTokenTestResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const res = await fetchImpl(URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    // The body is not read for its content; it is drained so the connection can be reused.
    await res.arrayBuffer().catch(() => undefined);
    if (res.status === 401 || res.status === 403) return "rejected";
    if (res.status === 429) return "rate_limited";
    return res.ok ? "valid" : "unreachable";
  } catch {
    return "unreachable"; // the message may quote the request; discarded
  } finally {
    clearTimeout(timer);
  }
}
