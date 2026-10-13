/**
 * The two kinds of failure desktop-app ticket 08 keeps a trace of, over HTTP against a real server writing a real
 * log file at level `debug`:
 *
 *   - a compile that fails: the complete latexmk log is kept as a file of the project (beside the job's record for
 *     an ingest, in the manuscript's build directory for the Writer), and the user-level log says where it is, which
 *     engine, which exit code and what was missing — never a line of it;
 *   - an error of the page: what the browser reports is checked field by field, limited in number, and never
 *     carries a message.
 *
 * It is also the reverse privacy test of both (the search of logging-coverage.test.ts): marker strings go into the
 * TeX source, the names of missing files, the reported error's message, name, frames, pane and extra fields — and
 * afterwards none of them is anywhere in the log directory, while the new records are there.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Job } from "@argelanderspace/contracts";
import { emptyWork, LibraryStore, libraryPaths, plansPath } from "@argelanderspace/core";
import {
  createLogger,
  haveLatexmk,
  haveTexEngine,
  type LogFile,
  type LogJson,
  openLogFile,
} from "@argelanderspace/infra";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  classifyMissingTexFiles,
  INGEST_FAILURE_LOGS_KEPT,
  INGEST_PARTIAL_STALE_MS,
  pruneIngestFailureLogs,
  sweepIngestPartials,
} from "../src/compile-failure-log.js";
import { statusDirFor } from "../src/deps.js";
import { SERVER_LOG_EVENTS, type ServerLog } from "../src/log.js";
import {
  PAGE_ERROR_BODY_MAX_BYTES,
  PAGE_ERRORS_PER_LAUNCH,
  PAGE_ERRORS_PER_MINUTE,
} from "../src/page-errors.js";
import { createServer, type RunningServer } from "../src/server.js";
import { makeZip, stubPipelines } from "./helpers.js";
import { logText, markersInText, ROOT } from "./log-markers.js";

const LATEX = haveLatexmk() && haveTexEngine("pdflatex") && haveTexEngine("xelatex");
if (!LATEX) console.warn("latexmk/pdflatex/xelatex not on PATH — real-compile tests skipped");

const MARK = {
  macro: "zqxmarkundefinedmacro",
  secondMacro: "zqxmarksecondmacro",
  figure: "zqxmarkfigure",
  chapter: "zqxmarkchapter",
  packageDir: "zqxmarkdir",
  packageName: "zqxmarkpkg",
  cell: "ZqxMarkCell draft paragraph",
  title: "Zqxmark Hidden Thesis Title",
  message: "ZqxMarkMessage cannot read properties of the secret plan",
  errorName: "ZqxMarkName",
  frameFile: "zqxmarkfile",
  frameFunction: "zqxmarkFunction",
  pane: "zqxmarkpane",
  extra: "ZqxMarkExtra",
  long: "ZqxMarkLong",
  bibStyle: "zqxmarkstyle",
  bibFile: "zqxmarkbib",
  typeout: "ZqxMarkTypeout",
  eprint: "zqxmarkeprintmacro",
} as const;
const WORK_ID = "work:zqxmark-broken-source-2002";
const ARXIV_WORK = "work:arxiv-2603.00008";
const ARXIV_ID = "2603.00008";

type LogRecord = Record<string, LogJson>;
let root: string;
let logDir: string;
let dataDir: string;
let file: LogFile;
let log: ServerLog;
let srv: RunningServer;
let webDist: string;
let boundPort: number;
const WINDOW_MS = 400;
/** A built script of the page, with the characters a base64url hash may have. */
const SCRIPT = "index-eZ_qHf-D.js";
/** The other names a real build has: a hyphen in the name, a hyphen in the hash, a chunk named after another. */
const REAL_SCRIPTS = [
  "direct-engine-BMwLK-Tl.js",
  "worker-engine-2r7-DNkh.js",
  "browser-BKLM0ThC-D7mrvnwI.js",
  "index-CzpUSa7s.js",
  "pdf.worker.min-B_x-9aQ0.mjs",
];

const records = (): LogRecord[] =>
  logText(logDir)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LogRecord);
const mark = (): number => records().length;
const eventsNamed = (name: string, from = 0): LogRecord[] =>
  records()
    .slice(from)
    .filter((record) => record.event === name);
const expectNoMarkers = (): void =>
  expect(markersInText(logText(logDir), [...Object.values(MARK), WORK_ID])).toEqual([]);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const json = (
  method: string,
  body: unknown,
  headers: Record<string, string> = {}
): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const doc = (...body: string[]): string =>
  ["\\documentclass{article}", ...body, "\\end{document}", ""].join("\n");
