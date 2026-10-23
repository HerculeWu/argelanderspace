/**
 * The Shelf (文献仓) store (shelf ticket 01; ADR 0013; contracts「文献仓」): global data in `<global data>/shelf/`.
 * Format, file rule and the envelope every format keeps: contracts `shelf.ts`; layout and reasons:
 * docs/architecture.md「数据与配置」.
 *
 *   shelf/
 *   ├── shelf.lock/                 the cross-process write lock (proper-lockfile)
 *   ├── entries/<entry id>.r<rev>/  one entry: entry.json + docs/, annotations/, argument-graph.json, note.md
 *   ├── staging/<…>/                an entry being written (never read)
 *   └── trash/<…>/                  an entry being removed (never read)
 *
 * This module never reads or writes a project's dataDir: `put` takes the files as bytes the caller has already
 * read and chosen, and `read` hands bytes back.
 *
 * Writes (`put`, `delete`) run inside the cross-process lock, with asynchronous I/O only, so that proper-lockfile's
 * timer keeps the lock fresh while they work. Before every step that changes what readers see (renaming an entry
 * into place, moving one into trash) the write checks that the lock is still its own: lost — taken over as stale
 * by another process, or not provably kept fresh — it stops, removes what it staged, reports `lock_lost`, and does
 * not release (and so does not remove) a lock directory that is no longer its own.
 *
 * An entry is written whole under `staging/` and renamed into `entries/` under a name no entry has
 * (`<id>.r<rev+1>` for a replacement), so it appears whole or not at all. A replacement removes the old directories
 * only once the new one is in place; a delete renames the entry into `trash/` (it disappears at once) and removes it
 * from there. A failure before the rename removes the staged directory and leaves every entry as it was; a failure
 * while removing an old directory leaves a superseded directory that readers ignore (the highest rev of an id wins)
 * and the next write clears.
 *
 * Reads take no lock. Every file of an entry is immutable once it is in place, so a reader either reads the bytes
 * the manifest names or finds the file gone; `read`/`verify` check every file against the manifest and, when one is
 * missing, look again to tell an entry replaced or deleted meanwhile (`changed` / `not_found`) from a damaged one.
 * A file that cannot be read for another reason (permissions, I/O) is a system error: `read`/`verify` throw
 * {@link ShelfIoError}, `list` reports the entry as `unreadable` — never as damaged, never as absent.
 *
 * An entry of a format this build does not know is listed (status `incompatible`), never read, and never rewritten
 * (a replacement refuses it, tidying leaves its whole id alone); only a delete removes it (the caller asks first).
 */

import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  SHELF_DOC_ID_RE,
  SHELF_ENTRY_ID_RE,
  SHELF_FORMAT,
  type ShelfBibliography,
  ShelfBibliographySchema,
  type ShelfDoc,
  type ShelfDocKind,
  type ShelfIdentity,
  type ShelfManifest,
  ShelfManifestSchema,
  shelfDocFileAllowed,
  shelfDocRequiredFiles,
} from "@argelanderspace/contracts";
import { arxivFromDoi, normArxiv, normDoi } from "@argelanderspace/core";
import lockfile from "proper-lockfile";
import { type GlobalDirsOptions, resolveGlobalDirs } from "../global-dirs.js";

export const SHELF_DIR = "shelf";
export const SHELF_LOCK = "shelf.lock";
export const SHELF_MANIFEST_FILE = "entry.json";
export const SHELF_ARGUMENT_GRAPH_FILE = "argument-graph.json";
export const SHELF_NOTE_FILE = "note.md";

/** The Shelf directory in the global data directory. Like `resolveGlobalDirs`, touches nothing but (maybe) config.toml. */
export function resolveShelfDir(opts: GlobalDirsOptions = {}): string {
  return join(resolveGlobalDirs(opts).dataDir, SHELF_DIR);
}

// ---- results ------------------------------------------------------------------------------------------------

/** Why an entry of this build's format cannot be used. A category, never content. */
export type ShelfDamage =
  | "not_a_directory"
  | "manifest_missing"
  | "manifest_not_a_file"
  | "manifest_unreadable"
  | "manifest_invalid"
  | "manifest_mismatch"
  | "file_missing"
  | "file_changed"
  | "file_unexpected";

/** An entry of this build's format, as its manifest says (files not checked). */
export interface ShelfEntry {
  entryId: string;
  rev: number;
  /** Bytes on disk: the manifest plus every file it names. */
  bytes: number;
  manifest: ShelfManifest;
}

