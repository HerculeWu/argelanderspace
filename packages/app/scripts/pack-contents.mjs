// The published-tarball policy of `argelanderspace` (ticket 31), kept pure so it is unit-testable (see
// pack-contents.test.mjs) and shared with scripts/smoke-pack.mjs, which feeds it the real `npm pack` listing.
//
// Everything the bundle needs at run time must be IN the tarball (the versioned instruction text and the Pi runtime
// glue and the PNG encoder (node:zlib code in pdf-material.ts) are inlined into dist/bin.js; the PDFium WASM and the
// Pi SDK come from the declared `dependencies`, installed next to the package). Nothing from the repository, a user library, a provider secret or a
// private prototype may be in it.

import { readFileSync } from "node:fs";

/**
 * The vendored license texts (packages/app/licenses, desktop-app tickets 23 and 26): the runtime packages that ship no
 * license file of their own get their text from here, in the npm package as in the desktop package (the user's
 * decision in ticket 23). Read from the manifest, so a new vendored text is required without editing this list.
 */
const vendored = JSON.parse(
  readFileSync(new URL("../licenses/runtime-licenses.json", import.meta.url), "utf8")
);
export const VENDORED_LICENSE_FILES = [
  "licenses/runtime-licenses.json",
  ...Object.keys(vendored.files).map((f) => `licenses/${f}`),
  "licenses/uiw-react-codemirror-4.25.11-LICENSE",
];

export const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "dist/bin.js",
  "dist/argelander.sty",
  "dist/web/index.html",
  "dist/icons.provenance.json",
  "dist/THIRD_PARTY_LICENSES.md",
  "dist/THIRD-PARTY-EDITOR-NOTICES.txt",
  "dist/THIRD-PARTY-EMBEDPDF-NOTICES.txt",
  "dist/THIRD-PARTY-BUNDLED-NOTICES.txt",
  "dist/THIRD-PARTY-MAIL-NOTICES.txt",
  "dist/web/THIRD_PARTY_LICENSES.md",
  "dist/web/icons.provenance.json",
  "dist/web/THIRD-PARTY-EDITOR-NOTICES.txt",
  "dist/web/THIRD-PARTY-EMBEDPDF-NOTICES.txt",
  "dist/web/THIRD-PARTY-BUNDLED-NOTICES.txt",
  "dist/web/THIRD-PARTY-MAIL-NOTICES.txt",
  // The tutorial sample (in-app-tutorial ticket 16): its marker makes bundledTutorialDir find it; its notice carries
  // the papers' licenses.
  "dist/tutorial/argelanderspace-tutorial.json",
  "dist/tutorial/NOTICE.md",
  ...VENDORED_LICENSE_FILES,
];

/** Only these top-level entries may exist in the tarball (dist/ includes the tutorial sample, dist/tutorial/…). */
const ALLOWED_ROOT = /^(?:package\.json|README\.md|LICENSE|dist\/.+|licenses\/[^/]+)$/;

/**
 * The tutorial sample is a project folder by design (in-app-tutorial ticket 16): under dist/tutorial/ its literature
 * data is what the package must carry. Every other rule holds there too.
 */
const TUTORIAL_SAMPLE = /^dist\/tutorial\//;

const FORBIDDEN = [
  [/(^|\/)\.scratch(\/|$)/, "a private scratch/ticket file"],
  [/(^|\/)literatures(\/|$)/, "literature data", "sample"],
  [
    /(^|\/)(?:\.pi|\.git|\.codegraph|\.serena|node_modules|svglib)(\/|$)/,
    "a repository/tooling directory",
  ],
  [/(^|\/)copilot(\/|$)/, "Copilot conversation data"],
  [/(^|\/)(?:auth|models|settings)\.json$/, "a provider credential/config file"],
  [/(^|\/)\.env(?:\.|$)|\.(?:pem|key)$|(^|\/)id_rsa/, "a secret-looking file"],
  [/\.tgz$/, "a nested tarball"],
  [/\.(?:pdf|jsonl)$/i, "a document or conversation/session file"],
  [/(^|\/)(?:\.npmrc|preferences\.json)$/, "a user config file"],
  [/\.map$/, "a source map (it would embed sources)"],
  [/\.test\.|(^|\/)tests?\//, "a test file"],
];

export function checkPackContents(paths) {
  const files = paths.map((p) => p.replace(/^package\//, ""));
  const problems = [];
  for (const required of REQUIRED_FILES)
    if (!files.includes(required)) problems.push(`missing required file ${required}`);
  if (!files.some((p) => /^dist\/web\/assets\/.+\.js$/.test(p)))
    problems.push("missing the web bundle under dist/web/assets/*.js");
  if (!files.some((p) => /^dist\/web\/assets\/KaTeX_.+\.woff2$/.test(p)))
    problems.push("missing the KaTeX fonts under dist/web/assets/");
  for (const file of files) {
    if (!ALLOWED_ROOT.test(file))
      problems.push(`unexpected file outside the package contract: ${file}`);
    const inSample = TUTORIAL_SAMPLE.test(file);
    for (const [pattern, why, exempt] of FORBIDDEN)
      if (pattern.test(file) && !(inSample && exempt === "sample"))
        problems.push(`forbidden file ${file}: ${why}`);
  }
  return problems;
}