const upload = async (tex: string, more: Record<string, string> = {}): Promise<Job> => {
  const res = await srv.app.request(`/api/library/upload?id=${encodeURIComponent(WORK_ID)}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: makeZip({ "main.tex": tex, ...more }),
  });
  expect(res.status).toBe(202);
  const { job } = (await res.json()) as { job: Job };
  return srv.runner.waitFor(job.id);
};
const jobsDir = (): string => join(dataDir, "jobs");
const keptLogs = (): string[] =>
  readdirSync(jobsDir())
    .filter((name) => name.endsWith(".compile.log"))
    .sort();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "aspace-logging-failures-"));
  logDir = join(root, "global", "logs");
  dataDir = join(root, "project", "literatures");
  mkdirSync(dataDir, { recursive: true });
  const paths = libraryPaths(dataDir);
  mkdirSync(paths.libraryDir ?? join(dataDir, "library"), { recursive: true });
  const store = LibraryStore.load(paths);
  store.works = [
    { ...emptyWork(WORK_ID), title: MARK.title, cite_key: "zqx2002", year: 2002 },
    {
      ...emptyWork(ARXIV_WORK),
      title: MARK.title,
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
  file = openLogFile({ dir: logDir, process: "serve" });
  expect(file.path).not.toBeNull();
  log = createLogger({ events: SERVER_LOG_EVENTS, sink: file, level: "debug" });
  // the web build this server serves: one script, named the way Vite names them
  webDist = join(root, "web-dist");
  mkdirSync(join(webDist, "assets"), { recursive: true });
  writeFileSync(join(webDist, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(webDist, "assets", SCRIPT), "/* built */");
  for (const name of REAL_SCRIPTS) writeFileSync(join(webDist, "assets", name), "/* built */");
  writeFileSync(join(webDist, "assets", "index-BOe1kVrW.css"), "/* built */");
  srv = createServer({
    dataDir,
    port: 0,
    webDist,
    heartbeatMs: 0,
    log,
    // Offline, except for one arXiv e-print: a one-file submission (a gzipped .tex) that does not compile.
    fetchImpl: async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === `https://arxiv.org/e-print/${ARXIV_ID}`)
        return new Response(
          gzipSync(Buffer.from(doc("\\begin{document}", `Broken \\${MARK.eprint}{x}.`))),
          { status: 200 }
        );
      return new Response("offline", { status: 404 });
    },
    pageErrors: { windowMs: WINDOW_MS },
  });
  boundPort = await srv.ready();
}, 60_000);

