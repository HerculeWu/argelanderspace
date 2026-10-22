#!/usr/bin/env node
// Generates the desktop package's dependency directory (desktop-app ticket 22): the app package's runtime dependencies
// that bin.js loads from node_modules instead of carrying inline (Pi SDK, @embedpdf/engines + pdfium, @napi-rs/keyring),
// for ONE target platform, pruned. NOT part of `pnpm -r test` (it installs ~400 MB); its pure rules are in
// dep-dir-lib.mjs and tested by dep-dir.test.mjs. The smoke that proves the pruned directory works is smoke-dep-dir.mjs.
//
//   node packages/app/scripts/dep-dir.mjs --out <new dir> [--target <os>-<arch>] [--online] [--keep <categories>]
//        [--lock <pnpm-lock.yaml>] [--no-license-scan] [--budget-mb <n>]
//
//   --out     a directory that does not exist yet (or is empty); it receives node_modules/ (the dependency directory),
//             THIRD-PARTY-RUNTIME-NOTICES.txt, dep-dir-report.json, and the package.json + pnpm-lock.yaml it was
//             installed from (provenance). Only node_modules/ and the notices go into the desktop package.
//   --target  linux-x64 (glibc), linux-arm64, darwin-arm64, darwin-x64 or win32-x64; default: this machine.
//   --online  let pnpm download what the local store lacks (another target's native packages). Default: --offline,
//             from the local pnpm store only, like smoke-pack's --offline-lock. Either way versions come from the repo
//             lockfile (--frozen-lockfile); the registry's own resolution of the ranges is never used.
//   --keep    comma list of categories NOT to prune: fonts, foreign, esbuild, peers (all four = the unpruned control).
//   --no-license-scan  skip the license scan of the closure (it needs a second, isolated install).
//   --budget-mb  the size budget in decimal MB (default 500, the user's decision for ticket 22). What it measures: the
//             sum of the sizes of the files under node_modules after pruning (`bytes_after` / `budget` in the report)
//             -- NOT the installer's size, NOT the disk usage after install (cluster rounding adds ~30% on ext4), NOT
//             the Node runtime (ticket 23 counts those separately). Over budget: the directory is kept for inspection,
//             a line `OVER BUDGET` is printed and the exit code is 3 (a failed license scan exits 1).
//
// How: the repo lockfile's packages/app production closure becomes the lockfile of a standalone project, which pnpm
// installs with --prod --frozen-lockfile --ignore-scripts and --os/--cpu/--libc set to the target, so only the target's
// optional native packages come in. The layout is `node-linker=hoisted` (a flat npm-style tree, no symlinks: installers
// and Tauri resources copy it as plain files) with `package-import-method=copy` (no hard links into the real store, so
// pruning can never touch it). Then the prune rules of dep-dir-lib.mjs remove the font files of the PDF engine's
// non-CJK font packages (the CJK ones are its font fallback and stay, ticket 28), other platforms' prebuilt files,
// esbuild, and typescript with the UI frameworks that are only peers of @embedpdf/engines (ticket 29) plus what only
// they pull in. The license scan (scripts/license-scan.mjs, unchanged) needs pnpm's isolated layout, so
// it runs on a second, isolated install of the same lockfile in a temp dir.
//
// Isolation, stated exactly (the smoke-pack convention; NOT a fully isolated tree): pnpm runs with an env allowlist
// (dep-dir-lib.mjs toolEnv: PATH = a temp shim directory holding only `node` and `corepack` plus the system directories,
// never the whole node bin directory, which with nvm also holds global tools such as `pi`; temp HOME/XDG_*; empty npm
// user AND global configs). It READS the real corepack home (the cached pnpm, pinned by the root package.json's
// packageManager; corepack may touch its lastKnownGood file) and the real pnpm store; with --online pnpm may also WRITE
// to that store (adds the downloaded tarballs; a tool cache, never user data). It never runs install scripts. Nothing
// else outside --out and the temp dir is written.
//
// Platforms: verified only on Linux x64, cross-generating all four targets there (--target, --online). Running it ON
// Windows or macOS is unverified (ticket 26). What is already handled for Windows: corepack is started as
// `node <corepack.js>` (a .cmd cannot be spawned without a shell), the env keeps SystemRoot/PATHEXT and gets temp
// USERPROFILE/APPDATA/LOCALAPPDATA/TEMP, the system PATH is %SystemRoot%\System32, COREPACK_HOME follows corepack's
// Windows default (%LOCALAPPDATA%\node\corepack). Not handled: symlink shims (Windows needs a privilege for them, so
// the shim directory stays empty there and pnpm runs in-process under this node).
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPackages as packages } from "./dep-dir-fs.mjs";
import {
  budgetCheck,
  corepackCommand,
  DEP_DIR_BUDGET_BYTES,
  expectedPlatformPackages,
  findTool,
  foreignPrebuild,
  orphanPackages,
  PEER_FRAMEWORK_PACKAGES,
  PRUNE_CATEGORIES,
  pnpmVersion,
  pruneAction,
  subsetLockfile,
  toolEnv,
} from "./dep-dir-lib.mjs";
import { vendoredLicense } from "./desktop-package-lib.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(appRoot, "../..");
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const TARGETS = {
  "linux-x64": { platform: "linux", arch: "x64", libc: "glibc" },
  "linux-arm64": { platform: "linux", arch: "arm64", libc: "glibc" },
  "darwin-arm64": { platform: "darwin", arch: "arm64" },
  "darwin-x64": { platform: "darwin", arch: "x64" },
  "win32-x64": { platform: "win32", arch: "x64" },
};
const targetName = flag("--target") ?? `${process.platform}-${process.arch}`;
const target = TARGETS[targetName];
if (!target)
  throw new Error(`unknown --target ${targetName} (one of ${Object.keys(TARGETS).join(", ")})`);
