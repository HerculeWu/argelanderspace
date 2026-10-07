/**
 * Credential store (Mail ticket 02; ADR 0008). A narrow get/set/delete(accountId)
 * over the OS keychain (`@napi-rs/keyring`), plus an opt-in 0600 file under the
 * global data directory (ADR 0007) for machines whose keychain is unusable.
 *
 * Rules:
 * - The keychain is always tried first. If it fails (no Secret Service on
 *   headless Linux, locked, no native binary) the result says
 *   `keychain-unavailable`; nothing is ever written elsewhere on its own.
 * - The file is written only when the caller passes
 *   `{ fileFallbackConsent: true }` (strictly `true`), meaning the user agreed in
 *   the UI. Results then carry `keychainProtected: false` so the UI can keep
 *   flagging the account.
 * - The file is lightly encrypted (AES-256-GCM, key derived from a per-file salt
 *   and the local user/host). That only stops shoulder-surfing and casual
 *   `cat`/grep; anyone who can read the file as this user can recover it. The
 *   0600 mode is the real protection.
 * - Secrets never appear in results other than the explicit `password` of a
 *   successful `get`; failures are code-only. Backend/IO exceptions are caught
 *   and discarded (their messages may embed the secret), never rethrown or logged.
 * - Concurrency (global data, ADR 0007): the file is replaced atomically
 *   (tmp+rename) after a fresh read; two processes saving different accounts at
 *   the same instant can lose one write (last writer wins). Unlike project data
 *   this is accepted here: the user re-enters one password.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { ensureGlobalDirs, resolveGlobalDirs } from "./global-dirs.js";

export const CREDENTIAL_FILE_NAME = "credentials.json";
const KEYCHAIN_SERVICE = "argelanderspace.mail";

/** Synchronous or async; a throw means "keychain unusable". */
export interface KeychainBackend {
  get(accountId: string): string | null | Promise<string | null>;
  set(accountId: string, password: string): void | Promise<void>;
  /** true when an entry existed and was removed. */
  delete(accountId: string): boolean | Promise<boolean>;
}

