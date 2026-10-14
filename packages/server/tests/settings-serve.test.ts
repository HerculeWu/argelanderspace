/**
 * `serve` and a faulty config.toml (desktop-app ticket 10): the long-running server starts and keeps running where a
 * command stops. The file here is the one `serve` reads by default, which the test setup has put below a throwaway
 * home; it is removed after every test.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { DEFAULT_PORT, type SettingsSnapshot } from "@argelanderspace/contracts";
import {
  ConfigError,
  configFilePath,
  configOfReading,
  readSettingsText,
  resolveLogDir,
} from "@argelanderspace/infra";
import { afterEach, describe, expect, test, vi } from "vitest";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import {
  createServer,
  type RunningServer,
  resolveServerConfig,
  startServer,
} from "../src/server.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const running: RunningServer[] = [];
const roots: string[] = [];

/** `path`, once it is seen to lie below the throwaway home of this test run; anything else is refused. */
function isolated(path: string): string {
  const isolation = (globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] as
    | { root: string }
    | undefined;
  if (!isolation) throw new Error("isolate-user-dirs.ts did not run");
  const rel = relative(isolation.root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("a per-user path of this test run is outside its throwaway home");
  }
  return path;
}

function writeConfig(toml: string): string {
  const file = isolated(configFilePath());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, toml);
  return file;
}

function project(): string {
  const dataDir = makeDataDir();
  roots.push(dirname(dataDir));
  return dataDir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const srv of running.splice(0)) await srv.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(isolated(dirname(configFilePath())), { recursive: true, force: true });
  rmSync(isolated(resolveLogDir()), { recursive: true, force: true });
});

async function serve(dataDir: string): Promise<string> {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const srv = await startServer(["--port", "0", "--data-dir", dataDir, "--web-dist", dataDir]);
  running.push(srv);
  return `http://127.0.0.1:${await srv.ready()}`;
}

const settings = async (url: string): Promise<SettingsSnapshot> =>
  (await (await fetch(`${url}/api/settings`)).json()) as SettingsSnapshot;

describe("serve starts with a faulty config.toml", () => {
  test("a file that is not TOML: the server starts, and the settings say the file is read-only", async () => {
    const text = 'port = 1860\n[ui\ntheme = "dark"\n';
    const file = writeConfig(text);
    const url = await serve(project());
    const body = await settings(url);
    expect(body.path).toBe(file);
    expect(body.file).toBe("unparseable");
    expect(body.readonly).toBe(true);
    expect((await fetch(`${url}/api/papers`)).status).toBe(200);
    // The file was not rewritten.
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(file, "utf-8")).toBe(text);
  });

  test("faulty keys: the server starts with their defaults and names them", async () => {
    writeConfig('port = "eighteen"\nlog_level = 5\nauto_ingest_arxiv = "no"\n');
    const url = await serve(project());
    expect((await settings(url)).problems).toEqual([
      { key: "port", reason: "wrong_type" },
      { key: "auto_ingest_arxiv", reason: "wrong_type" },
      { key: "log_level", reason: "wrong_type" },
    ]);
  });

  test("`data_dir` written as an absolute path still stops the start, naming the key and not the value", async () => {
    const file = writeConfig('data_dir = "/zqxmark/elsewhere"\nport = "also wrong"\n');
    const attempt = startServer(["--port", "0", "--data-dir", project()]);
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toThrow(`${file}: "data_dir" must be a relative path`);
    await expect(attempt).rejects.not.toThrow(/zqxmark/);
  });
});

describe("a config.toml broken while the server runs", () => {
  test("requests that have nothing to do with it go on working, and the settings say what is wrong", async () => {
    const file = writeConfig("port = 1860\n");
    const url = await serve(project());
    expect((await settings(url)).values.port).toBe(1860);
    writeFileSync(file, "port = = 1860\n");
    expect((await fetch(`${url}/api/papers`)).status).toBe(200);
    expect((await fetch(`${url}/api/library`)).status).toBe(200);
    expect((await fetch(`${url}/api/plans`)).status).toBe(200);
    const body = await settings(url);
    expect(body.readonly).toBe(true);
    expect(body.values.port).toBe(DEFAULT_PORT);
  });

  test("adding a work does not fail: the automatic arXiv fetch falls back to its default (on)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-settings-serve-"));
    roots.push(dir);
    const configPath = join(dir, "config.toml");
    const dataDir = project();
    const srv = createServer({
      dataDir,
      port: 0,
      heartbeatMs: 0,
      webDist: null,
      deps: {
        makeSources: () => stubSources(),
        pipelines: stubPipelines(),
        fetchArxivPdf: async () => {
          throw new Error("offline");
        },
      },
      configPath,
    });
    running.push(srv);
    const url = `http://127.0.0.1:${await srv.ready()}`;
    const add = (value: string) =>
      fetch(`${url}/api/library/works`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "identifier", value }),
      });
    const automatic = () =>
      srv.runner.list().filter((job) => (job.payload as { automatic?: boolean }).automatic);

    writeFileSync(configPath, "auto_ingest_arxiv = false\n");
    expect((await add("arXiv:2603.00391")).status).toBe(200);
    expect(automatic()).toHaveLength(0);

    writeFileSync(configPath, "auto_ingest_arxiv = = false\n");
    expect((await add("arXiv:2603.00392")).status).toBe(200);
    expect(automatic()).toHaveLength(1);
  });
});

describe("the config a lenient reading gives the server", () => {
  test("has the file's acceptable values and nothing for a faulty, blank or unset key", () => {
    const reading = readSettingsText(
      'port = 70000\ndata_dir = "papers"\ncontact_email = "  "\nlog_level = "debug"\n[ui]\ntheme = "light"\ndensity = 7\n'
    );
    expect(configOfReading(reading)).toEqual({
      data_dir: "papers",
      log_level: "debug",
      ui: { theme: "light" },
    });
    expect(resolveServerConfig([], "/w", configOfReading(reading)).port).toBe(DEFAULT_PORT);
    expect(configOfReading(readSettingsText("not toml ="))).toEqual({});
  });
});
