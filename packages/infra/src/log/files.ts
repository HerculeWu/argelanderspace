/**
 * The user-level log directory and the file sink (global data, ADR 0007): `<global data dir>/logs/`, one file per
 * process run, one JSON record per line.
 *
 * Opening a file also tidies the directory: only the newest `LOG_KEEP_FILES` log files stay, and only as many of
 * them as fit in `LOG_MAX_TOTAL_BYTES` together. Several processes share the directory: each writes its own file,
 * and tidying is best effort — a failure to list, stat or delete is ignored, and a long-lived process whose file
 * was tidied away by a later start keeps running (it loses that file's records, nothing else).
 *
 * A run's file is always a new file: it is opened for exclusive creation, so a file or a symbolic link that already
 * has the name is neither appended to nor followed — the run takes the next free numbered name, or does without a
 * log. One run never writes more than `LOG_MAX_TOTAL_BYTES`; the record that would pass it is replaced by a last
 * `log.truncated` record, and nothing is written after that.
 *
 * Nothing here throws. A directory that cannot be made, a file that cannot be opened, a full disk: the records are
 * lost and the process carries on. The directory is 0700 and the files 0600, like the rest of the global data.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { type GlobalDirsOptions, resolveGlobalDirs } from "../global-dirs.js";
import type { LogSink } from "./logger.js";

export const LOG_DIR_NAME = "logs";
export const LOG_KEEP_FILES = 20;
export const LOG_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

/** The log directory. Like `resolveGlobalDirs`, this never touches the filesystem beyond reading config.toml. */
export function resolveLogDir(opts: GlobalDirsOptions = {}): string {
  return join(resolveGlobalDirs(opts).dataDir, LOG_DIR_NAME);
}

// <UTC time to the millisecond>-<process kind>-<pid>[-<n>].jsonl; sorting by name is sorting by start time. The
// number is there only when the plain name was already taken.
const LOG_FILE = /^\d{8}T\d{9}Z-[a-z][a-z0-9]*-\d+(?:-\d+)?\.jsonl$/;
const PROCESS_KIND = /^[a-z][a-z0-9]*$/;
/** How many numbered names are tried after the plain one. */
const NAME_ATTEMPTS = 8;
/** The event of the last record of a run that reached its size limit. */
export const LOG_TRUNCATED_EVENT = "log.truncated";

function fileName(kind: string, at: Date, pid: number, attempt: number): string {
  const stamp = at.toISOString().replace(/[-:.]/g, "");
  return `${stamp}-${kind}-${pid}${attempt === 0 ? "" : `-${attempt}`}.jsonl`;
}

function truncatedLine(): string {
  return JSON.stringify({ t: new Date().toISOString(), level: "warn", event: LOG_TRUNCATED_EVENT });
}
// The time has a fixed width, so the marker's size is known before it is needed.
const TRUNCATED_BYTES = Buffer.byteLength(truncatedLine()) + 1;

export interface LogFileOptions {
  dir: string;
  /** Which long-running process this is, as one lower-case word: `serve`. */
  process: string;
  now?: Date;
  pid?: number;
  keepFiles?: number;
  maxTotalBytes?: number;
}

export interface LogFile extends LogSink {
  /** The file being written, or null when none could be opened (records are then dropped). */
  readonly path: string | null;
  close(): void;
}

/**
 * Deletes log files beyond the newest `keepFiles`, and beyond the point where the newest ones together exceed
 * `maxTotalBytes`. `current` is never deleted. Files that are not named like a log file are left alone.
 */
export function pruneLogDir(
  dir: string,
  limits: { keepFiles?: number; maxTotalBytes?: number; current?: string } = {}
): void {
  const keepFiles = limits.keepFiles ?? LOG_KEEP_FILES;
  const maxTotalBytes = limits.maxTotalBytes ?? LOG_MAX_TOTAL_BYTES;
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => LOG_FILE.test(name));
  } catch {
    return;
  }
  // Newest first; the file of this run leads whatever the clock said when the others were named.
  names.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  if (limits.current !== undefined && names.includes(limits.current)) {
    names = [limits.current, ...names.filter((name) => name !== limits.current)];
  }
  let kept = 0;
  let bytes = 0;
  let full = false;
  for (const name of names) {
    const path = join(dir, name);
    let size: number;
    try {
      const stat = statSync(path);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    const isCurrent = name === limits.current;
    if (!isCurrent && (full || kept >= keepFiles || bytes + size > maxTotalBytes)) {
      // Everything older than the first file that does not fit goes too: what stays is always the newest run.
      full = true;
      try {
        unlinkSync(path);
      } catch {
        /* best effort */
      }
      continue;
    }
    kept += 1;
    bytes += size;
  }
}

/** Opens this run's log file and tidies the directory. Never throws. */
export function openLogFile(options: LogFileOptions): LogFile {
  const maxTotalBytes = options.maxTotalBytes ?? LOG_MAX_TOTAL_BYTES;
  let fd: number | null = null;
  let path: string | null = null;
  let written = 0;
  let truncated = false;
  try {
    if (!PROCESS_KIND.test(options.process)) throw new TypeError("process kind");
    mkdirSync(options.dir, { recursive: true, mode: 0o700 });
    const at = options.now ?? new Date();
    const pid = options.pid ?? process.pid;
    let name = "";
    for (let attempt = 0; attempt <= NAME_ATTEMPTS && fd === null; attempt++) {
      name = fileName(options.process, at, pid, attempt);
      try {
        // "ax": append, create, and fail if the name exists — a symbolic link with the name is not followed.
        fd = openSync(join(options.dir, name), "ax", 0o600);
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== "EEXIST") throw error;
      }
    }
    if (fd !== null) {
      path = join(options.dir, name);
      pruneLogDir(options.dir, {
        current: name,
        maxTotalBytes,
        ...(options.keepFiles === undefined ? {} : { keepFiles: options.keepFiles }),
      });
    }
  } catch {
    if (fd === null) path = null;
  }
  return {
    get path() {
      return path;
    },
    // Synchronous on purpose: a record written just before the process dies is on disk when it dies.
    write(line) {
      if (fd === null || truncated) return;
      const bytes = Buffer.byteLength(line) + 1;
      // One run never grows past the limit for the whole directory. Room for the marker is kept back, so the first
      // record that does not fit is replaced by it; after that the file is finished, whatever a later record's size.
      const fits = written + bytes + TRUNCATED_BYTES <= maxTotalBytes;
      if (!fits) truncated = true;
      if (!fits && written + TRUNCATED_BYTES > maxTotalBytes) return;
      try {
        writeSync(fd, `${fits ? line : truncatedLine()}\n`);
        written += fits ? bytes : TRUNCATED_BYTES;
      } catch {
        /* disk full, file gone: this record is lost */
      }
    },
    close() {
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        /* nothing to do */
      }
      fd = null;
    },
  };
}
