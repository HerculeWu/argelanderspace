/**
 * The desktop host (desktop-app ticket 17), in this process: its line protocol over two in-memory streams, the host
 * interface it gives the page, the port fallback, the shell's events in the log, and the graceful shutdown on a quit
 * line and on the end of its input — with a mail send in its undo window, which must end up interrupted and unsent.
 * The built program as a child process (ready line, page, exit, port released, a killed shell) is
 * `packages/cli/tests/desktop-host.test.ts`.
 *
 * Everything below the home directory is the throwaway one of the isolation setup; the config file is written there.
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
import { createServer as createHttpServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { HOST_REQUEST_KINDS } from "@argelanderspace/contracts";
import {
  __setWriterSandboxForTests,
  configFilePath,
  createCredentialStore,
  createMailAccountStore,
  createNodeMailMailbox,
  createNodeMailOutgoing,
  extractZip,
  type KeychainBackend,
} from "@argelanderspace/infra";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  type FakeFolder,
  type FakeMailbox,
  startFakeMailbox,
} from "../../infra/tests/mail/fake-mailbox.js";
import { TEST_PASSWORD, TEST_USER } from "../../infra/tests/mail/fake-servers.js";
import { type RecordingSmtp, startRecordingSmtp } from "../../infra/tests/mail/fake-smtp.js";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import {
  type DesktopHost,
  type HostOutLine,
  portIsFree,
  projectUnavailableLine,
  runDesktopHost,
} from "../src/desktop-host.js";
import { MailComposeService } from "../src/mail-compose.js";
import { MailOutbox } from "../src/mail-outbox.js";
import { disposeMailSendServices, MailSendService } from "../src/mail-send.js";
import { createServer, type RunningServer } from "../src/server.js";
import { makeDataDir } from "./helpers.js";

beforeAll(() => __setWriterSandboxForTests(false));
afterAll(() => __setWriterSandboxForTests(null));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const KEYCHAIN = async () => ({ state: "unavailable" as const, reason: "no_bus" as const });

const cwd = process.cwd();
const roots: string[] = [];
const closers: Array<() => Promise<unknown>> = [];
let project: string;

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => {});
  process.chdir(cwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(isolated(configFilePath()), { force: true });
});

/** `path`, once it is seen to lie below the throwaway home of this test run; anything else is refused. */
function isolated(path: string): string {
  const isolation = (globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] as
    | { root: string }
    | undefined;
  if (!isolation) throw new Error("isolate-user-dirs.ts did not run");
  const rel = relative(isolation.root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      "a per-user path of this test run is outside its throwaway home; not touching it"
    );
  }
  return path;
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "aspace-host-project-"));
  roots.push(project);
  process.chdir(project);
});

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const s = createHttpServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

function writeConfig(text: string): void {
  const file = isolated(configFilePath());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * A request the server has begun to read and not yet finished: its headers are sent all but the blank line that ends
 * them. The server's close waits for it (it is not an idle connection), so the shutdown stays in its window until
 * `finish` sends the rest; `finish` resolves with the status and body of the answer. It carries no `Origin`, as a
 * program other than a browser would not: once the server's listening socket is closed the origin guard no longer
 * knows the server's own address, so a request with the page's origin would be refused there (403) before it reached
 * the host.
 */
async function heldRequest(
  url: string,
  path: string
): Promise<{ socket: Socket; finish(): Promise<{ status: number; body: string }> }> {
  const { hostname, port } = new URL(url);
  const socket = connect({ host: hostname, port: Number(port) });
  closers.push(async () => void socket.destroy());
  await new Promise<void>((r, j) => {
    socket.once("connect", () => r());
    socket.once("error", j);
  });
  let answer = "";
  socket.on("data", (d: Buffer) => {
    answer += d.toString("utf8");
  });
  socket.write(`POST ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nContent-Length: 0\r\n`);
  return {
    socket,
    async finish() {
      const ended = new Promise<void>((r) => {
        socket.once("end", () => r());
        socket.once("close", () => r());
      });
      socket.write("Connection: close\r\n\r\n");
      await ended;
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1]);
      return { status, body: answer.slice(answer.indexOf("\r\n\r\n") + 4) };
    },
  };
}

interface Running {
  host: DesktopHost;
  input: PassThrough;
  lines: HostOutLine[];
  /** Resolves with the next line of this type (including one already written and not yet taken). */
  next<T extends HostOutLine["type"]>(type: T): Promise<Extract<HostOutLine, { type: T }>>;
  url: string;
  logFile: () => Array<Record<string, unknown>>;
}

