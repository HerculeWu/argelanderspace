/**
 * Mail accounts (Mail ticket 04; ADR 0007/0008). Global, per-user data: the
 * account list lives in the global data directory, passwords in the credential
 * store (never in these documents, requests echoes or responses).
 */

import { z } from "zod";

export const MailSecuritySchema = z.enum(["tls", "starttls"]);
export type MailSecurity = z.infer<typeof MailSecuritySchema>;

export const MailPresetIdSchema = z.enum(["gmail", "icloud", "uni-bonn", "custom"]);
export type MailPresetId = z.infer<typeof MailPresetIdSchema>;

const host = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/, "hostname");
const port = z.number().int().min(1).max(65535);

export const MailEndpointSchema = z.object({ host, port, security: MailSecuritySchema }).strict();
export type MailEndpoint = z.infer<typeof MailEndpointSchema>;

/** Safe to build file/cache paths from: generated server-side as `acc-<hex>`. */
export const MAIL_ACCOUNT_ID_PATTERN = /^acc-[0-9a-f]{12}$/;
export const MailAccountIdSchema = z.string().regex(MAIL_ACCOUNT_ID_PATTERN);

const address = z
  .string()
  .trim()
  .min(3)
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "address");
const displayName = z.string().trim().min(1).max(200);
const user = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 32));

export const MailCredentialProtectionSchema = z.enum(["keychain", "file"]);
export type MailCredentialProtection = z.infer<typeof MailCredentialProtectionSchema>;

/** One stored account. No password; `credentialRef` is the credential-store key (= id). */
export const MailAccountSchema = z
  .object({
    id: MailAccountIdSchema,
    displayName,
    address,
    preset: MailPresetIdSchema,
    imap: MailEndpointSchema,
    smtp: MailEndpointSchema,
    imapUser: user,
    smtpUser: user,
    credentialRef: MailAccountIdSchema,
    /** Where the password was last stored; "file" means not protected by the OS keychain. */
    credentialProtection: MailCredentialProtectionSchema,
  })
  .strict();
export type MailAccount = z.infer<typeof MailAccountSchema>;

export const MailAccountsFileSchema = z
  .object({
    version: z.literal(1),
    rev: z.number().int().min(0),
    accounts: z.array(MailAccountSchema),
  })
  .strict();
export type MailAccountsFile = z.infer<typeof MailAccountsFileSchema>;

// ---- presets --------------------------------------------------------------

export interface MailPreset {
  id: MailPresetId;
  imap: MailEndpoint | null;
  smtp: MailEndpoint | null;
  /** How the login names derive from the address. */
  imapUser: "address" | "local-part" | "custom";
  smtpUser: "address" | "custom";
  /** Needs an app-specific password rather than the normal account password. */
  appPassword: boolean;
}

/**
 * Hosts/ports verified against the providers' own documentation on 2026-10-07:
 * Gmail  https://developers.google.com/workspace/gmail/imap/imap-smtp
 * iCloud https://support.apple.com/en-us/102525
 * Uni Bonn comes from the spec (HRZ documentation), not re-verified here.
 */
export const MAIL_PRESETS: Readonly<Record<MailPresetId, MailPreset>> = {
  gmail: {
    id: "gmail",
    imap: { host: "imap.gmail.com", port: 993, security: "tls" },
    smtp: { host: "smtp.gmail.com", port: 465, security: "tls" },
    imapUser: "address",
    smtpUser: "address",
    appPassword: true,
  },
  icloud: {
    id: "icloud",
    imap: { host: "imap.mail.me.com", port: 993, security: "tls" },
    smtp: { host: "smtp.mail.me.com", port: 587, security: "starttls" },
    imapUser: "local-part",
    smtpUser: "address",
    appPassword: true,
  },
  "uni-bonn": {
    id: "uni-bonn",
    imap: { host: "email.uni-bonn.de", port: 993, security: "tls" },
    smtp: { host: "email.uni-bonn.de", port: 465, security: "tls" },
    imapUser: "address",
    smtpUser: "address",
    appPassword: false,
  },
  custom: {
    id: "custom",
    imap: null,
    smtp: null,
    imapUser: "custom",
    smtpUser: "custom",
    appPassword: false,
  },
};

export const MailPresetsResponseSchema = z.object({
  version: z.literal(1),
  presets: z.array(
    z.object({
      id: MailPresetIdSchema,
      imap: MailEndpointSchema.nullable(),
      smtp: MailEndpointSchema.nullable(),
      appPassword: z.boolean(),
    })
  ),
});
export type MailPresetsResponse = z.infer<typeof MailPresetsResponseSchema>;

// ---- requests -------------------------------------------------------------

const password = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !/[\0\r\n]/.test(v));