export type ShelfListItem =
  | ({ status: "ok" } & ShelfEntry)
  | {
      status: "incompatible";
      entryId: string;
      rev: number;
      bytes: number;
      /** The `format` the entry declares, as found (whatever its type). */
      format: unknown;
      /** `bibliography.title` when the entry has a string there; for display only. */
      title: string | null;
    }
  /** The entry's manifest says it is broken (`problem` is what was found). `list` does not hash: see `verify`. */
  | { status: "damaged"; entryId: string; rev: number; bytes: number; problem: ShelfDamage }
  /**
   * A system error (permissions, I/O, too many open files) kept the entry from being looked at: not damage, the
   * entry may be fine. `code` is the error's code only. `bytes` is 0 (not measured).
   */
  | { status: "unreadable"; entryId: string; rev: number; bytes: 0; code: string };

export type ShelfIdentityKey = keyof ShelfIdentity;

export type ShelfCheck =
  | { status: "ok"; entry: ShelfEntry }
  | { status: "not_found" }
  /** The entry's rev is not the one asked for (it was replaced). */
  | { status: "changed"; rev: number }
  | { status: "incompatible"; rev: number }
  | { status: "damaged"; rev: number; problem: ShelfDamage };

export interface ShelfDocContent {
  docId: string;
  kind: ShelfDocKind;
  /** In manifest order, every one checked against its size and SHA-256. */
  files: { path: string; bytes: Buffer }[];
  annotations: { count: number; bytes: Buffer } | null;
}

export type ShelfRead =
  | {
      status: "ok";
      entry: ShelfEntry;
      docs: ShelfDocContent[];
      argumentGraph: Buffer | null;
      note: string | null;
    }
  | Exclude<ShelfCheck, { status: "ok" }>;

export interface ShelfDocInput {
  docId: string;
  kind: ShelfDocKind;
  /** Relative paths as under the project's `output/<docId>/`; each must pass contracts `shelfDocFileAllowed`. */
  files: { path: string; bytes: Uint8Array }[];
  /** The annotation copy (a whole annotations file, already filtered to the chosen annotations), or null. */
  annotations: { count: number; bytes: Uint8Array } | null;
}

export interface ShelfPutInput {
  bibliography: ShelfBibliography;
  source: { project: string; workId: string };
  /** In the Work's order, primary first. May be empty. */
  docs: ShelfDocInput[];
  /** The argument graph file's bytes, or null when not carried. */
  argumentGraph: Uint8Array | null;
  /** The Work's note, or null when not carried. */
  note: string | null;
}

export interface ShelfEntryRef {
  entryId: string;
  rev: number;
}

/**
 * `new`: a new entry; refused when any entry is the same paper. `replace`: the new content takes the place of
 * exactly the entries that are the same paper (what an `identity_taken` named), each at the rev the person
 * confirmed. The new entry keeps the first target's id (its rev + 1); the other targets are removed once it is in
 * place.
 */
export type ShelfPutTarget = { mode: "new" } | { mode: "replace"; targets: ShelfEntryRef[] };

export type ShelfPutResult =
  | { ok: true; entry: ShelfEntry }
  /**
   * The entries that are the same paper (DOI, arXiv or OpenAlex id), at their current revs: for `new`, any; for
   * `replace`, when they are not exactly the targets. Confirm replacing these and send them as the targets.
   */
  | { ok: false; reason: "identity_taken"; entries: ShelfEntryRef[] }
  | { ok: false; reason: "not_found"; entryId: string }
  | { ok: false; reason: "rev_mismatch"; entryId: string; currentRev: number }
  /** A target is of a format this build does not know: it is never rewritten. */
  | { ok: false; reason: "incompatible"; entryId: string; currentRev: number }
  /** A target is damaged: its identity is unknown, so it can only be deleted. */
  | { ok: false; reason: "damaged"; entryId: string; problem: ShelfDamage }
  /** Another process holds the lock and did not let go in time. Nothing was written. */
  | { ok: false; reason: "busy" }
  /**
   * The lock stopped being this process's while the write ran, and the write stopped. `written` is null when no
   * entry was changed; otherwise the new entry is in place but old directories of the targets may remain (a target
   * other than the first may then still be listed beside it).
   */
  | { ok: false; reason: "lock_lost"; written: ShelfEntryRef | null };

export type ShelfDeleteResult =
  | { ok: true }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "rev_mismatch"; currentRev: number }
  | { ok: false; reason: "busy" }
  /** The lock stopped being this process's before the entry was removed; the entry is still there. */
  | { ok: false; reason: "lock_lost" };

/** The input to `put` is not an entry (a caller's mistake); nothing was written. */
export class ShelfInputError extends Error {}
/** A file could not be read for a reason other than its absence (permissions, I/O). Never reported as damage. */
export class ShelfIoError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(`shelf file could not be read (${code})`);
    this.code = code;
  }
}

/**
 * Test seam: the two operations a write can fail or be slow at. The defaults are node:fs; tests make one throw
 * (a failed write leaves nothing behind) or take long (a lock lost meanwhile is noticed).
 */
