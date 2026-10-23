// Post-bundle asset step (decision 22):
//  - the built SPA (packages/web/dist) is copied to dist/web — the server's
//    import.meta-relative web-dist candidate finds it there in the packed
//    layout;
//  - packages/infra/src/tex/argelander.sty is copied to dist/ next to the
//    bundle — tsup inlines infra's instrument.ts into bin.js, so its
//    `new URL("./argelander.sty", import.meta.url)` resolves to
//    dist/argelander.sty (MS4 checkpoint; missing asset = silent
//    clean-compile fallback that loses the event stream);
//  - packages/server/dist/pdfium-worker.js is copied to dist/ next to the
//    bundle — the server's PDFium engine runs in a worker thread
//    (shelf-followups 08) whose file pdfium-shared.ts finds by
//    `new URL("./pdfium-worker.js", import.meta.url)`, i.e. dist/ once the
//    server is inlined into bin.js; the file is self-contained (Node
//    built-ins and the @embedpdf/* runtime dependencies only). Missing, every
//    PDF upload, page and text read fails;
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

// Adopted icon attribution is carried both alongside the SPA and at application root.
for (const name of ["THIRD_PARTY_LICENSES.md", "icons.provenance.json"]) {
  copyFileSync(join(webDist, name), join(appRoot, "dist", name));
}

const stySrc = join(repoRoot, "packages", "infra", "src", "tex", "argelander.sty");
if (!existsSync(stySrc)) {
  throw new Error("packages/infra/src/tex/argelander.sty is missing");
}
copyFileSync(stySrc, join(appRoot, "dist", "argelander.sty"));

const pdfiumWorkerSrc = join(repoRoot, "packages", "server", "dist", "pdfium-worker.js");
if (!existsSync(pdfiumWorkerSrc)) {
  throw new Error(
    "packages/server/dist/pdfium-worker.js is missing — build @argelanderspace/server first"
  );
}
copyFileSync(pdfiumWorkerSrc, join(appRoot, "dist", "pdfium-worker.js"));

// The tutorial sample (in-app-tutorial ticket 16): the frozen sample project at the repository root goes to
// dist/tutorial, where infra's bundledTutorialDir finds it in the npm and development layouts (the desktop package
// copies it on its own). Copied whole and unchanged; a sample without its marker file stops the build.
const tutorialSrc = join(repoRoot, "tutorial-sample");
if (!existsSync(join(tutorialSrc, "argelanderspace-tutorial.json"))) {
  throw new Error("tutorial-sample/argelanderspace-tutorial.json is missing");
}
const tutorialTarget = join(appRoot, "dist", "tutorial");
rmSync(tutorialTarget, { recursive: true, force: true });
cpSync(tutorialSrc, tutorialTarget, { recursive: true });

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
const sdkNotices = new Map();
const allowedSdkLicenses = new Set([
  "MIT",
  "OFL-1.1",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
]);
function sdkNotice(name, req) {
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
  if (sdkNotices.has(key)) return;
  if (!allowedSdkLicenses.has(pkg.license))
    throw new Error(`Review EmbedPDF license before distribution: ${key} (${pkg.license})`);
  const files = readdirSync(root).filter((f) => /^(?:licen[sc]e|notice)(?:[._-].*)?$/i.test(f));
  const texts = files.map((f) => `===== ${f} =====\n${readFileSync(join(root, f), "utf8")}`);
  if (!texts.some((text) => /license/i.test(text)))
    throw new Error(`Missing license text for ${key}`);
  sdkNotices.set(key, texts.join("\n"));
  const childRequire = createRequire(join(root, "package.json"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) sdkNotice(dep, childRequire);
}
const webSdkRequire = createRequire(join(repoRoot, "packages/web/package.json"));
for (const name of [
  "@embedpdf/core",
  "@embedpdf/engines",
  "@embedpdf/models",
  "@embedpdf/pdfium",
  "@embedpdf/plugin-annotation",
  "@embedpdf/plugin-document-manager",
  "@embedpdf/plugin-interaction-manager",
  "@embedpdf/plugin-render",
  "@embedpdf/plugin-rotate",
  "@embedpdf/plugin-scroll",
  "@embedpdf/plugin-selection",
  "@embedpdf/plugin-viewport",
  "@embedpdf/plugin-zoom",
])
  sdkNotice(name, webSdkRequire);
const noticeText =
  "Third-party Writer editor licenses (upstream text; not relicensed by this project).\n\n" +
  [...notices]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `===== ${name} =====\n${license}`)
    .join("\n\n");
