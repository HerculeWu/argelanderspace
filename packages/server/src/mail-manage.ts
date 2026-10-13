/**
 * Managing mail and server-side search (Mail ticket 06; ADR 0008). Every change
 * goes to the IMAP server first and is answered only once the server confirmed;
 * the global cache is touched afterwards, never instead, and only to mirror what
 * the server now says (it stays disposable: a failed cache write is ignored).
 * Nothing is searched locally: SEARCH runs on the server and its results are not
 * cached. Delete moves into Trash; a message already in Trash is removed for
 * good only on an explicit `permanent` request (the UI confirms that with the
 * user first; Copilot will need a human confirmation card, ticket 09).
 * Mail content and server text never reach errors or logs.
 */

import type {
  MailDeleteRequest,
  MailDeleteResponse,
  MailFlagRequest,
  MailFlagResponse,
  MailManageFailureCode,
  MailMoveRequest,
  MailMoveResponse,
  MailSearchRequest,
  MailSearchResponse,
} from "@argelanderspace/contracts";
import { createNodeMailManage, type MailManage } from "@argelanderspace/infra";
import { type ServerLog, silentLog } from "./log.js";
import { observedMail } from "./log-observers.js";
import type { MailCache } from "./mail-cache.js";
import type { MailReadService } from "./mail-read.js";

export class MailManageError extends Error {
  readonly code: MailManageFailureCode;
  constructor(code: MailManageFailureCode) {
    super(code);
    this.code = code;
  }
}

export interface MailManageDeps {
  /** Shared with reading: account lookup, credentials and the per-account connection cap. */
  read: MailReadService;
  manage: MailManage;
  cache: MailCache;
}

export class MailManageService {
  constructor(private readonly deps: MailManageDeps) {}

  /** The uid generation the client knew, falling back to the cached list's (as opening does). */
  private known(accountId: string, folder: string, given: number | undefined) {
    return given ?? this.deps.cache.readHeaders(accountId, folder)?.uidValidity;
  }

  /**
   * The cache is disposable and is only touched AFTER the server has answered, so nothing it does may turn a
   * change the server already made into an error: a throw here would reach the client as a failed request
   * although the mailbox changed, and the client would report the wrong outcome.
   */
  private cacheBestEffort(fn: () => void) {
    try {
      fn();
    } catch {
      /* disposable */
    }
  }

  /** A server answer that proves the message is no longer where the client thinks: forget its cache. */
  private forget(accountId: string, folder: string, uidValidity: number | undefined, uid: number) {
    const { cache, read } = this.deps;
    this.cacheBestEffort(() =>
      read.ifAccountExists(accountId, () => {
        if (uidValidity !== undefined) cache.dropMessage(accountId, folder, uidValidity, uid);
        cache.removeHeader(accountId, folder, uid);
      })
    );
  }

  private fail(
    accountId: string,
    q: { folder: string; uid: number },
    known: number | undefined,
    code: MailManageFailureCode
  ): never {
    if (code === "message_not_found") this.forget(accountId, q.folder, known, q.uid);
    throw new MailManageError(code);
  }

  async flag(accountId: string, req: MailFlagRequest): Promise<MailFlagResponse> {
    const { read, manage, cache } = this.deps;
    const a = read.account(accountId);
    const known = this.known(a.id, req.folder, req.uidValidity);
    const t = await read.target(a);
    const r = await read.gate(a.id).run(() =>
      manage.setFlag(t, {
        folder: req.folder,
        uid: req.uid,
        uidValidity: known,
        flag: req.flag,
        value: req.value,
      })
    );
    if (!r.ok) return this.fail(a.id, req, known, r.code);
    this.cacheBestEffort(() =>
      read.ifAccountExists(a.id, () =>
        cache.patchHeader(a.id, req.folder, req.uid, {
          unread: r.value.unread,
          starred: r.value.starred,
        })
      )
    );
    return { uid: req.uid, unread: r.value.unread, starred: r.value.starred };
  }

  async move(accountId: string, req: MailMoveRequest): Promise<MailMoveResponse> {
    const { read, manage } = this.deps;
    if (req.destination === req.folder) throw new MailManageError("invalid_input");
    const a = read.account(accountId);
    const known = this.known(a.id, req.folder, req.uidValidity);
    const t = await read.target(a);
    const r = await read.gate(a.id).run(() =>
      manage.move(t, {
        folder: req.folder,
        uid: req.uid,
        uidValidity: known,
        destination: req.destination,
      })
    );
    if (!r.ok) return this.fail(a.id, req, known, r.code);
    this.forget(a.id, req.folder, r.value.uidValidity, req.uid);
    return {
      destination: r.value.destination,
      uid: r.value.uid,
      uidValidity: r.value.destinationUidValidity,
    };
  }

  async remove(accountId: string, req: MailDeleteRequest): Promise<MailDeleteResponse> {
    const { read, manage } = this.deps;
    const a = read.account(accountId);
    const known = this.known(a.id, req.folder, req.uidValidity);
    // An irreversible delete must name the exact uid generation: after a UIDVALIDITY change the same uid is
    // another message. The request schema already demands it; this is the same rule for any other caller.
    if (req.permanent === true && known === undefined) throw new MailManageError("invalid_input");
    const t = await read.target(a);
    const r = await read.gate(a.id).run(() =>
      manage.remove(t, {
        folder: req.folder,
        uid: req.uid,
        uidValidity: known,
        permanent: req.permanent === true,
      })
    );
    if (!r.ok) return this.fail(a.id, req, known, r.code);
    this.forget(a.id, req.folder, r.value.uidValidity, req.uid);
    return {
      outcome: r.value.outcome,
      destination: r.value.destination,
      uid: r.value.uid,
      uidValidity: r.value.destinationUidValidity,
    };
  }

  async search(accountId: string, req: MailSearchRequest): Promise<MailSearchResponse> {
    const { read, manage } = this.deps;
    const a = read.account(accountId);
    const t = await read.target(a);
    const r = await read.gate(a.id).run(() =>
      manage.search(t, {
        folder: req.folder,
        criteria: req.criteria,
        before: req.before,
        limit: req.limit ?? 50,
      })
    );
    if (!r.ok) throw new MailManageError(r.code);
    return {
      accountId: a.id,
      folder: req.folder,
      uidValidity: r.value.uidValidity,
      matches: r.value.matches,
      headers: r.value.headers.map((h) => ({ ...h })),
      nextBefore: r.value.nextBefore,
    };
  }
}

/** Production wiring: the real protocol over the reading service's account and credential access. */
export function createDefaultMailManageService(read: MailReadService, log: ServerLog = silentLog) {
  return new MailManageService({
    read,
    manage: observedMail(createNodeMailManage(), log),
    cache: read.cache,
  });
}
