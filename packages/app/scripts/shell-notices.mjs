#!/usr/bin/env node
// The license notices of the Rust crates linked into the desktop shell (desktop-app ticket 26; the user's decision in
// ticket 23: the shell's crate licenses go into every platform's package). NOT part of the four gates: it needs cargo
// and the crates' sources (cargo's registry cache, filled by any build of packages/desktop); its pure rules are in
// desktop-package-lib.mjs (`linkedCrates`, `shellNotices`), tested by desktop-package.test.mjs. No new tool: it reads
// `cargo metadata`, which comes with cargo.
//
//   node packages/app/scripts/shell-notices.mjs --out <file> [--target linux-x64|darwin-arm64|darwin-x64|win32-x64]
//        [--offline]
//
//   --target   default: this machine. The crates are those of the shell built for that target with the `packaged`
//              feature (the build the package carries): `cargo metadata --filter-platform <triple> --features packaged`.
//   --offline  passed to cargo (no index update; the crates must be in the local cache).
//
// Every linked crate (normal dependencies from the shell, not build-only or dev-only ones) needs a license on the
// production allowlist (scripts/license-allowlist.mjs, the one list) and a license file of its own in its source; the
// notice is each crate's name, version, license expression and the full text of its license files. Any crate without
// both is reported and NOTHING is written (exit 1): the package must not go out without its notices.
//
// Exit: 0 written; 1 a problem (listed) or cargo failed.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LICENSE_FILE,
  linkedCrates,
  parseStrictArgs,
  rustTargetTriple,
  shellNotices,
} from "./desktop-package-lib.mjs";

const desktopRoot = fileURLToPath(new URL("../../desktop/", import.meta.url));
let args;
try {
  args = parseStrictArgs(process.argv.slice(2), {
    valued: ["--out", "--target"],
    flags: ["--offline"],
  });
} catch (e) {
  console.error(`shell-notices: ${e.message}`);
  process.exit(1);
}
const out = args.values["--out"];
if (!out) {
  console.error("shell-notices: --out <file> is required");
  process.exit(1);
}
const target = args.values["--target"] ?? `${process.platform}-${process.arch}`;
const triple = rustTargetTriple(target);
const m = spawnSync(
  "cargo",
  [
    "metadata",
    "--format-version",
    "1",
    "--locked",
    "--features",
    "packaged",
    "--filter-platform",
    triple,
    ...(args.flags.has("--offline") ? ["--offline"] : []),
  ],
  { cwd: desktopRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }
);
if (m.error || m.status !== 0) {
  console.error(`shell-notices: cargo metadata failed: ${m.error ?? m.stderr.slice(-2000)}`);
  process.exit(1);
}
const crates = linkedCrates(JSON.parse(m.stdout)).map((p) => {
  const dir = dirname(p.manifest_path);
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) || /^unlicense(\.|$)/i.test(f))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();
  return {
    name: p.name,
    version: p.version,
    license: p.license ?? null,
    texts: files.map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8") })),
  };
});
const { problems, text } = shellNotices(crates);
for (const p of problems) console.error(`LICENSE ${p}`);
console.log(
  `shell-notices: ${crates.length} crates linked into the shell for ${target} (${triple}); ${problems.length} problem(s)`
);
if (problems.length > 0) {
  console.error(
    "shell-notices: nothing written (every linked crate needs an allowed license and a text)"
  );
  process.exit(1);
}
mkdirSync(dirname(resolve(out)), { recursive: true });
writeFileSync(resolve(out), text);
console.log(`shell-notices: wrote ${resolve(out)}`);