const embedPdfNoticeText =
  "EmbedPDF 2.15.1 and production dependency licenses (upstream text; not relicensed by this project).\n\n" +
  [...sdkNotices]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `===== ${name} =====\n${license}`)
    .join("\n\n");
// KaTeX and marked are inlined into dist/bin.js (via core: server-side math validation, text-Doc rendering) and into the
// SPA bundle (web); the KaTeX fonts ship in dist/web/assets. Their MIT notices must travel with both. Resolved from
// the core and web dependency trees, so a version bump re-reads the license; the same rule as above: fail, never omit.
const bundledNotices = new Map();
// bin.js gets its copies through core, the SPA through web: each tree is read, so a version split keeps both notices.
// marked-cjk-friendly (CJK bold/italic next to CJK punctuation) is web-only and inlined into the SPA bundle.
const bundledRequires = [
  [createRequire(join(repoRoot, "packages/core/package.json")), ["katex", "marked"]],
  [
    createRequire(join(repoRoot, "packages/web/package.json")),
    ["katex", "marked", "marked-cjk-friendly"],
  ],
];
for (const [req, names] of bundledRequires)
  for (const name of names) {
    const root = dirname(req.resolve(`${name}/package.json`));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const key = `${pkg.name}@${pkg.version}`;
    if (bundledNotices.has(key)) continue;
    if (pkg.license !== "MIT")
      throw new Error(
        `Review bundled dependency license before distribution: ${key} (${pkg.license})`
      );
    const files = readdirSync(root).filter((f) => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(f));
    const license = files.map((f) => readFileSync(join(root, f), "utf8")).join("\n");
    if (!license) throw new Error(`Missing license text for ${key}`);
    bundledNotices.set(key, license);
  }
const bundledNoticeText =
  "Third-party libraries bundled into the server (dist/bin.js) and the web app (upstream text; not relicensed by this project).\n" +
  "KaTeX also ships its fonts (dist/web/assets/KaTeX_*): the KaTeX npm package carries this single MIT license file and no separate font license text.\n\n" +
  [...bundledNotices]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `===== ${name} =====\n${license}`)
    .join("\n\n");
