/**
 * The desktop host's welcome state and recently opened projects (desktop-app ticket 18), in this process: which
 * project the host enters, what the server answers with no project open, leaving for a picked folder or a recent
 * project (the `switch` stop and its `next`), and the recent list as the page sees it. The built program as a child
 * process is `packages/cli/tests/desktop-welcome.test.ts`.
 *
 * Everything below the home directory is the throwaway one of the isolation setup: the config file and the recent
 * list are written there (checked by `isolated`).
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
import type { HostInfo, HostRecentProjects } from "@argelanderspace/contracts";
import {
  __setWriterSandboxForTests,
  configFilePath,
  readRecentProjects,
  recordRecentProject,
  resolveRecentProjectsPath,
} from "@argelanderspace/infra";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import { type DesktopHost, type HostOutLine, runDesktopHost } from "../src/desktop-host.js";
import { createServer } from "../src/server.js";

beforeAll(() => __setWriterSandboxForTests(false));
afterAll(() => __setWriterSandboxForTests(null));

const KEYCHAIN = async () => ({ state: "unavailable" as const, reason: "no_bus" as const });
const cwd = process.cwd();
const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
/** Where the host process starts (the shell's working directory): never a project. */
let start: string;
let web: string;

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

const recentFile = () => isolated(resolveRecentProjectsPath());

function folder(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `aspace-welcome-${name}-`));
  roots.push(root);
  return realpathSync(root);
}

beforeEach(() => {
  start = folder("start");
  web = join(folder("web"), "dist");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>welcome test</title><div id=root>");
  process.chdir(start);
  const config = isolated(configFilePath());
  mkdirSync(dirname(config), { recursive: true });
  // Port 0: whatever listens on the default port of this machine is not this test's business.
  writeFileSync(config, "port = 0\n");
});

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  process.chdir(cwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(isolated(configFilePath()), { force: true });
  rmSync(recentFile(), { force: true });
});

interface Running {
  host: DesktopHost;
  input: PassThrough;
  lines: HostOutLine[];
  next<T extends HostOutLine["type"]>(type: T): Promise<Extract<HostOutLine, { type: T }>>;
  url: string;
  get(path: string): Promise<{ status: number; body: unknown }>;
  post(path: string, body?: unknown, origin?: string): Promise<{ status: number; body: unknown }>;
  log(): Array<Record<string, unknown>>;
}

