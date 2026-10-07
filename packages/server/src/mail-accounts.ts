/**
 * Mail account management (Mail ticket 04; ADR 0007/0008).
 *
 * Orchestrates three seams: the account store (global data, rev compare-and-swap
 * across processes), the credential store (keychain / consented file) and the
 * mail protocol port (login probes). Passwords exist only inside a call: they are
 * never stored in the account file, returned, logged, or put in error details.
 * Deleting an account removes its credential and its global cache directory and
 * never contacts the mail server (the remote mailbox is untouched).
 */

import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  MAIL_ACCOUNT_ID_PATTERN,
  type MailAccount,
  type MailAccountCreate,
  type MailAccountDeleteResponse,
  type MailAccountsResponse,
  type MailAccountTest,
  type MailAccountUpdate,
  type MailConnection,
  type MailCredentialProtection,
  type MailProbeFailureCode,
  type MailProbeResult,
  type MailTestResponse,
  type MailWarning,
  resolveMailConnection,
} from "@argelanderspace/contracts";
import {
  type CredentialStore,
  type MailAccountStore,
  type MailProtocol,
  MailRevConflict,
} from "@argelanderspace/infra";

export type MailServiceErrorCode =
  | "invalid_input"
  | "not_found"
  | "rev_mismatch"
  | "duplicate_address"
  | "connection_failed"
  | "keychain_unavailable"
  | "credential_store_failed";

export class MailServiceError extends Error {
  readonly code: MailServiceErrorCode;
  readonly extra: Record<string, unknown>;
  constructor(code: MailServiceErrorCode, extra: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.extra = extra;
  }
}

export interface MailAccountServiceDeps {
  store: MailAccountStore;
  credentials: CredentialStore;
  protocol: MailProtocol;
  /** Global cache directory; an account's cache is `<cacheDir>/mail/<id>`. */
  cacheDir: () => string;
}

const DETAIL: Record<MailProbeFailureCode, string> = {
  auth_failed: "The server rejected the user name or password.",
  host_not_found: "The server host name could not be found.",
  connection_refused: "The server refused or dropped the connection (check host and port).",
  timeout: "The server did not respond in time.",
  tls_failed: "The secure connection could not be established or the certificate is not trusted.",
  starttls_unsupported: "The server does not offer the requested STARTTLS encryption.",
  protocol_error: "The server did not answer as an IMAP/SMTP server should.",
  unknown: "The connection test failed for an unrecognised reason.",
};
const APP_PASSWORD_HINT =
  " Gmail and iCloud need an app-specific password (with 2-step verification enabled); work or school Google accounts cannot use it (use a custom account instead).";

function describe(preset: MailConnection["preset"], code: MailProbeFailureCode): MailProbeResult {
  const hint =
    code === "auth_failed" && (preset === "gmail" || preset === "icloud") ? APP_PASSWORD_HINT : "";
  return { ok: false, code, detail: DETAIL[code] + hint };
}

const sameEndpoint = (a: MailAccount["imap"], b: MailAccount["imap"]) =>
  a.host === b.host && a.port === b.port && a.security === b.security;

export class MailAccountService {
  constructor(private readonly deps: MailAccountServiceDeps) {}

  list(): MailAccountsResponse {
    return this.deps.store.read();
  }

  private connection(input: MailAccountTest | MailAccountCreate | MailAccountUpdate) {
    const r = resolveMailConnection(input);
    if (!r.ok) throw new MailServiceError("invalid_input", { fields: r.missing });
    return r.value;
  }

  private async probe(c: MailConnection, password: string): Promise<MailTestResponse> {
    const [imap, smtp] = await Promise.all([
      this.deps.protocol.verifyImapLogin({ ...c.imap, user: c.imapUser, password }),
      this.deps.protocol.verifySmtpLogin({ ...c.smtp, user: c.smtpUser, password }),
    ]);
    return {
      imap: imap.ok ? { ok: true } : describe(c.preset, imap.code),
      smtp: smtp.ok ? { ok: true } : describe(c.preset, smtp.code),
    };
  }

  private async storedPassword(accountId: string): Promise<string> {
    const got = await this.deps.credentials.get(accountId);
    if (got.status === "ok") return got.password;
    throw new MailServiceError("invalid_input", { fields: ["password"] });
  }

  async test(input: MailAccountTest): Promise<MailTestResponse> {
    const c = this.connection(input);
    let password = input.password;
    if (password === undefined && input.accountId) {
      // The stored password may only be sent to the endpoints and user names
      // it was saved for; otherwise this route could ship it to any host.
      const stored = this.deps.store.read().accounts.find((a) => a.id === input.accountId);
      if (
        !stored ||
        !sameEndpoint(stored.imap, c.imap) ||
        !sameEndpoint(stored.smtp, c.smtp) ||
        stored.imapUser !== c.imapUser ||
        stored.smtpUser !== c.smtpUser
      )
        throw new MailServiceError("invalid_input", { fields: ["password"] });
      password = await this.storedPassword(input.accountId);
    }
    if (password === undefined)
      throw new MailServiceError("invalid_input", { fields: ["password"] });
    return this.probe(c, password);
  }

  private async requireLogin(c: MailConnection, password: string): Promise<void> {
    const r = await this.probe(c, password);
    if (!r.imap.ok || !r.smtp.ok) throw new MailServiceError("connection_failed", { test: r });
  }

