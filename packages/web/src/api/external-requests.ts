import {
  EXTERNAL_REQUESTS_PATH,
  type ExternalRequest,
  ExternalRequestListSchema,
} from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";

/** The confirmation cards external agents raised through the CLI (release-0.2 ticket 04), in arrival order. */
export async function fetchExternalRequests(): Promise<ExternalRequest[]> {
  const body = await apiRequest<unknown>(EXTERNAL_REQUESTS_PATH, { cache: "no-store" });
  const parsed = ExternalRequestListSchema.safeParse(body);
  // An older or newer server's list is not guessed at: no cards is the safe reading (the CLI keeps waiting).
  return parsed.success ? parsed.data.requests : [];
}

/** How a decision ended for the page: the operation's own result when approved. */
export type ExternalDecision =
  | { state: "approved"; result: unknown }
  | { state: "denied" }
  /** The request is gone, was withdrawn or is not the first any more: nothing was done. */
  | { state: "stale" };

export async function decideExternalRequest(id: string, decision: "approve" | "deny"): Promise<ExternalDecision> {
  try {
    const body = await apiRequest<{ state?: string; result?: unknown }>(`${EXTERNAL_REQUESTS_PATH}/${encodeURIComponent(id)}/decision`, { method: "POST", json: { decision } });
    return body.state === "approved" ? { state: "approved", result: body.result } : { state: "denied" };
  } catch (reason) {
    if (reason instanceof HttpError && (reason.status === 404 || reason.status === 409)) return { state: "stale" };
    throw reason;
  }
}

/** The user closes a withdrawn card. A request already gone is the same outcome. */
export async function dismissExternalRequest(id: string): Promise<void> {
  try {
    await apiRequest<unknown>(`${EXTERNAL_REQUESTS_PATH}/${encodeURIComponent(id)}/dismiss`, { method: "POST" });
  } catch (reason) {
    if (!(reason instanceof HttpError && reason.status === 404)) throw reason;
  }
}
