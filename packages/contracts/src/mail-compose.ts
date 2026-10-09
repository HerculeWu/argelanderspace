/**
 * Writing and sending mail (Mail ticket 07; ADR 0008). A draft lives in the
 * account's server-side Drafts folder (remote authority), never as local user
 * data. Sending enters an 8 second undo window owned by exactly one server
 * process; the window's bookkeeping is a disposable marker in the global cache
 * (see docs/architecture.md "Mail 写信与发送"). Recipients, subject, body and
 * attachment names are user/third-party content: they never appear in error
 * bodies or logs.
 */

import { z } from "zod";
import {
  hasMailControlChar,
  MailAccountIdSchema,
  MailFolderPathSchema,
  type MailPresetId,
  MailProbeFailureCodeSchema,
} from "./mail.js";

/** The undo window (ADR 0008; same length as the Copilot undo window). */
export const MAIL_UNDO_WINDOW_MS = 8000;

/** Largest single attachment accepted by this server (memory bound), and the cap for one message. */
export const MAIL_ATTACHMENT_MAX_BYTES = 40 * 1024 * 1024;
export const MAIL_ATTACHMENT_TOTAL_MAX_BYTES = 50 * 1024 * 1024;
export const MAIL_ATTACHMENT_MAX_COUNT = 50;

/**
 * Per-message size limits the provider documents (bytes of the encoded message), or null when we
 * do not know. Gmail 25 MB: https://support.google.com/mail/answer/6584 . iCloud 20 MB:
 * https://support.apple.com/en-us/102338 . Not re-verified for this ticket (no network use): the
 * UI treats them as a warning, never as a block; the server's own refusal is the authority.
 */
export const MAIL_PROVIDER_LIMIT_BYTES: Readonly<Record<MailPresetId, number | null>> = {
  gmail: 25 * 1024 * 1024,
  icloud: 20 * 1024 * 1024,
  custom: null,
};

/**
 * The preset DEFAULT for whether the provider's SMTP server stores the sent message in Sent by itself (then
 * appending a copy would duplicate it); an account can override it (`MailAccount.serverSavesSent`). Gmail does. For the other presets the answer is "no" and unverified: a user
 * smoke on iCloud / the custom server settles it.
 */
export const MAIL_SERVER_SAVES_SENT: Readonly<Record<MailPresetId, boolean>> = {
  gmail: true,
  icloud: false,
  custom: false,
};

/**
 * Whether to leave the Sent copy to the provider for this account: the account's own setting if it has one,
 * else the preset's default above (closing review U1).
 */
export const mailServerSavesSent = (account: {
  preset: MailPresetId;
  serverSavesSent?: boolean | undefined;
}): boolean => account.serverSavesSent ?? MAIL_SERVER_SAVES_SENT[account.preset];

/** Base64 + MIME line breaks make attachments about 4/3 of their size on the wire. */
export const estimateMailWireBytes = (attachmentBytes: number, textBytes = 0) =>
  Math.ceil((attachmentBytes * 4) / 3) + textBytes + 2048;

/** `<local@domain>`, the identity of one draft/message across saves and the final send. */
export const MAIL_MESSAGE_ID_PATTERN = /^<[^<>\s@]{1,200}@[^<>\s@]{1,200}>$/;
/** Shape plus "no control character anywhere" (the regex alone lets \u0000-\u0008 through `\S`). */
export const isMailMessageId = (s: string) =>
  s.length <= 420 && MAIL_MESSAGE_ID_PATTERN.test(s) && !hasMailControlChar(s);
export const MailMessageIdSchema = z
  .string()
  .max(420)
  .regex(MAIL_MESSAGE_ID_PATTERN)
  .refine((v) => !hasMailControlChar(v));
export const MAIL_STAGED_ID_PATTERN = /^[0-9a-f]{32}$/;
export const MAIL_SEND_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const MailStagedAttachmentSchema = z
  .object({
    id: z.string().regex(MAIL_STAGED_ID_PATTERN),
    filename: z.string().max(1000),
    contentType: z.string().max(255),
    size: z.number().int().min(0),
  })
  .strict();
