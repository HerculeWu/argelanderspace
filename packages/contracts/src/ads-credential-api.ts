/**
 * The ADS credential endpoints (desktop-app ticket 12): the ADS token kept in the credential store (OS keychain, or a
 * restricted file only with the user's consent), never in config.toml. No answer of these endpoints carries the
 * token; the page sends it, the server keeps it.
 *
 * - `GET    /api/credentials/ads`         → {@link AdsCredentialStatus}
 * - `PUT    /api/credentials/ads`         {@link AdsTokenSaveRequest} → {@link AdsCredentialChangeResponse}
 * - `DELETE /api/credentials/ads`         → {@link AdsCredentialChangeResponse}
 * - `POST   /api/credentials/ads/test`    {@link AdsTokenTestRequest} → {@link AdsTokenTestResponse}
 * - `POST   /api/credentials/ads/import`  {@link AdsTokenImportRequest} → {@link AdsCredentialChangeResponse}
 */

import type { ShownPath } from "./settings-api.js";

/** Where the token is: not saved, in the OS keychain, in the restricted file; or the file cannot be read. */
export const ADS_CREDENTIAL_STATES = ["none", "keychain", "file", "unreadable"] as const;
export type AdsCredentialState = (typeof ADS_CREDENTIAL_STATES)[number];

export interface AdsCredentialStatus {
  version: 1;
  saved: AdsCredentialState;
  /** Whether the OS keychain answered when this status was read (a save without consent needs it). */
  keychain: "available" | "unavailable";
  /** `~/.ads/dev_key`: whether it is there to import (never its content), and where it is looked for. */
  devKey: { exists: boolean; path: ShownPath };
}

/** The longest request body the endpoints read. */
export const ADS_CREDENTIAL_BODY_MAX_BYTES = 8192;
/** The longest token accepted, after the surrounding whitespace is removed. */
export const ADS_TOKEN_MAX_LENGTH = 1024;

/**
 * A token as the endpoints accept it, once trimmed: 1 to {@link ADS_TOKEN_MAX_LENGTH} printable ASCII characters
 * without spaces (it goes into an HTTP header). Shared by the page, which does not send what this rejects.
 */
export function isAdsTokenShaped(token: string): boolean {
  return token.length > 0 && token.length <= ADS_TOKEN_MAX_LENGTH && /^[\x21-\x7e]+$/.test(token);
}

export interface AdsTokenSaveRequest {
  token: string;
  /** Only a literal `true` — the user ticked the consent — lets the token go to the file when the keychain fails. */
  fileFallbackConsent?: boolean;
}

export interface AdsTokenImportRequest {
  fileFallbackConsent?: boolean;
}

/** A token not given: the saved one is tested. */
export interface AdsTokenTestRequest {
  token?: string;
}

export const ADS_TOKEN_TEST_OUTCOMES = [
  "valid",
  "rejected",
  "unreachable",
  "rate_limited",
] as const;
export type AdsTokenTestOutcome = (typeof ADS_TOKEN_TEST_OUTCOMES)[number];

/**
 * Why a request was refused, with its status code: `invalid_request` 400 (not the expected body), `invalid_token` 400
 * (blank, too long, or characters a token does not have; for an import: what the file holds), `keychain_unavailable`
 * 422 (no keychain and no consent to the file; or a removal that could not reach the keychain), `not_saved` 409 (a
 * test of the saved token when there is none), `no_dev_key` 404, `dev_key_unreadable` 500, `file_unreadable` 500 (the
 * restricted file is damaged), `storage_failed` 500.
 */
export const ADS_CREDENTIAL_REFUSALS = [
  "invalid_request",
  "invalid_token",
  "keychain_unavailable",
  "not_saved",
  "no_dev_key",
  "dev_key_unreadable",
  "file_unreadable",
  "storage_failed",
] as const;
export type AdsCredentialRefusal = (typeof ADS_CREDENTIAL_REFUSALS)[number];

export type AdsCredentialChangeResponse =
  | { ok: true; status: AdsCredentialStatus }
  | { ok: false; reason: AdsCredentialRefusal };

export type AdsTokenTestResponse =
  | { ok: true; result: AdsTokenTestOutcome }
  | { ok: false; reason: AdsCredentialRefusal };
