/**
 * Recently opened projects (desktop-app ticket 18; spec 「Project 与项目数据的定位」): global data (ADR 0007) kept by
 * the desktop host, in `<global data dir>/recent-projects.json`:
 *
 *   { "version": 1, "projects": [ { "path": "<absolute folder>", "openedAt": "<ISO time>" }, … ] }
 *
 * Most recent first, one entry per path (compared as written), at most {@link RECENT_PROJECTS_MAX}. Every change is a
 * read, then a whole new file written next to it and renamed over it (atomic replacement). There is no lock: two
 * processes that change it at once each write the list they read plus their change, and the last rename wins
 * (hard contract, 「全局数据」 — approved with the log directory, 2026-10-13).
 *
 * A file that cannot be used — unreadable, not JSON, of another shape or a newer version — is read as an empty list,
 * with the reason for the caller to log; it is replaced by the next successful open. Nothing in it is project data:
 * losing it loses shortcuts only. Entries of the wrong shape are left out (`bad_entries`) and the rest kept.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { type GlobalDirsOptions, resolveGlobalDirs } from "./global-dirs.js";

export const RECENT_PROJECTS_FILE = "recent-projects.json";
export const RECENT_PROJECTS_VERSION = 1;
export const RECENT_PROJECTS_MAX = 200;

export interface RecentProject {
  /** The project folder, absolute. */
  path: string;
  /** When it was last opened, an ISO time (UTC). */
  openedAt: string;
}

/** Why the file was read as an empty list (or why some entries were left out). Category only, never content. */
export const RECENT_PROJECTS_PROBLEMS = [
  "unreadable",
  "not_json",
  "bad_format",
  "unknown_version",
  "bad_entries",
] as const;
export type RecentProjectsProblem = (typeof RECENT_PROJECTS_PROBLEMS)[number];

export interface RecentProjectsReading {
  projects: RecentProject[];
  /** Null when the file was read whole, or was not there (a first start). */
  problem: RecentProjectsProblem | null;
}

/** The file in the global data directory. Like `resolveGlobalDirs`, touches nothing but (maybe) config.toml. */
export function resolveRecentProjectsPath(opts: GlobalDirsOptions = {}): string {
  return join(resolveGlobalDirs(opts).dataDir, RECENT_PROJECTS_FILE);
}

function isEntry(value: unknown): value is RecentProject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === "string" &&
    v.path !== "" &&
    isAbsolute(v.path) &&
    typeof v.openedAt === "string" &&
    !Number.isNaN(Date.parse(v.openedAt))
  );
}

export function readRecentProjects(file: string): RecentProjectsReading {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { projects: [], problem: null };
    return { projects: [], problem: "unreadable" };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { projects: [], problem: "not_json" };
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc))
    return { projects: [], problem: "bad_format" };
  const d = doc as Record<string, unknown>;
  if (typeof d.version !== "number") return { projects: [], problem: "bad_format" };
  if (d.version !== RECENT_PROJECTS_VERSION) return { projects: [], problem: "unknown_version" };
  if (!Array.isArray(d.projects)) return { projects: [], problem: "bad_format" };
  const projects: RecentProject[] = [];
  const seen = new Set<string>();
  let dropped = false;
  for (const entry of d.projects) {
    if (!isEntry(entry) || seen.has(entry.path)) {
      dropped = true;
      continue;
    }
    seen.add(entry.path);
    projects.push({ path: entry.path, openedAt: entry.openedAt });
    if (projects.length === RECENT_PROJECTS_MAX) break;
  }
  return { projects, problem: dropped ? "bad_entries" : null };
}

function writeRecentProjects(file: string, projects: RecentProject[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const body = { version: RECENT_PROJECTS_VERSION, projects };
  try {
    writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
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

export interface RecordRecentOptions {
  /**
   * The path the folder was opened by, when it is another spelling of `path` (a symbolic link, say): its entry goes
   * too, so that the folder is listed once.
   */
  replacing?: string;
}

/**
 * The project was opened at `at`: it goes first (once), the list is cut to the limit and the file replaced. Returns
 * the new list. A file that could not be read counts as empty and is replaced. Throws when the file cannot be written
 * (the old bytes stay).
 */
export function recordRecentProject(
  file: string,
  path: string,
  at: Date,
  options: RecordRecentOptions = {}
): RecentProject[] {
  const { projects } = readRecentProjects(file);
  const next = [
    { path, openedAt: at.toISOString() },
    ...projects.filter((p) => p.path !== path && p.path !== options.replacing),
  ].slice(0, RECENT_PROJECTS_MAX);
  writeRecentProjects(file, next);
  return next;
}

/** Removes the entry with exactly this path; nothing is written when there is none. Returns the list. */
export function removeRecentProject(file: string, path: string): RecentProject[] {
  const { projects } = readRecentProjects(file);
  if (!projects.some((p) => p.path === path)) return projects;
  const next = projects.filter((p) => p.path !== path);
  writeRecentProjects(file, next);
  return next;
}
