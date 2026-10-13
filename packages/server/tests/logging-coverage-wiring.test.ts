/**
 * The user-level log, second part (desktop-app ticket 07, revision): the wiring `createServer` does itself — the job
 * runner's watcher is there when the runner recovers the last run's jobs, arXiv is asked through an observed fetch on
 * both of its paths — and the branches no flow of logging-coverage.test.ts reaches: what a failed job threw, a job
 * file that was not written by the workbench, a program that could not be started, a keychain that does not answer.
 *
 * Marker strings are in everything that goes through; none may be in what was logged.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "@argelanderspace/contracts";
import { emptyWork, LibraryStore, libraryPaths, plansPath } from "@argelanderspace/core";
import {
  type CredentialStore,
  createLogger,
  type FetchImpl,
  type LogJson,
} from "@argelanderspace/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createMemorySink, type MemorySink } from "../../infra/tests/log-memory-sink.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { SERVER_LOG_EVENTS, type ServerLog } from "../src/log.js";
import {
  externalObserver,
  JOB_ID_UNRECOGNIZED,
  jobLogger,
  observedCredentials,
} from "../src/log-observers.js";
import { createServer, type RunningServer } from "../src/server.js";
import { markersInText } from "./log-markers.js";

const MARK = {
  jobId: "ZqxMarkJobId7c1d",
  jobKind: "ZqxMarkJobKind",
  title: "Zqxmark Hidden Thesis Title",
  message: "ZqxMarkErrorMessage could not parse the draft of chapter two",
  folder: "Zqxmark Private Folder",
  serviceBody: "ZqxMarkServiceBody",
  spawnCode: "ZqxMarkSpawnCode",
  password: "ZqxMarkPassword9d",
} as const;
const TITLE_WORK = "work:zqxmark-hidden-thesis-title-2001";
const ARXIV_WORK = "arxiv:2601.00001";
const ARXIV_ID = "2601.00001";

type LogRecord = Record<string, LogJson>;
/** A stack frame as it is written: the location of code — a file and a line and column, no function name. */
const FRAME = /^(?:node:[A-Za-z0-9_/.-]+|(?:~|[A-Za-z]:)?[\\/][^\s()]*):\d+:\d+$/;

function memoryLog(): { sink: MemorySink; log: ServerLog } {
  const sink = createMemorySink();
  return { sink, log: createLogger({ events: SERVER_LOG_EVENTS, sink, level: "debug" }) };
}
const named = (sink: MemorySink, event: string): LogRecord[] =>
  sink.records().filter((record) => record.event === event);
function expectNoMarkers(sink: MemorySink): void {
  expect(markersInText(sink.lines.join("\n"), Object.values(MARK))).toEqual([]);
}

const roots: string[] = [];
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aspace-logging-wiring-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const jobFile = (job: Omit<Partial<Job>, "kind"> & { id: string; kind: string }): string =>
  JSON.stringify({
    status: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-01T00:00:01.000Z",
    finishedAt: null,
    progress: [{ at: "2026-10-01T00:00:02.000Z", message: `Compiling ${MARK.title}` }],
    result: null,
    error: null,
    ...job,
  });

// --------------------------------------------------------------------------- //
// createServer: the last run's jobs, and arXiv
// --------------------------------------------------------------------------- //

