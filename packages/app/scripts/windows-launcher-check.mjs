#!/usr/bin/env node
// The command-line launcher on a real Windows (desktop-app ticket 26, carried over from ticket 24): run by the release
// workflow's Windows job, never on the other platforms (exit 2 there). NOT part of the four gates. Needs
// `corepack pnpm -r build` (it uses packages/infra/dist/cli-launcher.js, the code the host runs).
//
//   node packages/app/scripts/windows-launcher-check.mjs [--keep]
//
// Everything happens under a temp directory: a fake user folder whose name has Chinese characters and `! ^ ) &` (a
// Chinese user name; the path characters cmd treats specially), %LOCALAPPDATA% / %USERPROFILE% pointing into it for the
// launcher's own processes only (the real environment and the real user folders are never touched), a copy of this
// Node as the "app's" node.exe and a small bin.js that prints its arguments. It checks:
//   1. the installed .cmd is ASCII and names the paths through %LOCALAPPDATA%;
//   2. run through cmd with the console code page at 437, 936 and 65001, it runs the app's Node on the app's bin.js
//      with the arguments as given and its exit code (a code page the machine cannot switch to is reported untested);
//   3. the counter-check: the same script with the UTF-8 path written in literally (the ticket 24 form) does NOT run
//      under 437 or 936 (if it did, check 2 would prove nothing) -- each only where that code page could be set (a
//      `chcp` that fails stops the run as well, which would look like the expected failure); and its control: the
//      literal script DOES run under 65001, so its failure elsewhere is the encoding and not some other fault;
//   4. app moved: the launcher exits 1 and names the missing file;
//   5. the known limit of ticket 24, observed and reported (not a failure either way): a program that starts
//      `argelanderspace` by bare name without a shell (Node's spawn without `shell`) does not find the .cmd, and
//      Node refuses to start a .cmd without a shell at all; through a shell (`shell: true`) it works.
//
// Exit: 0 `CHECK OK`; 1 `CHECK FAILED`; 2 not Windows (nothing was run); 3 `CHECK INCOMPLETE`: none of the three code
// pages could be set, so neither the launcher under them nor the counter-check was run.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform !== "win32") {
  console.log("windows-launcher-check: not Windows; nothing run");
  process.exit(2);
}
const keep = process.argv.includes("--keep");
const { installCliLauncher, cliLauncherFile } = await import(
  new URL("../../infra/dist/cli-launcher.js", import.meta.url).href
);

const work = mkdtempSync(join(tmpdir(), "as-launcher-"));
const home = join(work, "Users", "张三 !^)&x");
const local = join(home, "AppData", "Local");
const appDir = join(local, "ArgelanderSpace", "sidecar");
mkdirSync(join(appDir, "node"), { recursive: true });
mkdirSync(join(appDir, "app", "dist"), { recursive: true });
const node = join(appDir, "node", "node.exe");
const cli = join(appDir, "app", "dist", "bin.js");
copyFileSync(process.execPath, node);
writeFileSync(
  cli,
  "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), execPath: process.execPath }));\nprocess.exit(7);\n"
);
const env = { ...process.env, LOCALAPPDATA: local, USERPROFILE: home };
const opts = { platform: "win32", home, env };

let failures = 0;
const untested = [];
const check = (ok, what, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` -- ${detail}` : ""}`);
};
const info = (what) => console.log(`INFO  ${what}`);

const r = installCliLauncher({ node, cli }, opts);
const file = cliLauncherFile(opts);
const text = readFileSync(file, "utf8");
check(r.outcome === "installed", "the launcher is installed", r.outcome);
check(
  [...text].every((c) => c.charCodeAt(0) < 0x80) &&
    text.includes('set "AS_NODE=%LOCALAPPDATA%\\ArgelanderSpace'),
  "the .cmd is ASCII and names the app through %LOCALAPPDATA%"
);

const args = ["a b", "c&d", "中文"];
/** Runs `<cmd file> args` through cmd after `chcp <cp>`; null when the code page cannot be set. */
function runAt(cp, cmdFile) {
  const quoted = args.map((a) => `"${a}"`).join(" ");
  const s = spawnSync(`chcp ${cp} >nul && "${cmdFile}" ${quoted}`, {
    shell: true,
    env,
    encoding: "utf8",
    timeout: 60000,
  });
  return s;
}
/** The code pages `chcp` could set here (in a process without a console it may not). */
const settable = new Set();
for (const cp of [437, 936, 65001]) {
  const probe = spawnSync(`chcp ${cp}`, { shell: true, encoding: "utf8" });
  if (probe.status !== 0) {
    untested.push(`code page ${cp}`);
    console.log(`UNTESTED  code page ${cp}: chcp exited ${probe.status}`);
    continue;
  }
  settable.add(cp);
  const s = runAt(cp, file);
  let out = null;
  try {
    out = JSON.parse(s.stdout);
  } catch {}
  check(
    s.status === 7 && out?.execPath?.toLowerCase() === node.toLowerCase(),
    `code page ${cp}: the launcher runs the app's Node on its bin.js and passes the exit code`,
    `exit ${s.status}; stdout ${JSON.stringify(s.stdout).slice(0, 300)}; stderr ${JSON.stringify(s.stderr).slice(0, 300)}`
  );
  // Arguments outside ASCII go through cmd's own command line; recorded, not judged (cmd, not the launcher).
  if (out)
    info(
      `code page ${cp}: arguments arrived as ${JSON.stringify(out.argv)} (sent ${JSON.stringify(args)})`
    );
}