const outArg = flag("--out");
if (!outArg) throw new Error("--out <new directory> is required");
const out = resolve(outArg);
if (existsSync(out) && readdirSync(out).length > 0)
  throw new Error(`--out ${out} exists and is not empty; give a new directory`);
const keep = new Set((flag("--keep") ?? "").split(",").filter(Boolean));
for (const k of keep)
  if (!PRUNE_CATEGORIES.includes(k)) throw new Error(`--keep: unknown category ${k}`);
const online = argv.includes("--online");
const licenseScan = !argv.includes("--no-license-scan");
const lockPath = resolve(flag("--lock") ?? join(repoRoot, "pnpm-lock.yaml"));
const budgetArg = flag("--budget-mb");
const budgetBytes = budgetArg === undefined ? DEP_DIR_BUDGET_BYTES : Number(budgetArg) * 1e6;
if (!(budgetBytes > 0)) throw new Error(`--budget-mb: not a positive number: ${budgetArg}`);
const pnpm = pnpmVersion(readFileSync(join(repoRoot, "package.json"), "utf8"));

// ---- environment allowlist for pnpm ------------------------------------------------------------------------------ //
const work = mkdtempSync(join(tmpdir(), "argelander-dep-dir-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));
const realHome = homedir();
writeFileSync(join(work, "empty-user-npmrc"), "");
writeFileSync(join(work, "empty-global-npmrc"), "");
// Tool shims (POSIX): only this node and its corepack are reachable on PATH. corepack's script runs under the `node`
// it finds on PATH, so the node shim is this very node (an older /usr/bin/node is refused by the pinned pnpm).
const bin = join(work, "bin");
mkdirSync(bin);
const corepackFound = findTool("corepack", {
  path: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
  platform: process.platform,
  pathext: process.env.PATHEXT,
  exists: existsSync,
});
if (!corepackFound) throw new Error("corepack not found next to this node or on PATH");
if (process.platform !== "win32") {
  symlinkSync(process.execPath, join(bin, "node"));
  symlinkSync(corepackFound, join(bin, "corepack"));
}
const corepack = corepackCommand({
  platform: process.platform,
  corepack: process.platform === "win32" ? corepackFound : join(bin, "corepack"),
  execPath: process.execPath,
});
const env = toolEnv({ platform: process.platform, env: process.env, realHome, work, bin });
for (const d of [env.HOME, env.TEMP].filter(Boolean)) mkdirSync(d, { recursive: true });
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, env, ...options });
  if (r.error) throw r.error;
  return r;
}
function must(r, what) {
  if (r.status !== 0) throw new Error(`${what} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
const pnpmCli = (args, options) =>
  run(corepack.command, [...corepack.args, "pnpm", ...args], options);
const realDirs = Object.fromEntries(
  ["USERPROFILE", "APPDATA", "LOCALAPPDATA"]
    .filter((k) => process.platform === "win32" && process.env[k])
    .map((k) => [k, process.env[k]])
);
const store = must(
  pnpmCli(["store", "path"], {
    cwd: repoRoot,
    env: {
      ...env,
      HOME: realHome,
      // pnpm takes PNPM_HOME, then XDG_DATA_HOME, then the platform's own place (~/Library/pnpm, %LOCALAPPDATA%\pnpm,
      // ~/.local/share/pnpm): the caller's own values only, so the platform default is not overridden.
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      PNPM_HOME: process.env.PNPM_HOME,
      ...realDirs,
    }, // read-only query of where the real store is
  }),
  "pnpm store path"
).trim();

// ---- the standalone project ------------------------------------------------------------------------------------- //
const appVersion = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")).version;
const subset = subsetLockfile(readFileSync(lockPath, "utf8"), "packages/app");
function writeProject(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pnpm-lock.yaml"), subset.lockfile);
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "argelanderspace-desktop-deps",
        version: appVersion,
        private: true,
        description: `Runtime dependency directory of argelanderspace ${appVersion} for ${targetName} (generated by packages/app/scripts/dep-dir.mjs)`,
        packageManager: `pnpm@${pnpm}`,
        dependencies: subset.dependencies,
      },
      null,
      2
    )}\n`
  );
}
function install(dir, linker) {
  const args = [
    "install",
    "--frozen-lockfile",
    "--trust-lockfile",
    "--ignore-scripts",
    "--ignore-workspace",
    "--prod",
    "--store-dir",
    store,
    `--config.node-linker=${linker}`,
    "--config.package-import-method=copy",
    "--config.minimum-release-age=0",
    "--os",
    target.platform,
    "--cpu",
    target.arch,
    ...(target.libc ? ["--libc", target.libc] : []),
    ...(online ? [] : ["--offline"]),
  ];
  return must(pnpmCli(args, { cwd: dir }), `pnpm install (${linker})`);
}

