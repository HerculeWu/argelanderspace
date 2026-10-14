/**
 * User config file (decision 23): XDG path resolution, TOML parsing + error
 * quality, and the env-first-then-config fallback wiring for the API keys
 * (OpenAlex / ADS; the MinerU key left with the PDF pipeline). Hermetic:
 * every disk-touching test points `$XDG_CONFIG_HOME` at a fresh tmp dir and
 * restores env afterwards.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  ConfigError,
  configFileKeys,
  configFilePath,
  getConfig,
  loadConfigFile,
  parseConfigToml,
} from "../src/config.js";
import { ADS_TOKEN_READ_TIMEOUT_MS, readAdsToken } from "../src/sources/ads.js";
import { OpenAlexClient, readOpenAlexApiKey } from "../src/sources/openalex.js";
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
        'data_dir = "srv/papers"',
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
      data_dir: "srv/papers",
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

  test("data_dir must be relative: an absolute path names the key, never the value", () => {
    for (const rel of ["papers", "./literatures", "../shared/lit", "a/b"]) {
      expect(parseConfigToml(`data_dir = "${rel}"`, "/p").data_dir).toBe(rel);
    }
    let err: unknown;
    try {
      parseConfigToml('data_dir = "/home/someone/secret-lit"', "/p/config.toml");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe('/p/config.toml: "data_dir" must be a relative path');
  });

  test("data_dir: an absolute path in the other platform's writing is refused too; a backslash inside a relative path is not", () => {
    for (const abs of ["C:\\Users\\me\\lit", "C:/Users/me/lit", "\\\\host\\share\\lit", "\\lit"]) {
      // A TOML literal string (single quotes): backslashes are taken as written.
      expect(() => parseConfigToml(`data_dir = '${abs}'`, "/p/config.toml")).toThrow(
        '/p/config.toml: "data_dir" must be a relative path'
      );
    }
    expect(parseConfigToml("data_dir = 'a\\b'", "/p").data_dir).toBe("a\\b");
  });

  test("a file with an older fault and an absolute data_dir still reports the older fault", () => {
    expect(() => parseConfigToml('data_dir = "/abs"\nport = "x"', "/p")).toThrow(
      '/p: "port" must be an integer between 0 and 65535'
    );
    expect(() => parseConfigToml('data_dir = "/abs"\nauto_ingest_arxiv = 1', "/p")).toThrow(
      '/p: "auto_ingest_arxiv" must be a boolean'
    );
  });

  test("auto_ingest_arxiv (Stage 15 hidden toggle): boolean, default unset (=on)", () => {
    expect(parseConfigToml("", "/p").auto_ingest_arxiv).toBeUndefined();
    expect(parseConfigToml("auto_ingest_arxiv = false", "/p").auto_ingest_arxiv).toBe(false);
    expect(parseConfigToml("auto_ingest_arxiv = true", "/p").auto_ingest_arxiv).toBe(true);
    expect(() => parseConfigToml('auto_ingest_arxiv = "no"', "/p")).toThrow(
      /"auto_ingest_arxiv" must be a boolean/
    );
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

describe("readAdsToken: only the credential store (desktop-app ticket 12)", () => {
  test("the environment variable, the config key and ~/.ads/dev_key are not read", async () => {
    // The HOME here is the isolated one (isolate-user-dirs.ts); the key file is a fake made for the test.
    const home = homedir();
    // Written only into a temporary home (isolate-user-dirs.ts): never the user's real ~/.ads.
    const temporary = home.startsWith(tmpdir() + sep);
    expect(temporary).toBe(true);
    if (!temporary) return;
    mkdirSync(join(home, ".ads"), { recursive: true });
    writeFileSync(join(home, ".ads", "dev_key"), "from-file\n", "utf-8");
    const xdg = xdgWithConfig('ads_dev_key = "from-config"\n');
    setEnv("ADS_DEV_KEY", "from-env");
    try {
      const empty = { get: async () => ({ status: "not-found" as const }) };
      expect(await readAdsToken(empty)).toBeNull();
      // The default store: no keychain in the tests (isolate-user-dirs.ts) and no fallback file, so no token.
      expect(await readAdsToken()).toBeNull();
    } finally {
      setEnv("ADS_DEV_KEY", undefined);
      rmSync(join(home, ".ads"), { recursive: true, force: true });
      rmSync(xdg, { recursive: true, force: true });
    }
  });

  test("the saved token, trimmed; an unavailable keychain or a damaged file is no token, not an error", async () => {
    const saved = {
      get: async () => ({
        status: "ok" as const,
        password: " tok-1 ",
        protection: "keychain" as const,
        keychainProtected: true,
      }),
    };
    expect(await readAdsToken(saved)).toBe("tok-1");
    const blank = {
      get: async () => ({
        status: "ok" as const,
        password: "  ",
        protection: "file" as const,
        keychainProtected: false,
      }),
    };
    expect(await readAdsToken(blank)).toBeNull();
    expect(
      await readAdsToken({ get: async () => ({ status: "keychain-unavailable" as const }) })
    ).toBeNull();
    expect(
      await readAdsToken({
        get: async () => ({ status: "error" as const, code: "file-unreadable" as const }),
      })
    ).toBeNull();
    expect(
      await readAdsToken({
        get: async () => {
          throw new Error("boom");
        },
      })
    ).toBeNull();
  });
});

describe("readAdsToken: a keychain that does not answer in time (ticket 12 revision)", () => {
  test("a read that hangs is no token after the timeout; nothing is left to hold the process", async () => {
    const hanging = { get: () => new Promise<never>(() => {}) };
    const started = Date.now();
    expect(await readAdsToken(hanging, { timeoutMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(ADS_TOKEN_READ_TIMEOUT_MS).toBe(5000);
  });

  test("a read that answers before the timeout is used", async () => {
    const slow = {
      get: () =>
        new Promise<{
          status: "ok";
          password: string;
          protection: "keychain";
          keychainProtected: true;
        }>((ok) =>
          setTimeout(
            () =>
              ok({
                status: "ok",
                password: "tok-2",
                protection: "keychain",
                keychainProtected: true,
              }),
            10
          )
        ),
    };
    expect(await readAdsToken(slow, { timeoutMs: 1000 })).toBe("tok-2");
  });
});

describe("readOpenAlexApiKey: a blank key is no key (ticket 09 reminder, aligned in ticket 12)", () => {
  test("blank in the config or the environment is null", () => {
    expect(readOpenAlexApiKey({}, { openalex_api_key: "   " })).toBeNull();
    expect(readOpenAlexApiKey({}, { openalex_api_key: "" })).toBeNull();
    expect(readOpenAlexApiKey({ OPENALEX_API_KEY: " " }, { openalex_api_key: "K" })).toBe("K");
    expect(readOpenAlexApiKey({}, { openalex_api_key: "K" })).toBe("K");
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
    await oa.resolve({ doi: "10.1/x" });
    expect(calls[0]?.url).toContain("api_key=CFG-1");
  });

  test("env beats config; explicit null beats both", async () => {
    xdgWithConfig('openalex_api_key = "CFG-1"\n');
    setEnv("OPENALEX_API_KEY", "ENV-1");
    const { fetchImpl, calls } = stubFetch(() => jsonResponse({ results: [] }));
    const cacheDir = mkdtempSync(join(tmpdir(), "aspace-oa-"));
    await new OpenAlexClient({ cacheDir, delay: 0, fetchImpl }).resolve({ doi: "10.1/one" });
    expect(calls[0]?.url).toContain("api_key=ENV-1");
    await new OpenAlexClient({ cacheDir, delay: 0, apiKey: null, fetchImpl }).resolve({
      doi: "10.1/two",
    });
    expect(calls[1]?.url).not.toContain("api_key=");
  });
});

describe("log_level and the keys a file has", () => {
  test("log_level is one of the four levels; anything else names the key, never the value", () => {
    expect(parseConfigToml('log_level = "debug"', "/p").log_level).toBe("debug");
    expect(parseConfigToml("", "/p").log_level).toBeUndefined();
    for (const toml of ['log_level = "LOUD-marker"', "log_level = 3", "log_level = true"]) {
      let err: unknown;
      try {
        parseConfigToml(toml, "/p/config.toml");
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toBe(
        '/p/config.toml: "log_level" must be one of debug, info, warn, error'
      );
    }
  });

  test("a file with an older fault and a bad log_level still reports the older fault", () => {
    expect(() => parseConfigToml('log_level = "x"\nport = 1.5', "/p")).toThrow(
      '/p: "port" must be an integer between 0 and 65535'
    );
    expect(() => parseConfigToml('log_level = "x"\ndata_dir = "/abs"', "/p")).toThrow(
      '/p: "data_dir" must be a relative path'
    );
  });

  test("configFileKeys names the keys this build reads and only counts the others", () => {
    const xdg = xdgWithConfig(
      'port = 1900\nmy_private_key_name = "v"\nlog_level = "debug"\n[ui]\ntheme = "dark"\n'
    );
    const path = join(xdg, "argelanderspace", "config.toml");
    expect(configFileKeys(path)).toEqual({ known: ["port", "log_level", "ui.theme"], unknown: 1 });
    expect(configFileKeys()).toEqual({ known: ["port", "log_level", "ui.theme"], unknown: 1 });
    expect(configFileKeys(join(xdg, "missing.toml"))).toEqual({ known: [], unknown: 0 });
    writeFileSync(path, "this is = = not toml", "utf-8");
    expect(configFileKeys(path)).toEqual({ known: [], unknown: 0 });
  });
});
