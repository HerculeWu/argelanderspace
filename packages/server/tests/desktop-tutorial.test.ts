/**
 * The tutorial's entry in the desktop host (in-app-tutorial ticket 25), in this process — what needs a job held in the
 * server or a copy that waits: with a project open whose switch would interrupt work, the tutorial folder is made (and
 * bound) first and the switch then asked about as for any picked folder (`host.switch-confirmation`); cancelling keeps
 * the folder and the binding. A host that begins to close during a copy announces `shutting_down`, removes what the copy
 * wrote and leaves for nothing. A second entry while one is under way is refused. The browser form has none of it.
 * The host as a child process (the main flows, the failures with real files) is `desktop-tutorial-host.test.ts`.
 *
 * Everything below the home directory is the throwaway one of the isolation setup (checked by `isolated`).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import type {
  HostSwitchImpact,
  WsHostSwitchConfirmation,
  WsHostTutorialResult,
} from "@argelanderspace/contracts";
import {
  __setWriterSandboxForTests,
  configFilePath,
  copyTutorialSample,
  resolveRecentProjectsPath,
  resolveTutorialProgressPath,
  type TutorialCopyOptions,
} from "@argelanderspace/infra";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import { type DesktopHost, type HostOutLine, runDesktopHost } from "../src/desktop-host.js";
import type { RunningServer } from "../src/server.js";
import { createServer } from "../src/server.js";
import { isolatedGlobalDirs } from "./helpers.js";

beforeAll(() => __setWriterSandboxForTests(false));
afterAll(() => __setWriterSandboxForTests(null));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEYCHAIN = async () => ({ state: "unavailable" as const, reason: "no_bus" as const });
const MARKER_FILE = "argelanderspace-tutorial.json";
const cwd = process.cwd();
const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
let web: string;
let sample: string;
let current: string;

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

const progressFile = () => isolated(resolveTutorialProgressPath());

function folder(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `aspace-tutorial-${name}-`));
  roots.push(root);
  return realpathSync(root);
}

beforeEach(() => {
  web = join(folder("web"), "dist");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>tutorial test</title><div id=root>");
  sample = folder("sample");
  writeFileSync(join(sample, MARKER_FILE), '{"version":1,"sample":2}\n');
  mkdirSync(join(sample, "literatures"));
  writeFileSync(join(sample, "literatures", "a.json"), "{}\n");
  writeFileSync(join(sample, "literatures", "b.json"), "{}\n");
  current = folder("current");
  process.chdir(current);
  const config = isolated(configFilePath());
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, "port = 0\n");
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  process.chdir(cwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(isolated(configFilePath()), { force: true });
  rmSync(isolated(resolveRecentProjectsPath()), { force: true });
  rmSync(progressFile(), { force: true });
});

/** A copy that waits for `open()` before it copies (`started` resolves once it is waiting). */
function gatedCopy() {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let started!: () => void;
  const waiting = new Promise<void>((r) => {
    started = r;
  });
  const copy = async (from: string, into: string, opts: TutorialCopyOptions) => {
    started();
    await gate;
    await copyTutorialSample(from, into, opts);
  };
  return { copy, open, waiting };
}

