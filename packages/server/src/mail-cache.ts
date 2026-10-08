/**
 * The mail cache in the global cache directory (ADR 0007/0008; Mail ticket 05):
 *
 *   <globalCache>/mail/<accountId>/folders.json
 *   <globalCache>/mail/<accountId>/f-<hash(folder)>/headers.json
 *   <globalCache>/mail/<accountId>/f-<hash(folder)>/<uidValidity>/<uid>.json   parsed message
 *   <globalCache>/mail/<accountId>/f-<hash(folder)>/<uidValidity>/<uid>.eml    raw source
 *
 * Everything here is disposable derived data: the remote mailbox is the
 * authority, so a missing, unreadable, truncated or schema-invalid entry is
 * simply a miss (and is removed) and the caller fetches again. Reads never
 * throw and are never reported as data errors; writes are best effort. There
 * is no locking (contracts: worst case a re-fetch). The files hold mail
 * content, so they are created 0600 in 0700 directories.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MAIL_ACCOUNT_ID_PATTERN,
  MailCachedFoldersFileSchema,
  type MailCachedHeadersFile,
  MailCachedHeadersFileSchema,
  type MailFolder,
  type MailHeader,
  type MailMessage,
  MailMessageSchema,
} from "@argelanderspace/contracts";

type CachedHeaders = MailCachedHeadersFile;
interface Schema<T> {
  parse(input: unknown): T;
}

/** Keep the newest this many headers per folder; older pages are re-fetched on demand. */
export const MAX_CACHED_HEADERS = 1000;

export class MailCache {
  /** @param root the global cache directory (the `mail` subdirectory is ours). */
  constructor(private readonly root: () => string) {}

  private accountDir(id: string): string | null {
    return MAIL_ACCOUNT_ID_PATTERN.test(id) ? join(this.root(), "mail", id) : null;
  }
  private folderDir(id: string, folder: string): string | null {
    const a = this.accountDir(id);
    if (!a) return null;
    return join(a, `f-${createHash("sha256").update(folder).digest("hex").slice(0, 24)}`);
  }
  private messageBase(id: string, folder: string, uidValidity: number, uid: number): string | null {
    const f = this.folderDir(id, folder);
    if (
      !f ||
      !Number.isSafeInteger(uidValidity) ||
      !Number.isSafeInteger(uid) ||
      uid < 1 ||
      uidValidity < 0
    )
      return null;
    return join(f, String(uidValidity), String(uid));
  }

  private read<T>(path: string, schema: Schema<T>): T | null {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return null;
    }
    try {
      return schema.parse(JSON.parse(text));
    } catch {
      this.drop(path); // truncated or from another version: discard, re-fetch
      return null;
    }
  }
  private drop(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      /* disposable */
    }
  }
  private write(path: string, data: string | Uint8Array): boolean {
    const dir = join(path, "..");
    const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, data, { mode: 0o600 });
      renameSync(tmp, path);
      return true;
    } catch {
      this.drop(tmp);
      return false;
    }
  }

  readFolders(id: string): MailFolder[] | null {
    const dir = this.accountDir(id);
    return dir
      ? (this.read(join(dir, "folders.json"), MailCachedFoldersFileSchema)?.folders ?? null)
      : null;
  }
  writeFolders(id: string, folders: MailFolder[]): void {
    const dir = this.accountDir(id);
    if (dir) this.write(join(dir, "folders.json"), JSON.stringify({ version: 1, folders }));
  }

  readHeaders(id: string, folder: string): CachedHeaders | null {
    const dir = this.folderDir(id, folder);
    const r = dir ? this.read(join(dir, "headers.json"), MailCachedHeadersFileSchema) : null;
    return r && r.folder === folder ? r : null;
  }
  /** Merge a freshly fetched page into the cached list (same UIDVALIDITY), or start over when it changed. */
  mergeHeaders(
    id: string,
    folder: string,
    uidValidity: number,
    total: number,
    page: MailHeader[]
  ): void {
    const dir = this.folderDir(id, folder);
    if (!dir) return;
    const old = this.readHeaders(id, folder);
    let kept: MailHeader[] = [];
    if (old && old.uidValidity === uidValidity) kept = old.headers;
    else if (old) this.dropGeneration(id, folder, old.uidValidity);
    const byUid = new Map<number, MailHeader>(kept.map((h) => [h.uid, h]));
    for (const h of page) byUid.set(h.uid, h);
    const headers = [...byUid.values()].sort((a, b) => b.uid - a.uid).slice(0, MAX_CACHED_HEADERS);
    this.write(
      join(dir, "headers.json"),
      JSON.stringify({ version: 1, folder, uidValidity, total, headers } satisfies CachedHeaders)
    );
  }
  /** Reflect a flag change that the server confirmed (opened message is now read). */
  markHeaderSeen(id: string, folder: string, uid: number): void {
    const old = this.readHeaders(id, folder);
    const dir = this.folderDir(id, folder);
    if (!old || !dir) return;
    this.write(
      join(dir, "headers.json"),
      JSON.stringify({
        ...old,
        headers: old.headers.map((h) => (h.uid === uid ? { ...h, unread: false } : h)),
      })
    );
  }
  dropGeneration(id: string, folder: string, uidValidity: number): void {
    const dir = this.folderDir(id, folder);
    if (dir) {
      try {
        rmSync(join(dir, String(uidValidity)), { recursive: true, force: true });
      } catch {
        /* disposable */
      }
    }
  }

  readMessage(id: string, folder: string, uidValidity: number, uid: number): MailMessage | null {
    const base = this.messageBase(id, folder, uidValidity, uid);
    return base ? this.read(`${base}.json`, MailMessageSchema) : null;
  }
  readSource(id: string, folder: string, uidValidity: number, uid: number): Buffer | null {
    const base = this.messageBase(id, folder, uidValidity, uid);
    if (!base) return null;
    try {
      return readFileSync(`${base}.eml`);
    } catch {
      return null;
    }
  }
  writeMessage(message: MailMessage, source: Buffer | null): void {
    const base = this.messageBase(
      message.accountId,
      message.folder,
      message.uidValidity,
      message.uid
    );
    if (!base) return;
    if (source) this.write(`${base}.eml`, source);
    this.write(`${base}.json`, JSON.stringify(message));
  }
  dropMessage(id: string, folder: string, uidValidity: number, uid: number): void {
    const base = this.messageBase(id, folder, uidValidity, uid);
    if (!base) return;
    this.drop(`${base}.json`);
    this.drop(`${base}.eml`);
  }

  /** Test/diagnostic helper: the account's cache entries as relative paths. */
  list(id: string): string[] {
    const dir = this.accountDir(id);
    const out: string[] = [];
    const walk = (d: string, prefix: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries)
        e.isDirectory()
          ? walk(join(d, e.name), `${prefix}${e.name}/`)
          : out.push(`${prefix}${e.name}`);
    };
    if (dir) walk(dir, "");
    return out;
  }
}
