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
  configFilePath,
  configOfReading,
  pinnedGlobalDirs,
  readSettingsText,
  resolveGlobalDirs,
  resolveLogDir,
} from "@argelanderspace/infra";
import { afterEach, describe, expect, test, vi } from "vitest";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import type { HostBridge } from "../src/host-routes.js";
import {
  createServer,
  type RunningServer,
  resolveServerConfig,
  type ServeStart,
  serveStart,
  startNoProjectServer,
  startServer,
} from "../src/server.js";
import { isolatedGlobalDirs, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

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

  test("`data_dir` written as an absolute path: the server starts on the default data location and names the key", async () => {
    writeConfig('data_dir = "/zqxmark/elsewhere"\nport = "also wrong"\n');
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "aspace-settings-serve-cwd-"));
    roots.push(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const srv = await startServer(["--port", "0", "--web-dist", cwd]);
    running.push(srv);
    const url = `http://127.0.0.1:${await srv.ready()}`;
    expect(srv.paths.dataDir).toBe(join(cwd, "literatures"));
    expect((await settings(url)).problems).toEqual([
      { key: "data_dir", reason: "must_be_relative" },
      { key: "port", reason: "wrong_type" },
    ]);
    const terminal = errors.join("\n");
    expect(terminal).toContain('"data_dir" must be a relative path');
    expect(terminal).toContain(
      "project data: the default location ./literatures is in use, not the one the file names"
    );
    expect(terminal).toContain('"port" has the wrong type: its default is in use');
    expect(terminal).not.toMatch(/zqxmark|also wrong/);
  });

  test("the start record lists the problems by key and category, never a value", async () => {
    writeConfig('openalex_api_key = "zqxsecret"\n[ui]\ntheme = 3\n');
    vi.spyOn(console, "error").mockImplementation(() => {});
    const dataDir = project();
    await serve(dataDir);
    for (const srv of running.splice(0)) await srv.close();
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = resolveLogDir({ config: {} });
    const text = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), "utf-8"))
      .join("");
    const started = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { event?: string; config_problems?: string[] })
      .find((record) => record.event === "server.started");
    expect(started?.config_problems).toEqual(["ui.theme:wrong_type"]);
    expect(text).not.toContain("zqxsecret");
  });

  test("a file that is not TOML: the start record and the terminal say every default is in use, the data location too", async () => {
    writeConfig('openalex_api_key = "zqxsecret"\n[ui\n');
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    await serve(project());
    const terminal = errors.join("\n");
    expect(terminal).toContain("the file is not valid TOML: every setting has its default");
    // Project data comes from --data-dir here, and an unreadable file says nothing against it; the global
    // directories are the defaults, and the file names nothing that could be told.
    expect(terminal).not.toContain("project data:");
    expect(terminal).toContain(
      "global data (Mail, credentials, log): the default directory is in use, the file could not be read"
    );
    expect(terminal).not.toMatch(/zqxsecret|\^/);
    for (const srv of running.splice(0)) await srv.close();
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = resolveLogDir({ config: {} });
    const text = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), "utf-8"))
      .join("");
    expect(text).toContain('"config_problems":["file:unparseable"]');
    expect(text).not.toContain("zqxsecret");
  });
});

