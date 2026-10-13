/**
 * The user-level log, seen from outside (desktop-app ticket 06): real servers on real sockets in temporary project
 * directories, real requests, and then the log files on disk. What is checked is what a developer would read in a
 * log a user sent in — and what must not be in it.
 */

import {
  chmodSync,
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
  f,
  type LogLevel,
  openLogFile,
  resolveLogDir,
} from "@argelanderspace/infra";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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

function isolatedRoot(): string {
  const isolation = (globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] as
    | { root: string }
    | undefined;
  if (!isolation) throw new Error("isolate-user-dirs.ts did not run");
  return isolation.root;
}

/** `path`, once it is seen to lie below the throwaway home of this test run; anything else is refused. */
function isolated(path: string): string {
  const rel = relative(isolatedRoot(), path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      "a per-user path of this test run is outside its throwaway home; not touching it"
    );
  }
  return path;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const srv of running.splice(0)) await srv.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  // Checked before anything is removed: these are the user's own directories if isolation ever fails. The config
  // goes first — a test may have pointed `global_dir` somewhere else, and the log directory is resolved without it.
  rmSync(isolated(dirname(configFilePath())), { recursive: true, force: true });
  rmSync(isolated(resolveLogDir()), { recursive: true, force: true });
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
  test("an unhandled error is recorded with route, status and stack — and the answer and the terminal are what they always were", async () => {
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
    // The terminal still gets the whole error, as it did before there was a log; only the log file is public.
    expect(printed).toHaveBeenCalledTimes(1);
    const shown = printed.mock.calls[0]?.[0] as Error;
    expect(shown).toBeInstanceOf(Error);
    // Its message names the file and quotes the start of what could not be parsed.
    expect(shown.message).toContain(join(dirname(dataDir), "status", "plans.json"));
    expect(shown.message).toContain("PLAN-CONTE");
  });

  test("an error that carries its own response answers exactly as it does without a log", async () => {
    const answer = async (log?: ServerLog) => {
      const app = new Hono();
      if (log) logRequests(app, log);
      app.use("*", async (c, next) => {
        c.header("X-Set-Before", "kept");
        await next();
      });
      app.get("/things/:id", () => {
        throw new HTTPException(418, {
          res: new Response("teapot body", { status: 418, headers: { "X-Own": "own" } }),
        });
      });
      const response = await app.request("/things/ID-MARKER");
      return {
        status: response.status,
        body: await response.text(),
        headers: [...response.headers.entries()].sort(),
      };
    };
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const { log, dir } = fileLog();
    const plain = await answer();
    const logged = await answer(log);
    expect(plain).toMatchObject({ status: 418, body: "teapot body" });
    expect(plain.headers).toContainEqual(["x-set-before", "kept"]);
    expect(logged).toEqual(plain);
    expect(printed).not.toHaveBeenCalled();
    const { records, text } = readLog(dir);
    expect(records).toMatchObject([
      { level: "warn", event: "request.failed", route: "/things/:id", status: 418 },
    ]);
    expect(text).not.toContain("MARKER");
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

describe("a Doc whose id is made from a title or a folder name", () => {
  /** What the identifier field writes for this Doc id. */
  function written(docId: string): string {
    const lines: string[] = [];
    createLogger({ events: SERVER_LOG_EVENTS, sink: { write: (l) => lines.push(l) } }).info(
      "server.started",
      { doc: f.docId(docId) }
    );
    return (JSON.parse(lines[0] as string) as { doc: string }).doc;
  }

  const cases = [
    { docId: "latex-MyPrivateThesisTitle", words: /Private|Thesis|Title/i, kind: "latex-" },
    {
      docId: "upload-work-attention-is-all-you-need-2017-a1b2c3",
      words: /attention|you-need/i,
      kind: "upload-",
    },
  ];

  for (const { docId, words, kind } of cases) {
    for (const route of ["ir", "annotations"] as const) {
      test(`${kind}… on /${route}: a file that cannot be read is named in the log by the id's hash, never by the id`, async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const { log, dir } = fileLog();
        const { url, dataDir } = await serve(log);
        const docDir = join(dataDir, "output", docId);
        mkdirSync(docDir, { recursive: true });
        const file = join(docDir, `${docId}.json`);
        writeFileSync(file, JSON.stringify({ doc_id: docId, meta: { title: "x" } }));
        chmodSync(file, 0o000);

        const response = await fetch(`${url}/api/paper/${docId}/${route}`);
        expect(response.status).toBe(500);
        chmodSync(file, 0o600);

        const { records, text } = readLog(dir);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          level: "error",
          event: "request.failed",
          route: `/api/paper/:doc_id/${route}`,
          status: 500,
        });
        expect(text).not.toMatch(words);
        const hash = written(docId);
        expect(hash).toMatch(new RegExp(`^${kind}#[0-9a-f]{12}$`));
        // The file is still named — by the same hash a record about the Doc itself would carry.
        const paths: string[] = [];
        for (
          let error = (records[0] as { error?: Record_ }).error;
          error;
          error = error.cause as Record_ | undefined
        ) {
          if (typeof error.path === "string") paths.push(error.path);
        }
        expect(paths.length).toBeGreaterThan(0);
        for (const path of paths) {
          expect(path.endsWith(`/output/${hash}/${hash}.json`), path).toBe(true);
        }
      });
    }
  }
});

