/**
 * `resolveServerConfig` precedence (decision 23): CLI flag > env var >
 * config file > default, for both `data_dir` and `port`. The config object
 * is injected (no disk); web-dist resolution keeps its explicit-flag/env
 * short-circuit and falls back to the bundle/dev directory candidates.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveServerConfig } from "../src/server.js";

const NO_ENV: NodeJS.ProcessEnv = {};

describe("resolveServerConfig", () => {
  test("defaults: ./literatures, port 8000, web dist null outside the repo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    const cfg = resolveServerConfig([], NO_ENV, cwd, {});
    expect(cfg.dataDir).toBe(resolve("./literatures"));
    expect(cfg.port).toBe(8000);
    expect(cfg.webDist).toBeNull();
  });

  test("config file supplies data_dir and port when flag and env are absent", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    const cfg = resolveServerConfig([], NO_ENV, cwd, { data_dir: "/srv/papers", port: 8123 });
    expect(cfg.dataDir).toBe("/srv/papers");
    expect(cfg.port).toBe(8123);
  });

  test("env beats config; flag beats env", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    const config = { data_dir: "/from-config", port: 9001 };
    const envCfg = resolveServerConfig(
      [],
      { ARGELANDERSPACE_DATA_DIR: "/from-env", ARGELANDERSPACE_PORT: "9002" },
      cwd,
      config
    );
    expect(envCfg.dataDir).toBe("/from-env");
    expect(envCfg.port).toBe(9002);

    const flagCfg = resolveServerConfig(
      ["--data-dir", "/from-flag", "--port", "9003"],
      { ARGELANDERSPACE_DATA_DIR: "/from-env", ARGELANDERSPACE_PORT: "9002" },
      cwd,
      config
    );
    expect(flagCfg.dataDir).toBe("/from-flag");
    expect(flagCfg.port).toBe(9003);
    // `--flag=value` spelling works too
    expect(resolveServerConfig(["--port=9004"], NO_ENV, cwd, config).port).toBe(9004);
  });

  test("a relative config data_dir resolves against the process cwd (like env)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    expect(resolveServerConfig([], NO_ENV, cwd, { data_dir: "papers" }).dataDir).toBe(
      resolve("papers")
    );
  });

  test("a garbage env port falls back to 8000 (pre-existing guard), not to config", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    const cfg = resolveServerConfig([], { ARGELANDERSPACE_PORT: "banana" }, cwd, { port: 8123 });
    expect(cfg.port).toBe(8000);
  });

  test("web-dist: flag/env win; the repo dev layout is discovered from cwd", () => {
    const cwd = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
    expect(resolveServerConfig(["--web-dist", "/x"], NO_ENV, cwd, {}).webDist).toBe("/x");
    expect(resolveServerConfig([], { ARGELANDERSPACE_WEB_DIST: "/y" }, cwd, {}).webDist).toBe("/y");
    mkdirSync(join(cwd, "packages", "web", "dist"), { recursive: true });
    expect(resolveServerConfig([], NO_ENV, cwd, {}).webDist).toBe(
      join(cwd, "packages", "web", "dist")
    );
  });
});
