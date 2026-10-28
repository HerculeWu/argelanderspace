/**
 * `argelanderspace open doc|work|argument-graph` (release-0.2 ticket 05): the real `bin.js` as a child process against a
 * real workbench in this process, with this test acting as the pages (windows) of the workbench. Covers the two paths
 * (workbench running, not running), the most recently active window getting the navigation, and objects that do not
 * exist. The registry and relay themselves are tested in `packages/server/tests/workbench-navigation.test.ts`.
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGlobalDirsLeniently } from "@argelanderspace/infra";
import {
  createServer,
  newWorkbenchToken,
  type RunningServer,
  registerWorkbench,
} from "@argelanderspace/server";
import { afterEach, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const WORK = "arxiv:2603.03522";
const roots: string[] = [];
const closers: (() => unknown)[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-nav-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  cpSync(
    join(PKG, "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  const cli = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, ...args, "--data-dir", dataDir], { env });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d));
      child.stderr?.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stdout, stderr }));
    });
  return { dataDir, cli };
}

async function startWorkbench(dataDir: string) {
  const token = newWorkbenchToken();
  const srv: RunningServer = createServer({
    globalDirs: resolveGlobalDirsLeniently({}).dirs,
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    operationToken: token,
  });
  closers.push(() => srv.close().catch(() => {}));
  const port = await srv.ready();
  const registration = await registerWorkbench(dataDir, { port, token });
  closers.push(() => registration.revoke());
  return { port };
}

/** A page: names itself, then answers every navigation the workbench sends it with `answer`. */
async function page(port: number, id: string, answer: "shown" | string = "shown") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const targets: unknown[] = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type !== "workbench.navigate") return;
    targets.push(msg.target);
    ws.send(
      JSON.stringify({
        type: "window.navigated",
        windowId: id,
        navId: msg.navId,
        ok: answer === "shown",
        ...(answer === "shown" ? {} : { detail: answer }),
      })
    );
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket error")));
  });
  const active = async () => ws.send(JSON.stringify({ type: "window.active", windowId: id }));
  await active();
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { targets, active };
}

const OPEN_COMMANDS: [string[], { op: string; params: Record<string, string> }][] = [
  [
    ["open", "doc", "--doc-id", "d1", "--anchor", "sec-2"],
    { op: "workspace.open_doc", params: { docId: "d1", anchor: "sec-2" } },
  ],
  [["open", "work", "--ref-id", WORK], { op: "library.open_work", params: { refId: WORK } }],
  [
    ["open", "argument-graph", "--work-id", WORK],
    { op: "argument.open", params: { workId: WORK } },
  ],
];

test("without a running workbench every open command refuses, exits 1 and starts nothing", {
  timeout: 60_000,
}, async () => {
  const { dataDir, cli } = setup();
  for (const [args] of OPEN_COMMANDS) {
    const result = await cli(args);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "workbench_required" });
    expect(JSON.parse(result.stdout).detail).toContain("never starts it");
  }
  expect(existsSync(join(dataDir, "workbench.json"))).toBe(false);
});

test("with a workbench the command goes to the most recently active window and exits 0 once it shows it", {
  timeout: 60_000,
}, async () => {
  const { dataDir, cli } = setup();
  const { port } = await startWorkbench(dataDir);
  const a = await page(port, "A");
  const b = await page(port, "B");
  for (const [args, target] of OPEN_COMMANDS) {
    const result = await cli(args);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, status: "ok" });
    expect(b.targets.at(-1)).toEqual(target);
  }
  expect(a.targets).toHaveLength(0);
  await a.active();
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect((await cli(OPEN_COMMANDS[0]?.[0] ?? [])).status).toBe(0);
  expect(a.targets).toHaveLength(1);
  expect(b.targets).toHaveLength(3);
});

test("objects that do not exist are reported, exit 1, and nothing is opened", {
  timeout: 60_000,
}, async () => {
  const { dataDir, cli } = setup();
  const { port } = await startWorkbench(dataDir);
  // No window yet: the Work is still checked first, a Doc cannot be.
  const noWindow = await cli(["open", "doc", "--doc-id", "d1"]);
  expect(noWindow.status).toBe(1);
  expect(JSON.parse(noWindow.stdout)).toMatchObject({ ok: false, status: "no_window" });
  const missingWork = await cli(["open", "work", "--ref-id", "no-such-work"]);
  expect(missingWork.status).toBe(1);
  expect(JSON.parse(missingWork.stdout)).toMatchObject({ ok: false, status: "not_found" });
  const graph = await cli(["open", "argument-graph", "--work-id", "no-such-work"]);
  expect(JSON.parse(graph.stdout)).toMatchObject({ ok: false, status: "not_found" });
  const window = await page(port, "A", "not_found");
  const missingDoc = await cli(["open", "doc", "--doc-id", "no-such-doc"]);
  expect(missingDoc.status).toBe(1);
  expect(JSON.parse(missingDoc.stdout)).toMatchObject({ ok: false, status: "not_found" });
  expect(window.targets).toHaveLength(1); // only the Doc went to the page, which is the one that knows Docs
});

test("bad parameters exit 2 without contacting the workbench; --help lists the open group", async () => {
  const { cli } = setup();
  const bad = await cli(["open", "doc"]);
  expect(bad.status).toBe(2);
  expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, status: "unsupported" });
  const help = await cli(["open", "--help"]);
  expect(help.stdout).toMatch(/doc\b[\s\S]*work\b[\s\S]*argument-graph\b/);
});