/** Connection part shared by test, add and edit. Preset fills whatever is omitted. */
const ConnectionFields = {
  preset: MailPresetIdSchema,
  address,
  imap: MailEndpointSchema.optional(),
  smtp: MailEndpointSchema.optional(),
  imapUser: user.optional(),
  smtpUser: user.optional(),
};

export const MailAccountCreateSchema = z
  .object({
    ...ConnectionFields,
    displayName,
    password,
    /** The user agreed (in the UI) to the 0600 file when the keychain is unusable. */
    fileFallbackConsent: z.boolean().optional(),
  })
  .strict();
export type MailAccountCreate = z.infer<typeof MailAccountCreateSchema>;

/** Full replacement of the editable fields; `password` only when it changes. */
export const MailAccountUpdateSchema = z
  .object({
    rev: z.number().int().min(0),
    ...ConnectionFields,
    displayName,
    password: password.optional(),
    fileFallbackConsent: z.boolean().optional(),
  })
  .strict();
export type MailAccountUpdate = z.infer<typeof MailAccountUpdateSchema>;

/** Test a draft without saving; `accountId` + no password reuses the stored one. */
export const MailAccountTestSchema = z
  .object({
    ...ConnectionFields,
    accountId: MailAccountIdSchema.optional(),
    password: password.optional(),
  })
  .strict();
export type MailAccountTest = z.infer<typeof MailAccountTestSchema>;

// ---- responses ------------------------------------------------------------

export const MailProbeFailureCodeSchema = z.enum([
  "auth_failed",
  "host_not_found",
  "connection_refused",
  "timeout",
  "tls_failed",
  "starttls_unsupported",
  "protocol_error",
  "unknown",
]);
export type MailProbeFailureCode = z.infer<typeof MailProbeFailureCodeSchema>;

export const MailProbeResultSchema = z.union([
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: MailProbeFailureCodeSchema, detail: z.string() }),
]);
export type MailProbeResult = z.infer<typeof MailProbeResultSchema>;

export const MailTestResponseSchema = z.object({
  imap: MailProbeResultSchema,
  smtp: MailProbeResultSchema,
});
export type MailTestResponse = z.infer<typeof MailTestResponseSchema>;

export const MailAccountsResponseSchema = z.object({
  version: z.literal(1),
  rev: z.number().int().min(0),
  accounts: z.array(MailAccountSchema),
});
export type MailAccountsResponse = z.infer<typeof MailAccountsResponseSchema>;

export const MailAccountMutationResponseSchema = z.object({
  rev: z.number().int().min(0),
  account: MailAccountSchema,
});
export type MailAccountMutationResponse = z.infer<typeof MailAccountMutationResponseSchema>;

export const MailWarningSchema = z.enum(["cache_not_removed"]);
export type MailWarning = z.infer<typeof MailWarningSchema>;

export const MailAccountDeleteResponseSchema = z.object({
  rev: z.number().int().min(0),
  warnings: z.array(MailWarningSchema),
});
export type MailAccountDeleteResponse = z.infer<typeof MailAccountDeleteResponseSchema>;

// ---- pure resolution ------------------------------------------------------

export type MailConnectionInput = {
  preset: MailPresetId;
  address: string;
  imap?: MailEndpoint | undefined;
  smtp?: MailEndpoint | undefined;
  imapUser?: string | undefined;
  smtpUser?: string | undefined;
};
export interface MailConnection {
  preset: MailPresetId;
  address: string;
  imap: MailEndpoint;
  smtp: MailEndpoint;
  imapUser: string;
  smtpUser: string;
}

/**
 * Fill omitted endpoints and login names from the preset. Explicit fields win
 * (a user may override a preset). Returns the missing field names when a custom
 * account lacks them; names only, never values.
 */
export function resolveMailConnection(
  input: MailConnectionInput
): { ok: true; value: MailConnection } | { ok: false; missing: string[] } {
  const p = MAIL_PRESETS[input.preset];
  const imap = input.imap ?? p.imap;
  const smtp = input.smtp ?? p.smtp;
  const local = input.address.split("@")[0] ?? input.address;
  const imapUser =
    input.imapUser ??
    (p.imapUser === "address" ? input.address : p.imapUser === "local-part" ? local : undefined);
  const smtpUser = input.smtpUser ?? (p.smtpUser === "address" ? input.address : undefined);
  const missing: string[] = [];
  if (!imap) missing.push("imap");
  if (!smtp) missing.push("smtp");
  if (!imapUser) missing.push("imapUser");
  if (!smtpUser) missing.push("smtpUser");
  if (missing.length > 0 || !imap || !smtp || !imapUser || !smtpUser) return { ok: false, missing };
  return {
    ok: true,
    value: { preset: input.preset, address: input.address, imap, smtp, imapUser, smtpUser },
  };
}