describe("a server made by createServer with a log", () => {
  let srv: RunningServer;
  let sink: MemorySink;
  const interrupted = `ingest-${randomUUID()}`;
  const requests: string[] = [];
  const fetchStub: FetchImpl = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    const { host, pathname } = new URL(url);
    // The e-print of a submission that has no LaTeX source: a PDF.
    if (host === "arxiv.org" && pathname.startsWith("/e-print/"))
      return new Response(`%PDF-1.5 ${MARK.serviceBody}`, { status: 200 });
    if (host === "arxiv.org" && pathname.startsWith("/pdf/"))
      return new Response(MARK.serviceBody, { status: 503 });
    return new Response(MARK.serviceBody, { status: 404 });
  };

  beforeAll(async () => {
    const root = tempRoot();
    const dataDir = join(root, "project", "literatures");
    const paths = libraryPaths(dataDir);
    mkdirSync(paths.libraryDir ?? join(dataDir, "library"), { recursive: true });
    const store = LibraryStore.load(paths);
    store.works = [
      { ...emptyWork(TITLE_WORK), title: MARK.title, cite_key: "zqx2001", year: 2001 },
      {
        ...emptyWork(ARXIV_WORK),
        title: "Zqxmark arXiv Work",
        cite_key: "zqx2026",
        year: 2026,
        arxiv_id: ARXIV_ID,
      },
    ];
    store.save(paths);
    mkdirSync(statusDirFor(dataDir), { recursive: true });
    writeFileSync(
      plansPath(statusDirFor(dataDir)),
      JSON.stringify({ version: 1, rev: 1, plans: [] }, null, 2)
    );
    // What the last run left in the job directory: a job of its own that was still running, a file whose id is not
    // one the runner makes (edited by hand, or put there by something else), and one whose kind is no kind.
    const jobs = join(dataDir, "jobs");
    mkdirSync(jobs, { recursive: true });
    writeFileSync(
      join(jobs, `${interrupted}.json`),
      jobFile({ id: interrupted, kind: "ingest", payload: { workId: TITLE_WORK } })
    );
    const foreign = `ingest-${MARK.jobId}`;
    writeFileSync(join(jobs, `${foreign}.json`), jobFile({ id: foreign, kind: "ingest" }));
    const unkind = `${MARK.jobKind}-${randomUUID()}`;
    writeFileSync(join(jobs, `${unkind}.json`), jobFile({ id: unkind, kind: MARK.jobKind }));

    const made = memoryLog();
    sink = made.sink;
    srv = createServer({
      dataDir,
      port: 0,
      webDist: null,
      heartbeatMs: 0,
      log: made.log,
      fetchImpl: fetchStub,
    });
    await srv.ready();
  }, 60_000);

  afterAll(async () => {
    await srv?.close();
  });

  test("the jobs the last run left unfinished are recorded as interrupted — the watcher is there when the runner is made", () => {
    const records = named(sink, "job.interrupted");
    expect(records).toHaveLength(3);
    expect(records).toContainEqual(
      expect.objectContaining({ level: "warn", job: interrupted, kind: "ingest", stage: "compile" })
    );
    // the runner did take all three over
    expect(srv.runner.get(interrupted)?.status).toBe("interrupted");
    expect(srv.runner.get(`ingest-${MARK.jobId}`)?.status).toBe("interrupted");
    expectNoMarkers(sink);
  });

  test("a job file whose id or kind the runner did not make: a fixed placeholder, not the file's text", () => {
    const records = named(sink, "job.interrupted").filter((r) => r.job !== interrupted);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.job)).toEqual([JOB_ID_UNRECOGNIZED, JOB_ID_UNRECOGNIZED]);
    expect(records.map((r) => r.kind).sort()).toEqual(["<invalid-enum>", "ingest"]);
    for (const record of records)
      expect(Object.keys(record).sort()).toEqual(["event", "job", "kind", "level", "stage", "t"]);
    expectNoMarkers(sink);
  });

  test("arXiv e-print, over HTTP: the request by service, host and status; the failed job by code, category and error name", async () => {
    const from = sink.lines.length;
    const res = await srv.app.request(
      `/api/library/attach-arxiv?id=${encodeURIComponent(ARXIV_WORK)}`,
      { method: "POST" }
    );
    expect(res.status).toBe(202);
    const { job: queued } = (await res.json()) as { job: Job };
    const job = await srv.runner.waitFor(queued.id);
    expect(job).toMatchObject({ status: "failed", errorCode: "arxiv_pdf_only" });
    expect(requests).toContain(`https://arxiv.org/e-print/${ARXIV_ID}`);

    const records = sink.records().slice(from);
    expect(records.filter((r) => r.event === "external_service.answered")).toContainEqual(
      expect.objectContaining({
        level: "debug",
        service: "arxiv",
        host: "https://arxiv.org",
        status: 200,
      })
    );
    const mine = records.filter((r) => r.job === job.id);
    expect(mine.map((r) => r.event).filter((e) => e !== "job.progress")).toEqual([
      "job.created",
      "job.started",
      "job.failed",
    ]);
    expect(mine[0]).toMatchObject({ kind: "ingest", work: ARXIV_WORK });
    const failed = mine.at(-1) as LogRecord;
    expect(failed).toMatchObject({
      level: "warn",
      kind: "ingest",
      category: "source_has_no_latex",
      error_code: "arxiv_pdf_only",
      error: { name: "ArxivPdfOnlyError" },
    });
    expect(Object.keys(failed).sort()).toEqual(
      [
        "category",
        "duration_ms",
        "error",
        "error_code",
        "event",
        "job",
        "kind",
        "level",
        "stage",
        "t",
      ].sort()
    );
    expectNoMarkers(sink);
  }, 60_000);

  test("arXiv PDF, over HTTP: a refusal is a warning by service and status; the job fails without its text", async () => {
    const from = sink.lines.length;
    const res = await srv.app.request(
      `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(ARXIV_WORK)}`,
      { method: "POST" }
    );
    expect(res.status).toBe(202);
    const { job: queued } = (await res.json()) as { job: Job };
    const job = await srv.runner.waitFor(queued.id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("503");
    expect(requests).toContain(`https://arxiv.org/pdf/${ARXIV_ID}`);

    const records = sink.records().slice(from);
    const asked = records.filter((r) => r.event === "external_service.answered");
    expect(asked).toEqual([
      expect.objectContaining({
        level: "warn",
        service: "arxiv",
        host: "https://arxiv.org",
        status: 503,
      }),
    ]);
    expect(Object.keys(asked[0] ?? {}).sort()).toEqual(
      ["duration_ms", "event", "host", "level", "service", "status", "t"].sort()
    );
    const failed = records.find((r) => r.event === "job.failed" && r.job === job.id);
    expect(failed).toMatchObject({ level: "warn", category: "unclassified" });
    expect(failed?.error).toMatchObject({ name: "Error" });
    expectNoMarkers(sink);
  }, 60_000);
});

