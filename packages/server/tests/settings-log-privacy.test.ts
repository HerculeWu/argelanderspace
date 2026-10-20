/**
 * The settings endpoints and the user-level log (desktop-app ticket 10): the endpoints add no event of their own,
 * and what the request log writes about them is the method, the route's pattern and the status. Nothing a request
 * carries (a value, a key that is not one, a body that is not a change) and nothing the file holds (a secret key's
 * value, a faulty key's value) is in the log. A real server with a real log file at the `debug` level, so every
 * request is recorded.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  __setWriterSandboxForTests,
  createLogger,
  type LogFile,
  openLogFile,
} from "@argelanderspace/infra";
import { afterAll, beforeAll, expect, test } from "vitest";
import { SERVER_LOG_EVENTS } from "../src/log.js";
import { createServer, type RunningServer } from "../src/server.js";
import { isolatedGlobalDirs, makeDataDir, stubSources } from "./helpers.js";
import { markersInText, ROOT } from "./log-markers.js";

const MARK = {
  secret: `${ROOT}SECRETKEY`,
  openalex: `${ROOT}OPENALEX`,
  faulty: `${ROOT}FAULTY`,
  value: `${ROOT}VALUE`,
  key: `${ROOT}KEYNAME`,
  body: `${ROOT}BODY`,
  query: `${ROOT}QUERY`,
};

let root: string;
let dataDir: string;
let srv: RunningServer;
let file: LogFile;
let logDir: string;
let url: string;
let configPath: string;

// The probe of the Writer's sandbox writes a record of its own when it ends; this file reads the whole log.
beforeAll(async () => {
  __setWriterSandboxForTests(false);
  root = mkdtempSync(join(tmpdir(), "aspace-settings-log-"));
  dataDir = makeDataDir();
  logDir = join(root, "logs");
  configPath = join(root, "config", "config.toml");
  mkdirSync(dirname(configPath));
  writeFileSync(
    configPath,
    // `log_level = "debug"`: the level follows the file from the first change on (desktop-app ticket 14), and this test
    // reads every request's record.
    `log_level = "debug"\nads_dev_key = "${MARK.secret}"\nopenalex_api_key = "${MARK.openalex}"\nport = "${MARK.faulty}"\n\n[ui]\ntheme = "dark"\n`
  );
  file = openLogFile({ dir: logDir, process: "serve" });
  srv = createServer({
    globalDirs: isolatedGlobalDirs(),
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    deps: { makeSources: () => stubSources() },
    log: createLogger({ events: SERVER_LOG_EVENTS, sink: file, level: "debug" }),
    configPath,
  });
  url = `http://127.0.0.1:${await srv.ready()}`;
});

afterAll(async () => {
  // The test closes the server itself, to read a complete log; a second close is refused. Whatever fails here, the
  // directories of the test are removed.
  try {
    await srv?.close().catch(() => {});
    file?.close();
    __setWriterSandboxForTests(null);
  } finally {
    rmSync(dirname(dataDir), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

const put = (key: string, body: string): Promise<Response> =>
  fetch(`${url}/api/settings/${key}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body,
  });

test("what the log has of the settings requests is their method, route pattern and status — no value, no key, no body", async () => {
  expect((await fetch(`${url}/api/settings`)).status).toBe(200);
  expect((await put("ui.theme", JSON.stringify({ set: "light" }))).status).toBe(200);
  expect((await put("ui.theme", JSON.stringify({ set: MARK.value }))).status).toBe(400);
  expect((await put(MARK.key, JSON.stringify({ set: "light" }))).status).toBe(404);
  expect((await put("ui.theme", `{"${MARK.body}": true}`)).status).toBe(400);
  expect((await put("ui.theme", MARK.body)).status).toBe(400);
  expect((await put(`ui.accent?path=${MARK.query}`, JSON.stringify({ set: "teal" }))).status).toBe(
    200
  );
  expect((await put("port", JSON.stringify({ set: 1 }))).status).toBe(200);
  expect((await put("global_dir", JSON.stringify({ set: `/${MARK.value}` }))).status).toBe(422);
  // A layout the page cannot edit: refused with a category.
  writeFileSync(configPath, `ads_dev_key = "${MARK.secret}"\nui.theme = "dark"\n`);
  expect((await put("ui.theme", JSON.stringify({ set: "light" }))).status).toBe(409);

  await srv.close();
  file.close();
  const text = readdirSync(logDir)
    .map((name) => readFileSync(join(logDir, name), "utf8"))
    .join("");
  const records = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

  // The requests are there, by pattern: this is not an empty log.
  const ofSettings = records.filter((r) => String(r.route).startsWith("/api/settings"));
  expect(ofSettings.map((r) => [r.event, r.method, r.route, r.status])).toEqual([
    ["request.completed", "GET", "/api/settings", 200],
    ["request.completed", "PUT", "/api/settings/:key", 200],
    ["request.failed", "PUT", "/api/settings/:key", 400],
    ["request.failed", "PUT", "/api/settings/:key", 404],
    ["request.failed", "PUT", "/api/settings/:key", 400],
    ["request.failed", "PUT", "/api/settings/:key", 400],
    ["request.completed", "PUT", "/api/settings/:key", 200],
    ["request.completed", "PUT", "/api/settings/:key", 200],
    ["request.failed", "PUT", "/api/settings/:key", 422],
    ["request.failed", "PUT", "/api/settings/:key", 409],
  ]);
  for (const record of ofSettings) {
    expect(Object.keys(record).sort()).toEqual(
      ["duration_ms", "event", "level", "method", "route", "status", "t"].sort()
    );
  }
  // No event was added for a change, and none names a key.
  expect(records.filter((r) => String(r.event).startsWith("settings"))).toEqual([]);
  expect(text).not.toContain("ui.theme");
  // And none of the marked values, in any spelling.
  expect(markersInText(text, Object.values(MARK))).toEqual([]);
  expect(text).not.toContain(ROOT);
});
