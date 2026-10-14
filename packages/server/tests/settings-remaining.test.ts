/**
 * The rest of the settings (desktop-app ticket 11) over HTTP: a real server on an ephemeral port, a config file in a
 * temporary directory, the real Crossref and OpenAlex clients over an offline fetch stub.
 *
 * - what the process really uses for the restart-only keys (`running`), and the keys changed since it started
 *   (`restartPending`); the server keeps answering on its port after the port is changed;
 * - the global directories are not editable;
 * - the contact email: a malformed one is refused by the endpoint, and named as a faulty key when written by hand;
 *   Crossref and OpenAlex requests carry it when set and carry no address at all when not, without a restart;
 * - the automatic arXiv fetch follows the switch the page changes;
 * - the email and the paths of `running` never reach the user log.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SettingChangeResponse, SettingsSnapshot } from "@argelanderspace/contracts";
import { createLogger, pinnedGlobalDirs } from "@argelanderspace/infra";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createMemorySink, type MemorySink } from "../../infra/tests/log-memory-sink.js";
import { SERVER_LOG_EVENTS, type ServerLog } from "../src/log.js";
import { createServer, type RunningServer } from "../src/server.js";
import { displayPath } from "../src/settings.js";
import { makeDataDir, stubPipelines } from "./helpers.js";

const MARK = "contact.mark-91c2@example.org";

let srv: RunningServer | undefined;
let port: number;
let dataDir: string;
let configDir: string;
let configPath: string;
let requests: { url: string; headers: Record<string, string> }[];
let sink: MemorySink;

function memoryLog(): { sink: MemorySink; log: ServerLog } {
  const made = createMemorySink();
  return {
    sink: made,
    log: createLogger({ events: SERVER_LOG_EVENTS, sink: made, level: "debug" }),
  };
}

/** Crossref and OpenAlex answer from here; everything else is a 404. Nothing leaves the machine. */
const fetchStub = async (input: unknown, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  requests.push({ url, headers });
  const host = new URL(url).host;
  if (host === "api.crossref.org")
    return Response.json({
      message: { DOI: "10.1234/abc", title: ["A synthetic work"], author: [{ family: "Doe" }] },
    });
  if (host === "api.openalex.org")
    return Response.json({ id: "https://openalex.org/W1", display_name: "A synthetic work" });
  return new Response("{}", { status: 404 });
};

async function start(): Promise<void> {
  const made = memoryLog();
  sink = made.sink;
  srv = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    fetchImpl: fetchStub,
    deps: {
      pipelines: stubPipelines(),
      fetchArxivPdf: async () => {
        throw new Error("offline");
      },
    },
    watchIntervalMs: 40,
    configPath,
    log: made.log,
  });
  port = await srv.ready();
}

beforeEach(() => {
  requests = [];
  dataDir = makeDataDir();
  configDir = mkdtempSync(join(tmpdir(), "aspace-settings11-"));
  configPath = join(configDir, "argelanderspace", "config.toml");
  mkdirSync(dirname(configPath));
});

