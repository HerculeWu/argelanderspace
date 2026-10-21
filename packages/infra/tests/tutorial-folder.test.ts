/**
 * The tutorial folder on disk (in-app-tutorial ticket 25): where the tutorial goes in a picked folder, the copy of the
 * sample (and what is removed when it fails), and the restart that empties only a marked folder. Only bytes on disk and
 * what the functions return are looked at. Every file is in a temporary directory.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  fillTutorialFolder,
  isTutorialFolder,
  NotATutorialFolder,
  resetTutorialFolder,
  stageTutorialSample,
  swapStagedTutorial,
  TUTORIAL_FOLDER_NAME,
  TutorialCopyStopped,
  tutorialTargetIn,
} from "../src/tutorial-folder.js";
import { TUTORIAL_MARKER_FILE } from "../src/tutorial-progress.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodRecursive(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function chmodRecursive(dir: string): void {
  try {
    chmodSync(dir, 0o755);
    for (const name of readdirSync(dir, { withFileTypes: true }))
      if (name.isDirectory()) chmodRecursive(join(dir, name.name));
  } catch {
    /* gone */
  }
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aspace-tutorial-folder-"));
  roots.push(dir);
  return dir;
}

const MARKER = '{"version":1,"sample":3}\n';

/** A small sample: the marker, a notice and a nested file. */
function sample(): string {
  const dir = join(tempDir(), "sample");
  mkdirSync(join(dir, "literatures", "library"), { recursive: true });
  writeFileSync(join(dir, TUTORIAL_MARKER_FILE), MARKER);
  writeFileSync(join(dir, "NOTICE.md"), "notice\n");
  writeFileSync(join(dir, "literatures", "library", "library.json"), '{"works":[]}\n');
  return dir;
}

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
      out.push(r);
      if (entry.isDirectory()) walk(join(at, entry.name), r);
    }
  };
  walk(dir, "");
  return out.sort();
}

describe("where the tutorial goes in a picked folder", () => {
  test("nothing of that name: made there", () => {
    const parent = tempDir();
    expect(tutorialTargetIn(parent)).toEqual({
      kind: "create",
      path: join(parent, TUTORIAL_FOLDER_NAME),
    });
  });

  test("the picked folder is a tutorial folder itself: taken as it is, whatever its name", () => {
    const own = join(tempDir(), "my tutorial");
    mkdirSync(own);
    writeFileSync(join(own, TUTORIAL_MARKER_FILE), MARKER);
    expect(tutorialTargetIn(own)).toEqual({ kind: "marked", path: own });
  });

  test("a marked folder of that name in it: taken; an empty one: filled; anything else: a conflict", () => {
    const parent = tempDir();
    const child = join(parent, TUTORIAL_FOLDER_NAME);
    mkdirSync(child);
    expect(tutorialTargetIn(parent)).toEqual({ kind: "fill", path: child });
    writeFileSync(join(child, "notes.txt"), "mine");
    expect(tutorialTargetIn(parent)).toEqual({ kind: "conflict", path: child });
    writeFileSync(join(child, TUTORIAL_MARKER_FILE), MARKER);
    expect(tutorialTargetIn(parent)).toEqual({ kind: "marked", path: child });
    // A broken marker is no marker.
    writeFileSync(join(child, TUTORIAL_MARKER_FILE), "{");
    expect(tutorialTargetIn(parent)).toEqual({ kind: "conflict", path: child });
    const other = tempDir();
    writeFileSync(join(other, TUTORIAL_FOLDER_NAME), "a file");
    expect(tutorialTargetIn(other)).toEqual({
      kind: "conflict",
      path: join(other, TUTORIAL_FOLDER_NAME),
    });
  });

  test("what was picked is not a folder", () => {
    const file = join(tempDir(), "file.txt");
    writeFileSync(file, "x");
    expect(tutorialTargetIn(file)).toEqual({ kind: "not_a_folder", path: file });
    expect(tutorialTargetIn(join(file, "gone"))).toMatchObject({ kind: "not_a_folder" });
  });
});

