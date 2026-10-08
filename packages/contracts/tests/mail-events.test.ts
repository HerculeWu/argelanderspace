import { expect, test } from "vitest";
import {
  MailUnreadSummarySchema,
  mailUnreadTotal,
  WsMailChangedSchema,
  WsServerMessageSchema,
} from "../src/index.js";

const a = (n: number, unread: number | null, watch: string) => ({
  accountId: `acc-${String(n).padStart(12, "0")}`,
  unread,
  watch,
});

test("the badge sums INBOX unread of accounts that can log in", () => {
  const accounts = [
    a(1, 4, "idle"),
    a(2, 10, "auth_failed"),
    a(3, 2, "offline"),
    a(4, null, "connecting"),
    a(5, 7, "credential_missing"),
    a(6, 1, "polling"),
  ] as never;
  expect(mailUnreadTotal(accounts)).toBe(7);
});

test("mail.changed is a member of the WS union and carries counts only", () => {
  const msg = {
    type: "mail.changed",
    accountId: "acc-0123456789ab",
    cause: "inbox",
    unread: 3,
    watch: "idle",
    at: "2026-10-08T10:00:00.000Z",
  };
  expect(WsServerMessageSchema.parse(msg)).toEqual(msg);
  expect(WsMailChangedSchema.safeParse({ ...msg, subject: "x" }).success).toBe(true); // unknown keys are stripped, not kept
  expect(WsMailChangedSchema.parse({ ...msg, subject: "x" })).not.toHaveProperty("subject");
  expect(WsMailChangedSchema.safeParse({ ...msg, accountId: "../etc" }).success).toBe(false);
  expect(WsMailChangedSchema.safeParse({ ...msg, watch: "weird" }).success).toBe(false);
});

test("the unread summary is strict", () => {
  const ok = { version: 1, accounts: [a(1, 2, "idle")], total: 2 };
  expect(MailUnreadSummarySchema.safeParse(ok).success).toBe(true);
  expect(MailUnreadSummarySchema.safeParse({ ...ok, total: -1 }).success).toBe(false);
  expect(MailUnreadSummarySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
});