async function startHost(
  opts: {
    onFolderPicked?: (path: string | null) => void;
    stopDeadline?: { ms: number; onExpired: () => void };
    /** The bundled skills; default a folder of the test's project. `null`: the host knows of none. */
    skillsDir?: string | null;
    /** The app's Node and CLI for the command-line tool; `null`: the host knows of none. */
    cliLauncher?: { node: string; cli: string } | null;
  } = {}
): Promise<Running> {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: HostOutLine[] = [];
  const taken = new Set<number>();
  const waiters: Array<() => void> = [];
  let rest = "";
  output.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    let nl = rest.indexOf("\n");
    while (nl !== -1) {
      lines.push(JSON.parse(rest.slice(0, nl)) as HostOutLine);
      rest = rest.slice(nl + 1);
      nl = rest.indexOf("\n");
    }
    for (const w of waiters.splice(0)) w();
  });
  const next = async <T extends HostOutLine["type"]>(type: T) => {
    for (let i = 0; i < 200; i++) {
      const index = lines.findIndex((line, n) => line.type === type && !taken.has(n));
      if (index !== -1) {
        taken.add(index);
        return lines[index] as Extract<HostOutLine, { type: T }>;
      }
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 25);
      });
    }
    throw new Error(`no ${type} line; got ${JSON.stringify(lines)}`);
  };
  const logDir = join(process.env.XDG_DATA_HOME ?? "", "argelanderspace", "logs");
  const before = new Set(safeList(logDir));
  const host = await runDesktopHost({
    input,
    output,
    version: "9.9.9-test",
    keychainProbe: KEYCHAIN,
    webDist: join(project, "web"),
    ...(opts.skillsDir === null ? {} : { skillsDir: opts.skillsDir ?? join(project, "skills") }),
    ...(opts.cliLauncher === null || opts.cliLauncher === undefined
      ? {}
      : { cliLauncher: opts.cliLauncher }),
    ...(opts.onFolderPicked ? { onFolderPicked: opts.onFolderPicked } : {}),
    ...(opts.stopDeadline ? { stopDeadline: opts.stopDeadline } : {}),
  });
  closers.push(() => host.stop());
  const ready = await next("ready");
  const mine = safeList(logDir).filter((name) => !before.has(name));
  const logFile = () =>
    readFileSync(join(logDir, mine[0] ?? "missing"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(mine).toHaveLength(1);
  expect(mine[0]).toMatch(new RegExp(`-desktop-${process.pid}(-\\d+)?\\.jsonl$`));
  return { host, input, lines, next, url: ready.url.replace(/\/$/, ""), logFile };
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const ORIGIN = (url: string) => ({ Origin: url });

describe("start", () => {
  beforeEach(() => {
    mkdirSync(join(project, "web"), { recursive: true });
    writeFileSync(
      join(project, "web", "index.html"),
      "<!doctype html><title>host test</title><div id=root></div>"
    );
  });

  test("the ready line names the address, the port, no fallback and the project; the page and the API answer there", async () => {
    const port = await freePort();
    writeConfig(`port = ${port}\n`);
    const h = await startHost();
    expect(h.lines[0]).toEqual({
      type: "ready",
      url: `http://127.0.0.1:${port}/`,
      port,
      configuredPort: port,
      portFallback: false,
      portOccupant: null,
      project: process.cwd(),
      // Where the shell's own events go while no host runs, and what its crash dialog's "show the log folder" opens
      // (desktop-app ticket 20); the language its native dialogs speak.
      logDir: join(process.env.XDG_DATA_HOME ?? "", "argelanderspace", "logs"),
      language: "zh-CN",
      // The log's level now: the shell writes its own file by it while no host runs (desktop-app ticket 20 review).
      logLevel: "info",
    });
    const page = await fetch(`${h.url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("host test");
    expect((await fetch(`${h.url}/api/papers`)).status).toBe(200);
    const info = await (await fetch(`${h.url}/api/host`)).json();
    expect(info).toEqual({
      version: 1,
      app: "argelanderspace",
      mode: "desktop",
      requests: [...HOST_REQUEST_KINDS],
      portFallback: null,
      project: "open",
    });
    // The project data are where `serve` run in the project folder puts them.
    const settings = (await (await fetch(`${h.url}/api/settings`)).json()) as {
      running: { project_root: { path: string }; port: number };
    };
    expect(settings.running.project_root.path).toBe(process.cwd());
    expect(settings.running.port).toBe(port);
    const started = h.logFile().find((r) => r.event === "server.started");
    expect(started).toMatchObject({
      mode: "desktop",
      port,
      port_fallback: "no",
      version: "9.9.9-test",
    });
  });

  test("the diagnostics' environment report says desktop", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    const res = await fetch(`${h.url}/api/diagnostics/export`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    const out = mkdtempSync(join(tmpdir(), "aspace-host-zip-"));
    roots.push(out);
    extractZip(new Uint8Array(await res.arrayBuffer()), out);
    const report = JSON.parse(readFileSync(join(out, "environment-report.json"), "utf8")) as {
      app: unknown;
    };
    expect(report.app).toEqual({ version: "9.9.9-test", mode: "desktop" });
  });
});

describe("what the shell is told about the log and the language (desktop-app ticket 20)", () => {
  beforeEach(() => {
    mkdirSync(join(project, "web"), { recursive: true });
    writeFileSync(join(project, "web", "index.html"), "<!doctype html><title>t</title>");
  });

  test("the ready line's language is the one config.toml names", async () => {
    writeConfig('port = 0\n[ui]\nlanguage = "en"\n');
    const h = await startHost();
    expect(h.lines[0]).toMatchObject({ type: "ready", language: "en" });
  });

  test("the ready line's log level is the one config.toml names", async () => {
    writeConfig('port = 0\nlog_level = "warn"\n');
    const h = await startHost();
    expect(h.lines[0]).toMatchObject({ type: "ready", logLevel: "warn" });
  });

  test("a server that cannot start: the failed line names the log directory, the start's stage", async () => {
    writeConfig("port = 0\n");
    // The project's data directory cannot be made: a file stands where it would be.
    writeFileSync(join(project, "literatures"), "not a folder");
    const input = new PassThrough();
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
    });
    await expect(
      runDesktopHost({ input, output, keychainProbe: KEYCHAIN, webDist: join(project, "web") })
    ).rejects.toBeDefined();
    expect(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    ).toEqual([
      {
        type: "failed",
        stage: "start",
        logDir: join(process.env.XDG_DATA_HOME ?? "", "argelanderspace", "logs"),
      },
    ]);
  });

  test("a project folder that cannot be entered: the line the CLI writes before it exits", () => {
    expect(projectUnavailableLine()).toEqual({
      type: "failed",
      stage: "project",
      logDir: join(process.env.XDG_DATA_HOME ?? "", "argelanderspace", "logs"),
    });
  });
});

describe("port fallback", () => {
  test("a port another program holds: the host listens on a free one and says so, in the ready line, to the page and in the log", async () => {
    const other: Server = createHttpServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ hello: "not the workbench" }));
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise<void>((r) => other.close(() => r())));
    const taken = (other.address() as { port: number }).port;
    writeConfig(`port = ${taken}\n`);
    const h = await startHost();
    const ready = h.lines[0] as Extract<HostOutLine, { type: "ready" }>;
    expect(ready).toMatchObject({
      configuredPort: taken,
      portFallback: true,
      portOccupant: "other",
    });
    expect(ready.port).not.toBe(taken);
    expect(ready.url).toBe(`http://127.0.0.1:${ready.port}/`);
    const info = (await (await fetch(`${h.url}/api/host`)).json()) as { portFallback: unknown };
    expect(info.portFallback).toEqual({ configured: taken, actual: ready.port, occupant: "other" });
    expect(h.logFile().find((r) => r.event === "server.started")).toMatchObject({
      port: ready.port,
      port_fallback: "yes",
      port_configured: taken,
      port_occupant: "other",
    });
    // The other program was only asked `GET /api/host`; it is still there and still answers.
    expect((await fetch(`http://127.0.0.1:${taken}/`)).status).toBe(200);
  });

  test("a port another ArgelanderSpace server holds: told apart from another program", async () => {
    const port = await freePort();
    const own: RunningServer = createServer({
      dataDir: makeDataDir(),
      port,
      webDist: null,
      heartbeatMs: 0,
    });
    await own.ready();
    closers.push(() => own.close());
    writeConfig(`port = ${port}\n`);
    const h = await startHost();
    expect(h.lines[0]).toMatchObject({
      configuredPort: port,
      portFallback: true,
      portOccupant: "argelanderspace",
    });
    const info = (await (await fetch(`${h.url}/api/host`)).json()) as { portFallback: unknown };
    expect(info.portFallback).toMatchObject({ configured: port, occupant: "argelanderspace" });
    // The other server is untouched.
    expect((await fetch(`http://127.0.0.1:${port}/api/host`)).status).toBe(200);
  });
});

describe("native requests", () => {
  test("each kind asked through the host interface writes its line, built from what the host knows — nothing of the page's", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    const seen: HostOutLine[] = [];
    for (const kind of HOST_REQUEST_KINDS) {
      const res = await fetch(`${h.url}/api/host/requests/${kind}`, {
        method: "POST",
        headers: { ...ORIGIN(h.url), "Content-Type": "application/json" },
        // Whatever the page puts here is never read.
        body: JSON.stringify({
          path: "/PAGE-PATH-MARKER",
          url: "https://page-url-marker.example/",
        }),
      });
      expect([kind, res.status, res.headers.get("cache-control")]).toEqual([kind, 202, "no-store"]);
      seen.push(await h.next("request"));
    }
    const port = h.lines[0]?.type === "ready" ? h.lines[0].port : 0;
    const pick = seen[0] as { id?: unknown };
    expect(seen).toEqual([
      { type: "request", kind: "pick_folder", id: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      { type: "request", kind: "open_in_browser", url: `http://127.0.0.1:${port}/` },
      { type: "request", kind: "open_devtools" },
      {
        type: "request",
        kind: "open_log_folder",
        path: join(process.env.XDG_DATA_HOME ?? "", "argelanderspace", "logs"),
      },
      { type: "request", kind: "open_config_file", path: configFilePath() },
      // The bundled skills the host was told of (desktop-app ticket 24).
      { type: "request", kind: "open_skills_folder", path: join(project, "skills") },
    ]);
    expect(typeof pick.id).toBe("string");
    const all = JSON.stringify(h.lines);
    expect(all).not.toContain("MARKER");
    expect(all).not.toContain("marker");
    expect(
      h
        .logFile()
        .filter((r) => r.event === "desktop.request")
        .map((r) => r.kind)
    ).toEqual([...HOST_REQUEST_KINDS]);
  });

  test("a cross-site request is refused and writes nothing; an unknown kind is 404", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    const before = h.lines.length;
    const cross = await fetch(`${h.url}/api/host/requests/open_log_folder`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    const crossGet = await fetch(`${h.url}/api/host`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(crossGet.status).toBe(403);
    const unknown = await fetch(`${h.url}/api/host/requests/open_anything`, {
      method: "POST",
      headers: ORIGIN(h.url),
    });
    expect([unknown.status, ((await unknown.json()) as { code: string }).code]).toEqual([
      404,
      "unknown_request",
    ]);
    await sleep(50);
    expect(h.lines.length).toBe(before);
  });

  test("the folder picked comes back by the request's id; an unknown id or a relative path is not taken", async () => {
    writeConfig("port = 0\n");
    const picked: Array<string | null> = [];
    const h = await startHost({ onFolderPicked: (p) => picked.push(p) });
    await fetch(`${h.url}/api/host/requests/pick_folder`, {
      method: "POST",
      headers: ORIGIN(h.url),
    });
    const req = (await h.next("request")) as { id: string };
    h.input.write(`${JSON.stringify({ type: "folder_picked", id: "nope", path: "/tmp/x" })}\n`);
    h.input.write(
      `${JSON.stringify({ type: "folder_picked", id: req.id, path: "relative/dir" })}\n`
    );
    h.input.write(
      `${JSON.stringify({ type: "folder_picked", id: req.id, path: "/somewhere/picked" })}\n`
    );
    // Answered once: a second answer for the same id is unknown.
    h.input.write(`${JSON.stringify({ type: "folder_picked", id: req.id, path: null })}\n`);
    await sleep(100);
    expect(picked).toEqual(["/somewhere/picked"]);
    const log = h.logFile();
    expect(log.filter((r) => r.event === "desktop.folder_picked")).toMatchObject([
      { outcome: "picked" },
    ]);
    expect(log.filter((r) => r.event === "desktop.protocol_rejected").map((r) => r.reason)).toEqual(
      ["unknown_id", "bad_shape", "unknown_id"]
    );
    // The picked path is not in the log.
    expect(JSON.stringify(log)).not.toContain("somewhere");
  });
});

describe("the shell's events", () => {
  test("are written into the host's log by the same field rules; others are rejected or dropped", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    const send = (o: unknown) => h.input.write(`${JSON.stringify(o)}\n`);
    send({
      type: "shell_event",
      event: "shell.started",
      fields: { version: "0.1.0", webview: "webkitgtk-2.52.6" },
    });
    send({
      type: "shell_event",
      event: "shell.host_exited",
      fields: { exit_code: 1, expected: "no", signal: "SIGKILL" },
    });
    send({
      type: "shell_event",
      event: "shell.dialog_answered",
      fields: {
        dialog: "host_crashed",
        choice: "a sentence the shell made up",
        extra: "SECRET-SHELL-TEXT",
      },
    });
    // The crash dialog has three answers; closing it is a quit (user ruling 3), there is no "closed".
    send({
      type: "shell_event",
      event: "shell.dialog_answered",
      fields: { dialog: "host_crashed", choice: "closed" },
    });
    // The review round's events: no window, a navigation stopped, a line the shell could not read, no single instance.
    send({ type: "shell_event", event: "shell.window_failed", fields: { stage: "guard" } });
    send({ type: "shell_event", event: "shell.navigation_blocked", fields: { scheme: "https" } });
    send({ type: "shell_event", event: "shell.line_rejected", fields: { reason: "not_utf8" } });
    send({
      type: "shell_event",
      event: "shell.instance_unguarded",
      fields: { reason: "foreign_owner" },
    });
    send({
      type: "shell_event",
      event: "shell.something_else",
      fields: { text: "SECRET-SHELL-TEXT" },
    });
    send({
      type: "shell_event",
      event: "shell.started",
      fields: { version: "has spaces SECRET-SHELL-TEXT" },
    });
    h.input.write("not json at all\n");
    send({ type: "dance" });
    send([1, 2, 3]);
    h.input.write(
      `{"type":"shell_event","event":"shell.started","fields":{"version":"${"x".repeat(70 * 1024)}"}}\n`
    );
    await sleep(150);
    const log = h.logFile();
    const shell = log.filter(
      (r) => String(r.event).startsWith("shell.") || r.event === "log.rejected"
    );
    expect(shell).toEqual([
      {
        t: expect.any(String),
        level: "info",
        event: "shell.started",
        version: "0.1.0",
        webview: "webkitgtk-2.52.6",
      },
      {
        t: expect.any(String),
        level: "warn",
        event: "shell.host_exited",
        exit_code: 1,
        expected: "no",
        signal: "SIGKILL",
      },
      {
        t: expect.any(String),
        level: "info",
        event: "shell.dialog_answered",
        dialog: "host_crashed",
        choice: "<invalid-enum>",
        dropped_fields: 1,
      },
      {
        t: expect.any(String),
        level: "info",
        event: "shell.dialog_answered",
        dialog: "host_crashed",
        choice: "<invalid-enum>",
      },
      { t: expect.any(String), level: "warn", event: "shell.window_failed", stage: "guard" },
      { t: expect.any(String), level: "warn", event: "shell.navigation_blocked", scheme: "https" },
      { t: expect.any(String), level: "warn", event: "shell.line_rejected", reason: "not_utf8" },
      {
        t: expect.any(String),
        level: "warn",
        event: "shell.instance_unguarded",
        reason: "foreign_owner",
      },
      { t: expect.any(String), level: "info", event: "shell.started", version: "<invalid-id>" },
    ]);
    expect(log.filter((r) => r.event === "desktop.protocol_rejected").map((r) => r.reason)).toEqual(
      ["unknown_event", "not_json", "unknown_type", "bad_shape", "too_long"]
    );
    expect(JSON.stringify(log)).not.toContain("SECRET-SHELL-TEXT");
    expect(JSON.stringify(log)).not.toContain("something_else");
    // The host still answers after all of that.
    expect((await fetch(`${h.url}/api/host`)).status).toBe(200);
  });
});

describe("the shell's events of the page's links, downloads and menu (desktop-app ticket 21)", () => {
  test("are written with their fixed words only; a path or an address in a field is not", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    const send = (o: unknown) => h.input.write(`${JSON.stringify(o)}\n`);
    send({
      type: "shell_event",
      event: "shell.link_opened",
      fields: { source: "new_window", outcome: "opened" },
    });
    send({
      type: "shell_event",
      event: "shell.link_opened",
      fields: { source: "navigation", outcome: "open_failed" },
    });
    send({
      type: "shell_event",
      event: "shell.navigation_blocked",
      fields: { scheme: "other", source: "new_window" },
    });
    send({ type: "shell_event", event: "shell.download", fields: { outcome: "saved" } });
    send({ type: "shell_event", event: "shell.download", fields: { outcome: "cancelled" } });
    send({ type: "shell_event", event: "shell.download", fields: { outcome: "failed" } });
    send({ type: "shell_event", event: "shell.menu_chosen", fields: { item: "about" } });
    send({ type: "shell_event", event: "shell.menu_chosen", fields: { item: "open_recent" } });
    send({ type: "shell_event", event: "shell.menu_chosen", fields: { item: "quit" } });
    send({
      type: "shell_event",
      event: "shell.link_opened",
      fields: {
        source: "https://example.org/SECRET-LINK",
        outcome: "opened",
        url: "https://example.org/SECRET-LINK",
      },
    });
    send({
      type: "shell_event",
      event: "shell.download",
      fields: { outcome: "/home/u/SECRET-FILE.zip" },
    });
    await sleep(150);
    const log = h.logFile();
    const pick = (event: string) =>
      log.filter((r) => r.event === event).map(({ t: _t, event: _e, ...rest }) => rest);
    expect(pick("shell.link_opened")).toEqual([
      { level: "info", source: "new_window", outcome: "opened" },
      { level: "info", source: "navigation", outcome: "open_failed" },
      { level: "info", source: "<invalid-enum>", outcome: "opened", dropped_fields: 1 },
    ]);
    expect(pick("shell.navigation_blocked")).toEqual([
      { level: "warn", scheme: "other", source: "new_window" },
    ]);
    expect(pick("shell.download")).toEqual([
      { level: "info", outcome: "saved" },
      { level: "info", outcome: "cancelled" },
      { level: "warn", outcome: "failed" },
      { level: "info", outcome: "<invalid-enum>" },
    ]);
    expect(pick("shell.menu_chosen")).toEqual([
      { level: "info", item: "about" },
      { level: "info", item: "open_recent" },
      { level: "info", item: "quit" },
    ]);
    expect(JSON.stringify(log)).not.toContain("SECRET");
  });
});

describe("the shell's events: names of the server's own records", () => {
  test("are not written as those records, but as one fixed rejection", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    const send = (o: unknown) => h.input.write(`${JSON.stringify(o)}\n`);
    // Names the logger knows — the server's own — are still not the shell's to write.
    for (const event of [
      "server.started",
      "process.uncaught_exception",
      "desktop.stopping",
      "log.rejected",
      "toString",
      "__proto__",
    ]) {
      send({ type: "shell_event", event, fields: { port: 1, mode: "browser", reason: "quit" } });
    }
    await sleep(150);
    const log = h.logFile();
    expect(log.filter((r) => r.event === "server.started")).toHaveLength(1);
    expect(log.filter((r) => r.event === "server.started")[0]).toMatchObject({ mode: "desktop" });
    expect(log.some((r) => r.event === "process.uncaught_exception")).toBe(false);
    expect(log.some((r) => r.event === "desktop.stopping")).toBe(false);
    expect(log.some((r) => r.event === "log.rejected")).toBe(false);
    expect(log.filter((r) => r.event === "desktop.protocol_rejected")).toEqual(
      Array.from({ length: 6 }, () => ({
        t: expect.any(String),
        level: "warn",
        event: "desktop.protocol_rejected",
        reason: "unknown_event",
      }))
    );
  });
});

// ---- graceful shutdown, with a mail send in its undo window ------------------------------------------------------ //

const ACC = "acc-0123456789ab";
const keychain = new Map<string, string>();
const backend = (): KeychainBackend => ({
  get: (a) => keychain.get(a) ?? null,
  set: (a, p) => void keychain.set(a, p),
  delete: (a) => keychain.delete(a),
});

/** A send held in its undo window by a service registered for shutdown, as the server's own Mail services are. */
async function sendInWindow(): Promise<{
  service: MailSendService;
  sendId: string;
  smtp: RecordingSmtp;
  drafts: FakeFolder;
}> {
  const root = mkdtempSync(join(tmpdir(), "aspace-host-mail-"));
  roots.push(root);
  const drafts: FakeFolder = { path: "Drafts", attrs: ["\\Drafts"], uidValidity: 31, messages: [] };
  const sent: FakeFolder = { path: "Sent", attrs: ["\\Sent"], uidValidity: 32, messages: [] };
  const imap: FakeMailbox = await startFakeMailbox([
    { path: "INBOX", uidValidity: 30, messages: [] },
    drafts,
    sent,
  ]);
  const smtp = await startRecordingSmtp();
  closers.push(
    () => imap.close(),
    () => smtp.close()
  );
  const store = createMailAccountStore({ dataDir: join(root, "global") });
  const credentials = createCredentialStore({ backend: backend(), dataDir: join(root, "global") });
  await credentials.set(ACC, TEST_PASSWORD, { fileFallbackConsent: false });
  await store.update(0, async () => ({
    accounts: [
      {
        id: ACC as never,
        displayName: "Test Person",
        address: "tester@fake.test",
        preset: "custom",
        imap: { host: "127.0.0.1", port: imap.port, security: "tls" },
        smtp: { host: "127.0.0.1", port: smtp.port, security: "tls" },
        imapUser: TEST_USER,
        smtpUser: TEST_USER,
        credentialRef: ACC as never,
        credentialProtection: "keychain",
      },
    ],
    result: null,
  }));
  const tls = { rejectUnauthorized: false };
  const cache = join(root, "cache");
  const outgoing = createNodeMailOutgoing({ timeoutMs: 3000, tls });
  const compose = new MailComposeService({
    accounts: store,
    credentials,
    mailbox: createNodeMailMailbox({ timeoutMs: 3000, tls }),
    outgoing,
    cacheDir: () => cache,
  });
  const service = new MailSendService({
    compose,
    outgoing,
    outbox: new MailOutbox(() => cache),
    undoMs: 1500,
    registerForShutdown: true,
  });
  const sendId = "00000000-0000-4000-8000-000000000017";
  await service.start(ACC, {
    sendId,
    draft: {
      messageId: "<draft-host@fake.test>",
      inReplyTo: null,
      references: [],
      to: "Ada <ada@fake.test>",
      cc: "",
      bcc: "",
      subject: "host shutdown",
      text: "body",
      attachments: [],
    } as never,
  });
  expect(service.status(ACC, sendId).state).toBe("pending");
  expect(drafts.messages).toHaveLength(1);
  return { service, sendId, smtp, drafts };
}

describe("graceful shutdown", () => {
  afterEach(() => disposeMailSendServices());

  for (const how of ["a quit line", "the end of the input"] as const) {
    test(`on ${how}: the mail in its undo window is interrupted and stays in Drafts, never sent; the port is free`, async () => {
      writeConfig("port = 0\n");
      const h = await startHost();
      const port = h.lines[0]?.type === "ready" ? h.lines[0].port : 0;
      const mail = await sendInWindow();
      if (how === "a quit line") h.input.write('{"type":"quit"}\n');
      else h.input.end();
      const reason = how === "a quit line" ? "quit" : "input_closed";
      expect(await h.next("stopping")).toEqual({ type: "stopping", reason });
      // The first step of the server's close is synchronous: the window is over before anything else stops.
      expect(mail.service.status(ACC, mail.sendId).state).toBe("interrupted");
      expect(await h.host.stopped).toBe(reason);
      expect(h.lines.at(-1)).toEqual({ type: "stopped" });
      expect(await portIsFree(port)).toBe(true);
      // Past the end of the window: nothing went out, the draft is still there.
      await sleep(1800);
      expect(mail.smtp.dataStarted.count).toBe(0);
      expect(mail.drafts.messages).toHaveLength(1);
      expect(h.logFile().find((r) => r.event === "desktop.stopping")).toMatchObject({ reason });
    });
  }

  test("a request that reaches the host interface once the shutdown has begun is refused (409) and writes no line", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    // Accepted before the quit, finished after it: the server is still serving it while the host shuts down.
    const held = await heldRequest(h.url, "/api/host/requests/open_devtools");
    h.input.write('{"type":"quit"}\n');
    await h.next("stopping");
    const answer = await held.finish();
    expect(answer.status).toBe(409);
    expect(JSON.parse(answer.body)).toMatchObject({ code: "shutting_down" });
    expect(await h.host.stopped).toBe("quit");
    expect(h.lines.filter((l) => l.type === "request")).toEqual([]);
    expect(h.logFile().some((r) => r.event === "desktop.request")).toBe(false);
  });

  test("on the end of the input, a shutdown that does not finish in time is given up: the mail was interrupted before", async () => {
    writeConfig("port = 0\n");
    let expiredAt: string | null = null;
    let mail: Awaited<ReturnType<typeof sendInWindow>> | null = null;
    const h = await startHost({
      stopDeadline: {
        ms: 300,
        onExpired: () => {
          expiredAt = mail ? mail.service.status(ACC, mail.sendId).state : "no mail";
        },
      },
    });
    mail = await sendInWindow();
    // Something keeps the server's close from finishing.
    const held = await heldRequest(h.url, "/api/host/requests/open_devtools");
    h.input.end();
    expect(await h.next("stopping")).toEqual({ type: "stopping", reason: "input_closed" });
    await sleep(700);
    expect(expiredAt).toBe("interrupted");
    expect(h.lines.some((l) => l.type === "stopped")).toBe(false);
    expect(h.logFile().filter((r) => r.event === "desktop.stop_timed_out")).toEqual([
      { t: expect.any(String), level: "warn", event: "desktop.stop_timed_out", ms: 300 },
    ]);
    await held.finish();
    expect(await h.host.stopped).toBe("input_closed");
    expect(mail.smtp.dataStarted.count).toBe(0);
  });

  test("a quit line sets no such limit: ending a shutdown that takes long is the shell's", async () => {
    writeConfig("port = 0\n");
    let expired = 0;
    const h = await startHost({ stopDeadline: { ms: 100, onExpired: () => void expired++ } });
    const held = await heldRequest(h.url, "/api/host/requests/open_devtools");
    h.input.write('{"type":"quit"}\n');
    await h.next("stopping");
    await sleep(400);
    expect(expired).toBe(0);
    await held.finish();
    expect(await h.host.stopped).toBe("quit");
  });

  test("a shutdown that finishes in time does not run out its limit", async () => {
    writeConfig("port = 0\n");
    let expired = 0;
    const h = await startHost({ stopDeadline: { ms: 300, onExpired: () => void expired++ } });
    h.input.end();
    expect(await h.host.stopped).toBe("input_closed");
    await sleep(500);
    expect(expired).toBe(0);
    expect(h.logFile().some((r) => r.event === "desktop.stop_timed_out")).toBe(false);
  });

  test("a second quit, or the input ending after a quit, stops it once", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    h.input.write('{"type":"quit"}\n{"type":"quit"}\n');
    h.input.end();
    await h.host.stopped;
    await sleep(50);
    expect(h.lines.filter((l) => l.type === "stopping")).toHaveLength(1);
    expect(h.lines.filter((l) => l.type === "stopped")).toHaveLength(1);
  });
});

