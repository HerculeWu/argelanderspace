/**
 * Change one key of the config file on disk: inside a cross-process lock, read the file again, edit its text
 * (`config-edit.ts`), and replace the file atomically. Because the file is read inside the lock, a change another
 * process (or an editor) made to another key a moment ago is kept; two writers of the same key leave the later
 * one's value.
 *
 * - The lock is proper-lockfile's: a `config.toml.lock` directory next to the file, there only while a write runs.
 *   One left by a process that died is taken over once it is stale (15 s). An editor does not take the lock; what
 *   protects its change is the fresh read, not the lock.
 * - The replacement is a temporary file in the same directory, flushed, then renamed over the file. A failure before
 *   the rename leaves the file as it was and removes the temporary file.
 * - A file that is a symbolic link is edited where it points (the lock and the temporary file are beside the
 *   target), so the link stays a link. A link that points nowhere is refused.
 * - The file's permission bits are kept. A missing file is created (mode 0600), and so is its directory (0700);
 *   restoring the default of a key in a missing file creates nothing.
 * - A file the user cannot write is refused, even where the directory would allow replacing it.
 * - A file that is not valid UTF-8 is refused: decoding it would not give back its bytes.
 * - Nothing is thrown and no result carries a path, a value or a system error message: a refusal is a category.
 */

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { configFilePath } from "./config.js";
import { type ConfigChange, type ConfigEditRefusal, editConfigText } from "./config-edit.js";

/**
 * Why the file was not changed: one of the line editor's refusals, or
 *
 *   busy              another writer held the lock for the whole wait
 *   unreadable        the file (or what its link points at) could not be read, or is not a regular file
 *   invalid_encoding  the file is not valid UTF-8
 *   not_writable      the file or its directory does not allow writing
 *   write_failed      writing or replacing the file failed for another reason
 */
export const SETTING_WRITE_REFUSALS = [
  "busy",
  "unreadable",
  "invalid_encoding",
  "not_writable",
  "write_failed",
] as const;
export type SettingWriteRefusal = ConfigEditRefusal | (typeof SETTING_WRITE_REFUSALS)[number];

export type SettingWriteResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: SettingWriteRefusal };

export interface SettingWriteOptions {
  /** The config file; default `configFilePath()`. */
  path?: string;
  /** The step that puts the new file in place; default `fs.rename`. */
  rename?: (from: string, to: string) => Promise<void>;
}

const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);
const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;
const writeRefusal = (e: unknown): SettingWriteRefusal =>
  DENIED.has(codeOf(e) ?? "") ? "not_writable" : "write_failed";

/** Where the bytes live: the path itself, or what a symbolic link at the path points at. */
async function target(
  path: string
): Promise<{ file: string; exists: boolean } | { refused: SettingWriteRefusal }> {
  try {
    const info = await lstat(path);
    const file = info.isSymbolicLink() ? await realpath(path) : path;
    if (!(await stat(file)).isFile()) return { refused: "unreadable" };
    return { file, exists: true };
  } catch (e) {
    // ENOENT from `realpath` is a link that points nowhere: `lstat` had found the link.
    if (codeOf(e) !== "ENOENT") return { refused: "unreadable" };
    try {
      await lstat(path);
      return { refused: "unreadable" };
    } catch {
      return { file: path, exists: false };
    }
  }
}

/** Change one key of the config file. Never throws. */
export async function writeSetting(
  key: string,
  change: ConfigChange,
  options: SettingWriteOptions = {}
): Promise<SettingWriteResult> {
  try {
    const found = await target(options.path ?? configFilePath());
    if ("refused" in found) return { ok: false, reason: found.refused };
    const { file } = found;
    if (!found.exists) {
      if ("reset" in change) return { ok: true, changed: false };
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      } catch (e) {
        return { ok: false, reason: writeRefusal(e) };
      }
    }

    // The lock is a directory made beside the file, and taking it retries on any failure: a directory that does
    // not allow writing is found out here, at once, rather than after the whole wait.
    try {
      await access(dirname(file), constants.W_OK);
    } catch (e) {
      return { ok: false, reason: writeRefusal(e) };
    }
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(file, {
        realpath: false,
        stale: 15_000,
        // The default throws from a timer; the replacement below is atomic either way.
        onCompromised: () => {},
        retries: { retries: 40, minTimeout: 25, maxTimeout: 150 },
      });
    } catch (e) {
      return { ok: false, reason: codeOf(e) === "ELOCKED" ? "busy" : writeRefusal(e) };
    }
    try {
      return await replaceUnderLock(file, key, change, options.rename ?? rename);
    } finally {
      await release().catch(() => {});
    }
  } catch {
    return { ok: false, reason: "write_failed" };
  }
}

async function replaceUnderLock(
  file: string,
  key: string,
  change: ConfigChange,
  moveIntoPlace: (from: string, to: string) => Promise<void>
): Promise<SettingWriteResult> {
  let bytes: Buffer | null;
  try {
    bytes = await readFile(file);
  } catch (e) {
    if (codeOf(e) !== "ENOENT") return { ok: false, reason: "unreadable" };
    bytes = null;
  }
  let text = "";
  if (bytes !== null) {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { ok: false, reason: "invalid_encoding" };
    }
  }
  const edited = editConfigText(text, key, change);
  if (!edited.ok) return edited;
  if (!edited.changed) return { ok: true, changed: false };

  let mode = 0o600;
  if (bytes !== null) {
    try {
      await access(file, constants.W_OK);
      mode = (await stat(file)).mode & 0o7777;
    } catch (e) {
      return { ok: false, reason: writeRefusal(e) };
    }
  }
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", mode);
    try {
      await handle.writeFile(edited.text, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // `open` applies the umask; the file being replaced may have bits the umask clears.
    await chmod(temporary, mode);
    await moveIntoPlace(temporary, file);
  } catch (e) {
    await rm(temporary, { force: true }).catch(() => {});
    return { ok: false, reason: writeRefusal(e) };
  }
  return { ok: true, changed: true };
}
