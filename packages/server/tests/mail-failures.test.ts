// Copilot ticket 49: one table of Mail failure codes. The five tables it replaced are copied here AS LITERALS
// (the read status table of mail-http.ts, the codes the manage and compose routes added to it, the account
// routes' status and detail tables, and the four sets of mail-copilot.ts), so the new table is checked against
// what the routes and the tool answered before, never against itself.
//
// Type level: `MAIL_FAILURES` is a `Record<MailFailureCode, ...>` literal, so a code added to a contracts enum (or
// to MailServiceErrorCode) without a row in mail-failures.ts fails `typecheck` ("Property '...' is missing"), and
// `SAME_CODES` below fails it too until the code is also added to the literal copies here.
import { describe, expect, test } from "vitest";
import { MailServiceError } from "../src/mail-accounts.js";
import { mailFailure } from "../src/mail-copilot.js";
import {
  MAIL_FAILURES,
  type MailFailureCode,
  type MailToolCategory,
  mailHttpStatus,
  mailToolCategory,
} from "../src/mail-failures.js";

// ---- the old tables, as they were (b3cf693) ----------------------------------------------------------- //

/** mail-http.ts READ_FAILURE_STATUS */
const READ_STATUS = {
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
} as const;
/** mail-manage-routes.ts STATUS, the codes added to READ_FAILURE_STATUS */
const MANAGE_STATUS = {
  refused: 502,
  connection_lost: 502,
  destination_not_found: 404,
  trash_not_found: 409,
  confirmation_required: 409,
  not_in_trash: 409,
  unsupported: 502,
  partial: 502,
} as const;
/** mail-compose-routes.ts STATUS, the codes added to READ_FAILURE_STATUS */
const COMPOSE_STATUS = {
  no_recipients: 400,
  invalid_recipient: 400,
  attachment_missing: 409,
  attachment_too_large: 413,
  drafts_unavailable: 422,
  recipient_rejected: 422,
  message_too_large: 413,
  already_pending: 409,
  already_sent: 409,
  not_found: 404,
  not_pending: 409,
  owned_elsewhere: 409,
  outcome_unknown: 502,
} as const;
/** mail-routes.ts STATUS (account routes) */
const ACCOUNT_STATUS = {
  invalid_input: 400,
  not_found: 404,
  rev_mismatch: 409,
  duplicate_address: 409,
  connection_failed: 422,
  keychain_unavailable: 422,
  credential_store_failed: 500,
} as const;
/** mail-routes.ts DETAIL (account routes) */
const ACCOUNT_DETAIL = {
  invalid_input: "invalid mail account input",
  not_found: "mail account not found",
  rev_mismatch: "mail accounts changed elsewhere; reload and retry",
  duplicate_address: "an account with this address already exists",
  connection_failed: "login test failed; nothing was saved",
  keychain_unavailable:
    "the OS keychain is unavailable; resend with fileFallbackConsent to store the password in a restricted file",
  credential_store_failed: "the credential could not be stored or removed",
} as const;
/** mail-copilot.ts NOT_FOUND / CONFLICT / REJECTED / UNKNOWN; anything else was `error`. */
const NOT_FOUND = [
  "message_not_found",
  "folder_not_found",
  "account_not_found",
  "destination_not_found",
  "not_found",
];
const CONFLICT = [
  "message_changed",
  "already_pending",
  "already_sent",
  "owned_elsewhere",
  "not_pending",
];
const REJECTED = [
  "invalid_input",
  "invalid_recipient",
  "no_recipients",
  "attachment_missing",
  "attachment_too_large",
  "message_too_large",
  "too_large",
  "drafts_unavailable",
  "recipient_rejected",
  "not_in_trash",
  "trash_not_found",
  "unsupported",
  "refused",
  "confirmation_required",
];
const UNKNOWN = ["connection_lost", "outcome_unknown"];

const oldTool = (code: string): MailToolCategory =>
  NOT_FOUND.includes(code)
    ? "not_found"
    : CONFLICT.includes(code)
      ? "conflict"
      : REJECTED.includes(code)
        ? "rejected"
        : UNKNOWN.includes(code)
          ? "unknown"
          : "error";

/** Every code with the status every old table that had it gave it (they must agree), and its old tool category. */
function oldRow(code: string): { http: number; tool: MailToolCategory; detail?: string } {
  const statuses = [READ_STATUS, MANAGE_STATUS, COMPOSE_STATUS, ACCOUNT_STATUS]
    .filter((t) => code in t)
    .map((t) => (t as Record<string, number>)[code]);
  expect(statuses.length, code).toBeGreaterThan(0);
  expect(new Set(statuses).size, `${code} has one status in every old table`).toBe(1);
  const detail = (ACCOUNT_DETAIL as Record<string, string>)[code];
  return { http: statuses[0] as number, tool: oldTool(code), ...(detail ? { detail } : {}) };
}

// The compile-time check described at the top: the codes of the old tables and MailFailureCode are the same set.
type OldCode =
  | keyof typeof READ_STATUS
  | keyof typeof MANAGE_STATUS
  | keyof typeof COMPOSE_STATUS
  | keyof typeof ACCOUNT_STATUS;
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const SAME_CODES: Same<OldCode, MailFailureCode> = true;
void SAME_CODES;
const OLD_CODES = [
  ...new Set([
    ...Object.keys(READ_STATUS),
    ...Object.keys(MANAGE_STATUS),
    ...Object.keys(COMPOSE_STATUS),
    ...Object.keys(ACCOUNT_STATUS),
  ]),
].sort();

describe("MAIL_FAILURES", () => {
  test("has exactly the codes of the old tables", () => {
    expect(Object.keys(MAIL_FAILURES).sort()).toEqual(OLD_CODES);
  });

  test.each(OLD_CODES)("%s keeps its status, tool category and detail", (code) => {
    const row = oldRow(code);
    expect(MAIL_FAILURES[code as MailFailureCode]).toEqual(row);
    expect(mailHttpStatus(code as MailFailureCode)).toBe(row.http);
    expect(mailToolCategory(code)).toBe(row.tool);
  });

  test("the four old sets name only known codes", () => {
    for (const code of [...NOT_FOUND, ...CONFLICT, ...REJECTED, ...UNKNOWN])
      expect(OLD_CODES, code).toContain(code);
  });

  test("a code no table has is an error", () => {
    expect(mailToolCategory("ENOENT")).toBe("error");
    expect(mailToolCategory("")).toBe("error");
    expect(mailToolCategory("toString")).toBe("error");
    expect(mailToolCategory("__proto__")).toBe("error");
  });
});

describe("mailFailure", () => {
  test("a Mail code keeps its code and gets its category", () => {
    expect(mailFailure(new MailServiceError("not_found"))).toEqual({
      ok: false,
      code: "not_found",
      status: "not_found",
    });
    const conn = Object.assign(new Error("x"), { code: "connection_lost" });
    expect(mailFailure(conn)).toEqual({ ok: false, code: "connection_lost", status: "unknown" });
  });

  test("no code is `unknown`; a non-Mail code passes through as it is; both are `error`", () => {
    expect(mailFailure(new Error("boom"))).toEqual({ ok: false, code: "unknown", status: "error" });
    expect(mailFailure("nope")).toEqual({ ok: false, code: "unknown", status: "error" });
    const foreign = Object.assign(new Error("x"), { code: "ENOENT" });
    expect(mailFailure(foreign)).toEqual({ ok: false, code: "ENOENT", status: "error" });
  });
});
