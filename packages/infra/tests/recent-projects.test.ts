/**
 * Recently opened projects (desktop-app ticket 18): global data, a versioned JSON file of at most 200 entries (path and
 * the time it was last opened), replaced atomically. Concurrent writers: the last one wins. A file that cannot be read
 * is an empty list with a reason (the caller logs it) and is written anew at the next successful open.
 *
 * Only bytes on disk and what the functions return are looked at. Every file is in a temporary directory.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveGlobalDirs } from "../src/global-dirs.js";
import {
  RECENT_PROJECTS_FILE,
  RECENT_PROJECTS_MAX,
  readRecentProjects,
  recordRecentProject,
  removeRecentProject,
  resolveRecentProjectsPath,
} from "../src/recent-projects.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fileIn(): string {
  const root = mkdtempSync(join(tmpdir(), "recent-"));
  roots.push(root);
  return join(root, "global", RECENT_PROJECTS_FILE);
}

const at = (iso: string) => new Date(iso);

describe("readRecentProjects", () => {
  test("no file: an empty list and no problem (a first start)", () => {
    expect(readRecentProjects(fileIn())).toEqual({ projects: [], problem: null });
  });

  test("a file written by record is read back, most recent first", () => {
    const file = fileIn();
    recordRecentProject(file, "/p/a", at("2026-10-01T10:00:00.000Z"));
    recordRecentProject(file, "/p/b", at("2026-10-02T10:00:00.000Z"));
    expect(readRecentProjects(file)).toEqual({
      projects: [
        { path: "/p/b", openedAt: "2026-10-02T10:00:00.000Z" },
        { path: "/p/a", openedAt: "2026-10-01T10:00:00.000Z" },
      ],
      problem: null,
    });
  });

  test.each([
    ["not JSON", "{oops", "not_json"],
    ["not an object", "[]", "bad_format"],
    ["no version", '{"projects":[]}', "bad_format"],
    ["a newer version", '{"version":2,"projects":[]}', "unknown_version"],
    ["projects not a list", '{"version":1,"projects":{}}', "bad_format"],
  ])("%s: an empty list with the reason", (_name, text, reason) => {
    const file = fileIn();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    expect(readRecentProjects(file)).toEqual({ projects: [], problem: reason });
  });

  test("a file that cannot be read (a directory in its place): an empty list, `unreadable`", () => {
    const file = fileIn();
    mkdirSync(file, { recursive: true });
    expect(readRecentProjects(file)).toEqual({ projects: [], problem: "unreadable" });
  });

  test("entries of the wrong shape are left out and counted; the rest are kept", () => {
    const file = fileIn();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        projects: [
          { path: "/p/a", openedAt: "2026-10-01T10:00:00.000Z" },
          { path: "relative/b", openedAt: "2026-10-01T10:00:00.000Z" },
          { path: "/p/c", openedAt: "not a time" },
          "/p/d",
          { path: "/p/a", openedAt: "2026-09-01T10:00:00.000Z" },
          { path: "/p/e", openedAt: "2026-09-01T10:00:00.000Z", extra: true },
        ],
      })
    );
    expect(readRecentProjects(file)).toEqual({
      projects: [
        { path: "/p/a", openedAt: "2026-10-01T10:00:00.000Z" },
        { path: "/p/e", openedAt: "2026-09-01T10:00:00.000Z" },
      ],
      problem: "bad_entries",
    });
  });
});

describe("recordRecentProject", () => {
  test("puts the project first with the time given, once; the file is versioned JSON", () => {
    const file = fileIn();
    recordRecentProject(file, "/p/a", at("2026-10-01T10:00:00.000Z"));
    recordRecentProject(file, "/p/b", at("2026-10-02T10:00:00.000Z"));
    const list = recordRecentProject(file, "/p/a", at("2026-10-03T10:00:00.000Z"));
    expect(list).toEqual([
      { path: "/p/a", openedAt: "2026-10-03T10:00:00.000Z" },
      { path: "/p/b", openedAt: "2026-10-02T10:00:00.000Z" },
    ]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, projects: list });
  });

  test("creates the global directory, and the file only its owner can read", () => {
    const file = fileIn();
    recordRecentProject(file, "/p/a", at("2026-10-01T10:00:00.000Z"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test(`keeps at most ${RECENT_PROJECTS_MAX}: the oldest falls off`, () => {
    const file = fileIn();
    for (let i = 0; i < RECENT_PROJECTS_MAX + 5; i++) {
      recordRecentProject(file, `/p/${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)));
    }
    const { projects } = readRecentProjects(file);
    expect(projects).toHaveLength(RECENT_PROJECTS_MAX);
    expect(projects[0]?.path).toBe(`/p/${RECENT_PROJECTS_MAX + 4}`);
    expect(projects.at(-1)?.path).toBe("/p/5");
  });

  test("an unreadable file is written anew at the next open (only shortcuts are lost)", () => {
    const file = fileIn();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{oops");
    recordRecentProject(file, "/p/a", at("2026-10-01T10:00:00.000Z"));
    expect(readRecentProjects(file)).toEqual({
      projects: [{ path: "/p/a", openedAt: "2026-10-01T10:00:00.000Z" }],
      problem: null,
    });
  });

  test("atomic: no temporary file is left, and a failed write leaves the old bytes", () => {
    const file = fileIn();
    recordRecentProject(file, "/p/a", at("2026-10-01T10:00:00.000Z"));
    const before = readFileSync(file);
    const dir = join(file, "..");
    expect(readdirSync(dir)).toEqual([RECENT_PROJECTS_FILE]);
    if (process.getuid?.() !== 0) {
      chmodSync(dir, 0o500);
      try {
        expect(() => recordRecentProject(file, "/p/b", at("2026-10-02T10:00:00.000Z"))).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(readFileSync(file)).toEqual(before);
      expect(readdirSync(dir)).toEqual([RECENT_PROJECTS_FILE]);
    }
  });
});

describe("removeRecentProject", () => {
  test("removes the entry with that exact path; the others stay in order", () => {
    const file = fileIn();
    recordRecentProject(file, "/p/a", at("2026-10-01T10:00:00.000Z"));
    recordRecentProject(file, "/p/b", at("2026-10-02T10:00:00.000Z"));
    recordRecentProject(file, "/p/c", at("2026-10-03T10:00:00.000Z"));
    expect(removeRecentProject(file, "/p/b").map((p) => p.path)).toEqual(["/p/c", "/p/a"]);
    expect(readRecentProjects(file).projects.map((p) => p.path)).toEqual(["/p/c", "/p/a"]);
  });

  test("a path not in the list: nothing is written", () => {
    const file = fileIn();
    expect(removeRecentProject(file, "/p/x")).toEqual([]);
    expect(() => statSync(file)).toThrow();
  });
});

test("the default file is in the global data directory", () => {
  expect(resolveRecentProjectsPath()).toBe(join(resolveGlobalDirs().dataDir, RECENT_PROJECTS_FILE));
});