afterEach(async () => {
  try {
    await srv?.close();
  } finally {
    srv = undefined;
    rmSync(dirname(dataDir), { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

const url = (path: string): string => `http://127.0.0.1:${port}${path}`;
const settings = async (): Promise<SettingsSnapshot> =>
  (await (await fetch(url("/api/settings"))).json()) as SettingsSnapshot;
async function put(
  key: string,
  body: unknown
): Promise<{ status: number; body: SettingChangeResponse }> {
  const res = await fetch(url(`/api/settings/${key}`), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as SettingChangeResponse };
}
const addWork = (value: string, mode = "identifier") =>
  fetch(url("/api/library/works"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode, value }),
  });

describe("what the process uses for the restart-only keys", () => {
  test("running: the bound port, the project data directory and the pinned global directories; the path as shown", async () => {
    writeFileSync(configPath, "port = 1861\n");
    await start();
    const body = await settings();
    expect(body.running.port).toBe(port);
    expect(body.running.data_dir.path).toBe(dataDir);
    const pinned = pinnedGlobalDirs();
    expect(pinned).not.toBeNull();
    expect(body.running.global_dir.path).toBe(pinned?.dataDir);
    expect(body.running.global_cache_dir.path).toBe(pinned?.cacheDir);
    expect(body.restartPending).toEqual([]);
    // The page is told how to show the paths: the server's home written as `~`.
    expect(body.pathDisplay).toBe(displayPath(configPath));
    expect(body.running.global_dir.display).toBe(displayPath(pinned?.dataDir ?? ""));
    expect(displayPath(join(homedir(), "x", "config.toml"))).toBe(join("~", "x", "config.toml"));
    expect(displayPath(`${homedir()}other/config.toml`)).toBe(`${homedir()}other/config.toml`);
    expect(displayPath(homedir())).toBe("~");
  });

  test("changing the port or the data directory: pending a restart, and the server keeps working where it is", async () => {
    await start();
    const portChange = await put("port", { set: port === 1862 ? 1863 : 1862 });
    expect(portChange.status).toBe(200);
    expect(portChange.body.ok && portChange.body.settings.restartPending).toEqual(["port"]);
    expect(portChange.body.ok && portChange.body.settings.running.port).toBe(port);
    const dirChange = await put("data_dir", { set: "papers" });
    expect(dirChange.body.ok && dirChange.body.settings.restartPending).toEqual([
      "data_dir",
      "port",
    ]);
    expect(dirChange.body.ok && dirChange.body.settings.running.data_dir.path).toBe(dataDir);
    expect(readFileSync(configPath, "utf-8")).toMatch(/^port = 186[23]\ndata_dir = "papers"\n$/);
    // Still the same server on the same port, with the same data.
    expect((await fetch(url("/api/library"))).status).toBe(200);
    expect((await fetch(url("/api/papers"))).status).toBe(200);
    expect((await settings()).running.port).toBe(port);
    // Back to how it was: nothing pending.
    await put("port", { reset: true });
    const back = await put("data_dir", { reset: true });
    expect(back.body.ok && back.body.settings.restartPending).toEqual([]);
  });

  test("a file that cannot be parsed reports nothing as pending a restart (it says nothing about what it sets)", async () => {
    writeFileSync(configPath, "port = 1861\n");
    await start();
    writeFileSync(configPath, "port = = 1\n");
    const body = await settings();
    expect(body.readonly).toBe(true);
    expect(body.restartPending).toEqual([]);
    expect(body.running.port).toBe(port);
  });

  test("the global directories cannot be changed by the page", async () => {
    await start();
    for (const key of ["global_dir", "global_cache_dir"]) {
      const before = (await settings()).values;
      const res = await put(key, { set: "/elsewhere" });
      expect(res).toEqual({ status: 422, body: { ok: false, reason: "not_editable" } });
      expect((await settings()).values).toEqual(before);
    }
  });
});

describe("the contact email", () => {
  test("the endpoint refuses an address of the wrong shape and leaves the file's bytes alone", async () => {
    const text = "# mine\nport = 1859\n";
    writeFileSync(configPath, text);
    await start();
    for (const bad of ["not an address", "a@b", ` ${MARK}`, `${MARK}​`]) {
      expect(await put("contact_email", { set: bad })).toEqual({
        status: 400,
        body: { ok: false, reason: "invalid_value" },
      });
      expect(readFileSync(configPath, "utf-8")).toBe(text);
    }
    const ok = await put("contact_email", { set: MARK });
    expect(ok.status).toBe(200);
    expect(ok.body.ok && ok.body.settings.values.contact_email).toBe(MARK);
    expect(readFileSync(configPath, "utf-8")).toBe(`${text}contact_email = "${MARK}"\n`);
    // Clearing is restoring the default: the line goes.
    const cleared = await put("contact_email", { reset: true });
    expect(cleared.body.ok && cleared.body.settings.values.contact_email).toBeNull();
    expect(readFileSync(configPath, "utf-8")).toBe(text);
    expect((await settings()).uneditable).toEqual({});
  });

  test("written by hand in the wrong shape: a faulty key, named without its value; nothing is sent", async () => {
    writeFileSync(configPath, 'contact_email = "nobody at example"\n');
    await start();
    const body = await settings();
    expect(body.problems).toEqual([{ key: "contact_email", reason: "must_be_email" }]);
    expect(body.values.contact_email).toBeNull();
    expect(JSON.stringify(body)).not.toContain("nobody");
    expect((await addWork("10.1234/abc")).status).toBe(200);
    const sent = requests.filter((r) => /api\.(crossref|openalex)\.org/.test(r.url));
    expect(sent.length).toBeGreaterThan(0);
    for (const r of sent) {
      expect(decodeURIComponent(r.url)).not.toContain("@");
      expect(JSON.stringify(r.headers)).not.toContain("nobody");
    }
  });

  test("Crossref and OpenAlex: the address when set, none at all when not — a change applies without a restart", async () => {
    await start();
    expect((await addWork("10.1234/abc")).status).toBe(200);
    const services = () => requests.filter((r) => /api\.(crossref|openalex)\.org/.test(r.url));
    const hosts = () => new Set(services().map((r) => new URL(r.url).host));
    expect(hosts()).toEqual(new Set(["api.crossref.org", "api.openalex.org"]));
    for (const r of services()) {
      expect(new URL(r.url).searchParams.has("mailto")).toBe(false);
      expect(decodeURIComponent(r.url)).not.toContain("@");
      for (const value of Object.values(r.headers)) expect(value).not.toContain("@");
    }

    // Set through the page, the next requests carry it: in the query and in the User-Agent.
    expect((await put("contact_email", { set: MARK })).status).toBe(200);
    requests = [];
    expect((await addWork("10.1234/abd")).status).toBe(200);
    expect(hosts()).toEqual(new Set(["api.crossref.org", "api.openalex.org"]));
    for (const r of services()) {
      expect(new URL(r.url).searchParams.get("mailto")).toBe(MARK);
      expect(r.headers["user-agent"]).toBe(`ArgelanderSpace/0.1 (mailto:${MARK})`);
    }

    // Cleared again: none.
    await put("contact_email", { reset: true });
    requests = [];
    expect((await addWork("10.1234/abe")).status).toBe(200);
    expect(services().length).toBeGreaterThan(0);
    for (const r of services()) expect(decodeURIComponent(r.url)).not.toContain("@");

    // Neither the address nor a path of `running` is in the user log.
    const logged = sink.lines.join("\n");
    expect(logged).not.toContain(MARK);
    expect(logged).not.toContain("contact.mark");
  });
});

describe("the automatic arXiv fetch follows the page's switch", () => {
  test("off: adding a work with an arXiv id queues nothing; on again: it queues the fetch", async () => {
    await start();
    const automatic = () =>
      srv?.runner.list().filter((job) => (job.payload as { automatic?: boolean }).automatic) ?? [];
    expect((await put("auto_ingest_arxiv", { set: false })).status).toBe(200);
    expect((await addWork("arXiv:2603.00391")).status).toBe(200);
    expect(automatic()).toHaveLength(0);
    expect((await put("auto_ingest_arxiv", { set: true })).status).toBe(200);
    expect((await addWork("arXiv:2603.00392")).status).toBe(200);
    expect(automatic()).toHaveLength(1);
  });
});
