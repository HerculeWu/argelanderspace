/**
 * Diagnostics over HTTP (desktop-app ticket 14): the log directory and what a bundle would take
 * (`GET /api/diagnostics`), the bundle itself (`POST /api/diagnostics/export`), the record an export writes, and the
 * log level taking effect without a restart. A real server on a throwaway data directory, log directory and config
 * file; the keychain is an in-memory fake and the keychain probe a fake answer — nothing here asks the real ones.
 *
 * The reverse privacy assertions put marker strings into what the bundle could pick up (config values, the ADS token,
 * the global directory's path, the source in a compile-failure log) and search the unpacked bundle for them.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  DIAGNOSTICS_CLIENT_MAX_LENGTH,
  DIAGNOSTICS_COMPILE_LOGS_MAX_FILES,
  DIAGNOSTICS_EXPORT_BODY_MAX_BYTES,
  type DiagnosticsInfo,
  SECRET_SETTING_KEYS,
} from "@argelanderspace/contracts";
import {
  __setWriterSandboxForTests,
  ADS_TOKEN_ID,
  createCredentialStore,
  createLogger,
  extractZip,
  type KeychainBackend,
  type LogFile,
  openLogFile,
} from "@argelanderspace/infra";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { DIAGNOSTICS_OMITTED_KEYS } from "../src/diagnostics.js";
import { SERVER_LOG_EVENTS } from "../src/log.js";
import { createServer, type RunningServer } from "../src/server.js";
import { makeDataDir, stubSources } from "./helpers.js";
import { ROOT, spellings } from "./log-markers.js";

const MARK = {
  contact: `${ROOT}contact@example.org`,
  openalex: `${ROOT}OPENALEXKEY`,
  devKey: `${ROOT}DEVKEY`,
  token: `${ROOT}ADSTOKEN0123456789`,
  globalDir: `${ROOT}GLOBALDIR`,
  source: `${ROOT}SOURCESNIPPET`,
  stray: `${ROOT}STRAYFILE`,
};

/** A log file's name, as infra `log/files.ts` writes them (the one rule the bundle follows). */
const LOG_NAME = /^\d{8}T\d{9}Z-[a-z][a-z0-9]*-\d+(?:-\d+)?\.jsonl$/;

const JOB_A = "ingest-11111111-2222-4333-8444-555555555555";
const JOB_B = "ingest-66666666-7777-4888-8999-aaaaaaaaaaaa";
const MANUSCRIPT = "m_0a1b2c3d";

let root: string;
let dataDir: string;
let logDir: string;
let globalDir: string;
let configPath: string;
let texDir: string;
let file: LogFile;
let srv: RunningServer;
let url: string;

const keychain = new Map<string, string>();
const backend: KeychainBackend = {
  get: (id, service) => keychain.get(`${service}/${id}`) ?? null,
  set: (id, password, service) => {
    keychain.set(`${service}/${id}`, password);
  },
  delete: (id, service) => keychain.delete(`${service}/${id}`),
};

