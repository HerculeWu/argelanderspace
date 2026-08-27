/**
 * `resolveDataDir` precedence (decision 23): `--data-dir` flag >
 * `ARGELANDERSPACE_DATA_DIR` > config `data_dir` > `./data`. Pure unit tests
 * (the config object is injected; the smoke suite covers the built binary).
 */

import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { resolveDataDir } from "../src/program.js";

describe("resolveDataDir", () => {
  test("defaults to ./data (process cwd)", () => {
    expect(resolveDataDir({}, {}, {})).toBe(resolve("./data"));
  });

  test("config file beats the default; env beats config; flag beats env", () => {
    expect(resolveDataDir({}, {}, { data_dir: "/from-config" })).toBe("/from-config");
    expect(
      resolveDataDir({}, { ARGELANDERSPACE_DATA_DIR: "/from-env" }, { data_dir: "/from-config" })
    ).toBe("/from-env");
    expect(
      resolveDataDir(
        { dataDir: "/from-flag" },
        { ARGELANDERSPACE_DATA_DIR: "/from-env" },
        { data_dir: "/from-config" }
      )
    ).toBe("/from-flag");
  });

  test("a relative config data_dir resolves against the process cwd (like env)", () => {
    expect(resolveDataDir({}, {}, { data_dir: "papers" })).toBe(resolve("papers"));
  });
});
