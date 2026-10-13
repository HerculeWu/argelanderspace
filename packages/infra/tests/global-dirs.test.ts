/**
 * Global data / global cache directory resolution (ADR 0007). env-paths reads
 * the platform at call time but fixes homedir at import, so each platform
 * case stubs process.platform + env and re-imports the module fresh.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConfigError, parseConfigToml } from "../src/config.js";

const realPlatform = process.platform;
const savedEnv = { ...process.env };
const tmps: string[] = [];

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform });
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  vi.resetModules();
  for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
});

async function load(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): Promise<typeof import("../src/global-dirs.js")> {
  Object.defineProperty(process, "platform", { value: platform });
  // The workbench's own variables are already gone from process.env (tests/isolate-user-dirs.ts); the cases below
  // that exercise them pass them explicitly.
  for (const k of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "LOCALAPPDATA"]) delete process.env[k];
  for (const [k, v] of Object.entries(env)) if (v !== undefined) process.env[k] = v;
  vi.resetModules();
  return import("../src/global-dirs.js");
}

const fwd = (p: string) => p.replaceAll("\\", "/");

describe("OS defaults", () => {
  test("linux default and XDG overrides", async () => {
    let m = await load("linux", { HOME: "/home/u" });
    expect(m.resolveGlobalDirs({ config: {} })).toEqual({
      dataDir: "/home/u/.local/share/argelanderspace",
      cacheDir: "/home/u/.cache/argelanderspace",
    });
    m = await load("linux", { HOME: "/home/u", XDG_DATA_HOME: "/x/d", XDG_CACHE_HOME: "/x/c" });
    expect(m.resolveGlobalDirs({ config: {} })).toEqual({
      dataDir: "/x/d/argelanderspace",
      cacheDir: "/x/c/argelanderspace",
    });
  });

  test("macOS", async () => {
    const m = await load("darwin", { HOME: "/Users/u" });
    expect(m.resolveGlobalDirs({ config: {} })).toEqual({
      dataDir: "/Users/u/Library/Application Support/argelanderspace",
      cacheDir: "/Users/u/Library/Caches/argelanderspace",
    });
  });

  test("windows (LOCALAPPDATA and fallback)", async () => {
    let m = await load("win32", { HOME: "/h", LOCALAPPDATA: "C:/Users/u/AppData/Local" });
    let r = m.resolveGlobalDirs({ config: {} });
    expect(fwd(r.dataDir)).toBe("C:/Users/u/AppData/Local/argelanderspace/Data");
    expect(fwd(r.cacheDir)).toBe("C:/Users/u/AppData/Local/argelanderspace/Cache");
    m = await load("win32", { HOME: "/h" });
    r = m.resolveGlobalDirs({ config: {} });
    expect(fwd(r.dataDir)).toBe("/h/AppData/Local/argelanderspace/Data");
  });
});

describe("override precedence", () => {
  test("env > config > OS default, per directory", async () => {
    const m = await load("linux", { HOME: "/home/u" });
    const config = { global_dir: "/cfg/data", global_cache_dir: "/cfg/cache" };
    expect(m.resolveGlobalDirs({ config, env: {} })).toEqual({
      dataDir: "/cfg/data",
      cacheDir: "/cfg/cache",
    });
    expect(
      m.resolveGlobalDirs({
        config,
        env: {
          ARGELANDERSPACE_GLOBAL_DIR: "/env/data",
          ARGELANDERSPACE_GLOBAL_CACHE_DIR: "/env/cache",
        },
      })
    ).toEqual({ dataDir: "/env/data", cacheDir: "/env/cache" });
    // overriding data does not move the cache
    expect(
      m.resolveGlobalDirs({ config: {}, env: { ARGELANDERSPACE_GLOBAL_DIR: "/env/data" } })
    ).toEqual({ dataDir: "/env/data", cacheDir: "/home/u/.cache/argelanderspace" });
  });

  test("blank env values are ignored", async () => {
    const m = await load("linux", { HOME: "/home/u" });
    const r = m.resolveGlobalDirs({
      config: { global_dir: "/cfg/data" },
      env: { ARGELANDERSPACE_GLOBAL_DIR: "  " },
    });
    expect(r.dataDir).toBe("/cfg/data");
  });

  test("relative overrides are rejected, naming the source but not the value", async () => {
    const m = await load("linux", { HOME: "/home/u" });
    expect(() => m.resolveGlobalDirs({ config: { global_dir: "secret/rel" } })).toThrow(
      /"global_dir" must be an absolute path/
    );
    expect(() => m.resolveGlobalDirs({ config: { global_dir: "secret/rel" } })).not.toThrow(
      /secret/
    );
    expect(() =>
      m.resolveGlobalDirs({ config: {}, env: { ARGELANDERSPACE_GLOBAL_CACHE_DIR: "rel" } })
    ).toThrow(/ARGELANDERSPACE_GLOBAL_CACHE_DIR must be an absolute path/);
  });

  test("windows absolute-ness follows win32 rules", async () => {
    const m = await load("win32", { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" });
    expect(m.resolveGlobalDirs({ config: { global_dir: "D:\\data" } }).dataDir).toBe("D:\\data");
    expect(() => m.resolveGlobalDirs({ config: { global_dir: "/data" } })).toThrow(/absolute/);
  });
});

describe("config keys", () => {
  test("parsed as strings", () => {
    expect(parseConfigToml('global_dir = "/a"\nglobal_cache_dir = "/b"')).toMatchObject({
      global_dir: "/a",
      global_cache_dir: "/b",
    });
  });

  test("type error names the key, never the value", () => {
    let err: unknown;
    try {
      parseConfigToml("global_dir = 42");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain("global_dir");
    expect((err as Error).message).not.toContain("42");
    expect(() => parseConfigToml("global_cache_dir = true")).toThrow(/global_cache_dir/);
  });
});

describe("ensureGlobalDirs", () => {
  test("creates directories on demand, only those", async () => {
    const root = mkdtempSync(join(tmpdir(), "gd-"));
    tmps.push(root);
    const m = await load("linux", { HOME: root });
    const env = {
      ARGELANDERSPACE_GLOBAL_DIR: join(root, "d/x"),
      ARGELANDERSPACE_GLOBAL_CACHE_DIR: join(root, "c/y"),
    };
    expect(existsSync(join(root, "d"))).toBe(false); // resolving never creates
    m.resolveGlobalDirs({ config: {}, env });
    expect(existsSync(join(root, "d"))).toBe(false);
    const r = m.ensureGlobalDirs({ config: {}, env });
    expect(statSync(r.dataDir).isDirectory()).toBe(true);
    expect(statSync(r.cacheDir).isDirectory()).toBe(true);
    m.ensureGlobalDirs({ config: {}, env }); // idempotent
  });
});
