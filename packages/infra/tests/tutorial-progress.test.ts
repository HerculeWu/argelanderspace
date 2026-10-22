/**
 * Tutorial progress (in-app-tutorial ticket 18): global data, `<global data dir>/tutorial.json`, read whole and replaced
 * whole (a temporary file renamed over it), no lock, the last writer wins. A file that cannot be used is no progress,
 * with the reason for the caller's log. And the tutorial marker at the root of a folder: its `sample` number, or null.
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
import type { TutorialProgress } from "@argelanderspace/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { bundledTutorialDir } from "../src/cli-launcher.js";
import { resolveGlobalDirs } from "../src/global-dirs.js";
import {
  newTutorialProgress,
  readTutorialMarker,
  readTutorialProgress,
  resolveTutorialProgressPath,
  TUTORIAL_MARKER_FILE,
  TUTORIAL_PROGRESS_FILE,
  tutorialProgressOf,
  writeTutorialProgress,
} from "../src/tutorial-progress.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "tutorial-"));
  roots.push(root);
  return root;
}

function fileIn(): string {
  return join(tempDir(), "global", TUTORIAL_PROGRESS_FILE);
}

const PROGRESS: TutorialProgress = {
  version: 1,
  project: { path: "/home/someone/ArgelanderSpace-Tutorial" },
  startedAt: "2026-10-21T08:00:00.000Z",
  updatedAt: "2026-10-21T09:30:00.000Z",
  position: "library.add-bibtex",
  steps: {
    "welcome.intro": { state: "done", at: "2026-10-21T08:01:00.000Z" },
    "library.import": { state: "skipped", at: "2026-10-21T09:00:00.000Z" },
  },
  appVersion: "0.2.0",
};

describe("readTutorialProgress", () => {
  test("no file: no progress and no problem (never started)", () => {
    expect(readTutorialProgress(fileIn())).toEqual({ progress: null, problem: null });
  });

  test("a file written by writeTutorialProgress is read back as it was", () => {
    const file = fileIn();
    writeTutorialProgress(file, PROGRESS);
    expect(readTutorialProgress(file)).toEqual({ progress: PROGRESS, problem: null });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(PROGRESS);
  });

  test("no project bound and no position: null both", () => {
    const file = fileIn();
    const blank = { ...PROGRESS, project: null, position: null, steps: {} };
    writeTutorialProgress(file, blank);
    expect(readTutorialProgress(file)).toEqual({ progress: blank, problem: null });
  });

  test.each([
    ["not JSON", "{oops", "not_json"],
    ["not an object", "[]", "bad_format"],
    ["no version", JSON.stringify({ ...PROGRESS, version: undefined }), "bad_format"],
    ["a version it does not know", JSON.stringify({ ...PROGRESS, version: 2 }), "unknown_version"],
    [
      "a step of another state",
      JSON.stringify({ ...PROGRESS, steps: { a: { state: "running", at: PROGRESS.updatedAt } } }),
      "bad_format",
    ],
    [
      "a relative project path",
      JSON.stringify({ ...PROGRESS, project: { path: "Tutorial" } }),
      "bad_format",
    ],
    ["a key it does not know", JSON.stringify({ ...PROGRESS, hintShownAt: null }), "bad_format"],
  ])("%s: no progress, with the reason", (_name, text, reason) => {
    const file = fileIn();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
    expect(readTutorialProgress(file)).toEqual({ progress: null, problem: reason });
  });

  test("a file that cannot be read (a directory in its place): no progress, `unreadable`", () => {
    const file = fileIn();
    mkdirSync(file, { recursive: true });
    expect(readTutorialProgress(file)).toEqual({ progress: null, problem: "unreadable" });
  });
});

describe("tutorialProgressOf (what PUT checks)", () => {
  test("a whole progress of version 1: accepted as it is", () => {
    expect(tutorialProgressOf(PROGRESS)).toEqual({ ok: true, progress: PROGRESS });
  });

  test("another version: `unknown_version`; anything else wrong: `bad_format`", () => {
    expect(tutorialProgressOf({ ...PROGRESS, version: 2 })).toEqual({
      ok: false,
      problem: "unknown_version",
    });
    expect(tutorialProgressOf({ ...PROGRESS, version: "1" })).toEqual({
      ok: false,
      problem: "unknown_version",
    });
    expect(tutorialProgressOf({ ...PROGRESS, startedAt: "yesterday" })).toEqual({
      ok: false,
      problem: "bad_format",
    });
    expect(tutorialProgressOf(null)).toEqual({ ok: false, problem: "bad_format" });
  });
});

describe("writeTutorialProgress", () => {
  test("creates the global directory, and the file only its owner can read", () => {
    const file = fileIn();
    writeTutorialProgress(file, PROGRESS);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("replaces the whole file: the last write wins", () => {
    const file = fileIn();
    writeTutorialProgress(file, PROGRESS);
    const next = { ...PROGRESS, position: "reader.open", updatedAt: "2026-10-21T10:00:00.000Z" };
    writeTutorialProgress(file, next);
    expect(readTutorialProgress(file).progress).toEqual(next);
  });

  test("a file that could not be read is simply replaced", () => {
    const file = fileIn();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "{oops");
    writeTutorialProgress(file, PROGRESS);
    expect(readTutorialProgress(file)).toEqual({ progress: PROGRESS, problem: null });
  });

  test("atomic: no temporary file is left, and a failed write leaves the old bytes", () => {
    const file = fileIn();
    writeTutorialProgress(file, PROGRESS);
    const before = readFileSync(file);
    const dir = join(file, "..");
    expect(readdirSync(dir)).toEqual([TUTORIAL_PROGRESS_FILE]);
    if (process.getuid?.() !== 0) {
      chmodSync(dir, 0o500);
      try {
        expect(() => writeTutorialProgress(file, { ...PROGRESS, position: null })).toThrow();
      } finally {
        chmodSync(dir, 0o700);
      }
      expect(readFileSync(file)).toEqual(before);
      expect(readdirSync(dir)).toEqual([TUTORIAL_PROGRESS_FILE]);
    }
  });

  test("a rename that fails (a directory in the file's place) leaves no temporary file", () => {
    const file = fileIn();
    mkdirSync(join(file, "inside"), { recursive: true });
    expect(() => writeTutorialProgress(file, PROGRESS)).toThrow();
    expect(readdirSync(join(file, ".."))).toEqual([TUTORIAL_PROGRESS_FILE]);
    expect(readdirSync(file)).toEqual(["inside"]);
  });
});

describe("readTutorialMarker", () => {
  function folderWithMarker(text: string | null): string {
    const dir = tempDir();
    if (text !== null) writeFileSync(join(dir, TUTORIAL_MARKER_FILE), text);
    return dir;
  }

  test("a marker {version: 1, sample: n}: n", () => {
    expect(readTutorialMarker(folderWithMarker('{"version":1,"sample":3}'))).toBe(3);
  });

  test("no marker, no folder: null", () => {
    expect(readTutorialMarker(folderWithMarker(null))).toBeNull();
    expect(readTutorialMarker(join(tempDir(), "gone"))).toBeNull();
  });

  test.each([
    ["not JSON", "{oops"],
    ["another version", '{"version":2,"sample":3}'],
    ["no sample", '{"version":1}'],
    ["a sample that is not a whole number", '{"version":1,"sample":1.5}'],
    ["a negative sample", '{"version":1,"sample":-1}'],
    ["a key more than the two", '{"version":1,"sample":3,"extra":true}'],
    ["not an object", "[1,3]"],
  ])("a bad marker (%s): null", (_name, text) => {
    expect(readTutorialMarker(folderWithMarker(text))).toBeNull();
  });

  test("a directory with the marker's name: null", () => {
    const dir = tempDir();
    mkdirSync(join(dir, TUTORIAL_MARKER_FILE));
    expect(readTutorialMarker(dir)).toBeNull();
  });

  test("the marker bundledTutorialDir looks for is this one", () => {
    const root = tempDir();
    const entry = join(root, "node_modules", "argelanderspace", "dist", "bin.js");
    const sample = join(root, "node_modules", "argelanderspace", "dist", "tutorial");
    mkdirSync(sample, { recursive: true });
    writeFileSync(join(sample, TUTORIAL_MARKER_FILE), '{"version":1,"sample":1}');
    expect(bundledTutorialDir(entry)).toBe(sample);
  });
});

test("the default file is in the global data directory", () => {
  expect(resolveTutorialProgressPath()).toBe(
    join(resolveGlobalDirs().dataDir, TUTORIAL_PROGRESS_FILE)
  );
});

describe("a new progress (the desktop host's and the CLI's, one shape)", () => {
  test("bound to the folder, nothing done yet, started and updated now, with the app's version", () => {
    const progress = newTutorialProgress(
      "/t/ArgelanderSpace-Tutorial",
      "0.4.2",
      new Date("2026-10-21T08:00:00.000Z")
    );
    expect(progress).toEqual({
      version: 1,
      project: { path: "/t/ArgelanderSpace-Tutorial" },
      startedAt: "2026-10-21T08:00:00.000Z",
      updatedAt: "2026-10-21T08:00:00.000Z",
      position: null,
      steps: {},
      appVersion: "0.4.2",
    });
    expect(tutorialProgressOf(progress)).toEqual({ ok: true, progress });
  });
  test("an app version longer than the progress takes is cut to 64 characters", () => {
    const progress = newTutorialProgress("/t", "9".repeat(80));
    expect(progress.appVersion).toBe("9".repeat(64));
    expect(tutorialProgressOf(progress).ok).toBe(true);
  });
});