/** Structural view of the native module (kept out of the package index). */
export interface NapiEntryLike {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
export interface NapiEntryOptions {
  linux: { store: "secret-service" };
}
export interface NapiKeyringModule {
  Entry: new (service: string, username: string, options?: NapiEntryOptions) => NapiEntryLike;
}

/**
 * The native module is loaded lazily so a missing prebuilt binary degrades to
 * "unavailable". On Linux the binding would otherwise fall back silently to the
 * kernel keyutils keyring (in-memory, lost on reboot, not what the user agreed
 * to), so entries are pinned to Secret Service: the constructor then throws
 * when there is none, which the store reports as `keychain-unavailable`. The
 * option is ignored on macOS and Windows.
 */
export function createNapiKeychainBackend(
  load: () => Promise<NapiKeyringModule> = () =>
    import("@napi-rs/keyring") as unknown as Promise<NapiKeyringModule>
): KeychainBackend {
  let mod: Promise<NapiKeyringModule> | undefined;
  const entry = async (accountId: string): Promise<NapiEntryLike> => {
    mod ??= load();
    const { Entry } = await mod;
    return new Entry(KEYCHAIN_SERVICE, accountId, { linux: { store: "secret-service" } });
  };
  return {
    get: async (a) => (await entry(a)).getPassword() ?? null,
    set: async (a, p) => (await entry(a)).setPassword(p),
    delete: async (a) => (await entry(a)).deletePassword(),
  };
}

export type CredentialErrorCode = "invalid-input" | "file-unreadable" | "file-write-failed";

export type GetCredentialResult =
  | { status: "ok"; password: string; protection: "keychain" | "file"; keychainProtected: boolean }
  | { status: "not-found" }
  | { status: "keychain-unavailable" }
  | { status: "error"; code: CredentialErrorCode };

export type SetCredentialResult =
  | {
      status: "stored";
      protection: "keychain" | "file";
      keychainProtected: boolean;
      /** Keychain stored it, but an older unprotected file copy could not be removed. */
      staleFileCopy?: true;
    }
  | { status: "keychain-unavailable" }
  | { status: "error"; code: CredentialErrorCode };

export type DeleteCredentialResult =
  | {
      status: "deleted";
      /**
       * Set when the keychain could not be reached: the file copy is gone, but a
       * keychain copy may still exist and was not checked.
       */
      keychainUnavailable?: true;
    }
  | { status: "not-found" }
  | { status: "keychain-unavailable" }
  | { status: "error"; code: CredentialErrorCode };

export interface SetCredentialOptions {
  /** Only a literal `true` (the user agreed in the UI) permits the file fallback. */
  fileFallbackConsent?: boolean;
}

export interface CredentialStore {
  get(accountId: string): Promise<GetCredentialResult>;
  set(
    accountId: string,
    password: string,
    opts?: SetCredentialOptions
  ): Promise<SetCredentialResult>;
  delete(accountId: string): Promise<DeleteCredentialResult>;
}

export interface CredentialStoreOptions {
  /** Defaults to the OS keychain via @napi-rs/keyring. */
  backend?: KeychainBackend;
  /** Directory for the fallback file; defaults to the global data dir (created on demand). */
  dataDir?: string;
}

// ---- fallback file ---------------------------------------------------------

interface FileEntry {
  iv: string;
  tag: string;
  ct: string;
}
interface FileDoc {
  v: 1;
  salt: string;
  entries: Map<string, FileEntry>;
}

class FileUnreadable extends Error {}

function deriveKey(salt: Buffer): Buffer {
  let who = "";
  try {
    who = `${userInfo().username}@${hostname()}`;
  } catch {
    // userInfo can throw for uid without passwd entry; the key is obfuscation only
  }
  return scryptSync(`argelanderspace.mail.credentials|${who}`, salt, 32);
}

function encrypt(doc: FileDoc, accountId: string, password: string): FileEntry {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", deriveKey(Buffer.from(doc.salt, "base64")), iv);
  c.setAAD(Buffer.from(accountId));
  const ct = Buffer.concat([c.update(password, "utf8"), c.final()]);
  return {
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function decrypt(doc: FileDoc, accountId: string, e: FileEntry): string {
  try {
    const d = createDecipheriv(
      "aes-256-gcm",
      deriveKey(Buffer.from(doc.salt, "base64")),
      Buffer.from(e.iv, "base64")
    );
    d.setAAD(Buffer.from(accountId));
    d.setAuthTag(Buffer.from(e.tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(e.ct, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new FileUnreadable();
  }
}

function isEntry(x: unknown): x is FileEntry {
  const e = x as FileEntry;
  return !!e && typeof e.iv === "string" && typeof e.tag === "string" && typeof e.ct === "string";
}

/**
 * Missing file -> null; anything malformed -> FileUnreadable (never partial contents).
 * Entries are held in a Map so account ids such as "__proto__" or "toString" are plain keys.
 */
function readDoc(path: string): FileDoc | null {
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      v?: number;
      salt?: unknown;
      entries?: unknown;
    };
    if (
      j?.v !== 1 ||
      typeof j.salt !== "string" ||
      !j.entries ||
      typeof j.entries !== "object" ||
      Array.isArray(j.entries)
    )
      throw new FileUnreadable();
    const entries = new Map<string, FileEntry>();
    for (const [k, v] of Object.entries(j.entries)) {
      if (!isEntry(v)) throw new FileUnreadable();
      entries.set(k, v);
    }
    return { v: 1, salt: j.salt, entries };
  } catch {
    throw new FileUnreadable();
  }
}

function writeDoc(path: string, doc: FileDoc): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const body = JSON.stringify({
      v: doc.v,
      salt: doc.salt,
      entries: Object.fromEntries(doc.entries),
    });
    writeFileSync(tmp, `${body}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

type RemoveOutcome = "removed" | "absent" | "unreadable" | "write-failed";

/** Remove one account's entry from the fallback file (rewrites it only when present). */
function removeFileEntry(path: string | null, accountId: string): RemoveOutcome {
  let doc: FileDoc | null;
  try {
    doc = path ? readDoc(path) : null;
  } catch {
    return "unreadable";
  }
  if (!path || !doc?.entries.has(accountId)) return "absent";
  doc.entries.delete(accountId);
  try {
    writeDoc(path, doc);
  } catch {
    return "write-failed";
  }
  return "removed";
}

// ---- store -----------------------------------------------------------------

type KeychainOutcome<T> = { ok: true; value: T } | { ok: false };

async function tryKeychain<T>(fn: () => T | Promise<T>): Promise<KeychainOutcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false }; // message may contain the secret; discard it
  }
}

export function createCredentialStore(options: CredentialStoreOptions = {}): CredentialStore {
  const backend = options.backend ?? createNapiKeychainBackend();
  const filePath = (): string => {
    const dir = options.dataDir ?? ensureGlobalDirs().dataDir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, CREDENTIAL_FILE_NAME);
  };
  /** Read-only lookups must not create directories. */
  const existingFilePath = (): string | null => {
    try {
      const dir = options.dataDir ?? resolveGlobalDirs().dataDir;
      return join(dir, CREDENTIAL_FILE_NAME);
    } catch {
      return null;
    }
  };
  const valid = (...xs: string[]) => xs.every((x) => typeof x === "string" && x.length > 0);

  return {
    async get(accountId) {
      if (!valid(accountId)) return { status: "error", code: "invalid-input" };
      const kc = await tryKeychain(() => backend.get(accountId));
      if (kc.ok && kc.value !== null) {
        return {
          status: "ok",
          password: kc.value,
          protection: "keychain",
          keychainProtected: true,
        };
      }
      try {
        const path = existingFilePath();
        const doc = path ? readDoc(path) : null;
        const e = doc?.entries.get(accountId);
        if (doc && e) {
          return {
            status: "ok",
            password: decrypt(doc, accountId, e),
            protection: "file",
            keychainProtected: false,
          };
        }
      } catch {
        return { status: "error", code: "file-unreadable" };
      }
      return kc.ok ? { status: "not-found" } : { status: "keychain-unavailable" };
    },

    async set(accountId, password, opts = {}) {
      if (!valid(accountId, password)) return { status: "error", code: "invalid-input" };
      const kc = await tryKeychain(() => backend.set(accountId, password));
      if (kc.ok) {
        // A keychain now works: drop any older file copy. Failure is reported, not hidden.
        const removed = removeFileEntry(existingFilePath(), accountId);
        if (removed === "unreadable" || removed === "write-failed") {
          return {
            status: "stored",
            protection: "keychain",
            keychainProtected: true,
            staleFileCopy: true,
          };
        }
        return { status: "stored", protection: "keychain", keychainProtected: true };
      }
      if (opts.fileFallbackConsent !== true) return { status: "keychain-unavailable" };
      let doc: FileDoc | null;
      let path: string;
      try {
        path = filePath();
      } catch {
        return { status: "error", code: "file-write-failed" };
      }
      try {
        doc = readDoc(path);
      } catch {
        return { status: "error", code: "file-unreadable" };
      }
      try {
        doc ??= { v: 1, salt: randomBytes(16).toString("base64"), entries: new Map() };
        doc.entries.set(accountId, encrypt(doc, accountId, password));
        writeDoc(path, doc);
      } catch {
        return { status: "error", code: "file-write-failed" };
      }
      return { status: "stored", protection: "file", keychainProtected: false };
    },

    async delete(accountId) {
      if (!valid(accountId)) return { status: "error", code: "invalid-input" };
      const kc = await tryKeychain(() => backend.delete(accountId));
      const removed = removeFileEntry(existingFilePath(), accountId);
      if (removed === "unreadable") return { status: "error", code: "file-unreadable" };
      if (removed === "write-failed") return { status: "error", code: "file-write-failed" };
      if (kc.ok)
        return kc.value || removed === "removed" ? { status: "deleted" } : { status: "not-found" };
      return removed === "removed"
        ? { status: "deleted", keychainUnavailable: true }
        : { status: "keychain-unavailable" };
    },
  };
}
