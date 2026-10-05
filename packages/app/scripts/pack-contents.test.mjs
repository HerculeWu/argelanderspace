// Seam test for the published-tarball policy (ticket 31). Pure: it feeds path lists to checkPackContents, so it needs
// no build; the real tarball is checked by scripts/smoke-pack.mjs.
import assert from "node:assert/strict";
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
]) {
  test(`forbidden ${forbidden} is reported`, () => {
    const problems = checkPackContents([...good, forbidden]);
    assert.ok(
      problems.some((p) => p.includes(forbidden)),
      problems.join("\n")
    );
  });
}