export interface ShelfStoreIo {
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

export interface ShelfStore {
  /** Every entry, newest addition first; never throws for one entry it cannot use. */
  list(): Promise<ShelfListItem[]>;
  /** Entries of this build's format with any of these identifiers (normalized like `shelfIdentityOf`). */
  findByIdentity(query: {
    doi?: string | null;
    arxiv?: string | null;
    openalex?: string | null;
  }): Promise<(ShelfEntry & { matchedOn: ShelfIdentityKey[] })[]>;
  /** Check every file of the entry against its manifest; with `rev`, also that it is still that rev. */
  verify(entryId: string, opts?: { rev?: number }): Promise<ShelfCheck>;
  /** `verify`, keeping the checked bytes. */
  read(entryId: string, opts?: { rev?: number }): Promise<ShelfRead>;
  /** Throws {@link ShelfIoError} when any entry cannot be read: it might be the same paper. */
  put(input: ShelfPutInput, target: ShelfPutTarget): Promise<ShelfPutResult>;
  /** Remove the entry at `rev`, whatever its format or state. */
  delete(entryId: string, rev: number): Promise<ShelfDeleteResult>;
}

// ---- identity -----------------------------------------------------------------------------------------------

/** The identifiers that make two Works the same paper (spec Q11); a title never does. */
export function shelfIdentityOf(ids: {
  doi?: string | null;
  arxiv_id?: string | null;
  openalex_id?: string | null;
}): ShelfIdentity {
  const doi = normDoi(ids.doi ?? null);
  // An arXiv DataCite DOI is the arXiv id, not a journal DOI.
  const fromDoi = arxivFromDoi(doi);
  const oa = ids.openalex_id?.trim().split("/").pop()?.trim().toUpperCase() || null;
  return {
    doi: fromDoi ? null : doi,
    arxiv: normArxiv(ids.arxiv_id ?? null) ?? fromDoi,
    openalex: oa,
  };
}

function sameIdentity(a: ShelfIdentity, b: ShelfIdentity): ShelfIdentityKey[] {
  const keys: ShelfIdentityKey[] = [];
  for (const k of ["doi", "arxiv", "openalex"] as const) if (a[k] && a[k] === b[k]) keys.push(k);
  return keys;
}

// ---- helpers ------------------------------------------------------------------------------------------------

const ENTRY_DIR_RE = /^([0-9a-f]{32})\.r([1-9][0-9]{0,8})$/;
const STALE_STAGING_MS = 60 * 60 * 1000;
const LOCK_STALE_MS = 15_000;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const errCode = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? "EUNKNOWN";
const isEnoent = (e: unknown) => errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The digest of a Doc's file list: each `path NUL sha256 LF`, in path order. */
export function shelfDocDigest(files: readonly { path: string; sha256: string }[]): string {
  const lines = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => `${f.path}\0${f.sha256}\n`);
  return sha256(Buffer.from(lines.join(""), "utf8"));
}

const defaultIo: ShelfStoreIo = {
  async writeFile(path, bytes) {
    const fh = await open(path, "wx", 0o600);
    try {
      let off = 0;
      while (off < bytes.length)
        off += (await fh.write(bytes, off, bytes.length - off)).bytesWritten;
      await fh.sync();
    } finally {
      await fh.close();
    }
  },
  rename,
};