// Mail (ticket 10). The roots are infra's declared dependencies (workspace packages and @napi-rs/keyring excluded),
// so a new dependency is picked up without editing this list, plus web's DOMPurify. Their transitive production
// closure is declared as a whole: tsup inlines most of it into dist/bin.js, but some packages (e.g. pino's optional
// worker-thread helpers) may never be reached by the bundle. Deciding which are inlined would need a bundler
// metafile in the shipped dist/, so we over-declare on purpose and label entries "dependency closure (may be
// partially inlined)". DOMPurify goes into the SPA bundle. @napi-rs/keyring is the declared runtime dependency
// (a native module installed next to the package, not bundled). Same rule as above: fail, never omit.
// Dual-licensed packages name the license we elect and the file that carries exactly that text; anything outside the
// allowed list stops the build so a new dependency gets a human license decision (docs/engineering.md,
// scripts/license-scan.mjs).
const mailNotices = new Map();
const mailAllowed = new Set(["MIT", "MIT-0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "Apache-2.0"]);
const mailElected = {
  // "(MIT OR EUPL-1.1+)": elect MIT.
  "@zone-eu/mailsplit": { license: "MIT", files: ["LICENSE.MIT"] },
  // "(MPL-2.0 OR Apache-2.0)": elect Apache-2.0.
  // The upstream LICENSE file is the bare Apache-2.0 text without a copyright line.
  dompurify: {
    license: "Apache-2.0",
    files: ["LICENSE"],
    copyright: "Copyright (c) Cure53 and other contributors",
  },
};
function locatePackage(name, req) {
  try {
    return dirname(req.resolve(`${name}/package.json`));
  } catch {
    let dir = dirname(req.resolve(name));
    for (;;) {
      const file = join(dir, "package.json");
      if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === name) return dir;
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`Cannot locate package metadata for ${name}`);
      dir = parent;
    }
  }
}
function mailNotice(name, req, via) {
  const root = locatePackage(name, req);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const key = `${pkg.name}@${pkg.version}`;
  if (mailNotices.has(key)) return;
  const elected = mailElected[pkg.name];
  const license = elected ? elected.license : pkg.license;
  if (!mailAllowed.has(license))
    throw new Error(`Review mail dependency license before distribution: ${key} (${pkg.license})`);
  const files = elected
    ? elected.files
    : readdirSync(root).filter((f) => /^licen[sc]e(?:\.(?:md|txt))?$/i.test(f));
  const text = files.map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  if (!text) throw new Error(`Missing license text for ${key}`);
  const note = elected ? ` (declared ${pkg.license}; ${elected.license} elected)` : "";
  const copyright = elected?.copyright ? `${elected.copyright}\n` : "";
  mailNotices.set(key, `License: ${license}${note}; ${via}\n${copyright}${text}`);
  const childRequire = createRequire(join(root, "package.json"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) mailNotice(dep, childRequire, via);
}
const infraRequire = createRequire(join(repoRoot, "packages/infra/package.json"));
const infraPkg = JSON.parse(readFileSync(join(repoRoot, "packages/infra/package.json"), "utf8"));
const MAIL_NOTICE_ROOTS = Object.entries(infraPkg.dependencies ?? {})
  .filter(([name, range]) => !String(range).startsWith("workspace:") && name !== "@napi-rs/keyring")
  .map(([name]) => name);
for (const name of MAIL_NOTICE_ROOTS)
  mailNotice(name, infraRequire, "dependency closure (may be partially inlined into dist/bin.js)");
mailNotice("dompurify", webRequire, "inlined into the web app bundle");
// @napi-rs/keyring: a runtime dependency installed beside the package. Its platform packages (optionalDependencies,
// one native binary each) carry the same release and MIT license but no LICENSE file of their own, so the parent's
// text is the declaration for all of them.
{
  const root = locatePackage("@napi-rs/keyring", createRequire(join(appRoot, "package.json")));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (pkg.license !== "MIT")
    throw new Error(`Review keyring license before distribution: ${pkg.license}`);
  const text = readFileSync(join(root, "LICENSE"), "utf8");
  const platforms = Object.keys(pkg.optionalDependencies ?? {}).sort();
  mailNotices.set(
    `${pkg.name}@${pkg.version}`,
    `License: MIT; installed as a runtime dependency (not bundled); applies equally to its platform binaries ${platforms.join(", ")}\n${text}`
  );
}
const mailNoticeText =
  "Third-party libraries used by Mail and the infra layer (upstream text; not relicensed by this project).\n" +
  "Elections: @zone-eu/mailsplit is offered as (MIT OR EUPL-1.1+) and is used under MIT; DOMPurify is offered as (MPL-2.0 OR Apache-2.0) and is used under Apache-2.0.\n\n" +
  [...mailNotices]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `===== ${name} =====\n${license}`)
    .join("\n\n");
writeFileSync(join(appRoot, "dist", "THIRD-PARTY-MAIL-NOTICES.txt"), mailNoticeText);
writeFileSync(join(target, "THIRD-PARTY-MAIL-NOTICES.txt"), mailNoticeText);
writeFileSync(join(appRoot, "dist", "THIRD-PARTY-BUNDLED-NOTICES.txt"), bundledNoticeText);
writeFileSync(join(target, "THIRD-PARTY-BUNDLED-NOTICES.txt"), bundledNoticeText);
writeFileSync(join(appRoot, "dist", "THIRD-PARTY-EDITOR-NOTICES.txt"), noticeText);
writeFileSync(join(target, "THIRD-PARTY-EDITOR-NOTICES.txt"), noticeText);
writeFileSync(join(appRoot, "dist", "THIRD-PARTY-EMBEDPDF-NOTICES.txt"), embedPdfNoticeText);
writeFileSync(join(target, "THIRD-PARTY-EMBEDPDF-NOTICES.txt"), embedPdfNoticeText);
console.log(
  `copied web/sty/tutorial/root assets, ${notices.size} editor notices, ${sdkNotices.size} EmbedPDF notices, ${bundledNotices.size} bundled-library notices and ${mailNotices.size} Mail notices`
);
