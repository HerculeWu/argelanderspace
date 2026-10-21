/**
 * The tutorial's entry in the desktop host (in-app-tutorial ticket 25), with the host as a child process the way the
 * shell runs it: a throwaway home, global directories and config file; the test reads the host's lines, sends requests
 * to its address, answers its `pick_folder` line with `folder_picked`, listens to its pages' WebSocket, and starts the
 * next host for the folder a `stopped` line names. The tutorial sample is a small one made here
 * (`fixtures/tutorial-host.mjs` hands it to the host). What needs a job held in the server or a slow copy — the switch
 * prompt before leaving, a host closing during a copy — is `desktop-tutorial.test.ts`, in this process.
 *
 * Runs the built server (`dist/`): build first (the four gates do).
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
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
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WsHostTutorialResult } from "@argelanderspace/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

const FIXTURE = fileURLToPath(new URL("./fixtures/tutorial-host.mjs", import.meta.url));
const MARKER_FILE = "argelanderspace-tutorial.json";

const roots: string[] = [];
const children: ChildProcess[] = [];
const sockets: WebSocket[] = [];
afterEach(() => {
  for (const ws of sockets.splice(0)) ws.terminate();
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const root of roots.splice(0)) {
    unlock(root);
    rmSync(root, { recursive: true, force: true });
  }
});

/** Gives back the permissions a test took away, so that its directory can be removed. */
function unlock(dir: string): void {
  try {
    chmodSync(dir, 0o755);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) unlock(join(dir, entry.name));
      else chmodSync(join(dir, entry.name), 0o644);
    }
  } catch {
    /* gone */
  }
}

interface World {
  root: string;
  sample: string;
  web: string;
  dataDir: string;
  progressFile: string;
  recentFile: string;
  env: NodeJS.ProcessEnv;
}

function world(opts: { sample?: boolean } = {}): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aspace-tutorial-host-")));
  roots.push(root);
  const web = join(root, "web");
  mkdirSync(web);
  writeFileSync(
    join(web, "index.html"),
    "<!doctype html><title>tutorial host</title><div id=root>"
  );
  const sample = join(root, "sample");
  mkdirSync(join(sample, "literatures", "library"), { recursive: true });
  mkdirSync(join(sample, "status"));
  writeFileSync(join(sample, MARKER_FILE), '{"version":1,"sample":4}\n');
  writeFileSync(join(sample, "NOTICE.md"), "sample notice\n");
  writeFileSync(join(sample, "literatures", "library", "library.json"), '{"works":[]}\n');
  writeFileSync(join(sample, "status", "plans.json"), '{"version":1,"plans":[]}\n');
  mkdirSync(join(root, "runtime"), { mode: 0o700 });
  mkdirSync(join(root, ".config", "argelanderspace"), { recursive: true });
  writeFileSync(join(root, ".config", "argelanderspace", "config.toml"), "port = 0\n");
  const dataDir = join(root, ".local", "share", "argelanderspace");
  return {
    root,
    sample,
    web,
    dataDir,
    progressFile: join(dataDir, "tutorial.json"),
    recentFile: join(dataDir, "recent-projects.json"),
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_DATA_HOME: join(root, ".local", "share"),
      XDG_CACHE_HOME: join(root, ".cache"),
      XDG_STATE_HOME: join(root, ".local", "state"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-session-bus")}`,
      XDG_RUNTIME_DIR: join(root, "runtime"),
      TEST_WEB_DIST: web,
      ...(opts.sample === false ? {} : { TEST_TUTORIAL_SAMPLE: sample }),
    },
  };
}

type Line = Record<string, unknown> & { type: string };