afterAll(async () => {
  await srv?.close();
  file?.close();
  rmSync(root, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- //
// A compile that fails
// --------------------------------------------------------------------------- //

describe("a failed ingest", () => {
  test.skipIf(!LATEX)(
    "keeps the complete latexmk log beside the job's record; the user log names the job, engine, exit code and the log's place — no line of it",
    async () => {
      const from = mark();
      const job = await upload(
        doc(
          "\\usepackage{graphicx}",
          "\\begin{document}",
          `Before \\${MARK.macro}{x} after.`,
          `\\includegraphics{${MARK.figure}.pdf}`,
          `\\input{${MARK.chapter}}`
        )
      );
      expect(job.status).toBe("failed");
      // the job's record and the page keep the excerpt, as before
      expect(job.error).toContain(
        "TeX compilation failed (engine: pdflatex, main: main.tex, exit code: 12)"
      );
      expect(job.error).toContain(MARK.macro);
      expect(JSON.parse(readFileSync(join(jobsDir(), `${job.id}.json`), "utf8")).error).toBe(
        job.error
      );

      // the complete log, beside the record: the engine's banner, the source line, every attempt
      const kept = join(jobsDir(), `${job.id}.compile.log`);
      const text = readFileSync(kept, "utf8");
      expect(text).toMatch(/This is pdfTeX/);
      expect(text).toContain(`\\${MARK.macro}`);
      expect(text).toContain(`${MARK.chapter}.tex`);
      expect(text.match(/^%% argelanderspace: latexmk attempt — /gm)).toHaveLength(4);
      expect(readdirSync(jobsDir()).filter((n) => n.endsWith(".partial"))).toEqual([]);

      const [failed] = eventsNamed("tex.compile_failed", from);
      expect(failed).toEqual({
        t: expect.any(String),
        level: "warn",
        event: "tex.compile_failed",
        source: "ingest",
        job: job.id,
        kind: "compile-error",
        engine: "pdflatex",
        exit_code: 12,
        timed_out: "no",
        // the user's own files: by extension only
        missing_other_files: ["pdf", "tex"],
        log_file: `jobs/${job.id}.compile.log`,
      });
      expect(eventsNamed("tex.compile_failed", from)).toHaveLength(1);
      // the job's own record of the failure is the one it was
      expect(eventsNamed("job.failed", from)).toHaveLength(1);
      expectNoMarkers();
    },
    240_000
  );

  test.skipIf(!LATEX)(
    "a missing package is named; one whose name is not a plain file name is not",
    async () => {
      let from = mark();
      await upload(doc("\\usepackage{nosuchpackagezz}", "\\begin{document}", "x"));
      expect(eventsNamed("tex.compile_failed", from)[0]).toMatchObject({
        missing_tex_files: ["nosuchpackagezz.sty"],
      });
      expect(eventsNamed("tex.compile_failed", from)[0]).not.toHaveProperty("missing_other_files");

      from = mark();
      const job = await upload(
        doc(`\\usepackage{${MARK.packageDir}/${MARK.packageName}}`, "\\begin{document}", "x")
      );
      expect(readFileSync(join(jobsDir(), `${job.id}.compile.log`), "utf8")).toContain(
        `${MARK.packageDir}/${MARK.packageName}.sty`
      );
      const [failed] = eventsNamed("tex.compile_failed", from);
      expect(failed).toMatchObject({ source: "ingest", job: job.id });
      expect(failed).not.toHaveProperty("missing_tex_files");
      expect(failed).not.toHaveProperty("missing_other_files");
      expectNoMarkers();
    },
    240_000
  );

  test.skipIf(!LATEX)(
    `more than ${INGEST_FAILURE_LOGS_KEPT} failures in a row: only the newest ${INGEST_FAILURE_LOGS_KEPT} logs stay; job records and other files are not touched`,
    async () => {
      const bystander = join(jobsDir(), "notes.compile.log");
      writeFileSync(bystander, "not one of ours");
      const before = keptLogs().filter((name) => name !== "notes.compile.log");
      const ids: string[] = [];
      for (let i = before.length; i < INGEST_FAILURE_LOGS_KEPT + 2; i++) {
        const job = await upload(doc("\\begin{document}", `\\${MARK.macro}`));
        expect(job.status).toBe("failed");
        ids.push(job.id);
        await sleep(15); // distinct modification times
      }
      const kept = keptLogs().filter((name) => name !== "notes.compile.log");
      expect(kept).toHaveLength(INGEST_FAILURE_LOGS_KEPT);
      // the newest are there, the oldest are gone
      for (const id of ids.slice(-INGEST_FAILURE_LOGS_KEPT))
        expect(kept).toContain(`${id}.compile.log`);
      const gone = before.filter((name) => !kept.includes(name));
      expect(gone.length).toBe(before.length + ids.length - INGEST_FAILURE_LOGS_KEPT);
      expect(gone).toEqual(
        [...before]
          .sort((a, b) =>
            JSON.parse(
              readFileSync(join(jobsDir(), a.replace(".compile.log", ".json")), "utf8")
            ).createdAt.localeCompare(
              JSON.parse(readFileSync(join(jobsDir(), b.replace(".compile.log", ".json")), "utf8"))
                .createdAt
            )
          )
          .slice(0, gone.length)
          .sort()
      );
      expect(readFileSync(bystander, "utf8")).toBe("not one of ours");
      // every job still has its record
      for (const name of [...before, ...ids.map((id) => `${id}.compile.log`)])
        expect(existsSync(join(jobsDir(), name.replace(".compile.log", ".json")))).toBe(true);
      expectNoMarkers();
    },
    600_000
  );

  test("pruning looks only at files named like a kept log", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-prune-"));
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `upload-${uuid(i)}.compile.log`), "x");
    writeFileSync(join(dir, `upload-${uuid(1)}.json`), "{}");
    writeFileSync(join(dir, "upload-not-a-uuid.compile.log"), "x");
    mkdirSync(join(dir, `ingest-${uuid(9)}.compile.log`));
    pruneIngestFailureLogs(dir, 2);
    const left = readdirSync(dir).sort();
    expect(left.filter((n) => /^upload-0.*\.compile\.log$/.test(n))).toHaveLength(2);
    expect(left).toContain(`upload-${uuid(1)}.json`);
    expect(left).toContain("upload-not-a-uuid.compile.log");
    expect(left).toContain(`ingest-${uuid(9)}.compile.log`);
    rmSync(dir, { recursive: true, force: true });
  });

  test("injected pipelines (a test server's stubs) keep no log and write no record: a failed ingest leaves its job record only", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-stub-"));
    const paths = libraryPaths(dir);
    mkdirSync(paths.libraryDir ?? join(dir, "library"), { recursive: true });
    const store = LibraryStore.load(paths);
    store.works = [{ ...emptyWork(WORK_ID), title: "t", cite_key: "zqx2002", year: 2002 }];
    store.save(paths);
    const from = mark();
    const stub = createServer({
      dataDir: dir,
      port: 0,
      webDist: null,
      heartbeatMs: 0,
      log,
      deps: {
        pipelines: {
          ...stubPipelines(),
          ingestLatexZip: async () => {
            throw new Error(
              "TeX compilation failed (engine: pdflatex, main: main.tex, exit code: 12)"
            );
          },
        },
      },
    });
    await stub.ready();
    const res = await stub.app.request(`/api/library/upload?id=${encodeURIComponent(WORK_ID)}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: makeZip({ "main.tex": doc("\\begin{document}", "x") }),
    });
    expect(res.status).toBe(202);
    const job = await stub.runner.waitFor(((await res.json()) as { job: Job }).job.id);
    expect(job.status).toBe("failed");
    expect(
      readdirSync(join(dir, "jobs"), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
    ).toEqual([`${job.id}.json`]);
    expect(eventsNamed("job.failed", from).map((r) => r.job)).toEqual([job.id]);
    expect(eventsNamed("tex.compile_failed", from)).toEqual([]);
    await stub.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(!LATEX)(
    "an arXiv fetch whose source does not compile keeps its log beside the job's record too",
    async () => {
      const from = mark();
      const res = await srv.app.request(
        `/api/library/attach-arxiv?id=${encodeURIComponent(ARXIV_WORK)}`,
        { method: "POST" }
      );
      expect(res.status).toBe(202);
      const job = await srv.runner.waitFor(((await res.json()) as { job: Job }).job.id);
      expect(job.status).toBe("failed");
      expect(job.kind).toBe("ingest");
      expect(job.error).toContain("TeX compilation failed");
      const text = readFileSync(join(jobsDir(), `${job.id}.compile.log`), "utf8");
      expect(text).toContain(`\\${MARK.eprint}`);
      expect(text).toContain("! Undefined control sequence.");
      expect(eventsNamed("tex.compile_failed", from)).toEqual([
        {
          t: expect.any(String),
          level: "warn",
          event: "tex.compile_failed",
          source: "ingest",
          job: job.id,
          kind: "compile-error",
          engine: "pdflatex",
          exit_code: 12,
          timed_out: "no",
          log_file: `jobs/${job.id}.compile.log`,
        },
      ]);
      expectNoMarkers();
    },
    240_000
  );

  test.skipIf(!LATEX)(
    "a failure of the bibliography stage: bibtex's report is in the kept file, a missing style is named, and nothing the source put there reaches the user log",
    async () => {
      const bib = "@article{k, author={A. Author}, title={T}, journal={J}, year={2020}}\n";
      let from = mark();
      const named = await upload(
        doc(
          "\\begin{document}",
          "See \\cite{k}.",
          "\\bibliographystyle{nosuchstylezz}",
          "\\bibliography{refs}"
        ),
        { "refs.bib": bib }
      );
      expect(named.status).toBe("failed");
      const text = readFileSync(join(jobsDir(), `${named.id}.compile.log`), "utf8");
      expect(text).toContain("I couldn't open style file nosuchstylezz.bst");
      expect(text).toMatch(/^%% argelanderspace: bibliography log \(\.blg\) of this attempt$/m);
      expect(text).toMatch(/^%% argelanderspace: latexmk's standard output of this attempt$/m);
      expect(eventsNamed("tex.compile_failed", from)).toHaveLength(1);
      expect(eventsNamed("tex.compile_failed", from)[0]).toMatchObject({
        job: named.id,
        missing_tex_files: ["nosuchstylezz.bst"],
      });

      // Reverse privacy: a style whose name is not a plain file name, a database entry bibtex cannot read (it quotes
      // the line in the .blg, and latexmk prints what bibtex printed), a line the source has the engine print.
      from = mark();
      const marked = await upload(
        doc(
          "\\begin{document}",
          `\\typeout{${MARK.typeout}}`,
          "See \\cite{k}.",
          `\\bibliographystyle{${MARK.packageDir}/${MARK.bibStyle}}`,
          "\\bibliography{refs}"
        ),
        { "refs.bib": `${bib}@article{${MARK.bibFile} title = oops}\n` }
      );
      expect(marked.status).toBe("failed");
      const kept = readFileSync(join(jobsDir(), `${marked.id}.compile.log`), "utf8");
      const part = (title: string): string =>
        kept
          .split(`%% argelanderspace: ${title} of this attempt\n`)[1]
          ?.split("%% argelanderspace: ")[0] ?? "";
      expect(part("bibliography log (.blg)")).toContain(
        `I couldn't open style file ${MARK.packageDir}/${MARK.bibStyle}.bst`
      );
      expect(part("latexmk's standard output")).toContain(MARK.typeout);
      expect(part("latexmk's standard output")).toContain(
        `${MARK.packageDir}/${MARK.bibStyle}.bst`
      );
      const [failed] = eventsNamed("tex.compile_failed", from);
      expect(failed).toMatchObject({ job: marked.id });
      expect(failed).not.toHaveProperty("missing_tex_files");
      expect(failed).not.toHaveProperty("missing_other_files");

      // … and what bibtex quotes of a database it cannot read (with a style that exists, so that it gets there)
      from = mark();
      const quoted = await upload(
        doc(
          "\\begin{document}",
          "See \\cite{k}.",
          "\\bibliographystyle{plain}",
          "\\bibliography{refs}"
        ),
        { "refs.bib": `${bib}@article{${MARK.bibFile} title = oops}\n` }
      );
      expect(quoted.status).toBe("failed");
      const quotedText = readFileSync(join(jobsDir(), `${quoted.id}.compile.log`), "utf8");
      expect(
        quotedText
          .split("%% argelanderspace: bibliography log (.blg) of this attempt\n")[1]
          ?.split("%% argelanderspace: ")[0]
      ).toContain(MARK.bibFile);
      expect(eventsNamed("tex.compile_failed", from)).toHaveLength(1);
      expectNoMarkers();
    },
    240_000
  );

  test("a collecting file left by a run that was killed is removed: at once when the server starts, and once it is old while one runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-partial-"));
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const old = new Date(Date.now() - INGEST_PARTIAL_STALE_MS - 60_000);
    const names = {
      stale: `upload-${uuid(1)}.compile.log.partial`,
      fresh: `ingest-${uuid(2)}.compile.log.partial`,
      other: "notes.compile.log.partial",
      folder: `upload-${uuid(3)}.compile.log.partial`,
      kept: `upload-${uuid(4)}.compile.log`,
    };
    const fill = (): void => {
      writeFileSync(join(dir, names.stale), "source line");
      utimesSync(join(dir, names.stale), old, old);
      writeFileSync(join(dir, names.fresh), "source line");
      writeFileSync(join(dir, names.other), "not ours");
      utimesSync(join(dir, names.other), old, old);
      mkdirSync(join(dir, names.folder), { recursive: true });
      utimesSync(join(dir, names.folder), old, old);
      writeFileSync(join(dir, names.kept), "kept");
    };
    fill();
    // while the server runs (the pruning after a failure): only one old enough that no compile can still be writing it
    pruneIngestFailureLogs(dir);
    expect(readdirSync(dir).sort()).toEqual(
      [names.fresh, names.other, names.folder, names.kept].sort()
    );
    // when the server starts no job of this directory is running (the runner has just marked them interrupted)
    fill();
    sweepIngestPartials(dir);
    expect(readdirSync(dir).sort()).toEqual([names.other, names.folder, names.kept].sort());
    sweepIngestPartials(join(dir, "no-such-dir"));

    // … and a starting server does that
    fill();
    const jobs = join(dir, "data", "jobs");
    mkdirSync(jobs, { recursive: true });
    writeFileSync(join(jobs, names.fresh), "source line");
    const booted = createServer({
      dataDir: join(dir, "data"),
      port: 0,
      webDist: null,
      heartbeatMs: 0,
    });
    expect(readdirSync(jobs)).toEqual([]);
    await booted.ready();
    await booted.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("what was missing", () => {
  test("distribution-kind files by name, the user's own by extension, nothing that is not a plain name", () => {
    expect(
      classifyMissingTexFiles([
        "natbib.sty",
        "revtex4-2.cls",
        "apj.bst",
        "t1cmr.fd",
        "nosuchfont.tfm",
        "size10.clo",
        "natbib.sty",
        `${MARK.packageDir}/x.sty`,
        "has space.sty",
        `../${MARK.packageName}.cls`,
        `${"a".repeat(80)}.sty`,
        `${MARK.figure}.pdf`,
        `figs/${MARK.figure}.PNG`,
        MARK.chapter,
        `${MARK.chapter}.tex`,
        `refs.${MARK.extra}`,
        "data.weird",
        42,
      ])
    ).toEqual({
      names: ["natbib.sty", "revtex4-2.cls", "apj.bst", "t1cmr.fd", "nosuchfont.tfm", "size10.clo"],
      otherExtensions: ["pdf", "png", "none", "tex", "other"],
    });
    expect(classifyMissingTexFiles([])).toEqual({ names: [], otherExtensions: [] });
  });
});

