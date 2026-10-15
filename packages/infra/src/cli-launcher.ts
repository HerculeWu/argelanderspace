/**
 * The command-line tool of the desktop app (desktop-app ticket 24; spec 「命令行工具与 skills」, User Stories 57–60): a
 * small launcher script in the user's own executable directory that runs the app's own Node on the app's own CLI, so an
 * agent in a terminal uses the same CLI without Node installed and without administrator rights.
 *
 * Where it goes, one directory per platform, chosen so that no administrator rights are needed and the file is the
 * user's own:
 * - Linux: `~/.local/bin` — the per-user executable directory of the XDG base directory specification and of systemd's
 *   file-hierarchy(7); many distributions' default `~/.profile` puts it on PATH when it exists at login.
 * - macOS: `~/.local/bin` too. macOS has no per-user executable directory of its own; `/usr/local/bin` needs an
 *   administrator on a fresh system and `/opt/homebrew/bin` belongs to Homebrew. The same place as on Linux is what
 *   other user-level tools (pipx, uv) use, and the line to add is the same.
 * - Windows: `%LOCALAPPDATA%\Programs\argelanderspace\bin` — `%LOCALAPPDATA%\Programs` is where per-user installs go;
 *   a folder of its own, because adding a directory to PATH there is all-or-nothing for what it holds. The script is a
 *   `.cmd`, which `cmd`, PowerShell and the runtimes' child-process lookups all run by its bare name.
 *
 * The file is named after the npm package's command, `argelanderspace` (`argelanderspace.cmd` on Windows), so the
 * desktop app's CLI and the npm one answer to the same name (User Story 62).
 *
 * Hard contract (「应用不替用户修改系统 PATH，不往其他 agent 工具的目录里写文件」): nothing here changes an
 * environment variable, a shell configuration or the system PATH. The PATH report only reads PATH and gives the line
 * the user would add.
 *
 * The mark: a line `<comment> argelanderspace-cli-launcher: …` among the script's first lines. Installing never
 * replaces a file of that name without it (nor a symbolic link or a directory: what is there is someone else's —
 * an npm global install into `~/.local` puts a symbolic link exactly there), and uninstalling removes only a file with
 * it. When the app has been moved or removed, the script names the missing file and says what to do, and exits 1.
 *
 * Races: a fresh install is a hard link of a complete temporary file onto the name, which fails when anything appeared
 * there meanwhile (it is then looked at again); replacing the app's own script is a rename over it, and uninstalling an
 * unlink after the check: a file put there by someone else in the instant between the check and the rename or the
 * unlink would be replaced or removed. Nobody else writes this name in the app's own scenarios.
 */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve, win32 } from "node:path";

/** The npm package's command (`packages/app/package.json` `bin`), and the launcher's file name. */
export const CLI_COMMAND = "argelanderspace";

/** The words of the mark line; the line is the comment marker, a space, these words and a colon. */
export const CLI_LAUNCHER_MARK = "argelanderspace-cli-launcher";

/** The platforms the launcher knows; anything else is treated as POSIX. */
export type LauncherPlatform = "linux" | "darwin" | "win32";

export interface CliLauncherOptions {
  /** Default `process.platform`. */
  platform?: NodeJS.Platform;
  /** Default `os.homedir()`, read at the call. */
  home?: string;
  /** Where PATH and `%LOCALAPPDATA%` are read; default `process.env`. Never written. */
  env?: NodeJS.ProcessEnv;
}

/** What the launcher runs: the app's Node and its CLI entry, both absolute. */
export interface CliLauncherTarget {
  node: string;
  cli: string;
}

/**
 * `not_installed`: nothing of that name. `installed`: the app's script, running this app. `outdated`: the app's script,
 * but for another place of the app (moved since, or another copy). `foreign`: something without the mark is there.
 */
export const CLI_LAUNCHER_STATES = ["not_installed", "installed", "outdated", "foreign"] as const;
export type CliLauncherState = (typeof CLI_LAUNCHER_STATES)[number];

