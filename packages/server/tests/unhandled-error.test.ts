/**
 * What happens when a route of the main app throws and nothing handles it: the client gets a plain-text 500 and the
 * server's terminal gets the error. This is the behaviour from before the user-level log (desktop-app ticket 06),
 * which records the failure without changing either.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createServer, type RunningServer } from "../src/server.js";
import { isolatedGlobalDirs, makeDataDir, stubSources } from "./helpers.js";

const running: RunningServer[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const srv of running.splice(0)) await srv.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("a route that throws answers 500 with the plain text `Internal Server Error`", async () => {
  const printed = vi.spyOn(console, "error").mockImplementation(() => {});
  const dataDir = makeDataDir();
  roots.push(dirname(dataDir));
  // GET /api/plans reads this file with no error handling of its own.
  mkdirSync(join(dirname(dataDir), "status"), { recursive: true });
  writeFileSync(join(dirname(dataDir), "status", "plans.json"), "{ this is not JSON");
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
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
  // And the server's terminal gets the error itself, once (Hono's default handling).
  expect(printed).toHaveBeenCalledTimes(1);
  const shown = printed.mock.calls[0]?.[0] as Error;
  expect(shown).toBeInstanceOf(Error);
  expect(shown.message).toContain("is not valid JSON");
});
