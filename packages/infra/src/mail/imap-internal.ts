/**
 * INTERNAL helpers shared by the mail protocol files. Deliberately NOT exported from the package index: they
 * hand out a raw imapflow client, which nothing outside infra's mail protocol files may hold (spec: the
 * protocol library stays behind the narrow interfaces).
 */

import type { ConnectionOptions } from "node:tls";
import type { MailProbeFailureCode } from "@argelanderspace/contracts";
import { type FetchMessageObject, ImapFlow, type MessageStructureObject } from "imapflow";
import type {
  MailLoginTarget,
  MailRemoteFailure,
  RemoteAddress,
  RemoteHeader,
} from "./protocol.js";

const TLS_CODES = /CERT|SELF_SIGNED|TLS|SSL|ERR_OSSL|HOSTNAME_MISMATCH|ALTNAME/i;

/** Map an error from either library to a code; the error text is never kept. */
/**
 * Where a special-use folder conventionally lives: at the top level or directly under INBOX. imapflow also GUESSES
 * special use from a folder's name at any depth (`specialUseSource: "name"`); a guess only counts in such a place,
 * so a custom `Projects/Deleted` is never taken for the Trash (nor `Archive/Sent` for Sent).
 */
export const isConventionalPlace = (parent: string[]): boolean =>
  parent.length === 0 || (parent.length === 1 && parent[0]?.toUpperCase() === "INBOX");

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

export function imapClient(
  t: MailLoginTarget,
  timeout: number,
  tls: ConnectionOptions,
  /** Idle socket timeout; defaults to `timeout`. A server-side SEARCH may be silent for a long time. */
  socketTimeout = timeout
): ImapFlow {
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
    socketTimeout,
    disableAutoIdle: true,
  });
  client.on("error", () => {}); // surfaced through the failing call; never logged
  return client;
}

const addr = (a: { name?: string | undefined; address?: string | undefined }): RemoteAddress => ({
  name: a.name ?? "",
  address: a.address ?? "",
});

function hasAttachment(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  if (node.disposition === "inline" && node.dispositionParameters?.filename) return true;
  return (node.childNodes ?? []).some(hasAttachment);
}

export function toHeader(m: FetchMessageObject): RemoteHeader {
  const env = m.envelope;
  let date: string | null = null;
  const raw = env?.date ?? m.internalDate;
  if (raw) {
    const d = raw instanceof Date ? raw : new Date(raw);
    if (!Number.isNaN(d.getTime())) date = d.toISOString();
  }
  const from = env?.from?.[0];
  return {
    uid: m.uid,
    date,
    from: from ? addr(from) : null,
    to: (env?.to ?? []).map(addr),
    subject: env?.subject ?? "",
    unread: !m.flags?.has("\\Seen"),
    starred: m.flags?.has("\\Flagged") ?? false,
    hasAttachments: hasAttachment(m.bodyStructure),
    size: typeof m.size === "number" ? m.size : null,
  };
}

export function remoteCode(error: unknown): MailRemoteFailure {
  if ((error as { mailboxMissing?: unknown } | null)?.mailboxMissing === true)
    return "folder_not_found";
  return classifyMailError(error);
}