// A failed generation leaves no half-made directory behind (a failed license scan keeps it, for inspection).
let generated = false;
const createdOut = !existsSync(out);
process.on("exit", (code) => {
  if (code !== 0 && !generated && createdOut) rmSync(out, { recursive: true, force: true });
});
writeProject(out);
install(out, "hoisted");
const nm = join(out, "node_modules");
for (const junk of [".bin", ".pnpm", ".modules.yaml", ".package-map.json"])
  rmSync(join(nm, junk), { recursive: true, force: true });
for (const f of readdirSync(nm)) if (f.startsWith(".pnpm-")) rmSync(join(nm, f), { force: true });

// ---- walk the installed packages -------------------------------------------------------------------------------- //
function du(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(path)) n += du(join(path, e));
  return n;
}
function dirsUnder(dir, base = dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    acc.push(relative(base, p).split(sep).join("/"));
    dirsUnder(p, base, acc);
  }
  return acc;
}

// An offline install silently skips an optional package the store does not hold: the target's own native packages
// must all be there, or the directory is unusable on the target (e.g. no keychain module).
{
  const installed = new Set(packages(nm).map(({ pkg }) => `${pkg.name}@${pkg.version}`));
  const missing = expectedPlatformPackages(subset.lockfile, target).filter(
    (id) => !installed.has(id)
  );
  if (missing.length > 0)
    throw new Error(
      `the install lacks the target's own platform packages: ${missing.join(", ")}${online ? "" : " (not in the local pnpm store; run with --online)"}`
    );
}
const sizeBefore = du(nm);
const countBefore = packages(nm).length;
const removed = Object.fromEntries(PRUNE_CATEGORIES.map((c) => [c, []]));
// peers (ticket 29): what only typescript and the UI frameworks pull in goes with them. A package that really depends
// on one of them (not as a peer) would be broken by removing it: refuse instead.
let peerOrphans = new Set();
let unexpectedPeerDependents = [];
if (!keep.has("peers")) {
  const plan = orphanPackages(
    packages(nm).map(({ pkg }) => pkg),
    Object.keys(subset.dependencies),
    PEER_FRAMEWORK_PACKAGES
  );
  if (plan.hardDependents.length > 0)
    throw new Error(
      `peers: ${plan.hardDependents.map((d) => `${d.from} depends on ${d.to}`).join(", ")}; those cannot be removed`
    );
  peerOrphans = new Set(plan.orphans);
  // @embedpdf/engines is the known package that lists them as peers (its framework entry points are never loaded).
  // Any other reachable package with such a peer would lose it silently: say so (report + warning).
  unexpectedPeerDependents = plan.peerDependents.filter((d) => d.from !== "@embedpdf/engines");
  for (const d of unexpectedPeerDependents)
    console.warn(
      `warning: peers: ${d.from} lists ${d.to} as a peer dependency, and ${d.to} is removed`
    );
}
for (const { dir, pkg } of packages(nm)) {
  if (!existsSync(dir)) continue; // inside a package removed earlier
  const action = peerOrphans.has(pkg.name)
    ? { category: "peers", remove: "." }
    : pruneAction(pkg, target);
  if (action && !keep.has(action.category)) {
    const path = action.remove === "." ? dir : join(dir, action.remove);
    if (existsSync(path)) {
      const bytes = du(path);
      rmSync(path, { recursive: true, force: true });
      removed[action.category].push({ path: relative(nm, path).split(sep).join("/"), bytes });
    }
    if (action.remove === ".") continue;
  }
  if (keep.has("foreign")) continue;
  for (const rel of dirsUnder(dir)) {
    const path = join(dir, rel);
    if (!existsSync(path) || !foreignPrebuild(rel, target)) continue;
    const bytes = du(path);
    rmSync(path, { recursive: true, force: true });
    removed.foreign.push({ path: relative(nm, path).split(sep).join("/"), bytes });
  }
}

