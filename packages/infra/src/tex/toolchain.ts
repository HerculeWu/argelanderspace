/**
 * Where the external programs are (desktop-app ticket 13). TeX is not installed with the workbench, and an app started
 * from a desktop icon does not inherit the PATH of a login shell, so the programs are looked for in this order:
 *
 *   1. the configured TeX directory (`tex_dir` in config.toml) — for TeX's own programs only;
 *   2. PATH;
 *   3. the usual install locations of the platform: macOS — MacTeX (`/Library/TeX/texbin`) and Homebrew
 *      (`/opt/homebrew/bin`, `/usr/local/bin`); Windows — TeX Live (`C:\texlive\<year>\bin\windows|win64|win32`, newest
 *      year first), MiKTeX (per-user and all-users) and Ghostscript (`%ProgramFiles%\gs\gs*\bin`). Linux has none for
 *      TeX (it comes from the distribution or from a PATH the user set); bubblewrap is looked for in `/usr/local/bin`,
 *      `/usr/bin`, `/bin`, where the Writer's sandbox probe runs it from.
 *
 * On Windows a program is a file whose name is the program's name plus one of the extensions of `PATHEXT` (default
 * `.COM;.EXE;.BAT;.CMD`), in that order; elsewhere it is an executable regular file of exactly that name.
 *
 * The lookup only looks at the file system: nothing is run here (the version lines are `environment.ts`'s). It is
 * synchronous and cheap, and it is asked again at every compile and every check, so a changed `tex_dir` applies
 * without a restart. macOS and Windows are implemented and unit-checked with constructed layouts; neither was tried on
 * a real machine.
 */
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { readSettingsFile } from "../config.js";

/** The programs the environment check reports, in its order. */
export const TOOLCHAIN_TOOLS = [
  "latexmk",
  "pdflatex",
  "xelatex",
  "bibtex",
  "biber",
  "pdftocairo",
  "ghostscript",
  "bwrap",
] as const;
export type ToolchainTool = (typeof TOOLCHAIN_TOOLS)[number];

/** TeX's own programs: the only ones looked for in the configured TeX directory. */
export const TEX_TOOLS: readonly ToolchainTool[] = [
  "latexmk",
  "pdflatex",
  "xelatex",
  "bibtex",
  "biber",
];

/** Which step of the lookup found a program. */
export type ToolSource = "tex_dir" | "path" | "common";

export interface LocatedTool {
  /** The program's path, as the platform writes it. */
  path: string;
  source: ToolSource;
}

export type ToolPlatform = "linux" | "darwin" | "win32";