describe("a failed Writer render", () => {
  test.skipIf(!LATEX)(
    "keeps the last failure's log in the manuscript's build directory — two failures, one file; the record names the manuscript by its random id",
    async () => {
      const from = mark();
      const created = await srv.app.request(
        "/api/writer/manuscripts",
        json("POST", { template: "report", title: MARK.title })
      );
      expect(created.status).toBe(201);
      let manuscript = (await created.json()) as {
        id: string;
        rev: number;
        cells: { id: string; type: string; data: Record<string, unknown> }[];
      };
      const base = manuscript.cells;
      const render = async (macro: string): Promise<string | null> => {
        const put = await srv.app.request(
          `/api/writer/manuscripts/${manuscript.id}`,
          json("PUT", {
            ...manuscript,
            cells: [
              ...base,
              { id: "c_0123abcd", type: "latex", data: { source: `${MARK.cell} \\${macro}{x}` } },
            ],
          })
        );
        expect(put.status).toBe(200);
        manuscript = (await put.json()) as typeof manuscript;
        const res = await srv.app.request(
          `/api/writer/manuscripts/${manuscript.id}/numbering/refresh`,
          json("POST", {})
        );
        expect(res.status).toBe(200);
        return ((await res.json()) as { lastError: string | null }).lastError;
      };
      const build = join(dataDir, "manuscripts", manuscript.id, "build");
      const logsIn = (): string[] =>
        readdirSync(build).filter((name) => /failure|\.partial$/.test(name));

      expect(await render(MARK.macro)).toContain(MARK.macro);
      expect(logsIn()).toEqual(["compile-failure.log"]);
      const first = readFileSync(join(build, "compile-failure.log"), "utf8");
      expect(first).toContain(`\\${MARK.macro}`);
      expect(first).toMatch(/This is (pdfTeX|XeTeX)/);

      expect(await render(MARK.secondMacro)).toContain(MARK.secondMacro);
      expect(logsIn()).toEqual(["compile-failure.log"]);
      const second = readFileSync(join(build, "compile-failure.log"), "utf8");
      expect(second).toContain(`\\${MARK.secondMacro}`);
      expect(second).not.toContain(`\\${MARK.macro}{`);

      const failed = eventsNamed("tex.compile_failed", from);
      expect(failed).toHaveLength(2);
      expect(manuscript.id).toMatch(/^m_[0-9a-f]{8}$/);
      for (const record of failed)
        expect(record).toEqual({
          t: expect.any(String),
          level: "warn",
          event: "tex.compile_failed",
          source: "writer",
          manuscript: manuscript.id.slice(2),
          kind: "compile-error",
          engine: "pdflatex",
          exit_code: 12,
          timed_out: "no",
          log_file: "manuscripts/m_<manuscript>/build/compile-failure.log",
        });

      // and the source, once right, renders at once on the same cache: the clearing still does its work
      const put = await srv.app.request(
        `/api/writer/manuscripts/${manuscript.id}`,
        json("PUT", { ...manuscript, cells: base })
      );
      expect(put.status).toBe(200);
      manuscript = (await put.json()) as typeof manuscript;
      const ok = await srv.app.request(
        `/api/writer/manuscripts/${manuscript.id}/numbering/refresh`,
        json("POST", {})
      );
      expect(((await ok.json()) as { lastError: string | null }).lastError).toBeNull();
      expect(eventsNamed("tex.compile_failed", from)).toHaveLength(2);
      // the last render succeeded: the log of the failure before it is not kept any more
      expect(logsIn()).toEqual([]);
      // … and the next failure has one again
      expect(await render(MARK.macro)).toContain(MARK.macro);
      expect(logsIn()).toEqual(["compile-failure.log"]);
      expect(eventsNamed("tex.compile_failed", from)).toHaveLength(3);

      // Something that cannot be removed standing in the log's place does not fail a render that succeeded.
      rmSync(join(build, "compile-failure.log"));
      mkdirSync(join(build, "compile-failure.log", "inside"), { recursive: true });
      const again = await srv.app.request(
        `/api/writer/manuscripts/${manuscript.id}`,
        json("PUT", { ...manuscript, cells: base })
      );
      expect(again.status).toBe(200);
      manuscript = (await again.json()) as typeof manuscript;
      const okAgain = await srv.app.request(
        `/api/writer/manuscripts/${manuscript.id}/numbering/refresh`,
        json("POST", {})
      );
      expect(((await okAgain.json()) as { lastError: string | null }).lastError).toBeNull();
      expect(existsSync(join(build, "compile-failure.log", "inside"))).toBe(true);
      expectNoMarkers();
    },
    300_000
  );
});

