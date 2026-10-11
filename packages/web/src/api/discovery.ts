/**
 * Stage 14 Discovery API client: `GET /api/library/discovery`. NO fixture
 * fallback (stage plan D9) — a network/HTTP failure is reported honestly and
 * the UI renders the localized error state. Cancellation rides the caller's
 * AbortSignal: an aborted call rethrows (the state machine treats it as a
 * cancel, never an error).
 */

import { type DiscoveryGraph, DiscoveryGraphSchema } from "@argelanderspace/contracts";
import { apiRequest, HttpError, underlyingError } from "./request";

export type DiscoveryOutcome =
  | { ok: true; graph: DiscoveryGraph }
  /** status: the HTTP status, or 0 for a network-level failure. */
  | { ok: false; status: number };

export async function fetchDiscovery(
  bibcode: string,
  signal?: AbortSignal
): Promise<DiscoveryOutcome> {
  let payload: unknown;
  try {
    payload = await apiRequest(`/api/library/discovery?bibcode=${encodeURIComponent(bibcode)}`, {}, { signal });
  } catch (e) {
    if (e instanceof HttpError && e.status > 0) return { ok: false, status: e.status };
    throw underlyingError(e);
  }
  // a malformed payload renders the honest upstream-failure state, never a crash
  const parsed = DiscoveryGraphSchema.safeParse(payload);
  return parsed.success ? { ok: true, graph: parsed.data } : { ok: false, status: 502 };
}
