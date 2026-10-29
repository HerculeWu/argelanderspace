// `prepack` guard (ticket 31): `npm pack` and `npm publish` fail closed when the REAL pack list breaks the content policy
// in pack-contents.mjs (a missing asset or notice, or a file that must never ship). It asks npm for the list with a dry
// run that skips lifecycle scripts, so it cannot recurse into itself, and writes nothing.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkAgentPluginIn, checkPackContents } from "./pack-contents.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const r = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: appRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (r.error || r.status !== 0) {
  console.error(`prepack check: could not list the package contents: ${r.error ?? r.stderr}`);
  process.exit(1);
}
const problems = [
  ...checkPackContents(JSON.parse(r.stdout)[0].files.map((f) => f.path)),
  ...checkAgentPluginIn(appRoot.replace(/[\\/]$/, "")),
];
if (problems.length > 0) {
  console.error(
    `prepack check: the package does not satisfy the content policy:\n  ${problems.join("\n  ")}`
  );
  process.exit(1);
}
console.error("prepack check: package contents satisfy the policy");
