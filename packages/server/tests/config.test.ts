/**
 * `resolveServerConfig` (decision 23): what it adds to the chains it shares with the CLI and the desktop host (infra
 * `dataDirOf` / `portOf`, tested in infra `config-chain.test.ts`) — the `--data-dir` / `--port` flags in both
 * spellings, the guard against a garbage `--port`, and the web dist (explicit flag, else the bundle/dev directory
 * candidates). The config object is injected (no disk); the workbench's former environment variables take no part.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveServerConfig } from "../src/server.js";

/** The variables the workbench used to read; setting them must change nothing. */
const REMOVED_ENV = {
  ARGELANDERSPACE_DATA_DIR: "/from-env",
  ARGELANDERSPACE_PORT: "9002",
  ARGELANDERSPACE_WEB_DIST: "/from-env-web",
};

afterEach(() => {
  for (const k of Object.keys(REMOVED_ENV)) delete process.env[k];
});

describe("resolveServerConfig", () => {
  test("flag beats config; a flag may give an absolute data dir", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    const config = { data_dir: "from-config", port: 9001 };
    const flagCfg = resolveServerConfig(
      ["--data-dir", "/from-flag", "--port", "9003"],
      cwd,
      config
    );
    expect(flagCfg.dataDir).toBe("/from-flag");
    expect(flagCfg.port).toBe(9003);
    // `--flag=value` spelling works too
    expect(resolveServerConfig(["--port=9004"], cwd, config).port).toBe(9004);
  });

  test("the removed environment variables change nothing", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    const config = { data_dir: "from-config", port: 9001 };
    const unset = [resolveServerConfig([], cwd, {}), resolveServerConfig([], cwd, config)];
    Object.assign(process.env, REMOVED_ENV);
    expect([resolveServerConfig([], cwd, {}), resolveServerConfig([], cwd, config)]).toEqual(unset);
    expect(unset[0]).toEqual({ dataDir: resolve("./literatures"), port: 1859, webDist: null });
    expect(unset[1]).toEqual({ dataDir: resolve("from-config"), port: 9001, webDist: null });
  });

  test("a relative config data_dir resolves against the process cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    expect(resolveServerConfig([], cwd, { data_dir: "papers" }).dataDir).toBe(resolve("papers"));
  });

  test("a garbage --port falls back to the default (pre-existing guard), not to config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    expect(resolveServerConfig(["--port", "banana"], cwd, { port: 8123 }).port).toBe(1859);
  });

  test("web-dist: the flag wins; the repo dev layout is discovered from cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    expect(resolveServerConfig(["--web-dist", "/x"], cwd, {}).webDist).toBe("/x");
    mkdirSync(join(cwd, "packages", "web", "dist"), { recursive: true });
    expect(resolveServerConfig([], cwd, {}).webDist).toBe(join(cwd, "packages", "web", "dist"));
  });
});
