// Post-bundle asset step (decision 22):
//  - the built SPA (packages/web/dist) is copied to dist/web — the server's
//    import.meta-relative web-dist candidate finds it there in the packed
//    layout;
//  - packages/infra/src/tex/argelander.sty is copied to dist/ next to the
//    bundle — tsup inlines infra's instrument.ts into bin.js, so its
//    `new URL("./argelander.sty", import.meta.url)` resolves to
//    dist/argelander.sty (MS4 checkpoint; missing asset = silent
//    clean-compile fallback that loses the event stream);
//  - the root README.md / LICENSE are copied to the package root because npm
//    only auto-includes them from there (both are git-ignored here).
// The @argelanderspace/web devDependency exists purely so `pnpm -r build`
// builds the SPA before this package.
import {
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

const stySrc = join(repoRoot, "packages", "infra", "src", "tex", "argelander.sty");
if (!existsSync(stySrc)) {
  throw new Error("packages/infra/src/tex/argelander.sty is missing");
}
copyFileSync(stySrc, join(appRoot, "dist", "argelander.sty"));

for (const name of ["README.md", "LICENSE"]) {
  copyFileSync(join(repoRoot, name), join(appRoot, name));
}
// The editor is bundled into the SPA: ship its complete upstream MIT notices,
// including runtime transitive dependencies. Fail rather than silently omit one.
const notices = new Map();
function editorNotice(name, req) {
  let root;
  try {
    root = dirname(req.resolve(`${name}/package.json`));
  } catch {
    root = dirname(req.resolve(name));
    while (!existsSync(join(root, "package.json"))) {
      const parent = dirname(root);
      if (parent === root) throw new Error(`Cannot locate package metadata for ${name}`);
      root = parent;
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (notices.has(key)) return;
  if (pkg.license !== "MIT")
    throw new Error(
      `Review editor dependency license before distribution: ${key} (${pkg.license})`
    );
  const files = readdirSync(root).filter((f) => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(f));
  let license = files.map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  // These two npm tarballs omit LICENSE. Exact upstream tag text is vendored
  // from https://raw.githubusercontent.com/uiwjs/react-codemirror/v4.25.11/LICENSE.
  if (
    !license &&
    pkg.version === "4.25.11" &&
    ["@uiw/react-codemirror", "@uiw/codemirror-extensions-basic-setup"].includes(pkg.name)
  ) {
    license = readFileSync(join(appRoot, "licenses/uiw-react-codemirror-4.25.11-LICENSE"), "utf8");
  }
  if (!license) throw new Error(`Missing license text for ${key}`);
  notices.set(key, license);
  const childRequire = createRequire(join(root, "package.json"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) editorNotice(dep, childRequire);
}
const webRequire = createRequire(join(repoRoot, "packages/web/package.json"));
for (const name of [
  "@uiw/react-codemirror",
  "@codemirror/legacy-modes",
  "@codemirror/language",
  "@codemirror/state",
  "@codemirror/view",
])
  editorNotice(name, webRequire);
const noticeText =
  "Third-party Writer editor licenses (upstream text; not relicensed by this project).\n\n" +
  [...notices]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `===== ${name} =====\n${license}`)
    .join("\n\n");
writeFileSync(join(appRoot, "dist", "THIRD-PARTY-EDITOR-NOTICES.txt"), noticeText);
writeFileSync(join(target, "THIRD-PARTY-EDITOR-NOTICES.txt"), noticeText);
console.log(`copied web/sty/root assets and ${notices.size} editor dependency license notices`);