export interface CliLauncherStatus {
  state: CliLauncherState;
  /** The executable directory. */
  dir: string;
  /** The launcher's path in it. */
  file: string;
  /** Whether the directory is on PATH, as this process's environment has it. */
  inPath: boolean;
  /** What the user would add themself: a shell line on POSIX, the directory on Windows. */
  pathLine: string;
  /** Which form `pathLine` has. */
  platform: "posix" | "windows";
}

function settle(opts: CliLauncherOptions): {
  platform: LauncherPlatform;
  home: string;
  env: NodeJS.ProcessEnv;
} {
  const raw = opts.platform ?? process.platform;
  const platform: LauncherPlatform =
    raw === "win32" ? "win32" : raw === "darwin" ? "darwin" : "linux";
  return { platform, home: opts.home ?? homedir(), env: opts.env ?? process.env };
}

/** An environment variable, by name; without regard to case on Windows (as the system reads it). */
function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: LauncherPlatform
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** The user's executable directory the launcher goes in. Resolves only; touches nothing. */
export function resolveUserBinDir(opts: CliLauncherOptions = {}): string {
  const { platform, home, env } = settle(opts);
  if (platform === "win32") {
    const local = envValue(env, "LOCALAPPDATA", platform) || win32.join(home, "AppData", "Local");
    return win32.join(local, "Programs", CLI_COMMAND, "bin");
  }
  return join(home, ".local", "bin");
}

/** The launcher's path. */
export function cliLauncherFile(opts: CliLauncherOptions = {}): string {
  const { platform } = settle(opts);
  const dir = resolveUserBinDir(opts);
  return platform === "win32" ? win32.join(dir, `${CLI_COMMAND}.cmd`) : join(dir, CLI_COMMAND);
}

/** Whether the directory is one of PATH's entries (exactly; a relative entry never is). */
export function dirOnPath(
  dir: string,
  pathValue: string | undefined,
  platform: NodeJS.Platform
): boolean {
  if (!pathValue) return false;
  if (platform === "win32") {
    const norm = (p: string) =>
      p
        .replace(/^"(.*)"$/, "$1")
        .replace(/[\\/]+$/, "")
        .toLowerCase();
    const want = norm(dir);
    return pathValue.split(";").some((entry) => entry.trim() !== "" && norm(entry.trim()) === want);
  }
  const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const want = norm(dir);
  return pathValue
    .split(":")
    .some((entry) => posix.isAbsolute(entry) && norm(posix.normalize(entry)) === want);
}