/** Every regular file under `root`, as relative POSIX paths; anything else is reported as `other`. */
async function walk(root: string): Promise<{ files: string[]; other: boolean }> {
  const files: string[] = [];
  let other = false;
  const visit = async (rel: string) => {
    for (const d of await readdir(join(root, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) await visit(r);
      else if (d.isFile()) files.push(r);
      else other = true;
    }
  };
  await visit("");
  return { files, other };
}

async function diskBytes(dir: string): Promise<number> {
  let n = 0;
  try {
    for (const f of (await walk(dir)).files) {
      try {
        n += (await lstat(join(dir, f))).size;
      } catch {
        /* gone meanwhile */
      }
    }
  } catch {
    /* unreadable or gone: counted as what was seen */
  }
  return n;
}

function manifestBytes(m: ShelfManifest, manifestSize: number): number {
  let n = manifestSize;
  for (const d of m.docs) n += d.bytes + (d.annotations?.bytes ?? 0);
  n += m.argument_graph?.bytes ?? 0;
  n += m.note?.bytes ?? 0;
  return n;
}

/** Every file a manifest names, relative to the entry directory, with its expected record. */
function manifestFiles(m: ShelfManifest): { path: string; bytes: number; sha256: string }[] {
  const out: { path: string; bytes: number; sha256: string }[] = [];
  for (const d of m.docs) {
    for (const f of d.files)
      out.push({ path: `docs/${d.doc_id}/${f.path}`, bytes: f.bytes, sha256: f.sha256 });
    if (d.annotations)
      out.push({
        path: `annotations/${d.doc_id}.json`,
        bytes: d.annotations.bytes,
        sha256: d.annotations.sha256,
      });
  }
  if (m.argument_graph) out.push({ path: SHELF_ARGUMENT_GRAPH_FILE, ...m.argument_graph });
  if (m.note) out.push({ path: SHELF_NOTE_FILE, ...m.note });
  return out;
}

/** The manifest's own consistency beyond its schema: unique Doc ids, allowed and required files, digests. */
function manifestConsistent(m: ShelfManifest): boolean {
  const ids = new Set<string>();
  for (const d of m.docs) {
    if (ids.has(d.doc_id)) return false;
    ids.add(d.doc_id);
    const paths = new Set(d.files.map((f) => f.path));
    if (paths.size !== d.files.length) return false;
    if (!d.files.every((f) => shelfDocFileAllowed(d.kind, d.doc_id, f.path))) return false;
    if (!shelfDocRequiredFiles(d.kind, d.doc_id).every((p) => paths.has(p))) return false;
    if (d.bytes !== d.files.reduce((n, f) => n + f.bytes, 0)) return false;
    if (d.sha256 !== shelfDocDigest(d.files)) return false;
  }
  return true;
}

type Parsed =
  | { kind: "ok"; manifest: ShelfManifest; size: number }
  | { kind: "incompatible"; format: unknown; title: string | null }
  | { kind: "damaged"; problem: ShelfDamage }
  | { kind: "unreadable"; code: string }
  | { kind: "gone" };

/** Read an entry's manifest. A system error is `unreadable` (with its code), never damage or absence. */
async function parseManifest(dir: string, entryId: string, rev: number): Promise<Parsed> {
  const unreadable = (e: unknown): Parsed => ({ kind: "unreadable", code: errCode(e) });
  try {
    if (!(await lstat(dir)).isDirectory()) return { kind: "damaged", problem: "not_a_directory" };
  } catch (e) {
    return isEnoent(e) ? { kind: "gone" } : unreadable(e);
  }
  const file = join(dir, SHELF_MANIFEST_FILE);
  // Gone with its directory (replaced or deleted meanwhile), or never there.
  const missing = async (): Promise<Parsed> => {
    try {
      await lstat(dir);
      return { kind: "damaged", problem: "manifest_missing" };
    } catch (e) {
      return isEnoent(e) ? { kind: "gone" } : unreadable(e);
    }
  };
  let text: Buffer;
  try {
    if (!(await lstat(file)).isFile()) return { kind: "damaged", problem: "manifest_not_a_file" };
    text = await readFile(file);
  } catch (e) {
    return isEnoent(e) ? missing() : unreadable(e);
  }
  let json: unknown;
  try {
    json = JSON.parse(text.toString("utf8"));
  } catch {
    return { kind: "damaged", problem: "manifest_unreadable" };
  }
  const obj =
    json !== null && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : null;
  if (obj && obj.format !== SHELF_FORMAT) {
    const bib = obj.bibliography as Record<string, unknown> | undefined;
    return {
      kind: "incompatible",
      format: obj.format,
      title: bib && typeof bib === "object" && typeof bib.title === "string" ? bib.title : null,
    };
  }
  const parsed = ShelfManifestSchema.safeParse(json);
  if (!parsed.success || !manifestConsistent(parsed.data))
    return { kind: "damaged", problem: "manifest_invalid" };
  if (parsed.data.entry_id !== entryId || parsed.data.rev !== rev)
    return { kind: "damaged", problem: "manifest_mismatch" };
  return { kind: "ok", manifest: parsed.data, size: text.length };
}

/** Entry directories by id, highest rev first. Missing `entries/` is an empty Shelf. */
async function scan(root: string): Promise<Map<string, number[]>> {
  const byId = new Map<string, number[]>();
  let names: string[];
  try {
    names = await readdir(join(root, "entries"));
  } catch (e) {
    if (isEnoent(e)) return byId;
    throw new ShelfIoError(errCode(e));
  }
  for (const name of names) {
    const m = ENTRY_DIR_RE.exec(name);
    if (!m) continue;
    const revs = byId.get(m[1] as string) ?? [];
    revs.push(Number(m[2]));
    byId.set(m[1] as string, revs);
  }
  for (const revs of byId.values()) revs.sort((a, b) => b - a);
  return byId;
}

const entryDir = (root: string, entryId: string, rev: number) =>
  join(root, "entries", `${entryId}.r${rev}`);

/** Whether the lock is still this write's, checked right before each step readers would see. */
interface LockGuard {
  held(): Promise<boolean>;
}

// ---- the store ----------------------------------------------------------------------------------------------

export interface ShelfStoreOptions {
  /** The Shelf directory; default `<global data>/shelf`, resolved once per call (created 0700 by the first write). */
  dir?: string;
  /** Test seam, see {@link ShelfStoreIo}. */
  io?: Partial<ShelfStoreIo>;
  /** Test seam: the lock's stale threshold in ms (default 15 s; proper-lockfile's floor is 2 s). */
  lockStaleMs?: number;
  /** Test seam: how many times taking the lock is retried before `busy` (default 200, about 40 s). */
  lockRetries?: number;
}

export function createShelfStore(opts: ShelfStoreOptions = {}): ShelfStore {
  const io: ShelfStoreIo = { ...defaultIo, ...opts.io };
  const resolveRoot = () => opts.dir ?? resolveShelfDir();
  const stale = Math.max(opts.lockStaleMs ?? LOCK_STALE_MS, 2000);
  const update = Math.max(stale / 2, 1000);

  const list = async (): Promise<ShelfListItem[]> => {
    const root = resolveRoot();
    const items: ShelfListItem[] = [];
    for (const [entryId, revs] of await scan(root)) {
      // A lower rev is a superseded directory not yet removed; one more look covers a replacement landing meanwhile.
      for (let attempt = 0; attempt < 2; attempt++) {
        const rev =
          attempt === 0 ? (revs[0] as number) : ((await scan(root)).get(entryId)?.[0] ?? 0);
        if (rev === 0) break;
        const dir = entryDir(root, entryId, rev);
        const p = await parseManifest(dir, entryId, rev);
        if (p.kind === "gone") continue;
        if (p.kind === "ok")
          items.push({
            status: "ok",
            entryId,
            rev,
            bytes: manifestBytes(p.manifest, p.size),
            manifest: p.manifest,
          });
        else if (p.kind === "incompatible")
          items.push({
            status: "incompatible",
            entryId,
            rev,
            bytes: await diskBytes(dir),
            format: p.format,
            title: p.title,
          });
        else if (p.kind === "unreadable")
          items.push({ status: "unreadable", entryId, rev, bytes: 0, code: p.code });
        else
          items.push({
            status: "damaged",
            entryId,
            rev,
            bytes: await diskBytes(dir),
            problem: p.problem,
          });
        break;
      }
    }
    const at = (i: ShelfListItem) => (i.status === "ok" ? i.manifest.added_at : "");
    return items.sort((a, b) =>
      at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : a.entryId < b.entryId ? -1 : 1
    );
  };

  const findByIdentity: ShelfStore["findByIdentity"] = async (query) => {
    const q = shelfIdentityOf({
      doi: query.doi,
      arxiv_id: query.arxiv,
      openalex_id: query.openalex,
    });
    const out: (ShelfEntry & { matchedOn: ShelfIdentityKey[] })[] = [];
    for (const item of await list()) {
      if (item.status !== "ok") continue;
      const matchedOn = sameIdentity(q, item.manifest.identity);
      if (matchedOn.length > 0) {
        const { status: _status, ...entry } = item;
        out.push({ ...entry, matchedOn });
      }
    }
    return out;
  };

  const check = async (
    entryId: string,
    o: { rev?: number } | undefined,
    keep: boolean
  ): Promise<ShelfRead | ShelfCheck> => {
    if (!SHELF_ENTRY_ID_RE.test(entryId)) return { status: "not_found" };
    const root = resolveRoot();
    /** What happened to an entry whose file vanished while it was read; null: still there, so damaged. */
    const vanished = async (rev: number): Promise<ShelfCheck | "retry" | null> => {
      const now = (await scan(root)).get(entryId)?.[0];
      if (now === undefined) return { status: "not_found" };
      if (now === rev) return null;
      // Replaced meanwhile: with a rev asked for, that is the answer; without, read the new one.
      return o?.rev !== undefined ? { status: "changed", rev: now } : "retry";
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const rev = (await scan(root)).get(entryId)?.[0];
      if (rev === undefined) return { status: "not_found" };
      if (o?.rev !== undefined && o.rev !== rev) return { status: "changed", rev };
      const dir = entryDir(root, entryId, rev);
      const p = await parseManifest(dir, entryId, rev);
      if (p.kind === "gone") continue;
      if (p.kind === "unreadable") throw new ShelfIoError(p.code);
      if (p.kind === "incompatible") return { status: "incompatible", rev };
      if (p.kind === "damaged") return { status: "damaged", rev, problem: p.problem };
      const m = p.manifest;
      const contents = new Map<string, Buffer>();
      let problem: ShelfDamage | null = null;
      for (const f of manifestFiles(m)) {
        let bytes: Buffer;
        try {
          if (!(await lstat(join(dir, f.path))).isFile()) {
            problem = "file_changed";
            break;
          }
          bytes = await readFile(join(dir, f.path));
        } catch (e) {
          if (!isEnoent(e)) throw new ShelfIoError(errCode(e));
          problem = "file_missing";
          break;
        }
        if (bytes.length !== f.bytes || sha256(bytes) !== f.sha256) {
          problem = "file_changed";
          break;
        }
        if (keep) contents.set(f.path, bytes);
      }
      if (problem === null) {
        try {
          const listed = await walk(dir);
          const expected = new Set([SHELF_MANIFEST_FILE, ...manifestFiles(m).map((f) => f.path)]);
          if (listed.other || listed.files.some((f) => !expected.has(f)))
            problem = "file_unexpected";
        } catch (e) {
          if (!isEnoent(e)) throw new ShelfIoError(errCode(e));
          problem = "file_missing";
        }
      }
      if (problem === "file_missing") {
        const v = await vanished(rev);
        if (v === "retry") continue;
        if (v !== null) return v;
      }
      if (problem !== null) return { status: "damaged", rev, problem };
      const entry: ShelfEntry = { entryId, rev, bytes: manifestBytes(m, p.size), manifest: m };
      if (!keep) return { status: "ok", entry };
      const at = (path: string) => contents.get(path) as Buffer;
      return {
        status: "ok",
        entry,
        docs: m.docs.map((d) => ({
          docId: d.doc_id,
          kind: d.kind,
          files: d.files.map((f) => ({ path: f.path, bytes: at(`docs/${d.doc_id}/${f.path}`) })),
          annotations: d.annotations
            ? { count: d.annotations.count, bytes: at(`annotations/${d.doc_id}.json`) }
            : null,
        })),
        argumentGraph: m.argument_graph ? at(SHELF_ARGUMENT_GRAPH_FILE) : null,
        note: m.note ? at(SHELF_NOTE_FILE).toString("utf8") : null,
      };
    }
    return { status: "not_found" };
  };

  // ---- writes ----

  /**
   * Run `fn` holding the cross-process lock; `"busy"` when another process kept it past the wait. The lock counts
   * as lost when proper-lockfile reports it compromised, and also when this process's timers were held up for half
   * the stale threshold (a blocked event loop or a suspended machine): then `held()` first waits for the lock's
   * refresh timer to run and say whether the lock is still ours. A lost lock is never released here — releasing
   * would remove a lock directory that is another process's now.
   */
  const withLock = async <T>(
    root: string,
    fn: (guard: LockGuard) => Promise<T>
  ): Promise<T | "busy"> => {
    for (const d of [root, join(root, "entries"), join(root, "staging"), join(root, "trash")])
      await mkdir(d, { recursive: true, mode: 0o700 });
    let compromised = false;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(root, {
        lockfilePath: join(root, SHELF_LOCK),
        stale,
        update,
        // Only recorded: the notice comes from a timer, where a throw (the default) would crash the process.
        onCompromised: () => {
          compromised = true;
        },
        retries: { retries: opts.lockRetries ?? 200, minTimeout: 25, maxTimeout: 200 },
      });
    } catch (e) {
      if (errCode(e) === "ELOCKED") return "busy";
      throw e;
    }
    let tick = Date.now();
    const heartbeat = setInterval(() => {
      tick = Date.now();
    }, 250);
    heartbeat.unref();
    const guard: LockGuard = {
      async held() {
        if (compromised) return false;
        if (Date.now() - tick > stale / 2) {
          // The refresh timer was held up too: let it run once and look at the lock before going on.
          await sleep(update + 250);
        }
        return !compromised;
      },
    };
    try {
      await tidy(root, guard);
      return await fn(guard);
    } finally {
      clearInterval(heartbeat);
      if (await guard.held()) await release().catch(() => {});
    }
  };

  /** Make a directory disappear at once (rename into trash), then remove it. A failed removal is tidied later. */
  const discard = async (root: string, path: string) => {
    const t = join(root, "trash", randomBytes(8).toString("hex"));
    await io.rename(path, t);
    await rm(t, { recursive: true, force: true }).catch(() => {});
  };

  /** Remove what a write that failed or was interrupted left: trash, old staging, superseded directories. */
  const tidy = async (root: string, guard: LockGuard) => {
    const quietly = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* the next write tries again */
      }
    };
    await quietly(async () => {
      for (const name of await readdir(join(root, "trash")))
        await quietly(() => rm(join(root, "trash", name), { recursive: true, force: true }));
    });
    await quietly(async () => {
      for (const name of await readdir(join(root, "staging"))) {
        const p = join(root, "staging", name);
        await quietly(async () => {
          if (Date.now() - (await stat(p)).mtimeMs > STALE_STAGING_MS)
            await rm(p, { recursive: true, force: true });
        });
      }
    });
    await quietly(async () => {
      for (const [entryId, revs] of await scan(root)) {
        const [top, ...lower] = revs;
        if (lower.length === 0 || top === undefined) continue;
        // Only below a whole entry of this build's format: an id whose newest directory is of a later format (or
        // cannot be used) is left exactly as it is.
        const p = await parseManifest(entryDir(root, entryId, top), entryId, top);
        if (p.kind !== "ok") continue;
        for (const rev of lower) {
          if (!(await guard.held())) return;
          await quietly(() => discard(root, entryDir(root, entryId, rev)));
        }
      }
    });
  };

  const put: ShelfStore["put"] = async (input, target) => {
    const prepared = prepare(input);
    if (target.mode === "replace") {
      if (target.targets.length === 0) throw new ShelfInputError("a replacement names no entry");
      const ids = new Set(target.targets.map((t) => t.entryId));
      if (ids.size !== target.targets.length) throw new ShelfInputError("an entry is named twice");
    }
    const root = resolveRoot();
    const r = await withLock(root, async (guard): Promise<ShelfPutResult> => {
      const byId = await scan(root);
      const targets = target.mode === "replace" ? target.targets : [];
      for (const t of targets) {
        const cur = SHELF_ENTRY_ID_RE.test(t.entryId) ? byId.get(t.entryId)?.[0] : undefined;
        if (cur === undefined) return { ok: false, reason: "not_found", entryId: t.entryId };
        if (cur !== t.rev)
          return { ok: false, reason: "rev_mismatch", entryId: t.entryId, currentRev: cur };
        const state = await parseManifest(entryDir(root, t.entryId, cur), t.entryId, cur);
        if (state.kind === "gone") return { ok: false, reason: "not_found", entryId: t.entryId };
        if (state.kind === "unreadable") throw new ShelfIoError(state.code);
        if (state.kind === "incompatible")
          return { ok: false, reason: "incompatible", entryId: t.entryId, currentRev: cur };
        if (state.kind === "damaged")
          return { ok: false, reason: "damaged", entryId: t.entryId, problem: state.problem };
      }
      // The entries that are the same paper, as they are now.
      const same: ShelfEntryRef[] = [];
      for (const [id, revs] of byId) {
        const top = revs[0] as number;
        const state = await parseManifest(entryDir(root, id, top), id, top);
        // An entry that cannot be read might be this paper: stop rather than add a duplicate beside it.
        if (state.kind === "unreadable") throw new ShelfIoError(state.code);
        if (
          state.kind === "ok" &&
          sameIdentity(prepared.identity, state.manifest.identity).length > 0
        )
          same.push({ entryId: id, rev: top });
      }
      const key = (e: ShelfEntryRef) => `${e.entryId}.${e.rev}`;
      const sameKeys = new Set(same.map(key));
      const exact = same.length === targets.length && targets.every((t) => sameKeys.has(key(t)));
      if (!exact) return { ok: false, reason: "identity_taken", entries: same };

      const first = targets[0];
      let entryId: string;
      if (first) entryId = first.entryId;
      else {
        do entryId = randomBytes(16).toString("hex");
        while (byId.has(entryId));
      }
      const rev = first ? first.rev + 1 : 1;

      const manifest: ShelfManifest = ShelfManifestSchema.parse({
        format: SHELF_FORMAT,
        entry_id: entryId,
        rev,
        added_at: new Date().toISOString(),
        source: { project: input.source.project, work_id: input.source.workId },
        identity: prepared.identity,
        bibliography: input.bibliography,
        docs: prepared.docs,
        argument_graph: prepared.argumentGraph ? record(prepared.argumentGraph) : null,
        note: prepared.note ? record(prepared.note) : null,
      });
      const manifestText = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const stage = join(root, "staging", `${process.pid}-${randomBytes(8).toString("hex")}`);
      const dropStage = () => rm(stage, { recursive: true, force: true }).catch(() => {});
      try {
        await mkdir(stage, { mode: 0o700 });
        for (const w of prepared.writes) {
          await mkdir(dirname(join(stage, w.path)), { recursive: true, mode: 0o700 });
          await io.writeFile(join(stage, w.path), w.bytes);
        }
        await io.writeFile(join(stage, SHELF_MANIFEST_FILE), manifestText);
        if (!(await guard.held())) {
          await dropStage();
          return { ok: false, reason: "lock_lost", written: null };
        }
        await io.rename(stage, entryDir(root, entryId, rev));
      } catch (e) {
        await dropStage(); // a failure here must not hide the one that brought us here
        throw e;
      }
      // The new entry is in place: only now do the old directories go — every directory of the other targets
      // (lower revs first, so an older one never shows again) and the first target's own.
      const old: string[] = [];
      for (const t of targets.slice(1))
        for (const r of [...(byId.get(t.entryId) ?? [])].reverse())
          old.push(entryDir(root, t.entryId, r));
      if (first) old.push(entryDir(root, first.entryId, first.rev));
      for (const path of old) {
        if (!(await guard.held()))
          return { ok: false, reason: "lock_lost", written: { entryId, rev } };
        await discard(root, path).catch(() => {
          /* readers take the highest rev; a superseded directory is removed by the next write */
        });
      }
      const entry: ShelfEntry = {
        entryId,
        rev,
        bytes: manifestBytes(manifest, manifestText.length),
        manifest,
      };
      return { ok: true, entry };
    });
    return r === "busy" ? { ok: false, reason: "busy" } : r;
  };

  const del: ShelfStore["delete"] = async (entryId, rev) => {
    if (!SHELF_ENTRY_ID_RE.test(entryId)) return { ok: false, reason: "not_found" };
    const root = resolveRoot();
    const r = await withLock(root, async (guard): Promise<ShelfDeleteResult> => {
      const revs = (await scan(root)).get(entryId);
      const cur = revs?.[0];
      if (revs === undefined || cur === undefined) return { ok: false, reason: "not_found" };
      if (cur !== rev) return { ok: false, reason: "rev_mismatch", currentRev: cur };
      // Superseded directories first: were the current one to go first, an older one would show again.
      for (const r of [...revs.slice(1), cur]) {
        if (!(await guard.held())) return { ok: false, reason: "lock_lost" };
        await discard(root, entryDir(root, entryId, r));
      }
      return { ok: true };
    });
    return r === "busy" ? { ok: false, reason: "busy" } : r;
  };

  return {
    list,
    findByIdentity,
    verify: async (entryId, o) => (await check(entryId, o, false)) as ShelfCheck,
    read: async (entryId, o) => (await check(entryId, o, true)) as ShelfRead,
    put,
    delete: del,
  };
}

