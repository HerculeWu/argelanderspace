/**
 * Navigation operations (release-0.2 ticket 05): the window registry's "most recently active" rule, the relay to the
 * chosen window and its answer, and the operations through the workbench's route and the in-process runtime. The CLI
 * side is in `packages/cli/tests/navigation.test.ts`.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NavigationResultSchema,
  type NavigationTarget,
  type WsWorkbenchNavigate,
} from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  createLocalOperationRuntime,
  createServer,
  newWorkbenchToken,
  type RunningServer,
  runCatalogOperation,
  runOnWorkbench,
  WorkbenchWindows,
} from "../src/index.js";
import { isolatedGlobalDirs, stubSources } from "./helpers.js";

const WORK = "arxiv:2603.03522";
const roots: string[] = [];
const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const srv of servers.splice(0)) await srv.close().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "aspace-nav-"));
  roots.push(root);
  const dir = join(root, "data");
  mkdirSync(join(dir, "library"), { recursive: true });
  cpSync(
    join(import.meta.dirname, "..", "..", "core", "tests", "fixtures", "library.json"),
    join(dir, "library", "library.json")
  );
  return dir;
}

const openDoc = (docId: string, anchor?: string): NavigationTarget => ({
  op: "workspace.open_doc",
  params: anchor === undefined ? { docId } : { docId, anchor },
});

// ---- the registry ----------------------------------------------------------------------------------------------- //

/** A window whose socket is a function: the frames it was sent, and what it answers. */
function fakeWindow(
  windows: WorkbenchWindows,
  id: string,
  answer: "shown" | string | null = "shown"
) {
  const frames: WsWorkbenchNavigate[] = [];
  const link = windows.attach((frame) => {
    frames.push(frame);
    if (answer !== null)
      queueMicrotask(() =>
        link.receive(
          answer === "shown"
            ? { type: "window.navigated", windowId: id, navId: frame.navId, ok: true }
            : {
                type: "window.navigated",
                windowId: id,
                navId: frame.navId,
                ok: false,
                detail: answer,
              }
        )
      );
    return true;
  });
  const active = () => link.receive({ type: "window.active", windowId: id });
  const hidden = () => link.receive({ type: "window.hidden", windowId: id });
  return { frames, link, active, hidden };
}

test("with no window that has identified itself there is nobody to navigate", async () => {
  const windows = new WorkbenchWindows();
  expect(await windows.navigate(openDoc("d1"))).toEqual({ kind: "no_window" });
  const silent = windows.attach(() => true); // a socket that never named itself is not a window
  expect(silent).toBeDefined();
  expect(await windows.navigate(openDoc("d1"))).toEqual({ kind: "no_window" });
});

test("the window that was active last gets the navigation; focusing another moves it", async () => {
  const windows = new WorkbenchWindows();
  const a = fakeWindow(windows, "A");
  const b = fakeWindow(windows, "B");
  a.active();
  b.active();
  expect(await windows.navigate(openDoc("d1"))).toEqual({ kind: "shown" });
  expect(a.frames).toHaveLength(0);
  expect(b.frames.map((f) => f.target)).toEqual([openDoc("d1")]);
  a.active(); // the user went back to A
  expect(await windows.navigate(openDoc("d2"))).toEqual({ kind: "shown" });
  expect(a.frames.map((f) => f.target)).toEqual([openDoc("d2")]);
  expect(b.frames).toHaveLength(1);
});

test("a hidden window is passed over, unless every window is hidden", async () => {
  const windows = new WorkbenchWindows();
  const a = fakeWindow(windows, "A");
  const b = fakeWindow(windows, "B");
  a.active();
  b.active();
  b.hidden();
  await windows.navigate(openDoc("d1"));
  expect(a.frames).toHaveLength(1);
  expect(b.frames).toHaveLength(0);
  a.hidden();
  expect(windows.latestWindowId()).toBe("B"); // both hidden: the one active last (before hiding)
  await windows.navigate(openDoc("d2"));
  expect(b.frames).toHaveLength(1);
  a.active();
  expect(windows.latestWindowId()).toBe("A");
});

test("a closed window is forgotten; one closing before it answers is reported as closed", async () => {
  const windows = new WorkbenchWindows();
  const a = fakeWindow(windows, "A");
  const b = fakeWindow(windows, "B", null);
  a.active();
  b.active();
  const waiting = windows.navigate(openDoc("d1"));
  expect(b.frames).toHaveLength(1);
  b.link.close();
  expect(await waiting).toEqual({ kind: "closed" });
  expect(await windows.navigate(openDoc("d1"))).toEqual({ kind: "shown" }); // A is the only one left
  expect(a.frames).toHaveLength(1);
});

test("an answer is taken only from the window it was asked of, and a window keeps its first id", async () => {
  const windows = new WorkbenchWindows({ reportMs: 30 });
  const a = fakeWindow(windows, "A", null);
  const b = fakeWindow(windows, "B", null);
  a.active();
  b.active();
  b.link.receive({ type: "window.active", windowId: "A" }); // B named itself B; this frame is not its own
  expect(windows.latestWindowId()).toBe("B");
  const waiting = windows.navigate(openDoc("d1"));
  const navId = b.frames[0]?.navId ?? "";
  a.link.receive({ type: "window.navigated", windowId: "A", navId, ok: true }); // A was not asked
  expect(await waiting).toEqual({ kind: "timeout" });
});

