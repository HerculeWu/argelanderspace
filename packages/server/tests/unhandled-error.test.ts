/**
 * What a client gets when a route of the main app throws and nothing handles it: a plain-text 500. Pinned on the
 * code as it was before the app had an error handler of its own (desktop-app ticket 06), so that adding the handler
 * — which records the failure — is seen not to change the answer.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createServer, type RunningServer } from "../src/server.js";
import { makeDataDir, stubSources } from "./helpers.js";

const running: RunningServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const srv of running.splice(0)) await srv.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a route that throws answers 500 with the plain text `Internal Server Error`", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const dataDir = makeDataDir();
  roots.push(dirname(dataDir));
  // GET /api/plans reads this file with no error handling of its own.
  mkdirSync(join(dirname(dataDir), "status"), { recursive: true });
  writeFileSync(join(dirname(dataDir), "status", "plans.json"), "{ this is not JSON");
  const srv = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
  });
  running.push(srv);
  const port = await srv.ready();

  const response = await fetch(`http://127.0.0.1:${port}/api/plans`);
  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
  expect(await response.text()).toBe("Internal Server Error");
});