async function startHost(opts: { fromRecent?: boolean } = { fromRecent: true }): Promise<Running> {
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
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type} line; got ${JSON.stringify(lines)}`);
  };
  const logDir = join(process.env.XDG_DATA_HOME ?? "", "argelanderspace", "logs");
  const before = new Set(existsSync(logDir) ? readdirSync(logDir) : []);
  const host = await runDesktopHost({
    input,
    output,
    version: "9.9.9-test",
    keychainProbe: KEYCHAIN,
    webDist: web,
    ...(opts.fromRecent ? { fromRecent: true } : {}),
  });
  closers.push(() => host.stop());
  const ready = await next("ready");
  const url = ready.url.replace(/\/$/, "");
  const mine = readdirSync(logDir).filter((name) => !before.has(name));
  return {
    host,
    input,
    lines,
    next,
    url,
    async get(path) {
      const r = await fetch(url + path);
      const text = await r.text();
      return { status: r.status, body: text.startsWith("{") ? JSON.parse(text) : text };
    },
    async post(path, body, origin = url) {
      const r = await fetch(url + path, {
        method: "POST",
        headers: { Origin: origin, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await r.text();
      return { status: r.status, body: text.startsWith("{") ? JSON.parse(text) : text };
    },
    log: () =>
      readFileSync(join(logDir, mine[0] ?? "missing"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** The records of one event, each with its fields only. */
const events = (h: Running, name: string) =>
  h
    .log()
    .filter((r) => r.event === name)
    .map(({ t: _t, level: _level, event: _event, ...fields }) => ({ fields }));

/** The business endpoints the page calls first; all of them are project data. */
const BUSINESS = [
  "/api/library",
  "/api/papers",
  "/api/plans",
  "/api/writer/manuscripts",
  "/api/mail/accounts",
  "/api/providers",
  "/api/diagnostics/log-folder",
  "/images/some-doc/fig.png",
];

describe("which project the host enters", () => {
  test("no recent projects: the welcome state — no project in the ready line, `none` to the page", async () => {
    const h = await startHost();
    expect(h.lines[0]).toMatchObject({ type: "ready", project: null });
    expect(h.host.project).toBe("none");
    const info = (await h.get("/api/host")).body as HostInfo;
    expect(info).toMatchObject({ mode: "desktop", project: "none" });
    expect((await h.get("/api/host/recent-projects")).body).toEqual({
      version: 1,
      projects: [],
      lastMissing: null,
    });
    expect(events(h, "desktop.no_project")).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ reason: "no_recent" }) }),
    ]);
    expect(events(h, "server.started")[0]?.fields).toMatchObject({
      mode: "desktop",
      project: "none",
    });
    expect(events(h, "server.started")[0]?.fields).not.toHaveProperty("data_dir");
  });

  test("the most recent project whose folder is there: entered (the host changes into it) and recorded again", async () => {
    const a = folder("a");
    const b = folder("b");
    recordRecentProject(recentFile(), a, new Date("2026-01-01T00:00:00Z"));
    recordRecentProject(recentFile(), b, new Date("2026-01-02T00:00:00Z"));
    const h = await startHost();
    expect(h.lines[0]).toMatchObject({ type: "ready", project: b });
    expect(process.cwd()).toBe(b);
    expect(((await h.get("/api/host")).body as HostInfo).project).toBe("open");
    const { projects } = readRecentProjects(recentFile());
    expect(projects.map((p) => p.path)).toEqual([b, a]);
    expect(Date.parse(projects[0]?.openedAt ?? "")).toBeGreaterThan(Date.parse("2026-01-03"));
    expect((await h.get("/api/library")).status).toBe(200);
  });

  test("the last project's folder is gone: the welcome state, the entry marked and named as the last one", async () => {
    const a = folder("a");
    const gone = join(folder("parent"), "gone");
    recordRecentProject(recentFile(), a, new Date("2026-01-01T00:00:00Z"));
    recordRecentProject(recentFile(), gone, new Date("2026-01-02T00:00:00Z"));
    const h = await startHost();
    expect(h.lines[0]).toMatchObject({ type: "ready", project: null });
    expect(process.cwd()).toBe(start);
    const list = (await h.get("/api/host/recent-projects")).body as HostRecentProjects;
    expect(list.projects.map((p) => [p.path, p.name, p.missing])).toEqual([
      [gone, "gone", true],
      [a, a.split("/").at(-1), false],
    ]);
    expect(list.lastMissing?.path).toBe(gone);
    expect(events(h, "desktop.no_project")[0]?.fields).toMatchObject({ reason: "last_missing" });
    // Nothing was recorded: no project was opened.
    expect(readRecentProjects(recentFile()).projects.map((p) => p.path)).toEqual([gone, a]);
  });

  test("an unreadable list: the welcome state, the reason logged, and the file written anew once a folder is opened", async () => {
    mkdirSync(dirname(recentFile()), { recursive: true });
    writeFileSync(recentFile(), "{not json");
    const h = await startHost();
    expect(h.host.project).toBe("none");
    expect(events(h, "recent_projects.unreadable")[0]?.fields).toEqual({ reason: "not_json" });
    expect((await h.get("/api/host/recent-projects")).body).toMatchObject({ projects: [] });
    const target = folder("target");
    expect((await h.post("/api/host/requests/pick_folder")).status).toBe(202);
    const request = await h.next("request");
    h.input.write(
      `${JSON.stringify({ type: "folder_picked", id: (request as { id: string }).id, path: target })}\n`
    );
    await h.next("stopped");
    expect(readRecentProjects(recentFile())).toEqual({
      projects: [{ path: target, openedAt: expect.any(String) }],
      problem: null,
    });
  });

  test("without `fromRecent` the project is the current directory (ticket 17), and it is recorded", async () => {
    const h = await startHost({ fromRecent: false });
    expect(h.lines[0]).toMatchObject({ type: "ready", project: start });
    expect(readRecentProjects(recentFile()).projects.map((p) => p.path)).toEqual([start]);
  });
});

describe("with no project open", () => {
  test("business endpoints answer 409 no_project; the page, the host and the settings interfaces answer", async () => {
    const h = await startHost();
    for (const path of BUSINESS) {
      const r = await h.get(path);
      expect([path, r.status, r.body]).toEqual([
        path,
        409,
        { code: "no_project", detail: "no project is open" },
      ]);
    }
    const posted = await h.post("/api/library/works", { arxiv: "2401.00001" });
    expect([posted.status, (posted.body as { code: string }).code]).toEqual([409, "no_project"]);
    expect((await h.post("/api/page-errors", { kind: "error" })).status).toBe(409);
    const page = await h.get("/");
    expect(page.status).toBe(200);
    expect(String(page.body)).toContain("welcome test");
    expect((await h.get("/plan")).status).toBe(200);
    const settings = await h.get("/api/settings");
    expect(settings.status).toBe(200);
    expect(settings.body).toMatchObject({
      running: { project_root: null, data_dir: null, port: expect.any(Number) },
    });
    const put = await fetch(`${h.url}/api/settings/ui.theme`, {
      method: "PUT",
      headers: { Origin: h.url, "Content-Type": "application/json" },
      body: JSON.stringify({ set: "light" }),
    });
    expect(put.status).toBe(200);
    expect(readFileSync(isolated(configFilePath()), "utf8")).toContain('theme = "light"');
    // No project data anywhere: not in the directory the host started in.
    expect(readdirSync(start)).toEqual([]);
  });

  test("a picked folder is left for: recorded first, `stopping` switch, `stopped` with the folder as next", async () => {
    const h = await startHost();
    const target = folder("empty-project");
    expect((await h.post("/api/host/requests/pick_folder")).status).toBe(202);
    const request = (await h.next("request")) as { id: string };
    h.input.write(`${JSON.stringify({ type: "folder_picked", id: request.id, path: target })}\n`);
    expect(await h.next("stopping")).toEqual({ type: "stopping", reason: "switch" });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: target });
    await expect(h.host.stopped).resolves.toBe("switch");
    expect(readRecentProjects(recentFile()).projects.map((p) => p.path)).toEqual([target]);
    expect(events(h, "desktop.leaving")[0]?.fields).toEqual({ source: "picked" });
    // The log never names the folder.
    expect(JSON.stringify(events(h, "desktop.leaving"))).not.toContain("empty-project");
  });

  test("a cancelled pick, and a path that is not a folder, leave nothing", async () => {
    const h = await startHost();
    for (const path of [null, join(start, "nope")]) {
      await h.post("/api/host/requests/pick_folder");
      const request = (await h.next("request")) as { id: string };
      h.input.write(`${JSON.stringify({ type: "folder_picked", id: request.id, path })}\n`);
    }
    await new Promise((r) => setTimeout(r, 100));
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "request", "request"]);
    expect(readRecentProjects(recentFile()).projects).toEqual([]);
  });

  test("opening a recent project: 202, then the switch; only a path of the list, only a folder", async () => {
    const a = folder("a");
    const gone = join(folder("parent"), "gone");
    recordRecentProject(recentFile(), a, new Date("2026-01-01T00:00:00Z"));
    recordRecentProject(recentFile(), gone, new Date("2026-01-02T00:00:00Z"));
    const h = await startHost();
    expect((await h.post("/api/host/recent-projects/open", { path: "/not/listed" })).body).toEqual({
      code: "unknown_project",
      detail: "not a recent project",
    });
    expect((await h.post("/api/host/recent-projects/open", { path: gone })).status).toBe(409);
    expect((await h.post("/api/host/recent-projects/open", {})).status).toBe(400);
    expect(
      (await h.post("/api/host/recent-projects/open", { path: a }, "http://evil.example")).status
    ).toBe(403);
    expect(h.lines.map((l) => l.type)).toEqual(["ready"]);
    expect((await h.post("/api/host/recent-projects/open", { path: a })).status).toBe(202);
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: a });
    expect(readRecentProjects(recentFile()).projects.map((p) => p.path)).toEqual([a, gone]);
    expect(events(h, "desktop.leaving")[0]?.fields).toEqual({ source: "recent" });
  });

  test("removing an entry: the list without it; a missing last project is no longer named once removed", async () => {
    const a = folder("a");
    const gone = join(folder("parent"), "gone");
    recordRecentProject(recentFile(), a, new Date("2026-01-01T00:00:00Z"));
    recordRecentProject(recentFile(), gone, new Date("2026-01-02T00:00:00Z"));
    const h = await startHost();
    expect(
      (await h.post("/api/host/recent-projects/remove", { path: gone }, "http://evil.example"))
        .status
    ).toBe(403);
    const after = await h.post("/api/host/recent-projects/remove", { path: gone });
    expect(after.status).toBe(200);
    expect(after.body).toMatchObject({
      projects: [{ path: a, missing: false }],
      lastMissing: null,
    });
    expect(readRecentProjects(recentFile()).projects.map((p) => p.path)).toEqual([a]);
    // Not in the list: nothing changes.
    expect((await h.post("/api/host/recent-projects/remove", { path: "/x" })).body).toMatchObject({
      projects: [{ path: a }],
    });
  });
});

describe("with a project open", () => {
  test("opening a recent project is refused (switching is ticket 19); a picked folder does not stop the host", async () => {
    const a = folder("a");
    recordRecentProject(recentFile(), a, new Date("2026-01-01T00:00:00Z"));
    const h = await startHost({ fromRecent: false });
    expect((await h.post("/api/host/recent-projects/open", { path: a })).body).toEqual({
      code: "project_open",
      detail: "a project is open",
    });
    await h.post("/api/host/requests/pick_folder");
    const request = (await h.next("request")) as { id: string };
    h.input.write(`${JSON.stringify({ type: "folder_picked", id: request.id, path: a })}\n`);
    await new Promise((r) => setTimeout(r, 100));
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "request"]);
  });

  test("an empty folder opened as a project: the pages' first requests answer, empty", async () => {
    const empty = folder("empty");
    process.chdir(empty);
    const h = await startHost({ fromRecent: false });
    expect((await h.get("/api/library")).status).toBe(200);
    expect((await h.get("/api/papers")).body).toEqual({ papers: [] });
    expect((await h.get("/api/plans")).status).toBe(200);
    expect((await h.get("/api/writer/manuscripts")).status).toBe(200);
    expect((await h.get("/api/host/recent-projects")).body).toMatchObject({
      projects: [{ path: empty, missing: false }],
    });
  });
});

test("the browser form has no recent projects and always a project", async () => {
  const srv = createServer({ dataDir: join(start, "literatures"), port: 0, heartbeatMs: 0 });
  closers.push(() => srv.close());
  const port = await srv.ready();
  const host = (await (await fetch(`http://127.0.0.1:${port}/api/host`)).json()) as HostInfo;
  expect(host.project).toBe("open");
  const r = await fetch(`http://127.0.0.1:${port}/api/host/recent-projects`);
  expect([r.status, ((await r.json()) as { code: string }).code]).toEqual([404, "not_desktop"]);
});
