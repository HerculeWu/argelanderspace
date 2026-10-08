/**
 * Reading mail (Mail ticket 05; ADR 0008). The remote mailbox is the only
 * authority: everything here describes what the server told us, and the local
 * copies behind these shapes are a disposable cache. Message bodies, subjects
 * and addresses are untrusted external content.
 */

import { z } from "zod";
import { MailAccountIdSchema, MailProbeFailureCodeSchema } from "./mail.js";

export const MailFolderRoleSchema = z.enum([
  "inbox",
  "drafts",
  "sent",
  "archive",
  "junk",
  "trash",
  "all",
  "flagged",
  "custom",
]);
export type MailFolderRole = z.infer<typeof MailFolderRoleSchema>;

const folderPath = z.string().min(1).max(1024);

export const MailFolderSchema = z
  .object({
    /** The IMAP mailbox path, verbatim (used to address the folder in later calls). */
    path: folderPath,
    /** Last path segment as the server names it; the UI localises standard roles. */
    name: z.string().max(512),
    role: MailFolderRoleSchema,
    depth: z.number().int().min(0),
    selectable: z.boolean(),
    unread: z.number().int().min(0).nullable(),
    total: z.number().int().min(0).nullable(),
  })
  .strict();
export type MailFolder = z.infer<typeof MailFolderSchema>;

export const MailFoldersResponseSchema = z
  .object({
    accountId: MailAccountIdSchema,
    folders: z.array(MailFolderSchema),
    /** True when the server could not be reached and this is the last cached listing. */
    stale: z.boolean(),
  })
  .strict();
export type MailFoldersResponse = z.infer<typeof MailFoldersResponseSchema>;

export const MailAddressSchema = z
  .object({ name: z.string().max(1000), address: z.string().max(1000) })
  .strict();
export type MailAddress = z.infer<typeof MailAddressSchema>;

export const MailHeaderSchema = z
  .object({
    uid: z.number().int().min(1),
    /** ISO 8601 UTC, or null when the server gave no usable date. */
    date: z.string().nullable(),
    from: MailAddressSchema.nullable(),
    to: z.array(MailAddressSchema),
    subject: z.string().max(10_000),
    unread: z.boolean(),
    starred: z.boolean(),
    hasAttachments: z.boolean(),
    size: z.number().int().min(0).nullable(),
  })
  .strict();
export type MailHeader = z.infer<typeof MailHeaderSchema>;

export const MAIL_PAGE_DEFAULT = 50;
export const MAIL_PAGE_MAX = 100;

export const MailHeadersResponseSchema = z
  .object({
    accountId: MailAccountIdSchema,
    folder: folderPath,
    uidValidity: z.number().int().min(0),
    /** Messages in the folder on the server (or in the cache when stale). */
    total: z.number().int().min(0),
    /** Newest first. */
    headers: z.array(MailHeaderSchema),
    /** Pass as `before` for the next older page; null when this was the last one. */
    nextBefore: z.number().int().min(1).nullable(),
    stale: z.boolean(),
  })
  .strict();
export type MailHeadersResponse = z.infer<typeof MailHeadersResponseSchema>;

export const MailAttachmentSchema = z
  .object({
    /** Index among the message's attachments (stable for one message source). */
    part: z.number().int().min(0),
    filename: z.string().max(1000),
    contentType: z.string().max(255),
    size: z.number().int().min(0),
    /** Content-ID without angle brackets, for `cid:` references from the HTML body. */
    contentId: z.string().max(1000).nullable(),
    /** Embedded in the HTML body rather than offered as a file. */
    inline: z.boolean(),
  })
  .strict();
export type MailAttachment = z.infer<typeof MailAttachmentSchema>;

export const MailMessageSchema = z
  .object({
    accountId: MailAccountIdSchema,
    folder: folderPath,
    uid: z.number().int().min(1),
    uidValidity: z.number().int().min(0),
    messageId: z.string().max(2000).nullable(),
    subject: z.string().max(10_000),
    date: z.string().nullable(),
    from: MailAddressSchema.nullable(),
    to: z.array(MailAddressSchema),
    cc: z.array(MailAddressSchema),
    replyTo: z.array(MailAddressSchema),
    /** Untrusted. Shown as plain text only. */
    text: z.string().nullable(),
    /** Untrusted and NOT sanitised: the web client sanitises before display. */
    html: z.string().nullable(),
    attachments: z.array(MailAttachmentSchema),
  })
  .strict();
export type MailMessage = z.infer<typeof MailMessageSchema>;

export const MailOpenRequestSchema = z
  .object({
    folder: folderPath,
    uid: z.number().int().min(1),
    /** When given and different from the server's, the uid no longer names the same message. */
    uidValidity: z.number().int().min(0).optional(),
    /** The list said it was unread: connect and set \Seen. When false a cached body is served offline. */
    unread: z.boolean(),
  })
  .strict();
export type MailOpenRequest = z.infer<typeof MailOpenRequestSchema>;

export const MailOpenResponseSchema = z
  .object({
    message: MailMessageSchema,
    /** The message carries \Seen on the server after this call. */
    seen: z.boolean(),
    /** Served from the cache because the server could not be reached. */
    stale: z.boolean(),
  })
  .strict();
export type MailOpenResponse = z.infer<typeof MailOpenResponseSchema>;

/** Failure codes of the read endpoints (`code` in the error body). */
export const MailReadFailureCodeSchema = z.enum([
  ...MailProbeFailureCodeSchema.options,
  "folder_not_found",
  "message_not_found",
  "message_changed",
  "too_large",
  "credential_missing",
  "account_not_found",
  "invalid_input",
  "storage",
]);
export type MailReadFailureCode = z.infer<typeof MailReadFailureCodeSchema>;

/** On-disk shapes of the disposable cache files (global cache dir); a mismatch is a cache miss, never an error. */
export const MailCachedFoldersFileSchema = z
  .object({ version: z.literal(1), folders: z.array(MailFolderSchema) })
  .strict();
export const MailCachedHeadersFileSchema = z
  .object({
    version: z.literal(1),
    folder: z.string(),
    uidValidity: z.number().int().min(0),
    total: z.number().int().min(0),
    headers: z.array(MailHeaderSchema),
  })
  .strict();
export type MailCachedHeadersFile = z.infer<typeof MailCachedHeadersFileSchema>;
