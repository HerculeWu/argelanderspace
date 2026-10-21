/**
 * `GET/PUT /api/tutorial` (in-app-tutorial ticket 18; contracts `tutorial.ts`): real servers on a port, real requests,
 * the bytes of `tutorial.json` on disk. The progress file is the one in this test file's throwaway global data
 * directory (`isolatedGlobalDirs`); the bundled sample and the tutorial projects are temporary folders with a marker
 * written by the test.
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
import { join } from "node:path";
import type { TutorialProgress, TutorialState } from "@argelanderspace/contracts";
import { createLogger, TUTORIAL_MARKER_FILE, TUTORIAL_PROGRESS_FILE } from "@argelanderspace/infra";
import { afterEach, describe, expect, test } from "vitest";
import { createMemorySink, type MemorySink } from "../../infra/tests/log-memory-sink.js";
import type { HostBridge } from "../src/host-routes.js";
import { SERVER_LOG_EVENTS } from "../src/log.js";
import { createNoProjectServer } from "../src/no-project.js";
import { createServer } from "../src/server.js";
import { isolatedGlobalDirs, makeDataDir, stubPipelines } from "./helpers.js";

const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
const progressFile = () => join(isolatedGlobalDirs().dataDir, TUTORIAL_PROGRESS_FILE);

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  const dir = isolatedGlobalDirs().dataDir;
  if (existsSync(dir)) chmodSync(dir, 0o700);
  rmSync(progressFile(), { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function folder(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `aspace-tutorial-${name}-`));
  roots.push(root);
  return root;
}

/** A folder with the tutorial marker of sample `n` at its root. */
function marked(name: string, n: number): string {
  const dir = folder(name);
  writeFileSync(join(dir, TUTORIAL_MARKER_FILE), JSON.stringify({ version: 1, sample: n }));
  return dir;
}

function progress(path: string | null): TutorialProgress {
  return {
    version: 1,
    project: path === null ? null : { path },
    startedAt: "2026-10-21T08:00:00.000Z",
    updatedAt: "2026-10-21T09:00:00.000Z",
    position: "library.add-bibtex",
    steps: { "welcome.intro": { state: "done", at: "2026-10-21T08:01:00.000Z" } },
    appVersion: "0.2.0",
  };
}

function writeProgressBytes(text: string): void {
  mkdirSync(isolatedGlobalDirs().dataDir, { recursive: true });
  writeFileSync(progressFile(), text);
}

interface Client {
  url: string;
  sink: MemorySink;
  get(): Promise<{ status: number; body: unknown; cache: string | null }>;
  put(body: unknown): Promise<{ status: number; body: unknown }>;
}

function client(url: string, sink: MemorySink): Client {
  return {
    url,
    sink,
    async get() {
      const r = await fetch(`${url}/api/tutorial`);
      return { status: r.status, body: await r.json(), cache: r.headers.get("cache-control") };
    },
    async put(body) {
      const r = await fetch(`${url}/api/tutorial`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: url },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    },
  };
}

/** The browser form: a server with a project and no host. */
async function browserServer(opts: { sample?: string } = {}): Promise<Client> {
  const sink = createMemorySink();
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir: makeDataDir(),
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    fetchImpl: async () => new Response("not found", { status: 404 }),
    deps: { pipelines: stubPipelines() },
    log: createLogger({ events: SERVER_LOG_EVENTS, sink, level: "debug" }),
    ...(opts.sample === undefined ? {} : { tutorialSampleDir: opts.sample }),
  });
  closers.push(() => srv.close());
  const port = await srv.ready();
  return client(`http://127.0.0.1:${port}`, sink);
}

/** The desktop app's welcome state: no project open. */
async function welcomeServer(opts: { sample?: string } = {}): Promise<Client> {
  const sink = createMemorySink();
  const srv = createNoProjectServer({
    host: {} as HostBridge,
    globalDirs: isolatedGlobalDirs(),
    heartbeatMs: 0,
    webDist: null,
    log: createLogger({ events: SERVER_LOG_EVENTS, sink, level: "debug" }),
    ...(opts.sample === undefined ? {} : { tutorialSampleDir: opts.sample }),
  });
  closers.push(() => srv.close());
  const port = await srv.ready();
  return client(`http://127.0.0.1:${port}`, sink);
}

const events = (sink: MemorySink, name: string) =>
  sink
    .records()
    .filter((r) => r.event === name)
    .map(({ t: _t, level: _level, event: _event, ...fields }) => fields);

