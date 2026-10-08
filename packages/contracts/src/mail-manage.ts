/**
 * Managing mail and server-side search (Mail ticket 06; ADR 0008). Every change
 * here is made on the remote mailbox first: the server answers only after the
 * IMAP server has confirmed, and the web client rolls back whatever it showed
 * optimistically when the answer is a failure. Nothing is searched locally:
 * there is no local full-text index, the IMAP SEARCH runs on the server.
 */

import { z } from "zod";
import { MailAccountIdSchema } from "./mail.js";
import { MailHeaderSchema, MailReadFailureCodeSchema } from "./mail-read.js";

const folderPath = z.string().min(1).max(1024);
const uid = z.number().int().min(1);
const uidValidity = z.number().int().min(0);

/** Flags a user can change: `seen` is "read" (unread = not seen), `flagged` is the star. */
export const MailFlagNameSchema = z.enum(["seen", "flagged"]);
export type MailFlagName = z.infer<typeof MailFlagNameSchema>;

export const MailFlagRequestSchema = z
  .object({
    folder: folderPath,
    uid,
    /** When given and different from the server's, the uid no longer names the same message. */
    uidValidity: uidValidity.optional(),
    flag: MailFlagNameSchema,
    value: z.boolean(),
  })
  .strict();
export type MailFlagRequest = z.infer<typeof MailFlagRequestSchema>;

/** The flags as the server reports them after the change (the truth the UI settles on). */
export const MailFlagResponseSchema = z
  .object({ uid, unread: z.boolean(), starred: z.boolean() })
  .strict();
export type MailFlagResponse = z.infer<typeof MailFlagResponseSchema>;

export const MailMoveRequestSchema = z
  .object({
    folder: folderPath,
    uid,
    uidValidity: uidValidity.optional(),
    destination: folderPath,
  })
  .strict();
export type MailMoveRequest = z.infer<typeof MailMoveRequestSchema>;

/** Where the message is now; `uid` is null when the server did not report it (an undo is then impossible). */
export const MailMoveResponseSchema = z
  .object({
    destination: folderPath,
    uid: uid.nullable(),
    uidValidity: uidValidity.nullable(),
  })
  .strict();
export type MailMoveResponse = z.infer<typeof MailMoveResponseSchema>;

/**
 * Delete moves the message into the account's Trash. A message that is already in
 * Trash is removed for good only when `permanent` is true (the UI asks the user
 * first because this cannot be undone); without it the server refuses with
 * `confirmation_required` and changes nothing.
 */
export const MailDeleteRequestSchema = z
  .object({
    folder: folderPath,
    uid,
    uidValidity: uidValidity.optional(),
    permanent: z.boolean().optional(),
  })
  .strict()
  // Irreversible: the request must name the uid generation it was shown, so a rebuilt folder can never make the
  // same uid mean another message.
  .refine((v) => v.permanent !== true || v.uidValidity !== undefined, {
    path: ["uidValidity"],
    message: "uidValidity is required for a permanent delete",
  });
export type MailDeleteRequest = z.infer<typeof MailDeleteRequestSchema>;

export const MailDeleteResponseSchema = z
  .object({
    outcome: z.enum(["trashed", "deleted"]),
    /** The Trash folder and the message's new position there; null after a permanent delete. */
    destination: folderPath.nullable(),
    uid: uid.nullable(),
    uidValidity: uidValidity.nullable(),
  })
  .strict();
export type MailDeleteResponse = z.infer<typeof MailDeleteResponseSchema>;

const term = z.string().trim().min(1).max(200);
/** A real calendar day: `2026-02-30` would roll over to March, so it is refused rather than silently shifted. */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  });

/**
 * What to ask the server. `text` matches sender OR subject OR body; the other
 * fields narrow further (all given terms must match). `since` is inclusive and
 * `before` exclusive, both calendar days of the message's own Date header (IMAP SENTSINCE/SENTBEFORE; the
 * server's own time zone decides the day boundary).
 */
export const MailSearchCriteriaSchema = z
  .object({
    text: term.optional(),
    from: term.optional(),
    subject: term.optional(),
    body: term.optional(),
    since: day.optional(),
    before: day.optional(),
  })
  .strict()
  .refine((c) => Object.values(c).some((v) => v !== undefined), "empty search");
export type MailSearchCriteria = z.infer<typeof MailSearchCriteriaSchema>;

export const MailSearchRequestSchema = z
  .object({
    folder: folderPath,
    criteria: MailSearchCriteriaSchema,
    /** Page cursor: only uids below this. */
    before: uid.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type MailSearchRequest = z.infer<typeof MailSearchRequestSchema>;

export const MailSearchResponseSchema = z
  .object({
    accountId: MailAccountIdSchema,
    folder: folderPath,
    uidValidity,
    /** How many messages in the folder match (all pages). */
    matches: z.number().int().min(0),
    /** Newest first. */
    headers: z.array(MailHeaderSchema),
    nextBefore: uid.nullable(),
  })
  .strict();
export type MailSearchResponse = z.infer<typeof MailSearchResponseSchema>;

/** Failure codes of the management and search endpoints (`code` in the error body). */
export const MailManageFailureCodeSchema = z.enum([
  ...MailReadFailureCodeSchema.options,
  /** The server answered NO to the change (read-only mailbox, no permission, flag not allowed). */
  "refused",
  /** The connection broke while the command was running: the change may or may not have happened. */
  "connection_lost",
  "destination_not_found",
  "trash_not_found",
  /** Delete of a message that is already in Trash was asked without `permanent`. */
  "confirmation_required",
  /** `permanent` was asked for a message outside Trash. */
  "not_in_trash",
  /** The server lacks what a safe change needs (UIDPLUS for expunge by uid). */
  "unsupported",
  /** A copy was made in the destination but the original could not be removed: the outcome is unknown. */
  "partial",
]);
export type MailManageFailureCode = z.infer<typeof MailManageFailureCodeSchema>;