export type MailStagedAttachment = z.infer<typeof MailStagedAttachmentSchema>;

const addrText = z.string().max(8000);

/** What the composer edits. Recipient fields are free text ("Ada <a@x>, b@y"); the server parses them. */
export const MailComposeDraftSchema = z
  .object({
    messageId: MailMessageIdSchema,
    inReplyTo: MailMessageIdSchema.nullable(),
    references: z.array(MailMessageIdSchema).max(100),
    to: addrText,
    cc: addrText,
    bcc: addrText,
    subject: z.string().max(2000),
    text: z.string().max(4_000_000),
    attachments: z.array(z.string().regex(MAIL_STAGED_ID_PATTERN)).max(MAIL_ATTACHMENT_MAX_COUNT),
  })
  .strict();
export type MailComposeDraft = z.infer<typeof MailComposeDraftSchema>;

export const MailComposeModeSchema = z.enum(["reply", "replyAll", "forward", "draft"]);
export type MailComposeMode = z.infer<typeof MailComposeModeSchema>;

export const MailComposeInitRequestSchema = z
  .object({
    mode: MailComposeModeSchema,
    folder: MailFolderPathSchema,
    uid: z.number().int().min(1),
    uidValidity: z.number().int().min(0).optional(),
    /** Language of the quote header lines ("On … wrote:"); the UI language. */
    locale: z.enum(["zh-CN", "en"]),
  })
  .strict();
export type MailComposeInitRequest = z.infer<typeof MailComposeInitRequestSchema>;

/** Where the copy of a sent message went: appended by us, saved by the provider itself, or nowhere. */
export const MailSentCopySchema = z.enum(["saved", "by_server", "failed"]);
export type MailSentCopy = z.infer<typeof MailSentCopySchema>;

export const MailComposeInitResponseSchema = z
  .object({
    draft: MailComposeDraftSchema,
    attachments: z.array(MailStagedAttachmentSchema),
    /**
     * Editing a draft whose Message-ID already went out (a copy left in Drafts): it can no longer be
     * sent or saved. `sentCopy` null = unknown; "failed" = this Drafts copy may be the only record.
     */
    sent: z.object({ sentCopy: MailSentCopySchema.nullable() }).strict().optional(),
  })
  .strict();
export type MailComposeInitResponse = z.infer<typeof MailComposeInitResponseSchema>;

export const MailStageFromMessageRequestSchema = z
  .object({
    folder: MailFolderPathSchema,
    uid: z.number().int().min(1),
    uidValidity: z.number().int().min(0).optional(),
  })
  .strict();

export const MailSaveDraftResponseSchema = z
  .object({
    messageId: MailMessageIdSchema,
    savedAt: z.string(),
    folder: z.string(),
    uid: z.number().int().min(1).nullable(),
  })
  .strict();
export type MailSaveDraftResponse = z.infer<typeof MailSaveDraftResponseSchema>;

/**
 * Who started a send. The Mail page only confirms, restores and dismisses sends it started itself ("mail",
 * also what a record without the field means); a send the Copilot started ("copilot") belongs to the Copilot's
 * own card and undo bar, so the Mail page must never treat it as its own (closing review, B2).
 */
export const MailSendOriginSchema = z.enum(["mail", "copilot"]);
export type MailSendOrigin = z.infer<typeof MailSendOriginSchema>;

export const MailSendRequestSchema = z
  .object({
    /** Client-chosen, makes a repeated POST (double click, retry) the same send instead of a second one. */
    sendId: z.string().regex(MAIL_SEND_ID_PATTERN),
    draft: MailComposeDraftSchema,
    /** Set by in-process callers only; the HTTP route always starts sends as "mail". */
    origin: MailSendOriginSchema.optional(),
  })
  .strict();
export type MailSendRequest = z.infer<typeof MailSendRequestSchema>;

