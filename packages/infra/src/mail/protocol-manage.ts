/**
 * Managing mail and server-side search over IMAP (Mail ticket 06; ADR 0008),
 * the second half of the narrow protocol seam (see protocol.ts). The remote
 * mailbox is the authority: each call changes or reads the server and answers
 * only after the server did. As elsewhere, results carry a failure CODE only;
 * server response text can embed names and hosts and is discarded here.
 *
 * imapflow reports a NO answer to STORE/MOVE/EXPUNGE as a plain `false` and
 * keeps the text to itself, so a refused change is told apart from a broken
 * connection by whether the session is still usable afterwards.
 *
 * Safety choices made here (not left to the library defaults):
 *  - a permanent delete uses UID EXPUNGE only. Plain EXPUNGE would also remove
 *    every OTHER message another client had flagged \Deleted, so a server
 *    without UIDPLUS gets `unsupported` instead;
 *  - a move on a server without MOVE is imapflow's copy + delete, which has the
 *    same hazard, so it needs UIDPLUS too;
 *  - nothing is ever deleted permanently outside the Trash folder, and an
 *    ordinary delete never falls back to a permanent one (no Trash -> error).
 */

import type { MailSearchCriteria } from "@argelanderspace/contracts";
import type { ImapFlow } from "imapflow";
import {
  imapClient,
  imapSocketOptions,
  isConventionalPlace,
  remoteCode,
  toHeader,
} from "./imap-internal.js";
import type {
  MailLoginTarget,
  MailRemoteFailure,
  NodeMailProtocolOptions,
  RemoteHeader,
} from "./protocol.js";

export type MailManageFailure =
  | MailRemoteFailure
  | "refused"
  | "connection_lost"
  | "destination_not_found"
  | "trash_not_found"
  | "confirmation_required"
  | "not_in_trash"
  | "unsupported"
  /** A copy was made in the destination but the original could not be removed (no MOVE extension). */
  | "partial";
export type MailManageResult<T> = { ok: true; value: T } | { ok: false; code: MailManageFailure };

interface MessageRef {
  folder: string;
  uid: number;
  /** When given and different from the server's, the uid no longer names the same message. */
  uidValidity?: number | undefined;
}

export interface RemoteFlags {
  uidValidity: number;
  /** Flags as the server reports them after the change. */
  unread: boolean;
  starred: boolean;
}
export interface RemoteMoved {
  /** UIDVALIDITY of the source folder (the cache generation the old uid belonged to). */
  uidValidity: number;
  destination: string;
  /** The message's uid in the destination, or null when the server did not report it. */
  uid: number | null;
  destinationUidValidity: number | null;
}
export interface RemoteDeleted {
  uidValidity: number;
  outcome: "trashed" | "deleted";
  destination: string | null;
  uid: number | null;
  destinationUidValidity: number | null;
}
export interface RemoteSearchPage {
  uidValidity: number;
  /** Messages matching, over all pages. */
  matches: number;
  /** Newest (highest uid) first. */
  headers: RemoteHeader[];
  nextBefore: number | null;
}

export interface MailManage {
  setFlag(
    t: MailLoginTarget,
    q: MessageRef & { flag: "seen" | "flagged"; value: boolean }
  ): Promise<MailManageResult<RemoteFlags>>;
  move(
    t: MailLoginTarget,
    q: MessageRef & { destination: string }
  ): Promise<MailManageResult<RemoteMoved>>;
  /** Delete: into Trash, or for good (only when `permanent` and the message is in Trash). */
  remove(
    t: MailLoginTarget,
    q: MessageRef & { permanent: boolean }
  ): Promise<MailManageResult<RemoteDeleted>>;
  search(
    t: MailLoginTarget,
    q: {
      folder: string;
      criteria: MailSearchCriteria;
      before?: number | undefined;
      limit: number;
    }
  ): Promise<MailManageResult<RemoteSearchPage>>;
}

const TRASH_NAMES = new Set([
  "trash",
  "deleted items",
  "deleted messages",
  "deleted",
  "bin",
  "papierkorb",
]);

/**
 * The special-use \Trash folder, else a conventionally named one (servers without RFC 6154). The name
 * fallback only looks at top-level folders and direct children of INBOX (where Dovecot-style servers put
 * Trash), so a custom `Projects/Deleted` can never be taken for the Trash.
 */
export function findTrashPath(
  list: {
    path: string;
    name: string;
    parent: string[];
    specialUse?: string | undefined;
    /** imapflow: "extension" (server said so), "user" or "name" (imapflow guessed from the folder name). */
    specialUseSource?: string | undefined;
    flags: Set<string>;
  }[]
): string | null {
  const usable = list.filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"));
  const conventional = (f: { parent: string[] }) => isConventionalPlace(f.parent);
  // imapflow also GUESSES special use from a folder's name, at any depth; a guess only counts where a Trash
  // conventionally lives. What the server declared (RFC 6154) counts anywhere.
  const special = usable.find(
    (f) => f.specialUse === "\\Trash" && (f.specialUseSource !== "name" || conventional(f))
  );
  if (special) return special.path;
  return usable.find((f) => conventional(f) && TRASH_NAMES.has(f.name.toLowerCase()))?.path ?? null;
}

