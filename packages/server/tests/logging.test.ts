/**
 * The user-level log, seen from outside (desktop-app ticket 06): real servers on real sockets in temporary project
 * directories, real requests, and then the log files on disk. What is checked is what a developer would read in a
 * log a user sent in — and what must not be in it.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { libraryPaths } from "@argelanderspace/core";
import {
  configFilePath,
  createLogger,
  type LogLevel,
  openLogFile,
  resolveLogDir,
} from "@argelanderspace/infra";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vitest";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { logRequests, SERVER_LOG_EVENTS, type ServerLog } from "../src/log.js";
import { createServer, type RunningServer, startServer } from "../src/server.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";

type Record_ = Record<string, unknown>;

const running: RunningServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const srv of running.splice(0)) await srv.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(dirname(configFilePath()), { recursive: true, force: true });
  rmSync(resolveLogDir(), { recursive: true, force: true });
});

/** A log that writes a file in its own temporary directory. */
function fileLog(level?: LogLevel): { log: ServerLog; dir: string } {
  const dir = join(mkdtempSync(join(tmpdir(), "aspace-logs-")), "logs");
  roots.push(dirname(dir));
  const sink = openLogFile({ dir, process: "serve" });
  return {
    log: createLogger({ events: SERVER_LOG_EVENTS, sink, ...(level ? { level } : {}) }),
    dir,
  };
}

/** Every record in every file of a log directory, and the raw text of all of them. */
function readLog(dir: string): { records: Record_[]; text: string; files: string[] } {
  const files = existsSync(dir) ? readdirSync(dir).sort() : [];
  const text = files.map((name) => readFileSync(join(dir, name), "utf8")).join("");
  const records = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record_);
  return { records, text, files };
}

function project(): string {
  const dataDir = makeDataDir();
  roots.push(dirname(dataDir));
  return dataDir;
}

async function serve(log?: ServerLog): Promise<{ url: string; dataDir: string }> {
  const dataDir = project();
  const srv = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    ...(log ? { log } : {}),
  });
  running.push(srv);
  return { url: `http://127.0.0.1:${await srv.ready()}`, dataDir };
}

function breakPlans(dataDir: string, marker: string): void {
  mkdirSync(join(dirname(dataDir), "status"), { recursive: true });
  writeFileSync(join(dirname(dataDir), "status", "plans.json"), `{ "plans": ${marker}`);
}

describe("a failed request", () => {
  test("an unhandled error is recorded with route, status and stack — and the answer is the one it always was", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const { log, dir } = fileLog();
    const { url, dataDir } = await serve(log);
    breakPlans(dataDir, "PLAN-CONTENT-MARKER");

    const response = await fetch(`${url}/api/plans`);
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await response.text()).toBe("Internal Server Error");

    const { records, text } = readLog(dir);
    expect(records).toHaveLength(1);
    const record = records[0] as Record_;
    expect(record).toMatchObject({
      level: "error",
      event: "request.failed",
      method: "GET",
      route: "/api/plans",
      status: 500,
    });
    expect(typeof record.duration_ms).toBe("number");
    const error = record.error as { name: string; message?: string; stack: string[] };
    expect(error.name).toBe("Error");
    // The message names the file and quotes what could not be parsed; the log must not.
    expect(error.message).toBeUndefined();
    expect(text).not.toContain("PLAN-CONTENT-MARKER");
    expect(error.stack.length).toBeGreaterThan(0);
    for (const frame of error.stack) expect(frame).toMatch(/:\d+:\d+$/);
    // The error went to the log instead of the terminal.
    expect(printed).not.toHaveBeenCalled();
  });

  test("the route is the pattern, never the path that was asked for", async () => {
    const { log, dir } = fileLog();
    const { url } = await serve(log);
    const response = await fetch(`${url}/api/paper/DOC-ID-MARKER-42`, { method: "DELETE" });
    expect(response.status).toBe(404);
    const { records, text } = readLog(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "warn",
      event: "request.failed",
      method: "DELETE",
      route: "/api/paper/:doc_id",
      status: 404,
    });
    expect(text).not.toContain("DOC-ID-MARKER");
  });

  test("a refused request is recorded at warn; a GET that finds nothing is not a failure", async () => {
    const { log, dir } = fileLog();
    const { url } = await serve(log);
    const refused = await fetch(`${url}/api/plans`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ detail: "cross-site request rejected" });
    expect((await fetch(`${url}/api/paper/no-such-doc/ir`)).status).toBe(404);
    expect((await fetch(`${url}/no/such/page?q=QUERY-MARKER`)).status).toBe(404);
    expect((await fetch(`${url}/api/papers`)).status).toBe(200);

    const { records, text } = readLog(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "warn",
      event: "request.failed",
      method: "PUT",
      route: "/api/plans",
      status: 403,
    });
    expect(records[0]?.error).toBeUndefined();
    expect(text).not.toContain("QUERY-MARKER");
  });

  test("a sub-route with its own fixed answer keeps it, and the record carries its code", async () => {
    const { log, dir } = fileLog();
    const dataDir = project();
    const app = createApp({
      paths: libraryPaths(dataDir),
      statusDir: join(dirname(dataDir), "status"),
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner: new JobRunner({ dir: join(dataDir, "jobs") }),
      mailAccounts: {
        list() {
          throw new Error("accounts file of someone@MAIL-MARKER.example is damaged");
        },
      } as never,
      log,
    });
    const response = await app.request("/api/mail/accounts");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "storage",
      detail: "mail account storage failed",
    });
    const { records, text } = readLog(dir);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "error",
      event: "request.failed",
      method: "GET",
      route: "/api/mail/accounts",
      status: 500,
      code: "storage",
    });
    expect(records[0]).toMatchObject({ error: { name: "Error" } });
    expect(text).not.toContain("MAIL-MARKER");
  });
});

