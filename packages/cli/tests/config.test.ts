/**
 * `resolveDataDir` (decision 23): the CLI's adapter over infra `dataDirOf`, whose chain — `--data-dir` flag > config
 * `data_dir` > `./literatures` — is tested in infra `config-chain.test.ts`. Pure unit tests (the config object is
 * injected; the agent and smoke suites cover the built binary, including that the workbench's former environment
 * variables change nothing).
 */

import { resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resolveDataDir } from "../src/program.js";

afterEach(() => {
  delete process.env.ARGELANDERSPACE_DATA_DIR;
});

describe("resolveDataDir", () => {
  test("the removed environment variable changes nothing", () => {
    process.env.ARGELANDERSPACE_DATA_DIR = "/from-env";
    expect(resolveDataDir({}, {})).toBe(resolve("./literatures"));
    expect(resolveDataDir({}, { data_dir: "from-config" })).toBe(resolve("from-config"));
  });

  test("a relative config data_dir resolves against the process cwd", () => {
    expect(resolveDataDir({}, { data_dir: "papers" })).toBe(resolve("papers"));
  });
});
