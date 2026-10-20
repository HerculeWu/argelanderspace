/**
 * The bound-port branch of the origin rule on a real socket (desktop-app ticket 05; the rule itself is tested on the
 * protected base, protected-app.test.ts): a server on an ephemeral port (`port: 0`) lets the page it serves on that
 * port through, REST and `/ws` alike, and refuses another origin. Nothing here knows a default port.
 */

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_PORT } from "@argelanderspace/contracts";
import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { createServer, type RunningServer } from "../src/server.js";
import { isolatedGlobalDirs, makeDataDir, stubSources } from "./helpers.js";

const running: RunningServer[] = [];
const dataDirs: string[] = [];

afterEach(async () => {
  for (const srv of running.splice(0)) await srv.close();
  for (const dir of dataDirs.splice(0)) rmSync(dirname(dir), { recursive: true, force: true });
});

async function start(port: number): Promise<number> {
  const dataDir = makeDataDir();
  dataDirs.push(dataDir);
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
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

test("a server on an ephemeral port: the page it serves passes the guard, another origin is refused", async () => {
  const port = await start(0);
  expect([DEFAULT_PORT, 8000, 5173]).not.toContain(port);
  expect(await putPlans(port, `http://127.0.0.1:${otherPort(port)}`)).toBe(403);
  expect(await putPlans(port, `http://127.0.0.1:${port}`)).toBe(200);
});

test("the WebSocket accepts the page's own origin and refuses another", async () => {
  const port = await start(0);
  expect(await upgrade(port, `http://localhost:${port}`)).toBe("open");
  expect(await upgrade(port, "https://cross-site.invalid")).toBe("403");
});