describe("the browser form", () => {
  test("`serve` has no host: the page is told browser, and a native request is 404", async () => {
    const srv = createServer({ dataDir: makeDataDir(), port: 0, webDist: null, heartbeatMs: 0 });
    const port = await srv.ready();
    closers.push(() => srv.close());
    const url = `http://127.0.0.1:${port}`;
    expect(await (await fetch(`${url}/api/host`)).json()).toEqual({
      version: 1,
      app: "argelanderspace",
      mode: "browser",
      requests: [],
      portFallback: null,
      project: "open",
    });
    const res = await fetch(`${url}/api/host/requests/open_log_folder`, {
      method: "POST",
      headers: ORIGIN(url),
    });
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([
      404,
      "not_desktop",
    ]);
    // The command-line tool is the desktop app's only (desktop-app ticket 24).
    for (const [method, path] of [
      ["GET", "/api/host/cli"],
      ["POST", "/api/host/cli/install"],
      ["POST", "/api/host/cli/uninstall"],
    ] as const) {
      const cli = await fetch(`${url}${path}`, { method, headers: ORIGIN(url) });
      expect([path, cli.status, ((await cli.json()) as { code: string }).code]).toEqual([
        path,
        404,
        "not_desktop",
      ]);
    }
    expect(safeList(join(isolated(homedir()), ".local", "bin"))).toEqual([]);
  });
});

