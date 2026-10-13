/**
 * `resolveDataDir` precedence (decision 23): `--data-dir` flag > config
 * `data_dir` > `./literatures`. Pure unit tests (the config object is
 * injected; the agent and smoke suites cover the built binary, including that
 * the workbench's former environment variables change nothing).
 */

import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveDataDir } from "../src/program.js";

afterEach(() => {
  delete process.env.ARGELANDERSPACE_DATA_DIR;
});

describe("resolveDataDir", () => {
  test("defaults to ./literatures (process cwd)", () => {
    expect(resolveDataDir({}, {})).toBe(resolve("./literatures"));
  });

  test("config file beats the default; flag beats config and may be absolute", () => {
    expect(resolveDataDir({}, { data_dir: "from-config" })).toBe(resolve("from-config"));
    expect(resolveDataDir({ dataDir: "/from-flag" }, { data_dir: "from-config" })).toBe(
      "/from-flag"
    );
  });

  test("the removed environment variable changes nothing", () => {
    process.env.ARGELANDERSPACE_DATA_DIR = "/from-env";
    expect(resolveDataDir({}, {})).toBe(resolve("./literatures"));
    expect(resolveDataDir({}, { data_dir: "from-config" })).toBe(resolve("from-config"));
  });

  test("a relative config data_dir resolves against the process cwd", () => {
    expect(resolveDataDir({}, { data_dir: "papers" })).toBe(resolve("papers"));
  });
});
