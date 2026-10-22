#!/usr/bin/env node
// Local pack + clean-install smoke of the published app (copilot ticket 31). NOT part of `pnpm -r test`: it needs a
// built package (`corepack pnpm -r build`), installs dependencies into a temp dir and starts a real server.
//
//   node packages/app/scripts/smoke-pack.mjs [--offline-lock <repo pnpm-lock.yaml>] [--keep] [--evidence <dir>]
//
// Isolation, stated exactly (nothing here is "everything in a throwaway tree"):
//   - Every pack/install/run process gets an env ALLOWLIST (PATH of symlinks to node/npm/corepack plus /usr/bin:/bin, a temp
//     HOME, temp XDG_*, a temp npm cache, an empty npm userconfig): no real ~/.npmrc, npm cache or secret env var reaches them.
//     `npm pack` runs the repo's own `prepack` check (trusted repo code); installs always use --ignore-scripts.
//   - The ONLY reads/writes outside the temp tree are: the repo (packages/app, read by `npm pack`), the real corepack home
//     (a cached pnpm binary; corepack may touch its lastKnownGood file) and, with --offline-lock, the real pnpm content store
//     (read for the packages; pnpm may add index files to it if it has to). The first is a source tree, the others are
//     tool caches, never user data; nothing else is written outside the temp tree.
//   - The run phase starts the installed server with `--port 0` (the OS picks the port), accepts it only after the child
//     itself printed its listen line and data dir, and re-checks that the child is alive and the library empty before ANY
//     write, so it can never talk to an unrelated server that happens to listen elsewhere. `--private-net` additionally
//     runs the whole smoke in a fresh network namespace (unshare -rn, loopback only).
//
//   node packages/app/scripts/smoke-pack.mjs [--offline-lock <repo pnpm-lock.yaml>] [--keep] [--evidence <dir>]
//        [--private-net] [--mutate-default-loader]
//   --mutate-default-loader: a CONTROL, not a pass: it patches the INSTALLED copy of bin.js (in the temp tree only) so the
//   session uses Pi's default resource loader, to show the decoy checks then FAIL (exit 1 is the expected outcome).
//
// What it proves:
//   1. `npm pack` of packages/app (written to the temp dir, never next to the sources) satisfies pack-contents.mjs and holds no
//      secret-looking text; the package.json that ships declares Node >=24 and exact runtime dependencies.
//   2. the tarball installs into an empty project (default: a plain `npm install` from the registry; with
//      --offline-lock: pnpm from the local store, pinned to the repo lockfile's versions, for machines without a network;
//      this is a partial clean install, a user decision recorded in ticket 31).
//   3. the installed `argelanderspace serve` runs with a PATH that has NO global pi, with decoy `.pi`/AGENTS/skill/extension
//      files where Pi's DefaultResourceLoader would look (the session cwd <dataDir>/copilot/runtime, its ancestors and the
//      agentDir <dataDir>/copilot/agent, plus cwd and HOME), and answers: web assets, KaTeX fonts, notices, argelander.sty.
//   4. a Copilot conversation against a local scripted OpenAI-Responses server (no real model, no external network)
//      opens, loads the pdf-transcription instruction, runs real tools (plan write, PDF read, PDFium page render to a PNG
//      the model receives), is answered after a server restart (the native session history resumes), the model sees
//      exactly the application tools plus the file and command tools of the default permission (ADR 0011: "ask") and,
//      once config.toml says "off", the application tools alone, no decoy resource reaches it, and read_svg_image
//      answers cleanly without resvg.
//   5. the installed package's dist/tutorial (the tutorial sample, in-app-tutorial ticket 27) is loadable: a temp copy
//      is the data dir of the installed server (`--data-dir <copy>/literatures`, own temp HOME/XDG), which lists the
//      five Works and gives Jerabkova's three annotations without archiving them; NOTICE.md and the upload zip are
//      there; its size is reported, not gated (tutorial-smoke-lib.mjs).
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_TOOL_NAMES } from "../../contracts/dist/index.js";
import { lockfileClosure, pnpmVersion } from "./dep-dir-lib.mjs";
import { checkPackContents } from "./pack-contents.mjs";
import { checkTutorialLoadable, tutorialSize } from "./tutorial-smoke-lib.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
if (argv.includes("--private-net") && !process.env.ARGELANDER_SMOKE_NETNS) {
  const self = fileURLToPath(import.meta.url);
  const r = spawnSync(
    "unshare",
    ["-rn", "sh", "-c", 'ip link set lo up && exec "$0" "$@"', process.execPath, self, ...argv],
    { stdio: "inherit", env: { ...process.env, ARGELANDER_SMOKE_NETNS: "1" } }
  );
  process.exit(r.status ?? 1);
}
if (argv.includes("--private-net")) {
  // proven, not assumed: inside the namespace only loopback interfaces may exist
  const external = Object.entries(networkInterfaces()).filter(([, list]) =>
    (list ?? []).some((a) => !a.internal)
  );
  if (external.length > 0)
    throw new Error(
      `--private-net: not in a private network namespace (${external.map(([n]) => n).join(", ")})`
    );
  console.log("network: private namespace (unshare -rn), loopback only");
}
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const keep = argv.includes("--keep");
const mutateLoader = argv.includes("--mutate-default-loader");
const offlineLock = flag("--offline-lock");
const work = mkdtempSync(join(tmpdir(), "argelander-pack-smoke-"));
const evidenceDir = flag("--evidence") ?? join(work, "evidence");
mkdirSync(evidenceDir, { recursive: true });
const results = [];
const log = (line) => {
  console.log(line);
  results.push(line);
};
let failures = 0;
function check(ok, what, detail = "") {
  if (!ok) failures += 1;
  log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` -- ${detail}` : ""}`);
}
const children = new Set();
// Always remove the temp tree and kill children, whatever ends the process (exception, signal, normal exit).
function cleanup() {
  for (const child of children) child.kill("SIGKILL");
  if (keep) console.log(`kept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(1));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Tool shims: only node, npm and corepack are reachable (never the nvm bin dir, which also holds a global pi).