describe("the answer to a failed request is sent the way it is sent without a log", () => {
  /** A JSON error answer that is not made by `c.json`: its body is a stream, so it goes out in chunks. */
  function streamingApp(log?: ServerLog): Hono {
    const app = new Hono();
    if (log) logRequests(app, log);
    app.get("/stream", () => {
      const encoder = new TextEncoder();
      // One piece: a reader that had the whole body before the answer went out would send it with a length.
      const pieces = [`{"code":"stream_failed","detail":"${"x".repeat(2000)}"}`];
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          await new Promise((resolve) => setTimeout(resolve, 15));
          if (sent < pieces.length) controller.enqueue(encoder.encode(pieces[sent++] as string));
          else controller.close();
        },
      });
      return new Response(body, {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    app.get("/plain", (c) => c.json({ code: "plain_failed", detail: "d" }, 500));
    return app;
  }

  async function over(app: Hono, path: string) {
    const { serve: listen } = await import("@hono/node-server");
    const server = listen({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    try {
      await new Promise<void>((resolve) => server.once("listening", () => resolve()));
      const { port } = server.address() as { port: number };
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      const headers = [...response.headers.entries()]
        .filter(([name]) => name !== "date")
        .sort(([a], [b]) => a.localeCompare(b));
      return { status: response.status, headers, body: await response.text() };
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  test("a streamed JSON error answer keeps its headers and its body; an answer made by c.json keeps its code in the record", async () => {
    const { log, dir } = fileLog();
    const plainStream = await over(streamingApp(), "/stream");
    const loggedStream = await over(streamingApp(log), "/stream");
    expect(plainStream.headers).toContainEqual(["transfer-encoding", "chunked"]);
    expect(plainStream.headers.map(([name]) => name)).not.toContain("content-length");
    expect(loggedStream).toEqual(plainStream);

    const plainJson = await over(streamingApp(), "/plain");
    const loggedJson = await over(streamingApp(log), "/plain");
    expect(loggedJson).toEqual(plainJson);

    const { records } = readLog(dir);
    expect(records).toMatchObject([
      { event: "request.failed", route: "/stream", status: 500 },
      { event: "request.failed", route: "/plain", status: 500, code: "plain_failed" },
    ]);
    // Nothing of the streamed body was read to find a code.
    expect(records[0]?.code).toBeUndefined();
  });

  test("the code is the one of the answer that was sent, not of a body some handler made and dropped", async () => {
    const { log, dir } = fileLog();
    const app = new Hono();
    logRequests(app, log);
    app.get("/dropped", (c) => {
      c.json({ code: "not_sent" }, 500);
      return c.text("fixed text", 500);
    });
    app.get("/other-status", (c) => {
      c.json({ code: "not_sent" }, 400);
      return new Response('{"detail":"d"}', {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    });
    app.get("/not-a-string", (c) => c.json({ code: { text: "SECRET" } } as never, 500));
    app.get("/title", (c) => c.json({ code: "work:my-private-title-2020" }, 500));
    for (const path of ["/dropped", "/other-status", "/not-a-string"]) {
      expect((await app.request(path)).status).toBe(500);
    }
    expect(await (await app.request("/title")).json()).toEqual({
      code: "work:my-private-title-2020",
    });
    const { records, text } = readLog(dir);
    expect(records).toHaveLength(4);
    for (const record of records.slice(0, 3)) expect(record.code).toBeUndefined();
    expect(records[3]?.code).toMatch(/^work:#[0-9a-f]{12}$/);
    expect(text).not.toMatch(/SECRET|private|not_sent/);
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
  test("records nothing, makes no log directory, and prints the error as it always did", async () => {
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    const { url, dataDir } = await serve();
    breakPlans(dataDir, "x");
    expect((await fetch(`${url}/api/plans`)).status).toBe(500);
    expect(existsSync(resolveLogDir())).toBe(false);
    expect(printed).toHaveBeenCalledTimes(1);
    expect(printed.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

describe("what used to be printed by the server", () => {
  test("an arXiv fetch log that cannot be appended to is recorded by job, without the reason's words", async () => {
    const { log, dir } = fileLog();
    const dataDir = project();
    // A fetch that was running when the last server stopped …
    const jobId = "ingest-3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b";
    mkdirSync(join(dataDir, "jobs"), { recursive: true });
    writeFileSync(
      join(dataDir, "jobs", `${jobId}.json`),
      JSON.stringify({
        id: jobId,
        kind: "ingest",
        status: "running",
        createdAt: "2026-10-13T08:00:00.000Z",
        payload: { workId: "work:a-private-title-2024", arxivId: "2603.00301" },
      })
    );
    // … and a file where the project's own `logs/` directory should be.
    writeFileSync(join(dataDir, "logs"), "FETCH-LOG-MARKER");
    const srv = createServer({
      dataDir,
      port: 0,
      heartbeatMs: 0,
      webDist: null,
      deps: { makeSources: () => stubSources() },
      log,
    });
    running.push(srv);
    await srv.ready();
    const { records, text } = readLog(dir);
    expect(records).toMatchObject([
      {
        level: "error",
        event: "arxiv_fetch.log_append_failed",
        job: jobId,
        error: { name: "Error", syscall: "mkdir" },
      },
    ]);
    expect(text).not.toMatch(/MARKER|private|title/);
    expect(readFileSync(join(dataDir, "logs"), "utf8")).toBe("FETCH-LOG-MARKER");
  });
});

describe("serve (startServer)", () => {
  function writeConfig(toml: string): void {
    const file = isolated(configFilePath());
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, toml);
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

    const logDir = isolated(resolveLogDir());
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
    // Without a log file the terminal is still told about a request that failed, as before.
    const printed = vi.spyOn(console, "error").mockImplementation(() => {});
    breakPlans(dataDir, "x");
    const failed = await fetch(`${url}/api/plans`);
    expect([failed.status, await failed.text()]).toEqual([500, "Internal Server Error"]);
    expect(printed).toHaveBeenCalledTimes(1);
    expect(printed.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  test("a server that cannot be created leaves no watch on the process and no open log", async () => {
    const before = process.listenerCount("uncaughtExceptionMonitor");
    // A file where the project data directory should be: the server cannot make its job directory.
    const root = mkdtempSync(join(tmpdir(), "aspace-nodata-"));
    roots.push(root);
    const dataDir = join(root, "literatures");
    writeFileSync(dataDir, "not a directory");
    const printed = vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(startServer(["--port", "0", "--data-dir", dataDir])).rejects.toMatchObject({
      code: expect.stringMatching(/^(ENOTDIR|EEXIST)$/),
    });
    expect(printed).not.toHaveBeenCalled();
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(before);
    // The log file this start opened is closed: it can be removed and the directory with it (also on Windows).
    const logDir = isolated(resolveLogDir());
    expect(readLog(logDir).records).toEqual([]);
    rmSync(logDir, { recursive: true, force: true });
    expect(existsSync(logDir)).toBe(false);
  });
});