beforeAll(async () => {
  __setWriterSandboxForTests(false);
  root = mkdtempSync(join(tmpdir(), "aspace-diagnostics-"));
  dataDir = makeDataDir();
  logDir = join(root, "logs");
  globalDir = join(root, MARK.globalDir);
  // A TeX directory under the (throwaway) home directory: the report writes it with `~`.
  texDir = join(homedir(), "texlive-for-diagnostics", "bin");
  configPath = join(root, "config", "config.toml");
  mkdirSync(dirname(configPath));
  writeFileSync(
    configPath,
    [
      `contact_email = "${MARK.contact}"`,
      `openalex_api_key = "${MARK.openalex}"`,
      `ads_dev_key = "${MARK.devKey}"`,
      `global_dir = "${globalDir}"`,
      `global_cache_dir = "${join(globalDir, "cache")}"`,
      `tex_dir = "${texDir}"`,
      `log_level = "info"`,
      "",
    ].join("\n")
  );
  // An older run's log, a directory that is not a log file, then this run's file.
  mkdirSync(logDir, { recursive: true });
  writeFileSync(
    join(logDir, "20261013T010203004Z-serve-123.jsonl"),
    `{"t":"2026-10-13T01:02:03.004Z","level":"info","event":"server.started"}\n`
  );
  mkdirSync(join(logDir, "not-a-file"));
  // Files whose names are not a log file's: never in a bundle, never counted (whatever put them there).
  writeFileSync(join(logDir, "notes.txt"), `${MARK.stray}\n`);
  writeFileSync(join(logDir, "2026-10-13T01-02-03.004Z-serve-123.jsonl"), `${MARK.stray}\n`);
  file = openLogFile({ dir: logDir, process: "serve" });
  const ads = createCredentialStore({ purpose: "ads", backend, dataDir: globalDir });
  expect((await ads.set(ADS_TOKEN_ID, MARK.token)).status).toBe("stored");
  srv = createServer({
    dataDir,
    port: 0,
    heartbeatMs: 0,
    webDist: null,
    watchIntervalMs: 50,
    deps: { makeSources: () => stubSources() },
    log: createLogger({ events: SERVER_LOG_EVENTS, sink: file, level: "info" }),
    logDir,
    configPath,
    version: "9.9.9-test",
    adsCredentials: ads,
    keychainProbe: async () => ({ state: "unavailable", reason: "no_bus" }),
  });
  url = `http://127.0.0.1:${await srv.ready()}`;
});

