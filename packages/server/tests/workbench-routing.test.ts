/**
 * Single writer and the running workbench (release-0.2 ticket 02): the instance record, stale-record recognition, the
 * token-gated operation route and its agreement with the in-process run. The CLI side is in
 * `packages/cli/tests/workbench-routing.test.ts`.
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATION_CATALOG } from "@argelanderspace/contracts";
import { libraryPaths } from "@argelanderspace/core";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import {
  createLocalOperationRuntime,
  createServer,
  findRunningWorkbench,
  newWorkbenchToken,
  type RunningServer,
  readWorkbenchRecord,
  registerWorkbench,
  runCatalogOperation,
  runOnWorkbench,
  startServer,
  WORKBENCH_RECORD_FILE,
  WorkbenchConflictError,
  workbenchRecordPath,
} from "../src/index.js";
import { isolatedGlobalDirs, stubSources } from "./helpers.js";

const WORK = "arxiv:2603.03522";
const roots: string[] = [];
const servers: RunningServer[] = [];
const sockets: WebSocket[] = [];

function fixtureDataDir(): string {
  const root = mkdtempSync(join(tmpdir(), "aspace-wbroute-"));
  roots.push(root);
  const dir = join(root, "data");
  mkdirSync(join(dir, "library"), { recursive: true });
  cpSync(
    join(import.meta.dirname, "..", "..", "core", "tests", "fixtures", "library.json"),
    join(dir, "library", "library.json")
  );
  return dir;
}

async function workbench(dataDir: string, token = newWorkbenchToken()) {
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
  return { srv, port, token };
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const srv of servers.splice(0)) await srv.close().catch(() => {});
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A pid that existed and is gone. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  return Number(child.stdout);
}

test("registering writes a private record with port, pid and token; revoking removes it", async () => {
  const dir = fixtureDataDir();
  const registration = await registerWorkbench(dir, { port: 4321, token: "t-1" });
  const path = workbenchRecordPath(dir);
  expect(path.endsWith(WORKBENCH_RECORD_FILE)).toBe(true);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readWorkbenchRecord(dir)).toMatchObject({
    v: 1,
    pid: process.pid,
    port: 4321,
    token: "t-1",
  });
  registration.revoke();
  expect(existsSync(path)).toBe(false);
  registration.revoke(); // twice is fine
});

test("revoking never removes a record that is another run's", async () => {
  const dir = fixtureDataDir();
  const first = await registerWorkbench(dir, { port: 1, token: "first", pid: deadPid() });
  // a newer run replaced the stale record
  const second = await registerWorkbench(dir, { port: 2, token: "second" });
  first.revoke();
  expect(readWorkbenchRecord(dir)?.token).toBe("second");
  second.revoke();
});

test("a stale record (process gone) is treated as no workbench and removed", async () => {
  const dir = fixtureDataDir();
  await registerWorkbench(dir, { port: 9, token: "x", pid: deadPid() });
  expect(await findRunningWorkbench(dir)).toBeNull();
  expect(existsSync(workbenchRecordPath(dir))).toBe(false);
});

test("a stale record (process exists, nothing answers the handshake) is removed", async () => {
  const dir = fixtureDataDir();
  // our own pid exists; the port has nothing listening
  await registerWorkbench(dir, { port: 1, token: "x" });
  expect(await findRunningWorkbench(dir)).toBeNull();
  expect(existsSync(workbenchRecordPath(dir))).toBe(false);
});

test("a record whose token the port does not accept is stale", async () => {
  const dir = fixtureDataDir();
  const { port } = await workbench(dir, "the-real-token");
  await registerWorkbench(dir, { port, token: "a-different-token" });
  expect(await findRunningWorkbench(dir)).toBeNull();
  expect(existsSync(workbenchRecordPath(dir))).toBe(false);
});

test("a corrupt record file is stale", async () => {
  const dir = fixtureDataDir();
  writeFileSync(workbenchRecordPath(dir), "{ not json");
  expect(await findRunningWorkbench(dir)).toBeNull();
  expect(existsSync(workbenchRecordPath(dir))).toBe(false);
});

test("a live workbench is found with its port and token", async () => {
  const dir = fixtureDataDir();
  const { port, token } = await workbench(dir);
  await registerWorkbench(dir, { port, token });
  const found = await findRunningWorkbench(dir);
  expect(found).toMatchObject({ port, token, pid: process.pid });
});

test("a second workbench for the same data directory is refused; a stale record does not block", async () => {
  const dir = fixtureDataDir();
  const { port, token } = await workbench(dir);
  const registration = await registerWorkbench(dir, { port, token });
  await expect(registerWorkbench(dir, { port: 7, token: "other" })).rejects.toBeInstanceOf(
    WorkbenchConflictError
  );
  expect(readWorkbenchRecord(dir)?.token).toBe(token);
  registration.revoke();
  await registerWorkbench(dir, { port: 1, token: "stale", pid: deadPid() });
  const again = await registerWorkbench(dir, { port: 8, token: "fresh" });
  expect(readWorkbenchRecord(dir)?.token).toBe("fresh");
  again.revoke();
});

test("serve and the desktop host start through startServer: it registers, close revokes, a second start is refused", async () => {
  const dir = fixtureDataDir();
  const first = await startServer(["--data-dir", dir, "--port", "0"]);
  servers.push(first);
  const record = readWorkbenchRecord(dir);
  expect(record).toMatchObject({ pid: process.pid, port: first.port });
  expect(await findRunningWorkbench(dir)).not.toBeNull();
  await expect(startServer(["--data-dir", dir, "--port", "0"])).rejects.toBeInstanceOf(
    WorkbenchConflictError
  );
  // the refused start did not disturb the first one's record
  expect(readWorkbenchRecord(dir)?.token).toBe(record?.token);
  await first.close();
  expect(existsSync(workbenchRecordPath(dir))).toBe(false);
});

// ---- the operation route ------------------------------------------------------------------------------ //

async function post(port: number, token: string | null, body: unknown) {
  const res = await fetch(`http://127.0.0.1:${port}/api/operations/run`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test("a request without the token, or with a wrong one, is refused and runs nothing", async () => {
  const dir = fixtureDataDir();
  const before = readFileSync(libraryPaths(dir).libraryJson, "utf8");
  const { port, token } = await workbench(dir);
  const write = {
    id: "library.set_main_doc",
    params: { refId: WORK, docId: "arxiv-2603.03522", expectedMainDocId: null },
  };
  for (const bad of [null, "nope", `${token}x`, ""]) {
    const answer = await post(port, bad, write);
    expect(answer.status).toBe(401);
    expect(answer.body).toEqual({ ok: false, status: "unauthorized" });
  }
  const noHandshake = await fetch(`http://127.0.0.1:${port}/api/operations/handshake`);
  expect(noHandshake.status).toBe(401);
  expect(readFileSync(libraryPaths(dir).libraryJson, "utf8")).toBe(before);
  const ok = await fetch(`http://127.0.0.1:${port}/api/operations/handshake`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(await ok.json()).toEqual({ ok: true, pid: process.pid });
});

test("the route is absent when the server has no operation token", async () => {
  const dir = fixtureDataDir();
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir: dir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
  });
  servers.push(srv);
  const port = await srv.ready();
  expect((await post(port, "anything", { id: "library.read", params: {} })).status).not.toBe(200);
});

test("malformed bodies, unknown ids and invalid params are 400 unsupported and run nothing", async () => {
  const dir = fixtureDataDir();
  const { port, token } = await workbench(dir);
  for (const body of [
    "not json",
    {},
    { id: 5 },
    { id: "library.nope", params: {} },
    { id: "library.read", params: { limit: "many" } },
    { id: "library.set_main_doc", params: {} },
  ]) {
    const answer = await post(port, token, body);
    expect(answer.status).toBe(400);
    expect(answer.body).toMatchObject({ ok: false, status: "unsupported" });
    expect(typeof answer.body.detail).toBe("string");
  }
});

test("the route answers exactly what the in-process run answers, read and write, answers of ok:false included", async () => {
  const dir = fixtureDataDir();
  const { port, token } = await workbench(dir);
  const local = createLocalOperationRuntime(libraryPaths(dir));
  const cases: [string, Record<string, unknown>][] = [
    ["library.read", {}],
    ["library.read", { refId: WORK }],
    ["library.read", { refId: "no-such" }],
    ["library.set_main_doc", { refId: "no-such", docId: "d", expectedMainDocId: null }],
    ["library.set_main_doc", { refId: WORK, docId: "ghost", expectedMainDocId: "2603.03522" }],
    ["library.set_main_doc", { refId: WORK, docId: "arxiv-2603.03522", expectedMainDocId: null }],
  ];
  for (const [id, params] of cases) {
    const viaRoute = await runOnWorkbench({ port, token }, { id, params });
    const inProcess = await runCatalogOperation(local, id as never, params);
    expect(viaRoute.status, id).toBe(200);
    expect(viaRoute.body, id).toEqual(JSON.parse(JSON.stringify(inProcess)));
    expect(
      OPERATION_CATALOG.find((op) => op.id === id)?.result.safeParse(viaRoute.body).success
    ).toBe(true);
  }
});

test("a write through the route reaches open pages as the same library.changed update a Copilot write sends", async () => {
  const dir = fixtureDataDir();
  const { port, token } = await workbench(dir);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  sockets.push(ws);
  const seen: Record<string, unknown>[] = [];
  ws.on("message", (data) => seen.push(JSON.parse(data.toString())));
  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", reject);
  });
  const changed = new Promise<void>((resolve) =>
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "library.changed") resolve();
    })
  );
  const answer = await runOnWorkbench(
    { port, token },
    {
      id: "library.set_main_doc",
      params: { refId: WORK, docId: "arxiv-2603.03522", expectedMainDocId: "2603.03522" },
    }
  );
  expect(answer.body).toMatchObject({ ok: true });
  await changed;
  expect(seen.find((m) => m.type === "library.changed")).toMatchObject({ cause: "patch" });
});
