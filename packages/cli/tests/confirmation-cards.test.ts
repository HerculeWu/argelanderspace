/**
 * `library delete-doc` from the CLI against the workbench's confirmation card (release-0.2 ticket 04): the real
 * `bin.js` as a child process, a real workbench in this process, and this test acting as the person at the page.
 * The five outcomes and their exit codes: approved (0), denied (3), Ctrl-C (130, the card is withdrawn), the workbench
 * exiting while the command waits (4), and no workbench running (1, `workbench_required`, nothing runs in the CLI).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const DOC = "2603.03522";
const roots: string[] = [];
const closers: (() => unknown)[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-card-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  cpSync(
    join(PKG, "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  mkdirSync(join(dataDir, "output", DOC), { recursive: true });
  writeFileSync(join(dataDir, "output", DOC, `${DOC}.json`), "{}");
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  const start = (args: string[]) => {
    const child = spawn(process.execPath, [BIN, ...args, "--data-dir", dataDir], { env });
    children.push(child);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d));
    child.stderr?.on("data", (d) => (stderr += d));
    const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) =>
      child.on("close", (status) => resolve({ status, stdout, stderr }))
    );
    return { child, done };
  };
  return { dataDir, start };
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
  const api = `http://127.0.0.1:${port}/api/external-requests`;
  const list = async () =>
    (
      (await (await fetch(api)).json()) as {
        requests: { id: string; state: string; client: { commandLine: string } | null }[];
      }
    ).requests;
  const waitFor = async (state: string) => {
    for (let i = 0; i < 400; i++) {
      const requests = await list();
      if (requests[0]?.state === state) return requests[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`no request reached ${state}`);
  };
  // The person at the page: a browser sends its own Origin on a POST.
  const decide = (id: string, decision: "approve" | "deny") =>
    fetch(`${api}/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ decision }),
    });
  return { srv, list, waitFor, decide };
}

const DELETE = ["library", "delete-doc", "--doc-id", DOC];

test("approved: the command waits on the card (showing its command line), then deletes and exits 0", {
  timeout: 90_000,
}, async () => {
  const { dataDir, start } = setup();
  const wb = await startWorkbench(dataDir);
  const cli = start(DELETE);
  const request = await wb.waitFor("pending");
  expect(request.client?.commandLine).toBe(
    `argelanderspace ${DELETE.join(" ")} --data-dir ${dataDir}`
  );
  // Held, with nothing deleted, as long as nobody decides (no timeout).
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(existsSync(join(dataDir, "output", DOC))).toBe(true);
  expect((await wb.decide(request.id, "approve")).status).toBe(200);
  const result = await cli.done;
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, status: "ok", docId: DOC });
  expect(existsSync(join(dataDir, "output", DOC))).toBe(false);
});

test("denied: exit 3 and the error code denied on stdout; nothing is deleted", {
  timeout: 90_000,
}, async () => {
  const { dataDir, start } = setup();
  const wb = await startWorkbench(dataDir);
  const cli = start(DELETE);
  const request = await wb.waitFor("pending");
  await wb.decide(request.id, "deny");
  const result = await cli.done;
  expect(result.status).toBe(3);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "denied" });
  expect(existsSync(join(dataDir, "output", DOC))).toBe(true);
});

test("Ctrl-C: exit 130 and the card is withdrawn; nothing is deleted", {
  timeout: 90_000,
}, async () => {
  const { dataDir, start } = setup();
  const wb = await startWorkbench(dataDir);
  const cli = start(DELETE);
  await wb.waitFor("pending");
  cli.child.kill("SIGINT");
  const result = await cli.done;
  expect(result.status).toBe(130);
  expect(result.stderr).toMatch(/withdrawn/);
  await wb.waitFor("withdrawn");
  expect(existsSync(join(dataDir, "output", DOC))).toBe(true);
});

test("the workbench exiting while the command waits: exit 4, reported as interrupted", {
  timeout: 90_000,
}, async () => {
  const { dataDir, start } = setup();
  const wb = await startWorkbench(dataDir);
  const cli = start(DELETE);
  await wb.waitFor("pending");
  await wb.srv.close();
  const result = await cli.done;
  expect(result.status).toBe(4);
  expect(result.stderr).toMatch(/interrupted/);
  expect(existsSync(join(dataDir, "output", DOC))).toBe(true);
});

test("no workbench running: refused with workbench_required (exit 1); nothing runs in the CLI process", {
  timeout: 90_000,
}, async () => {
  const { dataDir, start } = setup();
  const result = await start(DELETE).done;
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status: "workbench_required" });
  expect(JSON.parse(result.stdout).detail).toMatch(/open ArgelanderSpace/);
  expect(existsSync(join(dataDir, "output", DOC))).toBe(true);
});

test("a stale record (no live workbench behind it) is the same as no workbench", {
  timeout: 90_000,
}, async () => {
  const { dataDir, start } = setup();
  writeFileSync(
    join(dataDir, "workbench.json"),
    JSON.stringify({
      v: 1,
      pid: 999999,
      port: 1,
      token: "x".repeat(64),
      startedAt: "2026-10-28T00:00:00Z",
    })
  );
  const result = await start(DELETE).done;
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "workbench_required" });
});