afterAll(async () => {
  try {
    await srv?.close().catch(() => {});
    file?.close();
    __setWriterSandboxForTests(null);
  } finally {
    rmSync(dirname(dataDir), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

/** The compile-failure logs of the project, made fresh by each test that wants them. */
function writeCompileLogs(): void {
  const jobs = join(dataDir, "jobs");
  mkdirSync(jobs, { recursive: true });
  writeFileSync(
    join(jobs, `${JOB_A}.compile.log`),
    `! Undefined control sequence.\nl.3 ${MARK.source}\n`
  );
  writeFileSync(join(jobs, `${JOB_B}.compile.log`), "older failure\n");
  utimesSync(join(jobs, `${JOB_B}.compile.log`), new Date(2020, 0, 1), new Date(2020, 0, 1));
  // A collecting file of a compile under way, and files that only look alike: never in the bundle.
  writeFileSync(join(jobs, `${JOB_A}.compile.log.partial`), "collecting\n");
  writeFileSync(join(jobs, "notes.compile.log"), "not a job's\n");
  const build = join(dataDir, "manuscripts", MANUSCRIPT, "build");
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "compile-failure.log"), `manuscript failure ${MARK.source}\n`);
  writeFileSync(join(build, "compile-failure.log.partial"), "collecting\n");
}

function removeCompileLogs(): void {
  rmSync(join(dataDir, "jobs"), { recursive: true, force: true });
  rmSync(join(dataDir, "manuscripts"), { recursive: true, force: true });
}

const info = async (): Promise<DiagnosticsInfo> => {
  const res = await fetch(`${url}/api/diagnostics`);
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as DiagnosticsInfo;
};

interface Bundle {
  name: string;
  /** Member names, sorted. */
  entries: string[];
  text: (entry: string) => string;
  all: string;
}

const unpacked: string[] = [];
afterEach(() => {
  for (const dir of unpacked.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function exportBundle(body: unknown): Promise<Bundle> {
  const res = await fetch(`${url}/api/diagnostics/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "";
  const bytes = new Uint8Array(await res.arrayBuffer());
  const out = mkdtempSync(join(tmpdir(), "aspace-diagnostics-unpacked-"));
  unpacked.push(out);
  extractZip(bytes, out);
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else entries.push(relative(out, path).split("\\").join("/"));
    }
  };
  walk(out);
  entries.sort();
  const text = (entry: string) => readFileSync(join(out, entry), "utf8");
  return { name, entries, text, all: entries.map((e) => `${e}\n${text(e)}`).join("\n") };
}

const logFileNames = (): string[] =>
  readdirSync(logDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LOG_NAME.test(entry.name))
    .map((entry) => `logs/${entry.name}`);

const logRecords = (): Array<Record<string, unknown>> =>
  readFileSync(file.path ?? "", "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("the log directory and the bundle", () => {
  beforeEach(removeCompileLogs);

  test("GET names the log directory (home written as ~) and lists the compile-failure logs, .partial left out", async () => {
    writeCompileLogs();
    const got = await info();
    expect(got.logDir.path).toBe(logDir);
    expect(got.logFiles.count).toBe(logFileNames().length);
    // Newest first (the old job's log last); every one fits under the limit.
    expect(got.compileLogs.map((c) => c.name).sort()).toEqual(
      [
        `compile-failures/jobs/${JOB_A}.compile.log`,
        `compile-failures/jobs/${JOB_B}.compile.log`,
        `compile-failures/manuscripts/${MANUSCRIPT}/build/compile-failure.log`,
      ].sort()
    );
    expect(got.compileLogs.at(-1)?.name).toBe(`compile-failures/jobs/${JOB_B}.compile.log`);
    expect(got.compileLogs.every((c) => c.included && c.bytes > 0)).toBe(true);
    expect(got.logDir.display).toBe(
      got.logDir.path.startsWith(homedir())
        ? `~${got.logDir.path.slice(homedir().length)}`
        : got.logDir.path
    );
    expect(got.compileLogs.map((c) => c.name).join()).not.toContain(".partial");
    expect(got.compileLogsLimitBytes).toBeGreaterThan(0);
  });

  test("with no compile-failure log, GET lists none", async () => {
    expect((await info()).compileLogs).toEqual([]);
  });

  test("not ticked: the zip has the log files and the environment report, nothing else", async () => {
    writeCompileLogs();
    const bundle = await exportBundle({
      includeCompileLogs: false,
      client: "Mozilla/5.0 (X11; Linux x86_64) TestBrowser/1",
    });
    expect(bundle.name).toMatch(/^argelanderspace-diagnostics-\d{8}-\d{6}\.zip$/);
    expect(bundle.entries).toEqual(["environment-report.json", ...logFileNames()].sort());
    // Nothing of the compile logs, the source, a credential, the contact email or the global directory.
    for (const mark of Object.values(MARK))
      for (const spelling of spellings(mark)) expect(bundle.all).not.toContain(spelling);
    expect(bundle.all).not.toContain(homedir());
    expect(bundle.all).not.toContain(root);
  });

  test("ticked: the compile-failure logs GET listed are added — the same ones, never a .partial", async () => {
    writeCompileLogs();
    const listed = (await info()).compileLogs.filter((c) => c.included).map((c) => c.name);
    const bundle = await exportBundle({ includeCompileLogs: true, compileLogs: listed });
    expect(bundle.entries).toEqual(
      ["environment-report.json", ...logFileNames(), ...listed].sort()
    );
    expect(bundle.text(`compile-failures/jobs/${JOB_A}.compile.log`)).toBe(
      readFileSync(join(dataDir, "jobs", `${JOB_A}.compile.log`), "utf8")
    );
    expect(bundle.entries.join()).not.toContain(".partial");
    // The compile logs carry the source, as the box says; nothing else does.
    const others = bundle.entries.filter((e) => !e.startsWith("compile-failures/"));
    const rest = others.map((e) => bundle.text(e)).join("\n");
    for (const spelling of spellings(MARK.source)) expect(rest).not.toContain(spelling);
    for (const mark of [MARK.contact, MARK.openalex, MARK.devKey, MARK.token, MARK.globalDir])
      for (const spelling of spellings(mark)) expect(bundle.all).not.toContain(spelling);
  });

  test("ticked with no compile-failure log: the bundle is the same as not ticked", async () => {
    const bundle = await exportBundle({ includeCompileLogs: true, compileLogs: [] });
    expect(bundle.entries).toEqual(["environment-report.json", ...logFileNames()].sort());
  });

  test("a compile-failure log over the limit is listed as not included and left out", async () => {
    const jobs = join(dataDir, "jobs");
    mkdirSync(jobs, { recursive: true });
    const big = join(jobs, `${JOB_B}.compile.log`);
    writeFileSync(big, Buffer.alloc(33 * 1024 * 1024, 0x61));
    writeFileSync(join(jobs, `${JOB_A}.compile.log`), "small\n");
    utimesSync(big, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const got = await info();
    expect(got.compileLogs).toEqual([
      { name: `compile-failures/jobs/${JOB_A}.compile.log`, bytes: 6, included: true },
      {
        name: `compile-failures/jobs/${JOB_B}.compile.log`,
        bytes: statSync(big).size,
        included: false,
      },
    ]);
    // Even when the page names it, a log over the limit stays out.
    const bundle = await exportBundle({
      includeCompileLogs: true,
      compileLogs: got.compileLogs.map((c) => c.name),
    });
    expect(bundle.entries).toContain(`compile-failures/jobs/${JOB_A}.compile.log`);
    expect(bundle.entries).not.toContain(`compile-failures/jobs/${JOB_B}.compile.log`);
  });

  test("the newest log over the limit stops the list: an older small one stays out too (what is left out is older)", async () => {
    const jobs = join(dataDir, "jobs");
    mkdirSync(jobs, { recursive: true });
    const big = join(jobs, `${JOB_B}.compile.log`);
    const small = join(jobs, `${JOB_A}.compile.log`);
    writeFileSync(big, Buffer.alloc(33 * 1024 * 1024, 0x61));
    writeFileSync(small, "small\n");
    utimesSync(small, new Date(2020, 0, 1), new Date(2020, 0, 1));
    const got = await info();
    expect(got.compileLogs.map((c) => [c.name, c.included])).toEqual([
      [`compile-failures/jobs/${JOB_B}.compile.log`, false],
      [`compile-failures/jobs/${JOB_A}.compile.log`, false],
    ]);
  });

  test("more than the most files: the newest go in, every older one is listed as left out", async () => {
    const jobs = join(dataDir, "jobs");
    mkdirSync(jobs, { recursive: true });
    const total = DIAGNOSTICS_COMPILE_LOGS_MAX_FILES + 3;
    for (let i = 0; i < total; i++) {
      const id = `ingest-${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
      const path = join(jobs, `${id}.compile.log`);
      writeFileSync(path, "log\n");
      // i = 0 is the newest.
      const at = new Date(Date.UTC(2026, 0, 1) - i * 60_000);
      utimesSync(path, at, at);
    }
    const got = await info();
    expect(got.compileLogs).toHaveLength(total);
    expect(got.compileLogs.filter((c) => c.included)).toHaveLength(
      DIAGNOSTICS_COMPILE_LOGS_MAX_FILES
    );
    expect(
      got.compileLogs.slice(0, DIAGNOSTICS_COMPILE_LOGS_MAX_FILES).every((c) => c.included)
    ).toBe(true);
    expect(got.compileLogs.slice(DIAGNOSTICS_COMPILE_LOGS_MAX_FILES).some((c) => c.included)).toBe(
      false
    );
  });

  test("the environment report: version, form, system, Node, the page's browser, the check, the config file — redacted", async () => {
    const bundle = await exportBundle({ client: "Mozilla/5.0 TestBrowser/1" });
    // biome-ignore lint/suspicious/noExplicitAny: the test reads a JSON document field by field
    const report = JSON.parse(bundle.text("environment-report.json")) as Record<string, any>;
    expect(report.version).toBe(1);
    expect(report.app).toEqual({ version: "9.9.9-test", mode: "browser" });
    expect(report.system).toEqual({
      platform: process.platform,
      arch: process.arch,
      release: expect.any(String),
    });
    expect(report.node).toBe(process.version);
    expect(report.client).toBe("Mozilla/5.0 TestBrowser/1");
    expect(report.environment.tools.map((t: { tool: string }) => t.tool)).toContain("latexmk");
    expect(report.environment.keychain).toEqual({ state: "unavailable", reason: "no_bus" });
    // The TeX directory, under the home directory, is written with `~`; paths are shown only as displayed.
    expect(report.environment.texDir.path).toBe("~/texlive-for-diagnostics/bin");
    expect(report.config.values.tex_dir).toBe("~/texlive-for-diagnostics/bin");
    expect(report.config.values.log_level).toBe("info");
    for (const key of [
      "contact_email",
      "global_dir",
      "global_cache_dir",
      "openalex_api_key",
      "ads_dev_key",
    ]) {
      expect(report.config.values).not.toHaveProperty(key);
      expect(report.config.sources).not.toHaveProperty(key);
    }
    expect(report.config.file).toBe("read");
    expect(report.running).not.toHaveProperty("global_dir");
    expect(report.running).not.toHaveProperty("global_cache_dir");
    expect(report.credentials).toEqual({ ads_token: "keychain" });
    const text = bundle.text("environment-report.json");
    for (const mark of Object.values(MARK))
      for (const s of spellings(mark)) expect(text).not.toContain(s);
    expect(text).not.toContain(homedir());
  });

  test("a client identification is cut to its limit and keeps printable ASCII only", async () => {
    const bundle = await exportBundle({ client: `A\u0000B\u202eC${"x".repeat(600)}` });
    const report = JSON.parse(bundle.text("environment-report.json")) as { client: string };
    expect(report.client.startsWith("A?B?C")).toBe(true);
    expect(report.client.length).toBe(512);
  });

  test("an export writes one record: the event and whether compile logs were asked for, nothing else", async () => {
    await exportBundle({ includeCompileLogs: true, compileLogs: [] });
    await exportBundle({});
    const exports = logRecords().filter((r) => r.event === "diagnostics.exported");
    expect(exports.slice(-2).map(({ t: _t, ...rest }) => rest)).toEqual([
      { level: "info", event: "diagnostics.exported", compile_logs: "yes" },
      { level: "info", event: "diagnostics.exported", compile_logs: "no" },
    ]);
  });

  test("the log directory: only files named like a log file are counted and bundled", async () => {
    const got = await info();
    expect(got.logFiles.count).toBe(logFileNames().length);
    const sizes = logFileNames().reduce(
      (sum, n) => sum + statSync(join(logDir, n.slice(5))).size,
      0
    );
    expect(got.logFiles.bytes).toBeLessThanOrEqual(sizes + 4096); // this run's file grows between the two reads
    const bundle = await exportBundle({});
    expect(bundle.entries).not.toContain("logs/notes.txt");
    expect(bundle.entries).not.toContain("logs/2026-10-13T01-02-03.004Z-serve-123.jsonl");
    expect(bundle.entries).toContain("logs/20261013T010203004Z-serve-123.jsonl");
    for (const spelling of spellings(MARK.stray)) expect(bundle.all).not.toContain(spelling);
  });

  test("ticked: only the logs the page listed go in — one that appeared after the listing stays out", async () => {
    writeCompileLogs();
    const listed = (await info()).compileLogs.filter((c) => c.included).map((c) => c.name);
    const later = "ingest-77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    writeFileSync(join(dataDir, "jobs", `${later}.compile.log`), `later ${MARK.source}\n`);
    const bundle = await exportBundle({ includeCompileLogs: true, compileLogs: listed });
    expect(bundle.entries.filter((e) => e.startsWith("compile-failures/")).sort()).toEqual(
      [...listed].sort()
    );
    expect(bundle.entries.join()).not.toContain(later);
  });

  test("names the page sends that are not a kept log now are ignored: gone, .partial, ../, any path", async () => {
    writeCompileLogs();
    const outside = join(root, "outside.compile.log");
    writeFileSync(outside, `outside ${MARK.source}\n`);
    const bundle = await exportBundle({
      includeCompileLogs: true,
      compileLogs: [
        `compile-failures/jobs/${JOB_A}.compile.log`,
        "compile-failures/jobs/ingest-99999999-9999-4999-8999-999999999999.compile.log",
        `compile-failures/jobs/${JOB_A}.compile.log.partial`,
        "compile-failures/jobs/notes.compile.log",
        `compile-failures/jobs/../jobs/${JOB_B}.compile.log`,
        `compile-failures/../../${JOB_B}.compile.log`,
        outside,
        `compile-failures/${outside}`,
      ],
    });
    expect(bundle.entries.filter((e) => e.startsWith("compile-failures/"))).toEqual([
      `compile-failures/jobs/${JOB_A}.compile.log`,
    ]);
    expect(bundle.all).not.toContain("outside");
    expect(bundle.all).not.toContain("collecting");
  });

  test("ticked without a list of names is a bad request; so is a list too long or not of strings", async () => {
    const post = (body: unknown) =>
      fetch(`${url}/api/diagnostics/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ includeCompileLogs: true })).status).toBe(400);
    expect((await post({ includeCompileLogs: true, compileLogs: [1] })).status).toBe(400);
    expect(
      (
        await post({
          includeCompileLogs: true,
          compileLogs: Array.from({ length: DIAGNOSTICS_COMPILE_LOGS_MAX_FILES + 1 }, () => "x"),
        })
      ).status
    ).toBe(400);
  });

  test("the longest list the page can send, with the longest client, fits the request size limit", () => {
    const kinds = ["upload", "refresh", "ingest"];
    const longest = `compile-failures/jobs/${kinds.sort((a, b) => b.length - a.length)[0]}-${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.compile.log`;
    const body = JSON.stringify({
      includeCompileLogs: true,
      compileLogs: Array.from({ length: DIAGNOSTICS_COMPILE_LOGS_MAX_FILES }, () => longest),
      client: "x".repeat(DIAGNOSTICS_CLIENT_MAX_LENGTH),
    });
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(DIAGNOSTICS_EXPORT_BODY_MAX_BYTES);
  });

  test("every secret key of the schema is left out of the report, value and source", async () => {
    for (const key of SECRET_SETTING_KEYS) expect(DIAGNOSTICS_OMITTED_KEYS).toContain(key);
    for (const key of ["contact_email", "global_dir", "global_cache_dir"])
      expect(DIAGNOSTICS_OMITTED_KEYS).toContain(key);
    const bundle = await exportBundle({});
    const report = JSON.parse(bundle.text("environment-report.json")) as {
      config: { values: object; sources: object };
    };
    for (const key of SECRET_SETTING_KEYS) {
      expect(report.config.values).not.toHaveProperty(key);
      expect(report.config.sources).not.toHaveProperty(key);
    }
    for (const mark of [MARK.openalex, MARK.devKey])
      for (const s of spellings(mark)) expect(bundle.all).not.toContain(s);
  });

  test("a body that is not a request is refused", async () => {
    const bad = await fetch(`${url}/api/diagnostics/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "[1,2]",
    });
    expect(bad.status).toBe(400);
  });
});

describe("the log level takes effect without a restart", () => {
  const completed = () => logRecords().filter((r) => r.event === "request.completed").length;
  const put = (value: string) =>
    fetch(`${url}/api/settings/log_level`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ set: value }),
    });

  test("changed on the settings page: successful requests start, then stop, being recorded", async () => {
    const before = completed();
    await fetch(`${url}/api/diagnostics`);
    expect(completed()).toBe(before);
    expect((await put("debug")).status).toBe(200);
    await fetch(`${url}/api/diagnostics`);
    expect(completed()).toBeGreaterThan(before);
    expect((await put("info")).status).toBe(200);
    const after = completed();
    await fetch(`${url}/api/diagnostics`);
    expect(completed()).toBe(after);
  });

  test("changed by hand in the file: the watcher applies it", async () => {
    const text = readFileSync(configPath, "utf8");
    try {
      writeFileSync(configPath, text.replace(/log_level = "[a-z]+"/, 'log_level = "debug"'));
      const before = completed();
      await expect
        .poll(
          async () => {
            await fetch(`${url}/api/diagnostics`);
            return completed() > before;
          },
          { timeout: 3000, interval: 100 }
        )
        .toBe(true);
    } finally {
      writeFileSync(configPath, text.replace(/log_level = "[a-z]+"/, 'log_level = "info"'));
    }
    // Back to info: a request a while later is not recorded.
    await expect
      .poll(
        async () => {
          const n = completed();
          await fetch(`${url}/api/diagnostics`);
          return completed() === n;
        },
        { timeout: 3000, interval: 100 }
      )
      .toBe(true);
  });
});