/** imapflow search object for the criteria: `text` is sender OR subject OR body, the rest narrow. */
export interface MailSearchQuery {
  or?: MailSearchQuery[];
  from?: string;
  subject?: string;
  body?: string;
  sentSince?: Date;
  sentBefore?: Date;
}
export function searchQuery(c: MailSearchCriteria): MailSearchQuery {
  const q: MailSearchQuery = {};
  if (c.text !== undefined) q.or = [{ from: c.text }, { subject: c.text }, { body: c.text }];
  if (c.from !== undefined) q.from = c.from;
  if (c.subject !== undefined) q.subject = c.subject;
  if (c.body !== undefined) q.body = c.body;
  // SENT* match the message's own Date header, which is the date the list shows (SINCE/BEFORE would use
  // the server's arrival time, which differs for imported or delayed mail).
  if (c.since !== undefined) q.sentSince = new Date(`${c.since}T00:00:00.000Z`);
  if (c.before !== undefined) q.sentBefore = new Date(`${c.before}T00:00:00.000Z`);
  return q;
}

const usable = (client: ImapFlow) =>
  (client as unknown as { usable?: boolean }).usable !== false &&
  (client as unknown as { socket?: { destroyed?: boolean } }).socket?.destroyed !== true;

export function createNodeMailManage(
  options: NodeMailProtocolOptions & {
    /** Idle socket timeout of a SEARCH session (a server-side search can be silent for a long time). Default 60 s. */
    searchTimeoutMs?: number;
  } = {}
): MailManage {
  const timeout = options.timeoutMs ?? 10_000;
  const searchTimeout = Math.max(timeout, options.searchTimeoutMs ?? 60_000);
  const tls = imapSocketOptions(options.tls, timeout);

  /** `changing` flips to true just before the first command that modifies the mailbox. */
  interface Phase {
    changing: boolean;
  }
  async function session<T>(
    t: MailLoginTarget,
    fn: (client: ImapFlow, phase: Phase) => Promise<MailManageResult<T>>,
    socketTimeout = timeout
  ): Promise<MailManageResult<T>> {
    const client = imapClient(t, timeout, tls, socketTimeout);
    const phase: Phase = { changing: false };
    try {
      await client.connect();
      const r = await fn(client, phase);
      await client.logout().catch(() => {});
      return r;
    } catch (error) {
      client.close();
      // An error after a change was sent (even a timeout or a failed read-back) says nothing about whether
      // the server applied it: the outcome is unknown, never "timeout"/"unknown" as for a plain read.
      return { ok: false, code: phase.changing ? "connection_lost" : remoteCode(error) };
    }
  }

  /** imapflow answered `false`: a NO from a live server is a refusal, a dead session a lost connection. */
  const failed = (client: ImapFlow): { ok: false; code: MailManageFailure } => ({
    ok: false,
    code: usable(client) ? "refused" : "connection_lost",
  });

  /** Select the folder read-write and check the uid still names a message; returns its flags. */
  async function withMessage<T>(
    client: ImapFlow,
    q: MessageRef,
    fn: (state: { uidValidity: number; flags: Set<string> }) => Promise<MailManageResult<T>>
  ): Promise<MailManageResult<T>> {
    const lock = await client.getMailboxLock(q.folder);
    try {
      const box = client.mailbox;
      if (!box) return { ok: false, code: "folder_not_found" };
      const uidValidity = Number(box.uidValidity);
      if (q.uidValidity !== undefined && q.uidValidity !== uidValidity)
        return { ok: false, code: "message_changed" };
      const meta = await client.fetchOne(String(q.uid), { uid: true, flags: true }, { uid: true });
      if (!meta) return { ok: false, code: "message_not_found" };
      return await fn({ uidValidity, flags: meta.flags ?? new Set() });
    } finally {
      lock.release();
    }
  }

  /** MOVE (or COPY + UID EXPUNGE by imapflow) of one message; the folder is selected. */
  async function moveSelected(
    client: ImapFlow,
    phase: Phase,
    q: MessageRef,
    destination: string,
    uidValidity: number
  ): Promise<MailManageResult<RemoteMoved>> {
    if (!client.capabilities.has("MOVE") && !client.capabilities.has("UIDPLUS"))
      return { ok: false, code: "unsupported" };
    const known = await client.list();
    const dest = known.find((f) => f.path === destination);
    if (!dest || dest.flags.has("\\Noselect") || dest.flags.has("\\NonExistent"))
      return { ok: false, code: "destination_not_found" };
    const sid = String(q.uid);
    phase.changing = true;
    let r: { uidMap?: Map<number, number> | undefined; uidValidity?: bigint | undefined } | false;
    if (client.capabilities.has("MOVE"))
      r = await client.messageMove(sid, destination, { uid: true });
    else {
      // No MOVE extension: copy, then remove the original by UID (imapflow's own fallback cannot take back
      // the \Deleted mark when the expunge fails, and a plain EXPUNGE would hit other clients' messages).
      if (!client.capabilities.has("UIDPLUS")) return { ok: false, code: "unsupported" };
      r = await client.messageCopy(sid, destination, { uid: true });
      if (!r) return failed(client);
      const marked = await client.messageFlagsAdd(sid, ["\\Deleted"], { uid: true });
      const removed = marked && (await client.messageDelete(sid, { uid: true }));
      if (!removed) {
        const alive = usable(client);
        if (alive)
          await client.messageFlagsRemove(sid, ["\\Deleted"], { uid: true }).catch(() => false);
        // The destination now holds a copy; the original stays. Say so instead of a plain failure.
        return { ok: false, code: alive ? "partial" : "connection_lost" };
      }
    }
    if (!r) return failed(client);
    const newUid = r.uidMap?.get(q.uid);
    return {
      ok: true,
      value: {
        uidValidity,
        destination,
        uid: typeof newUid === "number" ? newUid : null,
        destinationUidValidity: r.uidValidity === undefined ? null : Number(r.uidValidity),
      },
    };
  }

  return {
    setFlag: (t, q) =>
      session(t, (client, phase) =>
        withMessage(client, q, async ({ uidValidity }) => {
          const flag = q.flag === "seen" ? "\\Seen" : "\\Flagged";
          const sid = String(q.uid);
          phase.changing = true;
          const ok = q.value
            ? await client.messageFlagsAdd(sid, [flag], { uid: true })
            : await client.messageFlagsRemove(sid, [flag], { uid: true });
          if (!ok) return failed(client);
          // Report what the server holds now, not what we asked for.
          const after = await client.fetchOne(sid, { uid: true, flags: true }, { uid: true });
          if (!after) return { ok: false, code: "message_not_found" };
          const flags = after.flags ?? new Set<string>();
          return {
            ok: true,
            value: { uidValidity, unread: !flags.has("\\Seen"), starred: flags.has("\\Flagged") },
          };
        })
      ),
    move: (t, q) =>
      session(t, (client, phase) =>
        withMessage(client, q, ({ uidValidity }) =>
          moveSelected(client, phase, q, q.destination, uidValidity)
        )
      ),
    remove: (t, q) =>
      session(t, (client, phase) =>
        withMessage<RemoteDeleted>(client, q, async ({ uidValidity }) => {
          const list = await client.list();
          const trash = findTrashPath(list);
          const inTrash = trash !== null && trash === q.folder;
          if (!q.permanent) {
            if (inTrash) return { ok: false, code: "confirmation_required" };
            if (trash === null) return { ok: false, code: "trash_not_found" };
            const moved = await moveSelected(client, phase, q, trash, uidValidity);
            if (!moved.ok) return moved;
            return { ok: true, value: { ...moved.value, outcome: "trashed" } };
          }
          if (!inTrash) return { ok: false, code: "not_in_trash" };
          if (!client.capabilities.has("UIDPLUS")) return { ok: false, code: "unsupported" };
          const sid = String(q.uid);
          phase.changing = true;
          if (!(await client.messageFlagsAdd(sid, ["\\Deleted"], { uid: true })))
            return failed(client);
          if (!(await client.messageDelete(sid, { uid: true }))) {
            const result = failed(client);
            // Do not leave the message half deleted for the next plain EXPUNGE of some client.
            if (usable(client))
              await client.messageFlagsRemove(sid, ["\\Deleted"], { uid: true }).catch(() => false);
            return result;
          }
          return {
            ok: true,
            value: {
              uidValidity,
              outcome: "deleted",
              destination: null,
              uid: null,
              destinationUidValidity: null,
            },
          };
        })
      ),
    search: (t, q) =>
      session(
        t,
        async (client) => {
          const lock = await client.getMailboxLock(q.folder, { readOnly: true });
          try {
            const box = client.mailbox;
            if (!box) return { ok: false, code: "folder_not_found" };
            const found = await client.search(searchQuery(q.criteria), { uid: true });
            // `false` is a failed SEARCH; an empty array is "no match". Telling them apart matters.
            if (found === false || found === undefined) return failed(client);
            const matching = [...new Set(found)].sort((a, b) => a - b);
            const older = matching.filter((u) => q.before === undefined || u < q.before);
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
                matches: matching.length,
                headers,
                nextBefore: older.length > page.length && oldest !== undefined ? oldest : null,
              },
            };
          } finally {
            lock.release();
          }
        },
        searchTimeout
      ),
  };
}
