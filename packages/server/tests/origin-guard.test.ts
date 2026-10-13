/**
 * Which origins may send a mutation or open the WebSocket (desktop-app ticket 05): the Vite dev origin, plus the
 * page this server itself serves on the port it is actually bound to — whatever that port is, an ephemeral one
 * (`port: 0`) included. Real servers on real sockets; nothing here knows a default port.
 */

import { rmSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join } from "node:path";
import { DEFAULT_PORT } from "@argelanderspace/contracts";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import { createServer, type RunningServer } from "../src/server.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const running: RunningServer[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const srv of running.splice(0)) await srv.close();
  for (const dir of dataDirs.splice(0)) rmSync(dirname(dir), { recursive: true, force: true });
});

/** A port nothing listens on right now (a real, non-default one to bind explicitly). */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
}

async function start(port: number): Promise<number> {
  const dataDir = makeDataDir();
  dataDirs.push(dataDir);
  const srv = createServer({
    dataDir,
    port,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
  });
  running.push(srv);
  return srv.ready();
}

/** A write: replace the (empty) plans document. Answers its HTTP status. */
async function putPlans(port: number, origin?: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/plans`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify({ version: 1, rev: 0, plans: [] }),
  });
  return res.status;
}

/** Opens the WebSocket with the given Origin; "open" or the upgrade's rejection status. */
function upgrade(port: number, origin: string): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
    ws.once("open", () => {
      ws.terminate();
      resolve("open");
    });
    ws.once("error", (e) => resolve(/\b(\d{3})\b/.exec(e.message)?.[1] ?? e.message));
  });
}

/** An origin on this machine that is neither the server's port, the dev port, nor a default. */
function otherPort(port: number): number {
  return port === 40_001 ? 40_002 : 40_001;
}

describe.each([
  ["an ephemeral port (port: 0)", async () => start(0)],
  ["an explicit non-default port", async () => start(await freePort())],
])("server on %s", (_name, boot) => {
  test("the bound port is not a default", async () => {
    const port = await boot();
    expect([DEFAULT_PORT, 8000, 5173]).not.toContain(port);
  });

  test("a same-origin write passes the CSRF guard; another origin is still rejected", async () => {
    const port = await boot();
    // rejected ones first: they never reach the plans store, so the accepted write below is rev 0 → 1
    for (const origin of [
      "http://evil.example",
      "https://evil.example",
      `https://127.0.0.1:${port}`,
      `http://evil.example:${port}`,
      `http://127.0.0.1:${otherPort(port)}`,
      `http://localhost:${DEFAULT_PORT}`,
      "http://localhost:8000",
      "http://127.0.0.1:8000",
      "null",
    ]) {
      expect([origin, await putPlans(port, origin)]).toEqual([origin, 403]);
    }
    expect(await putPlans(port, `http://127.0.0.1:${port}`)).toBe(200);
    // accepted by the guard (a 409 for the now stale rev is the plans store answering, not the guard)
    expect(await putPlans(port, `http://localhost:${port}`)).toBe(409);
    expect(await putPlans(port, "http://localhost:5173")).toBe(409);
    expect(await putPlans(port, "http://127.0.0.1:5173")).toBe(409);
    expect(await putPlans(port)).toBe(409); // no Origin: a local tool
  });

  test("the WebSocket accepts the same origins and rejects the others", async () => {
    const port = await boot();
    for (const origin of [
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ]) {
      expect([origin, await upgrade(port, origin)]).toEqual([origin, "open"]);
    }
    for (const origin of [
      "https://cross-site.invalid",
      `http://127.0.0.1:${otherPort(port)}`,
      `http://localhost:${DEFAULT_PORT}`,
      "http://localhost:8000",
    ]) {
      expect([origin, await upgrade(port, origin)]).toEqual([origin, "403"]);
    }
  });
});

test("an app that is not bound to a port allows the dev origins only", async () => {
  const dataDir = makeDataDir();
  dataDirs.push(dataDir);
  const { libraryPaths } = await import("@argelanderspace/core");
  const { statusDirFor } = await import("../src/deps.js");
  const app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: () => {},
    webDist: null,
  });
  const put = async (origin: string): Promise<number> =>
    (
      await app.request("/api/plans", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ version: 1, rev: 0, plans: [] }),
      })
    ).status;
  expect(await put(`http://localhost:${DEFAULT_PORT}`)).toBe(403);
  expect(await put("http://localhost:8000")).toBe(403);
  expect(await put("http://localhost:5173")).toBe(200);
});
