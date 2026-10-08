/**
 * The narrow seam in front of the mail protocol libraries (spec: single-maintainer
 * risk of imapflow/nodemailer, so nothing outside the mail protocol files imports them).
 * This ticket only needs "can we log in"; later tickets grow the interface.
 *
 * Results carry a failure CODE only. Library error messages and server response
 * text can embed user names, hosts or server banners, so they are discarded here
 * and never reach logs, API responses or tickets. Passwords stay inside the call.
 */

import type { ConnectionOptions } from "node:tls";
import type { MailEndpoint, MailProbeFailureCode } from "@argelanderspace/contracts";
import type { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import {
  classifyMailError,
  imapClient,
  isConventionalPlace,
  remoteCode,
  toHeader,
} from "./imap-internal.js";

export { classifyMailError };

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

export function createNodeMailProtocol(options: NodeMailProtocolOptions = {}): MailProtocol {
  const timeout = options.timeoutMs ?? 10_000;
  const tls: ConnectionOptions = { ...options.tls, minVersion: "TLSv1.2" };
  return {
    async verifyImapLogin(t) {
      const client = imapClient(t, timeout, tls);
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

// ---- reading (Mail ticket 05) ----------------------------------------------

/**
 * Remote failures of the reading calls: the probe codes plus the ones only a
 * selected mailbox can produce. As for the probes, server text is never kept.
 */
export type MailRemoteFailure =
  | MailProbeFailureCode
  | "folder_not_found"
  | "message_not_found"
  | "message_changed"
  | "too_large";
export type MailResult<T> = { ok: true; value: T } | { ok: false; code: MailRemoteFailure };

export interface RemoteAddress {
  name: string;
  address: string;
}
export interface RemoteFolder {
  path: string;
  name: string;
  delimiter: string;
  /** RFC 6154 special-use attribute (e.g. "\\Sent"), "\\Inbox" for INBOX, or null. */
  specialUse: string | null;
  selectable: boolean;
  unread: number | null;
  total: number | null;
}
export interface RemoteHeader {
  uid: number;
  date: string | null;
  from: RemoteAddress | null;
  to: RemoteAddress[];
  subject: string;
  unread: boolean;
  starred: boolean;
  hasAttachments: boolean;
  size: number | null;
}
export interface RemoteHeaderPage {
  uidValidity: number;
  total: number;
  /** Newest (highest uid) first. */
  headers: RemoteHeader[];
  /** `before` for the next older page, or null. */
  nextBefore: number | null;
}
export interface RemoteOpened {
  uidValidity: number;
  /** Server flags at the time of the call, after any \\Seen update. */
  seen: boolean;
  starred: boolean;
  /** The whole RFC 822 source, or null when it was not requested. */
  source: Buffer | null;
}

export interface MailMailbox {
  listFolders(t: MailLoginTarget): Promise<MailResult<RemoteFolder[]>>;
  listHeaders(
    t: MailLoginTarget,
    q: { folder: string; before?: number | undefined; limit: number }
  ): Promise<MailResult<RemoteHeaderPage>>;
  /**
   * Fetch one message by uid without touching its flags (BODY.PEEK), then set
   * \\Seen explicitly when asked. A failed \\Seen update still returns the
   * message with `seen: false`.
   */
  openMessage(
    t: MailLoginTarget,
    q: {
      folder: string;
      uid: number;
      uidValidity?: number | undefined;
      wantSource: boolean;
      markSeen: boolean;
      maxBytes: number;
    }
  ): Promise<MailResult<RemoteOpened>>;
}

export function createNodeMailMailbox(options: NodeMailProtocolOptions = {}): MailMailbox {
  const timeout = options.timeoutMs ?? 10_000;
  const tls: ConnectionOptions = { ...options.tls, minVersion: "TLSv1.2" };
  /** Connect, run, always disconnect; any thrown error becomes a code only. */
  async function session<T>(
    t: MailLoginTarget,
    fn: (client: ImapFlow) => Promise<MailResult<T>>
  ): Promise<MailResult<T>> {
    const client = imapClient(t, timeout, tls);
    try {
      await client.connect();
      const r = await fn(client);
      await client.logout().catch(() => {});
      return r;
    } catch (error) {
      client.close();
      return { ok: false, code: remoteCode(error) };
    }
  }
  return {
    listFolders: (t) =>
      session(t, async (client) => {
        const list = await client.list({ statusQuery: { messages: true, unseen: true } });
        return {
          ok: true,
          value: list.map((f) => ({
            path: f.path,
            name: f.name,
            delimiter: f.delimiter,
            // imapflow also guesses roles from folder NAMES; a guess only counts at the top level or directly
            // under INBOX (the same rule the Trash lookup of ticket 06 uses), never for `Projects/Deleted`.
            specialUse:
              f.specialUse && !(f.specialUseSource === "name" && !isConventionalPlace(f.parent))
                ? f.specialUse
                : f.path.toUpperCase() === "INBOX"
                  ? "\\Inbox"
                  : null,
            selectable: !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"),
            unread: typeof f.status?.unseen === "number" ? f.status.unseen : null,
            total: typeof f.status?.messages === "number" ? f.status.messages : null,
          })),
        };
      }),
    listHeaders: (t, q) =>
      session(t, async (client) => {
        const lock = await client.getMailboxLock(q.folder, { readOnly: true });
        try {
          const box = client.mailbox;
          if (!box) return { ok: false, code: "folder_not_found" };
          const found = await client.search({ all: true }, { uid: true });
          // imapflow answers `false` for a failed SEARCH. That is not an empty folder: a caller that took it for
          // one would show nothing and (cache pruning) forget everything it had. Report a failure instead.
          if (found === false || found === undefined) return { ok: false, code: "protocol_error" };
          const all = found;
          const older = all
            .filter((u) => q.before === undefined || u < q.before)
            .sort((a, b) => a - b);
          const page = older.slice(-q.limit);
          let headers: RemoteHeader[] = [];
          if (page.length > 0) {
            const fetched = await client.fetchAll(
              page.join(","),
              {
                uid: true,
                flags: true,
                envelope: true,
                internalDate: true,
                size: true,
                bodyStructure: true,
              },
              { uid: true }
            );
            headers = fetched.map(toHeader).sort((a, b) => b.uid - a.uid);
          }
          const oldest = page[0];
          return {
            ok: true,
            value: {
              uidValidity: Number(box.uidValidity),
              total: box.exists,
              headers,
              nextBefore: older.length > page.length && oldest !== undefined ? oldest : null,
            },
          };
        } finally {
          lock.release();
        }
      }),
    openMessage: (t, q) =>
      session(t, async (client) => {
        const lock = await client.getMailboxLock(q.folder, { readOnly: !q.markSeen });
        try {
          const box = client.mailbox;
          if (!box) return { ok: false, code: "folder_not_found" };
          const uidValidity = Number(box.uidValidity);
          if (q.uidValidity !== undefined && q.uidValidity !== uidValidity)
            return { ok: false, code: "message_changed" };
          const meta = await client.fetchOne(
            String(q.uid),
            { uid: true, flags: true, size: true },
            { uid: true }
          );
          if (!meta) return { ok: false, code: "message_not_found" };
          if (q.wantSource && (meta.size ?? 0) > q.maxBytes)
            return { ok: false, code: "too_large" };
          let source: Buffer | null = null;
          if (q.wantSource) {
            const full = await client.fetchOne(
              String(q.uid),
              { uid: true, source: true },
              { uid: true }
            );
            // biome-ignore lint/complexity/useOptionalChain: `full` may be the literal false, which `?.` does not narrow
            if (!full || !full.source) return { ok: false, code: "message_not_found" };
            source = full.source;
          }
          let seen = meta.flags?.has("\\Seen") ?? false;
          if (!seen && q.markSeen) {
            try {
              seen =
                (await client.messageFlagsAdd(String(q.uid), ["\\Seen"], { uid: true })) === true;
            } catch {
              seen = false; // read-only mailbox or permission: the message is still shown
            }
          }
          return {
            ok: true,
            value: { uidValidity, seen, starred: meta.flags?.has("\\Flagged") ?? false, source },
          };
        } finally {
          lock.release();
        }
      }),
  };
}
