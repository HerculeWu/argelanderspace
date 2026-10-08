import { expect, test } from "vitest";
import {
  MailDeleteRequestSchema,
  MailFlagRequestSchema,
  MailManageFailureCodeSchema,
  MailMoveRequestSchema,
  MailReadFailureCodeSchema,
  MailSearchCriteriaSchema,
  MailSearchRequestSchema,
} from "../src/index.js";

test("flag requests name a known flag, a message and a boolean; nothing else", () => {
  const ok = { folder: "INBOX", uid: 4, flag: "seen", value: true };
  expect(MailFlagRequestSchema.safeParse(ok).success).toBe(true);
  expect(MailFlagRequestSchema.safeParse({ ...ok, flag: "deleted" }).success).toBe(false);
  expect(MailFlagRequestSchema.safeParse({ ...ok, uid: 0 }).success).toBe(false);
  expect(MailFlagRequestSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  expect(MailFlagRequestSchema.safeParse({ ...ok, value: "yes" }).success).toBe(false);
});

test("move and delete requests are strict; permanent is optional and boolean", () => {
  expect(
    MailMoveRequestSchema.safeParse({ folder: "INBOX", uid: 1, destination: "Archive" }).success
  ).toBe(true);
  expect(MailMoveRequestSchema.safeParse({ folder: "INBOX", uid: 1 }).success).toBe(false);
  expect(MailDeleteRequestSchema.safeParse({ folder: "Trash", uid: 1 }).success).toBe(true);
  // a permanent delete must carry the uid generation; a plain delete need not
  expect(
    MailDeleteRequestSchema.safeParse({ folder: "Trash", uid: 1, permanent: true }).success
  ).toBe(false);
  expect(
    MailDeleteRequestSchema.safeParse({ folder: "Trash", uid: 1, uidValidity: 3, permanent: true })
      .success
  ).toBe(true);
  expect(
    MailDeleteRequestSchema.safeParse({ folder: "Trash", uid: 1, permanent: "true" }).success
  ).toBe(false);
});

test("search criteria need at least one term, real calendar days, and bounded terms", () => {
  expect(MailSearchCriteriaSchema.safeParse({}).success).toBe(false);
  expect(MailSearchCriteriaSchema.safeParse({ text: "   " }).success).toBe(false);
  expect(MailSearchCriteriaSchema.safeParse({ text: "euclid", since: "2026-01-31" }).success).toBe(
    true
  );
  expect(MailSearchCriteriaSchema.safeParse({ since: "31.01.2026" }).success).toBe(false);
  expect(MailSearchCriteriaSchema.safeParse({ since: "2026-13-45" }).success).toBe(false);
  // rolling dates are refused, not shifted into the next month
  expect(MailSearchCriteriaSchema.safeParse({ since: "2026-02-30" }).success).toBe(false);
  expect(MailSearchCriteriaSchema.safeParse({ before: "2025-02-29" }).success).toBe(false);
  expect(MailSearchCriteriaSchema.safeParse({ before: "2028-02-29" }).success).toBe(true);
  expect(MailSearchCriteriaSchema.safeParse({ text: "x".repeat(201) }).success).toBe(false);
  expect(MailSearchCriteriaSchema.safeParse({ text: "a", sql: "1" }).success).toBe(false);
  const req = { folder: "INBOX", criteria: { from: "ada" }, limit: 50, before: 7 };
  expect(MailSearchRequestSchema.safeParse(req).success).toBe(true);
  expect(MailSearchRequestSchema.safeParse({ ...req, limit: 101 }).success).toBe(false);
});

test("the management failure codes extend the read codes, never replace them", () => {
  for (const code of MailReadFailureCodeSchema.options)
    expect(MailManageFailureCodeSchema.options).toContain(code);
  for (const code of ["refused", "connection_lost", "confirmation_required", "not_in_trash"])
    expect(MailManageFailureCodeSchema.options).toContain(code);
});
