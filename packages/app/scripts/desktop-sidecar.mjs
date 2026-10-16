#!/usr/bin/env node
// Assembles the resources of the desktop package (desktop-app ticket 23): what the Tauri bundle carries next to the
// shell, so that the shell's packaged launcher (packages/desktop/src/launch.rs `HostLauncher::packaged`) finds a Node
// and the app build without anything on the user's PATH. NOT part of `pnpm -r test` (it downloads Node and installs
// ~400 MB); its pure rules are in desktop-package-lib.mjs, tested by desktop-package.test.mjs.
//
//   corepack pnpm -r build
//   node packages/app/scripts/desktop-sidecar.mjs [--out <dir>] [--target linux-x64] [--node-version <x.y.z>]
//        [--node-cache <dir>] (--node-keyring <pubring.kbx> | --insecure-skip-node-signature)
//        [--deps <dep-dir.mjs --out dir>] [--online]
//
//   --out           default packages/desktop/target/package-resources (what tauri.package.conf.json maps). Removed and
//                   rebuilt when it holds this script's marker file; any other non-empty directory is refused.
//   --node-version  default: DESKTOP_NODE_VERSION in desktop-package-lib.mjs (pinned in the repository; change it
//                   there); this option overrides it for one run. Major 24 only.
//   --node-cache    where the official archive, SHASUMS256.txt and its signature are kept (default
//                   packages/desktop/target/node-dist). Downloaded from nodejs.org when absent. The archive's sha256 is
//                   checked against SHASUMS256.txt on every run.
//   --node-keyring  REQUIRED (unless the next option): a keyring with the Node release keys (gpg/pubring.kbx of
//                   github.com/nodejs/release-keys). The signature of SHASUMS256.txt is checked with `gpgv` (never
//                   touches your own keyring) before the archive's checksum is read from it; when it does not verify,
//                   the cached SHASUMS256.txt and .sig are removed and the run fails.
//   --insecure-skip-node-signature  do not check the signature (unsafe; for a machine without the keyring). The
//                   manifest records `signature.verified: false` and the desktop package smoke then reports INCOMPLETE.
//   --deps          a dependency directory already made by dep-dir.mjs for the same target; default: run dep-dir.mjs.
//   --online        passed to dep-dir.mjs (another target's native packages).
//
// Layout (relative to --out = the bundle's resource directory once installed):
//   sidecar/node/bin/node, sidecar/node/LICENSE        the official Node runtime and its license (sidecar/node/node.exe
//                                                      on Windows: the archive's own layout; .zip unpacked with tar
//                                                      on Windows and unzip elsewhere)
//   sidecar/app/package.json, sidecar/app/LICENSE      the app package's own (version: the single source, ticket 16)
//   sidecar/app/dist/                                  packages/app/dist: bin.js, web/, argelander.sty, notices
//   sidecar/app/node_modules/                          the dependency directory (ticket 22)
//   sidecar/app/THIRD-PARTY-RUNTIME-NOTICES.txt        its notices, vendored texts included
//   sidecar/app/licenses/                              packages/app/licenses (vendored texts and their manifest)
//   sidecar/sidecar-manifest.json                      versions, checksums, sizes, the budget
//   skills/                                            the repository's skills/ (desktop-app ticket 24 opens it)
//   THIRD-PARTY-SHELL-NOTICES.txt                      the shell's Rust crates (shell-notices.mjs; needs cargo)
//
// Exit: 0 assembled and checked; 1 an error or a failed check (required file missing, license problem); 3 the
// dependency directory is over its budget (500 MB of file content; ticket 22). Nothing outside --out, --node-cache and
// a temp dir is written; dep-dir.mjs's own isolation applies to its run.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { budgetCheck } from "./dep-dir-lib.mjs";
import {
  DESKTOP_NODE_VERSION,
  licenseProblems,
  listInstalledPackages,
  nodeDist,
  nodeExtractCommand,
  nodeSignaturePlan,
  parseStrictArgs,
  SHELL_NOTICES_FILE,
  shaFromShasums,
  sidecarRequiredFiles,
  verifyNodeSignature,
} from "./desktop-package-lib.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(appRoot, "../..");
const MARKER = ".argelander-package-resources";
let args;
try {
  args = parseStrictArgs(process.argv.slice(2), {
    valued: ["--out", "--target", "--node-version", "--node-cache", "--node-keyring", "--deps"],
    flags: ["--online", "--insecure-skip-node-signature"],
  });
} catch (e) {
  console.error(`desktop-sidecar: ${e.message}`);
  process.exit(1);
}
const opt = args.values;
let signaturePlan;
try {
  signaturePlan = nodeSignaturePlan({
    keyring: opt["--node-keyring"] && resolve(opt["--node-keyring"]),
    insecureSkip: args.flags.has("--insecure-skip-node-signature"),
  });
} catch (e) {
  console.error(`desktop-sidecar: ${e.message}`);
  process.exit(1);
}
const target = opt["--target"] ?? `${process.platform}-${process.arch}`;
const nodeVersion = opt["--node-version"] ?? DESKTOP_NODE_VERSION;
if (!nodeVersion.startsWith("24."))
  throw new Error(
    `the desktop package carries Node 24 (got ${nodeVersion}); give --node-version 24.x.y`
  );