describe("a route that throws something that is not an error", () => {
  test("is recorded by kind, and still reaches whoever handled it before", async () => {
    const { log, dir } = fileLog();
    const app = new Hono();
    logRequests(app, log);
    app.get("/things/:id", () => {
      throw "THROWN-MARKER text";
    });
    await expect(app.request("/things/ID-MARKER")).rejects.toBe("THROWN-MARKER text");
    const { records, text } = readLog(dir);
    expect(records).toMatchObject([
      {
        level: "error",
        event: "request.failed",
        method: "GET",
        route: "/things/:id",
        error: { name: "NonError", thrown: "string" },
      },
    ]);
    expect(records[0]?.status).toBeUndefined();
    expect(text).not.toContain("MARKER");
  });
});

describe("the level", () => {
  test("successful requests are recorded only at debug", async () => {
    const info = fileLog();
    const atInfo = await serve(info.log);
    expect((await fetch(`${atInfo.url}/api/papers`)).status).toBe(200);
    expect(readLog(info.dir).records).toEqual([]);

    const debug = fileLog("debug");
    const atDebug = await serve(debug.log);
    expect((await fetch(`${atDebug.url}/api/papers`)).status).toBe(200);
    expect((await fetch(`${atDebug.url}/api/paper/GONE-MARKER/ir`)).status).toBe(404);
    const { records, text } = readLog(debug.dir);
    expect(records).toMatchObject([
      {
        level: "debug",
        event: "request.completed",
        method: "GET",
        route: "/api/papers",
        status: 200,
      },
      {
        level: "debug",
        event: "request.completed",
        method: "GET",
        route: "/api/paper/:doc_id/ir",
        status: 404,
      },
    ]);
    expect(text).not.toContain("GONE-MARKER");
  });

  test("changing the level of a running server's log takes effect on the next request", async () => {
    const { log, dir } = fileLog();
    const { url } = await serve(log);
    await fetch(`${url}/api/papers`);
    expect(readLog(dir).records).toHaveLength(0);
    log.setLevel("debug");
    await fetch(`${url}/api/papers`);
    expect(readLog(dir).records).toHaveLength(1);
    log.setLevel("info");
    await fetch(`${url}/api/papers`);
    expect(readLog(dir).records).toHaveLength(1);
  });
});

describe("a server nobody gave a log", () => {
  test("records nothing and makes no log directory", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { url, dataDir } = await serve();
    breakPlans(dataDir, "x");
    expect((await fetch(`${url}/api/plans`)).status).toBe(500);
    expect(existsSync(resolveLogDir())).toBe(false);
  });
});