const bin = join(work, "bin");
mkdirSync(bin);
for (const tool of ["node", "npm", "corepack"]) {
  const found = (process.env.PATH ?? "")
    .split(delimiter)
    .map((d) => join(d, tool))
    .find((f) => existsSync(f));
  if (!found) throw new Error(`${tool} not found on PATH`);
  symlinkSync(found, join(bin, tool));
}
const instHome = join(work, "inst-home");
mkdirSync(instHome);
writeFileSync(join(work, "empty-user-npmrc"), "");
writeFileSync(join(work, "empty-global-npmrc"), "");
const realHome = homedir();
const cleanEnv = {
  PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
  HOME: instHome,
  XDG_CONFIG_HOME: join(instHome, ".config"),
  XDG_DATA_HOME: join(instHome, ".local/share"),
  XDG_CACHE_HOME: join(instHome, ".cache"),
  XDG_STATE_HOME: join(instHome, ".state"),
  npm_config_cache: join(work, "npm-cache"),
  npm_config_userconfig: join(work, "empty-user-npmrc"),
  npm_config_globalconfig: join(work, "empty-global-npmrc"),
  // pnpm is a corepack shim: its cached binary lives in the REAL corepack home (a tool cache, see the header).
  COREPACK_HOME:
    process.env.COREPACK_HOME ??
    join(process.env.XDG_CACHE_HOME ?? join(realHome, ".cache"), "node", "corepack"),
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NO_COLOR: "1",
};
function onPath(tool, path) {
  return path
    .split(delimiter)
    .map((d) => join(d, tool))
    .find((f) => existsSync(f));
}
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: cleanEnv,
    ...options,
  });
  if (r.status !== 0)
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}): ${r.stderr || r.stdout}`);
  return r.stdout;
}

// ---- 1. pack ---------------------------------------------------------------------------------------------------- //
const packDir = join(work, "pack");
mkdirSync(packDir);
const packJson = JSON.parse(
  run("npm", ["pack", "--pack-destination", packDir, "--json"], { cwd: appRoot })
);
const tarball = join(packDir, packJson[0].filename);
// The tarball's own listing: npm 11 masks UUID-shaped file names in `pack --json` (`***.json`), which the example's
// Copilot conversation files are, so the JSON listing cannot be read back from the extracted tree.
const listing = run("tar", ["-tzf", tarball])
  .split("\n")
  .filter((name) => name.startsWith("package/") && !name.endsWith("/"))
  .map((name) => name.slice("package/".length))
  .sort();
check(
  listing.length === packJson[0].files.length,
  "the tarball's own listing has as many files as npm reported",
  `${listing.length} vs ${packJson[0].files.length}`
);
// Every path npm reported unmasked must be in tar's listing under the same spelling (a non-ASCII name that tar
// escaped would show up here), so the listing used below is trustworthy.
const inListing = new Set(listing);
const missingFromTar = packJson[0].files
  .map((f) => f.path)
  .filter((p) => !p.includes("***") && !inListing.has(p));
check(
  missingFromTar.length === 0,
  "every unmasked path npm reported is in the tarball's own listing",
  missingFromTar.slice(0, 5).join("; ")
);
writeFileSync(join(evidenceDir, "tarball-contents.txt"), `${listing.join("\n")}\n`);
log(
  `tarball ${packJson[0].filename}: ${listing.length} files, ${packJson[0].size} bytes packed, ${packJson[0].unpackedSize} unpacked`
);
const problems = checkPackContents(listing);
check(problems.length === 0, "tarball contents satisfy the package policy", problems.join("; "));
const extracted = join(work, "extracted");
mkdirSync(extracted);
run("tar", ["-xzf", tarball, "-C", extracted]);
const shipped = JSON.parse(readFileSync(join(extracted, "package/package.json"), "utf8"));
check(
  shipped.engines?.node === ">=24",
  "shipped package.json declares engines.node >=24",
  JSON.stringify(shipped.engines)
);
const depSpecs = Object.entries(shipped.dependencies ?? {});
check(
  depSpecs.length > 0 && depSpecs.every(([, v]) => /^\d+\.\d+\.\d+$/.test(v)),
  "runtime dependencies are exact versions with no workspace/file protocol",
  depSpecs.map(([k, v]) => `${k}@${v}`).join(", ")
);
for (const name of [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@embedpdf/pdfium",
  "@embedpdf/engines",
])
  check(name in (shipped.dependencies ?? {}), `${name} is a declared runtime dependency`);
check(
  !("@resvg/resvg-js" in { ...shipped.dependencies, ...shipped.optionalDependencies }),
  "@resvg/resvg-js is NOT declared (pending user decision)"
);
const SECRET = [
  [/sk-[A-Za-z0-9_-]{20,}/, "an API-key-looking string"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/gh[pous]_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/\/home\/[a-z0-9_-]+\//, "an absolute home path"],
];
const textFiles = listing.filter((p) => /\.(?:js|json|md|txt|sty|html|css|mjs)$/.test(p));
const hits = [];
for (const file of textFiles) {
  const text = readFileSync(join(extracted, "package", file), "utf8");
  for (const [pattern, why] of SECRET) if (pattern.test(text)) hits.push(`${file}: ${why}`);
}
check(
  hits.length === 0,
  "no secret-looking text or absolute home path in any packed text file",
  hits.join("; ")
);
const bundle = readFileSync(join(extracted, "package/dist/bin.js"), "utf8");
check(
  bundle
    .split("\n")[1]
    ?.startsWith(
      'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
    ),
  "dist/bin.js keeps the createRequire banner (line 2)"
);
const notices = readFileSync(
  join(extracted, "package/dist/THIRD-PARTY-BUNDLED-NOTICES.txt"),
  "utf8"
);
check(
  /===== katex@[\d.]+ =====\nThe MIT License/.test(notices) &&
    /===== marked@[\d.]+ =====\n/.test(notices),
  "bundled notices carry the KaTeX and marked licenses"
);
const mailNotices = readFileSync(
  join(extracted, "package/dist/THIRD-PARTY-MAIL-NOTICES.txt"),
  "utf8"
);
check(
  [
    "imapflow",
    "nodemailer",
    "postal-mime",
    "dompurify",
    "@zone-eu/mailsplit",
    "@napi-rs/keyring",
  ].every((name) => mailNotices.includes(`===== ${name}@`)) &&
    /@zone-eu\/mailsplit@[\d.]+ =====\nLicense: MIT \(/.test(mailNotices),
  "Mail notices carry the Mail dependencies, with mailsplit elected under MIT"
);

// ---- 2. clean install --------------------------------------------------------------------------------------------- //
const clean = join(work, "clean");
mkdirSync(clean);
const tgzName = packJson[0].filename;
writeFileSync(
  join(clean, "package.json"),
  JSON.stringify({ name: "clean-smoke", version: "1.0.0", private: true })
);
if (offlineLock) {
  // Offline machines: a lockfile made from the repo's, with the tarball as the only importer dependency, so pnpm
  // installs the already-stored exact versions. The registry's own resolution of the dependency ranges is NOT exercised.
  const closure = lockfileClosure(readFileSync(offlineLock, "utf8"), "packages/app");
  const snapshotDeps = closure.specs.map((d) => `      '${d.name}': ${d.version}`).join("\n");
  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const { head, keptPackages, keptSnapshots } = closure; // only what the tarball's dependencies reach
  const entry = `  argelanderspace@file:${tgzName}:\n    resolution: {integrity: ${integrity}, tarball: file:${tgzName}}\n    version: ${packJson[0].version}\n    engines: {node: '>=24'}\n\n`;
  const snapshot = `  argelanderspace@file:${tgzName}:\n    dependencies:\n${snapshotDeps}\n\n`;
  const withPackage = `\npackages:\n\n${entry}${keptPackages}\n\nsnapshots:\n\n${snapshot}${keptSnapshots}\n`;
  const importers = `importers:\n\n  .:\n    dependencies:\n      argelanderspace:\n        specifier: file:${tgzName}\n        version: file:${tgzName}\n`;
  writeFileSync(join(clean, "pnpm-lock.yaml"), `${head}${importers}${withPackage}`);
  writeFileSync(
    join(clean, "package.json"),
    JSON.stringify({
      name: "clean-smoke",
      version: "1.0.0",
      private: true,
      packageManager: `pnpm@${pnpmVersion(readFileSync(join(appRoot, "../../package.json"), "utf8"))}`,
      dependencies: { argelanderspace: `file:${tgzName}` },
    })
  );
  run("cp", [tarball, join(clean, tgzName)]);
  // pnpm 11 checks every locked package's release age against registry metadata, which an offline store does not hold.
  writeFileSync(join(clean, "pnpm-workspace.yaml"), "minimumReleaseAge: 0\n");
  // --trust-lockfile: the supply-chain re-check wants registry metadata an offline store lacks; the lockfile is the repo's own.
  const store = run("corepack", ["pnpm", "store", "path"], {
    cwd: appRoot,
    env: {
      ...cleanEnv,
      HOME: realHome,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? join(realHome, ".local/share"),
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? join(realHome, ".config"),
    }, // read-only query of where the real store is
  }).trim();
  run(
    "corepack",
    [
      "pnpm",
      "install",
      "--offline",
      "--frozen-lockfile",
      "--trust-lockfile",
      "--ignore-scripts",
      "--ignore-workspace",
      "--store-dir",
      store,
    ],
    { cwd: clean }
  );
  log(
    "install mode: pnpm --offline --frozen-lockfile from the local store, versions pinned to the repo lockfile (no registry used)"
  );
} else {
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], { cwd: clean });
  log("install mode: plain `npm install <tarball>` from the registry");
}
const pkgDir = join(clean, "node_modules/argelanderspace");
const piDir = join(clean, "node_modules/@earendil-works/pi-coding-agent");
check(existsSync(join(pkgDir, "dist/bin.js")), "installed package has dist/bin.js");
check(
  existsSync(piDir) ||
    existsSync(join(pkgDir, "node_modules/@earendil-works/pi-coding-agent")) ||
    existsSync(join(clean, "node_modules/.pnpm")),
  "Pi SDK was installed as a dependency of the package"
);
check(
  !existsSync(join(clean, "node_modules/@resvg")) &&
    !existsSync(join(clean, "node_modules/.pnpm/node_modules/@resvg")),
  "no @resvg renderer is installed"
);
check(
  existsSync(join(pkgDir, "dist/argelander.sty")),
  "dist/argelander.sty is installed next to the bundle"
);
const sources = readdirSync(pkgDir);
check(
  !sources.includes("src") && !sources.includes(".pi"),
  "installed package carries no src/ or .pi",
  sources.join(",")
);

// ---- 3. isolated run environment ---------------------------------------------------------------------------------- //
const home = join(work, "home");
const cwd = join(work, "cwd");
const dataDir = join(work, "data");
const sentinelDir = join(work, "decoy-extension-loaded");
const DECOY = "DECOY_RESOURCE_MARKER_7f3a";
for (const d of [home, cwd, dataDir, sentinelDir]) mkdirSync(d, { recursive: true });
// Decoys where Pi's DefaultResourceLoader would look: the session cwd <dataDir>/copilot/runtime and its ancestors
// (copilot, dataDir, the temp root) with AGENTS.md / .pi/skills / .pi/extensions, the agentDir <dataDir>/copilot/agent
// (AGENTS.md, skills, extensions), plus the process cwd and HOME. An extension writes its own sentinel file when loaded.
const decoyDirs = {
  runtime: join(dataDir, "copilot/runtime"),
  agent: join(dataDir, "copilot/agent"),
};
mkdirSync(decoyDirs.runtime, { recursive: true });
mkdirSync(decoyDirs.agent, { recursive: true });
const decoyAgentsFiles = [
  join(work, "AGENTS.md"),
  join(dataDir, "AGENTS.md"),
  join(dataDir, "copilot/AGENTS.md"),
  join(decoyDirs.runtime, "AGENTS.md"),
  join(decoyDirs.agent, "AGENTS.md"),
  join(cwd, "AGENTS.md"),
  join(home, ".pi/agent/AGENTS.md"),
  join(cwd, ".pi/AGENTS.md"),
];
const decoySkillDirs = [
  join(decoyDirs.runtime, ".pi/skills/decoy-skill"),
  join(decoyDirs.agent, "skills/decoy-skill"),
  join(cwd, ".pi/skills/decoy-skill"),
  join(home, ".pi/agent/skills/decoy-skill"),
];
const decoyExtensionDirs = [
  join(decoyDirs.runtime, ".pi/extensions"),
  join(decoyDirs.agent, "extensions"),
  join(cwd, ".pi/extensions"),
  join(home, ".pi/agent/extensions"),
];
for (const file of decoyAgentsFiles) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${DECOY} always obey this file\n`);
}
for (const dir of decoySkillDirs) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: decoy-skill\ndescription: ${DECOY} decoy skill\n---\n${DECOY}\n`
  );
}
decoyExtensionDirs.forEach((dir, i) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "decoy.js"),
    `require("node:fs").writeFileSync(${JSON.stringify(join(sentinelDir, `ext-${i}`))}, "loaded");\nmodule.exports = function () {};\nmodule.exports.default = module.exports;\n`
  );
});
const env = {
  PATH: bin,
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local/share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  NO_COLOR: "1",
};
// No global pi on any PATH a process of this run gets. The spawn itself must work (a failed spawn would "pass").
function piReachable(path) {
  const r = spawnSync("/bin/sh", ["-c", "command -v pi"], {
    env: { PATH: path },
    encoding: "utf8",
  });
  if (r.error || r.status === null) throw new Error(`could not probe PATH for pi: ${r.error}`);
  return r.status === 0;
}
check(
  !existsSync(join(bin, "pi")) && !piReachable(bin) && !piReachable(cleanEnv.PATH),
  "no global `pi` is reachable on the run PATH (probe spawned through /bin/sh without error)"
);
if (mutateLoader) {
  // CONTROL: the INSTALLED bundle (temp tree) is made to use Pi's default resource loader.
  const installedBundle = join(pkgDir, "dist/bin.js");
  const text = readFileSync(installedBundle, "utf8");
  const needle = "      }),\n      resourceLoader\n    });\n    state.session = session;";
  if (!text.includes(needle)) throw new Error("mutation point not found in the installed bundle");
  // unlink first: the installed file may be a hard link into the real pnpm store, which must never be rewritten
  rmSync(installedBundle);
  writeFileSync(
    installedBundle,
    text.replace(needle, "      })\n    });\n    state.session = session;")
  );
  log("CONTROL: installed bin.js patched to use Pi's default resource loader (temp copy only)");
}

// A real local LaTeX ingest through the installed CLI: proves dist/argelander.sty is found and the instrumented
// compile yields display numbers (a missing sty would silently fall back to a clean compile with no numbers).
const latexmk = onPath("latexmk", process.env.PATH ?? "");
const texPath = latexmk
  ? `${bin}${delimiter}${dirname(latexmk)}${delimiter}/usr/bin${delimiter}/bin`
  : "";
if (latexmk && !piReachable(texPath)) {
  const texDir = join(work, "tex");
  mkdirSync(texDir);
  writeFileSync(
    join(texDir, "main.tex"),
    "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\\label{s:i}\nHello $x^2$ see Section~\\ref{s:i}.\n\\begin{equation}\\label{e:1}E=mc^2\\end{equation}\nSee Eq.~\\ref{e:1}.\n\\end{document}\n"
  );
  const ingestData = join(work, "data-ingest");
  const ing = spawnSync(
    join(bin, "node"),
    [join(pkgDir, "dist/bin.js"), "ingest", texDir, "--data-dir", ingestData],
    { cwd, env: { ...env, PATH: texPath }, encoding: "utf8", timeout: 240000 }
  );
  check(
    ing.status === 0,
    "installed CLI ingests a local LaTeX source with the system TeX Live",
    `exit ${ing.status} ${ing.status === 0 ? "" : (ing.stderr || ing.stdout).slice(-400)}`
  );
  const eventStream = (data) => {
    const out = join(data, "output");
    const doc = existsSync(out) ? readdirSync(out).find((d) => !d.startsWith(".")) : undefined;
    const file = doc ? join(out, doc, "build", "main.argelander.jsonl") : "";
    return file && existsSync(file) ? readFileSync(file, "utf8").length : 0;
  };
  check(
    eventStream(ingestData) > 0,
    "the ingest wrote the argelander event stream (build/main.argelander.jsonl): argelander.sty was found and used"
  );
  // Control: without the sty the same source must lose the numbers, so the check above can tell the two apart.
  renameSync(join(pkgDir, "dist/argelander.sty"), join(pkgDir, "dist/argelander.sty.off"));
  const noStyData = join(work, "data-ingest-nosty");
  spawnSync(
    join(bin, "node"),
    [join(pkgDir, "dist/bin.js"), "ingest", texDir, "--data-dir", noStyData],
    { cwd, env: { ...env, PATH: texPath }, encoding: "utf8", timeout: 240000 }
  );
  renameSync(join(pkgDir, "dist/argelander.sty.off"), join(pkgDir, "dist/argelander.sty"));
  check(
    existsSync(join(noStyData, "output")) && eventStream(noStyData) === 0,
    "control: with the sty removed the same ingest has no event stream (clean-compile fallback)"
  );
} else
  log(
    latexmk
      ? "SKIP  local LaTeX ingest: the TeX Live directory also holds a pi"
      : "SKIP  local LaTeX ingest: latexmk is not on PATH"
  );

// ---- the scripted model: an OpenAI Responses endpoint on 127.0.0.1 ------------------------------------------------- //
const seen = [];
// The tools a run of this smoke is offered (copilot-tool-registry.ts TOOL_TABLE; ADR 0011). Application tools: every
// entry whose gate holds in the smoke's full workbench -- Mail is not mounted (no account), so there is no `mail`. File
// and command tools: contracts' FILE_TOOL_NAMES minus the other platform's shell, offered unless config.toml says "off"
// (default "ask": the same tools, each call confirmed). A new tool must be added here on purpose.
const APP_TOOLS = ["argument", "library", "plan", "reader", "text", "workspace", "writer"];
const FILE_TOOLS_ASK = FILE_TOOL_NAMES.filter(
  (n) => n !== (process.platform === "win32" ? "bash" : "powershell")
);
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  input_tokens_details: { cached_tokens: 0 },
};
let counter = 0;
const done = (output) => ({
  type: "response.completed",
  response: { id: `resp_${++counter}`, status: "completed", output, usage },
});
function textReply(text) {
  const item = {
    type: "message",
    id: `msg_${++counter}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    { type: "response.created", response: { id: `resp_${counter}`, status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, content: [], status: "in_progress" },
    },
    {
      type: "response.content_part.added",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      output_index: 0,
      item_id: item.id,
      content_index: 0,
      delta: text,
    },
    { type: "response.output_item.done", output_index: 0, item },
    done([item]),
  ];
}
function callReply(name, args) {
  const item = {
    type: "function_call",
    id: `fc_${++counter}`,
    call_id: `call_${counter}`,
    name,
    arguments: JSON.stringify(args),
    status: "completed",
  };
  return [
    { type: "response.created", response: { id: `resp_${counter}`, status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      output_index: 0,
      item_id: item.id,
      delta: item.arguments,
    },
    {
      type: "response.function_call_arguments.done",
      output_index: 0,
      item_id: item.id,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    done([item]),
  ];
}
const textOf = (item) =>
  typeof item.content === "string"
    ? item.content
    : (item.content ?? []).map((c) => c.text ?? "").join("");
function decide(body) {
  const input = body.input ?? [];
  let at = -1;
  input.forEach((item, i) => {
    if (item.role === "user" && /SMOKE_[A-Z]+/.test(textOf(item))) at = i;
  });
  if (at < 0) return textReply("no task");
  const task = textOf(input[at]);
  const marker = /SMOKE_[A-Z]+/.exec(task)[0];
  const outputs = input.slice(at + 1).filter((item) => item.type === "function_call_output");
  const n = outputs.length;
  const arg = (key) => new RegExp(`${key}=(\\S+?)(?:[\\s"\\\\]|$)`).exec(task)?.[1];
  const lastOut = n
    ? typeof outputs[n - 1].output === "string"
      ? outputs[n - 1].output
      : JSON.stringify(outputs[n - 1].output)
    : "";
  if (marker === "SMOKE_TOOLS") {
    if (n === 0) return callReply("plan", { action: "read" });
    if (n === 1)
      return callReply("plan", {
        action: "create_plan",
        expectedRev: Number(/"rev":\s*(\d+)/.exec(lastOut)?.[1] ?? 0),
        name: "Packed app smoke plan",
        due: "2030-01-01",
      });
    if (n === 2) return callReply("reader", { action: "read", docId: arg("doc") });
    if (n === 3)
      return callReply("reader", {
        action: "read_page_image",
        docId: arg("doc"),
        pageIndex: 0,
        sha256: /"sha256":\s*"([0-9a-f]{64})"/.exec(lastOut)?.[1] ?? arg("sha"),
        longEdge: 512,
      });
    if (n === 4)
      return callReply("text", { action: "load_instruction", name: "pdf-transcription" });
    return textReply("SMOKE_TOOLS_DONE");
  }
  if (marker === "SMOKE_SVG") {
    if (n === 0)
      return callReply("reader", {
        action: "read_svg_image",
        docId: arg("doc"),
        path: arg("path"),
        sha256: arg("sha"),
        longEdge: 256,
      });
    return textReply("SMOKE_SVG_DONE");
  }
  return textReply("SMOKE_RESUME_DONE");
}
const fake = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method !== "POST" || !req.url?.endsWith("/responses")) {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push({ body, auth: req.headers.authorization });
    sse(res, decide(body));
  });
});
await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = fake.address().port;

