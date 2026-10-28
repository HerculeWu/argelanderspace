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
 *   `.cmd`, which `cmd` and PowerShell run by its bare name, and so does any program that starts it through a shell.
 *   A program that starts a child process by bare name without a shell (Node's `spawn` without `shell`, for one) does
 *   not find a `.cmd`: a known limit, checked on the release workflow's Windows runner (ticket 26,
 *   packages/app/scripts/windows-launcher-check.mjs). On Windows, paths under the user's folders are written through
 *   their variables (`%LOCALAPPDATA%\…`) so that the script is ASCII whatever the user's name: see `windowsPath`.
 *
 * The file is named after the npm package's command, `argelanderspace` (`argelanderspace.cmd` on Windows), so the
 * desktop app's CLI and the npm one answer to the same name (User Story 62).
 *
 * Hard contract (「应用不替用户修改系统 PATH，不往其他 agent 工具的目录里写文件」): nothing here changes the system's or
 * the user's environment variables (PATH among them) or a shell configuration. The PATH report only reads PATH and
 * gives the line the user would add.
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
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { TUTORIAL_MARKER_FILE } from "./tutorial-progress.js";

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
  file: string,
  env: NodeJS.ProcessEnv = {}
): string {
  const p: LauncherPlatform =
    platform === "win32" ? "win32" : platform === "darwin" ? "darwin" : "linux";
  checkTarget(target, p, file);
  const what =
    "is missing: the ArgelanderSpace desktop app this command runs from was moved or removed.";
  const todo =
    "Install the command-line tool again from the app (Settings > Command line & agents), or delete";
  if (p === "win32") {
    // In a batch file `%` is doubled; inside the quotes of `set "…"` and of the run line the rest is taken as written
    // (delayed expansion is off, so `!` is too). A path under one of the user's folders is written through its
    // variable (cmd expands it when the line runs), so that the file stays ASCII: see `windowsPath`.
    const cmd = (path: string) => windowsPath(path, env);
    // An echo's own words are outside quotes: every cmd metacharacter in them is escaped with `^`.
    const echoText = (text: string) => text.replace(/[\^&|<>()]/g, "^$&");
    return [
      "@echo off",
      `rem ${CLI_LAUNCHER_MARK}: placed by the ArgelanderSpace desktop app, which removes only a file with this line.`,
      "rem It runs the app's own Node on the app's own CLI; the app changes no PATH and no shell configuration.",
      "setlocal DisableDelayedExpansion",
      `set "AS_NODE=${cmd(target.node)}"`,
      `set "AS_CLI=${cmd(target.cli)}"`,
      `set "AS_SELF=${cmd(file)}"`,
      'if not exist "%AS_NODE%" (set "AS_MISSING=%AS_NODE%" & goto missing)',
      'if not exist "%AS_CLI%" (set "AS_MISSING=%AS_CLI%" & goto missing)',
      '"%AS_NODE%" "%AS_CLI%" %*',
      "exit /b %ERRORLEVEL%",
      ":missing",
      `>&2 echo error: "%AS_MISSING%" ${echoText(what)}`,
      `>&2 echo ${echoText(todo)} "%AS_SELF%".`,
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

/**
 * The variables a Windows path may be written through, so that a user name or another non-ASCII folder name is not in
 * the launcher (desktop-app ticket 26). cmd reads a batch file in the console's OEM code page (437, 850, 936, …), not
 * UTF-8, and has no way to be told the file's encoding; a non-ASCII byte sequence is read as other characters and the
 * path does not exist. Expanded by cmd, a variable gives the path in full (cmd keeps the environment as UTF-16).
 *
 * `chcp 65001` at the top of the script was considered and not taken: it changes the code page of the user's console
 * window for good (everything that window shows afterwards, after the command has ended), and restoring it means
 * parsing `chcp`'s localised output. Encoding the file in the OEM code page cannot be done from here (the code page is
 * the machine's, and Node has no encoder for it).
 */
const WINDOWS_PATH_VARIABLES = [
  "LOCALAPPDATA",
  "APPDATA",
  "USERPROFILE",
  // Before %ProgramFiles%, which a 32-bit process sees as the x86 folder; %ProgramW6432% is always the 64-bit one.
  "ProgramW6432",
  "ProgramFiles",
];

const isAscii = (text: string) => [...text].every((c) => c.charCodeAt(0) < 0x80);

/**
 * A Windows path as written in the launcher, `%` doubled. An ASCII path is written as it is. A path with a non-ASCII
 * character is written through the longest of the variables above whose value is a folder that holds it (without
 * regard to case; on a tie the earlier in the list); what is still not ASCII then cannot be written: refused (thrown),
 * like a path with a double quote.
 */
function windowsPath(path: string, env: NodeJS.ProcessEnv): string {
  if (isAscii(path)) return path.replace(/%/g, "%%");
  let best: { name: string; length: number } | null = null;
  for (const name of WINDOWS_PATH_VARIABLES) {
    const value = envValue(env, name, "win32")?.replace(/[\\/]+$/, "");
    if (!value || !win32.isAbsolute(value)) continue;
    const head = path.slice(0, value.length);
    const next = path[value.length];
    if (head.toLowerCase() !== value.toLowerCase() || (next !== undefined && next !== "\\"))
      continue;
    if (!best || value.length > best.length) best = { name, length: value.length };
  }
  const rest = (best ? path.slice(best.length) : path).replace(/%/g, "%%");
  if (!isAscii(rest))
    throw new Error(
      "a Windows launcher cannot hold a non-ASCII character outside %LOCALAPPDATA%, %APPDATA%, %USERPROFILE%, %ProgramW6432% or %ProgramFiles% (cmd reads it in the console's code page)"
    );
  return best ? `%${best.name}%${rest}` : rest;
}

/**
 * Why this app cannot offer the command-line tool, or null when it can (desktop-app ticket 26; the user's decision of
 * 2026-10-15). `appimage`: the CLI runs from an AppImage's own folder (`APPDIR`), a mount at a new `/tmp/.mount_*`
 * each start that is gone once the app closes, so a launcher pointing into it would stop working — the app offers
 * none there (the deb and the npm package have a fixed place). The AppImage runtime sets `APPIMAGE` and `APPDIR` before
 * it runs `AppRun` (the AppRun hook of linuxdeploy's GTK plugin sets `APPDIR` for an extracted one as well); the shell
 * and the host inherit them. The CLI entry must lie inside `APPDIR`, so a variable inherited from some other AppImage
 * (a terminal started from one, say) does not count.
 */
export function cliLauncherUnavailable(
  target: CliLauncherTarget,
  env: NodeJS.ProcessEnv = process.env
): "appimage" | null {
  const raw = env.APPDIR;
  if (!raw || !posix.isAbsolute(raw)) return null;
  // The CLI entry is a resolved path (the host takes it through realpath); APPDIR is the runtime's `$TMPDIR/.mount_*`
  // as written, so a doubled slash or a link in TMPDIR must not make it miss.
  let appdir: string;
  try {
    appdir = realpathSync(raw);
  } catch {
    appdir = posix.resolve(raw);
  }
  appdir = appdir.replace(/\/+$/, "");
  return target.cli.startsWith(`${appdir}/`) ? "appimage" : null;
}

/** Only the first bytes are read to find the mark (it is on the second line). */
const HEAD_BYTES = 4096;
/**
 * A marked file up to this size is read whole to tell whether it runs this app; a script of the app's is far smaller
 * (three paths and a few lines), so a larger marked file is the app's but not this one: outdated.
 */
const SCRIPT_MAX_BYTES = 256 * 1024;
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
  try {
    const head = readFrom(fd, Math.min(HEAD_BYTES, st.size)).toString("utf8");
    if (
      !head
        .split(/\r?\n/)
        .slice(0, 3)
        .some((line) => MARK_LINE.test(line))
    )
      return { kind: "foreign" };
    // The whole text, to tell whether it runs this app; a marked file too large for a script of the app's is not read.
    const size = fstatSync(fd).size;
    if (size > SCRIPT_MAX_BYTES) return { kind: "ours", text: "" };
    return { kind: "ours", text: readFrom(fd, size).toString("utf8") };
  } finally {
    closeSync(fd);
  }
}

/** Up to `length` bytes from the start of the file. */
function readFrom(fd: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, read);
    if (n === 0) break;
    read += n;
  }
  return buffer.subarray(0, read);
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
        : found.text === launcherScript(target, platform, file, env)
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
  const { platform, env } = settle(opts);
  const dir = resolveUserBinDir(opts);
  const file = cliLauncherFile(opts);
  const text = launcherScript(target, platform, file, env);
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
      // Something appeared there meanwhile: the app's own script is replaced, anything else is left; when it has gone
      // again by now, the file is placed once more (and only once: still in the way, it is reported as it is).
      const now = inspect(file);
      if (now.kind === "ours") renameSync(temp, file);
      else if (now.kind === "foreign" || !placeNew(temp, file))
        return { outcome: "foreign", status: cliLauncherStatus(target, opts) };
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
 * Which form of the app a CLI entry belongs to, read from the folders around it, and that form's root:
 * - `packaged`: the desktop package, `<resources>/sidecar/app/dist/bin.js`; the root is `<resources>`.
 * - `development`: the repository, `<repo>/packages/{app,cli}/dist/bin.js`; the root is `<repo>`.
 * - `other`: anything else, an npm install (`…/node_modules/argelanderspace/dist/bin.js`) among them; no root.
 *
 * Only the layout counts, not what lies three levels up: a local npm install
 * `<project>/node_modules/argelanderspace/dist/bin.js` has the user's project there, and that is not the app's.
 * Shared by the bundled skills and the bundled tutorial sample.
 */
function cliEntryLayout(
  cliEntry: string
): { form: "packaged" | "development"; root: string } | { form: "other" } {
  const bin = dirname(cliEntry);
  const pkg = dirname(bin);
  const outer = dirname(pkg);
  if (basename(bin) !== "dist") return { form: "other" };
  const root = resolve(bin, "..", "..", "..");
  if (basename(pkg) === "app" && basename(outer) === "sidecar") return { form: "packaged", root };
  if ((basename(pkg) === "app" || basename(pkg) === "cli") && basename(outer) === "packages") {
    return { form: "development", root };
  }
  return { form: "other" };
}

/** `dir` when it is a folder holding the file `marker`; else null. */
function folderWith(dir: string, marker: string): string | null {
  try {
    if (statSync(dir).isDirectory() && statSync(join(dir, marker)).isFile()) return dir;
  } catch {
    /* not there */
  }
  return null;
}

/**
 * The skills that ship with the app, found from the CLI entry the host runs, in the three forms of the app:
 * - `packaged`: `<resources>/skills` next to `<resources>/sidecar/app/dist/bin.js` in the desktop package;
 * - `development`: the repository's `skills/` next to `packages/app/dist/bin.js` (or `packages/cli/dist/bin.js`);
 * - `other`, an npm install: `dist/skills` beside the entry (`…/node_modules/argelanderspace/dist/skills`), which the
 *   npm build's copy-assets step puts there (project-intake ticket 12), as it does `dist/tutorial`.
 * A folder counts only when it holds `README.md`. Null when there is none.
 *
 * The entry must sit in one of those layouts, not merely have a `skills/README.md` three levels up: a local install
 * `<project>/node_modules/argelanderspace/dist/bin.js` reaches the project's own `skills/` that way, and a project's
 * folder is not the application's (the Copilot reads its skills from here, copilot ticket 58). In the npm form only
 * the folder right beside an entry that itself sits in a `dist` folder counts, never anything further up.
 */
export function bundledSkillsDir(cliEntry: string): string | null {
  const layout = cliEntryLayout(cliEntry);
  if (layout.form === "other") {
    const bin = dirname(cliEntry);
    return basename(bin) === "dist" ? folderWith(join(bin, "skills"), "README.md") : null;
  }
  return folderWith(join(layout.root, "skills"), "README.md");
}

/**
 * The tutorial sample that ships with the app (in-app-tutorial ticket 15), found from the CLI entry: `<resources>/tutorial`
 * in the desktop package, and `dist/tutorial` beside the CLI in an npm install or the development form
 * (`packages/{app,cli}/dist/tutorial`). Only a folder holding the marker file {@link TUTORIAL_MARKER_FILE} counts;
 * null otherwise (an installation without the sample).
 */
export function bundledTutorialDir(cliEntry: string): string | null {
  const layout = cliEntryLayout(cliEntry);
  const dir =
    layout.form === "packaged"
      ? join(layout.root, "tutorial")
      : resolve(dirname(cliEntry), "tutorial");
  return folderWith(dir, TUTORIAL_MARKER_FILE);
}
