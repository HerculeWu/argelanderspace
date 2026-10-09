import type { MailReadFailureCode } from "@argelanderspace/contracts";

/**
 * The HTTP status of each read-side failure code: the one definition the read, manage and compose routes
 * extend with their own codes (closing review of Mail tickets 06-10: it used to be copied three times).
 */
export const READ_FAILURE_STATUS: Record<MailReadFailureCode, 400 | 404 | 409 | 413 | 500 | 502> = {
  auth_failed: 502,
  host_not_found: 502,
  connection_refused: 502,
  timeout: 502,
  tls_failed: 502,
  starttls_unsupported: 502,
  protocol_error: 502,
  unknown: 502,
  folder_not_found: 404,
  message_not_found: 404,
  message_changed: 409,
  too_large: 413,
  credential_missing: 409,
  account_not_found: 404,
  invalid_input: 400,
  storage: 500,
};