describe("serve (startServer)", () => {
  function isolatedRoot(): string {
    const isolation = (globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] as
      | { root: string }
      | undefined;
    if (!isolation) throw new Error("isolate-user-dirs.ts did not run");
    return isolation.root;
  }

  function writeConfig(toml: string): void {
    mkdirSync(dirname(configFilePath()), { recursive: true });
    writeFileSync(configFilePath(), toml);
  }

  async function start(dataDir: string): Promise<{ url: string; lines: string[] }> {
    const lines: string[] = [];
    const printed = vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(line);
    });
    const srv = await startServer(["--port", "0", "--data-dir", dataDir, "--web-dist", dataDir], {
      version: "9.8.7",
    });
    printed.mockRestore();
    running.push(srv);
    const port = await srv.ready();
    return { url: `http://127.0.0.1:${port}`, lines };
  }

  test("prints its three lines unchanged and writes its log below the global data directory", async () => {
    const dataDir = project();
    const { url, lines } = await start(dataDir);
    expect(lines).toEqual([
      `ArgelanderSpace server listening on ${url}`,
      `  data dir: ${dataDir}`,
      `  web dist: ${dataDir}`,
    ]);

    const logDir = resolveLogDir();
    const rel = relative(isolatedRoot(), logDir);
    expect(rel.startsWith("..") || isAbsolute(rel)).toBe(false);
    const { records, files } = readLog(logDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(new RegExp(`^\\d{8}T\\d{9}Z-serve-${process.pid}\\.jsonl$`));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: "info",
      event: "server.started",
      version: "9.8.7",
      mode: "browser",
      port: Number(new URL(url).port),
      config_keys: [],
      config_unknown_keys: 0,
      log_level: "info",
      pid: process.pid,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    });
  });

  test("the start record names the config keys and none of their values; paths lose the home directory", async () => {
    writeConfig(
      [
        'ads_dev_key = "VALUE-MARKER-ADS"',
        'openalex_api_key = "VALUE-MARKER-OPENALEX"',
        'data_dir = "VALUE-MARKER-DATA"',
        "auto_ingest_arxiv = false",
        'log_level = "debug"',
        'KEYNAME-MARKER = "VALUE-MARKER-UNKNOWN"',
        "[VALUE-MARKER-TABLE]",
        'inner = "VALUE-MARKER-INNER"',
      ].join("\n")
    );
    // A project below the (isolated) home directory, as a user's would be.
    const home = process.env.HOME as string;
    const dataDir = join(home, "research", "literatures");
    mkdirSync(dataDir, { recursive: true });
    const { url } = await start(dataDir);
    expect((await fetch(`${url}/api/papers`)).status).toBe(200);

    const { records, text } = readLog(resolveLogDir());
    expect(text).not.toContain("MARKER");
    expect(text).not.toContain(home);
    expect(records[0]).toMatchObject({
      event: "server.started",
      data_dir: "~/research/literatures",
      web_dist: "~/research/literatures",
      config_keys: [
        "data_dir",
        "openalex_api_key",
        "ads_dev_key",
        "auto_ingest_arxiv",
        "log_level",
      ],
      config_unknown_keys: 2,
      log_level: "debug",
    });
    // log_level = "debug" in config.toml: the successful request is there.
    expect(records.slice(1)).toMatchObject([
      { level: "debug", event: "request.completed", route: "/api/papers", status: 200 },
    ]);
  });

  test("closing the server stops watching the process", async () => {
    const before = process.listenerCount("uncaughtExceptionMonitor");
    const dataDir = project();
    await start(dataDir);
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before + 1);
    await running.pop()?.close();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before);
  });

  test("a log directory that cannot be made does not stop the server", async () => {
    // A file where the global data directory should be.
    const blocker = join(mkdtempSync(join(tmpdir(), "aspace-blocked-")), "global");
    roots.push(dirname(blocker));
    writeFileSync(blocker, "not a directory");
    writeConfig(`global_dir = ${JSON.stringify(blocker)}\n`);
    const dataDir = project();
    const { url, lines } = await start(dataDir);
    expect(lines).toHaveLength(3);
    expect((await fetch(`${url}/api/papers`)).status).toBe(200);
    expect(readFileSync(blocker, "utf8")).toBe("not a directory");
  });
});
