// Post-bundle asset step (decision 22):
//  - the built SPA (packages/web/dist) is copied to dist/web — the server's
//    import.meta-relative web-dist candidate finds it there in the packed
//    layout;
//  - the root README.md / LICENSE are copied to the package root because npm
//    only auto-includes them from there (both are git-ignored here).
// The @argelanderspace/web devDependency exists purely so `pnpm -r build`
// builds the SPA before this package.
import { copyFileSync, cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const webDist = join(repoRoot, "packages", "web", "dist");
if (!existsSync(webDist)) {
  throw new Error("packages/web/dist is missing — build @argelanderspace/web first");
}
const target = join(appRoot, "dist", "web");
rmSync(target, { recursive: true, force: true });
cpSync(webDist, target, { recursive: true });

for (const name of ["README.md", "LICENSE"]) {
  copyFileSync(join(repoRoot, name), join(appRoot, name));
}
console.log("copied dist/web + README.md + LICENSE into packages/app");
