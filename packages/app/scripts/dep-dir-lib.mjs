// Pure rules of the desktop dependency directory (desktop-app ticket 22). Used by dep-dir.mjs; tested by
// dep-dir.test.mjs (part of `pnpm --filter argelanderspace test`). No I/O here (paths are computed, not touched).
import nodePath, { posix as posixPath, win32 as win32Path } from "node:path";

/** The three kinds of package the generator may remove, in the order the ticket names them. */
export const PRUNE_CATEGORIES = ["fonts", "foreign", "esbuild"];

/**
 * The production closure of `importer` in a pnpm lockfile, as text pieces: the lockfile head (version, settings), the
 * importer's `dependencies` block, the dependency specifiers, and the `packages` and `snapshots` entries it reaches
 * (sorted). Optional platform packages stay listed: pnpm installs only the ones that match the target
 * (`supportedArchitectures`). Throws when the importer or any reached entry is missing, so a stale lockfile never
 * yields a silently partial install. Shared by subsetLockfile and smoke-pack's --offline-lock.
 */
export function lockfileClosure(lockText, importer) {
  const escaped = importer.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const found = new RegExp(`\\n {2}${escaped}:\\n {4}dependencies:\\n((?: {6}.*\\n)+)`).exec(
    lockText
  );
  if (!found) throw new Error(`lockfile has no ${importer} importer with dependencies`);
  const depBlock = found[1];
  const specs = [
    ...depBlock.matchAll(/ {6}'?([^':\n]+)'?:\n {8}specifier: (.+)\n {8}version: (.+)\n/g),
  ].map((m) => ({ name: m[1], specifier: m[2], version: m[3] }));
  const head = lockText.slice(0, lockText.indexOf("importers:"));
  const rest = lockText.slice(lockText.indexOf("\npackages:\n"));
  const [packagesText, snapshotsText] = rest.split("\nsnapshots:\n");
  const blocks = (text) =>
    new Map(
      [...text.matchAll(/^ {2}(\S.*?):(?: \{\}\n|\n(?: {4}.*\n)*)/gm)].map((m) => [
        m[1].replace(/^'|'$/g, ""),
        m[0],
      ])
    );
  const snapshotBlocks = blocks(snapshotsText ?? "");
  const packageBlocks = blocks(packagesText);
  const wanted = new Set();
  const queue = specs.map((s) => `${s.name}@${s.version}`);
  while (queue.length > 0) {
    const key = queue.pop();
    if (wanted.has(key)) continue;
    const block = snapshotBlocks.get(key);
    if (!block) throw new Error(`lockfile has no snapshot ${key}`);
    wanted.add(key);
    for (const dep of block.matchAll(/^ {6}'?([^':\n]+)'?: (\S.*)$/gm))
      queue.push(`${dep[1]}@${dep[2]}`);
  }
  const sortedWanted = [...wanted].sort();
  const keptSnapshots = sortedWanted.map((key) => snapshotBlocks.get(key)).join("\n");
  const keptPackages = [...new Set(sortedWanted.map((key) => key.replace(/\(.*$/, "")))]
    .sort()
    .map((key) => {
      const block = packageBlocks.get(key);
      if (!block) throw new Error(`lockfile has no package ${key}`);
      return block;
    })
    .join("\n");
  return { head, depBlock, specs, keptPackages, keptSnapshots, snapshots: sortedWanted.length };
}

/**
 * The part of the repo lockfile that the app package's production dependencies reach, rewritten so that those
 * dependencies are the root importer (`.`) of a standalone project (see lockfileClosure).
 */
export function subsetLockfile(lockText, importer) {
  const c = lockfileClosure(lockText, importer);
  const dependencies = Object.fromEntries(c.specs.map((s) => [s.name, s.specifier]));
  const importers = `importers:\n\n  .:\n    dependencies:\n${c.depBlock}`;
  const lockfile = `${c.head}${importers}\npackages:\n\n${c.keptPackages}\nsnapshots:\n\n${c.keptSnapshots}`;
  return { lockfile, dependencies, packages: c.snapshots };
}

/** npm's `os` / `cpu` / `libc` semantics: a list of allowed values, or of `!value` exclusions. */
function listAllows(list, value) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const negated = list.filter((v) => v.startsWith("!"));
  if (negated.includes(`!${value}`)) return false;
  const positive = list.filter((v) => !v.startsWith("!"));
  return positive.length === 0 || positive.includes(value);
}

/** Whether a package.json's platform fields admit the target `{platform, arch, libc}` (libc only on Linux). */
export function matchesTarget(pkg, target) {
  return (
    listAllows(pkg.os, target.platform) &&
    listAllows(pkg.cpu, target.arch) &&
    (target.platform !== "linux" || !target.libc || listAllows(pkg.libc, target.libc))
  );
}

