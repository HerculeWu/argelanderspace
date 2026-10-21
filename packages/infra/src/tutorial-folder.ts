/**
 * The tutorial folder on disk (in-app-tutorial ticket 26; spec §2 「浏览器形态命令」, §6 「重新开始」): what is at a
 * folder the tutorial is to use, copying the bundled sample into it, and emptying it before a fresh copy.
 *
 * A tutorial folder is told by its marker (`argelanderspace-tutorial.json`, {@link readTutorialMarker}) at the root,
 * never by its name. Only a folder with the marker is ever emptied: a non-empty folder without it is someone's other
 * data and is refused, with nothing written.
 */

import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readTutorialMarker, TUTORIAL_MARKER_FILE } from "./tutorial-progress.js";

/** The folder the desktop app makes in the parent folder the user picks, and the `tutorial` command's default (ASCII,
 * the same in every language; spec §2). */
export const TUTORIAL_FOLDER_NAME = "ArgelanderSpace-Tutorial";

/**
 * - `missing`: nothing at the path;
 * - `empty`: a folder with nothing in it;
 * - `marked`: a folder with a usable tutorial marker at its root (`sample` is its number);
 * - `unmarked`: anything else — a non-empty folder without a usable marker, or something that is not a folder.
 */
export type TutorialFolderState =
  | { kind: "missing" }
  | { kind: "empty" }
  | { kind: "marked"; sample: number }
  | { kind: "unmarked" };

export function tutorialFolderState(dir: string): TutorialFolderState {
  let isDir: boolean;
  try {
    isDir = statSync(dir).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "unmarked" };
  }
  if (!isDir) return { kind: "unmarked" };
  const sample = readTutorialMarker(dir);
  if (sample !== null) return { kind: "marked", sample };
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return { kind: "unmarked" };
  }
  return entries.length === 0 ? { kind: "empty" } : { kind: "unmarked" };
}

/**
 * Copies the bundled sample into `dir`, which must be missing or an empty folder (made when missing). The marker is
 * copied last, so a copy cut short never looks like a tutorial folder. On failure what this call wrote is removed — the
 * folder itself when this call made it — and the error is thrown.
 */
export function copyTutorialSample(sampleDir: string, dir: string): void {
  const state = tutorialFolderState(dir);
  if (state.kind !== "missing" && state.kind !== "empty") {
    throw new Error(`the tutorial folder ${JSON.stringify(dir)} is not missing or empty`);
  }
  const made = state.kind === "missing";
  try {
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(sampleDir)) {
      if (name === TUTORIAL_MARKER_FILE) continue;
      cpSync(join(sampleDir, name), join(dir, name), {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      });
    }
    cpSync(join(sampleDir, TUTORIAL_MARKER_FILE), join(dir, TUTORIAL_MARKER_FILE), {
      errorOnExist: true,
      force: false,
    });
  } catch (error) {
    try {
      if (made) rmSync(dir, { recursive: true, force: true });
      else emptyFolder(dir);
    } catch {
      /* the copy's own error is the one that counts */
    }
    throw error;
  }
}

/**
 * Empties a tutorial folder — one with the marker at its root — keeping the folder itself. Throws, touching nothing,
 * when the folder has no usable marker. The marker goes last, so a folder emptied only in part is still recognised.
 */
export function emptyTutorialFolder(dir: string): void {
  if (tutorialFolderState(dir).kind !== "marked") {
    throw new Error(`${JSON.stringify(dir)} is not a tutorial folder; it is not emptied`);
  }
  emptyFolder(dir, TUTORIAL_MARKER_FILE);
}

function emptyFolder(dir: string, last?: string): void {
  for (const name of readdirSync(dir)) {
    if (name === last) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
  }
  if (last !== undefined) rmSync(join(dir, last), { force: true });
}

/**
 * Replaces a tutorial folder — one with the marker at its root — by a fresh copy of the sample, so that a failure at
 * any step leaves it exactly as it was ({@link stageTutorialCopy}, then {@link swapInTutorialCopy}). Throws, touching
 * nothing, when the folder has no usable marker. Returns the path of an old folder that could not be removed at the end
 * (a hidden leftover beside it), null otherwise.
 */
export function replaceTutorialFolder(sampleDir: string, dir: string): string | null {
  const staging = stageTutorialCopy(sampleDir, dir);
  try {
    return swapInTutorialCopy(dir, staging);
  } catch (error) {
    discardTutorialCopy(staging);
    throw error;
  }
}

const notTutorial = (dir: string) =>
  new Error(`${JSON.stringify(dir)} is not a tutorial folder; it is not replaced`);

/**
 * The first half of {@link replaceTutorialFolder}: copies the sample into a new hidden folder beside the tutorial folder
 * `dir` (same parent, so that it can take its place by a rename) and returns its path. `dir` is not touched; on failure
 * the new folder is removed and the error thrown. Throws when `dir` has no usable marker.
 */
export function stageTutorialCopy(sampleDir: string, dir: string): string {
  if (tutorialFolderState(dir).kind !== "marked") throw notTutorial(dir);
  const staging = mkdtempSync(join(dirname(dir), `.${basename(dir)}-new-`));
  try {
    copyTutorialSample(sampleDir, staging);
  } catch (error) {
    discardTutorialCopy(staging);
    throw error;
  }
  return staging;
}

/**
 * The second half: the staged copy takes the place of the tutorial folder `dir`, whose marker is checked again — `dir`
 * is renamed aside, the copy renamed into its place, the old one removed. When a rename fails `dir` is put back and the
 * error thrown (the staged copy is left to {@link discardTutorialCopy}). Returns the path of an old folder that could
 * not be removed (a hidden leftover beside it), null otherwise.
 */
export function swapInTutorialCopy(dir: string, staging: string): string | null {
  if (tutorialFolderState(dir).kind !== "marked") throw notTutorial(dir);
  const old = join(dirname(dir), `.${basename(dir)}-old-${randomBytes(4).toString("hex")}`);
  renameSync(dir, old);
  try {
    renameSync(staging, dir);
  } catch (error) {
    renameSync(old, dir);
    throw error;
  }
  try {
    rmSync(old, { recursive: true, force: true });
    return null;
  } catch {
    return old;
  }
}

/** Removes a staged copy that is not used. */
export function discardTutorialCopy(staging: string): void {
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    /* a hidden leftover beside the tutorial folder; nothing depends on it */
  }
}