/**
 * Failure codes of the compose endpoints. The probe codes are connection/protocol failures; the others
 * are specific answers (a recipient the SMTP server refused, an attachment that is no longer staged, ...).
 */
export const MailComposeFailureCodeSchema = z.enum([
  ...MailProbeFailureCodeSchema.options,
  "folder_not_found",
  "message_not_found",
  "message_changed",
  "too_large",
  "credential_missing",
  "account_not_found",
  "invalid_input",
  "storage",
  "no_recipients",
  "invalid_recipient",
  "attachment_missing",
  "attachment_too_large",
  "drafts_unavailable",
  "recipient_rejected",
  "message_too_large",
  "already_pending",
  "already_sent",
  "not_found",
  "not_pending",
  "owned_elsewhere",
  "outcome_unknown",
]);
export type MailComposeFailureCode = z.infer<typeof MailComposeFailureCodeSchema>;

export const MailSendStateSchema = z.enum([
  /** In the undo window; nothing has been sent. */
  "pending",
  /** The window closed; handed to the SMTP server, outcome not yet known. */
  "sending",
  "sent",
  "cancelled",
  /** Definitely not sent (SMTP refused / unreachable); the draft is still in Drafts. */
  "failed",
  /** The server process ended inside the window: not sent, back in Drafts, never resent. */
  "interrupted",
  /** The process ended after the window closed: may or may not have been sent. */
  "unknown",
]);
export type MailSendState = z.infer<typeof MailSendStateSchema>;

export const MailSendStatusSchema = z
  .object({
    sendId: z.string().regex(MAIL_SEND_ID_PATTERN),
    accountId: MailAccountIdSchema,
    messageId: MailMessageIdSchema,
    subject: z.string().max(2000),
    state: MailSendStateSchema,
    /** Milliseconds of undo window left (pending only). */
    remainingMs: z.number().int().min(0).nullable(),
    /** Failure detail for failed / unknown. */
    code: MailComposeFailureCodeSchema.nullable(),
    /** After a successful send: where the Sent copy came from. */
    sentCopy: MailSentCopySchema.nullable(),
    /** The Drafts copy is still on the server (always true unless the send went through and was cleaned up). */
    draftKept: z.boolean(),
    /** Recipients the SMTP server refused while accepting the others (the message went to the rest). */
    rejected: z.number().int().min(0),
    /** Another server process owns this send; this one can only watch. */
    ownedElsewhere: z.boolean(),
    /** Who started it; absent means "mail". */
    origin: MailSendOriginSchema.optional(),
  })
  .strict();
export type MailSendStatus = z.infer<typeof MailSendStatusSchema>;

export const MailOutboxResponseSchema = z.object({ sends: z.array(MailSendStatusSchema) }).strict();
export type MailOutboxResponse = z.infer<typeof MailOutboxResponseSchema>;

/** On-disk marker (global cache; a mismatch is a miss, never a data error). */
export const MailOutboxMarkerSchema = z
  .object({
    version: z.literal(1),
    sendId: z.string().regex(MAIL_SEND_ID_PATTERN),
    accountId: MailAccountIdSchema,
    messageId: MailMessageIdSchema,
    subject: z.string().max(2000),
    state: z.enum(["pending", "sending", "sent", "cancelled", "failed", "interrupted"]),
    createdAt: z.number(),
    deadlineAt: z.number(),
    ownerPid: z.number().int(),
    ownerBoot: z.string().max(64),
    code: MailComposeFailureCodeSchema.nullable(),
    /** Failed with an outcome that cannot be known (e.g. connection lost after DATA). */
    ambiguous: z.boolean(),
    sentCopy: MailSentCopySchema.nullable(),
    draftKept: z.boolean(),
    rejected: z.number().int().min(0),
    /** Who started the send; a marker without it was started by the Mail page. */
    origin: MailSendOriginSchema.optional(),
  })
  .strict();
export type MailOutboxMarker = z.infer<typeof MailOutboxMarkerSchema>;
