/**
 * `argelanderspace tutorial` (in-app-tutorial ticket 26; spec §2 「浏览器形态命令」, §6 「重新开始」「旧版示例」): the
 * tutorial for the browser form in one command. It sets up — or resumes — the tutorial folder, binds it in
 * `tutorial.json`, and starts the server in it, printing the address (no browser is opened).
 *
 * - The folder: `--dir` > the folder `tutorial.json` is bound to, when it is there with its marker >
 *   `~/ArgelanderSpace-Tutorial`. Missing or empty → the bundled sample is copied in; with the marker → resumed (a
 *   note when its sample is older than the bundled one, then the start as usual); anything else → refused, nothing
 *   written.
 * - `--reset` empties only a folder with the marker, after one `y/N` on a terminal; without a terminal it is refused.
 *   There is no `--yes`.
 * - The server is `serve`'s: the process changes into the folder and passes `--data-dir <dir>/literatures`, so the
 *   lenient reading, the log, the start record and the port chain (`--port` > config.toml > 1859, no fallback) are
 *   the same. `--data-dir` is not taken.
 *
 * The messages are English and not in the locale files (copy, section 8). Not detected and not supported: the desktop
 * app and this command running the same tutorial project at once.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT, type TutorialProgress } from "@argelanderspace/contracts";
import {
  bundledSkillsDir,
  bundledTutorialDir,
  configFilePath,
  copyTutorialSample,
  emptyTutorialFolder,
  readTutorialMarker,
  readTutorialProgress,
  TUTORIAL_FOLDER_NAME,
  TUTORIAL_PROGRESS_FILE,
  tutorialFolderState,
  writeTutorialProgress,
} from "@argelanderspace/infra";
import { serveStart, startServer } from "@argelanderspace/server";
import type { Command } from "commander";
import { fail } from "./common.js";
import { APP_VERSION } from "./generated/app-version.js";

/** The folder used when nothing else names one: in the home directory, so every working directory finds it. */
export const DEFAULT_TUTORIAL_FOLDER = TUTORIAL_FOLDER_NAME;

export const TUTORIAL_MESSAGES = {
  noSample: "this installation does not include the tutorial sample",
  notATutorialFolder: (dir: string) =>
    `${dir} exists, is not empty and is not a tutorial folder; pick another --dir`,
  created: (dir: string) => `tutorial folder: ${dir} (created from the bundled sample)`,
  resuming: (dir: string) => `tutorial folder: ${dir} (resuming)`,
  olderSample:
    "note: this tutorial folder was created from an older sample and may not load correctly; " +
    "run with --reset to start over",
  resetQuestion: (dir: string) =>
    `This will empty ${dir} and copy the sample again. Annotations, arguments, tasks and manuscripts you wrote in ` +
    "the tutorial will be deleted. Continue? [y/N] ",
  resetNeedsTerminal: "--reset needs an interactive terminal to confirm",
  resetCancelled: "cancelled; nothing was changed",
} as const;

interface TutorialOpts {
  dir?: string;
  port?: string;
  reset?: boolean;
}

export function registerTutorialCommand(program: Command): void {
  program
    .command("tutorial")
    .description(
      "Start the in-app tutorial in the browser: set up (or resume) the tutorial folder, " +
        "serve it, and print the address to open."
    )
    .option(
      "--dir <dir>",
      `the tutorial folder (default: the one in use, or ~/${DEFAULT_TUTORIAL_FOLDER})`
    )
    .option("--port <n>", `port (default ${DEFAULT_PORT}, or port in config.toml)`)
    .option("--reset", "empty the tutorial folder and copy the sample again (asks first)")
    .action(async (opts: TutorialOpts, cmd: Command) => {
      // The program's --data-dir is global; this command does not take it (its data is the tutorial folder's).
      if (cmd.optsWithGlobals().dataDir !== undefined) {
        cmd.error("error: unknown option '--data-dir'");
      }
      try {
        await runTutorial(opts);
      } catch (e) {
        fail(e);
      }
    });
}

