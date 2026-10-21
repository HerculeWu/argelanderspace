/**
 * The tutorial's entry in the desktop host (in-app-tutorial ticket 25; spec §2 「桌面目标文件夹」「宿主接口」, §6
 * 「重新开始」): "Start / Resume tutorial" and "Restart…" on the welcome page and the settings page, carried out by the
 * host, which alone knows the folders. The page never hands it a path.
 *
 * - pick: the host writes the existing `pick_folder` line with an id it marks as the tutorial's. The answer is the
 *   parent folder (or a tutorial folder itself): an `ArgelanderSpace-Tutorial` is made there
 *   and the bundled sample copied in (or the marked folder that is there taken as it is), the progress bound to it
 *   (cleared, unless it was bound to that folder already), the folder recorded among the recent projects, and left for.
 *   Which folder that is — the picked one when it has the marker, else `ArgelanderSpace-Tutorial` in it — is the
 *   host's rule ({@link tutorialTargetIn}); the copy and the emptying are infra's `tutorial-folder.ts` (shared with
 *   the `tutorial` command, ticket 26).
 * - continue: the folder `tutorial.json` is bound to, when it is there and marked; left for.
 * - restart: the bound folder, only when marked, replaced by a fresh copy of the sample: copied first into a hidden
 *   folder beside it (infra `stageTutorialCopy`; a failure is announced and the folder is left as it was), then swapped
 *   in by rename (`swapInTutorialCopy`; a failed rename puts the folder back), the progress cleared, left for. When the
 *   tutorial project is the one open, the swap waits until its server has closed (before `stopped`); a switch that is
 *   given up removes the staged copy.
 *
 * Leaving goes through the host's own switch (`go`): at once in the welcome state or when nothing would be interrupted,
 * otherwise held and announced as a picked folder is (`host.switch-confirmation`) — the folder is made first, so a
 * cancelled switch leaves it bound and the page offers to resume. A failure after the request was taken is announced to
 * the pages (`host.tutorial-result`) and nothing is left for: what the copy wrote is removed (only what this host made),
 * and a half-made folder is never opened. The copy is synchronous: the host answers
 * nothing else meanwhile. The log has the action and the reason's category only, never a path.
 */

import { rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  HOST_TUTORIAL_ACTIONS,
  HOST_TUTORIAL_FAILURES,
  type HostShownPath,
  type HostTutorialAction,
  type HostTutorialFailure,
  type HostTutorialRefusal,
  type TutorialProgress,
  type WsHostTutorialResult,
} from "@argelanderspace/contracts";
import {
  copyTutorialSample,
  discardTutorialCopy,
  emptyTutorialFolder,
  f,
  readTutorialProgress,
  stageTutorialCopy,
  swapInTutorialCopy,
  TUTORIAL_FOLDER_NAME,
  tutorialFolderState,
  writeTutorialProgress,
} from "@argelanderspace/infra";
import type { ServerLog } from "./log.js";

/** How an entry ended up, as `desktop.tutorial_entered` records it. */
export const TUTORIAL_ENTRY_OUTCOMES = ["created", "resumed", "rebound", "restarted"] as const;
/**
 * Why an entry failed, as `desktop.tutorial_failed` records it: the announced reasons, and `bind_failed` — the folder
 * was made but `tutorial.json` could not be written (announced as `copy_failed`; the folder is removed again).
 */
export const TUTORIAL_FAILURE_RECORDS = [...HOST_TUTORIAL_FAILURES, "bind_failed"] as const;

/**
 * Where the tutorial goes for a folder the user picked: the folder itself when it holds the marker; else
 * `ArgelanderSpace-Tutorial` in it — taken as it is when marked, filled when missing or empty, a conflict otherwise.
 */
export type TutorialTarget =
  | { kind: "marked"; path: string }
  | { kind: "copy"; path: string }
  | { kind: "conflict"; path: string }
  | { kind: "not_a_folder"; path: string };

export function tutorialTargetIn(picked: string): TutorialTarget {
  let isDir = false;
  try {
    isDir = statSync(picked).isDirectory();
  } catch {
    /* not there, or not to be looked at */
  }
  if (!isDir) return { kind: "not_a_folder", path: picked };
  if (tutorialFolderState(picked).kind === "marked") return { kind: "marked", path: picked };
  const child = join(picked, TUTORIAL_FOLDER_NAME);
  switch (tutorialFolderState(child).kind) {
    case "marked":
      return { kind: "marked", path: child };
    case "missing":
    case "empty":
      return { kind: "copy", path: child };
    case "unmarked":
      return { kind: "conflict", path: child };
  }
}

