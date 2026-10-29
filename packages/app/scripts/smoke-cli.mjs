#!/usr/bin/env node
// The CLI end-to-end smoke (release-0.2 ticket 15, cli-e2e-lib.mjs) on the repository's own build, without packing:
//
//   corepack pnpm -r build && node packages/app/scripts/smoke-cli.mjs [--bin <bin.js>] [--evidence <dir>] [--keep]
//
// smoke-pack.mjs runs the same checks on the packed-and-installed package (its section 7); use that for the release
// check. Everything runs in a temp tree (HOME/XDG, data copies, synthetic files); no network leaves the machine.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCliE2E } from "./cli-e2e-lib.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const binJs = flag("--bin") ?? join(appRoot, "dist/bin.js");
const evidenceDir = flag("--evidence");
if (evidenceDir) mkdirSync(evidenceDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "argelander-cli-e2e-"));
let failures = 0;
const check = (ok, what, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? ` -- ${detail}` : ""}`);
};
const bin = join(work, "bin");
mkdirSync(bin);
const found = (process.env.PATH ?? "")
  .split(delimiter)
  .map((d) => join(d, "node"))
  .find(existsSync);
symlinkSync(found, join(bin, "node"));
const latexmk = (process.env.PATH ?? "")
  .split(delimiter)
  .map((d) => join(d, "latexmk"))
  .find(existsSync);
const texPath = latexmk
  ? `${bin}${delimiter}${dirname(latexmk)}${delimiter}/usr/bin${delimiter}/bin`
  : undefined;
const piOnTexPath =
  texPath && spawnSync("/bin/sh", ["-c", "command -v pi"], { env: { PATH: texPath } }).status === 0;
try {
  await runCliE2E({
    node: join(bin, "node"),
    binJs,
    tutorialDir: join(dirname(binJs), "tutorial"),
    skillsDir: join(dirname(binJs), "skills"),
    work,
    evidenceDir,
    pathEnv: bin,
    texPath: piOnTexPath ? undefined : texPath,
    check,
    log: console.log,
  });
} finally {
  if (!argv.includes("--keep")) rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
console.log(failures === 0 ? "\nCLI E2E OK" : `\nCLI E2E FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