  private async setCredential(
    id: string,
    password: string,
    consent: boolean | undefined
  ): Promise<MailCredentialProtection> {
    const r = await this.deps.credentials.set(id, password, {
      fileFallbackConsent: consent === true,
    });
    if (r.status === "stored") return r.protection;
    if (r.status === "keychain-unavailable") throw new MailServiceError("keychain_unavailable");
    throw new MailServiceError("credential_store_failed");
  }

  async create(input: MailAccountCreate): Promise<{ rev: number; account: MailAccount }> {
    const c = this.connection(input);
    await this.requireLogin(c, input.password);
    for (let attempt = 0; ; attempt++) {
      const id = `acc-${randomBytes(6).toString("hex")}`;
      let credentialSet = false;
      try {
        const { file, result } = await this.deps.store.update(
          this.deps.store.read().rev,
          async (current) => {
            if (current.accounts.some((a) => a.address.toLowerCase() === c.address.toLowerCase()))
              throw new MailServiceError("duplicate_address");
            const protection = await this.setCredential(
              id,
              input.password,
              input.fileFallbackConsent
            );
            credentialSet = true;
            const account: MailAccount = {
              id,
              displayName: input.displayName,
              address: c.address,
              preset: c.preset,
              imap: c.imap,
              smtp: c.smtp,
              imapUser: c.imapUser,
              smtpUser: c.smtpUser,
              credentialRef: id as MailAccount["credentialRef"],
              credentialProtection: protection,
            };
            return { accounts: [...current.accounts, account], result: account };
          }
        );
        return { rev: file.rev, account: result };
      } catch (error) {
        if (credentialSet) await this.deps.credentials.delete(id).catch(() => {});
        // Another process saved between our rev read and the lock: our add is
        // independent of theirs, so retry against the new rev.
        if (error instanceof MailRevConflict && attempt < 5) continue;
        throw this.translate(error);
      }
    }
  }

  async update(
    id: string,
    input: MailAccountUpdate
  ): Promise<{ rev: number; account: MailAccount }> {
    if (!MAIL_ACCOUNT_ID_PATTERN.test(id)) throw new MailServiceError("not_found");
    const c = this.connection(input);
    const before = this.deps.store.read();
    if (before.rev !== input.rev) throw new MailServiceError("rev_mismatch", { rev: before.rev });
    const old = before.accounts.find((a) => a.id === id);
    if (!old) throw new MailServiceError("not_found");
    const connectionChanged =
      !sameEndpoint(old.imap, c.imap) ||
      !sameEndpoint(old.smtp, c.smtp) ||
      old.imapUser !== c.imapUser ||
      old.smtpUser !== c.smtpUser;
    if (input.password !== undefined || connectionChanged)
      await this.requireLogin(c, input.password ?? (await this.storedPassword(id)));
    try {
      const { file, result } = await this.deps.store.update(input.rev, async (current) => {
        const cur = current.accounts.find((a) => a.id === id);
        if (!cur) throw new MailServiceError("not_found");
        if (
          current.accounts.some(
            (a) => a.id !== id && a.address.toLowerCase() === c.address.toLowerCase()
          )
        )
          throw new MailServiceError("duplicate_address");
        const protection =
          input.password !== undefined
            ? await this.setCredential(id, input.password, input.fileFallbackConsent)
            : cur.credentialProtection;
        const account: MailAccount = {
          ...cur,
          displayName: input.displayName,
          address: c.address,
          preset: c.preset,
          imap: c.imap,
          smtp: c.smtp,
          imapUser: c.imapUser,
          smtpUser: c.smtpUser,
          credentialProtection: protection,
        };
        return {
          accounts: current.accounts.map((a) => (a.id === id ? account : a)),
          result: account,
        };
      });
      return { rev: file.rev, account: result };
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** Removes the account, its credential and its global cache. Never contacts the mail server. */
  async remove(id: string, rev: number): Promise<MailAccountDeleteResponse> {
    if (!MAIL_ACCOUNT_ID_PATTERN.test(id)) throw new MailServiceError("not_found");
    const warnings: MailWarning[] = [];
    let file: { rev: number };
    try {
      ({ file } = await this.deps.store.update(rev, async (current) => {
        if (!current.accounts.some((a) => a.id === id)) throw new MailServiceError("not_found");
        const d = await this.deps.credentials.delete(id);
        // An unreachable keychain may still hold the password: refuse, so the
        // account (and its id) stays and the delete can be retried.
        if (
          d.status === "error" ||
          d.status === "keychain-unavailable" ||
          (d.status === "deleted" && d.keychainUnavailable)
        )
          throw new MailServiceError("credential_store_failed");
        return { accounts: current.accounts.filter((a) => a.id !== id), result: null };
      }));
    } catch (error) {
      throw this.translate(error);
    }
    try {
      await rm(join(this.deps.cacheDir(), "mail", id), { recursive: true, force: true });
    } catch {
      warnings.push("cache_not_removed"); // cache is disposable derived data
    }
    return { rev: file.rev, warnings };
  }

  private translate(error: unknown): unknown {
    if (error instanceof MailRevConflict)
      return new MailServiceError("rev_mismatch", { rev: error.currentRev });
    return error;
  }
}