// ---- notices: every kept package's license field and license files ---------------------------------------------- //
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const kept = packages(nm).sort((a, b) =>
  `${a.pkg.name}@${a.pkg.version}`.localeCompare(`${b.pkg.name}@${b.pkg.version}`)
);
const seen = new Set();
const noticeParts = [
  `Third-party software in the runtime dependency directory of argelanderspace ${appVersion} (${targetName}).\n` +
    "Each entry: the package, the license its package.json declares, and the license files it ships.\n",
];
const withoutFile = [];
// Packages that ship no license file get the version-qualified text vendored in packages/app/licenses (ticket 23,
// the user's decision in ticket 22), when there is one for exactly that version.
const licensesDir = join(appRoot, "licenses");
const vendored = JSON.parse(readFileSync(join(licensesDir, "runtime-licenses.json"), "utf8"));
const withoutText = [];
const licenses = {};
for (const { dir, pkg } of kept) {
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const license =
    typeof pkg.license === "string"
      ? pkg.license
      : (pkg.license?.type ?? "UNKNOWN (no license field)");
  licenses[id] = license;
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f));
  if (files.length === 0) withoutFile.push(id);
  const v = files.length === 0 ? vendoredLicense(vendored, pkg.name, pkg.version) : null;
  if (files.length === 0 && !v) withoutText.push(id);
  noticeParts.push(
    `===== ${id} =====\nLicense: ${license}\n` +
      (files.length === 0
        ? v
          ? `(the package ships no license file; text vendored as licenses/${v.file}, ${v.kind}: ${vendored.files[v.file].source}${v.note ? `; ${v.note}` : ""})\n--- licenses/${v.file} ---\n${readFileSync(join(licensesDir, v.file), "utf8").trimEnd()}\n`
          : "(the package ships no license file; its declared license applies)\n"
        : files
            .map((f) => `--- ${f} ---\n${readFileSync(join(dir, f), "utf8").trimEnd()}\n`)
            .join(""))
  );
}
writeFileSync(join(out, "THIRD-PARTY-RUNTIME-NOTICES.txt"), noticeParts.join("\n"));
generated = true;

