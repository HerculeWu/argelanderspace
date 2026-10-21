/**
 * The tutorial's entry in the desktop host (in-app-tutorial ticket 25; spec §2 「桌面目标文件夹」「宿主接口」, §6
 * 「重新开始」): "Start / Resume tutorial" and "Restart…" on the welcome page and the settings page, carried out by the
 * host, which alone knows the folders. The page never hands it a path.
 *
 * - pick: the host writes the existing `pick_folder` line with an id it marks as the tutorial's. The answer is the
 *   parent folder (or a tutorial folder itself, infra `tutorialTargetIn`): an `ArgelanderSpace-Tutorial` is made there
 *   and the bundled sample copied in (or the marked folder that is there taken as it is), the progress bound to it
 *   (cleared, unless it was bound to that folder already), the folder recorded among the recent projects, and left for.
 * - continue: the folder `tutorial.json` is bound to, when it is there and marked; left for.
 * - restart: the bound folder, only when marked, emptied and filled with the sample again (a copy staged beside it
 *   first, which then takes its place: infra `stageTutorialSample` / `swapStagedTutorial`), the progress cleared, left
 *   for. When the tutorial project is the one open, the swap waits until the server has closed (before `stopped`).
 *
 * Leaving goes through the host's own switch (`go`): at once in the welcome state or when nothing would be interrupted,
 * otherwise held and announced as a picked folder is (`host.switch-confirmation`) — the folder is made first, so a
 * cancelled switch leaves it bound and the page offers to resume. A failure after the request was taken is announced to
 * the pages (`host.tutorial-result`) and nothing is left for: what the copy wrote is removed (only what this host made),
 * and a half-made folder is never opened. The log has the action and the reason's category only, never a path.
 */

import type {
  HostShownPath,
  HostTutorialAction,
  HostTutorialFailure,
  HostTutorialRefusal,
  TutorialProgress,
  WsHostTutorialResult,
} from "@argelanderspace/contracts";
import { HOST_TUTORIAL_ACTIONS, HOST_TUTORIAL_FAILURES } from "@argelanderspace/contracts";
import {
  discardStagedTutorial,
  f,
  fillTutorialFolder,
  isTutorialFolder,
  readTutorialProgress,
  type StagedTutorial,
  stageTutorialSample,
  swapStagedTutorial,
  type TutorialCopyOptions,
  tutorialTargetIn,
  unfillTutorialFolder,
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
   * the server has closed, before `stopped`; `onDrop` when a held switch is given up instead.
   */
  go(path: string, extra: { afterClose?: () => void; onDrop?: () => void }): void;
  /** Tells every page of the server (none while it is closing or closed). */
  broadcast(message: WsHostTutorialResult): void;
  /** Tests only: the copy (default infra's). */
  copy?: (sample: string, into: string, opts: TutorialCopyOptions) => Promise<void>;
}

export type TutorialRequestOutcome = "accepted" | HostTutorialRefusal;

export interface TutorialEntry {
  pick(): TutorialRequestOutcome;
  continue(): TutorialRequestOutcome;
  restart(): TutorialRequestOutcome;
  /** Whether the answer to a `pick_folder` line is the tutorial's; if so it is taken care of here. */
  picked(id: string, path: string | null): boolean;
  /** The host begins to stop: an entry under way is told to stop and announced as `shutting_down` while pages listen. */
  onStopping(): void;
  /** Resolves once no entry is under way (what a stopped copy wrote is removed by then). */
  settled(): Promise<void>;
}

