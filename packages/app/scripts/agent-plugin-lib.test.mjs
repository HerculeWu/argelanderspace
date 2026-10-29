// The Agent plugin build and its content check (release-0.2 ticket 14), on a temporary dist folder.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  AGENT_MARKETPLACE_NAME,
  AGENT_PLUGIN_NAME,
  buildAgentPlugin,
  checkAgentPlugin,
} from "./agent-plugin-lib.mjs";
import { checkAgentPluginIn } from "./pack-contents.mjs";

let root;
let dist;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aspace-agent-plugin-"));
  dist = join(root, "dist");
  mkdirSync(join(dist, "skills", "argelander-x"), { recursive: true });
  writeFileSync(join(dist, "skills", "README.md"), "# guides\n");
  writeFileSync(join(dist, "skills", "argelander-x", "SKILL.md"), "---\nname: argelander-x\n---\n");
  buildAgentPlugin(dist, "1.2.3", "git+https://example.invalid/r.git");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const plugin = () => join(dist, "agent-plugin");
const check = () => checkAgentPlugin(plugin(), join(dist, "skills"), "1.2.3");
const edit = (file, fn) => {
  const p = join(plugin(), ".claude-plugin", file);
  writeFileSync(p, JSON.stringify(fn(JSON.parse(readFileSync(p, "utf8")))));
};

test("a built plugin is complete: manifests at the package version, skills equal to the guides", () => {
  assert.deepEqual(check(), []);
  const m = JSON.parse(readFileSync(join(plugin(), ".claude-plugin/marketplace.json"), "utf8"));
  const p = JSON.parse(readFileSync(join(plugin(), ".claude-plugin/plugin.json"), "utf8"));
  assert.equal(p.name, AGENT_PLUGIN_NAME);
  assert.equal(p.version, "1.2.3");
  assert.equal(m.name, AGENT_MARKETPLACE_NAME);
  assert.equal(m.plugins[0].source, "./");
  assert.ok(m.owner.name);
  for (const k of ["mcpServers", "hooks", "agents", "commands"]) assert.ok(!(k in p));
});

test("a missing manifest is reported", () => {
  rmSync(join(plugin(), ".claude-plugin/plugin.json"));
  assert.match(check().join("\n"), /missing \.claude-plugin\/plugin\.json/);
  buildAgentPlugin(dist, "1.2.3");
  rmSync(join(plugin(), ".claude-plugin/marketplace.json"));
  assert.match(check().join("\n"), /missing \.claude-plugin\/marketplace\.json/);
});

test("a plugin version that differs from the package version is reported", () => {
  edit("plugin.json", (j) => ({ ...j, version: "9.9.9" }));
  assert.match(check().join("\n"), /plugin\.json version 9\.9\.9 differs/);
});

test("a marketplace entry version that differs, or a wrong entry, is reported", () => {
  edit("marketplace.json", (j) => ({ ...j, plugins: [{ ...j.plugins[0], version: "0.0.1" }] }));
  assert.match(check().join("\n"), /marketplace\.json version 0\.0\.1 differs/);
  edit("marketplace.json", (j) => ({ ...j, plugins: [{ name: "other", source: "./" }] }));
  assert.match(check().join("\n"), /exactly argelanderspace/);
});

test("a skills copy that is missing a file, differs, or has an extra one is reported", () => {
  rmSync(join(plugin(), "skills/argelander-x/SKILL.md"));
  assert.match(check().join("\n"), /skills\/argelander-x\/SKILL\.md is missing/);
  writeFileSync(join(plugin(), "skills/argelander-x/SKILL.md"), "changed");
  assert.match(check().join("\n"), /differs from the bundled guide/);
  buildAgentPlugin(dist, "1.2.3");
  writeFileSync(join(plugin(), "skills/extra.md"), "x");
  assert.match(check().join("\n"), /skills\/extra\.md is not a bundled guide/);
});

test("checkAgentPluginIn reads the package version from package.json", () => {
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.3" }));
  assert.deepEqual(checkAgentPluginIn(root), []);
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.2.4" }));
  assert.match(checkAgentPluginIn(root).join("\n"), /differs from package version 1\.2\.4/);
});