describe("GET /api/tutorial", () => {
  test("no file: no progress, no project; no-store", async () => {
    const h = await browserServer({ sample: marked("sample", 3) });
    const got = await h.get();
    expect(got.status).toBe(200);
    expect(got.cache).toBe("no-store");
    expect(got.body).toEqual({
      progress: null,
      project: null,
      sample: { bundled: 3, project: null },
    } satisfies TutorialState);
    expect(existsSync(progressFile())).toBe(false);
  });

  test("bound to a folder with the marker: `ready`, and that folder's sample number", async () => {
    const project = marked("project", 2);
    writeProgressBytes(JSON.stringify(progress(project)));
    const h = await browserServer({ sample: marked("sample", 3) });
    expect((await h.get()).body).toEqual({
      progress: progress(project),
      project: { path: project, state: "ready" },
      sample: { bundled: 3, project: 2 },
    });
  });

  test("the bound folder is gone: `missing`; there without a marker: `unmarked` — looked at for each answer", async () => {
    const project = marked("project", 2);
    writeProgressBytes(JSON.stringify(progress(project)));
    const h = await browserServer({ sample: marked("sample", 3) });
    rmSync(join(project, TUTORIAL_MARKER_FILE));
    expect((await h.get()).body).toMatchObject({
      project: { path: project, state: "unmarked" },
      sample: { bundled: 3, project: null },
    });
    writeFileSync(join(project, TUTORIAL_MARKER_FILE), "{broken");
    expect((await h.get()).body).toMatchObject({ project: { state: "unmarked" } });
    rmSync(project, { recursive: true });
    expect((await h.get()).body).toMatchObject({
      project: { path: project, state: "missing" },
      sample: { project: null },
    });
    // A file where the folder was is not a folder.
    writeFileSync(project, "");
    expect((await h.get()).body).toMatchObject({ project: { state: "missing" } });
  });

  test("progress bound to no project: project null", async () => {
    writeProgressBytes(JSON.stringify(progress(null)));
    const h = await browserServer();
    expect((await h.get()).body).toEqual({
      progress: progress(null),
      project: null,
      sample: { bundled: null, project: null },
    });
  });

  test("no bundled sample (none given, the folder gone, or no usable marker): `bundled` null", async () => {
    expect(((await (await browserServer()).get()).body as TutorialState).sample.bundled).toBeNull();
    const gone = join(folder("parent"), "tutorial");
    expect(
      ((await (await browserServer({ sample: gone })).get()).body as TutorialState).sample.bundled
    ).toBeNull();
    const unmarked = folder("unmarked");
    expect(
      ((await (await browserServer({ sample: unmarked })).get()).body as TutorialState).sample
        .bundled
    ).toBeNull();
  });

  test.each([
    ["not JSON", "{oops", "not_json"],
    ["of another shape", '{"version":1}', "bad_format"],
    ["of a version this build does not know", '{"version":2}', "unknown_version"],
  ])(
    "a file %s: no progress, logged with the reason only, the bytes left alone",
    async (_name, text, reason) => {
      writeProgressBytes(text);
      const h = await browserServer();
      expect((await h.get()).body).toEqual({
        progress: null,
        project: null,
        sample: { bundled: null, project: null },
      });
      expect(events(h.sink, "tutorial.unreadable")).toEqual([{ reason }]);
      expect(readFileSync(progressFile(), "utf8")).toBe(text);
    }
  );

  test("a file that cannot be read: `unreadable`; the log names no path", async () => {
    mkdirSync(progressFile(), { recursive: true });
    const h = await browserServer();
    expect(((await h.get()).body as TutorialState).progress).toBeNull();
    expect(events(h.sink, "tutorial.unreadable")).toEqual([{ reason: "unreadable" }]);
    expect(h.sink.lines.join("\n")).not.toContain(TUTORIAL_PROGRESS_FILE);
  });
});

