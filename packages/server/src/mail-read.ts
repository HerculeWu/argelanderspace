/**
 * Reading mail (Mail ticket 05; ADR 0008). The remote mailbox is the authority:
 * every read goes to the IMAP server first and the global cache is only a
 * disposable copy (a miss, a corrupt entry or a deleted cache directory just
 * means "fetch again"; it is never reported as a data error). A cached copy is
 * served as `stale` only when the server cannot be reached. Message content is
 * untrusted: it is parsed here but never sanitised (the web client does that)
 * and never logged. Passwords come from the credential store per call.
 */

import {
  MAIL_PAGE_MAX,
  type MailAccount,
  type MailAttachment,
  type MailFolder,
  type MailFolderRole,
  type MailFoldersResponse,
  type MailHeader,
  type MailHeadersResponse,
  type MailMessage,
  type MailOpenRequest,
  type MailOpenResponse,
  type MailReadFailureCode,
} from "@argelanderspace/contracts";
import {
  type CredentialStore,
  type MailAccountStore,
  type MailLoginTarget,
  type MailMailbox,
  parseMailSource,
  type RemoteFolder,
  type RemoteHeader,
} from "@argelanderspace/infra";
import type { MailCache } from "./mail-cache.js";

export class MailReadError extends Error {
  readonly code: MailReadFailureCode;
  constructor(code: MailReadFailureCode) {
    super(code);
    this.code = code;
  }
}

export interface MailReadDeps {
  accounts: MailAccountStore;
  credentials: CredentialStore;
  mailbox: MailMailbox;
  cache: MailCache;
  /** Largest message source fetched, default 40 MiB. */
  maxMessageBytes?: number;
}

const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;
/** Per-account cap on simultaneous IMAP connections (providers limit these). */
const CONNECTIONS_PER_ACCOUNT = 2;

const ROLE: Record<string, MailFolderRole> = {
  "\\Inbox": "inbox",
  "\\Drafts": "drafts",
  "\\Sent": "sent",
  "\\Archive": "archive",
  "\\Junk": "junk",
  "\\Trash": "trash",
  "\\All": "all",
  "\\Flagged": "flagged",
};
const ROLE_ORDER: MailFolderRole[] = [
  "inbox",
  "drafts",
  "sent",
  "archive",
  "junk",
  "trash",
  "all",
  "flagged",
  "custom",
];

/** Failures that mean "the server is unreachable" (a cached copy may stand in); the rest are real answers. */
const UNREACHABLE = new Set<MailReadFailureCode>([
  "host_not_found",
  "connection_refused",
  "timeout",
  "tls_failed",
  "starttls_unsupported",
  "protocol_error",
  "unknown",
]);

class Gate {
  private active = 0;
  private waiting: (() => void)[] = [];
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= CONNECTIONS_PER_ACCOUNT)
      await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