interface Running {
  host: DesktopHost;
  server: RunningServer;
  lines: HostOutLine[];
  next<T extends HostOutLine["type"]>(type: T): Promise<Extract<HostOutLine, { type: T }>>;
  url: string;
  get(path: string): Promise<{ status: number; body: Record<string, unknown> }>;
  post(path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>;
  pickTutorial(path: string | null): Promise<void>;
}

async function startHost(opts: { copy?: TutorialCopyOptions["copy"] } = {}): Promise<Running> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: HostOutLine[] = [];
  const taken = new Set<number>();
  let rest = "";
  output.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    let nl = rest.indexOf("\n");
    while (nl !== -1) {
      lines.push(JSON.parse(rest.slice(0, nl)) as HostOutLine);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
  });
  const next = async <T extends HostOutLine["type"]>(type: T) => {
    for (let i = 0; i < 400; i++) {
      const index = lines.findIndex((line, n) => line.type === type && !taken.has(n));
      if (index !== -1) {
        taken.add(index);
        return lines[index] as Extract<HostOutLine, { type: T }>;
      }
      await sleep(10);
    }
    throw new Error(`no ${type} line; got ${JSON.stringify(lines)}`);
  };
  const host = await runDesktopHost({
    input,
    output,
    version: "9.9.9-test",
    keychainProbe: KEYCHAIN,
    webDist: web,
    tutorialSampleDir: sample,
    ...(opts.copy === undefined ? {} : { tutorialCopy: opts.copy }),
  });
  closers.push(() => host.stop());
  const ready = await next("ready");
  const url = ready.type === "ready" ? ready.url.replace(/\/$/, "") : "";
  const post = async (path: string, body?: unknown) => {
    const r = await fetch(url + path, {
      method: "POST",
      headers: { Origin: url, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  return {
    host,
    server: host.server as RunningServer,
    lines,
    next,
    url,
    async get(path) {
      const r = await fetch(url + path, { headers: { Origin: url } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    post,
    async pickTutorial(path) {
      expect((await post("/api/host/tutorial/pick")).status).toBe(202);
      const request = (await next("request")) as { id: string };
      input.write(`${JSON.stringify({ type: "folder_picked", id: request.id, path })}\n`);
    },
  };
}

/** A job that runs until `release` is called. */
function holdJob(server: RunningServer): { id: string; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const job = server.runner.submit("ingest", () => gate, {});
  closers.push(async () => release());
  return { id: job.id, release };
}

/** What a page connected to the server receives of the host's two messages. */
async function listen(url: string) {
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`, { headers: { Origin: url } });
  const switches: WsHostSwitchConfirmation[] = [];
  const results: WsHostTutorialResult[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data)) as { type: string };
    if (m.type === "host.switch-confirmation") switches.push(m as WsHostSwitchConfirmation);
    if (m.type === "host.tutorial-result") results.push(m as WsHostTutorialResult);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  closers.push(async () => ws.close());
  return { switches, results };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await sleep(10);
  if (!check()) throw new Error("not reached");
}

const ack = (impact: HostSwitchImpact) => ({
  jobs: impact.jobs.map((j) => j.id),
  conversations: impact.conversations.map((c) => c.id),
  mail: impact.mail.map((m) => m.sendId),
});

function bindTo(path: string): void {
  mkdirSync(dirname(progressFile()), { recursive: true });
  writeFileSync(
    progressFile(),
    JSON.stringify({
      version: 1,
      project: { path },
      startedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      position: "tour.split",
      steps: {},
      appVersion: "0.1.0",
    })
  );
}

function markedFolder(at: string): string {
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, MARKER_FILE), '{"version":1,"sample":1}\n');
  writeFileSync(join(at, "mine.txt"), "what I wrote");
  return at;
}

describe("with a project open whose switch would interrupt work", () => {
  test("start: the folder is made and bound first, then the switch is asked about; cancelled, both stay", async () => {
    const parent = folder("parent");
    const h = await startHost();
    const page = await listen(h.url);
    const job = holdJob(h.server);
    await h.pickTutorial(parent);
    await until(() => page.switches.length === 1);
    const target = join(parent, "ArgelanderSpace-Tutorial");
    const [asked] = page.switches;
    expect(asked).toMatchObject({
      target: { path: target, name: "ArgelanderSpace-Tutorial" },
      impact: { jobs: [{ id: job.id }] },
    });
    // Copied and bound before the prompt.
    expect(readdirSync(target).sort()).toEqual([MARKER_FILE, "literatures"]);
    expect(JSON.parse(readFileSync(progressFile(), "utf8"))).toMatchObject({
      project: { path: target },
    });
    if (asked === undefined) throw new Error("no prompt");
    expect((await h.post("/api/host/switch/cancel", { id: asked.id })).status).toBe(200);
    await sleep(50);
    expect(h.lines.some((l) => l.type === "stopping")).toBe(false);
    expect(existsSync(join(target, MARKER_FILE))).toBe(true);
    // The page now offers to resume.
    expect((await h.get("/api/tutorial")).body).toMatchObject({
      project: { path: target, state: "ready" },
    });
    // Resuming asks again; confirmed, the host leaves for it.
    expect((await h.post("/api/host/tutorial/continue")).status).toBe(202);
    await until(() => page.switches.length === 2);
    const second = page.switches[1];
    if (second === undefined) throw new Error("no second prompt");
    expect(
      (await h.post("/api/host/switch/confirm", { id: second.id, acknowledged: ack(second.impact) }))
        .status
    ).toBe(202);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: target });
  });

  test("restart of the open tutorial project: the copy is staged and the switch asked about; cancelled, the folder is as it was and the staged copy gone", async () => {
    const tutorial = markedFolder(join(current, "..", `${current.split("/").at(-1)}-tut`));
    roots.push(tutorial);
    process.chdir(tutorial);
    bindTo(tutorial);
    const h = await startHost();
    const page = await listen(h.url);
    const job = holdJob(h.server);
    expect((await h.post("/api/host/tutorial/restart")).status).toBe(202);
    await until(() => page.switches.length === 1);
    const asked = page.switches[0];
    if (asked === undefined) throw new Error("no prompt");
    expect(asked.target.path).toBe(tutorial);
    const beside = () => readdirSync(dirname(tutorial)).filter((n) => n.startsWith(`.${tutorial.split("/").at(-1)}-`));
    expect(beside()).toHaveLength(1);
    expect((await h.post("/api/host/switch/cancel", { id: asked.id })).status).toBe(200);
    expect(beside()).toEqual([]);
    expect(readFileSync(join(tutorial, "mine.txt"), "utf8")).toBe("what I wrote");
    expect(JSON.parse(readFileSync(progressFile(), "utf8"))).toMatchObject({ position: "tour.split" });

    // The job has ended: asked again, the host leaves at once; emptied after the server closed, before stopped.
    job.release();
    await h.server.runner.waitFor(job.id);
    expect((await h.post("/api/host/tutorial/restart")).status).toBe(202);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: tutorial });
    expect(existsSync(join(tutorial, "mine.txt"))).toBe(false);
    expect(readdirSync(tutorial).sort()).toEqual([MARKER_FILE, "literatures"]);
    expect(beside()).toEqual([]);
    expect(JSON.parse(readFileSync(progressFile(), "utf8"))).toMatchObject({ position: null, steps: {} });
  });
});

describe("one entry at a time, and a host that closes", () => {
  test("a second entry while a copy is under way: 409 tutorial_busy", async () => {
    const parent = folder("parent");
    const gated = gatedCopy();
    const h = await startHost({ copy: gated.copy });
    await h.pickTutorial(parent);
    await gated.waiting;
    expect(await h.post("/api/host/tutorial/pick")).toMatchObject({
      status: 409,
      body: { code: "tutorial_busy" },
    });
    gated.open();
    expect(await h.next("stopped")).toEqual({
      type: "stopped",
      next: join(parent, "ArgelanderSpace-Tutorial"),
    });
  });

  test("closing during the copy: shutting_down is announced, what the copy wrote is removed, nothing is left for", async () => {
    const parent = folder("parent");
    writeFileSync(join(parent, "mine.txt"), "the user's");
    const gated = gatedCopy();
    const h = await startHost({ copy: gated.copy });
    const page = await listen(h.url);
    await h.pickTutorial(parent);
    await gated.waiting;
    const stopped = h.host.stop("quit");
    await until(() => page.results.length === 1);
    expect(page.results[0]).toMatchObject({
      type: "host.tutorial-result",
      reason: "shutting_down",
      path: { path: join(parent, "ArgelanderSpace-Tutorial") },
    });
    gated.open();
    expect(await stopped).toBe("quit");
    expect(await h.next("stopped")).toEqual({ type: "stopped" });
    expect(readdirSync(parent)).toEqual(["mine.txt"]);
    expect(existsSync(progressFile())).toBe(false);
  });
});

test("the browser form: 404 not_desktop for the three", async () => {
  const start = folder("browser");
  const srv = createServer({
    dataDir: join(start, "literatures"),
    globalDirs: isolatedGlobalDirs(),
    port: 0,
    heartbeatMs: 0,
  });
  closers.push(() => srv.close());
  const port = await srv.ready();
  const url = `http://127.0.0.1:${port}`;
  for (const action of ["pick", "continue", "restart"]) {
    const r = await fetch(`${url}/api/host/tutorial/${action}`, {
      method: "POST",
      headers: { Origin: url },
    });
    expect([action, r.status, ((await r.json()) as { code: string }).code]).toEqual([
      action,
      404,
      "not_desktop",
    ]);
  }
});