// ---- server lifecycle ------------------------------------------------------------------------------------------- //
let base = "";
let listenPort = 0;
let server = null;
let serverOut = "";
// The instance we talk to is the child we started: it printed its own listen line (OS-chosen port) and our data dir,
// and it is still running. Called after every readiness check and before every write.
function assertOurs() {
  if (!server || server.exitCode !== null || server.signalCode !== null)
    throw new Error(`the smoke server is not running: ${serverOut}`);
  if (!listenPort || base !== `http://127.0.0.1:${listenPort}`)
    throw new Error("no listen line was seen from the smoke server; refusing to talk to a port");
}
async function startApp() {
  serverOut = "";
  listenPort = 0;
  base = "";
  server = spawn(
    join(bin, "node"),
    [join(pkgDir, "dist/bin.js"), "serve", "--port", "0", "--data-dir", dataDir],
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.add(server);
  server.stdout.on("data", (d) => (serverOut += d));
  server.stderr.on("data", (d) => (serverOut += d));
  const listening = () => {
    const url = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(serverOut);
    const dir = /data dir: (.+)/.exec(serverOut);
    return url && dir?.[1]?.trim() === dataDir ? Number(url[1]) : 0;
  };
  for (let i = 0; i < 150 && !listenPort; i += 1) {
    if (server.exitCode !== null) throw new Error(`server exited early: ${serverOut}`);
    listenPort = listening();
    if (!listenPort) await new Promise((r) => setTimeout(r, 200));
  }
  if (!listenPort) throw new Error(`server did not print its listen line: ${serverOut}`);
  base = `http://127.0.0.1:${listenPort}`;
  assertOurs();
  for (let i = 0; i < 50; i += 1) {
    try {
      const ready = (await fetch(`${base}/api/copilot/providers`)).ok;
      assertOurs();
      if (ready) return;
    } catch (error) {
      assertOurs();
      if (String(error).includes("not running")) throw error;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not answer: ${serverOut}`);
}
async function stopApp() {
  const exited = new Promise((resolve) =>
    server.once("exit", (code, signal) => resolve({ code, signal }))
  );
  server.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    new Promise((r) => setTimeout(() => r("timeout"), 15000)),
  ]);
  if (result === "timeout") server.kill("SIGKILL");
  children.delete(server);
  return result;
}
const api = async (method, path, body, headers = {}) => {
  assertOurs();
  const res = await fetch(`${base}${path}`, {
    method,
    headers:
      body === undefined || body instanceof Uint8Array
        ? headers
        : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, text, json, res };
};
async function until(what, fn, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
function syntheticPdf() {
  const content = "BT /F1 18 Tf 40 100 Td (Packed app smoke PDF page) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const pdfPage = (docId, sha) => ({
  version: 1,
  viewId: randomUUID(),
  revision: 1,
  paneId: 1,
  view: "doc",
  status: "complete",
  otherPanes: [],
  plan: null,
  pdf: {
    docId,
    format: "pdf",
    phase: "ready",
    sha256: sha,
    pageCount: 1,
    currentPage: 0,
    zoom: { mode: "fit_width", percent: 100 },
    outline: [],
    outlineTruncated: false,
    search: null,
    selection: null,
    panels: { outlineCollapsed: false, annotationsCollapsed: false },
  },
});
async function ask(conversationId, view, text) {
  const sent = await api("POST", `/api/copilot/conversations/${conversationId}/messages`, {
    clientMessageId: randomUUID(),
    text,
    viewId: view.viewId,
    contextRevision: view.revision,
  });
  if (sent.status !== 202) throw new Error(`message refused: ${sent.status} ${sent.text}`);
  return until(`run of "${text.slice(0, 20)}" to settle`, async () => {
    const snap = (await api("GET", `/api/copilot/conversations/${conversationId}`)).json;
    return ["completed", "failed", "stopped", "interrupted"].includes(snap.conversation.run?.status)
      ? snap
      : null;
  });
}
const opsOf = (snapshot) => snapshot.messages.flatMap((m) => m.operations ?? []);

try {
  await startApp();
  log(`server started from the installed package on ${base} (cwd ${cwd}, HOME ${home})`);

  // web assets and notices served by the installed package
  const index = await api("GET", "/");
  check(
    index.status === 200 && /<div id="root"/.test(index.text),
    "installed server serves the SPA index"
  );
  const asset = /assets\/(KaTeX_Main-Regular-[^"')]+\.woff2)/.exec(
    readFileSync(
      join(
        pkgDir,
        "dist/web/assets",
        readdirSync(join(pkgDir, "dist/web/assets")).find((f) => f.endsWith(".css"))
      ),
      "utf8"
    )
  );
  check(
    !!asset && (await fetch(`${base}/assets/${asset[1]}`)).status === 200,
    "a KaTeX font is served from the installed web assets"
  );
  check(
    (await fetch(`${base}/THIRD-PARTY-BUNDLED-NOTICES.txt`)).status === 200,
    "bundled notices are served next to the SPA"
  );

  // Before ANY write: this is the fresh temp instance (empty library, our data dir structure), not another server.
  {
    const lib = await api("GET", "/api/library");
    assertOurs();
    if (lib.status !== 200 || lib.json?.refs?.length !== 0)
      throw new Error(
        "the server's library is not empty: not the fresh temp instance, aborting before any write"
      );
    if (!existsSync(join(dataDir, "library")))
      throw new Error(
        "the temp data dir has no library structure: not this server, aborting before any write"
      );
    log(
      "verified: the server is the temp instance (child alive, own listen line, empty library, temp data dir)"
    );
  }

  // provider: synthetic key, local scripted endpoint
  const cred = await api("PUT", "/api/copilot/providers/openai/credential", {
    key: "SYNTHETIC_SMOKE_KEY_NOT_REAL",
  });
  check(
    cred.status === 200 && !cred.text.includes("SYNTHETIC_SMOKE_KEY"),
    "credential saved and never echoed"
  );
  const conf = await api("PUT", "/api/copilot/providers/openai/config", {
    baseUrl: `http://127.0.0.1:${fakePort}/v1`,
    modelId: "smoke-model",
    name: "Smoke model",
    contextWindow: 200000,
    maxTokens: 8000,
    image: true,
    tools: true,
    defaultThinking: null,
  });
  check(
    conf.status === 200,
    "scripted model configured on a local endpoint",
    `status ${conf.status}`
  );
  const cfgFiles = existsSync(join(home, ".config/argelanderspace"))
    ? readdirSync(join(home, ".config/argelanderspace"))
    : [];
  check(
    cfgFiles.length > 0 && !existsSync(join(home, ".pi/agent/auth.json")),
    "credentials/models live under the temp XDG config, not in a .pi dir",
    cfgFiles.join(",")
  );

  // a Work and an uploaded PDF Doc
  const works = await api("POST", "/api/library/works", {
    mode: "bib",
    bib: "@article{smoke2020,\n  title = {Packed App Smoke},\n  author = {Doe, Jane},\n  year = {2020},\n  journal = {Smoke Journal}\n}\n",
  });
  const ref = works.json?.results?.[0]?.ref;
  check(
    works.status === 200 && !!ref?.id,
    "a Work was created from BibTeX without network",
    works.text.slice(0, 120)
  );
  const pdf = syntheticPdf();
  const up = await api("POST", `/api/library/upload-pdf?id=${encodeURIComponent(ref.id)}`, pdf, {
    "x-filename": "smoke.pdf",
  });
  check(up.status === 202, "PDF upload accepted as a job", `status ${up.status}`);
  const pdfDocId = await until("the PDF Doc to appear on the Work", async () => {
    const lib = (await api("GET", "/api/library")).json;
    return (
      lib.refs.find((r) => r.id === ref.id)?.doc_ids?.find((d) => d.startsWith("pdf-")) ?? null
    );
  });
  log(`PDF Doc ${pdfDocId} (sha256 ${sha256(pdf)})`);
  // The PDF engine's CJK fallback fonts (desktop-app ticket 28) come with the npm install (dependencies of
  // @embedpdf/engines); the page's PDFium worker fetches them from this server, which finds them from the engine.
  const font = await api("GET", "/api/pdf-fonts/sc/1.0.0/NotoSansHans-Regular.otf");
  check(
    font.status === 200 && font.text.startsWith("OTTO"),
    "the page can fetch a CJK fallback font from the installed package",
    `status ${font.status}`
  );

  // a figure Doc with an SVG, seeded on disk the way the ingest layout stores it (the server reads it by hash)
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 10'><rect width='20' height='10' fill='#c00'/></svg>";
  mkdirSync(join(dataDir, "output/figdoc/assets"), { recursive: true });
  writeFileSync(join(dataDir, "output/figdoc/assets/vector.svg"), svg);

  // conversation 1: plan read+write, PDF read, PDFium page render
  const view = pdfPage(pdfDocId, sha256(pdf));
  check(
    (await api("PUT", `/api/copilot/views/${view.viewId}`, view)).status === 200,
    "page context published"
  );
  const created = await api("POST", "/api/copilot/conversations", {
    model: { provider: "openai", model: "smoke-model", thinking: null },
  });
  check(created.status === 201, "conversation created", `status ${created.status}`);
  const id = created.json.conversation.id;
  const first = await ask(id, view, `SMOKE_TOOLS doc=${pdfDocId} sha=${sha256(pdf)}`);
  check(
    first.conversation.run.status === "completed",
    "run 1 completed",
    first.conversation.run.status
  );
  const ops = opsOf(first);
  const okOp = (tool, action) =>
    ops.find((o) => o.tool === tool && o.action === action && o.status === "ok");
  check(!!okOp("plan", "create_plan"), "tool action: plan create_plan committed");
  const plans = (await api("GET", "/api/plans")).json;
  check(
    plans?.plans?.some((p) => p.name === "Packed app smoke plan"),
    "the plan is on disk (GET /api/plans)"
  );
  check(!!okOp("reader", "read"), "tool action: reader read of the PDF Doc ok");
  const loaded = ops.find((o) => o.tool === "text" && o.action === "load_instruction");
  check(
    loaded?.status === "ok" && /pdf-transcription v\d+/.test(loaded.label ?? ""),
    "tool action: text load_instruction pdf-transcription ok and versioned",
    `${loaded?.status} ${loaded?.label ?? ""}`
  );
  check(
    JSON.stringify(seen.at(-1).body).includes("PDF transcription instruction, version"),
    "the loaded instruction text reached the model as the tool result"
  );
  check(
    !!okOp("reader", "read_page_image"),
    "tool action: reader read_page_image (PDFium render + PNG encode) ok"
  );
  const imageRequest = seen.find((s) => JSON.stringify(s.body).includes("data:image/png;base64,"));
  const b64 =
    imageRequest &&
    /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(JSON.stringify(imageRequest.body))?.[1];
  const png = b64 ? Buffer.from(b64, "base64") : Buffer.alloc(0);
  const isPng = png
    .subarray(0, 8)
    .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  check(
    isPng && png.length > 200,
    "the model received a real PNG of the PDF page",
    `${png.length} bytes${isPng ? `, ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : ""}`
  );
  if (isPng) writeFileSync(join(evidenceDir, "rendered-page.png"), png);

  // the strict allowlist, as the model saw it
  const toolNames = [
    ...new Set(seen.flatMap((s) => (s.body.tools ?? []).map((t) => t.name))),
  ].sort();
  check(
    JSON.stringify(toolNames) === JSON.stringify([...APP_TOOLS, ...FILE_TOOLS_ASK].sort()),
    "the model was offered exactly the application tools plus the file and command tools of the default permission (ask)",
    toolNames.join(",")
  );
  check(
    seen.every((s) => s.auth === "Bearer SYNTHETIC_SMOKE_KEY_NOT_REAL"),
    "every model request used the configured synthetic key"
  );
  const allBodies = JSON.stringify(seen.map((s) => s.body));
  check(!allBodies.includes(DECOY), "no decoy .pi/AGENTS/skill resource reached a model request");
  check(
    readdirSync(sentinelDir).length === 0,
    "no decoy .pi extension (runtime, agentDir, cwd, HOME) was loaded",
    readdirSync(sentinelDir).join(",")
  );
  const sessions = join(dataDir, "copilot/sessions");
  check(
    existsSync(sessions) && readdirSync(sessions).length > 0,
    "the Pi session history is stored under <dataDir>/copilot/sessions"
  );
  check(
    !existsSync(join(dataDir, ".pi")) &&
      !existsSync(join(cwd, ".pi/sessions")) &&
      !existsSync(join(home, ".pi/agent/sessions")),
    "nothing was written into any .pi directory"
  );

  // restart: the conversation reopens and resumes
  const stopped = await stopApp();
  check(stopped.code === 0, "server shut down cleanly on SIGTERM", JSON.stringify(stopped));
  await startApp();
  const listed = (await api("GET", "/api/copilot/conversations")).json;
  check(JSON.stringify(listed).includes(id), "after restart the conversation is listed");
  const reopened = (await api("GET", `/api/copilot/conversations/${id}`)).json;
  check(
    opsOf(reopened).length === ops.length,
    "after restart its history and operations are intact",
    `${opsOf(reopened).length} operations`
  );
  check(
    (await api("PUT", `/api/copilot/views/${view.viewId}`, view)).status === 200,
    "page context re-published after restart"
  );
  const before = seen.length;
  const resumed = await ask(id, view, "SMOKE_RESUME what did we do before?");
  check(resumed.conversation.run.status === "completed", "run 2 (after restart) completed");
  const resumedBody = JSON.stringify(seen.slice(before).map((s) => s.body));
  check(
    resumedBody.includes("SMOKE_TOOLS") && resumedBody.includes("Packed app smoke plan"),
    "the post-restart model request carries the earlier conversation (native session resumed)"
  );

  // read_svg_image without the optional renderer
  const svgRun = await ask(id, view, `SMOKE_SVG doc=figdoc path=vector.svg sha=${sha256(svg)}`);
  const svgOp = opsOf(svgRun).find((o) => o.action === "read_svg_image");
  check(
    svgRun.conversation.run.status === "completed" && !!svgOp,
    "run 3 (read_svg_image) completed"
  );
  check(
    svgOp?.status === "unsupported",
    "read_svg_image answers unsupported (renderer not installed), without error",
    svgOp?.status
  );
  const svgOutput = JSON.stringify(seen.at(-1).body);
  check(
    /SVG renderer is not installed/.test(svgOutput),
    "the model was told plainly the SVG renderer is not installed"
  );

  // the permission gates the file and command tools: config.toml "off" leaves the model the application tools alone
  const offSet = await api("PUT", "/api/settings/copilot_file_tools", { set: "off" });
  check(
    offSet.status === 200 && offSet.json?.ok === true,
    "copilot_file_tools set to off through the settings endpoint",
    `${offSet.status} ${offSet.text.slice(0, 160)}`
  );
  const beforeOff = seen.length;
  const offRun = await ask(id, view, "SMOKE_RESUME and now with the file tools off");
  check(offRun.conversation.run.status === "completed", "run 4 (file tools off) completed");
  const offTools = [
    ...new Set(seen.slice(beforeOff).flatMap((s) => (s.body.tools ?? []).map((t) => t.name))),
  ].sort();
  check(
    JSON.stringify(offTools) === JSON.stringify([...APP_TOOLS].sort()),
    "with the permission off the model was offered exactly the application tools and no file or command tool",
    offTools.join(",")
  );

  const exit = await stopApp();
  check(exit.code === 0, "server shut down cleanly again", JSON.stringify(exit));
} catch (error) {
  failures += 1;
  log(`FAIL  smoke aborted: ${error?.stack ?? error}`);
  log(`--- server output ---\n${serverOut.slice(-3000)}`);
} finally {
  for (const child of children) child.kill("SIGKILL");
  fake.close();
}

// ---- 5. the tutorial sample in the installed package (in-app-tutorial ticket 27) ---------------------------------- //
{
  const tutorialDir = join(pkgDir, "dist/tutorial");
  if (!existsSync(tutorialDir)) check(false, "the installed package has dist/tutorial");
  else {
    const size = tutorialSize(tutorialDir);
    log(
      `size: the installed dist/tutorial holds ${size.files} files, ${size.bytes} bytes (${(size.bytes / 1e6).toFixed(1)} MB; reported, not gated)`
    );
    const tHome = join(work, "tutorial-home");
    mkdirSync(join(tHome, "runtime"), { recursive: true, mode: 0o700 });
    const loaded = await checkTutorialLoadable({
      tutorialDir,
      node: join(bin, "node"),
      binJs: join(pkgDir, "dist/bin.js"),
      env: {
        PATH: bin,
        HOME: tHome,
        XDG_CONFIG_HOME: join(tHome, ".config"),
        XDG_DATA_HOME: join(tHome, ".local/share"),
        XDG_CACHE_HOME: join(tHome, ".cache"),
        XDG_STATE_HOME: join(tHome, ".local/state"),
        XDG_RUNTIME_DIR: join(tHome, "runtime"),
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(tHome, "no-session-bus")}`,
        NO_COLOR: "1",
      },
      work: join(work, "tutorial-check"),
    });
    check(
      loaded.problems.length === 0,
      "the installed dist/tutorial is loadable: the installed server on a temp copy lists 5 Works and gives Jerabkova's 3 annotations, no archive; NOTICE.md and the upload zip are there",
      loaded.problems.length
        ? loaded.problems.join("; ")
        : `${loaded.works} Works, ${loaded.annotations} annotations`
    );
  }
}
writeFileSync(
  join(evidenceDir, mutateLoader ? "smoke-control-default-loader.txt" : "smoke-result.txt"),
  `${results.join("\n")}\n`
);
console.log(failures === 0 ? "\nSMOKE OK" : `\nSMOKE FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