describe("PUT /api/tutorial", () => {
  test("replaces the whole file and answers what GET answers", async () => {
    const project = marked("project", 4);
    writeProgressBytes(JSON.stringify(progress(null)));
    const h = await browserServer({ sample: marked("sample", 4) });
    const next = { ...progress(project), position: "reader.open" };
    const put = await h.put(next);
    expect(put.status).toBe(200);
    expect(put.body).toEqual({
      progress: next,
      project: { path: project, state: "ready" },
      sample: { bundled: 4, project: 4 },
    });
    expect(JSON.parse(readFileSync(progressFile(), "utf8"))).toEqual(next);
    expect((await h.get()).body).toEqual(put.body);
    // Written next to it and renamed: nothing else is left in the directory.
    expect(readdirSync(isolatedGlobalDirs().dataDir).filter((n) => n.includes("tutorial"))).toEqual(
      [TUTORIAL_PROGRESS_FILE]
    );
  });

  test("a file that could not be read is replaced", async () => {
    writeProgressBytes("{oops");
    const h = await browserServer();
    expect((await h.put(progress(null))).status).toBe(200);
    expect(JSON.parse(readFileSync(progressFile(), "utf8"))).toEqual(progress(null));
  });

  test("a version it does not know: 400 `unknown_version`, nothing written", async () => {
    writeProgressBytes(JSON.stringify(progress(null)));
    const before = readFileSync(progressFile());
    const h = await browserServer();
    const put = await h.put({ ...progress(null), version: 2 });
    expect(put).toEqual({
      status: 400,
      body: {
        code: "unknown_version",
        detail: "this build only reads tutorial progress version 1",
      },
    });
    expect(readFileSync(progressFile())).toEqual(before);
  });

  test.each([
    ["not JSON", "{oops"],
    ["no version", JSON.stringify({ ...progress(null), version: undefined })],
    ["a relative project path", JSON.stringify(progress("Tutorial"))],
    [
      "a step of another state",
      JSON.stringify({
        ...progress(null),
        steps: { a: { state: "seen", at: "2026-10-21T08:00:00.000Z" } },
      }),
    ],
    ["a key it does not know", JSON.stringify({ ...progress(null), extra: 1 })],
  ])("%s: 400 `invalid_request`, nothing written", async (_name, body) => {
    const h = await browserServer();
    const put = await h.put(body);
    expect(put.status).toBe(400);
    expect((put.body as { code: string }).code).toBe("invalid_request");
    expect(existsSync(progressFile())).toBe(false);
  });

  test("a body over the limit: 413 `too_large`", async () => {
    const h = await browserServer();
    const put = await h.put(`{"pad":"${"x".repeat(300 * 1024)}"}`);
    expect(put.status).toBe(413);
    expect((put.body as { code: string }).code).toBe("too_large");
  });

  test("the file cannot be written: 500 `write_failed` with the error's code only, the old bytes stay, logged without a path", async () => {
    if (process.getuid?.() === 0) return;
    writeProgressBytes(JSON.stringify(progress(null)));
    const before = readFileSync(progressFile());
    const h = await browserServer();
    chmodSync(isolatedGlobalDirs().dataDir, 0o500);
    const put = await h.put({ ...progress(null), position: "reader.open" });
    chmodSync(isolatedGlobalDirs().dataDir, 0o700);
    expect(put).toEqual({ status: 500, body: { code: "write_failed", detail: "EACCES" } });
    expect(readFileSync(progressFile())).toEqual(before);
    expect(readdirSync(isolatedGlobalDirs().dataDir).filter((n) => n.includes("tutorial"))).toEqual(
      [TUTORIAL_PROGRESS_FILE]
    );
    const failed = events(h.sink, "tutorial.write_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ error: { name: "Error", code: "EACCES" } });
    expect(h.sink.lines.join("\n")).not.toContain(isolatedGlobalDirs().dataDir);
  });

  test("a cross-site PUT, and a cross-site GET, are refused (403)", async () => {
    const h = await browserServer();
    const put = await fetch(`${h.url}/api/tutorial`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example" },
      body: JSON.stringify(progress(null)),
    });
    expect(put.status).toBe(403);
    const get = await fetch(`${h.url}/api/tutorial`, {
      headers: { Origin: "http://evil.example" },
    });
    expect(get.status).toBe(403);
    expect(existsSync(progressFile())).toBe(false);
  });
});

describe("the desktop app's welcome state", () => {
  test("answers GET and PUT like the browser form, the same file", async () => {
    const project = marked("project", 1);
    const h = await welcomeServer({ sample: marked("sample", 2) });
    expect((await h.get()).body).toEqual({
      progress: null,
      project: null,
      sample: { bundled: 2, project: null },
    });
    const put = await h.put(progress(project));
    expect(put).toEqual({
      status: 200,
      body: {
        progress: progress(project),
        project: { path: project, state: "ready" },
        sample: { bundled: 2, project: 1 },
      },
    });
    expect(JSON.parse(readFileSync(progressFile(), "utf8"))).toEqual(progress(project));
    // Every other business endpoint still answers no_project.
    expect((await fetch(`${h.url}/api/library`)).status).toBe(409);
  });

  test("a file it cannot use is logged there too", async () => {
    writeProgressBytes("[]");
    const h = await welcomeServer();
    expect(((await h.get()).body as TutorialState).progress).toBeNull();
    expect(events(h.sink, "tutorial.unreadable")).toEqual([{ reason: "bad_format" }]);
  });
});