describe("filling the folder", () => {
  test("made and filled: the sample's bytes, nothing else", async () => {
    const from = sample();
    const parent = tempDir();
    const target = tutorialTargetIn(parent);
    if (target.kind !== "create") throw new Error("expected create");
    await fillTutorialFolder(from, target);
    expect(tree(target.path)).toEqual(tree(from));
    expect(readFileSync(join(target.path, TUTORIAL_MARKER_FILE), "utf8")).toBe(MARKER);
    expect(isTutorialFolder(target.path)).toBe(true);
  });

  test("a failure in the middle removes the folder it made, and only it", async () => {
    const from = sample();
    writeFileSync(join(from, "secret.bin"), "x");
    chmodSync(join(from, "secret.bin"), 0o000);
    const parent = tempDir();
    writeFileSync(join(parent, "mine.txt"), "the user's");
    const target = tutorialTargetIn(parent);
    if (target.kind !== "create") throw new Error("expected create");
    await expect(fillTutorialFolder(from, target)).rejects.toMatchObject({ code: "EACCES" });
    expect(readdirSync(parent)).toEqual(["mine.txt"]);
    expect(readFileSync(join(parent, "mine.txt"), "utf8")).toBe("the user's");
  });

  test("an empty folder that was there: emptied again on failure, not removed", async () => {
    const from = sample();
    writeFileSync(join(from, "zz-unreadable"), "x");
    chmodSync(join(from, "zz-unreadable"), 0o000);
    const parent = tempDir();
    mkdirSync(join(parent, TUTORIAL_FOLDER_NAME));
    const target = tutorialTargetIn(parent);
    if (target.kind !== "fill") throw new Error("expected fill");
    await expect(fillTutorialFolder(from, target)).rejects.toThrow();
    expect(readdirSync(target.path)).toEqual([]);
  });

  test("a read-only parent: nothing is made", async () => {
    const from = sample();
    const parent = tempDir();
    chmodSync(parent, 0o555);
    const target = tutorialTargetIn(parent);
    if (target.kind !== "create") throw new Error("expected create");
    await expect(fillTutorialFolder(from, target)).rejects.toMatchObject({ code: "EACCES" });
    expect(existsSync(target.path)).toBe(false);
  });

  test("told to stop: stops and removes what it wrote", async () => {
    const from = sample();
    const parent = tempDir();
    const target = tutorialTargetIn(parent);
    if (target.kind !== "create") throw new Error("expected create");
    let asked = 0;
    await expect(
      fillTutorialFolder(from, target, { shouldStop: () => ++asked > 1 })
    ).rejects.toBeInstanceOf(TutorialCopyStopped);
    expect(readdirSync(parent)).toEqual([]);
  });

  test("a link in the sample fails the copy (only files and folders are copied)", async () => {
    const from = sample();
    symlinkSync("/etc/hostname", join(from, "link"));
    const parent = tempDir();
    const target = tutorialTargetIn(parent);
    if (target.kind !== "create") throw new Error("expected create");
    await expect(fillTutorialFolder(from, target)).rejects.toMatchObject({ code: "EUNSUPPORTED" });
    expect(readdirSync(parent)).toEqual([]);
  });
});

describe("restarting a tutorial folder", () => {
  function tutorial(): string {
    const dir = join(tempDir(), TUTORIAL_FOLDER_NAME);
    mkdirSync(join(dir, "literatures", "annotations"), { recursive: true });
    writeFileSync(join(dir, TUTORIAL_MARKER_FILE), '{"version":1,"sample":1}\n');
    writeFileSync(join(dir, "literatures", "annotations", "mine.json"), "what I wrote");
    return dir;
  }

  test("a marked folder: emptied and filled with the sample again; nothing is left beside it", async () => {
    const from = sample();
    const target = tutorial();
    await resetTutorialFolder(from, target);
    expect(tree(target)).toEqual(tree(from));
    expect(readFileSync(join(target, TUTORIAL_MARKER_FILE), "utf8")).toBe(MARKER);
    expect(readdirSync(join(target, ".."))).toEqual([TUTORIAL_FOLDER_NAME]);
  });

  test("a folder without the marker is never touched, empty or not", async () => {
    const from = sample();
    const target = tutorial();
    rmSync(join(target, TUTORIAL_MARKER_FILE));
    const before = tree(target);
    await expect(resetTutorialFolder(from, target)).rejects.toBeInstanceOf(NotATutorialFolder);
    expect(tree(target)).toEqual(before);
    expect(readdirSync(join(target, ".."))).toEqual([TUTORIAL_FOLDER_NAME]);
  });

  test("a copy that fails leaves the folder as it was and nothing beside it", async () => {
    const from = sample();
    writeFileSync(join(from, "zz"), "x");
    chmodSync(join(from, "zz"), 0o000);
    const target = tutorial();
    const before = tree(target);
    await expect(resetTutorialFolder(from, target)).rejects.toThrow();
    expect(tree(target)).toEqual(before);
    expect(readFileSync(join(target, "literatures", "annotations", "mine.json"), "utf8")).toBe(
      "what I wrote"
    );
    expect(readdirSync(join(target, ".."))).toEqual([TUTORIAL_FOLDER_NAME]);
  });

  test("staged first, swapped later: the marker is checked again at the swap", async () => {
    const from = sample();
    const target = tutorial();
    const staged = await stageTutorialSample(from, target);
    rmSync(join(target, TUTORIAL_MARKER_FILE));
    expect(() => swapStagedTutorial(staged)).toThrow(NotATutorialFolder);
    expect(existsSync(join(target, "literatures", "annotations", "mine.json"))).toBe(true);
  });
});