/** The line the user would add to their shell's configuration, or on Windows the directory for the user PATH. */
export function pathLineFor(dir: string, platform: NodeJS.Platform, home: string): string {
  if (platform === "win32") return dir;
  const base = home.replace(/\/+$/, "");
  const inHome = base !== "" && dir.startsWith(`${base}/`);
  const esc = (text: string) => text.replace(/(["\\$`])/g, "\\$1");
  // Inside double quotes, so that a space needs nothing; below the home, `$HOME` stays expandable.
  const shown = inHome ? `$HOME${esc(dir.slice(base.length))}` : esc(dir);
  return `export PATH="${shown}:$PATH"`;
}

/** A path as one single-quoted shell word. */
function shQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

function checkTarget(target: CliLauncherTarget, platform: LauncherPlatform, file: string): void {
  for (const path of [target.node, target.cli, file]) {
    const absolute = platform === "win32" ? win32.isAbsolute(path) : posix.isAbsolute(path);
    if (!absolute) throw new Error("the launcher's target must be absolute paths");
    if (path.includes("\0")) throw new Error("the launcher's target cannot hold a NUL character");
    if (platform === "win32" && /["\r\n]/.test(path))
      throw new Error("a Windows launcher cannot hold a double quote or a line break in a path");
  }
}

/**
 * The launcher's text: runs `target.node` on `target.cli` with the arguments given, and exits with the CLI's code. When
 * either file is gone (the app was moved or removed) it says which, and what to do, on stderr, and exits 1.
 */
export function launcherScript(
  target: CliLauncherTarget,
  platform: NodeJS.Platform,
  file: string
): string {
  const p: LauncherPlatform =
    platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  checkTarget(target, p, file);
  const what =
    "is missing: the ArgelanderSpace desktop app this command runs from was moved or removed.";
  const todo =
    "Install the command-line tool again from the app (Settings > Command line & agents), or delete";
  if (p === "win32") {
    // In a batch file `%` is doubled; inside the quotes of `set "…"` and of the run line the rest is taken as written.
    const cmd = (path: string) => path.replace(/%/g, "%%");
    return [
      "@echo off",
      `rem ${CLI_LAUNCHER_MARK}: placed by the ArgelanderSpace desktop app, which removes only a file with this line.`,
      "rem It runs the app's own Node on the app's own CLI; the app changes no PATH and no environment variable.",
      "setlocal",
      `set "AS_NODE=${cmd(target.node)}"`,
      `set "AS_CLI=${cmd(target.cli)}"`,
      `set "AS_SELF=${cmd(file)}"`,
      'if not exist "%AS_NODE%" (set "AS_MISSING=%AS_NODE%" & goto missing)',
      'if not exist "%AS_CLI%" (set "AS_MISSING=%AS_CLI%" & goto missing)',
      '"%AS_NODE%" "%AS_CLI%" %*',
      "exit /b %ERRORLEVEL%",
      ":missing",
      `>&2 echo error: "%AS_MISSING%" ${what}`,
      // `>` would redirect: written `^>`.
      `>&2 echo ${todo.replace(/>/g, "^>")} "%AS_SELF%".`,
      "exit /b 1",
      "",
    ].join("\r\n");
  }
  return [
    "#!/bin/sh",
    `# ${CLI_LAUNCHER_MARK}: placed by the ArgelanderSpace desktop app, which removes only a file with this line.`,
    "# It runs the app's own Node on the app's own CLI; the app changes no PATH and no shell configuration.",
    `node=${shQuote(target.node)}`,
    `cli=${shQuote(target.cli)}`,
    `self=${shQuote(file)}`,
    'for f in "$node" "$cli"; do',
    '  if [ ! -f "$f" ]; then',
    `    printf 'error: %s ${what}\\n' "$f" >&2`,
    `    printf '${todo} %s.\\n' "$self" >&2`,
    "    exit 1",
    "  fi",
    "done",
    'exec "$node" "$cli" "$@"',
    "",
  ].join("\n");
}

/** Only the first bytes are read: the mark is on the second line. */
const HEAD_BYTES = 4096;
const MARK_LINE = new RegExp(`^(?:#|rem|::) ${CLI_LAUNCHER_MARK}:`, "i");

type Found = { kind: "none" } | { kind: "foreign" } | { kind: "ours"; text: string };

/** What is at the launcher's path: nothing, someone else's, or the app's script (and its text). */
function inspect(file: string): Found {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw error;
  }
  if (!st.isFile()) return { kind: "foreign" };
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let text: string;
  try {
    const buffer = Buffer.alloc(Math.min(HEAD_BYTES, st.size));
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    text = buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const head = text.split(/\r?\n/).slice(0, 3);
  if (!head.some((line) => MARK_LINE.test(line))) return { kind: "foreign" };
  // The whole text, to tell whether it runs this app (a script of the app's is small).
  if (st.size > HEAD_BYTES) return { kind: "ours", text: "" };
  return { kind: "ours", text };
}

/** The launcher's state, the directory and whether it is on PATH. Reads only. */
export function cliLauncherStatus(
  target: CliLauncherTarget,
  opts: CliLauncherOptions = {}
): CliLauncherStatus {
  const { platform, home, env } = settle(opts);
  const dir = resolveUserBinDir(opts);
  const file = cliLauncherFile(opts);
  const found = inspect(file);
  const state: CliLauncherState =
    found.kind === "none"
      ? "not_installed"
      : found.kind === "foreign"
        ? "foreign"
        : found.text === launcherScript(target, platform, file)
          ? "installed"
          : "outdated";
  return {
    state,
    dir,
    file,
    inPath: dirOnPath(dir, envValue(env, "PATH", platform), platform),
    pathLine: pathLineFor(dir, platform, home),
    platform: platform === "win32" ? "windows" : "posix",
  };
}

export interface CliLauncherChange {
  /** `installed`: the script is there and runs this app. `foreign`: someone else's file is there; nothing was written. */
  outcome: "installed" | "foreign";
  status: CliLauncherStatus;
}

const LINK_UNSUPPORTED = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV", "EMLINK"]);

/**
 * Puts the launcher in place. The directory is made when it is missing. Someone else's file (or link, or directory) of
 * that name is never replaced: the outcome is `foreign` and nothing is written. File system errors are thrown (with
 * their `code`), nothing left behind.
 */
export function installCliLauncher(
  target: CliLauncherTarget,
  opts: CliLauncherOptions = {}
): CliLauncherChange {
  const { platform } = settle(opts);
  const dir = resolveUserBinDir(opts);
  const file = cliLauncherFile(opts);
  const text = launcherScript(target, platform, file);
  const before = inspect(file);
  if (before.kind === "foreign")
    return { outcome: "foreign", status: cliLauncherStatus(target, opts) };
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.${CLI_COMMAND}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o755 });
    // The umask may have taken bits off.
    if (platform !== "win32") chmodSync(temp, 0o755);
    if (before.kind === "ours") {
      renameSync(temp, file);
    } else if (!placeNew(temp, file)) {
      // Something appeared there meanwhile: the app's own script is replaced, anything else is left.
      if (inspect(file).kind !== "ours")
        return { outcome: "foreign", status: cliLauncherStatus(target, opts) };
      renameSync(temp, file);
    }
  } finally {
    rmSync(temp, { force: true });
  }
  return { outcome: "installed", status: cliLauncherStatus(target, opts) };
}

/** Puts the temporary file at the name unless something is there: false when something is. */
function placeNew(temp: string, file: string): boolean {
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (code === "EEXIST") return false;
    if (!LINK_UNSUPPORTED.has(code)) throw error;
  }
  // A file system without hard links: an exclusive copy (its mode is copied too).
  try {
    copyFileSync(temp, file, constants.COPYFILE_EXCL);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

export interface CliLauncherRemoval {
  /** `removed`: the app's script was deleted. `not_installed`: nothing was there. `foreign`: someone else's; left. */
  outcome: "removed" | "not_installed" | "foreign";
  /** The state after, with `not_installed` meaning no file; no target is needed to read it. */
  status: Omit<CliLauncherStatus, "state"> & { state: "not_installed" | "foreign" };
}

/** Deletes the launcher when it is the app's (marked) script, whichever place of the app it runs. The directory stays. */
export function uninstallCliLauncher(opts: CliLauncherOptions = {}): CliLauncherRemoval {
  const { platform, home, env } = settle(opts);
  const dir = resolveUserBinDir(opts);
  const file = cliLauncherFile(opts);
  const report = (state: "not_installed" | "foreign") => ({
    state,
    dir,
    file,
    inPath: dirOnPath(dir, envValue(env, "PATH", platform), platform),
    pathLine: pathLineFor(dir, platform, home),
    platform: platform === "win32" ? ("windows" as const) : ("posix" as const),
  });
  const found = inspect(file);
  if (found.kind === "none") return { outcome: "not_installed", status: report("not_installed") };
  if (found.kind === "foreign") return { outcome: "foreign", status: report("foreign") };
  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return { outcome: "not_installed", status: report("not_installed") };
  }
  return { outcome: "removed", status: report("not_installed") };
}

/**
 * The skills that ship with the app, found from the CLI entry the host runs: three levels up, a `skills` folder with
 * its README. That is `<resources>/skills` next to `<resources>/sidecar/app/dist/bin.js` in the desktop package, and
 * the repository's `skills/` next to `packages/app/dist/bin.js` (or `packages/cli/dist/bin.js`) in the development
 * form. Null elsewhere (an npm install has none).
 */
export function bundledSkillsDir(cliEntry: string): string | null {
  const dir = resolve(dirname(cliEntry), "..", "..", "..", "skills");
  try {
    if (statSync(dir).isDirectory() && statSync(join(dir, "README.md")).isFile()) return dir;
  } catch {
    /* not there */
  }
  return null;
}