test("an abandoned request (the CLI left) stops waiting", async () => {
  const windows = new WorkbenchWindows();
  const a = fakeWindow(windows, "A", null);
  a.active();
  const controller = new AbortController();
  const waiting = windows.navigate(openDoc("d1"), { signal: controller.signal });
  controller.abort();
  expect(await waiting).toEqual({ kind: "aborted" });
});

// ---- through the workbench -------------------------------------------------------------------------------------- //

async function workbench(dataDir: string) {
  const token = newWorkbenchToken();
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    operationToken: token,
  });
  servers.push(srv);
  const port = await srv.ready();
  return { port, token };
}

/** A page as the server sees it: a socket that names itself and answers `workbench.navigate` as told. */
async function page(port: number, id: string, answer: "shown" | string = "shown") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const frames: WsWorkbenchNavigate[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type !== "workbench.navigate") return;
    frames.push(msg);
    ws.send(
      JSON.stringify(
        answer === "shown"
          ? { type: "window.navigated", windowId: id, navId: msg.navId, ok: true }
          : { type: "window.navigated", windowId: id, navId: msg.navId, ok: false, detail: answer }
      )
    );
  });
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const send = (type: "window.active" | "window.hidden") =>
    new Promise<void>((resolve) =>
      ws.send(JSON.stringify({ type, windowId: id }), () => resolve())
    );
  await send("window.active");
  return { ws, frames, active: () => send("window.active"), hidden: () => send("window.hidden") };
}

/** The sockets' frames cross a real socket: give the server a beat to have read the last one. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function run(port: number, token: string, id: string, params: Record<string, unknown>) {
  return runOnWorkbench({ port, token }, { id, params });
}

test("a running workbench with no window open says so, and opens nothing", async () => {
  const { port, token } = await workbench(fixtureDataDir());
  const answer = await run(port, token, "workspace.open_doc", { docId: "d1" });
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({ ok: false, status: "no_window" });
  expect(NavigationResultSchema.safeParse(answer.body).success).toBe(true);
});

test("the operation goes to the most recently active window of the workbench, and its answer is the result", async () => {
  const { port, token } = await workbench(fixtureDataDir());
  const a = await page(port, "A");
  const b = await page(port, "B");
  await settle();
  const first = await run(port, token, "workspace.open_doc", { docId: "d1", anchor: "sec-2" });
  expect(first.body).toEqual({ ok: true, status: "ok" });
  expect(b.frames.map((f) => f.target)).toEqual([openDoc("d1", "sec-2")]);
  expect(a.frames).toHaveLength(0);
  await a.active();
  await settle();
  await run(port, token, "library.open_work", { refId: WORK });
  await run(port, token, "argument.open", { workId: WORK });
  expect(a.frames.map((f) => f.target)).toEqual([
    { op: "library.open_work", params: { refId: WORK } },
    { op: "argument.open", params: { workId: WORK } },
  ]);
  expect(b.frames).toHaveLength(1);
});

test("the page's own reasons become honest results", async () => {
  const { port, token } = await workbench(fixtureDataDir());
  const missing = await page(port, "A", "not_found");
  await settle();
  const doc = await run(port, token, "workspace.open_doc", { docId: "nope" });
  expect(doc.body).toMatchObject({ ok: false, status: "not_found" });
  missing.ws.close();
  await settle();
  for (const [reason, status] of [
    ["anchor_not_found", "not_found"],
    ["leave_blocked", "not_displayed"],
    ["unavailable", "not_displayed"],
  ] as const) {
    const ok = await page(port, `P-${reason}`, reason);
    await settle();
    const answer = await run(port, token, "workspace.open_doc", { docId: "d1", anchor: "x" });
    expect(answer.body).toMatchObject({ ok: false, status });
    expect(NavigationResultSchema.safeParse(answer.body).success).toBe(true);
    ok.ws.close();
    await settle();
  }
});

test("a Work the Library does not have is not found without bothering any window", async () => {
  const { port, token } = await workbench(fixtureDataDir());
  const a = await page(port, "A");
  await settle();
  for (const [id, params] of [
    ["library.open_work", { refId: "no-such-work" }],
    ["argument.open", { workId: "no-such-work" }],
  ] as const) {
    const answer = await run(port, token, id, params);
    expect(answer.body).toMatchObject({ ok: false, status: "not_found" });
  }
  expect(a.frames).toHaveLength(0);
});

test("invalid parameters are refused by the route before any window is asked", async () => {
  const { port, token } = await workbench(fixtureDataDir());
  const a = await page(port, "A");
  await settle();
  const answer = await run(port, token, "workspace.open_doc", { docId: "" });
  expect(answer.status).toBe(400);
  expect(a.frames).toHaveLength(0);
});

test("without a workbench the operation is refused in the process and opens nothing", async () => {
  const dir = fixtureDataDir();
  const runtime = createLocalOperationRuntime(libraryPaths(dir));
  for (const [id, params] of [
    ["workspace.open_doc", { docId: "d1" }],
    ["library.open_work", { refId: WORK }],
    ["argument.open", { workId: WORK }],
  ] as const) {
    const result = await runCatalogOperation(runtime, id, params);
    expect(result).toMatchObject({ ok: false, status: "workbench_required" });
    expect(NavigationResultSchema.safeParse(result).success).toBe(true);
  }
});