export interface LocateOptions {
  /** The configured TeX directory; null/undefined/blank = not set. */
  texDir?: string | null | undefined;
  /** Default `process.platform` (anything but darwin and win32 is looked up like Linux). */
  platform?: ToolPlatform | NodeJS.Platform;
  /** PATH (Windows: `Path` too), PATHEXT, ProgramFiles, LOCALAPPDATA…; default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Tests only: maps a path of the platform onto the real file system (a constructed layout under a temporary root).
   * The paths reported are the platform's, not the mapped ones.
   */
  fsPath?: (path: string) => string;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

function platformOf(opts: LocateOptions): ToolPlatform {
  const p = opts.platform ?? process.platform;
  return p === "darwin" || p === "win32" ? p : "linux";
}

function pathOf(platform: ToolPlatform) {
  return platform === "win32" ? win32 : posix;
}

/** An environment variable; Windows' names are not case-sensitive (`Path`, `PATH`). */
function envVar(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: ToolPlatform
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** The file names a program may have on the platform. */
function namesOf(tool: ToolchainTool, platform: ToolPlatform): string[] {
  if (tool === "ghostscript") return platform === "win32" ? ["gswin64c", "gswin32c", "gs"] : ["gs"];
  return [tool];
}

function isProgram(real: string, platform: ToolPlatform): boolean {
  try {
    if (!statSync(real).isFile()) return false;
    if (platform !== "win32") accessSync(real, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(real: string): boolean {
  try {
    return statSync(real).isDirectory();
  } catch {
    return false;
  }
}

function listDir(real: string): string[] {
  try {
    return readdirSync(real);
  } catch {
    return [];
  }
}

interface Ctx {
  platform: ToolPlatform;
  env: Readonly<Record<string, string | undefined>>;
  real: (path: string) => string;
}

function contextOf(opts: LocateOptions): Ctx {
  return {
    platform: platformOf(opts),
    env: opts.env ?? process.env,
    real: opts.fsPath ?? ((p) => p),
  };
}

/** The first file in `dir` that is `tool` on this platform, or null. */
function inDirectory(tool: ToolchainTool, dir: string, ctx: Ctx): string | null {
  const { platform } = ctx;
  const join = pathOf(platform).join;
  const exts =
    platform === "win32"
      ? (envVar(ctx.env, "PATHEXT", platform) || DEFAULT_PATHEXT)
          .split(";")
          .filter((e) => e.startsWith("."))
      : [""];
  for (const name of namesOf(tool, platform)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      // Windows does not distinguish case; the file system of the test (or a case-sensitive volume) may.
      if (isProgram(ctx.real(candidate), platform)) return candidate;
      if (platform === "win32" && ext !== ext.toLowerCase()) {
        const lower = join(dir, name + ext.toLowerCase());
        if (isProgram(ctx.real(lower), platform)) return lower;
      }
    }
  }
  return null;
}

function pathDirs(ctx: Ctx): string[] {
  const value = envVar(ctx.env, "PATH", ctx.platform) ?? "";
  const delimiter = pathOf(ctx.platform).delimiter;
  return value
    .split(delimiter)
    .map((d) => (ctx.platform === "win32" ? d.replace(/^"(.*)"$/, "$1") : d))
    .filter((d) => d.length > 0 && pathOf(ctx.platform).isAbsolute(d));
}

/** Child directories of `dir` (as platform paths), sorted so that the newest-looking name comes first. */
function childrenNewestFirst(dir: string, ctx: Ctx, match: RegExp): string[] {
  const join = pathOf(ctx.platform).join;
  return listDir(ctx.real(dir))
    .filter((name) => match.test(name))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))
    .map((name) => join(dir, name));
}

/** The usual install locations of the platform, for `tool`, in the order they are tried. */
function commonDirs(tool: ToolchainTool, ctx: Ctx): string[] {
  if (ctx.platform === "darwin") {
    return tool === "bwrap"
      ? []
      : ["/Library/TeX/texbin", "/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
  }
  // Linux: none for TeX (it comes from the distribution or from a PATH the user set); bubblewrap is looked for in the
  // system directories the Writer's sandbox probe runs it from (sandbox.ts), so the check and the sandbox agree.
  if (ctx.platform !== "win32")
    return tool === "bwrap" ? ["/usr/local/bin", "/usr/bin", "/bin"] : [];
  const join = win32.join;
  const drive = (envVar(ctx.env, "SystemDrive", "win32") || "C:").replace(/\\$/, "");
  const programFiles = envVar(ctx.env, "ProgramFiles", "win32") || `${drive}\\Program Files`;
  const programFilesX86 =
    envVar(ctx.env, "ProgramFiles(x86)", "win32") || `${drive}\\Program Files (x86)`;
  const local = envVar(ctx.env, "LOCALAPPDATA", "win32");
  if (tool === "bwrap") return [];
  if (tool === "ghostscript") {
    return [programFiles, programFilesX86].flatMap((base) =>
      childrenNewestFirst(join(base, "gs"), ctx, /^gs\d/i).map((d) => join(d, "bin"))
    );
  }
  if (tool === "pdftocairo") return [];
  const texLive = childrenNewestFirst(`${drive}\\texlive`, ctx, /^\d{4}$/).flatMap((year) =>
    ["windows", "win64", "win32"].map((arch) => join(year, "bin", arch))
  );
  const miktex = [
    ...(local
      ? [
          join(local, "Programs", "MiKTeX", "miktex", "bin", "x64"),
          join(local, "Programs", "MiKTeX", "miktex", "bin"),
        ]
      : []),
    join(programFiles, "MiKTeX", "miktex", "bin", "x64"),
    join(programFiles, "MiKTeX", "miktex", "bin"),
    join(programFilesX86, "MiKTeX", "miktex", "bin"),
  ];
  return [...texLive, ...miktex];
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/** Where `tool` is: the configured TeX directory (TeX's programs only), then PATH, then the usual places; or null. */
export function locateTool(tool: ToolchainTool, opts: LocateOptions = {}): LocatedTool | null {
  const ctx = contextOf(opts);
  const texDir = blank(opts.texDir) ? null : (opts.texDir as string).trim();
  if (texDir !== null && TEX_TOOLS.includes(tool) && pathOf(ctx.platform).isAbsolute(texDir)) {
    const found = inDirectory(tool, texDir, ctx);
    if (found !== null) return { path: found, source: "tex_dir" };
  }
  for (const dir of pathDirs(ctx)) {
    const found = inDirectory(tool, dir, ctx);
    if (found !== null) return { path: found, source: "path" };
  }
  for (const dir of commonDirs(tool, ctx)) {
    const found = inDirectory(tool, dir, ctx);
    if (found !== null) return { path: found, source: "common" };
  }
  return null;
}

/** What is the matter with the configured TeX directory. Not set, or a directory with latexmk in it, is `ok`/`unset`. */
export type TexDirState = "unset" | "ok" | "missing" | "no_latexmk" | "not_absolute";

export function texDirState(
  texDir: string | null | undefined,
  platform?: LocateOptions["platform"],
  opts: Omit<LocateOptions, "texDir" | "platform"> = {}
): TexDirState {
  if (blank(texDir)) return "unset";
  const ctx = contextOf({ ...opts, ...(platform !== undefined ? { platform } : {}) });
  const dir = (texDir as string).trim();
  if (!pathOf(ctx.platform).isAbsolute(dir)) return "not_absolute";
  if (!isDirectory(ctx.real(dir))) return "missing";
  return inDirectory("latexmk", dir, ctx) === null ? "no_latexmk" : "ok";
}

export interface Toolchain {
  platform: ToolPlatform;
  /** The configured TeX directory as given (trimmed), or null. */
  texDir: string | null;
  texDirState: TexDirState;
  tools: Record<ToolchainTool, LocatedTool | null>;
  /** The directory latexmk was found in: put first on the PATH latexmk runs with, so it finds its engines beside it. */
  texBinDir: string | null;
}

export function locateToolchain(opts: LocateOptions = {}): Toolchain {
  const ctx = contextOf(opts);
  const texDir = blank(opts.texDir) ? null : (opts.texDir as string).trim();
  const tools = Object.fromEntries(
    TOOLCHAIN_TOOLS.map((tool) => [tool, locateTool(tool, opts)])
  ) as Record<ToolchainTool, LocatedTool | null>;
  const latexmk = tools.latexmk;
  return {
    platform: ctx.platform,
    texDir,
    texDirState: texDirState(texDir, ctx.platform, opts),
    tools,
    texBinDir: latexmk === null ? null : pathOf(ctx.platform).dirname(latexmk.path),
  };
}

/** The PATH latexmk runs with: the TeX directory first, then `basePath` (default the process's PATH). */
export function texChildPath(
  chain: Pick<Toolchain, "texBinDir">,
  basePath: string | undefined = process.env.PATH,
  platform: LocateOptions["platform"] = process.platform
): string {
  const delimiter = pathOf(platformOf({ platform })).delimiter;
  if (chain.texBinDir === null) return basePath ?? "";
  return basePath ? `${chain.texBinDir}${delimiter}${basePath}` : chain.texBinDir;
}

/**
 * The whole environment latexmk runs with outside the Writer: `base` (default the process's) with its PATH replaced by
 * {@link texChildPath}. On Windows the variable may be spelled `Path`: every spelling is dropped and one `Path` is set,
 * so the child does not get two.
 */
export function texChildEnv(
  chain: Pick<Toolchain, "texBinDir">,
  base: Readonly<Record<string, string | undefined>> = process.env,
  platform: LocateOptions["platform"] = process.platform
): Record<string, string> {
  const p = platformOf({ platform });
  const env: Record<string, string> = {};
  let current: string | undefined;
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const isPath = p === "win32" ? key.toUpperCase() === "PATH" : key === "PATH";
    if (isPath) current ??= value;
    else env[key] = value;
  }
  env[p === "win32" ? "Path" : "PATH"] = texChildPath(chain, current, p);
  return env;
}

/**
 * The TeX directory config.toml sets now (lenient reading: a faulty file or key means "not set"). Read at each call,
 * so a change applies to the next compile and the next check without a restart.
 */
export function configuredTexDir(configPath?: string): string | null {
  try {
    const value = (configPath === undefined ? readSettingsFile() : readSettingsFile(configPath))
      .values.tex_dir;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  } catch {
    return null;
  }
}

/** The toolchain of this machine with the TeX directory config.toml sets now. */
export function currentToolchain(configPath?: string): Toolchain {
  return locateToolchain({ texDir: configuredTexDir(configPath) });
}