export function createTutorialEntry(deps: TutorialHostDeps): TutorialEntry {
  const tutorialPicks = new Set<string>();
  /** The entry under way (a copy): its action, the folder it is about, and its end. */
  let running: { action: HostTutorialAction; path: string; done: Promise<void> } | null = null;
  /** Whether the pages were told already that the entry under way ends because the host stops. */
  let toldStopping = false;

  const bound = (): string | null => {
    const { progress } = readTutorialProgress(deps.progressFile);
    return progress?.project?.path ?? null;
  };

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

  const record = (action: HostTutorialAction, outcome: (typeof TUTORIAL_ENTRY_OUTCOMES)[number]) =>
    deps.log()?.info("desktop.tutorial_entered", {
      action: f.oneOf(HOST_TUTORIAL_ACTIONS, action),
      outcome: f.oneOf(TUTORIAL_ENTRY_OUTCOMES, outcome),
    });

  /** Records the failure and tells the pages; `announce` is what they are told (default the recorded reason). */
  const fail = (
    action: HostTutorialAction,
    reason: (typeof TUTORIAL_FAILURE_RECORDS)[number],
    path: string,
    announce: HostTutorialFailure = reason === "bind_failed" ? "copy_failed" : reason
  ) => {
    deps.log()?.warn("desktop.tutorial_failed", {
      action: f.oneOf(HOST_TUTORIAL_ACTIONS, action),
      reason: f.oneOf(TUTORIAL_FAILURE_RECORDS, reason),
    });
    // While the host stops, the pages were told once already (onStopping), and nobody listens any more.
    if (announce === "shutting_down" && toldStopping) return;
    deps.broadcast({ type: "host.tutorial-result", reason: announce, path: deps.shownPath(path) });
  };

  const copyOpts: TutorialCopyOptions = {
    shouldStop: () => deps.stopping(),
    ...(deps.copy === undefined ? {} : { copy: deps.copy }),
  };

  /** Runs an entry's asynchronous part as the one under way. */
  const under = (action: HostTutorialAction, path: string, work: () => Promise<void>): void => {
    const done = work()
      .catch(() => {
        /* each step records its own failure */
      })
      .finally(() => {
        running = null;
      });
    running = { action, path, done };
  };

  /** Writes a progress bound to the folder; false (recorded) when it could not be written. */
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
  function onPicked(picked: string): void {
    if (deps.stopping()) {
      fail("pick", "shutting_down", picked);
      return;
    }
    if (deps.sampleDir === null) return;
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
      record("pick", already ? "resumed" : "rebound");
      deps.record(path);
      if (!deps.isCurrent(path)) deps.go(path, {});
      return;
    }
    const sample = deps.sampleDir;
    under("pick", target.path, async () => {
      try {
        await fillTutorialFolder(sample, target, copyOpts);
      } catch {
        fail("pick", deps.stopping() ? "shutting_down" : "copy_failed", target.path);
        return;
      }
      // Copied, but the host began to stop meanwhile: what was made is removed again, nothing is left for.
      if (deps.stopping()) {
        await unfillTutorialFolder(target);
        fail("pick", "shutting_down", target.path);
        return;
      }
      const path = deps.canonical(target.path);
      if (!bind("pick", path)) {
        await unfillTutorialFolder(target);
        return;
      }
      record("pick", "created");
      deps.record(path);
      deps.go(path, {});
    });
  }

  /** Checks shared by the three requests. */
  function refused(): HostTutorialRefusal | null {
    if (deps.stopping()) return "shutting_down";
    if (deps.sampleDir === null) return "no_sample";
    if (running !== null) return "tutorial_busy";
    return null;
  }

  return {
    pick() {
      const no = refused();
      if (no !== null) return no;
      const id = deps.requestPick();
      if (id === null) return "shutting_down";
      tutorialPicks.add(id);
      return "accepted";
    },

    continue() {
      if (deps.stopping()) return "shutting_down";
      if (running !== null) return "tutorial_busy";
      const path = bound();
      if (path === null || !isTutorialFolder(path)) return "tutorial_missing";
      if (deps.isCurrent(path)) return "current_project";
      record("continue", "resumed");
      deps.record(path);
      deps.go(path, {});
      return "accepted";
    },

    restart() {
      const no = refused();
      if (no !== null) return no;
      const path = bound();
      // Only a folder with the marker is ever emptied.
      if (path === null || !isTutorialFolder(path)) return "tutorial_missing";
      const sample = deps.sampleDir as string;
      under("restart", path, async () => {
        let staged: StagedTutorial;
        try {
          staged = await stageTutorialSample(sample, path, copyOpts);
        } catch {
          fail("restart", deps.stopping() ? "shutting_down" : "copy_failed", path);
          return;
        }
        if (deps.stopping()) {
          discardStagedTutorial(staged);
          fail("restart", "shutting_down", path);
          return;
        }
        const swap = (): boolean => {
          try {
            swapStagedTutorial(staged);
          } catch {
            discardStagedTutorial(staged);
            fail("restart", "copy_failed", path);
            return false;
          }
          // The folder is the sample again: the progress starts over (a failure to write it is recorded; the folder
          // is complete, so it is still left for).
          try {
            writeTutorialProgress(deps.progressFile, fresh(path));
          } catch {
            deps.log()?.warn("desktop.tutorial_failed", {
              action: f.oneOf(HOST_TUTORIAL_ACTIONS, "restart"),
              reason: f.oneOf(TUTORIAL_FAILURE_RECORDS, "bind_failed"),
            });
          }
          record("restart", "restarted");
          return true;
        };
        if (deps.isCurrent(path)) {
          // The open project itself: emptied once its server has closed, before the shell is told the next project.
          // When that fails the folder is as it was, and that is what opens again.
          deps.record(path);
          deps.go(path, { afterClose: () => void swap(), onDrop: () => discardStagedTutorial(staged) });
          return;
        }
        if (!swap()) return;
        deps.record(path);
        deps.go(path, {});
      });
      return "accepted";
    },

    picked(id, path) {
      if (!tutorialPicks.delete(id)) return false;
      if (path !== null) onPicked(path);
      return true;
    },

    onStopping() {
      if (running === null) return;
      deps.broadcast({
        type: "host.tutorial-result",
        reason: "shutting_down",
        path: deps.shownPath(running.path),
      });
      toldStopping = true;
    },

    settled: () => running?.done ?? Promise.resolve(),
  };
}