function toFolders(remote: RemoteFolder[]): MailFolder[] {
  const mapped = remote.map((f): MailFolder => {
    const role = (f.specialUse && ROLE[f.specialUse]) || "custom";
    const depth = f.delimiter ? Math.max(0, f.path.split(f.delimiter).length - 1) : 0;
    return {
      path: f.path,
      name: f.name,
      role,
      depth,
      selectable: f.selectable,
      unread: f.unread,
      total: f.total,
    };
  });
  // Top-level standard folders first in a fixed order, then the rest; every folder is followed by its
  // own subfolders (INBOX/Projects under INBOX, Sent/2024 under Sent) so indentation reads as a tree.
  const delim = new Map(remote.map((f) => [f.path, f.delimiter]));
  const parentOf = (f: MailFolder): string | null => {
    const d = delim.get(f.path);
    if (!d) return null;
    const i = f.path.lastIndexOf(d);
    return i > 0 ? f.path.slice(0, i) : null;
  };
  const paths = new Set(mapped.map((f) => f.path));
  const roots: MailFolder[] = [];
  const kids = new Map<string, MailFolder[]>();
  for (const f of mapped) {
    let p = parentOf(f);
    while (p !== null && !paths.has(p)) {
      const d = delim.get(f.path) ?? "/";
      const i = p.lastIndexOf(d);
      p = i > 0 ? p.slice(0, i) : null;
    }
    if (p === null) roots.push(f);
    else kids.set(p, [...(kids.get(p) ?? []), f]);
  }
  const rank = (f: MailFolder) =>
    f.role === "custom" ? ROLE_ORDER.length : ROLE_ORDER.indexOf(f.role);
  roots.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  const out: MailFolder[] = [];
  const walk = (f: MailFolder, depth: number) => {
    out.push({ ...f, depth });
    for (const c of (kids.get(f.path) ?? []).sort((a, b) => a.path.localeCompare(b.path)))
      walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

const toHeader = (h: RemoteHeader): MailHeader => ({ ...h });

export class MailReadService {
  /** The one cache instance; management reuses it instead of building another over the real cache dir. */
  get cache(): MailCache {
    return this.deps.cache;
  }
  private readonly gates = new Map<string, Gate>();
  constructor(private readonly deps: MailReadDeps) {}

  account(id: string): MailAccount {
    let found: MailAccount | undefined;
    try {
      found = this.deps.accounts.read().accounts.find((a) => a.id === id);
    } catch {
      throw new MailReadError("storage");
    }
    if (!found) throw new MailReadError("account_not_found");
    return found;
  }

  /**
   * Cache writes only while the account still exists: a delete that ran during a fetch must not have its
   * cache directory recreated (nothing would ever reclaim it). A delete in ANOTHER process between this
   * check and the write remains a tiny window (see contracts.md).
   */
  ifAccountExists(id: string, write: () => void): void {
    let exists = false;
    try {
      exists = this.deps.accounts.read().accounts.some((a) => a.id === id);
    } catch {
      exists = false;
    }
    if (exists) write();
  }

  async target(a: MailAccount): Promise<MailLoginTarget> {
    const got = await this.deps.credentials.get(a.credentialRef);
    if (got.status !== "ok") throw new MailReadError("credential_missing");
    return { ...a.imap, user: a.imapUser, password: got.password };
  }

  gate(id: string): Gate {
    const existing = this.gates.get(id);
    if (existing) return existing;
    const created = new Gate();
    this.gates.set(id, created);
    return created;
  }

  async folders(accountId: string): Promise<MailFoldersResponse> {
    const a = this.account(accountId);
    const t = await this.target(a);
    const r = await this.gate(a.id).run(() => this.deps.mailbox.listFolders(t));
    if (r.ok) {
      const folders = toFolders(r.value);
      this.ifAccountExists(a.id, () => this.deps.cache.writeFolders(a.id, folders));
      return { accountId: a.id, folders, stale: false };
    }
    const cached = UNREACHABLE.has(r.code) ? this.deps.cache.readFolders(a.id) : null;
    if (cached) return { accountId: a.id, folders: cached, stale: true };
    throw new MailReadError(r.code);
  }

  async headers(
    accountId: string,
    folder: string,
    before: number | undefined,
    limitRaw: number
  ): Promise<MailHeadersResponse> {
    const a = this.account(accountId);
    const limit = Math.max(1, Math.min(MAIL_PAGE_MAX, Math.floor(limitRaw)));
    const t = await this.target(a);
    const r = await this.gate(a.id).run(() =>
      this.deps.mailbox.listHeaders(t, { folder, before, limit })
    );
    if (r.ok) {
      const headers = r.value.headers.map(toHeader);
      this.ifAccountExists(a.id, () =>
        this.deps.cache.mergeHeaders(
          a.id,
          folder,
          r.value.uidValidity,
          r.value.total,
          headers,
          before === undefined
        )
      );
      return {
        accountId: a.id,
        folder,
        uidValidity: r.value.uidValidity,
        total: r.value.total,
        headers,
        nextBefore: r.value.nextBefore,
        stale: false,
      };
    }
    const cached = UNREACHABLE.has(r.code) ? this.deps.cache.readHeaders(a.id, folder) : null;
    if (cached) {
      const older = cached.headers.filter((h) => before === undefined || h.uid < before);
      const page = older.slice(0, limit);
      const last = page[page.length - 1];
      return {
        accountId: a.id,
        folder,
        uidValidity: cached.uidValidity,
        total: cached.total,
        headers: page,
        nextBefore: older.length > page.length && last ? last.uid : null,
        stale: true,
      };
    }
    throw new MailReadError(r.code);
  }

  private build(
    a: MailAccount,
    req: { folder: string; uid: number },
    uidValidity: number,
    parsed: Awaited<ReturnType<typeof parseMailSource>>
  ): MailMessage {
    const attachments: MailAttachment[] = parsed.attachments.map((x) => ({
      part: x.part,
      filename: x.filename,
      contentType: x.contentType,
      size: x.size,
      contentId: x.contentId,
      inline: x.inline,
    }));
    return {
      accountId: a.id,
      folder: req.folder,
      uid: req.uid,
      uidValidity,
      messageId: parsed.messageId,
      subject: parsed.subject,
      date: parsed.date,
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      text: parsed.text,
      html: parsed.html,
      attachments,
    };
  }

  /** Parse a fetched source; a source postal-mime rejects is a broken message, not a server error. */
  private async parse(source: Buffer) {
    try {
      return await parseMailSource(source);
    } catch {
      throw new MailReadError("protocol_error");
    }
  }

  async open(accountId: string, req: MailOpenRequest): Promise<MailOpenResponse> {
    const a = this.account(accountId);
    const cache = this.deps.cache;
    const known = req.uidValidity ?? cache.readHeaders(a.id, req.folder)?.uidValidity;
    const cached = known === undefined ? null : cache.readMessage(a.id, req.folder, known, req.uid);

    // Already read and cached: no connection needed (also works offline).
    if (cached && !req.unread) return { message: cached, seen: true, stale: false };

    const t = await this.target(a);
    const r = await this.gate(a.id).run(() =>
      this.deps.mailbox.openMessage(t, {
        folder: req.folder,
        uid: req.uid,
        uidValidity: known,
        wantSource: cached === null,
        markSeen: req.unread,
        maxBytes: this.deps.maxMessageBytes ?? DEFAULT_MAX_BYTES,
      })
    );
    if (!r.ok) {
      if (r.code === "message_not_found" || r.code === "message_changed") {
        if (known !== undefined) cache.dropMessage(a.id, req.folder, known, req.uid);
      }
      if (cached && UNREACHABLE.has(r.code))
        return { message: cached, seen: !req.unread, stale: true };
      throw new MailReadError(r.code);
    }
    let message = cached;
    if (r.value.source) {
      message = this.build(a, req, r.value.uidValidity, await this.parse(r.value.source));
      const toCache = message;
      const src = r.value.source;
      this.ifAccountExists(a.id, () => cache.writeMessage(toCache, src));
    }
    if (!message) throw new MailReadError("message_not_found");
    if (r.value.seen)
      this.ifAccountExists(a.id, () => cache.markHeaderSeen(a.id, req.folder, req.uid));
    return { message, seen: r.value.seen, stale: false };
  }

  /** One attachment's bytes. Does not change any flag. */
  async attachment(
    accountId: string,
    q: { folder: string; uid: number; uidValidity?: number | undefined; part: number }
  ): Promise<{ filename: string; contentType: string; content: Uint8Array }> {
    const a = this.account(accountId);
    const cache = this.deps.cache;
    const known = q.uidValidity ?? cache.readHeaders(a.id, q.folder)?.uidValidity;
    const cachedSource =
      known === undefined ? null : cache.readSource(a.id, q.folder, known, q.uid);
    const cachedMeta = known === undefined ? null : cache.readMessage(a.id, q.folder, known, q.uid);
    if (cachedSource && cachedMeta) {
      // A damaged (e.g. truncated) cached source must not yield wrong bytes: the part has to be there
      // and match the size recorded when the message was first parsed; otherwise ask the server.
      const att = (await this.parse(cachedSource).catch(() => null))?.attachments[q.part];
      if (att && att.size === cachedMeta.attachments[q.part]?.size)
        return { filename: att.filename, contentType: att.contentType, content: att.content };
    }
    const t = await this.target(a);
    const r = await this.gate(a.id).run(() =>
      this.deps.mailbox.openMessage(t, {
        folder: q.folder,
        uid: q.uid,
        uidValidity: known,
        wantSource: true,
        markSeen: false,
        maxBytes: this.deps.maxMessageBytes ?? DEFAULT_MAX_BYTES,
      })
    );
    if (!r.ok) throw new MailReadError(r.code);
    const source = r.value.source;
    if (!source) throw new MailReadError("message_not_found");
    const parsed = await this.parse(source);
    const built = this.build(a, q, r.value.uidValidity, parsed);
    this.ifAccountExists(a.id, () => cache.writeMessage(built, source));
    const att = parsed.attachments[q.part];
    if (!att) throw new MailReadError("message_not_found");
    return { filename: att.filename, contentType: att.contentType, content: att.content };
  }
}
