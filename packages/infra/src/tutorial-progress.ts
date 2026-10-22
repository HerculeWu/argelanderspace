/**
 * Tutorial progress (in-app-tutorial ticket 18; spec §6, appendix B): global data (ADR 0007) in
 * `<global data dir>/tutorial.json`, shaped as contracts `TutorialProgressSchema`. One progress binds one tutorial
 * project; it belongs to the person, not to a project.
 *
 * Read whole; written whole — a new file next to it, renamed over it (atomic replacement). No lock: two processes that
 * write at once (the desktop app and `serve` running the tutorial together, which is not supported) each replace the
 * file, and the last rename wins.
 *
 * A file that cannot be used — unreadable, not JSON, of another shape, or of a version this build does not know — is
 * read as no progress, with the reason (a category only) for the caller to log; the next write replaces it. Nothing
 * is repaired or kept of it.
 *
 * Also here: the tutorial marker `argelanderspace-tutorial.json` at the root of the bundled sample and of a tutorial
 * project copied from it (`{version: 1, sample: n}`), read by the server's `/api/tutorial`, the desktop host and the
 * CLI alike; infra `bundledTutorialDir` looks for the same file.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import {
  TUTORIAL_PROGRESS_VERSION,
  TutorialMarkerSchema,
  type TutorialProgress,
  TutorialProgressSchema,
} from "@argelanderspace/contracts";
import { type GlobalDirsOptions, resolveGlobalDirs } from "./global-dirs.js";

export const TUTORIAL_PROGRESS_FILE = "tutorial.json";
/** The marker file at the root of the tutorial sample and of a tutorial project copied from it. */
export const TUTORIAL_MARKER_FILE = "argelanderspace-tutorial.json";

/** Why the file was read as no progress. Category only, never content. */
export const TUTORIAL_PROGRESS_PROBLEMS = [
  "unreadable",
  "not_json",
  "bad_format",
  "unknown_version",
] as const;
export type TutorialProgressProblem = (typeof TUTORIAL_PROGRESS_PROBLEMS)[number];

export interface TutorialProgressReading {
  progress: TutorialProgress | null;
  /** Null when the file was read whole, or was not there (the tutorial was never started). */
  problem: TutorialProgressProblem | null;
}

/** The file in the global data directory. Like `resolveGlobalDirs`, touches nothing but (maybe) config.toml. */
export function resolveTutorialProgressPath(opts: GlobalDirsOptions = {}): string {
  return join(resolveGlobalDirs(opts).dataDir, TUTORIAL_PROGRESS_FILE);
}

/**
 * Whether `value` is a whole progress this build can use: what a read accepts and what `PUT /api/tutorial` checks.
 * A `version` other than 1 (whatever its type) is `unknown_version`; anything else wrong is `bad_format`.
 */
export function tutorialProgressOf(
  value: unknown
):
  | { ok: true; progress: TutorialProgress }
  | { ok: false; problem: "bad_format" | "unknown_version" } {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return { ok: false, problem: "bad_format" };
  const version = (value as Record<string, unknown>).version;
  if (version === undefined) return { ok: false, problem: "bad_format" };
  if (version !== TUTORIAL_PROGRESS_VERSION) return { ok: false, problem: "unknown_version" };
  const parsed = TutorialProgressSchema.safeParse(value);
  if (!parsed.success) return { ok: false, problem: "bad_format" };
  const progress = parsed.data;
  if (progress.project !== null && !isAbsolute(progress.project.path))
    return { ok: false, problem: "bad_format" };
  return { ok: true, progress };
}

export function readTutorialProgress(file: string): TutorialProgressReading {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { progress: null, problem: null };
    return { progress: null, problem: "unreadable" };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { progress: null, problem: "not_json" };
  }
  const checked = tutorialProgressOf(doc);
  return checked.ok
    ? { progress: checked.progress, problem: null }
    : { progress: null, problem: checked.problem };
}

/** The longest `appVersion` a progress takes (contracts `TutorialProgressSchema`). */
const APP_VERSION_MAX = 64;

/**
 * A new progress bound to the tutorial folder `path`: nothing done yet, started and updated `now`, with the app's
 * version (cut to what the shape takes). The one the desktop host writes when it starts a tutorial and the one the
 * `tutorial` command writes.
 */
export function newTutorialProgress(
  path: string,
  appVersion: string,
  now: Date = new Date()
): TutorialProgress {
  const at = now.toISOString();
  return {
    version: TUTORIAL_PROGRESS_VERSION,
    project: { path },
    startedAt: at,
    updatedAt: at,
    position: null,
    steps: {},
    appVersion: appVersion.slice(0, APP_VERSION_MAX),
  };
}

/**
 * Replaces the file with `progress` (already checked by {@link tutorialProgressOf}): written next to it and renamed
 * over it, the directory made when missing (0700), the file 0600. Throws when it cannot be written; the old bytes then
 * stay and no temporary file is left.
 */
export function writeTutorialProgress(file: string, progress: TutorialProgress): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(progress, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* the write's own error is the one that counts */
    }
    throw error;
  }
}

/**
 * The `sample` number of the tutorial marker at the root of `dir`; null when there is no such file, it cannot be
 * read, or it is not exactly `{version: 1, sample: <whole number ≥ 0>}`.
 */
export function readTutorialMarker(dir: string): number | null {
  let text: string;
  try {
    text = readFileSync(join(dir, TUTORIAL_MARKER_FILE), "utf8");
  } catch {
    return null;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = TutorialMarkerSchema.safeParse(doc);
  return parsed.success ? parsed.data.sample : null;
}