// ---- license scan of the closure (isolated layout, temp dir) ---------------------------------------------------- //
let scan = { ran: false };
if (licenseScan) {
  const iso = join(work, "isolated");
  writeProject(iso);
  install(iso, "isolated");
  const r = run(process.execPath, [join(repoRoot, "scripts/license-scan.mjs"), "--root", iso]);
  scan = { ran: true, exit: r.status, output: `${r.stdout}${r.stderr}`.trim() };
  writeFileSync(join(out, "license-scan.txt"), `${scan.output}\n`);
}

const sizeAfter = du(nm);
const budget = budgetCheck(sizeAfter, budgetBytes);
const report = {
  app: appVersion,
  target: targetName,
  install: online
    ? "pnpm --frozen-lockfile (registry allowed)"
    : "pnpm --offline --frozen-lockfile",
  kept_categories: [...keep],
  packages_before: countBefore,
  packages_after: packages(nm).length,
  bytes_before: sizeBefore,
  bytes_after: sizeAfter,
  removed: Object.fromEntries(
    Object.entries(removed).map(([c, list]) => [
      c,
      { bytes: list.reduce((n, x) => n + x.bytes, 0), paths: list.map((x) => x.path) },
    ])
  ),
  packages_without_license_file: withoutFile,
  packages_without_license_text: withoutText,
  peer_dependents_of_removed: unexpectedPeerDependents,
  budget: {
    measures: "sum of file sizes under node_modules after pruning (decimal MB = 1e6 bytes)",
    bytes: budget.bytes,
    budget_bytes: budget.budget,
    ok: budget.ok,
  },
  license_scan: scan.ran ? { exit: scan.exit } : "skipped",
  licenses,
};
writeFileSync(join(out, "dep-dir-report.json"), `${JSON.stringify(report, null, 2)}\n`);
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
console.log(`dependency directory for ${targetName}: ${nm}`);
console.log(
  `  ${countBefore} packages, ${mb(sizeBefore)} installed -> ${report.packages_after} packages, ${mb(sizeAfter)} after pruning`
);
for (const c of PRUNE_CATEGORIES)
  console.log(
    `  ${c}: ${keep.has(c) ? "kept" : `removed ${report.removed[c].paths.length} paths, ${mb(report.removed[c].bytes)}`}`
  );
console.log(
  `  packages without a license file: ${withoutFile.length} (of which without a vendored text: ${withoutText.length})`
);
if (scan.ran)
  console.log(`  license scan of the closure: exit ${scan.exit} (output in license-scan.txt)`);
console.log(`  budget: ${budget.line}`);
process.exit(scan.ran && scan.exit !== 0 ? 1 : budget.ok ? 0 : 3);
