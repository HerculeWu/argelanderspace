/**
 * The two one-line chains that `serve`, the desktop host and the CLI share (architecture-deepening ticket 10): the
 * data directory — an override (`--data-dir`) > config `data_dir` > `./literatures`, resolved against the process's
 * working directory — and the configured port — config `port` > `DEFAULT_PORT` (1859). They take a config that was
 * already read (strictly by the CLI, leniently by `serve` and the host) and read no file; no environment variable
 * takes part.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_DATA_DIR, DEFAULT_PORT } from "@argelanderspace/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { dataDirOf, portOf } from "../src/config-chain.js";

const cwd = process.cwd();
const roots: string[] = [];

afterEach(() => {
  process.chdir(cwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.ARGELANDERSPACE_DATA_DIR;
  delete process.env.ARGELANDERSPACE_PORT;
});

describe("dataDirOf", () => {
  test("the default is ./literatures", () => {
    expect(DEFAULT_DATA_DIR).toBe("./literatures");
    expect(dataDirOf({})).toBe(resolve("./literatures"));
  });

  test("override > config data_dir > default; an override may be absolute", () => {
    expect(dataDirOf({ data_dir: "from-config" })).toBe(resolve("from-config"));
    expect(dataDirOf({ data_dir: "from-config" }, "/from-flag")).toBe("/from-flag");
    expect(dataDirOf({}, "rel-flag")).toBe(resolve("rel-flag"));
    expect(dataDirOf({ data_dir: "from-config" }, undefined)).toBe(resolve("from-config"));
  });

  test("a relative path resolves against the process's working directory at the call", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "aspace-chain-")));
    roots.push(dir);
    process.chdir(dir);
    expect(dataDirOf({ data_dir: "papers" })).toBe(join(dir, "papers"));
    expect(dataDirOf({})).toBe(join(dir, "literatures"));
  });

  test("the workbench's former environment variable takes no part", () => {
    process.env.ARGELANDERSPACE_DATA_DIR = "/from-env";
    expect(dataDirOf({})).toBe(resolve("./literatures"));
  });
});

describe("portOf", () => {
  test("config port > 1859", () => {
    expect(DEFAULT_PORT).toBe(1859);
    expect(portOf({})).toBe(1859);
    expect(portOf({ port: 8123 })).toBe(8123);
    expect(portOf({ port: 0 })).toBe(0);
  });

  test("the workbench's former environment variable takes no part", () => {
    process.env.ARGELANDERSPACE_PORT = "9002";
    expect(portOf({})).toBe(1859);
  });
});
