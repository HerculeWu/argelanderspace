/**
 * The desktop host as the built program runs it (desktop-app ticket 17): `argelanderspace desktop-host --project …`
 * started as a child process — as the desktop shell will start it — with a throwaway home, global directories and
 * config file. It reads the ready line, asks the address in it for the page and the API, and ends the host the three
 * ways a shell can: a quit line, closing the host's input, and the shell itself being killed. After each the port is
 * free and no process is left. The protocol's details, the requests and the mail undo window are covered in this
 * process by `packages/server/tests/desktop-host.test.ts`.
 *
 * Runs the built `dist/bin.js`: build first (the four gates do).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");

const roots: string[] = [];
const children: ChildProcess[] = [];
/** Processes this file did not start itself (a host started by a stand-in shell), until they are seen gone. */
const pids: number[] = [];
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone, as it should be */
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface World {
  root: string;
  project: string;
  web: string;
  logDir: string;
  env: NodeJS.ProcessEnv;
}

function world(): World {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-host-"));
  roots.push(root);
  const project = join(root, "My Project");
  mkdirSync(project, { recursive: true });
  const web = join(root, "web");
  mkdirSync(web);
  writeFileSync(
    join(web, "index.html"),
    "<!doctype html><title>desktop host page</title><div id=root></div>"
  );
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_DATA_HOME: join(root, ".local", "share"),
    XDG_CACHE_HOME: join(root, ".cache"),
    // No way to the user's session bus, so no real keychain (docs/engineering.md); no display.
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(root, "no-session-bus")}`,
    XDG_RUNTIME_DIR: join(root, "runtime"),
  };
  mkdirSync(join(root, "runtime"), { mode: 0o700 });
  return {
    root,
    project,
    web,
    logDir: join(root, ".local", "share", "argelanderspace", "logs"),
    env,
  };
}

function writeConfig(w: World, text: string): void {
  mkdirSync(join(w.root, ".config", "argelanderspace"), { recursive: true });
  writeFileSync(join(w.root, ".config", "argelanderspace", "config.toml"), text);
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen({ port, host: "127.0.0.1", exclusive: true }, () => s.close(() => resolve(true)));
  });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return check();
}

type Line = Record<string, unknown> & { type: string };

/** Lines a stream carries, as they come. */
function lineReader(stream: NodeJS.ReadableStream): {
  lines: Line[];
  next(type: string, ms?: number): Promise<Line>;
} {
  const lines: Line[] = [];
  let rest = "";
  stream.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    let nl = rest.indexOf("\n");
    while (nl !== -1) {
      lines.push(JSON.parse(rest.slice(0, nl)) as Line);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
  });
  const taken = new Set<number>();
  return {
    lines,
    async next(type, ms = 30_000) {
      let found: Line | undefined;
      await until(() => {
        const i = lines.findIndex((l, n) => l.type === type && !taken.has(n));
        if (i === -1) return false;
        taken.add(i);
        found = lines[i];
        return true;
      }, ms);
      if (!found) throw new Error(`no ${type} line; got ${JSON.stringify(lines)}`);
      return found;
    },
  };
}

function startHost(
  w: World,
  webDist: string = w.web,
  project: string = w.project
): {
  child: ChildProcess;
  out: ReturnType<typeof lineReader>;
  err: () => string;
  exited: Promise<number | null>;
} {
  const child = spawn(
    process.execPath,
    [BIN, "desktop-host", "--project", project, "--web-dist", webDist],
    {
      env: w.env,
      // The shell's working directory is not the project; the host must not depend on it.
      cwd: w.root,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return {
    child,
    out: lineReader(child.stdout as NodeJS.ReadableStream),
    err: () => stderr,
    exited,
  };
}

describe("the built desktop host", () => {
  test("ready line, page and API at its address; a quit line ends it, the port is free and no process is left", async () => {
    const w = world();
    const port = await freePort();
    writeConfig(w, `port = ${port}\n`);
    const h = startHost(w);
    const ready = await h.out.next("ready");
    expect(ready).toEqual({
      type: "ready",
      url: `http://127.0.0.1:${port}/`,
      port,
      configuredPort: port,
      portFallback: false,
      portOccupant: null,
      // The project folder as the system resolves it (the host's working directory): symbolic links resolved.
      project: realpathSync(w.project),
      logDir: w.logDir,
      language: "zh-CN",
      logLevel: "info",
    });
    const page = await fetch(String(ready.url));
    expect([page.status, (await page.text()).includes("desktop host page")]).toEqual([200, true]);
    expect((await fetch(`${ready.url}api/papers`)).status).toBe(200);
    expect(((await (await fetch(`${ready.url}api/host`)).json()) as { mode: string }).mode).toBe(
      "desktop"
    );
    // The project data are in the project folder, as `serve` run there would keep them.
    const settings = (await (await fetch(`${ready.url}api/settings`)).json()) as {
      running: { data_dir: { path: string } };
    };
    expect(settings.running.data_dir.path).toBe(join(w.project, "literatures"));

    h.child.stdin?.write('{"type":"quit"}\n');
    expect(await h.exited).toBe(0);
    expect(h.out.lines.slice(-2)).toEqual([
      { type: "stopping", reason: "quit" },
      { type: "stopped" },
    ]);
    expect(await portFree(port)).toBe(true);
    expect(alive(h.child.pid as number)).toBe(false);
    // The three start lines went to stderr: stdout carries nothing but the protocol.
    expect(h.err()).toContain(`ArgelanderSpace server listening on http://127.0.0.1:${port}`);

    // The log: this process's own file, the start record says desktop.
    const files = readdirSync(w.logDir);
    expect(files).toEqual([expect.stringMatching(new RegExp(`-desktop-${h.child.pid}\\.jsonl$`))]);
    const records = readFileSync(join(w.logDir, files[0] as string), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.find((r) => r.event === "server.started")).toMatchObject({
      mode: "desktop",
      port,
      port_fallback: "no",
      project_root: "~/My Project",
    });
    expect(records.find((r) => r.event === "desktop.stopping")).toMatchObject({ reason: "quit" });
  }, 60_000);

  test("closing its input ends it the same way", async () => {
    const w = world();
    writeConfig(w, "port = 0\n");
    const h = startHost(w);
    const ready = await h.out.next("ready");
    h.child.stdin?.end();
    expect(await h.exited).toBe(0);
    expect(h.out.lines.slice(-2)).toEqual([
      { type: "stopping", reason: "input_closed" },
      { type: "stopped" },
    ]);
    expect(await portFree(Number(ready.port))).toBe(true);
  }, 60_000);

  test("when the shell is killed the host does not stay behind holding the port", async () => {
    const w = world();
    const port = await freePort();
    writeConfig(w, `port = ${port}\n`);
    // A stand-in shell: starts the host with pipes, reports its pid, and is then killed outright.
    const shellCode = `
      const { spawn } = require("node:child_process");
      const host = spawn(process.execPath, ${JSON.stringify([BIN, "desktop-host", "--project", w.project, "--web-dist", w.web])}, { stdio: ["pipe", "pipe", "ignore"] });
      host.stdout.on("data", (d) => { if (String(d).includes('"ready"')) process.stdout.write("host " + host.pid + "\\n"); });
      setInterval(() => {}, 1000);
    `;
    const shell = spawn(process.execPath, ["-e", shellCode], {
      env: w.env,
      cwd: w.root,
      stdio: ["ignore", "pipe", "inherit"],
    });
    children.push(shell);
    let said = "";
    shell.stdout?.on("data", (d: Buffer) => {
      said += d.toString();
    });
    expect(await until(() => /host (\d+)/.test(said), 30_000)).toBe(true);
    const hostPid = Number(/host (\d+)/.exec(said)?.[1]);
    pids.push(hostPid);
    expect(alive(hostPid)).toBe(true);
    expect(await portFree(port)).toBe(false);
    shell.kill("SIGKILL");
    // The host's input ends with the shell: it shuts down and exits.
    expect(await until(() => !alive(hostPid), 20_000)).toBe(true);
    // Seen gone: its pid may be another process's by the end of the test, so it is not signalled again.
    pids.splice(pids.indexOf(hostPid), 1);
    expect(await portFree(port)).toBe(true);
  }, 60_000);

  test("a relative --web-dist is the caller's, as --project is — not the project folder's", async () => {
    const w = world();
    writeConfig(w, "port = 0\n");
    // Run from the folder that holds `web`; the project folder has none.
    const h = startHost(w, "web");
    const ready = await h.out.next("ready");
    const page = await fetch(String(ready.url));
    expect([page.status, (await page.text()).includes("desktop host page")]).toEqual([200, true]);
    h.child.stdin?.end();
    expect(await h.exited).toBe(0);
  }, 60_000);

  test("its input closed with a request half sent: the socket does not hold the stop — exit 0 after the 2 s grace, port free", async () => {
    const w = world();
    writeConfig(w, "port = 0\n");
    const h = startHost(w);
    const ready = await h.out.next("ready");
    // A request the server has begun to read and never sees the end of (desktop-app ticket 31): the server's close
    // cuts it after the grace (server http-close.ts) instead of waiting for it.
    const socket = connect({ host: "127.0.0.1", port: Number(ready.port) });
    await new Promise<void>((r) => socket.once("connect", () => r()));
    socket.on("error", () => {});
    socket.write(`POST /api/host/requests/open_devtools HTTP/1.1\r\nHost: 127.0.0.1\r\n`);
    const started = Date.now();
    h.child.stdin?.end();
    try {
      expect(await h.exited).toBe(0);
    } finally {
      socket.destroy();
    }
    const took = Date.now() - started;
    // the grace is waited out, not skipped; no upper bound here: under load the exit can take longer without anything
    // being wrong, and the test's own timeout still catches a host that waits for the half-sent request forever
    expect(took).toBeGreaterThanOrEqual(1_500);
    expect(alive(h.child.pid as number)).toBe(false);
    expect(await portFree(Number(ready.port))).toBe(true);
  }, 60_000);

  test("its configured port held by another ArgelanderSpace: the second host falls back and says whose the port is", async () => {
    const w = world();
    const port = await freePort();
    writeConfig(w, `port = ${port}\n`);
    const first = startHost(w);
    await first.out.next("ready");
    // Another project: one workbench per data directory (release-0.2 ticket 02), so a second host for the same folder is
    // refused (the next test); this one is about the port.
    const otherProject = join(w.root, "Other Project");
    mkdirSync(otherProject);
    const second = startHost(w, w.web, otherProject);
    const ready = await second.out.next("ready");
    expect(ready).toMatchObject({
      configuredPort: port,
      portFallback: true,
      portOccupant: "argelanderspace",
    });
    expect(ready.port).not.toBe(port);
    const info = (await (await fetch(`${ready.url}api/host`)).json()) as { portFallback: unknown };
    expect(info.portFallback).toEqual({
      configured: port,
      actual: ready.port,
      occupant: "argelanderspace",
    });
    for (const h of [second, first]) {
      h.child.stdin?.end();
      expect(await h.exited).toBe(0);
    }
    expect(await portFree(port)).toBe(true);
  }, 60_000);

  test("a second host for a project folder that already has a workbench is refused: one failed line, exit 1, the first host keeps its record", async () => {
    const w = world();
    const first = startHost(w);
    await first.out.next("ready");
    const second = startHost(w);
    const failed = await second.out.next("failed");
    expect(failed).toMatchObject({ type: "failed" });
    expect(await second.exited).toBe(1);
    expect(second.err()).toMatch(/another ArgelanderSpace workbench is already running/);
    // the first host is untouched and its record is still there
    expect(existsSync(join(w.project, "literatures", "workbench.json"))).toBe(true);
    first.child.stdin?.end();
    expect(await first.exited).toBe(0);
    expect(existsSync(join(w.project, "literatures", "workbench.json"))).toBe(false);
  }, 60_000);

  test("a project folder that is not there: exit 1, no ready line; one failed line the shell tells apart from a crash", () => {
    const w = world();
    const r = spawnSync(
      process.execPath,
      [BIN, "desktop-host", "--project", join(w.root, "missing")],
      {
        env: w.env,
        encoding: "utf8",
        input: "",
        timeout: 30_000,
      }
    );
    expect(r.status).toBe(1);
    // The shell starts a host without --project then, which goes to the welcome state (desktop-app ticket 20).
    expect(r.stdout).toBe(
      `${JSON.stringify({ type: "failed", stage: "project", logDir: w.logDir })}\n`
    );
    expect(r.stderr).toMatch(/^error: the project folder .* is not a directory\n$/);
  });

  test("it is not in the help", () => {
    const r = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8", timeout: 30_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("desktop-host");
  });

  test("the skills that ship with it and the command-line tool (desktop-app ticket 24): the request line names the skills folder; the launcher, installed below the home, runs this CLI", async () => {
    const w = world();
    writeConfig(w, "port = 0\n");
    const h = startHost(w);
    const ready = await h.out.next("ready");
    const url = String(ready.url);
    const origin = { Origin: url.replace(/\/$/, "") };
    const info = (await (await fetch(`${url}api/host`)).json()) as { requests: string[] };
    expect(info.requests).toContain("open_skills_folder");
    expect(
      (
        await fetch(`${url}api/host/requests/open_skills_folder`, {
          method: "POST",
          headers: origin,
        })
      ).status
    ).toBe(202);
    // The repository's skills: three levels up from packages/cli/dist/bin.js, as from sidecar/app/dist/bin.js.
    expect(await h.out.next("request")).toEqual({
      type: "request",
      kind: "open_skills_folder",
      path: realpathSync(join(PKG, "..", "..", "skills")),
    });

    const status = (await (await fetch(`${url}api/host/cli`)).json()) as Record<string, unknown>;
    expect(status).toMatchObject({
      state: "not_installed",
      file: {
        path: join(w.root, ".local", "bin", "argelanderspace"),
        display: "~/.local/bin/argelanderspace",
      },
    });
    const installed = await fetch(`${url}api/host/cli/install`, {
      method: "POST",
      headers: origin,
    });
    expect(installed.status).toBe(200);
    h.child.stdin?.write('{"type":"quit"}\n');
    expect(await h.exited).toBe(0);

    const launcher = join(w.root, ".local", "bin", "argelanderspace");
    const text = readFileSync(launcher, "utf8");
    // This program's own Node and bundle.
    expect(text).toContain(`node='${process.execPath}'`);
    expect(text).toContain(`cli='${realpathSync(BIN)}'`);
    // Both in the isolated environment (temporary home and XDG folders, no session bus), PATH without any node.
    const isolated = { ...w.env, PATH: "/usr/bin:/bin" };
    const version = spawnSync(process.execPath, [BIN, "--version"], {
      encoding: "utf8",
      env: isolated,
    }).stdout;
    const run = spawnSync(launcher, ["--version"], { encoding: "utf8", env: isolated });
    expect([run.status, run.stdout]).toEqual([0, version]);
  }, 60_000);
});
