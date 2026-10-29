// The published-tarball policy of `argelanderspace` (ticket 31), kept pure so it is unit-testable (see
// pack-contents.test.mjs) and shared with scripts/smoke-pack.mjs, which feeds it the real `npm pack` listing.
//
// Everything the bundle needs at run time must be IN the tarball (the versioned instruction text and the Pi runtime
// glue are inlined into dist/bin.js; the PDFium worker thread with the PNG encoder (node:zlib code) is
// dist/pdfium-worker.js, copied from the server's build (shelf-followups 08); the PDFium WASM and the
// Pi SDK come from the declared `dependencies`, installed next to the package). Nothing from the repository, a user library, a provider secret or a
// private prototype may be in it.

import { readFileSync } from "node:fs";
import { checkAgentPlugin } from "./agent-plugin-lib.mjs";

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
  "dist/pdfium-worker.js",
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
  // The bundled skills (project-intake ticket 12, release-0.2 ticket 12): the README marker makes infra's
  // bundledSkillsDir find them; all six SKILL.md are loaded by the Copilot (no allow-list) and by external agents.
  "dist/skills/README.md",
  "dist/skills/argelander-argument-graph/SKILL.md",
  "dist/skills/argelander-find-papers/SKILL.md",
  "dist/skills/argelander-paper-ingest/SKILL.md",
  "dist/skills/argelander-project-intake/SKILL.md",
  "dist/skills/argelander-query-paper-library/SKILL.md",
  "dist/skills/argelander-read-paper/SKILL.md",
  // The Agent plugin (release-0.2 ticket 14): marketplace and plugin manifests, and the copy of the guides it carries
  // (agent-plugin-lib.mjs checks versions and that skills/ equals dist/skills in the built folder).
  "dist/agent-plugin/.claude-plugin/marketplace.json",
  "dist/agent-plugin/.claude-plugin/plugin.json",
  "dist/agent-plugin/skills/README.md",
  "dist/agent-plugin/skills/argelander-argument-graph/SKILL.md",
  "dist/agent-plugin/skills/argelander-find-papers/SKILL.md",
  "dist/agent-plugin/skills/argelander-paper-ingest/SKILL.md",
  "dist/agent-plugin/skills/argelander-project-intake/SKILL.md",
  "dist/agent-plugin/skills/argelander-query-paper-library/SKILL.md",
  "dist/agent-plugin/skills/argelander-read-paper/SKILL.md",
  ...VENDORED_LICENSE_FILES,
];

/** Only these top-level entries may exist in the tarball (dist/ includes the tutorial sample, dist/tutorial/…). */
const ALLOWED_ROOT = /^(?:package\.json|README\.md|LICENSE|dist\/.+|licenses\/[^/]+)$/;

/**
 * The tutorial sample is a project folder by design (in-app-tutorial ticket 16): under dist/tutorial/ its literature
 * data is what the package must carry. Every other rule holds there too.
 */
const TUTORIAL_SAMPLE = /^dist\/tutorial\//;
/**
 * The sample's preset Copilot conversations (in-app-tutorial ticket 17; the move-in one is project-intake ticket 10): each a record and a Pi session file, at
 * exactly the places the server reads them. Only these two shapes are exempt from the Copilot and `.jsonl` rules.
 */
const TUTORIAL_CONVERSATION =
  /^dist\/tutorial\/literatures\/copilot\/(?:conversations\/[^/]+\.json|sessions\/[^/]+\.jsonl)$/;

const FORBIDDEN = [
  [/(^|\/)\.scratch(\/|$)/, "a private scratch/ticket file"],
  [/(^|\/)literatures(\/|$)/, "literature data", "sample"],
  // Never exempt, not even in the sample: a library cache holds source data (ADS API terms forbid redistributing
  // anything obtained from ADS; the sample carries no cache since 2026-10-21, in-app-tutorial ticket 16).
  [/(^|\/)literatures\/library\/cache(\/|$)/, "a library cache (e.g. ADS discovery data)"],
  [
    /(^|\/)(?:\.pi|\.git|\.codegraph|\.serena|node_modules|svglib)(\/|$)/,
    "a repository/tooling directory",
  ],
  [/(^|\/)copilot(\/|$)/, "Copilot conversation data", "conversation"],
  [/(^|\/)(?:auth|models|settings)\.json$/, "a provider credential/config file"],
  [/(^|\/)\.env(?:\.|$)|\.(?:pem|key)$|(^|\/)id_rsa/, "a secret-looking file"],
  [/\.tgz$/, "a nested tarball"],
  [/\.pdf$/i, "a document"],
  [/\.jsonl$/i, "a conversation/session file", "conversation"],
  [/(^|\/)(?:\.npmrc|preferences\.json)$/, "a user config file"],
  [/\.map$/, "a source map (it would embed sources)"],
  [/\.test\.|(^|\/)tests?\//, "a test file"],
];

/**
 * The content checks that need the files themselves (versions, the plugin's skills equal to dist/skills): run on a built
 * `dist` folder by check-pack.mjs (prepack) and on the installed package by smoke-pack.mjs.
 */
export function checkAgentPluginIn(packageRoot) {
  const version = JSON.parse(readFileSync(`${packageRoot}/package.json`, "utf8")).version;
  return checkAgentPlugin(
    `${packageRoot}/dist/agent-plugin`,
    `${packageRoot}/dist/skills`,
    version
  );
}

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
    const isConversation = TUTORIAL_CONVERSATION.test(file);
    for (const [pattern, why, exempt] of FORBIDDEN)
      if (
        pattern.test(file) &&
        !(inSample && exempt === "sample") &&
        !(isConversation && exempt === "conversation")
      )
        problems.push(`forbidden file ${file}: ${why}`);
  }
  return problems;
}
