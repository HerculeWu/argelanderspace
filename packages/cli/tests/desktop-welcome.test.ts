/**
 * The welcome state and recently opened projects as the built program runs them (desktop-app ticket 18):
 * `argelanderspace desktop-host` without `--project`, started as a child process the way the shell will — a
 * throwaway home, global directories and config file, a working directory that is not a project. The shell's part is
 * played here: it writes the folder picked, reads the next project from the `stopped` line and starts the next host.
 * The protocol's details are covered in this process by `packages/server/tests/desktop-welcome.test.ts`.
 *
 * Runs the built `dist/bin.js`: build first (the four gates do).
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const BIN = join(fileURLToPath(new URL("..", import.meta.url)), "dist", "bin.js");

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface World {
  root: string;
  shellCwd: string;
  web: string;
  recentFile: string;
  env: NodeJS.ProcessEnv;
}

function world(): World {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aspace-cli-welcome-")));
  roots.push(root);
  const web = join(root, "web");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>welcome page</title><div id=root>");
  const shellCwd = join(root, "shell");
  mkdirSync(shellCwd);
  mkdirSync(join(root, "runtime"), { mode: 0o700 });
  mkdirSync(join(root, ".config", "argelanderspace"), { recursive: true });
  // Port 0: whatever listens on this machine's default port is not this test's business.
  writeFileSync(join(root, ".config", "argelanderspace", "config.toml"), "port = 0\n");
  return {
    root,
    shellCwd,
    web,
    recentFile: join(root, ".local", "share", "argelanderspace", "recent-projects.json"),
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      XDG_DATA_HOME: join(root, ".local", "share"),
      XDG_CACHE_HOME: join(root, ".cache"),
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-session-bus")}`,
      XDG_RUNTIME_DIR: join(root, "runtime"),
    },
  };
}

type Line = Record<string, unknown> & { type: string };

function startHost(w: World, project?: string) {
  const child = spawn(
    process.execPath,
    [BIN, "desktop-host", ...(project ? ["--project", project] : []), "--web-dist", w.web],
    { env: w.env, cwd: w.shellCwd, stdio: ["pipe", "pipe", "pipe"] }
  );
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
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  const taken = new Set<number>();
  return {
    child,
    lines,
    exited,
    async next(type: string): Promise<Line> {
      for (let i = 0; i < 600; i++) {
        const at = lines.findIndex((l, n) => l.type === type && !taken.has(n));
        if (at !== -1) {
          taken.add(at);
          return lines[at] as Line;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no ${type} line; got ${JSON.stringify(lines)}`);
    },
  };
}

const recentPaths = (w: World): string[] =>
  (JSON.parse(readFileSync(w.recentFile, "utf8")) as { projects: { path: string }[] }).projects.map(
    (p) => p.path
  );

test("first start: the welcome state; a picked empty folder is left for, the next host enters it, and the start after that goes straight in", async () => {
  const w = world();
  const first = startHost(w);
  const ready = await first.next("ready");
  expect(ready.project).toBeNull();
  const url = String(ready.url);
  const page = await fetch(url);
  expect([page.status, (await page.text()).includes("welcome page")]).toEqual([200, true]);
  const library = await fetch(`${url}api/library`);
  expect([library.status, ((await library.json()) as { code: string }).code]).toEqual([
    409,
    "no_project",
  ]);
  expect((await fetch(`${url}api/settings`)).status).toBe(200);

  // The page asks for a folder; the shell answers with one it picked: an empty folder.
  const target = join(w.root, "New Project");
  mkdirSync(target);
  expect((await fetch(`${url}api/host/requests/pick_folder`, { method: "POST" })).status).toBe(202);
  const request = await first.next("request");
  first.child.stdin?.write(
    `${JSON.stringify({ type: "folder_picked", id: request.id, path: target })}\n`
  );
  expect(await first.next("stopping")).toEqual({ type: "stopping", reason: "switch" });
  expect(await first.next("stopped")).toEqual({ type: "stopped", next: target });
  expect(await first.exited).toBe(0);
  expect(recentPaths(w)).toEqual([target]);
  // Nothing was written where the shell started the host.
  expect(readdirSync(w.shellCwd)).toEqual([]);

  // The shell starts the next host for that folder.
  const second = startHost(w, target);
  const entered = await second.next("ready");
  expect(entered.project).toBe(target);
  const papers = await fetch(`${entered.url}api/papers`);
  expect([papers.status, await papers.json()]).toEqual([200, { papers: [] }]);
  second.child.stdin?.write('{"type":"quit"}\n');
  expect(await second.exited).toBe(0);

  // A later start without a folder: straight into the last project.
  const third = startHost(w);
  expect((await third.next("ready")).project).toBe(target);
  third.child.stdin?.end();
  expect(await third.exited).toBe(0);

  // The folder is gone: the welcome state again, with the entry marked missing and named as the last one.
  renameSync(target, join(w.root, "moved away"));
  const fourth = startHost(w);
  const welcome = await fourth.next("ready");
  expect(welcome.project).toBeNull();
  const recent = (await (await fetch(`${welcome.url}api/host/recent-projects`)).json()) as {
    projects: { path: string; missing: boolean }[];
    lastMissing: { path: string } | null;
  };
  expect(recent.projects).toEqual([expect.objectContaining({ path: target, missing: true })]);
  expect(recent.lastMissing?.path).toBe(target);
  fourth.child.stdin?.write('{"type":"quit"}\n');
  expect(await fourth.exited).toBe(0);
}, 60_000);

test("an unreadable list: the welcome state, and the file is written anew when a project is opened", async () => {
  const w = world();
  mkdirSync(join(w.recentFile, ".."), { recursive: true });
  writeFileSync(w.recentFile, "not json at all");
  const h = startHost(w);
  expect((await h.next("ready")).project).toBeNull();
  h.child.stdin?.write('{"type":"quit"}\n');
  expect(await h.exited).toBe(0);
  const logDir = join(w.root, ".local", "share", "argelanderspace", "logs");
  const records = readdirSync(logDir).flatMap((name) =>
    readFileSync(join(logDir, name), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  );
  expect(records.find((r) => r.event === "recent_projects.unreadable")).toMatchObject({
    reason: "not_json",
  });
  const project = join(w.root, "Project");
  mkdirSync(project);
  const opened = startHost(w, project);
  expect((await opened.next("ready")).project).toBe(project);
  opened.child.stdin?.write('{"type":"quit"}\n');
  expect(await opened.exited).toBe(0);
  expect(recentPaths(w)).toEqual([project]);
}, 60_000);