// --------------------------------------------------------------------------- //
// An error of the page
// --------------------------------------------------------------------------- //

describe("an error the page reports", () => {
  const report = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    Promise.resolve(srv.app.request("/api/page-errors", json("POST", body, headers)));
  const ownOrigin = (): string => `http://127.0.0.1:${boundPort}`;
  /** Lets the rate window, and the wait before dropped reports are counted, run out. */
  const nextWindow = (): Promise<unknown> => sleep(WINDOW_MS + 150);

  test("is recorded by kind, name, frames in the page's own scripts and pane — and nothing else", async () => {
    await nextWindow();
    const from = mark();
    const res = await report(
      {
        kind: "render",
        name: "TypeError",
        message: MARK.message,
        stack: [`${SCRIPT}:12:3456`, `${SCRIPT}:1:2`],
        pane: "library",
      },
      { Origin: ownOrigin() }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: true });
    expect(eventsNamed("page.error", from)).toEqual([
      {
        t: expect.any(String),
        level: "error",
        event: "page.error",
        kind: "render",
        pane: "library",
        error: { name: "TypeError", stack: [`/assets/${SCRIPT}:12:3456`, `/assets/${SCRIPT}:1:2`] },
      },
    ]);
    expectNoMarkers();
  });

  test("frames of every script a real build has are kept: a hyphen in the name, `_` and `-` in the hash, an .mjs", async () => {
    await nextWindow();
    const from = mark();
    const res = await report({
      kind: "error",
      name: "TypeError",
      stack: [
        ...REAL_SCRIPTS.map((name, i) => `${name}:${i + 1}:${i + 10}`),
        "not-there-AbCdEfGh.js:1:2",
      ],
      pane: "doc",
    });
    expect(await res.json()).toEqual({ recorded: true });
    const [written] = eventsNamed("page.error", from);
    expect((written?.error as { stack: string[] } | undefined)?.stack).toEqual(
      REAL_SCRIPTS.map((name, i) => `/assets/${name}:${i + 1}:${i + 10}`)
    );
    expectNoMarkers();
  });

  test("the message of any error — a built-in type's too — is not in the log, wherever the page puts it", async () => {
    await nextWindow();
    const from = mark();
    for (const name of ["TypeError", "SyntaxError", "Error", "RangeError", "DOMException"]) {
      const res = await report({
        kind: "error",
        name,
        message: MARK.message,
        stack: [`${name}: ${MARK.message}`, `    at ${MARK.frameFunction} (${SCRIPT}:1:2)`],
        pane: "doc",
        cause: { message: MARK.message },
        [MARK.extra]: MARK.extra,
        detail: MARK.message,
      });
      expect(await res.json()).toEqual({ recorded: true });
    }
    const written = eventsNamed("page.error", from);
    expect(written).toHaveLength(5);
    for (const record of written) {
      expect(Object.keys(record).sort()).toEqual(["error", "event", "kind", "level", "pane", "t"]);
      expect(Object.keys(record.error as object).sort()).toEqual(["name", "stack"]);
      expect((record.error as { stack: string[] }).stack).toEqual([]);
    }
    expect(logText(logDir)).not.toContain("message");
    expectNoMarkers();
  });

  test("what is not of a known shape is written as a fixed value or left out: name, kind, pane, frames, other types", async () => {
    await nextWindow();
    const from = mark();
    const frames = [
      `${MARK.frameFile}-AbCdEfGh.js:1:2`, // the shape of a built script, but not one this server serves
      `http://127.0.0.1/assets/${SCRIPT}:1:2`,
      `${SCRIPT}?${MARK.extra}=1:1:2`,
      `${SCRIPT}#${MARK.extra}:1:2`,
      `at ${MARK.frameFunction} (${SCRIPT}:1:2)`,
      `${MARK.frameFunction}@${SCRIPT}:1:2`,
      `../${SCRIPT}:1:2`,
      `${SCRIPT}:1`,
      `${SCRIPT}:0:0`,
      `${SCRIPT}:1:2 ${MARK.extra}`,
      "index-BOe1kVrW.css:1:2",
      `${SCRIPT}:7:8`,
      42,
      { file: MARK.frameFile },
      null,
    ];
    expect(
      await (
        await report({ kind: MARK.extra, name: MARK.errorName, stack: frames, pane: MARK.pane })
      ).json()
    ).toEqual({ recorded: true });
    await report({
      kind: "error",
      name: `${MARK.errorName} with spaces Error`,
      stack: MARK.message,
      pane: 7,
    });
    await report({ kind: ["error"], name: { toString: MARK.errorName }, pane: null });
    await report({
      kind: "unhandledrejection",
      name: "ChunkLoadError",
      stack: Array(200).fill(`${SCRIPT}:9:9`),
      pane: "none",
    });
    const written = eventsNamed("page.error", from);
    expect(written.map((r) => [r.kind, r.pane, r.error])).toEqual([
      [
        "<invalid-enum>",
        "<invalid-enum>",
        { name: "UnrecognizedName", stack: [`/assets/${SCRIPT}:7:8`] },
      ],
      ["error", "<invalid-enum>", { name: "UnrecognizedName", stack: [] }],
      ["<invalid-enum>", "<invalid-enum>", { name: "UnrecognizedName", stack: [] }],
      [
        "unhandledrejection",
        "none",
        { name: "ChunkLoadError", stack: Array(30).fill(`/assets/${SCRIPT}:9:9`) },
      ],
    ]);
    expectNoMarkers();
  });

  test("a cross-site report is refused and leaves no record; a body that is too large or not an object is dropped and counted", async () => {
    await nextWindow();
    const from = mark();
    const cross = await report(
      { kind: "error", name: "TypeError", pane: "plan" },
      { Origin: "https://evil.example" }
    );
    expect(cross.status).toBe(403);
    expect(await cross.json()).toEqual({ detail: "cross-site request rejected" });

    const big = await report({
      kind: "error",
      name: "TypeError",
      pad: `${MARK.long}${"x".repeat(PAGE_ERROR_BODY_MAX_BYTES)}`,
    });
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ recorded: false, reason: "too_large" });
    // a body without a declared length is cut off while it is read
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 64; i++)
          controller.enqueue(new TextEncoder().encode(`${MARK.long}${"y".repeat(1024)}`));
        controller.close();
      },
    });
    const streamed = await srv.app.request("/api/page-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(streamed.status).toBe(413);
    for (const body of ["[1,2]", `"${MARK.message}"`, `{not json ${MARK.message}`, "null", ""]) {
      const res = await srv.app.request("/api/page-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ recorded: false, reason: "malformed" });
    }
    expect(eventsNamed("page.error", from)).toEqual([]);
    await nextWindow();
    expect(
      eventsNamed("page.errors_dropped", from)
        .map((r) => [r.level, r.reason, r.count])
        .sort()
    ).toEqual([
      ["warn", "malformed", 5],
      ["warn", "too_large", 2],
    ]);
    expectNoMarkers();
  });

  test(`at most ${PAGE_ERRORS_PER_MINUTE} a window and ${PAGE_ERRORS_PER_LAUNCH} a launch: the rest is dropped, and counted in one record a window`, async () => {
    await nextWindow();
    const from = mark();
    const one = { kind: "error", name: "TypeError", message: MARK.message, pane: "mail" };
    const outcomes: unknown[] = [];
    for (let i = 0; i < PAGE_ERRORS_PER_MINUTE + 7; i++)
      outcomes.push(await (await report(one)).json());
    expect(outcomes.slice(0, PAGE_ERRORS_PER_MINUTE)).toEqual(
      Array(PAGE_ERRORS_PER_MINUTE).fill({ recorded: true })
    );
    expect(outcomes.slice(PAGE_ERRORS_PER_MINUTE)).toEqual(
      Array(7).fill({ recorded: false, reason: "per_minute" })
    );
    expect(eventsNamed("page.error", from)).toHaveLength(PAGE_ERRORS_PER_MINUTE);
    // not one record per dropped report: none yet, then one for the window
    expect(eventsNamed("page.errors_dropped", from)).toEqual([]);
    await nextWindow();
    expect(eventsNamed("page.errors_dropped", from)).toEqual([
      {
        t: expect.any(String),
        level: "warn",
        event: "page.errors_dropped",
        reason: "per_minute",
        count: 7,
        recorded_this_launch: eventsNamed("page.error").length,
      },
    ]);
    // the next window takes reports again
    expect(await (await report(one)).json()).toEqual({ recorded: true });

    // up to the launch's cap
    for (;;) {
      const recorded = eventsNamed("page.error").length;
      if (recorded >= PAGE_ERRORS_PER_LAUNCH) break;
      await nextWindow();
      const batch = Math.min(PAGE_ERRORS_PER_MINUTE, PAGE_ERRORS_PER_LAUNCH - recorded);
      for (let i = 0; i < batch; i++)
        expect(await (await report(one)).json()).toEqual({ recorded: true });
    }
    await nextWindow();
    const capped = mark();
    for (let i = 0; i < 3; i++)
      expect(await (await report(one)).json()).toEqual({ recorded: false, reason: "per_launch" });
    await nextWindow();
    expect(eventsNamed("page.error")).toHaveLength(PAGE_ERRORS_PER_LAUNCH);
    expect(
      eventsNamed("page.errors_dropped", capped).map((r) => [
        r.reason,
        r.count,
        r.recorded_this_launch,
      ])
    ).toEqual([["per_launch", 3, PAGE_ERRORS_PER_LAUNCH]]);
    expectNoMarkers();
    expect(logText(logDir).toLowerCase()).not.toContain(ROOT);
  }, 60_000);

  test("a server that closes before the window is over writes the count of what it dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-closing-"));
    const closing = createServer({
      dataDir: dir,
      port: 0,
      webDist: null,
      heartbeatMs: 0,
      log,
      deps: { pipelines: stubPipelines() },
      // a window that does not end during the test
      pageErrors: { windowMs: 3_600_000 },
    });
    await closing.ready();
    const from = mark();
    for (const body of ["[1,2]", "null", ""]) {
      const res = await closing.app.request("/api/page-errors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(eventsNamed("page.errors_dropped", from)).toEqual([]);
    await closing.close();
    expect(eventsNamed("page.errors_dropped", from).map((r) => [r.reason, r.count])).toEqual([
      ["malformed", 3],
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a server without a log answers that nothing was recorded; the route is behind the same guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-nolog-"));
    const quiet = createServer({
      dataDir: dir,
      port: 0,
      webDist: null,
      heartbeatMs: 0,
      deps: { pipelines: stubPipelines() },
    });
    await quiet.ready();
    const res = await quiet.app.request(
      "/api/page-errors",
      json("POST", { kind: "error", name: "TypeError", pane: "plan" })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ recorded: false, reason: "no_log" });
    const cross = await quiet.app.request(
      "/api/page-errors",
      json("POST", { kind: "error" }, { Origin: "https://evil.example" })
    );
    expect(cross.status).toBe(403);
    await quiet.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