/** What the host gives the tutorial's entry. */
export interface TutorialHostDeps {
  /** The bundled sample (infra `bundledTutorialDir`); null: this installation has none. */
  sampleDir: string | null;
  /** `<global data dir>/tutorial.json`. */
  progressFile: string;
  /** The app's version, written into a progress the host starts (`appVersion`, for diagnosis only). */
  appVersion: string;
  log(): ServerLog | null;
  stopping(): boolean;
  /** Whether the folder is the project open now. */
  isCurrent(path: string): boolean;
  /** The path with its links resolved, as the host names projects. */
  canonical(path: string): string;
  shownPath(path: string): HostShownPath;
  /** Writes the `pick_folder` request line; the id its answer will carry, or null when that was not possible. */
  requestPick(): string | null;
  /** Records the folder first among the recent projects. */
  record(path: string): void;
  /**
   * Leaves for the folder (at once, or once the user confirmed what the switch would interrupt). `afterClose` runs when
   * the server has closed, before `stopped`; `onDrop` when a held switch is given up instead (or the host stops).
   */
  go(path: string, extra: { afterClose?: () => void; onDrop?: () => void }): void;
  /** Tells every page of the server (none while it is closing or closed). */
  broadcast(message: WsHostTutorialResult): void;
}

export type TutorialRequestOutcome = "accepted" | HostTutorialRefusal;

export interface TutorialEntry {
  pick(): TutorialRequestOutcome;
  continue(): TutorialRequestOutcome;
  restart(): TutorialRequestOutcome;
  /** Whether the answer to a `pick_folder` line is the tutorial's; if so it is taken care of here. */
  picked(id: string, path: string | null): boolean;
}