// Counter-check: the literal UTF-8 path (what ticket 24 wrote). Only under a code page `chcp` could set: otherwise the
// run stops at `chcp`, which would look like the expected failure.
const literal = join(work, "literal.cmd");
writeFileSync(literal, text.replaceAll("%LOCALAPPDATA%", local));
for (const cp of [437, 936]) {
  if (!settable.has(cp)) {
    untested.push(`counter-check at code page ${cp}`);
    console.log(`UNTESTED  counter-check at code page ${cp}: chcp could not set it`);
    continue;
  }
  const s = runAt(cp, literal);
  check(
    s.status !== 7,
    `counter-check, code page ${cp}: the literal UTF-8 path does not run (so the check above means something)`,
    `exit ${s.status}`
  );
}
// Its control: the same literal script runs where cmd reads UTF-8, so the counter-check's failure is the encoding.
if (settable.has(65001)) {
  const s = runAt(65001, literal);
  check(
    s.status === 7,
    "control, code page 65001: the literal UTF-8 script runs (it is not broken otherwise)",
    `exit ${s.status}; stderr ${JSON.stringify(s.stderr).slice(0, 300)}`
  );
} else {
  untested.push("the counter-check's control at code page 65001");
  console.log("UNTESTED  the counter-check's control at code page 65001: chcp could not set it");
}

// Bare-name start without a shell (the known limit), observed and reported.
const binDir = join(local, "Programs", "argelanderspace", "bin");
const pathEnv = { ...env, PATH: `${binDir};${process.env.PATH}` };
const bare = spawnSync("argelanderspace", ["--x"], { env: pathEnv, encoding: "utf8" });
info(
  `spawn("argelanderspace") without a shell: ${bare.error ? bare.error.code : `exit ${bare.status}`}`
);
let direct;
try {
  direct = spawnSync(file, ["--x"], { env: pathEnv, encoding: "utf8" });
} catch (e) {
  direct = { error: e };
}
info(
  `spawn(<full path of the .cmd>) without a shell: ${direct.error ? direct.error.code : `exit ${direct.status}`}`
);
const viaShell = spawnSync("argelanderspace", ["--x"], {
  env: pathEnv,
  encoding: "utf8",
  shell: true,
});
check(
  viaShell.status === 7,
  'spawn("argelanderspace", { shell: true }) finds and runs the .cmd',
  `exit ${viaShell.status}`
);

// The app moved away.
renameSync(join(local, "ArgelanderSpace"), join(local, "Moved"));
// In the console's own code page (no chcp): the paths it reads are ASCII, so any code page will do.
const moved = spawnSync(`"${file}" --x`, { shell: true, env, encoding: "utf8", timeout: 60000 });
check(
  moved.status === 1 && /is missing/.test(moved.stderr),
  "after the app moved: exit 1 and the missing file is named",
  `exit ${moved.status}; stderr ${JSON.stringify(moved.stderr).slice(0, 300)}`
);

if (keep) console.log(`kept ${work}`);
else rmSync(work, { recursive: true, force: true });
const incomplete = settable.size === 0;
const line = failures
  ? `CHECK FAILED (${failures})`
  : incomplete
    ? `CHECK INCOMPLETE (no code page could be set; untested: ${untested.join(", ")})`
    : `CHECK OK${untested.length ? ` (untested: ${untested.join(", ")})` : ""}`;
console.log(`\n${line}`);
process.exit(failures ? 1 : incomplete ? 3 : 0);