describe("the locations the process uses are the ones of its start, not the file as it is now", () => {
  async function serveIn(
    argv: string[] = []
  ): Promise<{ url: string; cwd: string; errors: string[] }> {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => {
      errors.push(String(line));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const cwd = mkdtempSync(join(tmpdir(), "aspace-settings-serve-cwd-"));
    roots.push(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    const srv = await startServer(["--port", "0", "--web-dist", cwd, ...argv]);
    running.push(srv);
    return { url: `http://127.0.0.1:${await srv.ready()}`, cwd, errors };
  }
  const fine = { source: "default", problem: null };

  test("(a) a good data_dir broken while running: the process keeps the file's location; the page says so", async () => {
    const file = writeConfig('data_dir = "papers"\n');
    const { url } = await serveIn();
    writeFileSync(file, 'data_dir = "papers"\n[ui\n');
    const body = await settings(url);
    expect(body.readonly).toBe(true);
    expect(body.startup).toEqual({
      data_dir: { source: "file", problem: null },
      global_dir: fine,
      global_cache_dir: fine,
    });
  });

  test("(b) data_dir absolute in the file, --data-dir given: the location given on the command line", async () => {
    writeConfig('data_dir = "/zqxmark/abs"\n');
    const dir = mkdtempSync(join(tmpdir(), "aspace-settings-serve-flag-"));
    roots.push(dir);
    const { url, errors } = await serveIn(["--data-dir", join(dir, "data")]);
    expect((await settings(url)).startup?.data_dir).toEqual({
      source: "flag",
      problem: "must_be_relative",
    });
    const terminal = errors.join("\n");
    expect(terminal).toContain("project data: the location given by --data-dir is in use");
    expect(terminal).not.toMatch(/default location|restart|zqxmark/);
  });

  test("(c) a global directory this platform cannot use: the page lists it, as the terminal says", async () => {
    writeConfig('global_dir = "C:\\\\Users\\\\me\\\\aspace"\n');
    const { url, errors } = await serveIn();
    const body = await settings(url);
    expect(body.problems).toEqual([{ key: "global_dir", reason: "must_be_absolute" }]);
    expect(body.startup?.global_dir).toEqual({ source: "default", problem: "must_be_absolute" });
    expect(body.startup?.data_dir).toEqual(fine);
    const terminal = errors.join("\n");
    expect(terminal).toContain('"global_dir" must be an absolute path');
    expect(terminal).toContain(
      "global data (Mail, credentials, log): the default directory is in use"
    );
    expect(terminal).toContain("the settings page lists them too");
    expect(terminal).not.toContain("project data:");
  });

  test("a faulty data_dir repaired while running: the process is still on the default location until a restart", async () => {
    const file = writeConfig('data_dir = "/zqxmark/abs"\n');
    const { url } = await serveIn();
    writeFileSync(file, 'data_dir = "papers"\n');
    const body = await settings(url);
    expect(body.problems).toEqual([]);
    expect(body.startup?.data_dir).toEqual({ source: "default", problem: "must_be_relative" });
  });
});

describe("the global directories are fixed when serve starts", () => {
  test("Mail, the credentials and the log use the directories of the start; a later edit of the file moves nothing", async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "aspace-settings-serve-global-"));
    roots.push(globalRoot);
    const startDir = join(globalRoot, "start");
    const file = writeConfig(`global_dir = "${startDir}"\n`);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const url = await serve(project());
    expect(pinnedGlobalDirs()?.dataDir).toBe(startDir);
    // The log of this run is in the global data directory of the start.
    const { existsSync, readdirSync } = await import("node:fs");
    expect(readdirSync(join(startDir, "logs")).length).toBe(1);
    // The file names another directory, then becomes unreadable as TOML: the run keeps the one of its start.
    writeFileSync(file, `global_dir = "${join(globalRoot, "later")}"\n`);
    expect(resolveGlobalDirs().dataDir).toBe(startDir);
    writeFileSync(file, "global_dir = = 1\n");
    expect(resolveGlobalDirs().dataDir).toBe(startDir);
    const accounts = await fetch(`${url}/api/mail/accounts`);
    expect(accounts.status).toBe(200);
    expect(existsSync(join(globalRoot, "later"))).toBe(false);
    // The pin ends with the server.
    for (const srv of running.splice(0)) await srv.close();
    expect(pinnedGlobalDirs()).toBeNull();
  });

  test("createServer pins the directories it is given and releases them when it closes", async () => {
    const globalRoot = mkdtempSync(join(tmpdir(), "aspace-settings-serve-global-"));
    roots.push(globalRoot);
    const dirs = { dataDir: join(globalRoot, "data"), cacheDir: join(globalRoot, "cache") };
    const srv = createServer({
      dataDir: project(),
      port: 0,
      heartbeatMs: 0,
      webDist: null,
      globalDirs: dirs,
    });
    await srv.ready();
    expect(pinnedGlobalDirs()).toEqual(dirs);
    await srv.close();
    expect(pinnedGlobalDirs()).toBeNull();
  });
});