// --------------------------------------------------------------------------- //
// What a failed job threw
// --------------------------------------------------------------------------- //

describe("job.failed: what was thrown, by name, code and stack — never its message, never a file it names", () => {
  const privateFile = `/home/someone/papers/${MARK.folder}/output/latex-${MARK.folder}/main.tex`;
  const systemError = () =>
    Object.assign(new Error(`EACCES: permission denied, open '${privateFile}'`), {
      code: "EACCES",
      syscall: "open",
      path: privateFile,
    });
  const thrown: Array<{
    what: string;
    make: () => unknown;
    expected: Record<string, unknown>;
    keys: string[];
    category: string;
  }> = [
    {
      what: "a plain Error",
      make: () => new Error(MARK.message),
      expected: { name: "Error" },
      keys: ["name", "stack"],
      category: "unclassified",
    },
    {
      what: "a TypeError",
      make: () => new TypeError(`${MARK.message}\n    at secret (/${MARK.folder}/x.js:1:2)`),
      expected: { name: "TypeError" },
      keys: ["name", "stack"],
      category: "unclassified",
    },
    {
      what: "a system error with a path",
      make: systemError,
      expected: { name: "Error", code: "EACCES", syscall: "open" },
      keys: ["code", "name", "stack", "syscall"],
      category: "file_system",
    },
    {
      what: "an error with a cause that is a system error",
      make: () => new RangeError(MARK.message, { cause: systemError() }),
      expected: { name: "RangeError", cause: { name: "Error", code: "EACCES", syscall: "open" } },
      keys: ["cause", "name", "stack"],
      category: "unclassified",
    },
    {
      what: "something that is not an Error",
      make: () => MARK.message,
      expected: { name: "NonError", thrown: "string" },
      keys: ["name", "thrown"],
      category: "unclassified",
    },
  ];

  test.each(thrown)("$what", async ({ make, expected, keys, category }) => {
    const { sink, log } = memoryLog();
    const runner = new JobRunner({ dir: join(tempRoot(), "jobs"), observe: jobLogger(log) });
    const job = await runner.waitFor(
      runner.submit("refresh", async () => {
        throw make();
      }).id
    );
    // the job record keeps the text, as before
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/zqxmark/i);
    const [failed] = named(sink, "job.failed");
    expect(failed).toMatchObject({ level: "warn", job: job.id, kind: "refresh", category });
    // the record's fields are these and no others
    expect(Object.keys(failed ?? {}).sort()).toEqual(
      ["category", "duration_ms", "error", "event", "job", "kind", "level", "stage", "t"].sort()
    );
    const error = failed?.error as Record<string, LogJson>;
    expect(error).toMatchObject(expected);
    expect(Object.keys(error).sort()).toEqual(keys);
    const checkFrames = (e: Record<string, LogJson>): void => {
      if (e.name === "NonError") return;
      const stack = e.stack as string[];
      // frames: the locations of code (this file among them), nothing else
      expect(stack.length).toBeGreaterThan(0);
      for (const frame of stack) expect(frame).toMatch(FRAME);
      expect("path" in e).toBe(false);
      expect("message" in e).toBe(false);
      if (e.cause !== undefined) {
        expect(Object.keys(e.cause as object).sort()).toEqual(["code", "name", "stack", "syscall"]);
        checkFrames(e.cause as Record<string, LogJson>);
      }
    };
    checkFrames(error);
    // the handler above is among the frames: this is the stack of what was thrown
    if (error.name !== "NonError")
      expect((error.stack as string[]).join("\n")).toMatch(
        /logging-coverage-wiring\.test\.ts:\d+:\d+/
      );
    expectNoMarkers(sink);
  });
});

// --------------------------------------------------------------------------- //
// External programs: could not be started; the sandbox probe
// --------------------------------------------------------------------------- //