async function startHost(w: World, project?: string) {
  const child = spawn(process.execPath, [FIXTURE, ...(project ? [project] : [])], {
    env: w.env,
    cwd: w.root,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const lines: Line[] = [];
  let rest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    let nl = rest.indexOf("\n");
    while (nl !== -1) {
      lines.push(JSON.parse(rest.slice(0, nl)) as Line);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const taken = new Set<number>();
  const next = async (type: string): Promise<Line> => {
    for (let i = 0; i < 600; i++) {
      const at = lines.findIndex((l, n) => l.type === type && !taken.has(n));
      if (at !== -1) {
        taken.add(at);
        return lines[at] as Line;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no ${type} line; got ${JSON.stringify(lines)}; stderr ${stderr}`);
  };
  const ready = await next("ready");
  const url = String(ready.url).replace(/\/$/, "");
  const post = async (path: string) => {
    const r = await fetch(url + path, { method: "POST", headers: { Origin: url } });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  /** The `host.tutorial-result` messages a page connected now receives. */
  const results: WsHostTutorialResult[] = [];
  const ws = new WebSocket(`${url.replace(/^http/, "ws")}/ws`, { headers: { Origin: url } });
  sockets.push(ws);
  ws.on("message", (data) => {
    const m = JSON.parse(String(data)) as { type: string };
    if (m.type === "host.tutorial-result") results.push(m as WsHostTutorialResult);
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    child,
    lines,
    exited,
    ready,
    url,
    next,
    post,
    results,
    async get(path: string) {
      const r = await fetch(url + path, { headers: { Origin: url } });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    },
    /** "Start tutorial": the page asks, the shell answers the `pick_folder` line it gets. */
    async pick(path: string | null) {
      expect(await post("/api/host/tutorial/pick")).toEqual({ status: 202, body: { ok: true } });
      const request = await next("request");
      expect(request).toMatchObject({ kind: "pick_folder" });
      child.stdin?.write(`${JSON.stringify({ type: "folder_picked", id: request.id, path })}\n`);
    },
    async quit() {
      child.stdin?.write('{"type":"quit"}\n');
      return exited;
    },
    async result(): Promise<WsHostTutorialResult> {
      for (let i = 0; i < 400 && results.length === 0; i++)
        await new Promise((r) => setTimeout(r, 25));
      const first = results.shift();
      if (first === undefined)
        throw new Error(`no host.tutorial-result; lines ${JSON.stringify(lines)}`);
      return first;
    },
  };
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, rel: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(at, entry.name), r);
      else out[r] = readFileSync(join(at, entry.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}

const progress = (w: World) =>
  JSON.parse(readFileSync(w.progressFile, "utf8")) as Record<string, unknown>;
const recentPaths = (w: World): string[] =>
  (JSON.parse(readFileSync(w.recentFile, "utf8")) as { projects: { path: string }[] }).projects.map(
    (p) => p.path
  );

function logRecords(w: World): Array<Record<string, unknown>> {
  const dir = join(w.dataDir, "logs");
  return readdirSync(dir).flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .trimEnd()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  );
}

/** A tutorial folder with something the user wrote in it. */
function tutorialFolder(at: string, sample = 1): string {
  mkdirSync(join(at, "literatures", "annotations"), { recursive: true });
  writeFileSync(join(at, MARKER_FILE), `{"version":1,"sample":${sample}}\n`);
  writeFileSync(join(at, "literatures", "annotations", "mine.json"), "what I wrote");
  return at;
}

function bind(w: World, path: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(w.dataDir, { recursive: true });
  writeFileSync(
    w.progressFile,
    JSON.stringify({
      version: 1,
      project: { path },
      startedAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
      position: "tour.palette",
      steps: { "prepare.welcome": { state: "done", at: "2026-10-01T00:00:00.000Z" } },
      appVersion: "0.1.0",
      ...extra,
    })
  );
}

describe("start: a parent folder picked in the welcome state", () => {
  test("the tutorial folder is made and filled, the progress bound from the start, recorded first, and left for; the next host opens it", async () => {
    const w = world();
    const parent = join(w.root, "Documents");
    mkdirSync(parent);
    writeFileSync(join(parent, "mine.txt"), "the user's");
    const h = await startHost(w);
    expect(h.ready.project).toBeNull();
    await h.pick(parent);
    const target = join(parent, "ArgelanderSpace-Tutorial");
    expect(await h.next("stopping")).toEqual({ type: "stopping", reason: "switch" });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: target });
    expect(await h.exited).toBe(0);
    expect(tree(target)).toEqual(tree(w.sample));
    expect(readFileSync(join(parent, "mine.txt"), "utf8")).toBe("the user's");
    expect(progress(w)).toMatchObject({
      version: 1,
      project: { path: target },
      position: null,
      steps: {},
      appVersion: "9.9.9-test",
    });
    expect(recentPaths(w)[0]).toBe(target);
    const records = logRecords(w);
    expect(records.find((r) => r.event === "desktop.tutorial_entered")).toMatchObject({
      action: "pick",
      outcome: "created",
    });
    expect(records.find((r) => r.event === "desktop.leaving")).toMatchObject({
      source: "tutorial",
    });
    expect(JSON.stringify(records)).not.toContain("Documents");

    // The shell starts the next host for that folder: the tutorial project is open and ready.
    const second = await startHost(w, target);
    expect(second.ready.project).toBe(target);
    expect((await second.get("/api/tutorial")).body).toMatchObject({
      project: { path: target, state: "ready" },
      sample: { bundled: 4, project: 4 },
    });
    expect(await second.quit()).toBe(0);
  }, 60_000);

  test("the picked folder is a tutorial folder itself: it is the target, nothing is copied, bound anew", async () => {
    const w = world();
    const own = tutorialFolder(join(w.root, "My Tutorial"));
    const before = tree(own);
    bind(w, join(w.root, "elsewhere"));
    const h = await startHost(w);
    await h.pick(own);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: own });
    expect(tree(own)).toEqual(before);
    expect(progress(w)).toMatchObject({ project: { path: own }, position: null, steps: {} });
    expect(logRecords(w).find((r) => r.event === "desktop.tutorial_entered")).toMatchObject({
      outcome: "rebound",
    });
  }, 30_000);

  test("a marked tutorial folder in the parent that the progress is not bound to: bound to it and continued, its content kept", async () => {
    const w = world();
    const parent = join(w.root, "Work");
    const existing = tutorialFolder(join(parent, "ArgelanderSpace-Tutorial"));
    const before = tree(existing);
    const h = await startHost(w);
    await h.pick(parent);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: existing });
    expect(tree(existing)).toEqual(before);
    expect(progress(w)).toMatchObject({ project: { path: existing }, steps: {} });
  }, 30_000);

  test("the folder the progress is bound to already: continued where it was", async () => {
    const w = world();
    const parent = join(w.root, "Work");
    const existing = tutorialFolder(join(parent, "ArgelanderSpace-Tutorial"));
    bind(w, existing);
    const h = await startHost(w);
    await h.pick(parent);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: existing });
    expect(progress(w)).toMatchObject({
      project: { path: existing },
      position: "tour.palette",
      steps: { "prepare.welcome": { state: "done" } },
    });
  }, 30_000);

  test("a cancelled dialog: nothing happens", async () => {
    const w = world();
    const h = await startHost(w);
    await h.pick(null);
    await new Promise((r) => setTimeout(r, 200));
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "menu", "request"]);
    expect(existsSync(w.progressFile)).toBe(false);
    expect(await h.quit()).toBe(0);
  }, 30_000);
});

describe("start: what fails is announced, nothing is left for", () => {
  test("target_conflict: a non-empty folder of that name without the marker is left as it is", async () => {
    const w = world();
    const parent = join(w.root, "Work");
    const taken = join(parent, "ArgelanderSpace-Tutorial");
    mkdirSync(taken, { recursive: true });
    writeFileSync(join(taken, "notes.txt"), "mine");
    const h = await startHost(w);
    await h.pick(parent);
    expect(await h.result()).toEqual({
      type: "host.tutorial-result",
      reason: "target_conflict",
      path: { path: taken, display: "~/Work/ArgelanderSpace-Tutorial" },
    });
    expect(readdirSync(taken)).toEqual(["notes.txt"]);
    expect(existsSync(w.progressFile)).toBe(false);
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "menu", "request"]);
    // Still serving: the button can be clicked again.
    expect((await h.post("/api/host/tutorial/pick")).status).toBe(202);
    expect(await h.quit()).toBe(0);
    const failed = logRecords(w).filter((r) => r.event === "desktop.tutorial_failed");
    expect(failed).toEqual([
      expect.objectContaining({ action: "pick", reason: "target_conflict" }),
    ]);
    expect(JSON.stringify(failed)).not.toContain("Work");
  }, 30_000);

  test("not_a_folder: what the dialog answered is a file", async () => {
    const w = world();
    const file = join(w.root, "notes.txt");
    writeFileSync(file, "x");
    const h = await startHost(w);
    await h.pick(file);
    expect(await h.result()).toMatchObject({ reason: "not_a_folder", path: { path: file } });
    expect(readFileSync(file, "utf8")).toBe("x");
    expect(await h.quit()).toBe(0);
  }, 30_000);

  test("copy_failed in a read-only folder: nothing is made", async () => {
    const w = world();
    const parent = join(w.root, "ReadOnly");
    mkdirSync(parent);
    writeFileSync(join(parent, "mine.txt"), "the user's");
    chmodSync(parent, 0o555);
    const h = await startHost(w);
    await h.pick(parent);
    expect(await h.result()).toMatchObject({
      reason: "copy_failed",
      path: { path: join(parent, "ArgelanderSpace-Tutorial") },
    });
    expect(readdirSync(parent)).toEqual(["mine.txt"]);
    expect(existsSync(w.progressFile)).toBe(false);
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "menu", "request"]);
    expect(await h.quit()).toBe(0);
  }, 30_000);

  test("copy_failed in the middle: only the folder the host made is removed; the user's files stay; not left for", async () => {
    const w = world();
    writeFileSync(join(w.sample, "zz-unreadable.bin"), "x");
    chmodSync(join(w.sample, "zz-unreadable.bin"), 0o000);
    const parent = join(w.root, "Work");
    mkdirSync(parent);
    writeFileSync(join(parent, "mine.txt"), "the user's");
    const h = await startHost(w);
    await h.pick(parent);
    expect(await h.result()).toMatchObject({ reason: "copy_failed" });
    expect(readdirSync(parent)).toEqual(["mine.txt"]);
    expect(readFileSync(join(parent, "mine.txt"), "utf8")).toBe("the user's");
    expect(existsSync(w.progressFile)).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.lines.some((l) => l.type === "stopping")).toBe(false);
    expect(await h.quit()).toBe(0);
  }, 30_000);

  test("no sample in this installation: 409 no_sample, no dialog", async () => {
    const w = world({ sample: false });
    const h = await startHost(w);
    expect(await h.post("/api/host/tutorial/pick")).toMatchObject({
      status: 409,
      body: { code: "no_sample" },
    });
    expect(await h.post("/api/host/tutorial/restart")).toMatchObject({
      status: 409,
      body: { code: "no_sample" },
    });
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "menu"]);
    expect(await h.quit()).toBe(0);
  }, 30_000);
});

describe("continue", () => {
  test("the bound folder: left for, without a dialog; the progress as it was", async () => {
    const w = world();
    const existing = tutorialFolder(join(w.root, "ArgelanderSpace-Tutorial"));
    bind(w, existing);
    const h = await startHost(w);
    expect(await h.post("/api/host/tutorial/continue")).toEqual({
      status: 202,
      body: { ok: true },
    });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: existing });
    expect(h.lines.some((l) => l.type === "request")).toBe(false);
    expect(progress(w)).toMatchObject({ position: "tour.palette" });
    expect(recentPaths(w)[0]).toBe(existing);
  }, 30_000);

  test("409 when the bound folder is gone or has no marker, and when nothing is bound", async () => {
    const w = world();
    const h = await startHost(w);
    expect(await h.post("/api/host/tutorial/continue")).toMatchObject({
      status: 409,
      body: { code: "tutorial_missing" },
    });
    const existing = tutorialFolder(join(w.root, "ArgelanderSpace-Tutorial"));
    bind(w, join(w.root, "gone"));
    expect(await h.post("/api/host/tutorial/continue")).toMatchObject({
      status: 409,
      body: { code: "tutorial_missing" },
    });
    bind(w, existing);
    rmSync(join(existing, MARKER_FILE));
    expect(await h.post("/api/host/tutorial/continue")).toMatchObject({
      status: 409,
      body: { code: "tutorial_missing" },
    });
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "menu"]);
    expect(await h.quit()).toBe(0);
  }, 30_000);
});

describe("restart", () => {
  test("from the welcome state: only the marked folder is emptied and filled again, the progress cleared, left for", async () => {
    const w = world();
    const parent = join(w.root, "Work");
    const existing = tutorialFolder(join(parent, "ArgelanderSpace-Tutorial"));
    writeFileSync(join(parent, "mine.txt"), "the user's");
    bind(w, existing);
    const h = await startHost(w);
    expect(await h.post("/api/host/tutorial/restart")).toEqual({ status: 202, body: { ok: true } });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: existing });
    expect(tree(existing)).toEqual(tree(w.sample));
    expect(readdirSync(parent).sort()).toEqual(["ArgelanderSpace-Tutorial", "mine.txt"]);
    expect(progress(w)).toMatchObject({ project: { path: existing }, position: null, steps: {} });
    expect(logRecords(w).find((r) => r.event === "desktop.tutorial_entered")).toMatchObject({
      action: "restart",
      outcome: "restarted",
    });
  }, 30_000);

  test("a bound folder without the marker is refused, whatever is in it", async () => {
    const w = world();
    const existing = tutorialFolder(join(w.root, "ArgelanderSpace-Tutorial"));
    rmSync(join(existing, MARKER_FILE));
    const before = tree(existing);
    bind(w, existing);
    const h = await startHost(w);
    expect(await h.post("/api/host/tutorial/restart")).toMatchObject({
      status: 409,
      body: { code: "tutorial_missing" },
    });
    expect(tree(existing)).toEqual(before);
    expect(await h.quit()).toBe(0);
  }, 30_000);

  test("with another project open (nothing to interrupt): emptied and filled again, then left for", async () => {
    const w = world();
    const other = join(w.root, "Other Project");
    mkdirSync(other);
    const existing = tutorialFolder(join(w.root, "ArgelanderSpace-Tutorial"));
    bind(w, existing);
    const h = await startHost(w, other);
    expect(h.ready.project).toBe(other);
    expect((await h.post("/api/host/tutorial/restart")).status).toBe(202);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: existing });
    expect(tree(existing)).toEqual(tree(w.sample));
  }, 30_000);

  test("with the tutorial project itself open: emptied once its server has closed, before stopped; it opens again", async () => {
    const w = world();
    const existing = tutorialFolder(join(w.root, "ArgelanderSpace-Tutorial"));
    bind(w, existing);
    const h = await startHost(w, existing);
    expect(h.ready.project).toBe(existing);
    expect((await h.post("/api/host/tutorial/restart")).status).toBe(202);
    expect(await h.next("stopping")).toEqual({ type: "stopping", reason: "switch" });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: existing });
    expect(await h.exited).toBe(0);
    expect(tree(existing)).toEqual(tree(w.sample));
    expect(readdirSync(w.root).filter((name) => name.startsWith(".ArgelanderSpace"))).toEqual([]);
    expect(progress(w)).toMatchObject({ position: null, steps: {} });
    const again = await startHost(w, existing);
    expect((await again.get("/api/tutorial")).body).toMatchObject({
      project: { state: "ready" },
      progress: { position: null },
    });
    expect(await again.quit()).toBe(0);
  }, 30_000);

  test("a copy that fails during the restart of the open tutorial project: announced, the folder byte for byte as it was, nothing beside it, not left for", async () => {
    const w = world();
    writeFileSync(join(w.sample, "zz-unreadable.bin"), "x");
    chmodSync(join(w.sample, "zz-unreadable.bin"), 0o000);
    const existing = tutorialFolder(join(w.root, "ArgelanderSpace-Tutorial"));
    bind(w, existing);
    const h = await startHost(w, existing);
    const before = tree(existing);
    const progressBefore = readFileSync(w.progressFile, "utf8");
    expect((await h.post("/api/host/tutorial/restart")).status).toBe(202);
    expect(await h.result()).toMatchObject({ reason: "copy_failed", path: { path: existing } });
    expect(tree(existing)).toEqual(before);
    expect(readdirSync(w.root).filter((name) => name.startsWith(".ArgelanderSpace"))).toEqual([]);
    expect(readFileSync(w.progressFile, "utf8")).toBe(progressBefore);
    expect(h.lines.some((l) => l.type === "stopping")).toBe(false);
    expect(await h.quit()).toBe(0);
    expect(logRecords(w).find((r) => r.event === "desktop.tutorial_failed")).toMatchObject({
      action: "restart",
      reason: "copy_failed",
    });
  }, 30_000);

  test("a copy that fails during the restart from the welcome state: announced, the folder as it was, not left for", async () => {
    const w = world();
    writeFileSync(join(w.sample, "zz-unreadable.bin"), "x");
    chmodSync(join(w.sample, "zz-unreadable.bin"), 0o000);
    const existing = tutorialFolder(join(w.root, "ArgelanderSpace-Tutorial"));
    bind(w, existing);
    const before = tree(existing);
    const h = await startHost(w);
    expect((await h.post("/api/host/tutorial/restart")).status).toBe(202);
    expect(await h.result()).toMatchObject({ reason: "copy_failed", path: { path: existing } });
    expect(tree(existing)).toEqual(before);
    expect(readdirSync(w.root).filter((name) => name.startsWith(".ArgelanderSpace"))).toEqual([]);
    expect(h.lines.some((l) => l.type === "stopping")).toBe(false);
    expect(await h.quit()).toBe(0);
  }, 30_000);

  test("continue with the tutorial project open: 409 current_project", async () => {
    const w = world();
    const existing = tutorialFolder(join(w.root, "ArgelanderSpace-Tutorial"));
    bind(w, existing);
    const h = await startHost(w, existing);
    expect(await h.post("/api/host/tutorial/continue")).toMatchObject({
      status: 409,
      body: { code: "current_project" },
    });
    expect(await h.quit()).toBe(0);
  }, 30_000);
});
