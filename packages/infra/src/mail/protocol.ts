/**
 * The narrow seam in front of the mail protocol libraries (spec: single-maintainer
 * risk of imapflow/nodemailer, so nothing outside this file imports them).
 * This ticket only needs "can we log in"; later tickets grow the interface.
 *
 * Results carry a failure CODE only. Library error messages and server response
 * text can embed user names, hosts or server banners, so they are discarded here
 * and never reach logs, API responses or tickets. Passwords stay inside the call.
 */

import type { ConnectionOptions } from "node:tls";
import type { MailEndpoint, MailProbeFailureCode } from "@argelanderspace/contracts";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

export interface MailLoginTarget extends MailEndpoint {
  user: string;
  password: string;
}

export type MailProbe = { ok: true } | { ok: false; code: MailProbeFailureCode };

export interface MailProtocol {
  verifyImapLogin(target: MailLoginTarget): Promise<MailProbe>;
  verifySmtpLogin(target: MailLoginTarget): Promise<MailProbe>;
}

export interface NodeMailProtocolOptions {
  /** Connect/greeting/socket timeout, default 10 s. */
  timeoutMs?: number;
  /** TLS overrides (tests pass a private CA); production leaves this unset. */
  tls?: { ca?: string | Buffer; rejectUnauthorized?: boolean; servername?: string };
}

const TLS_CODES = /CERT|SELF_SIGNED|TLS|SSL|ERR_OSSL|HOSTNAME_MISMATCH|ALTNAME/i;

/** Map an error from either library to a code; the error text is never kept. */
export function classifyMailError(error: unknown): MailProbeFailureCode {
  const e = (error ?? {}) as {
    code?: unknown;
    authenticationFailed?: unknown;
    responseStatus?: unknown;
    command?: unknown;
    message?: unknown;
  };
  const code = typeof e.code === "string" ? e.code : "";
  if (e.authenticationFailed === true || code === "EAUTH" || code === "AUTHENTICATIONFAILED")
    return "auth_failed";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EDNS" || code === "ENODATA")
    return "host_not_found";
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  )
    return "connection_refused";
  if (/TIMEOUT|TIMEDOUT/i.test(code)) return "timeout";
  if (code === "ETLS" || TLS_CODES.test(code)) return "tls_failed";
  const msg = typeof e.message === "string" ? e.message : "";
  if (/certificate|self[- ]signed|\bTLS\b|\bSSL\b/i.test(msg) && !/STARTTLS/i.test(msg))
    return "tls_failed";
  if (/STARTTLS/i.test(msg)) return "starttls_unsupported";
  if (code === "EPROTOCOL" || code === "EENVELOPE" || code === "ECONNECTION" || code === "ESOCKET")
    return "protocol_error";
  return "unknown";
}

export function createNodeMailProtocol(options: NodeMailProtocolOptions = {}): MailProtocol {
  const timeout = options.timeoutMs ?? 10_000;
  const tls: ConnectionOptions = { ...options.tls, minVersion: "TLSv1.2" };
  return {
    async verifyImapLogin(t) {
      const client = new ImapFlow({
        host: t.host,
        port: t.port,
        secure: t.security === "tls",
        doSTARTTLS: t.security === "starttls" ? true : undefined,
        auth: { user: t.user, pass: t.password },
        logger: false,
        tls,
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
        disableAutoIdle: true,
      });
      client.on("error", () => {}); // surfaced through connect(); never logged
      try {
        await client.connect();
        await client.logout().catch(() => {});
        return { ok: true };
      } catch (error) {
        client.close();
        return { ok: false, code: classifyMailError(error) };
      }
    },
    async verifySmtpLogin(t) {
      const transport = nodemailer.createTransport({
        host: t.host,
        port: t.port,
        secure: t.security === "tls",
        requireTLS: t.security === "starttls",
        auth: { user: t.user, pass: t.password },
        tls,
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: timeout,
        logger: false,
        debug: false,
      });
      try {
        await transport.verify();
        return { ok: true };
      } catch (error) {
        return { ok: false, code: classifyMailError(error) };
      } finally {
        transport.close();
      }
    },
  };
}