describe("external programs", () => {
  const call = { sandboxed: false, exitCode: null, signal: null, timedOut: false, durationMs: 3 };
  const enoent = () =>
    Object.assign(new Error(`spawn /home/someone/${MARK.folder}/pdftocairo ENOENT`), {
      code: "ENOENT",
      syscall: "spawn",
      path: `/home/someone/${MARK.folder}/pdftocairo`,
    });

  test("a program that could not be started: a warning with the system's code, nothing of the error", () => {
    const { sink, log } = memoryLog();
    const observer = externalObserver(log);
    observer?.program?.({ ...call, program: "pdftocairo", error: enoent() });
    // a code that is not one of the system's is not written
    observer?.program?.({
      ...call,
      program: "latexmk",
      sandboxed: true,
      error: Object.assign(new Error(MARK.message), { code: MARK.spawnCode }),
    });
    // nor is an error without a code
    observer?.program?.({ ...call, program: "gs", error: new Error(MARK.message) });
    const records = named(sink, "external_program.not_started");
    expect(records).toMatchObject([
      { level: "warn", program: "pdftocairo", sandboxed: "no", code: "ENOENT", duration_ms: 3 },
      { level: "warn", program: "latexmk", sandboxed: "yes", code: "<invalid-enum>" },
      { level: "warn", program: "gs", sandboxed: "no" },
    ]);
    expect(Object.keys(records[0] ?? {}).sort()).toEqual(
      ["code", "duration_ms", "event", "level", "program", "sandboxed", "t"].sort()
    );
    expect("code" in (records[2] ?? {})).toBe(false);
    expect(named(sink, "external_program.exited")).toEqual([]);
    expectNoMarkers(sink);
  });

  test("the sandbox probe: no bwrap is said once at info, a probe that fails once as a warning; repeats are debug", () => {
    const { sink, log } = memoryLog();
    const observer = externalObserver(log);
    // one observer per log: a probe two callers wait for is reported to one object
    expect(externalObserver(log)).toBe(observer);
    const missing = () => observer?.program?.({ ...call, program: "bwrap", error: enoent() });
    const refused = () => observer?.program?.({ ...call, program: "bwrap", exitCode: 1 });
    const works = () => observer?.program?.({ ...call, program: "bwrap", exitCode: 0 });
    missing();
    missing();
    missing();
    refused();
    refused();
    works();
    missing();
    const levels = sink
      .records()
      .map((r) => `${r.event}:${r.level}${r.exit_code === undefined ? "" : `:${r.exit_code}`}`);
    expect(levels).toEqual([
      "external_program.not_started:info",
      "external_program.not_started:debug",
      "external_program.not_started:debug",
      "external_program.exited:warn:1",
      "external_program.exited:debug:1",
      "external_program.exited:info:0",
      "external_program.not_started:info",
    ]);
    // another program that is missing is a warning every time
    observer?.program?.({ ...call, program: "latexmk", error: enoent() });
    observer?.program?.({ ...call, program: "latexmk", error: enoent() });
    expect(sink.records().slice(-2)).toMatchObject([{ level: "warn" }, { level: "warn" }]);
    expectNoMarkers(sink);
  });
});

// --------------------------------------------------------------------------- //
// The keychain
// --------------------------------------------------------------------------- //

test("a keychain that does not answer: recorded as unavailable, once per change — not the account, not the password", async () => {
  const { sink, log } = memoryLog();
  let answer: "keychain-unavailable" | "ok" = "keychain-unavailable";
  const store: CredentialStore = {
    get: async () =>
      answer === "ok"
        ? { status: "ok", password: MARK.password, protection: "keychain", keychainProtected: true }
        : { status: "keychain-unavailable" },
    set: async () => ({ status: "keychain-unavailable" }),
    delete: async () => ({ status: "deleted" }) as never,
  };
  const watched = observedCredentials(store, log);
  const account = "zqxmark.account@zqxmark-mail.test";
  expect(await watched.get(account)).toEqual({ status: "keychain-unavailable" });
  expect(await watched.get(account)).toEqual({ status: "keychain-unavailable" });
  expect(await watched.set(account, MARK.password, { fileFallbackConsent: false })).toEqual({
    status: "keychain-unavailable",
  });
  answer = "ok";
  expect(await watched.get(account)).toMatchObject({ status: "ok", password: MARK.password });
  const records = named(sink, "credentials.keychain_state");
  expect(records).toMatchObject([
    { level: "warn", state: "unavailable" },
    { level: "info", state: "available" },
  ]);
  for (const record of records)
    expect(Object.keys(record).sort()).toEqual(["event", "level", "state", "t"]);
  expect(sink.lines).toHaveLength(2);
  expectNoMarkers(sink);
});
