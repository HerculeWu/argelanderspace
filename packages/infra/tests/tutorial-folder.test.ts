/**
 * The tutorial folder on disk (in-app-tutorial ticket 26): its state, copying a sample into it, emptying it. Only a
 * folder with the tutorial marker is ever emptied. Only bytes on disk are looked at; every file is in a temporary
 * directory, the sample a small synthetic one.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  copyTutorialSample,
  emptyTutorialFolder,
  replaceTutorialFolder,
  stageTutorialCopy,
  swapInTutorialCopy,
  TUTORIAL_FOLDER_NAME,
  tutorialFolderState,
} from "../src/tutorial-folder.js";
import { TUTORIAL_MARKER_FILE } from "../src/tutorial-progress.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "tutorial-folder-"));
  roots.push(root);
  return root;
}

function sample(root: string): string {
  const dir = join(root, "sample");
  mkdirSync(join(dir, "literatures", "library"), { recursive: true });
  writeFileSync(join(dir, "literatures", "library", "library.json"), '{"works":[]}\n');
  writeFileSync(join(dir, "NOTICE.md"), "notice\n");
  writeFileSync(join(dir, TUTORIAL_MARKER_FILE), '{"version":1,"sample":3}\n');
  return dir;
}

function tree(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(prefix, entry.name);
    if (entry.isDirectory()) out.push(`${rel}/`, ...tree(join(dir, entry.name), rel));
    else out.push(`${rel} ${readFileSync(join(dir, entry.name), "utf8")}`);
  }
  return out.sort();
}

describe("tutorialFolderState", () => {
  test("missing, empty, marked (with its number), unmarked", () => {
    const root = tempDir();
    expect(tutorialFolderState(join(root, "nothing"))).toEqual({ kind: "missing" });
    mkdirSync(join(root, "empty"));
    expect(tutorialFolderState(join(root, "empty"))).toEqual({ kind: "empty" });
    expect(tutorialFolderState(sample(root))).toEqual({ kind: "marked", sample: 3 });
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "notes.txt"), "mine");
    expect(tutorialFolderState(join(root, "other"))).toEqual({ kind: "unmarked" });
    // A broken marker is no marker; a file is not a folder.
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", TUTORIAL_MARKER_FILE), '{"version":2,"sample":3}');
    expect(tutorialFolderState(join(root, "broken"))).toEqual({ kind: "unmarked" });
    writeFileSync(join(root, "file"), "x");
    expect(tutorialFolderState(join(root, "file"))).toEqual({ kind: "unmarked" });
  });
});

describe("copyTutorialSample", () => {
  test("into a missing folder (made, parents too) and into an empty one: the sample, byte for byte", () => {
    const root = tempDir();
    const from = sample(root);
    copyTutorialSample(from, join(root, "a", "b"));
    expect(tree(join(root, "a", "b"))).toEqual(tree(from));
    mkdirSync(join(root, "empty"));
    copyTutorialSample(from, join(root, "empty"));
    expect(tree(join(root, "empty"))).toEqual(tree(from));
  });

  test("refuses a folder that is not missing or empty, writing nothing", () => {
    const root = tempDir();
    const from = sample(root);
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "notes.txt"), "mine");
    expect(() => copyTutorialSample(from, join(root, "other"))).toThrow(/not missing or empty/);
    expect(tree(join(root, "other"))).toEqual(["notes.txt mine"]);
    expect(() => copyTutorialSample(from, from)).toThrow(/not missing or empty/);
  });

  test("a copy that fails leaves nothing behind: the folder it made is gone, an empty one is empty again", () => {
    const root = tempDir();
    const from = sample(root);
    // The marker cannot be read: everything else was copied first, then removed.
    chmodSync(join(from, TUTORIAL_MARKER_FILE), 0o000);
    expect(() => copyTutorialSample(from, join(root, "made"))).toThrow();
    expect(existsSync(join(root, "made"))).toBe(false);
    mkdirSync(join(root, "empty"));
    expect(() => copyTutorialSample(from, join(root, "empty"))).toThrow();
    expect(readdirSync(join(root, "empty"))).toEqual([]);
    chmodSync(join(from, TUTORIAL_MARKER_FILE), 0o600);
  });
});

describe("emptyTutorialFolder", () => {
  test("empties a marked folder and keeps the folder", () => {
    const root = tempDir();
    const dir = join(root, "tutorial");
    copyTutorialSample(sample(root), dir);
    writeFileSync(join(dir, "mine.txt"), "written in the tutorial");
    emptyTutorialFolder(dir);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses a folder without the marker, touching nothing", () => {
    const root = tempDir();
    mkdirSync(join(root, "other"));
    writeFileSync(join(root, "other", "notes.txt"), "mine");
    expect(() => emptyTutorialFolder(join(root, "other"))).toThrow(/not a tutorial folder/);
    expect(tree(join(root, "other"))).toEqual(["notes.txt mine"]);
    expect(() => emptyTutorialFolder(join(root, "nothing"))).toThrow(/not a tutorial folder/);
  });
});

describe("replaceTutorialFolder (in-app-tutorial ticket 25)", () => {
  function tutorial(root: string): string {
    const dir = join(root, TUTORIAL_FOLDER_NAME);
    mkdirSync(join(dir, "literatures"), { recursive: true });
    writeFileSync(join(dir, TUTORIAL_MARKER_FILE), '{"version":1,"sample":1}\n');
    writeFileSync(join(dir, "literatures", "mine.json"), "written in the tutorial");
    return dir;
  }

  test("a marked folder becomes a fresh copy of the sample; nothing is left beside it", () => {
    const root = tempDir();
    const from = sample(root);
    const dir = tutorial(root);
    expect(replaceTutorialFolder(from, dir)).toBeNull();
    expect(tree(dir)).toEqual(tree(from));
    expect(readdirSync(root).sort()).toEqual([TUTORIAL_FOLDER_NAME, "sample"]);
  });

  test("a copy that fails leaves the folder byte for byte as it was, and no staging folder", () => {
    const root = tempDir();
    const from = sample(root);
    writeFileSync(join(from, "zz-unreadable"), "x");
    chmodSync(join(from, "zz-unreadable"), 0o000);
    const dir = tutorial(root);
    const before = tree(dir);
    expect(() => replaceTutorialFolder(from, dir)).toThrow();
    expect(tree(dir)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual([TUTORIAL_FOLDER_NAME, "sample"]);
    chmodSync(join(from, "zz-unreadable"), 0o600);
  });

  test("a parent that cannot be written: nothing changes", () => {
    const root = tempDir();
    const from = sample(root);
    const parent = join(root, "parent");
    mkdirSync(parent);
    const dir = tutorial(parent);
    const before = tree(dir);
    chmodSync(parent, 0o555);
    expect(() => replaceTutorialFolder(from, dir)).toThrow();
    chmodSync(parent, 0o700);
    expect(tree(dir)).toEqual(before);
    expect(readdirSync(parent)).toEqual([TUTORIAL_FOLDER_NAME]);
  });

  test("a folder without the marker is refused, touching nothing", () => {
    const root = tempDir();
    const from = sample(root);
    const dir = tutorial(root);
    rmSync(join(dir, TUTORIAL_MARKER_FILE));
    const before = tree(dir);
    expect(() => replaceTutorialFolder(from, dir)).toThrow(/not a tutorial folder/);
    expect(tree(dir)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual([TUTORIAL_FOLDER_NAME, "sample"]);
  });

  test("staged first, swapped later: the marker is checked again at the swap, the folder untouched", () => {
    const root = tempDir();
    const from = sample(root);
    const dir = tutorial(root);
    const staging = stageTutorialCopy(from, dir);
    rmSync(join(dir, TUTORIAL_MARKER_FILE));
    const before = tree(dir);
    expect(() => swapInTutorialCopy(dir, staging)).toThrow(/not a tutorial folder/);
    expect(tree(dir)).toEqual(before);
  });
});
