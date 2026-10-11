/**
 * Every Mail failure code with its HTTP status and its Copilot tool category: the one table the read, manage,
 * compose and account routes and the Copilot's Mail tool all read (Copilot ticket 49; before, the statuses were
 * spread over four tables and the categories over four sets in mail-copilot.ts).
 *
 * The status and the category answer different questions and differ on purpose: the status is what the HTTP
 * client is told about the request, the category is what the model is told about the change (`rejected`:
 * refused, nothing changed; `unknown`: it may or may not have happened; `error`: it could not be done). So
 * `credential_missing` is 409 but `error`, `attachment_missing` 409 but `rejected`, `refused` and `unsupported`
 * 502 but `rejected`, and `partial` 502 but `error` (its state is known; the tool words it on its own).
 */
import type { MailComposeFailureCode, MailManageFailureCode } from "@argelanderspace/contracts";
import type { MailServiceErrorCode } from "./mail-accounts.js";

export type MailFailureCode = MailManageFailureCode | MailComposeFailureCode | MailServiceErrorCode;
export type MailToolCategory = "not_found" | "conflict" | "rejected" | "unknown" | "error";
export type MailHttpStatus = 400 | 404 | 409 | 413 | 422 | 500 | 502;

export interface MailFailureRow {
  http: MailHttpStatus;
  tool: MailToolCategory;
  /**
   * The fixed text the ACCOUNT routes answer with (MailServiceError); only account codes have one, and each of
   * them must. The read, manage and compose routes answer `mail request failed: <code>` for every code,
   * including `invalid_input` and `not_found`, which they share with the account routes.
   */
  detail?: string;
}
type Row<C extends MailFailureCode> = Readonly<
  C extends MailServiceErrorCode ? Required<MailFailureRow> : Omit<MailFailureRow, "detail">
>;

export const MAIL_FAILURES: { readonly [C in MailFailureCode]: Row<C> } = {
  // ---- connection and protocol (the probe codes) ---- //
  auth_failed: { http: 502, tool: "error" },
  host_not_found: { http: 502, tool: "error" },
  connection_refused: { http: 502, tool: "error" },
  timeout: { http: 502, tool: "error" },
  tls_failed: { http: 502, tool: "error" },
  starttls_unsupported: { http: 502, tool: "error" },
  protocol_error: { http: 502, tool: "error" },
  unknown: { http: 502, tool: "error" },
  // ---- reading ---- //
  folder_not_found: { http: 404, tool: "not_found" },
  message_not_found: { http: 404, tool: "not_found" },
  message_changed: { http: 409, tool: "conflict" },
  too_large: { http: 413, tool: "rejected" },
  credential_missing: { http: 409, tool: "error" },
  account_not_found: { http: 404, tool: "not_found" },
  invalid_input: { http: 400, tool: "rejected", detail: "invalid mail account input" },
  storage: { http: 500, tool: "error" },
  // ---- management ---- //
  refused: { http: 502, tool: "rejected" },
  /** The connection broke while the command was running: the change may or may not have happened. */
  connection_lost: { http: 502, tool: "unknown" },
  destination_not_found: { http: 404, tool: "not_found" },
  trash_not_found: { http: 409, tool: "rejected" },
  confirmation_required: { http: 409, tool: "rejected" },
  not_in_trash: { http: 409, tool: "rejected" },
  unsupported: { http: 502, tool: "rejected" },
  /** Known state (a copy in the destination, the original still there): not `unknown`. */
  partial: { http: 502, tool: "error" },
  // ---- writing and sending ---- //
  no_recipients: { http: 400, tool: "rejected" },
  invalid_recipient: { http: 400, tool: "rejected" },
  attachment_missing: { http: 409, tool: "rejected" },
  attachment_too_large: { http: 413, tool: "rejected" },
  drafts_unavailable: { http: 422, tool: "rejected" },
  recipient_rejected: { http: 422, tool: "rejected" },
  message_too_large: { http: 413, tool: "rejected" },
  already_pending: { http: 409, tool: "conflict" },
  already_sent: { http: 409, tool: "conflict" },
  not_found: { http: 404, tool: "not_found", detail: "mail account not found" },
  not_pending: { http: 409, tool: "conflict" },
  owned_elsewhere: { http: 409, tool: "conflict" },
  outcome_unknown: { http: 502, tool: "unknown" },
  // ---- accounts ---- //
  rev_mismatch: {
    http: 409,
    tool: "error",
    detail: "mail accounts changed elsewhere; reload and retry",
  },
  duplicate_address: {
    http: 409,
    tool: "error",
    detail: "an account with this address already exists",
  },
  connection_failed: { http: 422, tool: "error", detail: "login test failed; nothing was saved" },
  keychain_unavailable: {
    http: 422,
    tool: "error",
    detail:
      "the OS keychain is unavailable; resend with fileFallbackConsent to store the password in a restricted file",
  },
  credential_store_failed: {
    http: 500,
    tool: "error",
    detail: "the credential could not be stored or removed",
  },
};

/** True for a code of the table (own keys only: `toString` is not a code). */
export const isMailFailureCode = (code: string): code is MailFailureCode =>
  Object.hasOwn(MAIL_FAILURES, code);

export const mailHttpStatus = (code: MailFailureCode): MailHttpStatus => MAIL_FAILURES[code].http;

/** The fixed text an account route answers for a MailServiceError. */
export const mailAccountDetail = (code: MailServiceErrorCode): string => MAIL_FAILURES[code].detail;

/** The tool category of a code; a code the table does not have is a plain `error`. */
export const mailToolCategory = (code: string): MailToolCategory =>
  isMailFailureCode(code) ? MAIL_FAILURES[code].tool : "error";
