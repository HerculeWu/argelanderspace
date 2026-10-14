// The version has one source (desktop-app ticket 16): the `version` of the app package (packages/app/package.json,
// published as `argelanderspace`). This build step writes it into the CLI's source as `src/generated/app-version.ts`
// (git-ignored, never edited by hand); the CLI's `--version`, the `serve` start record and the diagnostics report all
// take it from there, and the app bundle inlines it with the rest of the CLI. To change the version, change it in
// packages/app/package.json and rebuild.
//
//   node scripts/app-version.mjs [--package <package.json>] [--out <file>]
//
// Run by the CLI package's build, pretest and typecheck scripts. A package without a usable version stops the build
// (exit 1) and writes nothing; an unchanged module is not rewritten.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};
const packagePath = flag(
  "--package",
  fileURLToPath(new URL("../../app/package.json", import.meta.url))
);
const out = flag(
  "--out",
  fileURLToPath(new URL("../src/generated/app-version.ts", import.meta.url))
);

function fail(message) {
  process.stderr.write(`app-version: ${message}\n`);
  process.exit(1);
}

// x.y.z with an optional pre-release and build part (semver's shape, without its finer rules).
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

let version;
try {
  version = JSON.parse(readFileSync(packagePath, "utf8")).version;
} catch (error) {
  fail(`cannot read the version of ${packagePath} (${error?.code ?? error?.name ?? "error"})`);
}
if (typeof version !== "string" || !SEMVER.test(version)) {
  fail(`${packagePath} has no version of the form x.y.z`);
}

const text =
  "// Generated from packages/app/package.json by packages/cli/scripts/app-version.mjs at build time.\n" +
  "// Not tracked, not edited by hand: change the version in packages/app/package.json and rebuild.\n" +
  `export const APP_VERSION = ${JSON.stringify(version)};\n`;

let current = null;
try {
  current = readFileSync(out, "utf8");
} catch {
  /* not generated yet */
}
if (current !== text) {
  mkdirSync(dirname(out), { recursive: true });
  const tmp = `${out}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, out);
}