const dist = nodeDist(nodeVersion, target);
const out = resolve(opt["--out"] ?? join(repoRoot, "packages/desktop/target/package-resources"));
const cache = resolve(opt["--node-cache"] ?? join(repoRoot, "packages/desktop/target/node-dist"));
const appPkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));

const run = (cmd, argv, options = {}) => spawnSync(cmd, argv, { encoding: "utf8", ...options });
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
function du(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(path)) n += du(join(path, e));
  return n;
}
const work = mkdtempSync(join(tmpdir(), "argelander-sidecar-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

// ---- the app build is there and is this version ------------------------------------------------------------------ //
const binJs = join(appRoot, "dist/bin.js");
if (!existsSync(binJs))
  throw new Error("packages/app/dist/bin.js is missing: run `corepack pnpm -r build` first");
// A bare environment; Windows needs SystemRoot to start a process at all.
const bareEnv =
  process.platform === "win32"
    ? {
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
        USERPROFILE: work,
        TEMP: work,
        TMP: work,
      }
    : { PATH: "/usr/bin:/bin", HOME: work };
const v = run(process.execPath, [binJs, "--version"], { env: bareEnv });
if (v.status !== 0 || v.stdout.trim() !== appPkg.version)
  throw new Error(
    `dist/bin.js --version says ${JSON.stringify(v.stdout.trim())}, the app package is ${appPkg.version}: rebuild`
  );

// ---- --out --------------------------------------------------------------------------------------------------------- //
if (existsSync(out) && readdirSync(out).length > 0) {
  if (!existsSync(join(out, MARKER)))
    throw new Error(
      `--out ${out} is not empty and was not made by this script; give a new directory`
    );
  rmSync(out, { recursive: true, force: true });
}
mkdirSync(out, { recursive: true });
writeFileSync(join(out, MARKER), "made by packages/app/scripts/desktop-sidecar.mjs\n");
const sidecar = join(out, "sidecar");

// ---- Node: download (cached), checksum, signature, extract ------------------------------------------------------- //
mkdirSync(cache, { recursive: true });
async function fetchTo(url, path) {
  if (existsSync(path)) return;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  writeFileSync(`${path}.part`, Buffer.from(await res.arrayBuffer()));
  rmSync(path, { force: true });
  copyFileSync(`${path}.part`, path);
  rmSync(`${path}.part`);
}
const versionCache = join(cache, `v${nodeVersion}`);
mkdirSync(versionCache, { recursive: true });
const shasums = join(versionCache, "SHASUMS256.txt");
const signature = join(versionCache, "SHASUMS256.txt.sig");
const archive = join(versionCache, dist.file);
await fetchTo(dist.shasumsUrl, shasums);
await fetchTo(dist.signatureUrl, signature);
// The signature first: the checksum below is only as good as the list it is read from.
let nodeSignature = {
  verified: false,
  detail: "NOT verified: --insecure-skip-node-signature was given",
};
if (signaturePlan.verify) {
  nodeSignature = verifyNodeSignature({
    keyring: signaturePlan.keyring,
    shasums,
    signature,
    run: (cmd, argv, options) => run(cmd, argv, options),
    remove: (f) => rmSync(f, { force: true }),
  });
  nodeSignature.keyring_sha256 = sha256(signaturePlan.keyring);
  console.log(`SHASUMS256.txt signature: ${nodeSignature.detail}`);
} else console.warn(`WARNING SHASUMS256.txt signature ${nodeSignature.detail}`);
await fetchTo(dist.url, archive);
const expected = shaFromShasums(readFileSync(shasums, "utf8"), dist.file);
const actual = sha256(archive);
if (actual !== expected) {
  rmSync(archive);
  throw new Error(
    `${dist.file}: sha256 ${actual} does not match SHASUMS256.txt (${expected}); removed it`
  );
}
console.log(`node ${nodeVersion} ${dist.file}: sha256 matches SHASUMS256.txt`);
const unpack = nodeExtractCommand(dist, archive, work, process.platform, process.env.SystemRoot);
const x = run(unpack.cmd, unpack.args);
if (x.error || x.status !== 0)
  throw new Error(`${unpack.cmd} could not unpack ${dist.file}: ${x.error?.code ?? x.stderr}`);
mkdirSync(join(sidecar, "node", dist.binary, ".."), { recursive: true });
copyFileSync(join(work, dist.base, dist.binary), join(sidecar, "node", dist.binary));
chmodSync(join(sidecar, "node", dist.binary), 0o755);
copyFileSync(join(work, dist.base, "LICENSE"), join(sidecar, "node/LICENSE"));

// ---- the app build ------------------------------------------------------------------------------------------------ //
cpSync(join(appRoot, "dist"), join(sidecar, "app/dist"), { recursive: true });
copyFileSync(join(appRoot, "package.json"), join(sidecar, "app/package.json"));
copyFileSync(join(repoRoot, "LICENSE"), join(sidecar, "app/LICENSE"));

// ---- the dependency directory (ticket 22) ------------------------------------------------------------------------ //
let deps = opt["--deps"] ? resolve(opt["--deps"]) : null;
if (!deps) {
  deps = join(work, "deps");
  const d = run(
    process.execPath,
    [
      join(appRoot, "scripts/dep-dir.mjs"),
      "--out",
      deps,
      "--target",
      target,
      ...(args.flags.has("--online") ? ["--online"] : []),
    ],
    { stdio: "inherit" }
  );
  if (d.status !== 0) {
    console.error(`dep-dir.mjs exited ${d.status}`);
    process.exit(d.status === 3 ? 3 : 1);
  }
}
const report = JSON.parse(readFileSync(join(deps, "dep-dir-report.json"), "utf8"));
if (report.target !== target)
  throw new Error(`--deps was made for ${report.target}, not ${target}`);
cpSync(join(deps, "node_modules"), join(sidecar, "app/node_modules"), {
  recursive: true,
  verbatimSymlinks: true,
});
copyFileSync(
  join(deps, "THIRD-PARTY-RUNTIME-NOTICES.txt"),
  join(sidecar, "app/THIRD-PARTY-RUNTIME-NOTICES.txt")
);
cpSync(join(appRoot, "licenses"), join(sidecar, "app/licenses"), { recursive: true });

// ---- skills (desktop-app ticket 24 opens this folder) ------------------------------------------------------------- //
cpSync(join(repoRoot, "skills"), join(out, "skills"), { recursive: true });

// ---- the shell's Rust crates: their notices (desktop-app ticket 26) ---------------------------------------------- //
const notices = run(
  process.execPath,
  [
    join(appRoot, "scripts/shell-notices.mjs"),
    "--out",
    join(out, SHELL_NOTICES_FILE),
    "--target",
    target,
  ],
  { stdio: "inherit" }
);
if (notices.status !== 0) {
  console.error(
    `shell-notices.mjs exited ${notices.status}: the shell's crate notices are not complete`
  );
  process.exit(1);
}

// ---- checks: required files, licenses, budget -------------------------------------------------------------------- //
let failed = false;
const nodeModules = join(sidecar, "app/node_modules");
const budget = budgetCheck(du(nodeModules));
const sizes = {
  node_runtime_bytes: du(join(sidecar, "node")),
  app_dist_bytes: du(join(sidecar, "app/dist")),
  dependency_directory_bytes: budget.bytes,
  skills_bytes: du(join(out, "skills")),
};
const manifest = {
  app: { name: appPkg.name, version: appPkg.version },
  target,
  node: {
    version: nodeVersion,
    archive: dist.file,
    url: dist.url,
    sha256: actual,
    // The binary as assembled: a bundler that rewrites it (linuxdeploy sets a RUNPATH in an AppImage) shows up here.
    binary_sha256: sha256(join(sidecar, "node", dist.binary)),
    shasums_sha256: sha256(shasums),
    signature: nodeSignature,
  },
  dependency_directory: {
    packages: report.packages_after,
    packages_without_license_file: report.packages_without_license_file,
    packages_without_license_text: report.packages_without_license_text,
    budget: { measures: "sum of file sizes under sidecar/app/node_modules", ...budget },
  },
  sizes: { ...sizes, total_bytes: Object.values(sizes).reduce((a, b) => a + b, 0) },
};
writeFileSync(join(sidecar, "sidecar-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const missing = sidecarRequiredFiles(target).filter((f) => !existsSync(join(out, f)));
for (const f of missing) console.error(`MISSING ${f}`);
if (missing.length) failed = true;
const vendored = JSON.parse(
  readFileSync(join(sidecar, "app/licenses/runtime-licenses.json"), "utf8")
);
const problems = licenseProblems({
  packages: listInstalledPackages(nodeModules, { join, existsSync, readdirSync, readFileSync }),
  manifest: vendored,
  vendoredSha: (f) =>
    existsSync(join(sidecar, "app/licenses", f)) ? sha256(join(sidecar, "app/licenses", f)) : null,
});
for (const p of problems) console.error(`LICENSE ${p}`);
if (problems.length) failed = true;

const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
console.log(`desktop package resources for ${target}: ${out}`);
console.log(
  `  node ${mb(sizes.node_runtime_bytes)}, app dist ${mb(sizes.app_dist_bytes)}, dependency directory ${mb(sizes.dependency_directory_bytes)}, skills ${mb(sizes.skills_bytes)}`
);
console.log(
  `  license check: ${problems.length} problem(s); required files missing: ${missing.length}`
);
console.log(`  budget: ${budget.line}`);
if (failed) process.exit(1);
if (!budget.ok) process.exit(3);
