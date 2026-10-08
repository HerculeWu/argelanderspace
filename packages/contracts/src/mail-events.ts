/**
 * Live Mail updates (Mail ticket 08). Each workbench process keeps one IMAP
 * connection per account on its INBOX (IDLE, or polling when the server has no
 * IDLE) and pushes what it learns over `/ws`. Nothing here carries mail
 * content, addresses or server text: only counts, a watch state and a time.
 * The remote mailbox stays the authority; these counts are what the last
 * successful look at INBOX said and are refetched whenever the page needs them.
 */

import { z } from "zod";
import { MailAccountIdSchema } from "./mail.js";

/**
 * What the watcher of one account is doing:
 * `connecting` first connection or a reconnect in progress, `idle` IDLE push,
 * `polling` the server has no IDLE so INBOX is polled, `offline` the server
 * could not be reached (retrying with backoff; the last count still stands),
 * `auth_failed` the server refused the credentials (no retry until the
 * account changes), `credential_missing` the stored password is gone.
 */
export const MailWatchStateSchema = z.enum([
  "connecting",
  "idle",
  "polling",
  "offline",
  "auth_failed",
  "credential_missing",
]);
export type MailWatchState = z.infer<typeof MailWatchStateSchema>;

/** States in which the account cannot log in: its INBOX does not count towards the badge. */
export const MAIL_WATCH_BLOCKED_STATES: readonly MailWatchState[] = [
  "auth_failed",
  "credential_missing",
];

export const MailUnreadAccountSchema = z
  .object({
    accountId: MailAccountIdSchema,
    /** Unread messages in INBOX at the last successful look; null before the first one. */
    unread: z.number().int().min(0).nullable(),
    watch: MailWatchStateSchema,
  })
  .strict();
export type MailUnreadAccount = z.infer<typeof MailUnreadAccountSchema>;

/** `GET /api/mail/unread`: the sidebar badge and what to refetch after a reconnect. */
export const MailUnreadSummarySchema = z
  .object({
    version: z.literal(1),
    accounts: z.array(MailUnreadAccountSchema),
    /** Sum of INBOX unread over accounts that can log in (the badge number). */
    total: z.number().int().min(0),
  })
  .strict();
export type MailUnreadSummary = z.infer<typeof MailUnreadSummarySchema>;

/** The badge number for a list of accounts: logged-in-able accounts' INBOX only. */
export function mailUnreadTotal(accounts: readonly MailUnreadAccount[]): number {
  let total = 0;
  for (const a of accounts) {
    if (MAIL_WATCH_BLOCKED_STATES.includes(a.watch)) continue;
    total += a.unread ?? 0;
  }
  return total;
}

/**
 * Pushed when INBOX of an account changed or its watch state changed.
 * `cause`: `inbox` the mailbox contents changed (mail arrived or was expunged), `flags`
 * the server pushed a flag change (read/unread, starred, ...) with the contents unchanged, even when the
 * unread number did not move, `state` only the watch state changed (or the first look after connecting).
 */
export const WsMailChangedSchema = z.object({
  type: z.literal("mail.changed"),
  accountId: MailAccountIdSchema,
  cause: z.enum(["inbox", "flags", "state"]),
  unread: z.number().int().min(0).nullable(),
  watch: MailWatchStateSchema,
  /** ISO-8601 timestamp. */
  at: z.string(),
});
export type WsMailChanged = z.infer<typeof WsMailChangedSchema>;