describe("a start reading handed in (the desktop host's, architecture-deepening ticket 10)", () => {
  /** A desktop host that takes no request: the start needs one, and these tests ask it nothing. */
  const bridge = (project: "open" | "none"): HostBridge => ({
    portFallback: null,
    requests: [],
    request: () => false,
    cli: null,
    project,
    recent: {
      list: () => ({ version: 1, projects: [], lastMissing: null }),
      open: () => "unknown_project",
      remove: () => ({ version: 1, projects: [], lastMissing: null }),
    },
    switching: { confirm: () => "unknown_switch", cancel: () => {} },
    useWorkbench: () => {},
    usePages: () => {},
    tutorial: { pick: () => "no_sample", continue: () => "no_sample", restart: () => "no_sample" },
  });

  /**
   * The file as the host read it at its start, then the file as it is when the server starts: the start must not read
   * it a second time, so everything it fixes comes from the first.
   */
  function handedAndChanged(): {
    reading: ServeStart;
    startDir: string;
    laterDir: string;
    cwd: string;
  } {
    const globalRoot = mkdtempSync(join(tmpdir(), "aspace-settings-serve-handed-"));
    roots.push(globalRoot);
    const startDir = join(globalRoot, "start");
    const laterDir = join(globalRoot, "later");
    writeConfig(`data_dir = "papers"\nglobal_dir = "${startDir}"\nlog_level = "debug"\n`);
    const reading = serveStart(configFilePath());
    writeConfig(`global_dir = "${laterDir}"\nlog_level = "error"\n`);
    const cwd = mkdtempSync(join(tmpdir(), "aspace-settings-serve-handed-cwd-"));
    roots.push(cwd);
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "error").mockImplementation(() => {});
    return { reading, startDir, laterDir, cwd };
  }

  test("startServer: the pin, the log directory, the start locations and the values at the start are the handed-in reading's", async () => {
    const { reading, startDir, laterDir, cwd } = handedAndChanged();
    const srv = await startServer(["--web-dist", cwd], {
      desktop: { host: bridge("open"), listenPort: 0, atStart: reading },
    });
    running.push(srv);
    expect(pinnedGlobalDirs()?.dataDir).toBe(startDir);
    expect(srv.logDir).toBe(join(startDir, "logs"));
    const { existsSync, readdirSync } = await import("node:fs");
    expect(readdirSync(join(startDir, "logs")).length).toBe(1);
    expect(existsSync(laterDir)).toBe(false);
    expect(srv.log.level()).toBe("debug");
    const body = await settings(`http://127.0.0.1:${srv.port}`);
    // The data directory of that reading, against the working directory of the start.
    expect(body.running.data_dir?.path).toBe(join(cwd, "papers"));
    expect(body.startup).toEqual({
      data_dir: { source: "file", problem: null },
      global_dir: { source: "file", problem: null },
      global_cache_dir: { source: "default", problem: null },
    });
    // The file now differs from the reading in `data_dir` and `global_dir`: both are pending a restart, so the values
    // at the start are the reading's, not a second reading of the file (which would leave nothing pending).
    expect(body.values).toMatchObject({ global_dir: laterDir, log_level: "error" });
    expect(body.restartPending).toEqual(["data_dir", "global_dir"]);
  });

  test("startNoProjectServer: the pin, the log directory and the start locations are the handed-in reading's", async () => {
    const { reading, startDir, laterDir, cwd } = handedAndChanged();
    const srv = await startNoProjectServer(["--web-dist", cwd], {
      desktop: { host: bridge("none"), listenPort: 0, atStart: reading },
    });
    running.push(srv as unknown as RunningServer);
    expect(pinnedGlobalDirs()?.dataDir).toBe(startDir);
    expect(srv.logDir).toBe(join(startDir, "logs"));
    const { existsSync } = await import("node:fs");
    expect(existsSync(laterDir)).toBe(false);
    expect(srv.log.level()).toBe("debug");
    const body = await settings(`http://127.0.0.1:${srv.port}`);
    expect(body.running.global_dir.path).toBe(startDir);
    expect(body.startup?.global_dir).toEqual({ source: "file", problem: null });
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

  test("the automatic arXiv fetch reads `auto_ingest_arxiv` leniently at each add: a broken file means its default (on)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-settings-serve-"));
    roots.push(dir);
    const configPath = join(dir, "config.toml");
    const dataDir = project();
    const srv = createServer({
      globalDirs: isolatedGlobalDirs(),
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
