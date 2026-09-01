/**
 * User config file (decision 23): XDG path resolution, TOML parsing + error
 * quality, and the env-first-then-config fallback wiring for the API keys
 * (OpenAlex / ADS; the MinerU key left with the PDF pipeline). Hermetic:
 * every disk-touching test points `$XDG_CONFIG_HOME` at a fresh tmp dir and
 * restores env afterwards.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  type AppConfig,
  ConfigError,
  configFilePath,
  getConfig,
  loadConfigFile,
  parseConfigToml,
} from "../src/config.js";
import { readAdsToken } from "../src/sources/ads.js";
import { OpenAlexClient } from "../src/sources/openalex.js";
import { jsonResponse, stubFetch } from "./helpers.js";

// --------------------------------------------------------------------------- //
// env pinning helpers
// --------------------------------------------------------------------------- //

const SAVED: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in SAVED)) SAVED[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete SAVED[k];
  }
});

/** A fresh XDG config home holding the given config.toml text. */
function xdgWithConfig(toml: string): string {
  const xdg = mkdtempSync(join(tmpdir(), "aspace-cfg-"));
  mkdirSync(join(xdg, "argelanderspace"), { recursive: true });
  writeFileSync(join(xdg, "argelanderspace", "config.toml"), toml, "utf-8");
  setEnv("XDG_CONFIG_HOME", xdg);
  return xdg;
}

// --------------------------------------------------------------------------- //
// path resolution + parsing
// --------------------------------------------------------------------------- //

describe("configFilePath", () => {
  test("respects $XDG_CONFIG_HOME; default is ~/.config", () => {
    expect(configFilePath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(
      "/xdg/argelanderspace/config.toml"
    );
    expect(configFilePath({}, "/home/u")).toBe("/home/u/.config/argelanderspace/config.toml");
    // a blank XDG value falls back to ~/.config (spec: empty means unset)
    expect(configFilePath({ XDG_CONFIG_HOME: "  " }, "/home/u")).toBe(
      "/home/u/.config/argelanderspace/config.toml"
    );
  });
});

describe("parseConfigToml", () => {
  test("parses the full flat subset; unknown keys are ignored", () => {
    const cfg = parseConfigToml(
      [
        'data_dir = "/srv/papers"',
        "port = 8123",
        'openalex_api_key = "o"',
        'ads_dev_key = "a"',
        'mineru_api_key = "ignored-now"', // known key before MS1, unknown since
        'future_key = "ignored"',
        "",
      ].join("\n"),
      "/p/config.toml"
    );
    expect(cfg).toEqual({
      data_dir: "/srv/papers",
      port: 8123,
      openalex_api_key: "o",
      ads_dev_key: "a",
    });
  });

  test("wrong value types are ConfigErrors naming the key, never the value", () => {
    expect(() => parseConfigToml("port = 1.5", "/p")).toThrow(/"port" must be an integer/);
    expect(() => parseConfigToml('data_dir = ["x"]', "/p")).toThrow(/"data_dir" must be a string/);
    expect(() => parseConfigToml("port = 70000", "/p")).toThrow(ConfigError);
    try {
      parseConfigToml("openalex_api_key = 42", "/p");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain('"openalex_api_key" must be a string');
      expect((e as Error).message).not.toContain("42");
    }
  });

  test("malformed TOML reports the path and the parse location", () => {
    try {
      parseConfigToml('port = "abc"\n= bad', "/p/config.toml");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as Error).message;
      expect(msg).toContain("invalid TOML in /p/config.toml");
      expect(msg).toMatch(/\n1:/); // smol-toml's line/column rendering is kept
    }
  });
});

describe("loadConfigFile", () => {
  test("a missing file is an empty config, not an error", () => {
    expect(loadConfigFile(join(tmpdir(), "aspace-definitely-missing", "config.toml"))).toEqual({});
  });

  test("a malformed file is a loud ConfigError carrying the path", () => {
    xdgWithConfig("data_dir = \n");
    expect(() => getConfig()).toThrow(/invalid TOML in .*argelanderspace/);
  });

  test("an unreadable path (directory) is a ConfigError, not silent {}", () => {
    expect(() => loadConfigFile(mkdtempSync(join(tmpdir(), "aspace-cfgdir-")))).toThrow(
      /cannot read config file/
    );
  });
});

// --------------------------------------------------------------------------- //
// API-key fallbacks: env var > config file (values never logged)
// --------------------------------------------------------------------------- //

describe("readAdsToken chain", () => {
  test("env > config > ~/.ads/dev_key > null", () => {
    const home = mkdtempSync(join(tmpdir(), "aspace-ads-"));
    mkdirSync(join(home, ".ads"), { recursive: true });
    writeFileSync(join(home, ".ads", "dev_key"), "from-file\n", "utf-8");
    const cfg: AppConfig = { ads_dev_key: " from-config " };
    expect(readAdsToken({ ADS_DEV_KEY: "from-env" }, home, cfg)).toBe("from-env");
    expect(readAdsToken({}, home, cfg)).toBe("from-config");
    expect(readAdsToken({}, home, {})).toBe("from-file");
    expect(readAdsToken({}, "/nonexistent-home", {})).toBeNull();
  });
});

describe("OpenAlexClient api key", () => {
  test("config openalex_api_key goes on the wire when env is absent", async () => {
    xdgWithConfig('openalex_api_key = "CFG-1"\n');
    setEnv("OPENALEX_API_KEY", undefined);
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ results: [] }));
    const oa = new OpenAlexClient({
      cacheDir: mkdtempSync(join(tmpdir(), "aspace-oa-")),
      delay: 0,
      fetchImpl,
    });
    await oa.fetchMany(["W1"]);
    expect(calls[0]?.url).toContain("api_key=CFG-1");
  });

  test("env beats config; explicit null beats both", async () => {
    xdgWithConfig('openalex_api_key = "CFG-1"\n');
    setEnv("OPENALEX_API_KEY", "ENV-1");
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ results: [] }));
    const cacheDir = mkdtempSync(join(tmpdir(), "aspace-oa-"));
    await new OpenAlexClient({ cacheDir, delay: 0, fetchImpl }).fetchMany(["W1"]);
    expect(calls[0]?.url).toContain("api_key=ENV-1");
    await new OpenAlexClient({ cacheDir, delay: 0, apiKey: null, fetchImpl }).fetchMany(["W2"]);
    expect(calls[1]?.url).not.toContain("api_key=");
  });
});