async function runTutorial(opts: TutorialOpts): Promise<void> {
  const entry = process.argv[1] === undefined ? null : realpathOr(resolve(process.argv[1]));
  const sampleDir = entry === null ? null : bundledTutorialDir(entry);
  if (sampleDir === null) throw new Error(TUTORIAL_MESSAGES.noSample);
  const bundledSample = readTutorialMarker(sampleDir);

  // tutorial.json where the server will read it: the global data directory of serve's lenient reading.
  const progressFile = join(
    serveStart(configFilePath()).globalDirs.dataDir,
    TUTORIAL_PROGRESS_FILE
  );
  const progress = readTutorialProgress(progressFile).progress;

  const dir = targetFolder(opts.dir, progress);
  const state = tutorialFolderState(dir);
  if (state.kind === "unmarked") throw new Error(TUTORIAL_MESSAGES.notATutorialFolder(dir));

  // Where the web page finds the SPA when serve is run from here (a development checkout): looked for before the
  // change of directory, as serve would.
  const webDist = webDistFrom(process.cwd());

  let lines: string[];
  let fresh: boolean;
  if (state.kind === "marked" && opts.reset === true) {
    if (process.stdin.isTTY !== true) throw new Error(TUTORIAL_MESSAGES.resetNeedsTerminal);
    if (!(await confirm(TUTORIAL_MESSAGES.resetQuestion(dir)))) {
      console.log(TUTORIAL_MESSAGES.resetCancelled);
      return;
    }
    emptyTutorialFolder(dir);
    copyTutorialSample(sampleDir, dir);
    lines = [TUTORIAL_MESSAGES.created(dir)];
    fresh = true;
  } else if (state.kind === "marked") {
    lines = [TUTORIAL_MESSAGES.resuming(dir)];
    if (bundledSample !== null && state.sample < bundledSample) {
      lines.push(TUTORIAL_MESSAGES.olderSample);
    }
    fresh = false;
  } else {
    copyTutorialSample(sampleDir, dir);
    lines = [TUTORIAL_MESSAGES.created(dir)];
    fresh = true;
  }

  // The binding names the folder as the server's working directory will (symbolic links resolved), which is what the
  // page compares it with.
  const bound = realpathSync(dir);
  if (fresh || !sameFolder(progress?.project?.path, bound)) {
    writeTutorialProgress(progressFile, newProgress(bound));
  }
  for (const line of lines) console.log(line);

  const argv = ["--data-dir", join(bound, "literatures")];
  if (opts.port !== undefined) argv.push("--port", opts.port);
  if (webDist !== null) argv.push("--web-dist", webDist);
  const skillsDir = entry === null ? null : bundledSkillsDir(entry);
  process.chdir(bound);
  const srv = await startServer(argv, {
    version: APP_VERSION,
    ...(skillsDir === null ? {} : { skillsDir }),
    tutorialSampleDir: sampleDir,
  });
  const shutdown = () => {
    void srv.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** `--dir` (against the working directory) > the bound folder when it is there with its marker > the default. */
function targetFolder(dirFlag: string | undefined, progress: TutorialProgress | null): string {
  if (dirFlag !== undefined) return resolve(dirFlag);
  const bound = progress?.project?.path;
  if (bound !== undefined && tutorialFolderState(bound).kind === "marked") return bound;
  return join(homedir(), DEFAULT_TUTORIAL_FOLDER);
}

function newProgress(path: string): TutorialProgress {
  const now = new Date().toISOString();
  return {
    version: 1,
    project: { path },
    startedAt: now,
    updatedAt: now,
    position: null,
    steps: {},
    appVersion: APP_VERSION,
  };
}

function sameFolder(a: string | undefined, b: string): boolean {
  return a !== undefined && realpathOr(a) === b;
}

/** Asks once on the terminal; only `y` / `yes` (any case) is yes. End of input is no. */
async function confirm(question: string): Promise<boolean> {
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, terminal: false });
  const answer = await new Promise<string | null>((done) => {
    rl.once("line", done);
    rl.once("close", () => done(null));
  });
  rl.close();
  return answer !== null && /^\s*y(es)?\s*$/i.test(answer);
}

/**
 * The SPA serve would use from `cwd`: the one bundled beside this program, else a development checkout's
 * `packages/web/dist` (server `resolveServerConfig`); null when neither is there.
 */
function webDistFrom(cwd: string): string | null {
  const candidates = [
    fileURLToPath(new URL("./web", import.meta.url)),
    join(cwd, "packages", "web", "dist"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The path with its symbolic links resolved; the path itself when that fails. */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
