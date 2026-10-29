/**
 * `argelanderspace agent-plugin` (release-0.2 ticket 14): the built CLI run from an install-shaped copy
 * (`<install>/dist/bin.js` with `dist/agent-plugin` beside it) prints the plugin path and the two Claude Code commands,
 * reads the names from the shipped manifests, and changes nothing; without the plugin it says so and exits 1.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { agentPluginLines } from "../src/agent-plugin.js";

const PKG = fileURLToPath(new URL("..", import.meta.url));
let root: string;
let withPlugin: string;
let withoutPlugin: string;

function install(dir: string): string {
  mkdirSync(dir, { recursive: true });
  cpSync(join(PKG, "dist"), join(dir, "dist"), { recursive: true });
  symlinkSync(join(PKG, "node_modules"), join(dir, "node_modules"));
  return join(dir, "dist");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "aspace-cli-agent-plugin-"));
  const dist = install(join(root, "with"));
  const plugin = join(dist, "agent-plugin", ".claude-plugin");
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(plugin, "plugin.json"), JSON.stringify({ name: "argelanderspace" }));
  writeFileSync(join(plugin, "marketplace.json"), JSON.stringify({ name: "some-market" }));
  withPlugin = join(dist, "bin.js");
  withoutPlugin = join(install(join(root, "without")), "bin.js");
}, 120_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = (bin: string, home: string) =>
  spawnSync(process.execPath, [bin, "agent-plugin"], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, "c"),
      XDG_DATA_HOME: join(home, "d"),
    },
    cwd: home,
    encoding: "utf8",
  });

test("it prints the installed plugin's absolute path and the two commands, and writes nothing", () => {
  const home = mkdtempSync(join(root, "home-"));
  const r = run(withPlugin, home);
  const dir = join(realpathSync(join(withPlugin, "..")), "agent-plugin");
  expect(r.status).toBe(0);
  expect(r.stdout).toBe(
    `Agent plugin: ${dir}\n\nIn Claude Code, run:\n  /plugin marketplace add ${dir}\n  /plugin install argelanderspace@some-market\n`
  );
  expect(readdirSync(home)).toEqual([]);
});

test("an installation without the plugin says so and exits 1", () => {
  const r = run(withoutPlugin, mkdtempSync(join(root, "home-")));
  expect(r.status).toBe(1);
  expect(r.stderr).toBe("error: this installation does not include the Agent plugin\n");
  expect(r.stdout).toBe("");
});

test("the lines are built from the manifests' names", () => {
  expect(agentPluginLines(join(root, "with", "dist", "agent-plugin")).slice(-1)).toEqual([
    "  /plugin install argelanderspace@some-market",
  ]);
});
