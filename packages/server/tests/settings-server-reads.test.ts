/**
 * How the server process reads config.toml (desktop-app ticket 10, revision): every reading is lenient, so a faulty
 * file fails no request, and nothing the TOML parser says about the file — which quotes its lines, a key's line
 * perhaps — reaches an answer or a job record. The sources are the production ones (`realSources`, composed by
 * `createServer`); only the network under them is a stub. The file is the one the server reads by default, below
 * the throwaway home of the test setup; it is removed after every test.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { configFilePath } from "@argelanderspace/infra";
import { afterEach, describe, expect, test } from "vitest";
import { USER_DIRS_ISOLATION } from "../../infra/tests/user-dirs-guard-key.js";
import { createServer, type RunningServer } from "../src/server.js";
import { isolatedGlobalDirs, makeDataDir, stubPipelines } from "./helpers.js";

const MARK = "zqxmark-credential";
const running: RunningServer[] = [];
const roots: string[] = [];

function isolated(path: string): string {
  const isolation = (globalThis as Record<symbol, unknown>)[USER_DIRS_ISOLATION] as
    | { root: string }
    | undefined;
  if (!isolation) throw new Error("isolate-user-dirs.ts did not run");
  const rel = relative(isolation.root, path);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("a per-user path of this test run is outside its throwaway home");
  }
  return path;
}

function writeConfig(toml: string): void {
  const file = isolated(configFilePath());
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, toml);
}

afterEach(async () => {
  for (const srv of running.splice(0)) await srv.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  rmSync(isolated(dirname(configFilePath())), { recursive: true, force: true });
});

/** A server with the real sources over a network that answers nothing (404 for every request). */
async function server(): Promise<{ url: string; dataDir: string; srv: RunningServer }> {
  const dataDir = makeDataDir();
  roots.push(dirname(dataDir));
  const srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    fetchImpl: async () => new Response("not found", { status: 404 }),
    deps: {
      pipelines: stubPipelines(),
      fetchArxivPdf: async () => {
        throw new Error("offline");
      },
    },
  });
  running.push(srv);
  return { url: `http://127.0.0.1:${await srv.ready()}`, dataDir, srv };
}

const post = (url: string, body?: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** Wait until no job of the runner is queued or running. */
async function settled(srv: RunningServer): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (srv.runner.list().every((job) => job.status !== "queued" && job.status !== "running"))
      return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("one faulty key ([ui] theme = 3) fails nothing that reads config.toml", () => {
  test("adding a work, reading the mail accounts and a refresh go through the production sources", async () => {
    writeConfig(`openalex_api_key = "${MARK}"\n[ui]\ntheme = 3\n`);
    const { url, srv } = await server();
    const added = await post(`${url}/api/library/works`, {
      mode: "identifier",
      value: "arXiv:2603.00391",
    });
    expect(added.status).toBe(200);
    expect((await fetch(`${url}/api/mail/accounts`)).status).toBe(200);
    expect((await post(`${url}/api/library/refresh?offline=1`)).status).toBe(200);
    await settled(srv);
    // The one job that fails is the automatic arXiv PDF fetch, for the stub network's sake ("offline").
    expect(
      srv.runner
        .list()
        .filter((job) => job.status === "failed")
        .map((job) => job.error)
    ).toEqual(["offline"]);
  });
});

describe("a config.toml that is not TOML: no answer and no job record carries the parser's text", () => {
  test("refresh, adding a work, the mail accounts and an exploration", {
    timeout: 30_000,
  }, async () => {
    writeConfig(`openalex_api_key = "${MARK}"\nads_dev_key = "${MARK}"\n[ui\ntheme = "dark"\n`);
    const { url, dataDir, srv } = await server();
    const bodies: string[] = [];
    const keep = async (answer: Response) => {
      bodies.push(`${answer.status} ${await answer.text()}`);
    };
    await keep(await post(`${url}/api/library/refresh?offline=1`));
    await keep(
      await post(`${url}/api/library/works`, { mode: "identifier", value: "arXiv:2603.00392" })
    );
    await keep(await fetch(`${url}/api/mail/accounts`));
    await keep(await fetch(`${url}/api/library/discovery?bibcode=2020ApJ...900..100A`));
    await settled(srv);
    const jobsDir = join(dataDir, "jobs");
    const records = readdirSync(jobsDir).map((name) => readFileSync(join(jobsDir, name), "utf-8"));
    expect(records.length).toBeGreaterThan(0);
    for (const text of [...bodies, ...records]) {
      expect(text).not.toContain(MARK);
      expect(text).not.toMatch(/invalid TOML|\^|config\.toml:/);
    }
    // Nothing failed for the file's sake: every one of them was answered as without a config file.
    expect(bodies.map((body) => Number(body.slice(0, 3))).slice(0, 3)).toEqual([200, 200, 200]);
  });
});