describe("the bundled skills folder (desktop-app ticket 24)", () => {
  test("a host that knows of none does not offer the request: not listed, 404, no line", async () => {
    writeConfig("port = 0\n");
    const h = await startHost({ skillsDir: null });
    const info = (await (await fetch(`${h.url}/api/host`, { headers: ORIGIN(h.url) })).json()) as {
      requests: string[];
    };
    expect(info.requests).toEqual(
      HOST_REQUEST_KINDS.filter((kind) => kind !== "open_skills_folder")
    );
    const before = h.lines.length;
    const res = await fetch(`${h.url}/api/host/requests/open_skills_folder`, {
      method: "POST",
      headers: ORIGIN(h.url),
    });
    expect([res.status, ((await res.json()) as { code: string }).code]).toEqual([
      404,
      "unknown_request",
    ]);
    await sleep(50);
    expect(h.lines.length).toBe(before);
  });
});

describe("the command-line tool (desktop-app ticket 24)", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
    rmSync(join(isolated(homedir()), ".local", "bin"), { recursive: true, force: true });
  });

  /** A stand-in for the app's Node and CLI. */
  function app(): { node: string; cli: string } {
    const dir = join(project, "app", "dist");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bin.js"), "console.log('cli', process.argv.slice(2).join(' '));\n");
    return { node: process.execPath, cli: join(dir, "bin.js") };
  }

  const bin = () => join(isolated(homedir()), ".local", "bin");
  const post = (h: Running, path: string) =>
    fetch(`${h.url}${path}`, { method: "POST", headers: ORIGIN(h.url) });
  const status = async (h: Running) => {
    const res = await fetch(`${h.url}/api/host/cli`, { headers: ORIGIN(h.url) });
    expect([res.status, res.headers.get("cache-control")]).toEqual([200, "no-store"]);
    return (await res.json()) as Record<string, unknown>;
  };

  test("the status before: not installed, in ~/.local/bin, not on PATH, and the line to add", async () => {
    writeConfig("port = 0\n");
    process.env.PATH = "/usr/bin:/bin";
    const h = await startHost({ cliLauncher: app() });
    expect(await status(h)).toEqual({
      version: 1,
      command: "argelanderspace",
      state: "not_installed",
      file: { path: join(bin(), "argelanderspace"), display: "~/.local/bin/argelanderspace" },
      dir: { path: bin(), display: "~/.local/bin" },
      inPath: false,
      pathLine: 'export PATH="$HOME/.local/bin:$PATH"',
      platform: "posix",
    });
    // Looking writes nothing.
    expect(existsSync(bin())).toBe(false);
  });

  test("install writes the marked launcher; the status then says installed, and on PATH when it is", async () => {
    writeConfig("port = 0\n");
    process.env.PATH = "/usr/bin:/bin";
    const target = app();
    const h = await startHost({ cliLauncher: target });
    const res = await post(h, "/api/host/cli/install");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string; status: Record<string, unknown> };
    expect(body.outcome).toBe("installed");
    expect(body.status.state).toBe("installed");
    const text = readFileSync(join(bin(), "argelanderspace"), "utf8");
    expect(text).toContain("argelanderspace-cli-launcher:");
    expect(text).toContain(target.cli);
    expect((await status(h)).inPath).toBe(false);
    process.env.PATH = `/usr/bin:${bin()}`;
    expect(await status(h)).toMatchObject({ state: "installed", inPath: true });
    // Nothing of the environment is changed by the host: PATH is what the test set.
    expect(process.env.PATH).toBe(`/usr/bin:${bin()}`);
    const records = h.logFile().filter((r) => r.event === "desktop.cli_launcher");
    expect(records.map((r) => [r.action, r.outcome])).toEqual([["install", "installed"]]);
    expect(JSON.stringify(records)).not.toContain(project);
  });

  test("a file of that name without the mark: install and uninstall are 409 foreign, the file is untouched", async () => {
    writeConfig("port = 0\n");
    mkdirSync(bin(), { recursive: true });
    writeFileSync(join(bin(), "argelanderspace"), "#!/bin/sh\necho someone else\n");
    const h = await startHost({ cliLauncher: app() });
    expect((await status(h)).state).toBe("foreign");
    for (const path of ["/api/host/cli/install", "/api/host/cli/uninstall"]) {
      const res = await post(h, path);
      const body = (await res.json()) as { code: string; status: { state: string } };
      expect([path, res.status, body.code, body.status.state]).toEqual([
        path,
        409,
        "foreign",
        "foreign",
      ]);
    }
    expect(readFileSync(join(bin(), "argelanderspace"), "utf8")).toBe(
      "#!/bin/sh\necho someone else\n"
    );
    expect(
      h
        .logFile()
        .filter((r) => r.event === "desktop.cli_launcher")
        .map((r) => [r.action, r.outcome])
    ).toEqual([
      ["install", "foreign"],
      ["uninstall", "foreign"],
    ]);
  });

  test("uninstall removes the marked launcher only; again: not installed", async () => {
    writeConfig("port = 0\n");
    const h = await startHost({ cliLauncher: app() });
    expect((await post(h, "/api/host/cli/install")).status).toBe(200);
    const first = await post(h, "/api/host/cli/uninstall");
    expect([first.status, ((await first.json()) as { outcome: string }).outcome]).toEqual([
      200,
      "removed",
    ]);
    expect(safeList(bin())).toEqual([]);
    const again = await post(h, "/api/host/cli/uninstall");
    const body = (await again.json()) as { outcome: string; status: { state: string } };
    expect([again.status, body.outcome, body.status.state]).toEqual([
      200,
      "not_installed",
      "not_installed",
    ]);
  });

  test("a directory that cannot be written: 500 write_failed with the error code only, nothing left", async () => {
    if (process.getuid?.() === 0) return;
    writeConfig("port = 0\n");
    mkdirSync(bin(), { recursive: true });
    chmodSync(bin(), 0o500);
    try {
      const h = await startHost({ cliLauncher: app() });
      const res = await post(h, "/api/host/cli/install");
      expect([res.status, await res.json()]).toEqual([
        500,
        { code: "write_failed", detail: "EACCES" },
      ]);
      expect(safeList(bin())).toEqual([]);
      expect(
        h
          .logFile()
          .filter((r) => r.event === "desktop.cli_launcher")
          .map((r) => [r.action, r.outcome])
      ).toEqual([["install", "failed"]]);
    } finally {
      chmodSync(bin(), 0o700);
    }
  });

  test("a host that does not know its Node and CLI: 404 cli_unavailable; cross-site requests are refused", async () => {
    writeConfig("port = 0\n");
    const h = await startHost();
    for (const [method, path] of [
      ["GET", "/api/host/cli"],
      ["POST", "/api/host/cli/install"],
      ["POST", "/api/host/cli/uninstall"],
    ] as const) {
      const res = await fetch(`${h.url}${path}`, { method, headers: ORIGIN(h.url) });
      expect([path, res.status, ((await res.json()) as { code: string }).code]).toEqual([
        path,
        404,
        "cli_unavailable",
      ]);
      const cross = await fetch(`${h.url}${path}`, {
        method,
        headers: { Origin: "https://evil.example" },
      });
      expect([path, cross.status]).toEqual([path, 403]);
    }
    const h2 = await startHost({ cliLauncher: app() });
    const cross = await fetch(`${h2.url}/api/host/cli/install`, {
      method: "POST",
      headers: { Origin: "https://evil.example" },
    });
    expect(cross.status).toBe(403);
    expect(safeList(bin())).toEqual([]);
  });
});
