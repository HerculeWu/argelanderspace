#!/usr/bin/env node
// Generates the desktop package's dependency directory (desktop-app ticket 22): the app package's runtime dependencies
// that bin.js loads from node_modules instead of carrying inline (Pi SDK, @embedpdf/engines + pdfium, @napi-rs/keyring),
// for ONE target platform, pruned. NOT part of `pnpm -r test` (it installs ~400 MB); its pure rules are in
// dep-dir-lib.mjs and tested by dep-dir.test.mjs. The smoke that proves the pruned directory works is smoke-dep-dir.mjs.
//
//   node packages/app/scripts/dep-dir.mjs --out <new dir> [--target <os>-<arch>] [--online] [--keep <categories>]
//        [--lock <pnpm-lock.yaml>] [--no-license-scan]
//
//   --out     a directory that does not exist yet (or is empty); it receives node_modules/ (the dependency directory),
//             THIRD-PARTY-RUNTIME-NOTICES.txt, dep-dir-report.json, and the package.json + pnpm-lock.yaml it was
//             installed from (provenance). Only node_modules/ and the notices go into the desktop package.
//   --target  linux-x64 (glibc), linux-arm64, darwin-arm64, darwin-x64 or win32-x64; default: this machine.
//   --online  let pnpm download what the local store lacks (another target's native packages). Default: --offline,
//             from the local pnpm store only, like smoke-pack's --offline-lock. Either way versions come from the repo
//             lockfile (--frozen-lockfile); the registry's own resolution of the ranges is never used.
//   --keep    comma list of categories NOT to prune: fonts, foreign, esbuild (all three = the unpruned control).
//   --no-license-scan  skip the license scan of the closure (it needs a second, isolated install).
//
// How: the repo lockfile's packages/app production closure becomes the lockfile of a standalone project, which pnpm
// installs with --prod --frozen-lockfile --ignore-scripts and --os/--cpu/--libc set to the target, so only the target's
// optional native packages come in. The layout is `node-linker=hoisted` (a flat npm-style tree, no symlinks: installers
// and Tauri resources copy it as plain files) with `package-import-method=copy` (no hard links into the real store, so
// pruning can never touch it). Then the prune rules of dep-dir-lib.mjs remove the font files, other platforms'
// prebuilt files and esbuild. The license scan (scripts/license-scan.mjs, unchanged) needs pnpm's isolated layout, so
// it runs on a second, isolated install of the same lockfile in a temp dir.
//
// Isolation: pnpm runs with an env allowlist (PATH of node + system dirs, temp HOME/XDG, empty npm userconfig); it reads
// the real pnpm store (and with --online may add to it, a tool cache) and the real corepack home (cached pnpm). It never
// runs install scripts. Nothing else outside --out and the temp dir is written.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  expectedPlatformPackages,
  foreignPrebuild,
  PRUNE_CATEGORIES,
  pruneAction,
  subsetLockfile,
} from "./dep-dir-lib.mjs";

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

// ---- environment allowlist for pnpm ------------------------------------------------------------------------------ //
const work = mkdtempSync(join(tmpdir(), "argelander-dep-dir-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));
const realHome = homedir();
const pnpmHome = join(work, "home");
mkdirSync(pnpmHome);
writeFileSync(join(work, "empty-npmrc"), "");
const env = {
  // node first: /usr/bin may hold an older node that the corepack pnpm refuses
  PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
  HOME: pnpmHome,
  XDG_CONFIG_HOME: join(pnpmHome, ".config"),
  XDG_DATA_HOME: join(pnpmHome, ".local/share"),
  XDG_CACHE_HOME: join(pnpmHome, ".cache"),
  npm_config_userconfig: join(work, "empty-npmrc"),
  COREPACK_HOME:
    process.env.COREPACK_HOME ??
    join(process.env.XDG_CACHE_HOME ?? join(realHome, ".cache"), "node", "corepack"),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NO_COLOR: "1",
};
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, env, ...options });
  if (r.error) throw r.error;
  return r;
}
function must(r, what) {
  if (r.status !== 0) throw new Error(`${what} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}
const store = must(
  run("corepack", ["pnpm", "store", "path"], {
    cwd: repoRoot,
    env: {
      ...env,
      HOME: realHome,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(realHome, ".local/share"),
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(realHome, ".config"),
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
        packageManager: "pnpm@11.24.0",
        dependencies: subset.dependencies,
      },
      null,
      2
    )}\n`
  );
}
function install(dir, linker) {
  const args = [
    "pnpm",
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
  return must(run("corepack", args, { cwd: dir }), `pnpm install (${linker})`);
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
/** Every installed package directory (hoisted and nested), with its package.json. */
function packages(root) {
  const found = [];
  const visitModules = (modulesDir) => {
    if (!existsSync(modulesDir)) return;
    for (const entry of readdirSync(modulesDir)) {
      if (entry.startsWith(".")) continue;
      const p = join(modulesDir, entry);
      if (entry.startsWith("@")) {
        for (const sub of readdirSync(p)) visitPackage(join(p, sub));
      } else visitPackage(p);
    }
  };
  const visitPackage = (dir) => {
    const pj = join(dir, "package.json");
    if (!existsSync(pj)) return;
    found.push({ dir, pkg: JSON.parse(readFileSync(pj, "utf8")) });
    visitModules(join(dir, "node_modules"));
  };
  visitModules(root);
  return found;
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
for (const { dir, pkg } of packages(nm)) {
  if (!existsSync(dir)) continue; // inside a package removed earlier
  const action = pruneAction(pkg, target);
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
  noticeParts.push(
    `===== ${id} =====\nLicense: ${license}\n` +
      (files.length === 0
        ? "(the package ships no license file; its declared license applies)\n"
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
console.log(`  packages without a license file: ${withoutFile.length}`);
if (scan.ran)
  console.log(`  license scan of the closure: exit ${scan.exit} (output in license-scan.txt)`);
process.exit(scan.ran && scan.exit !== 0 ? 1 : 0);
