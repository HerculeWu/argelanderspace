/**
 * The tutorial folder on disk (in-app-tutorial ticket 25; spec §2 「桌面目标文件夹」, §6 「重新开始」): where a
 * tutorial project goes, how the bundled sample is copied into it, and how a tutorial folder is emptied and filled
 * again. Shared by the desktop host (server `desktop-tutorial.ts`) and the `tutorial` command (ticket 26).
 *
 * A folder is a tutorial folder when it holds the tutorial marker ({@link TUTORIAL_MARKER_FILE}, `readTutorialMarker`)
 * — its name does not matter. Only a tutorial folder is ever emptied; a folder the copy made itself is removed whole
 * when the copy fails, and nothing else is touched: what the user had in the parent folder stays as it was.
 */

import { randomBytes } from "node:crypto";
import { constants, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readTutorialMarker } from "./tutorial-progress.js";

/** The folder the desktop app makes in the parent folder the user picks (ASCII, the same in every language). */
export const TUTORIAL_FOLDER_NAME = "ArgelanderSpace-Tutorial";

/** Whether `dir` is a folder holding a usable tutorial marker. */
export function isTutorialFolder(dir: string): boolean {
  try {
    if (!statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return readTutorialMarker(dir) !== null;
}

/**
 * Where the tutorial goes for a folder the user picked:
 * - `marked`: the picked folder is a tutorial folder itself, or holds one named {@link TUTORIAL_FOLDER_NAME}: taken as
 *   it is (nothing is copied);
 * - `create`: nothing of that name is in the picked folder: it is made there and the sample copied in;
 * - `fill`: an empty folder of that name is there: the sample is copied into it;
 * - `conflict`: something else of that name is there (a folder that is not empty and has no marker, or a file);
 * - `not_a_folder`: what was picked is not a folder (`path` is the picked path).
 */
export type TutorialTarget =
  | { kind: "marked"; path: string }
  | { kind: "create"; path: string }
  | { kind: "fill"; path: string }
  | { kind: "conflict"; path: string }
  | { kind: "not_a_folder"; path: string };

export function tutorialTargetIn(picked: string): TutorialTarget {
  let pickedIsFolder = false;
  try {
    pickedIsFolder = statSync(picked).isDirectory();
  } catch {
    /* not there, or not to be looked at */
  }
  if (!pickedIsFolder) return { kind: "not_a_folder", path: picked };
  if (readTutorialMarker(picked) !== null) return { kind: "marked", path: picked };
  const child = join(picked, TUTORIAL_FOLDER_NAME);
  let isDir: boolean;
  try {
    isDir = statSync(child).isDirectory();
  } catch {
    // Not there (or not to be looked at: making it then fails, and that is the copy's failure).
    return { kind: "create", path: child };
  }
  if (!isDir) return { kind: "conflict", path: child };
  if (readTutorialMarker(child) !== null) return { kind: "marked", path: child };
  let empty = false;
  try {
    empty = readdirSync(child).length === 0;
  } catch {
    /* cannot be listed: not ours to fill */
  }
  return empty ? { kind: "fill", path: child } : { kind: "conflict", path: child };
}

/** Thrown by a copy that was told to stop (`shouldStop`) before it finished. */
export class TutorialCopyStopped extends Error {
  constructor() {
    super("the copy of the tutorial sample was stopped");
    this.name = "TutorialCopyStopped";
  }
}

export interface TutorialCopyOptions {
  /** Asked before each entry: true ends the copy with {@link TutorialCopyStopped} (what was written is removed). */
  shouldStop?: () => boolean;
  /** Tests only: the copy itself (default {@link copyTutorialSample}); the clean-up around it is the same. */
  copy?: (sample: string, into: string, opts: TutorialCopyOptions) => Promise<void>;
}

const copyOf = (opts: TutorialCopyOptions) => opts.copy ?? copyTutorialSample;

/**
 * Copies the sample's entries into the folder `into` (which exists): folders and regular files only, never over an
 * existing file. Anything else in the sample (a link, a device) fails the copy.
 */
export async function copyTutorialSample(
  sample: string,
  into: string,
  opts: TutorialCopyOptions = {}
): Promise<void> {
  for (const entry of await readdir(sample, { withFileTypes: true })) {
    if (opts.shouldStop?.()) throw new TutorialCopyStopped();
    const from = join(sample, entry.name);
    const to = join(into, entry.name);
    if (entry.isDirectory()) {
      await mkdir(to);
      await copyTutorialSample(from, to, opts);
    } else if (entry.isFile()) {
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } else {
      throw Object.assign(new Error("the tutorial sample holds an entry that is not a file or a folder"), {
        code: "EUNSUPPORTED",
      });
    }
  }
}

/**
 * Fills a `create` or `fill` target with the sample. On any failure what this call wrote is removed — the whole folder
 * when it made it, the entries it copied when the folder was there (empty) before — and the error is thrown.
 */
export async function fillTutorialFolder(
  sample: string,
  target: Extract<TutorialTarget, { kind: "create" | "fill" }>,
  opts: TutorialCopyOptions = {}
): Promise<void> {
  if (target.kind === "create") await mkdir(target.path);
  try {
    await copyOf(opts)(sample, target.path, opts);
  } catch (error) {
    await unfillTutorialFolder(target);
    throw error;
  }
}

/**
 * Removes what {@link fillTutorialFolder} wrote: the whole folder of a `create` target, the entries of a `fill` target
 * (empty before). Failures are swallowed: the caller reports the failure that led here.
 */
export async function unfillTutorialFolder(
  target: Extract<TutorialTarget, { kind: "create" | "fill" }>
): Promise<void> {
  try {
    if (target.kind === "create") await rm(target.path, { recursive: true, force: true });
    else
      for (const name of readdirSync(target.path))
        await rm(join(target.path, name), { recursive: true, force: true });
  } catch {
    /* what could not be removed stays; the caller's failure is the one that counts */
  }
}

/** A fresh copy of the sample next to a tutorial folder, waiting to take its place ({@link swapStagedTutorial}). */
export interface StagedTutorial {
  target: string;
  staging: string;
}

/** The error of a folder that is to be emptied but holds no tutorial marker: it is never touched. */
export class NotATutorialFolder extends Error {
  readonly code = "ENOTTUTORIAL";
  constructor() {
    super("the folder is not a tutorial folder");
    this.name = "NotATutorialFolder";
  }
}

/**
 * Copies the sample into a new hidden folder beside the tutorial folder `target` (same parent, so that it can take
 * the folder's place by a rename). On failure the new folder is removed and the error thrown; `target` is not touched.
 */
export async function stageTutorialSample(
  sample: string,
  target: string,
  opts: TutorialCopyOptions = {}
): Promise<StagedTutorial> {
  if (!isTutorialFolder(target)) throw new NotATutorialFolder();
  const staging = await mkdtemp(join(dirname(target), `.${basename(target)}-new-`));
  try {
    await copyOf(opts)(sample, staging, opts);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { target, staging };
}

/**
 * The staged copy takes the tutorial folder's place: the folder is renamed aside, the copy renamed to its name, and the
 * old one removed. The folder must still hold its marker. When a rename fails the folder is put back as it was and the
 * error thrown (the staged copy is left for {@link discardStagedTutorial}). Returns the old folder's path when it could
 * not be removed afterwards (a leftover beside the tutorial folder), null otherwise.
 */
export function swapStagedTutorial(staged: StagedTutorial): string | null {
  const { target, staging } = staged;
  if (!isTutorialFolder(target)) throw new NotATutorialFolder();
  const old = join(dirname(target), `.${basename(target)}-old-${randomBytes(4).toString("hex")}`);
  renameSync(target, old);
  try {
    renameSync(staging, target);
  } catch (error) {
    renameSync(old, target);
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
export function discardStagedTutorial(staged: StagedTutorial): void {
  try {
    rmSync(staged.staging, { recursive: true, force: true });
  } catch {
    /* a leftover hidden folder; nothing else depends on it */
  }
}

/**
 * Empties the tutorial folder `target` and copies the sample into it again (the `tutorial --reset` of ticket 26, and the
 * desktop host's restart from a state where the folder is not open). Only a folder with the marker: otherwise
 * {@link NotATutorialFolder} and nothing is touched. A failure leaves the folder as it was.
 */
export async function resetTutorialFolder(
  sample: string,
  target: string,
  opts: TutorialCopyOptions = {}
): Promise<void> {
  const staged = await stageTutorialSample(sample, target, opts);
  try {
    swapStagedTutorial(staged);
  } catch (error) {
    discardStagedTutorial(staged);
    throw error;
  }
}
