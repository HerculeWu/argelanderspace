/**
 * The desktop shell's menu as the host serves it (desktop-app ticket 21), in this process: the `menu` line the host
 * writes for the shell (the language the settings name now, the recent projects with ids only the host can turn back
 * into folders), and the `menu` lines the shell writes back — each carried out by the same path as the page's request
 * of that kind, or as opening a recent project. The shell itself is `packages/desktop/` (Rust).
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
import {
  __setWriterSandboxForTests,
  configFilePath,
  readRecentProjects,
  recordRecentProject,
  resolveRecentProjectsPath,
} from "@argelanderspace/infra";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import {
  type DesktopHost,
  HOST_MENU_LABEL_MAX,
  type HostOutLine,
  runDesktopHost,
} from "../src/desktop-host.js";

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

async function startHost(
  opts: { fromRecent?: boolean; menuWatchIntervalMs?: number } = { fromRecent: true }
): Promise<Running> {
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
    ...(opts.menuWatchIntervalMs ? { menuWatchIntervalMs: opts.menuWatchIntervalMs } : {}),
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
        // A string is sent as it is (a body of a given size); anything else as JSON.
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
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

const send = (h: Running, line: unknown) => h.input.write(`${JSON.stringify(line)}\n`);
const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("the menu line", () => {
  test("follows the ready line: the language now, the recent projects (a missing one disabled), ids not paths", async () => {
    const a = folder("alpha");
    const gone = join(folder("parent"), "gone-beta");
    recordRecentProject(recentFile(), a, new Date("2026-01-01T00:00:00Z"));
    recordRecentProject(recentFile(), gone, new Date("2026-01-02T00:00:00Z"));
    const h = await startHost();
    expect(h.lines.map((l) => l.type)).toEqual(["ready", "menu"]);
    const menu = await h.next("menu");
    expect(menu.language).toBe("zh-CN");
    expect(menu.recent).toHaveLength(2);
    const [first, second] = menu.recent;
    expect(first?.enabled).toBe(false);
    expect(first?.label).toContain("gone-beta");
    expect(second?.enabled).toBe(true);
    expect(second?.label).toContain("alpha");
    // The id is the host's: the shell never holds a folder to send back.
    for (const item of menu.recent) {
      expect(item.id).toMatch(/^[a-z0-9-]{1,40}$/);
      expect(item.id).not.toContain("alpha");
    }
  });

  test("with a project open, the open project is not listed; the language is the one config.toml names", async () => {
    const a = folder("alpha");
    const b = folder("beta");
    recordRecentProject(recentFile(), b, new Date("2026-01-01T00:00:00Z"));
    recordRecentProject(recentFile(), a, new Date("2026-01-02T00:00:00Z"));
    writeFileSync(isolated(configFilePath()), 'port = 0\n[ui]\nlanguage = "en"\n');
    const h = await startHost();
    const menu = await h.next("menu");
    expect(menu.language).toBe("en");
    expect(menu.recent.map((r) => r.label.includes("beta"))).toEqual([true]);
  });

  test("a long label is shortened (start and end kept), so the shell never leaves it out", async () => {
    const deep = join(
      folder("deep"),
      ...Array.from({ length: 30 }, (_, i) => `level-${i}-folder`),
      "the-end"
    );
    mkdirSync(deep, { recursive: true });
    recordRecentProject(recentFile(), deep, new Date("2026-01-01T00:00:00Z"));
    const h = await startHost({ fromRecent: false });
    const label = (await h.next("menu")).recent[0]?.label ?? "";
    expect(Array.from(label).length).toBeLessThanOrEqual(HOST_MENU_LABEL_MAX);
    // Far under the shell's own limit (1024 bytes) whatever the characters.
    expect(HOST_MENU_LABEL_MAX * 4).toBeLessThan(1024);
    expect(label.startsWith("the-end — ")).toBe(true);
    expect(label.endsWith("/the-end")).toBe(true);
    expect(label).toContain("…");
  });

  test("ids differ from one host to the next for the same list (a click on an old menu never names another folder)", async () => {
    recordRecentProject(recentFile(), folder("alpha"), new Date("2026-01-01T00:00:00Z"));
    const first = await startHost({ fromRecent: false });
    const a = (await first.next("menu")).recent[0]?.id;
    await first.host.stop();
    const second = await startHost({ fromRecent: false });
    const b = (await second.next("menu")).recent[0]?.id;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    // The first host's id means nothing to the second.
    send(second, { type: "menu", item: "open_recent", id: a });
    await waitFor(() => events(second, "desktop.protocol_rejected").length === 1);
    expect(events(second, "desktop.protocol_rejected")[0]?.fields).toEqual({
      reason: "unknown_id",
    });
  });

  test("at most ten recent projects", async () => {
    for (let i = 0; i < 12; i++)
      recordRecentProject(recentFile(), folder(`p${i}`), new Date(Date.UTC(2026, 0, 1 + i)));
    const h = await startHost({ fromRecent: false });
    expect((await h.next("menu")).recent).toHaveLength(10);
  });

  test("written again when the language in config.toml changes, and when the page removes a recent project", async () => {
    const a = folder("alpha");
    recordRecentProject(recentFile(), a, new Date("2026-01-01T00:00:00Z"));
    const h = await startHost({ fromRecent: false, menuWatchIntervalMs: 20 });
    expect((await h.next("menu")).language).toBe("zh-CN");
    writeFileSync(isolated(configFilePath()), 'port = 0\n[ui]\nlanguage = "en"\n');
    const changed = await h.next("menu");
    expect(changed.language).toBe("en");
    expect(changed.recent).toHaveLength(1);
    expect((await h.post("/api/host/recent-projects/remove", { path: a })).status).toBe(200);
    expect((await h.next("menu")).recent).toEqual([]);
  });
});

describe("the shell's menu lines", () => {
  test("open folder, open in browser and the developer tools: the request line the page's request writes", async () => {
    const h = await startHost({ fromRecent: false });
    send(h, { type: "menu", item: "pick_folder" });
    const pick = await h.next("request");
    expect(pick).toMatchObject({ type: "request", kind: "pick_folder" });
    expect(typeof (pick as { id?: unknown }).id).toBe("string");
    send(h, { type: "menu", item: "open_in_browser" });
    expect(await h.next("request")).toEqual({
      type: "request",
      kind: "open_in_browser",
      url: `${h.url}/`,
    });
    send(h, { type: "menu", item: "open_devtools" });
    expect(await h.next("request")).toEqual({ type: "request", kind: "open_devtools" });
    await waitFor(() => events(h, "desktop.request").length === 3);
    expect(events(h, "desktop.request").map((e) => e.fields)).toEqual([
      { kind: "pick_folder", source: "menu" },
      { kind: "open_in_browser", source: "menu" },
      { kind: "open_devtools", source: "menu" },
    ]);
    // The page's own request says so too.
    expect((await h.post("/api/host/requests/open_devtools")).status).toBe(202);
    await waitFor(() => events(h, "desktop.request").length === 4);
    expect(events(h, "desktop.request")[3]?.fields).toEqual({
      kind: "open_devtools",
      source: "page",
    });
  });

  test("a recent project from the menu, with no project open: left for at once, recorded as from the recent list", async () => {
    const a = folder("alpha");
    recordRecentProject(recentFile(), a, new Date("2026-01-01T00:00:00Z"));
    // The last project's folder is gone: the welcome state.
    recordRecentProject(
      recentFile(),
      join(folder("parent"), "gone"),
      new Date("2026-01-02T00:00:00Z")
    );
    const h = await startHost();
    expect(h.lines[0]).toMatchObject({ type: "ready", project: null });
    const menu = await h.next("menu");
    send(h, { type: "menu", item: "open_recent", id: menu.recent[1]?.id });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: a });
    expect(events(h, "desktop.leaving")[0]?.fields).toEqual({ source: "recent" });
    expect(readRecentProjects(recentFile()).projects[0]?.path).toBe(a);
  });

  test("a recent project from the menu with a project open and nothing to interrupt: left for", async () => {
    const a = folder("alpha");
    const b = folder("beta");
    recordRecentProject(recentFile(), b, new Date("2026-01-01T00:00:00Z"));
    recordRecentProject(recentFile(), a, new Date("2026-01-02T00:00:00Z"));
    const h = await startHost();
    const menu = await h.next("menu");
    send(h, { type: "menu", item: "open_recent", id: menu.recent[0]?.id });
    expect(await h.next("stopped")).toEqual({ type: "stopped", next: b });
  });

  test("a recent project whose folder went away after the menu was written: nothing happens, the menu is written anew", async () => {
    const parent = folder("parent");
    const gone = join(parent, "soon-gone");
    mkdirSync(gone);
    recordRecentProject(recentFile(), gone, new Date("2026-01-01T00:00:00Z"));
    const h = await startHost({ fromRecent: false });
    const menu = await h.next("menu");
    expect(menu.recent[0]?.enabled).toBe(true);
    rmSync(gone, { recursive: true });
    send(h, { type: "menu", item: "open_recent", id: menu.recent[0]?.id });
    const again = await h.next("menu");
    expect(again.recent[0]?.enabled).toBe(false);
    expect(h.lines.some((l) => l.type === "stopping")).toBe(false);
    expect(existsSync(gone)).toBe(false);
  });
});
