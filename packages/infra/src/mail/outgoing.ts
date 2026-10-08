/**
 * The write side of the mail protocol seam (Mail ticket 07): building a message
 * (nodemailer MailComposer), storing/replacing/removing a draft in the server's
 * Drafts folder (IMAP APPEND), appending a Sent copy, and handing a finished
 * message to the SMTP server. Like protocol.ts, nothing outside the infra mail
 * files imports imapflow/nodemailer, and results carry failure CODES only:
 * server text, addresses and subjects never leave this file in an error.
 * Passwords stay inside the call.
 */

import type { ConnectionOptions } from "node:tls";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser";
import MailComposer from "nodemailer/lib/mail-composer";
import {
  classifyMailError,
  type MailLoginTarget,
  type MailRemoteFailure,
  type NodeMailProtocolOptions,
} from "./protocol.js";

export interface OutAddress {
  name: string;
  address: string;
}

const hasControl = (s: string) =>
  [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const ADDRESS = /^[^\s@<>()[\],;:"\\]+@[^\s@<>()[\],;:"\\]+$/;

/** Parse "Ada <a@x>, b@y; c@z" into addresses; `ok:false` when any entry is not a plain address. */
export function parseRecipients(text: string): { ok: true; list: OutAddress[] } | { ok: false } {
  if (text.trim() === "") return { ok: true, list: [] };
  if (hasControl(text)) return { ok: false };
  const list: OutAddress[] = [];
  const walk = (items: ReturnType<typeof addressparser>): boolean => {
    for (const item of items) {
      if (item.group) {
        if (!walk(item.group)) return false;
        continue;
      }
      const address = (item.address ?? "").trim();
      if (!ADDRESS.test(address) || address.length > 254) return false;
      list.push({ name: hasControl(item.name ?? "") ? "" : (item.name ?? "").trim(), address });
    }
    return true;
  };
  if (!walk(addressparser(text.replace(/;/g, ","), { flatten: false }))) return { ok: false };
  return { ok: true, list };
}

export interface OutAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export interface ComposeInput {
  from: OutAddress;
  to: OutAddress[];
  cc: OutAddress[];
  bcc: OutAddress[];
  subject: string;
  text: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  attachments: OutAttachment[];
  date?: Date;
}
export interface ComposedMail {
  /** With the Bcc header: what the Drafts and Sent copies hold. */
  raw: Buffer;
  /** Without the Bcc header: what goes over SMTP (recipients travel in the envelope). */
  wire: Buffer;
  /** SMTP envelope sender and every recipient (to + cc + bcc). */
  envelope: { from: string; to: string[] };
}

const one = (s: string) => s.replace(/[\r\n]+/g, " ");

/** Build the RFC 822 message. Plain-text body only (rich text is out of scope for the first version). */
export async function composeMail(input: ComposeInput): Promise<ComposedMail> {
  const date = input.date ?? new Date();
  const options = () => ({
    from: { name: one(input.from.name), address: input.from.address },
    to: input.to.map((a) => ({ name: one(a.name), address: a.address })),
    cc: input.cc.map((a) => ({ name: one(a.name), address: a.address })),
    bcc: input.bcc.map((a) => ({ name: one(a.name), address: a.address })),
    subject: one(input.subject),
    text: input.text,
    messageId: input.messageId,
    date,
    ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}),
    ...(input.references.length > 0 ? { references: input.references } : {}),
    attachments: input.attachments.map((a) => ({
      filename: one(a.filename) || "attachment",
      contentType: a.contentType || "application/octet-stream",
      content: a.content,
    })),
    xMailer: false as const,
  });
  const withBcc = new MailComposer(options()).compile();
  withBcc.keepBcc = true;
  const raw = await withBcc.build();
  const wire = await new MailComposer(options()).compile().build();
  return {
    raw,
    wire,
    envelope: {
      from: input.from.address,
      to: [...input.to, ...input.cc, ...input.bcc].map((a) => a.address),
    },
  };
}

export type OutFailure =
  | MailRemoteFailure
  | "recipient_rejected"
  | "message_too_large"
  | "drafts_unavailable";