// ---- input checks -------------------------------------------------------------------------------------------

const record = (bytes: Uint8Array) => ({ bytes: bytes.length, sha256: sha256(bytes) });

interface Prepared {
  identity: ShelfIdentity;
  docs: ShelfDoc[];
  argumentGraph: Uint8Array | null;
  note: Uint8Array | null;
  writes: { path: string; bytes: Uint8Array }[];
}

function annotationCountOf(bytes: Uint8Array): number | null {
  try {
    const v = JSON.parse(Buffer.from(bytes).toString("utf8")) as { annotations?: unknown };
    return v && typeof v === "object" && Array.isArray(v.annotations) ? v.annotations.length : null;
  } catch {
    return null;
  }
}

function prepare(input: ShelfPutInput): Prepared {
  const fail = (why: string): never => {
    throw new ShelfInputError(why);
  };
  const bib = ShelfBibliographySchema.safeParse(input.bibliography);
  if (!bib.success)
    fail("the bibliography is not a Shelf bibliography (or carries a project field)");
  if (!input.source.project || !input.source.workId)
    fail("the source project and Work id are required");
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const ids = new Set<string>();
  const docs: ShelfDoc[] = input.docs.map((d) => {
    if (!SHELF_DOC_ID_RE.test(d.docId)) fail("a Doc id is not valid");
    if (ids.has(d.docId)) fail("a Doc is given twice");
    ids.add(d.docId);
    const paths = new Set<string>();
    const files = d.files.map((f) => {
      if (!shelfDocFileAllowed(d.kind, d.docId, f.path))
        fail(`a ${d.kind} Doc file is not one the Shelf carries`);
      if (paths.has(f.path)) fail("a Doc file is given twice");
      paths.add(f.path);
      writes.push({ path: `docs/${d.docId}/${f.path}`, bytes: f.bytes });
      return { path: f.path, ...record(f.bytes) };
    });
    for (const p of shelfDocRequiredFiles(d.kind, d.docId))
      if (!paths.has(p)) fail(`a ${d.kind} Doc lacks a required file`);
    let annotations: ShelfDoc["annotations"] = null;
    if (d.annotations) {
      if (annotationCountOf(d.annotations.bytes) !== d.annotations.count)
        fail("an annotation copy does not hold the stated number of annotations");
      writes.push({ path: `annotations/${d.docId}.json`, bytes: d.annotations.bytes });
      annotations = { count: d.annotations.count, ...record(d.annotations.bytes) };
    }
    return {
      doc_id: d.docId,
      kind: d.kind,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      sha256: shelfDocDigest(files),
      files,
      annotations,
    };
  });
  if (input.argumentGraph) {
    try {
      JSON.parse(Buffer.from(input.argumentGraph).toString("utf8"));
    } catch {
      fail("the argument graph is not JSON");
    }
    writes.push({ path: SHELF_ARGUMENT_GRAPH_FILE, bytes: input.argumentGraph });
  }
  const note = input.note === null ? null : Buffer.from(input.note, "utf8");
  if (note) writes.push({ path: SHELF_NOTE_FILE, bytes: note });
  return {
    identity: shelfIdentityOf(input.bibliography),
    docs,
    argumentGraph: input.argumentGraph,
    note,
    writes,
  };
}
