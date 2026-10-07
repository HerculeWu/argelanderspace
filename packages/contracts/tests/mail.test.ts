import { expect, test } from "vitest";
import {
  MAIL_PRESETS,
  MailAccountCreateSchema,
  MailAccountSchema,
  resolveMailConnection,
} from "../src/index.js";

test("preset hosts/ports (verified against Google and Apple docs 2026-10-07)", () => {
  expect(MAIL_PRESETS.gmail.imap).toEqual({ host: "imap.gmail.com", port: 993, security: "tls" });
  expect(MAIL_PRESETS.gmail.smtp).toEqual({ host: "smtp.gmail.com", port: 465, security: "tls" });
  expect(MAIL_PRESETS.icloud.imap).toEqual({
    host: "imap.mail.me.com",
    port: 993,
    security: "tls",
  });
  expect(MAIL_PRESETS.icloud.smtp).toEqual({
    host: "smtp.mail.me.com",
    port: 587,
    security: "starttls",
  });
});

test("resolveMailConnection: preset defaults, explicit overrides, custom missing fields by name", () => {
  const r = resolveMailConnection({ preset: "icloud", address: "a@icloud.com" });
  expect(r).toMatchObject({ ok: true, value: { imapUser: "a", smtpUser: "a@icloud.com" } });
  const o = resolveMailConnection({ preset: "gmail", address: "a@gmail.com", imapUser: "x" });
  expect(o).toMatchObject({ ok: true, value: { imapUser: "x", smtpUser: "a@gmail.com" } });
  expect(resolveMailConnection({ preset: "custom", address: "a@b.de" })).toEqual({
    ok: false,
    missing: ["imap", "smtp", "imapUser", "smtpUser"],
  });
});

test("plaintext endpoints and extra keys (e.g. a password on a stored account) are rejected", () => {
  const ep = { host: "h.test", port: 25, security: "none" };
  expect(
    MailAccountCreateSchema.safeParse({
      preset: "custom",
      displayName: "x",
      address: "a@b.de",
      password: "p",
      imap: ep,
    }).success
  ).toBe(false);
  const acc = {
    id: "acc-0123456789ab",
    displayName: "x",
    address: "a@b.de",
    preset: "custom",
    imap: { host: "h.test", port: 993, security: "tls" },
    smtp: { host: "h.test", port: 465, security: "tls" },
    imapUser: "u",
    smtpUser: "u",
    credentialRef: "acc-0123456789ab",
    credentialProtection: "keychain",
  };
  expect(MailAccountSchema.safeParse(acc).success).toBe(true);
  expect(MailAccountSchema.safeParse({ ...acc, password: "p" }).success).toBe(false);
});