export type OutResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: OutFailure /** The message may nevertheless have been accepted. */;
      ambiguous?: boolean;
    };

export interface DraftRef {
  folder: string;
  /** Uid of the stored draft, or null when the server did not report it and it could not be found. */
  uid: number | null;
}

export interface MailOutgoing {
  /**
   * Store `raw` in Drafts, then remove OLDER copies with the same Message-ID. Only older ones (lower
   * uid) are removed, so two racing saves of one draft can never leave the folder with zero copies.
   */
  saveDraft(
    t: MailLoginTarget,
    q: { raw: Buffer; messageId: string }
  ): Promise<OutResult<DraftRef>>;
  /** Remove every copy of the draft with this Message-ID from Drafts. Nothing to remove is success. */
  deleteDraft(
    t: MailLoginTarget,
    q: { messageId: string }
  ): Promise<OutResult<{ removed: number }>>;
  /** Append `raw` to the Sent folder (flag \\Seen). */
  appendSent(t: MailLoginTarget, q: { raw: Buffer }): Promise<OutResult<{ folder: string }>>;
  /** One SMTP transaction. Never retried here or by callers: a retry could send twice. */
  sendSmtp(
    t: MailLoginTarget,
    q: { from: string; to: string[]; raw: Buffer }
  ): Promise<OutResult<{ accepted: number; rejected: number }>>;
}

const DRAFT_NAMES = ["drafts", "draft"];
const SENT_NAMES = ["sent", "sent items", "sent messages", "sent mail"];

async function findFolder(
  client: ImapFlow,
  special: string,
  names: string[]
): Promise<string | null> {
  const list = await client.list();
  const bySpecial = list.find((f) => f.specialUse === special && !f.flags.has("\\Noselect"));
  if (bySpecial) return bySpecial.path;
  const byName = list.find(
    (f) => names.includes(f.name.toLowerCase()) && !f.flags.has("\\Noselect")
  );
  return byName ? byName.path : null;
}

/**
 * `dataAccepted`: the client has sent the DATA command (or the server answered it with 354), i.e. the
 * message body may be on its way. Counting the command already is deliberate: from then on a lost
 * connection cannot be told from "accepted, the reply was lost".
 * Before that point every failure is a definite "not sent". After it, a failure without a server answer
 * (the connection dropped, a timeout, even a TLS error text) cannot be told from "accepted, the reply
 * got lost" and is reported as ambiguous. A server answer (a response code) is always definite.
 */
export function classifySmtpFailure(
  error: unknown,
  dataAccepted: boolean
): { code: OutFailure; ambiguous: boolean } {
  const e = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  const code = typeof e.code === "string" ? e.code : "";
  const responseCode = typeof e.responseCode === "number" ? e.responseCode : 0;
  if (responseCode === 552 || responseCode === 452)
    return { code: "message_too_large", ambiguous: false };
  if (code === "EENVELOPE") return { code: "recipient_rejected", ambiguous: false };
  // nodemailer wraps socket errors (ESOCKET / ECONNECTION); the cause carries the system code.
  const inner = (error as { cause?: unknown } | null)?.cause;
  const innerCode = inner ? classifyMailError(inner) : "unknown";
  const text = String((error as { message?: unknown } | null)?.message ?? ""); // classified, never kept
  const plain = /ECONNREFUSED/.test(text)
    ? "connection_refused"
    : /ENOTFOUND|EAI_AGAIN/.test(text)
      ? "host_not_found"
      : classifyMailError(error);
  const resolved = innerCode !== "unknown" && innerCode !== "protocol_error" ? innerCode : plain;
  return { code: resolved, ambiguous: dataAccepted && responseCode === 0 };
}

