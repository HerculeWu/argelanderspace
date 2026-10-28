/**
 * The CLI's catalog commands against a running workbench (release-0.2 ticket 02): with a live workbench for the data
 * directory the command goes through its HTTP route; without one (or with a stale record) it runs in its own process.
 * Output, errors and exit codes are the same on both paths.
 */
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGlobalDirsLeniently } from "@argelanderspace/infra";
import {
  createServer,
  newWorkbenchToken,
  registerWorkbench,
  workbenchRecordPath,
} from "@argelanderspace/server";
import { afterEach, expect, test } from "vitest";

const PKG = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PKG, "dist", "bin.js");
const WORK = "arxiv:2603.03522";
const roots: string[] = [];
const closers: (() => unknown)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "aspace-cli-wb-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(join(dataDir, "library"), { recursive: true });
  cpSync(
    join(PKG, "..", "core", "tests", "fixtures", "library.json"),
    join(dataDir, "library", "library.json")
  );
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg") };
  // Asynchronous: the workbench of these tests lives in this very process and must keep answering.
  const run = (args: string[]) =>
    new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        [BIN, ...args, "--data-dir", dataDir],
        { env, encoding: "utf8", timeout: 60_000 },
        (error, stdout, stderr) =>
          resolve({
            status: error === null ? 0 : ((error as { code?: number }).code ?? 1),
            stdout,
            stderr,
          })
      );
    });
  return { root, dataDir, run };
}

async function startWorkbench(dataDir: string) {
  const token = newWorkbenchToken();
  const srv = createServer({
    globalDirs: resolveGlobalDirsLeniently({}).dirs,
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    operationToken: token,
  });
  closers.push(() => srv.close());
  const port = await srv.ready();
  const registration = await registerWorkbench(dataDir, { port, token });
  closers.push(() => registration.revoke());
  return { srv, port, token };
}

const READS = [
  ["library", "read"],
  ["library", "read", "--ref-id", WORK],
  ["library", "read", "--ref-id", "no-such"],
  [
    "library",
    "set-main-doc",
    "--ref-id",
    "no-such",
    "--doc-id",
    "d",
    "--expected-main-doc-id",
    "null",
  ],
  [
    "library",
    "set-main-doc",
    "--ref-id",
    WORK,
    "--doc-id",
    "ghost",
    "--expected-main-doc-id",
    "2603.03522",
  ],
  ["library", "set-main-doc", "--ref-id", WORK],
];

test("every command gives the same stdout and exit code through a running workbench as in its own process", {
  timeout: 90_000,
}, async () => {
  const alone = setup();
  const served = setup();
  await startWorkbench(served.dataDir);
  const codes = new Set<number>();
  for (const args of READS) {
    const [a, b] = await Promise.all([alone.run(args), served.run(args)]);
    codes.add(a.status);
    expect(b.stdout, args.join(" ")).toBe(a.stdout);
    expect(b.status, args.join(" ")).toBe(a.status);
    expect(b.stderr, args.join(" ")).toBe(a.stderr);
  }
  // sanity: the set covers the three exit codes
  expect([...codes].sort()).toEqual([0, 1, 2]);
});

test("a command really goes through the workbench: its write reaches the open page, and a read shows the workbench's state", async () => {
  const { dataDir, run } = setup();
  const { port } = await startWorkbench(dataDir);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  closers.push(() => ws.close());
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws failed")));
  });
  const changed = new Promise<Record<string, unknown>>((resolve) =>
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.type === "library.changed") resolve(message);
    })
  );
  const written = await run([
    "library",
    "set-main-doc",
    "--ref-id",
    WORK,
    "--doc-id",
    "arxiv-2603.03522",
    "--expected-main-doc-id",
    "2603.03522",
  ]);
  expect(written.status).toBe(0);
  expect(JSON.parse(written.stdout)).toMatchObject({ ok: true });
  expect(await changed).toMatchObject({ type: "library.changed", cause: "patch" });
  const read = JSON.parse((await run(["library", "read", "--ref-id", WORK])).stdout);
  expect(JSON.stringify(read)).toContain("arxiv-2603.03522");
});

test("a stale record (dead workbench, wrong token) is cleared and the command runs in its own process", async () => {
  const { dataDir, run } = setup();
  await registerWorkbench(dataDir, { port: 1, token: "stale" });
  const result = await run(["library", "read", "--ref-id", WORK]);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: true });
  expect(existsSync(workbenchRecordPath(dataDir))).toBe(false);
  writeFileSync(workbenchRecordPath(dataDir), "garbage");
  expect((await run(["library", "read"])).status).toBe(0);
  expect(existsSync(workbenchRecordPath(dataDir))).toBe(false);
});

test("a record whose port answers to another token is stale too", async () => {
  const { dataDir, run } = setup();
  const { port } = await startWorkbench(dataDir);
  rmSync(workbenchRecordPath(dataDir));
  await registerWorkbench(dataDir, { port, token: "not-the-workbench-token" });
  const result = await run(["library", "read"]);
  expect(result.status).toBe(0);
  expect(existsSync(workbenchRecordPath(dataDir))).toBe(false);
});