/**
 * What to remove of an installed package, or null when it is not a candidate:
 *   fonts   - the font files (`fonts/`) of the PDF engine's font packages (`@embedpdf/fonts-*`). The package itself
 *             stays: `@embedpdf/engines/pdfium` imports each one's JS manifest statically, so removing the whole
 *             package breaks loading the engine (ticket 22 smoke).
 *   foreign - a whole package whose os/cpu/libc fields exclude the target (another platform's native file)
 *   esbuild - esbuild and its platform binaries, the whole package
 * `remove` is relative to the package directory ("." is the package itself).
 */
export function pruneAction(pkg, target) {
  const name = pkg.name ?? "";
  if (/^@embedpdf\/fonts-/.test(name)) return { category: "fonts", remove: "fonts" };
  if (name === "esbuild" || name.startsWith("@esbuild/"))
    return { category: "esbuild", remove: "." };
  if (!matchesTarget(pkg, target)) return { category: "foreign", remove: "." };
  return null;
}

const OSES = [
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "netbsd",
  "openbsd",
  "sunos",
  "win32",
];
const ARCHES = ["arm", "arm64", "ia32", "loong64", "mips64el", "ppc64", "riscv64", "s390x", "x64"];

/**
 * Whether a directory inside a package (path relative to the package, `/`-separated) holds another platform's
 * prebuilt native files: a `prebuilds/<os>-<arch>[-<libc>]` directory (the prebuildify layout, e.g. pi-tui's
 * `native/darwin/prebuilds/darwin-arm64`) that is not the target's.
 */
export function foreignPrebuild(relDir, target) {
  const parts = relDir.split("/");
  if (parts.length < 2 || parts.at(-2) !== "prebuilds") return false;
  const m = /^([a-z0-9]+)-([a-z0-9]+)(?:-([a-z]+))?$/.exec(parts.at(-1));
  if (!m || !OSES.includes(m[1]) || !ARCHES.includes(m[2])) return false;
  if (m[1] !== target.platform || m[2] !== target.arch) return true;
  const libc = m[3] === "gnu" ? "glibc" : m[3];
  return target.platform === "linux" && !!libc && !!target.libc && libc !== target.libc;
}

/**
 * The lockfile's packages that carry os/cpu/libc fields and admit the target (`name@version`, sorted): the target's
 * own native packages. An offline install whose store lacks one of them silently skips it (it is optional), so the
 * generator checks that every one of these was installed.
 */
