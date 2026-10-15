#!/usr/bin/env node
// The release workflow's first step on every runner (desktop-app ticket 26; .github/workflows/release.yml). Fails
// before anything is built when the run cannot make a correct package:
//   - a tag run whose tag is not `v` + the app package's version (packages/app/package.json, the single source of
//     ticket 16): the tag rule;
//   - the build machine's Node is not the release the desktop package carries (DESKTOP_NODE_VERSION), so the build and
//     the packaged runtime are one Node;
//   - the target's keychain package has no vendored license text for its lockfile version (it ships none; the
//     package's license check would fail closed only after a long build).
//
//   node packages/app/scripts/release-preflight.mjs --target <t> [--ref <git ref>]
//
//   --ref   GITHUB_REF of a tag run (refs/tags/v0.1.0); omitted for a manual run, which builds the chosen commit and
//           names the draft `v<version>` without a tag of its own (the tag is made only when the draft is published).
//
// Prints the version; with GITHUB_OUTPUT set, also writes `version=` and `tag=` lines there. Exit: 0 fine; 1 a problem.
import { appendFileSync, readFileSync } from "node:fs";
import {
  DESKTOP_NODE_VERSION,
  parseStrictArgs,
  preflightProblems,
  releaseTagFor,
  releaseTagProblem,
} from "./desktop-package-lib.mjs";

let args;
try {
  args = parseStrictArgs(process.argv.slice(2), { valued: ["--target", "--ref"] });
  if (!args.values["--target"]) throw new Error("--target is required");
} catch (e) {
  console.error(`release-preflight: ${e.message}`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const problems = [];
if (args.values["--ref"] !== undefined) {
  const p = releaseTagProblem(args.values["--ref"], version);
  if (p) problems.push(p);
}
if (process.version !== `v${DESKTOP_NODE_VERSION}`)
  problems.push(
    `the build runs on Node ${process.version}; the desktop package carries v${DESKTOP_NODE_VERSION} (desktop-package-lib.mjs): use that one`
  );
problems.push(
  ...preflightProblems({
    target: args.values["--target"],
    lockText: readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"),
    manifest: JSON.parse(
      readFileSync(new URL("../licenses/runtime-licenses.json", import.meta.url), "utf8")
    ),
  })
);
for (const p of problems) console.error(`PREFLIGHT ${p}`);
if (problems.length > 0) process.exit(1);
console.log(`release-preflight: ${args.values["--target"]} ${releaseTagFor(version)} ok`);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${releaseTagFor(version)}\n`);
