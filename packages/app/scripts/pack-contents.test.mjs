// Seam test for the published-tarball policy (ticket 31). Pure: it feeds path lists to checkPackContents, so it needs
// no build; the real tarball is checked by scripts/smoke-pack.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkPackContents, REQUIRED_FILES } from "./pack-contents.mjs";

const good = [
  ...REQUIRED_FILES,
  "dist/web/assets/index-abc.js",
  "dist/web/assets/KaTeX_Main-Regular-abc.woff2",
];

test("a complete package passes", () => {
  assert.deepEqual(checkPackContents(good), []);
});

test("npm's package/ prefix is accepted", () => {
  assert.deepEqual(checkPackContents(good.map((p) => `package/${p}`)), []);
});

for (const missing of REQUIRED_FILES) {
  test(`missing ${missing} is reported`, () => {
    const problems = checkPackContents(good.filter((p) => p !== missing));
    assert.ok(
      problems.some((p) => p.includes(missing)),
      problems.join("\n")
    );
  });
}

test("the web bundle and the KaTeX fonts are required", () => {
  const noJs = good.filter((p) => !p.endsWith(".js") || p === "dist/bin.js");
  assert.ok(checkPackContents(noJs).some((p) => p.includes("dist/web/assets")));
  const noFont = good.filter((p) => !p.includes("KaTeX_"));
  assert.ok(checkPackContents(noFont).some((p) => p.includes("KaTeX")));
});

for (const forbidden of [
  ".scratch/copilot/spec.md",
  "literatures/library/library.json",
  "literatures/output/x.json",
  "dist/.pi/skills/x/SKILL.md",
  ".pi/AGENTS.md",
  "dist/.env",
  "dist/auth.json",
  "dist/models.json",
  "copilot/sessions/a.jsonl",
  "svglib/icon.svg",
  "node_modules/x/index.js",
  "argelanderspace-0.1.0.tgz",
  "dist/bin.js.map",
  "src/bin.ts",
  "dist/key.pem",
  "dist/web/sample.pdf",
  "dist/session.jsonl",
  "dist/.npmrc",
  "dist/preferences.json",
]) {
  test(`forbidden ${forbidden} is reported`, () => {
    const problems = checkPackContents([...good, forbidden]);
    assert.ok(
      problems.some((p) => p.includes(forbidden)),
      problems.join("\n")
    );
  });
}

test("the vendored license texts ship with the npm package (desktop-app ticket 26)", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../licenses/runtime-licenses.json", import.meta.url), "utf8")
  );
  assert.ok(REQUIRED_FILES.includes("licenses/runtime-licenses.json"));
  for (const file of Object.keys(manifest.files))
    assert.ok(REQUIRED_FILES.includes(`licenses/${file}`), file);
  // Every package entry's text is one of them: the 17 of ticket 22 and the other platforms' keychain packages.
  for (const p of manifest.packages)
    assert.ok(REQUIRED_FILES.includes(`licenses/${p.file}`), p.package);
  assert.ok(manifest.packages.length >= 17);
  // Only flat files in licenses/ are allowed there.
  assert.ok(
    checkPackContents([...good, "licenses/nested/x"]).some((p) => p.includes("licenses/nested/x"))
  );
  // The package's `files` carries the folder.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("licenses"));
});

test("the tutorial sample ships under dist/tutorial: its marker and notice are required (in-app-tutorial ticket 16)", () => {
  assert.ok(REQUIRED_FILES.includes("dist/tutorial/argelanderspace-tutorial.json"));
  assert.ok(REQUIRED_FILES.includes("dist/tutorial/NOTICE.md"));
  // the sample is a project folder: its literature data, Doc and upload zip are allowed there
  const sample = [
    "dist/tutorial/literatures/library/library.json",
    "dist/tutorial/literatures/library/cache/ads-discovery/0a1b.json",
    "dist/tutorial/literatures/output/arxiv-2103.12080/arxiv-2103.12080.json",
    "dist/tutorial/literatures/output/arxiv-2103.12080/assets/YX_D__pdf.svg",
    "dist/tutorial/status/plans.json",
    "dist/tutorial/tutorial-assets/evans-oh-2022-source.zip",
  ];
  assert.deepEqual(checkPackContents([...good, ...sample]), []);
});

for (const forbidden of [
  // literature data is allowed only inside the sample
  "dist/literatures/library/library.json",
  "dist/tutorial-sample/literatures/library/library.json",
  // every other rule still holds inside the sample
  "dist/tutorial/literatures/.env",
  "dist/tutorial/auth.json",
  "dist/tutorial/literatures/output/x/x.pdf",
  "dist/tutorial/.scratch/notes.md",
  "dist/tutorial/node_modules/x/index.js",
]) {
  test(`forbidden ${forbidden} is reported even next to the tutorial sample`, () => {
    const problems = checkPackContents([...good, forbidden]);
    assert.ok(
      problems.some((p) => p.includes(forbidden)),
      problems.join("\n")
    );
  });
}