export function createNodeMailOutgoing(options: NodeMailProtocolOptions = {}): MailOutgoing {
  const timeout = options.timeoutMs ?? 10_000;
  const tls: ConnectionOptions = { ...options.tls, minVersion: "TLSv1.2" };

  async function session<T>(
    t: MailLoginTarget,
    fn: (client: ImapFlow) => Promise<OutResult<T>>
  ): Promise<OutResult<T>> {
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
      socketTimeout: Math.max(timeout, 60_000), // an APPEND of a large message takes a while
      disableAutoIdle: true,
    });
    client.on("error", () => {}); // surfaced through the failing call; never logged
    try {
      await client.connect();
      const r = await fn(client);
      await client.logout().catch(() => {});
      return r;
    } catch (error) {
      client.close();
      const c = classifyMailError(error);
      return {
        ok: false,
        code:
          (error as { mailboxMissing?: unknown } | null)?.mailboxMissing === true
            ? "folder_not_found"
            : c,
      };
    }
  }

  const copiesOf = async (client: ImapFlow, messageId: string): Promise<number[]> => {
    const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
    return (found || []).sort((a, b) => a - b);
  };

  return {
    saveDraft: (t, q) =>
      session(t, async (client) => {
        const path = await findFolder(client, "\\Drafts", DRAFT_NAMES);
        if (!path) return { ok: false, code: "drafts_unavailable" };
        const appended = await client.append(path, q.raw, ["\\Draft", "\\Seen"]);
        if (!appended) return { ok: false, code: "protocol_error" };
        const lock = await client.getMailboxLock(path);
        try {
          const copies = await copiesOf(client, q.messageId);
          const mine =
            typeof appended.uid === "number" ? appended.uid : (copies[copies.length - 1] ?? null);
          const older = mine === null ? [] : copies.filter((u) => u < mine);
          if (older.length > 0) await client.messageDelete(older.join(","), { uid: true });
          return { ok: true, value: { folder: path, uid: mine } };
        } finally {
          lock.release();
        }
      }),
    deleteDraft: (t, q) =>
      session(t, async (client) => {
        const path = await findFolder(client, "\\Drafts", DRAFT_NAMES);
        if (!path) return { ok: true, value: { removed: 0 } };
        const lock = await client.getMailboxLock(path);
        try {
          const copies = await copiesOf(client, q.messageId);
          if (copies.length > 0) await client.messageDelete(copies.join(","), { uid: true });
          return { ok: true, value: { removed: copies.length } };
        } finally {
          lock.release();
        }
      }),
    appendSent: (t, q) =>
      session(t, async (client) => {
        const path = await findFolder(client, "\\Sent", SENT_NAMES);
        if (!path) return { ok: false, code: "folder_not_found" };
        const appended = await client.append(path, q.raw, ["\\Seen"]);
        if (!appended) return { ok: false, code: "protocol_error" };
        return { ok: true, value: { folder: path } };
      }),
    async sendSmtp(t, q) {
      let dataAccepted = false;
      // The only use of nodemailer's protocol trace: noticing that the DATA command went out (or was
      // answered with 354). Nothing else in it (credentials, addresses, body lines) is read, kept or logged.
      const watch = (data: unknown, message: unknown) => {
        const tnx = (data as { tnx?: unknown } | null)?.tnx;
        if (typeof message !== "string") return;
        if (
          (tnx === "client" && message === "DATA") ||
          (tnx === "server" && message.startsWith("354"))
        )
          dataAccepted = true;
      };
      const transport = nodemailer.createTransport({
        host: t.host,
        port: t.port,
        secure: t.security === "tls",
        requireTLS: t.security === "starttls",
        auth: { user: t.user, pass: t.password },
        tls,
        connectionTimeout: timeout,
        greetingTimeout: timeout,
        socketTimeout: Math.max(timeout, 60_000),
        debug: true,
        logger: {
          level: () => {},
          trace: () => {},
          debug: watch,
          info: () => {},
          warn: () => {},
          error: () => {},
          fatal: () => {},
        },
      });
      try {
        const info = await transport.sendMail({
          envelope: { from: q.from, to: q.to },
          raw: q.raw,
        });
        return {
          ok: true,
          value: { accepted: info.accepted.length, rejected: info.rejected.length },
        };
      } catch (error) {
        const f = classifySmtpFailure(error, dataAccepted);
        return { ok: false, code: f.code, ...(f.ambiguous ? { ambiguous: true } : {}) };
      } finally {
        transport.close();
      }
    },
  };
}
