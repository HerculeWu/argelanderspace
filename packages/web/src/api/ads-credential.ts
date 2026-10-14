import {
  ADS_CREDENTIAL_REFUSALS,
  ADS_CREDENTIAL_STATES,
  ADS_TOKEN_TEST_OUTCOMES,
  type AdsCredentialRefusal,
  type AdsCredentialStatus,
  type AdsTokenTestOutcome,
} from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";

/**
 * The ADS credential endpoints (desktop-app ticket 12). The page sends the token when it saves or tests an input; no
 * answer carries it back. What comes back is checked for the shape the page relies on; an answer without it counts as
 * no answer (`unreachable`).
 */

export type AdsCredentialFailure = AdsCredentialRefusal | "unreachable";

export type AdsCredentialOutcome =
  | { ok: true; status: AdsCredentialStatus }
  | { ok: false; reason: AdsCredentialFailure };

export type AdsTokenTestResult =
  | { ok: true; result: AdsTokenTestOutcome }
  | { ok: false; reason: AdsCredentialFailure };

const BASE = "/api/credentials/ads";

function isStatus(value: unknown): value is AdsCredentialStatus {
  const v = value as Partial<AdsCredentialStatus> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    (ADS_CREDENTIAL_STATES as readonly unknown[]).includes(v.saved) &&
    (v.keychain === "available" || v.keychain === "unavailable") &&
    typeof v.devKey?.exists === "boolean" &&
    typeof v.devKey?.path?.display === "string"
  );
}

function failure(e: unknown): { ok: false; reason: AdsCredentialFailure } {
  if ((e as { name?: string } | null)?.name === "AbortError") throw e;
  const reason = e instanceof HttpError ? (e.body as { reason?: unknown } | null)?.reason : undefined;
  return {
    ok: false,
    reason: (ADS_CREDENTIAL_REFUSALS as readonly unknown[]).includes(reason) ? (reason as AdsCredentialRefusal) : "unreachable",
  };
}

/** Where the token is now; null when the server gave no usable answer. */
export async function fetchAdsCredential(signal?: AbortSignal): Promise<AdsCredentialStatus | null> {
  try {
    const body = await apiRequest<unknown>(BASE, { cache: "no-store" }, { signal });
    return isStatus(body) ? body : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === "AbortError") throw e;
    return null;
  }
}

async function change(path: string, method: string, json?: unknown): Promise<AdsCredentialOutcome> {
  try {
    const body = await apiRequest<{ ok?: unknown; status?: unknown }>(path, {
      method,
      ...(json === undefined ? {} : { json }),
    });
    return body?.ok === true && isStatus(body.status) ? { ok: true, status: body.status } : { ok: false, reason: "unreachable" };
  } catch (e) {
    return failure(e);
  }
}

/** Save a token. `fileFallbackConsent` only when the user ticked the consent. */
export function saveAdsToken(token: string, fileFallbackConsent: boolean): Promise<AdsCredentialOutcome> {
  return change(BASE, "PUT", { token, ...(fileFallbackConsent ? { fileFallbackConsent: true } : {}) });
}

export function removeAdsToken(): Promise<AdsCredentialOutcome> {
  return change(BASE, "DELETE");
}

/** Save the content of `~/.ads/dev_key` (read by the server, left as it is). */
export function importAdsDevKey(fileFallbackConsent: boolean): Promise<AdsCredentialOutcome> {
  return change(`${BASE}/import`, "POST", fileFallbackConsent ? { fileFallbackConsent: true } : {});
}

/** Test the saved token, or `token` when given (not saved by this). */
export async function testAdsToken(token?: string): Promise<AdsTokenTestResult> {
  try {
    const body = await apiRequest<{ ok?: unknown; result?: unknown }>(`${BASE}/test`, {
      method: "POST",
      json: token === undefined ? {} : { token },
    });
    return body?.ok === true && (ADS_TOKEN_TEST_OUTCOMES as readonly unknown[]).includes(body.result)
      ? { ok: true, result: body.result as AdsTokenTestOutcome }
      : { ok: false, reason: "unreachable" };
  } catch (e) {
    return failure(e);
  }
}