export function expectedPlatformPackages(lockText, target) {
  const packagesText = lockText.slice(
    lockText.indexOf("\npackages:\n"),
    lockText.indexOf("\nsnapshots:\n")
  );
  const field = (block, key) => {
    const m = new RegExp(`\\n {4}${key}: \\[([^\\]]*)\\]`).exec(block);
    return m ? m[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")) : undefined;
  };
  const found = [];
  for (const m of packagesText.matchAll(/^ {2}(\S.*?):\n((?: {4}.*\n)*)/gm)) {
    const block = `\n${m[2]}`;
    const pkg = { os: field(block, "os"), cpu: field(block, "cpu"), libc: field(block, "libc") };
    if (!pkg.os && !pkg.cpu && !pkg.libc) continue;
    if (matchesTarget(pkg, target)) found.push(m[1].replace(/^'|'$/g, ""));
  }
  return found.sort();
}

// ---- the size budget (user decision 2026-10-15, ticket 22) ------------------------------------------------------- //

/**
 * The budget of ONE target's dependency directory: the sum of the sizes of the files in node_modules after pruning
 * (`bytes_after` in dep-dir-report.json; decimal MB). It is not the installer's size, the installed disk usage (cluster
 * rounding of ~18 000 small files adds ~30%), nor the Node runtime, which ticket 23 counts separately.
 */
export const DEP_DIR_BUDGET_BYTES = 500_000_000;

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/** Whether `bytes` of file content fits `budget`; `line` is what the generator prints. */
export function budgetCheck(bytes, budget = DEP_DIR_BUDGET_BYTES) {
  if (!(budget > 0))
    throw new Error(`the budget must be a positive number of bytes, got ${budget}`);
  const ok = bytes <= budget;
  return {
    bytes,
    budget,
    ok,
    line: `${mb(bytes)} of file content, budget ${mb(budget)}: ${ok ? "within" : "OVER BUDGET"}`,
  };
}

// ---- tool environment (the generator's pnpm runs) ---------------------------------------------------------------- //

/** The pnpm version the repo pins (`packageManager` of the root package.json text). */
export function pnpmVersion(packageJsonText) {
  const pm = JSON.parse(packageJsonText).packageManager;
  if (typeof pm !== "string") throw new Error("the root package.json has no packageManager field");
  const m = /^pnpm@([^+]+)/.exec(pm);
  if (!m) throw new Error(`packageManager is not pnpm: ${pm}`);
  return m[1];
}

const pathFor = (platform) => (platform === "win32" ? win32Path : posixPath);

/** Where corepack keeps its cached package managers when COREPACK_HOME is unset (corepack's own default). */
export function corepackHome(env, home, platform) {
  if (env.COREPACK_HOME) return env.COREPACK_HOME;
  const { join } = pathFor(platform);
  const base =
    env.XDG_CACHE_HOME ??
    env.LOCALAPPDATA ??
    join(home, platform === "win32" ? "AppData/Local" : ".cache");
  return join(base, "node/corepack");
}

/** The first `name` on `path` (with PATHEXT extensions on Windows), or undefined. `exists` is injected for tests. */
export function findTool(name, { path, platform, pathext, exists }) {
  const p = pathFor(platform);
  const exts =
    platform === "win32" ? (pathext ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (path ?? "").split(p.delimiter).filter(Boolean))
    for (const ext of exts) {
      const file = p.join(dir, `${name}${ext}`);
      if (exists(file)) return file;
    }
  return undefined;
}

/**
 * How to start corepack. POSIX: the shim (a symlink to corepack's own script, run by the `node` shim next to it).
 * Windows: corepack on PATH is a `.cmd`, which Node refuses to spawn without a shell (and a shell would re-parse
 * the arguments), so this node runs corepack's JS directly from the npm-style layout beside the `.cmd`.
 */
export function corepackCommand({ platform, corepack, execPath }) {
  if (platform === "win32" && /\.(cmd|bat)$/i.test(corepack))
    return {
      command: execPath,
      args: [win32Path.join(win32Path.dirname(corepack), "node_modules/corepack/dist/corepack.js")],
    };
  return { command: corepack, args: [] };
}

/**
 * The environment allowlist for the generator's pnpm runs, the smoke-pack convention: PATH holds only the tool shim
 * directory `bin` and the system directories (never the whole node bin directory, which with nvm also holds global
 * tools such as `pi`); a temp home under `work`; empty npm user and global configs (`work/empty-*-npmrc`, the caller
 * writes them); the REAL corepack home (its cached pnpm; a tool cache). On Windows also SystemRoot and PATHEXT (child
 * processes and DLL loading need them) and temp USERPROFILE / APPDATA / LOCALAPPDATA / TEMP. Nothing else passes.
 */
export function toolEnv({ platform, env, realHome, work, bin }) {
  const p = pathFor(platform);
  const home = p.join(work, "home");
  const common = {
    HOME: home,
    XDG_CONFIG_HOME: p.join(home, ".config"),
    XDG_DATA_HOME: p.join(home, ".local/share"),
    XDG_CACHE_HOME: p.join(home, ".cache"),
    XDG_STATE_HOME: p.join(home, ".local/state"),
    npm_config_userconfig: p.join(work, "empty-user-npmrc"),
    npm_config_globalconfig: p.join(work, "empty-global-npmrc"),
    COREPACK_HOME: corepackHome(env, realHome, platform),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    NO_COLOR: "1",
  };
  if (platform !== "win32") return { PATH: [bin, "/usr/bin", "/bin"].join(":"), ...common };
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
  return {
    PATH: [bin, p.join(systemRoot, "System32"), systemRoot].join(";"),
    SystemRoot: systemRoot,
    PATHEXT: env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
    USERPROFILE: home,
    APPDATA: p.join(home, "AppData/Roaming"),
    LOCALAPPDATA: p.join(home, "AppData/Local"),
    TEMP: p.join(work, "tmp"),
    TMP: p.join(work, "tmp"),
    ...common,
  };
}

// ---- smoke helpers (smoke-dep-dir.mjs) --------------------------------------------------------------------------- //

/** The absolute path a `--remove` entry names, which must lie strictly inside `nodeModules`. */
export function removalPath(nodeModules, rel) {
  const abs = posixPath.isAbsolute(rel) || win32Path.isAbsolute(rel);
  const target = nodePath.resolve(nodeModules, rel);
  const r = nodePath.relative(nodeModules, target);
  if (
    !rel ||
    abs ||
    !r ||
    r === ".." ||
    r.startsWith(`..${nodePath.sep}`) ||
    nodePath.isAbsolute(r)
  )
    throw new Error(`--remove ${JSON.stringify(rel)}: must name a path inside node_modules`);
  return target;
}

/**
 * A Copilot run's error cut down to a non-sensitive word: `run.error` is one of the server's codes (e.g.
 * `unavailable`); anything else becomes `other`. The server does not pass the underlying message (e.g. which package
 * Node could not find) to the snapshot or to stderr, so the code is all a smoke can record.
 */
export function runErrorCategory(error) {
  if (error == null) return { code: null };
  return { code: /^[a-z_]{1,40}$/.test(String(error)) ? String(error) : "other" };
}

/** The smoke's last line and exit code: OK only with no failure AND no path left untested. */
export function smokeVerdict({ failures, untested, label }) {
  if (failures > 0) return { line: `SMOKE FAILED (${label}, ${failures})`, code: 1 };
  if (untested.length > 0)
    return { line: `SMOKE INCOMPLETE (${label}; untested: ${untested.join(", ")})`, code: 2 };
  return { line: `SMOKE OK (${label})`, code: 0 };
}