export function createTutorialEntry(deps: TutorialHostDeps): TutorialEntry {
  const tutorialPicks = new Set<string>();

  const bound = (): string | null => {
    const { progress } = readTutorialProgress(deps.progressFile);
    return progress?.project?.path ?? null;
  };
  const marked = (path: string) => tutorialFolderState(path).kind === "marked";

  const fresh = (path: string): TutorialProgress => {
    const now = new Date().toISOString();
    return {
      version: 1,
      project: { path },
      startedAt: now,
      updatedAt: now,
      position: null,
      steps: {},
      appVersion: deps.appVersion.slice(0, 64),
    };
  };

  const entered = (action: HostTutorialAction, outcome: (typeof TUTORIAL_ENTRY_OUTCOMES)[number]) =>
    deps.log()?.info("desktop.tutorial_entered", {
      action: f.oneOf(HOST_TUTORIAL_ACTIONS, action),
      outcome: f.oneOf(TUTORIAL_ENTRY_OUTCOMES, outcome),
    });

  const recordFailure = (
    action: HostTutorialAction,
    reason: (typeof TUTORIAL_FAILURE_RECORDS)[number]
  ) =>
    deps.log()?.warn("desktop.tutorial_failed", {
      action: f.oneOf(HOST_TUTORIAL_ACTIONS, action),
      reason: f.oneOf(TUTORIAL_FAILURE_RECORDS, reason),
    });

  /** Records the failure and tells the pages what it was about. */
  const fail = (
    action: HostTutorialAction,
    reason: (typeof TUTORIAL_FAILURE_RECORDS)[number],
    path: string
  ) => {
    recordFailure(action, reason);
    const announce: HostTutorialFailure = reason === "bind_failed" ? "copy_failed" : reason;
    deps.broadcast({ type: "host.tutorial-result", reason: announce, path: deps.shownPath(path) });
  };

  /** Binds a fresh progress to the folder; false (recorded and announced) when it could not be written. */
  const bind = (action: HostTutorialAction, path: string): boolean => {
    try {
      writeTutorialProgress(deps.progressFile, fresh(path));
      return true;
    } catch {
      fail(action, "bind_failed", path);
      return false;
    }
  };

  /** A folder the shell picked for the tutorial. */
  function onPicked(picked: string, sample: string): void {
    // The answer came while the host stops: nothing is made, nothing left for.
    if (deps.stopping()) {
      fail("pick", "shutting_down", picked);
      return;
    }
    const target = tutorialTargetIn(picked);
    if (target.kind === "not_a_folder") {
      fail("pick", "not_a_folder", target.path);
      return;
    }
    if (target.kind === "conflict") {
      fail("pick", "target_conflict", target.path);
      return;
    }
    if (target.kind === "marked") {
      const path = deps.canonical(target.path);
      // Bound to it already: resumed as it was. Otherwise bound anew, from the start (spec §2: 改绑并续上).
      const already = bound() === path;
      if (!already && !bind("pick", path)) return;
      entered("pick", already ? "resumed" : "rebound");
      deps.record(path);
      if (!deps.isCurrent(path)) deps.go(path, {});
      return;
    }
    // Missing or empty: filled. A failed copy removes what it wrote (the folder itself when it made it).
    const existed = tutorialFolderState(target.path).kind === "empty";
    try {
      copyTutorialSample(sample, target.path);
    } catch {
      fail("pick", "copy_failed", target.path);
      return;
    }
    const path = deps.canonical(target.path);
    if (!bind("pick", path)) {
      // Never left for, and not left behind half-bound: what was made goes again.
      undoCopy(target.path, existed);
      return;
    }
    entered("pick", "created");
    deps.record(path);
    deps.go(path, {});
  }

  /** Empties again a folder this host just filled; removes it when the host made it. */
  function undoCopy(path: string, existed: boolean): void {
    try {
      emptyTutorialFolder(path);
      // Emptied just before: only the folder itself is left.
      if (!existed) rmdirSync(path);
    } catch {
      /* recorded as the failure it was */
    }
  }

  /** The progress starts over once the folder is the sample again (a failure to write it is recorded only). */
  function restarted(path: string): void {
    try {
      writeTutorialProgress(deps.progressFile, fresh(path));
    } catch {
      // The folder is complete again: still left for; the old progress stays bound to the same folder.
      recordFailure("restart", "bind_failed");
    }
    entered("restart", "restarted");
  }

  return {
    pick() {
      if (deps.stopping()) return "shutting_down";
      if (deps.sampleDir === null) return "no_sample";
      const id = deps.requestPick();
      if (id === null) return "shutting_down";
      tutorialPicks.add(id);
      return "accepted";
    },

    continue() {
      if (deps.stopping()) return "shutting_down";
      const path = bound();
      if (path === null || !marked(path)) return "tutorial_missing";
      if (deps.isCurrent(path)) return "current_project";
      entered("continue", "resumed");
      deps.record(path);
      deps.go(path, {});
      return "accepted";
    },

    restart() {
      if (deps.stopping()) return "shutting_down";
      const sample = deps.sampleDir;
      if (sample === null) return "no_sample";
      const path = bound();
      // Only a folder with the marker is ever emptied.
      if (path === null || !marked(path)) return "tutorial_missing";
      // The sample is copied beside the folder first (infra `stageTutorialCopy`): a failure here leaves the folder as
      // it was and is announced while the page still listens.
      let staging: string;
      try {
        staging = stageTutorialCopy(sample, path);
      } catch {
        fail("restart", "copy_failed", path);
        return "accepted";
      }
      const swap = (): boolean => {
        try {
          swapInTutorialCopy(path, staging);
        } catch {
          discardTutorialCopy(staging);
          return false;
        }
        restarted(path);
        return true;
      };
      if (deps.isCurrent(path)) {
        // The open project itself: swapped in once its server has closed, before the shell is told the next project.
        // A failed swap puts the folder back as it was, and that opens again (recorded as far as the log still is).
        deps.record(path);
        deps.go(path, {
          afterClose: () => {
            if (!swap()) recordFailure("restart", "copy_failed");
          },
          onDrop: () => discardTutorialCopy(staging),
        });
        return "accepted";
      }
      if (!swap()) {
        fail("restart", "copy_failed", path);
        return "accepted";
      }
      deps.record(path);
      deps.go(path, {});
      return "accepted";
    },

    picked(id, path) {
      if (!tutorialPicks.delete(id)) return false;
      if (path !== null && deps.sampleDir !== null) onPicked(path, deps.sampleDir);
      return true;
    },
  };
}
