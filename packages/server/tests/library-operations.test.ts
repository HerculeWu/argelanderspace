/**
 * The Library-domain catalog operations of release-0.2 ticket 06 (`import_works`, `attach_local_pdf`,
 * `list_ads_libraries`, `read_ads_library`, `acquire_arxiv_pdf`, `attach_arxiv`, `read_jobs`), each on both paths of
 * ADR 0015: in this process (`createLocalOperationRuntime`, what a CLI command uses without a workbench) and on the
 * workbench's operation route (`createApp` with a run token, what the CLI uses with one). Every run is on synthetic
 * data in a temporary directory with an offline network stub, a real JobRunner, real PDFium and the real library lock.
 * `attach_arxiv` replacing a Doc's text is the one operation that needs a person: approval, denial, withdrawal and the
 * absence of a workbench are covered. The Copilot side of the same actions stays in `copilot-library-*.test.ts`.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ExternalRequest, OPERATION_CATALOG } from "@argelanderspace/contracts";
import {
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  saveAnnotationsFile,
} from "@argelanderspace/core";
import { AdsClient, type AdsLibrariesSource } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { afterEach, beforeEach, expect, test } from "vitest";
import { jsonResponse, stubFetch } from "../../infra/tests/helpers.js";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { createLocalOperationRuntime } from "../src/local-operations.js";
import { runCatalogOperation } from "../src/operation-catalog.js";
import { stubPipelines, stubSources } from "./helpers.js";

/** An answer as the tests read it: the fields they look at are named where they are used. */
type Answer = Record<string, unknown> & {
  docId?: string;
  entries?: { bibcode: string; status: string }[];
};

const TOKEN = "t".repeat(64);
const PDF = new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url);
const TRUNCATED = new URL("./fixtures/pdf/truncated.pdf", import.meta.url);
const W_DOCLESS = "arxiv:2603.00001";
const W_REFRESH = "arxiv:2603.00002";
const W_NOARXIV = "doi:10.1000/noarxiv";
const REFRESH_DOC = "arxiv-2603.00002";
const CLIENT = { pid: 4242, commandLine: "argelanderspace library attach-arxiv --ref-id x" };
const ORIGIN = { Origin: "http://localhost:5173" };

const work = (id: string, extra: object = {}) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "arXiv",
  type: "article",
  ...(id.startsWith("arxiv:") ? { arxiv_id: id.slice(6) } : { doi: id.slice(4) }),
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: [],
  ...extra,
});
const refreshIr = (text: string) => ({
  version: 1,
  docId: REFRESH_DOC,
  sections: [
    {
      id: "sec-1",
      level: 1,
      number: "1",
      heading: "Introduction",
      blocks: [{ id: "p-1", type: "paragraph", segments: [{ type: "text", text }] }],
      children: [],
    },
  ],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
  source: { type: "latex", origin: "/tmp/src", main_tex: "main.tex", arxiv_id: "2603.00002" },
  meta: { title: "Existing arXiv Doc" },
});

let root: string;
let dataDir: string;
let paths: LibraryPaths;
let pdfBytes: Buffer;
let arxivPdf: (arxivId: string) => Promise<Buffer>;
let app: Hono;
let runner: JobRunner;
let adsLibraries: AdsLibrariesSource | undefined;

/** A fresh data directory with the synthetic library; `n` makes a second, independent one. */
function seed(name: string): { dir: string; paths: LibraryPaths } {
  const dir = join(root, name);
  const p = libraryPaths(dir);
  mkdirSync(p.libraryDir, { recursive: true });
  writeFileSync(
    p.libraryJson,
    JSON.stringify(
      {
        version: 1,
        project: { name: "Synthetic", short: "S", field: "" },
        works: [work(W_DOCLESS), work(W_REFRESH, { doc_ids: [REFRESH_DOC] }), work(W_NOARXIV)],
      },
      null,
      2
    )
  );
  const docDir = join(p.outputDir, REFRESH_DOC);
  mkdirSync(docDir, { recursive: true });
  writeFileSync(join(docDir, `${REFRESH_DOC}.json`), JSON.stringify(refreshIr("Hello world")));
  return { dir, paths: p };
}

const refreshText = (p: LibraryPaths = paths) =>
  readFileSync(join(p.outputDir, REFRESH_DOC, `${REFRESH_DOC}.json`), "utf8");
const jobsDirOf = (p: LibraryPaths = paths) => join(p.dataDir, "jobs");
const jobRecords = (p: LibraryPaths = paths) =>
  existsSync(jobsDirOf(p)) ? readdirSync(jobsDirOf(p)).filter((n) => n.endsWith(".json")) : [];
const workOnDisk = (id: string, p: LibraryPaths = paths) => LibraryStore.load(p).get(id);

function localRuntime(
  p: LibraryPaths = paths,
  wiring: Record<string, unknown> = {},
  autoIngestArxiv: () => boolean = () => false
) {
  const runtime = createLocalOperationRuntime(p, wiring, {
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    fetchArxivPdf: (id) => arxivPdf(id),
    autoIngestArxiv,
  });
  if (adsLibraries) runtime.library.adsLibraries = () => adsLibraries as AdsLibrariesSource;
  return runtime;
}
const local = (id: string, params: Record<string, unknown>, p: LibraryPaths = paths) =>
  runCatalogOperation(localRuntime(p), id as never, params);

function buildApp(jobWaitMs?: number) {
  runner = new JobRunner({ dir: jobsDirOf() });
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    fetchArxivPdf: (id) => arxivPdf(id),
    makeAdsLibraries: () => adsLibraries as AdsLibrariesSource,
    runner,
    broadcast: () => {},
    operations: { token: TOKEN, ...(jobWaitMs !== undefined ? { jobWaitMs } : {}) },
  }) as unknown as Hono;
}
/** The CLI's request to the workbench: held until the operation (and its card) is done. */
function viaWorkbench(
  id: string,
  params: Record<string, unknown>,
  signal?: AbortSignal
): Promise<{ status: number; body: Record<string, unknown> }> {
  return Promise.resolve(
    app.request("/api/operations/run", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ id, params, client: CLIENT }),
      ...(signal ? { signal } : {}),
    })
  ).then(async (res) => ({
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  }));
}
const queue = async (): Promise<ExternalRequest[]> =>
  ((await (await app.request("/api/external-requests")).json()) as { requests: ExternalRequest[] })
    .requests;
async function waitForQueue(count: number): Promise<ExternalRequest[]> {
  for (let i = 0; i < 400; i++) {
    const requests = await queue();
    if (requests.length === count) return requests;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`the queue never reached ${count} requests`);
}
const decide = (id: string, decision: "approve" | "deny") =>
  app.request(`/api/external-requests/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json", ...ORIGIN },
    body: JSON.stringify({ decision }),
  });

const resultSchema = (id: string) => {
  const op = OPERATION_CATALOG.find((entry) => entry.id === id);
  if (!op) throw new Error(id);
  return op.result;
};
const valid = (id: string, answer: unknown) => resultSchema(id).safeParse(answer).success;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "library-ops-"));
  ({ dir: dataDir, paths } = seed("data"));
  pdfBytes = readFileSync(PDF);
  arxivPdf = async () => pdfBytes;
  adsLibraries = undefined;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ---- read_jobs ------------------------------------------------------------------------------------ //
test("read_jobs: in this process it reads the records without creating or rewriting anything; the workbench gives the same answer", async () => {
  expect(await local("library.read_jobs", {})).toEqual({ ok: true, jobs: [], total: 0 });
  expect(existsSync(jobsDirOf())).toBe(false);
  // A record left by a run that did not finish stays exactly as written (a read does not mark it interrupted).
  mkdirSync(jobsDirOf(), { recursive: true });
  const record = {
    id: "upload-1",
    kind: "upload",
    status: "running",
    createdAt: "2026-10-01T00:00:00.000Z",
    startedAt: "2026-10-01T00:00:01.000Z",
    finishedAt: null,
    progress: [{ at: "2026-10-01T00:00:02.000Z", message: "Fetching current arXiv PDF" }],
    result: null,
    error: null,
    payload: { workId: W_DOCLESS, format: "arxiv-pdf", arxivId: "2603.00001" },
  };
  writeFileSync(join(jobsDirOf(), "upload-1.json"), JSON.stringify(record));
  const before = readFileSync(join(jobsDirOf(), "upload-1.json"), "utf8");
  const answer = await local("library.read_jobs", { refId: W_DOCLESS });
  expect(answer).toMatchObject({
    ok: true,
    total: 1,
    jobs: [
      {
        id: "upload-1",
        status: "running",
        workId: W_DOCLESS,
        progress: "Fetching current arXiv PDF",
      },
    ],
  });
  expect(valid("library.read_jobs", answer)).toBe(true);
  expect(readFileSync(join(jobsDirOf(), "upload-1.json"), "utf8")).toBe(before);
  expect(await local("library.read_jobs", { refId: W_REFRESH })).toMatchObject({ total: 0 });

  // The workbench (its runner is the live table): a fresh one answers the empty table in the same shape.
  rmSync(jobsDirOf(), { recursive: true, force: true });
  buildApp();
  const viaRoute = await viaWorkbench("library.read_jobs", {});
  expect(viaRoute).toEqual({ status: 200, body: { ok: true, jobs: [], total: 0 } });
  const bad = await viaWorkbench("library.read_jobs", { limit: 51 });
  expect(bad.status).toBe(400);
});

// ---- import_works --------------------------------------------------------------------------------- //
const BIB = `@article{synth2026,\n  author = {Doe, Jane},\n  title = {A synthetic import},\n  journal = {MNRAS},\n  year = {2026},\n  doi = {10.1000/synth}\n}`;

test("import_works (bib): created, then already held; BibTeX never queues an arXiv PDF job; the workbench answers the same", async () => {
  const first = (await local("library.import_works", { mode: "bib", text: BIB })) as Record<
    string,
    unknown
  >;
  expect(first).toMatchObject({
    ok: true,
    status: "ok",
    mode: "bib",
    created: 1,
    existing: 0,
    failed: 0,
  });
  expect(valid("library.import_works", first)).toBe(true);
  expect(workOnDisk("doi:10.1000/synth")).toBeDefined();
  expect(jobRecords()).toEqual([]); // nothing was queued
  const again = await local("library.import_works", { mode: "bib", text: BIB });
  expect(again).toMatchObject({ ok: true, status: "noop", created: 0, existing: 1 });

  // The same input on a second, independent data directory through the workbench.
  const other = seed("other");
  paths = other.paths;
  dataDir = other.dir;
  buildApp();
  const viaRoute = await viaWorkbench("library.import_works", { mode: "bib", text: BIB });
  expect(viaRoute.status).toBe(200);
  expect(viaRoute.body).toEqual(JSON.parse(JSON.stringify(first)));
  expect(workOnDisk("doi:10.1000/synth", other.paths)).toBeDefined();
});

test("import_works (identifier) in this process follows auto_ingest_arxiv: on queues the arXiv PDF job and waits for its end, off queues none; same answer shape as the workbench", async () => {
  const pdfJobs = (p: LibraryPaths) =>
    jobRecords(p)
      .map((name) => JSON.parse(readFileSync(join(jobsDirOf(p), name), "utf8")))
      .filter((job) => job.payload?.format === "arxiv-pdf");
  const params = { mode: "identifier", text: "arXiv:2603.77777" };
  const fetched: string[] = [];
  arxivPdf = async (id) => {
    fetched.push(id);
    return pdfBytes;
  };

  const off = (await runCatalogOperation(
    localRuntime(paths, {}, () => false),
    "library.import_works",
    params
  )) as Answer;
  expect(off).toMatchObject({ ok: true, status: "ok", created: 1 });
  expect(jobRecords()).toEqual([]);
  expect(fetched).toEqual([]);

  const second = seed("second");
  const on = (await runCatalogOperation(
    localRuntime(second.paths, {}, () => true),
    "library.import_works",
    params
  )) as Answer;
  expect(on).toMatchObject({ ok: true, status: "ok", created: 1 });
  expect(valid("library.import_works", on)).toBe(true);
  // The command returned only after the job ended.
  const jobs = pdfJobs(second.paths);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ status: "done" });
  expect(fetched).toEqual(["2603.77777"]);

  // The workbench (its gate on) gives the same answer shape.
  const third = seed("third");
  paths = third.paths;
  dataDir = third.dir;
  buildApp();
  const viaRoute = await viaWorkbench("library.import_works", params);
  expect(viaRoute.status).toBe(200);
  expect(Object.keys(viaRoute.body).sort()).toEqual(Object.keys(on).sort());
  await Promise.all(runner.list().map((job) => runner.waitFor(job.id)));
});

test("import_works: invalid parameters never run; more than 200 bibcodes are the operation's own rejection on both paths", async () => {
  buildApp();
  for (const params of [
    {},
    { mode: "bibcode", text: " ; , " },
    { mode: "bib", text: BIB, batch: true },
    { mode: "bibcode", text: "2020ApJ...900....1H", path: "/etc/passwd" },
  ]) {
    const refused = await viaWorkbench("library.import_works", params);
    expect(refused.status, JSON.stringify(params)).toBe(400);
    expect(refused.body).toMatchObject({ ok: false, status: "unsupported" });
  }
  const many = Array.from(
    { length: 201 },
    (_, i) => `2020ApJ...900.${String(i).padStart(4, "0")}H`
  );
  const before = readFileSync(paths.libraryJson, "utf8");
  const local201 = await local("library.import_works", { mode: "bibcode", text: many.join(" ") });
  expect(local201).toMatchObject({ ok: false, status: "rejected", requested: 201, batch: true });
  const route201 = await viaWorkbench("library.import_works", {
    mode: "bibcode",
    text: many.join("\n"),
  });
  expect(route201.status).toBe(200);
  expect(route201.body).toEqual(JSON.parse(JSON.stringify(local201)));
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
});

test("import_works (bibcode batch): per-entry report from one ADS export, ads_unavailable told per entry, nothing queued", async () => {
  const exports: string[][] = [];
  const entry = (b: string, t: string, doi: string) =>
    `@ARTICLE{${b},\n  author = {{Doe}, J.},\n  title = {${t}},\n  journal = {\\mnras},\n  year = {2020},\n  doi = {${doi}}\n}`;
  const known: Record<string, string> = {
    "2020MNRAS.499.1234A": entry("2020MNRAS.499.1234A", "Paper A", "10.1093/mnras/a1"),
    "2021ApJ...900....1B": entry("2021ApJ...900....1B", "Paper B", "10.1093/mnras/b1"),
  };
  const runtime = createLocalOperationRuntime(
    paths,
    {},
    {
      makeSources: () => ({
        ...stubSources(),
        ads: new AdsClient({
          token: "SYNTHETIC",
          delay: 0,
          cacheDir: join(root, "ads-cache"),
          fetchImpl: (async (url: unknown, init?: { body?: string }) => {
            if (String(url).includes("/search/query"))
              return new Response(JSON.stringify({ response: { docs: [] } }), { status: 200 });
            const codes = (JSON.parse(String(init?.body)) as { bibcode: string[] }).bibcode;
            exports.push(codes);
            return new Response(
              JSON.stringify({
                export: codes
                  .map((c) => known[c])
                  .filter(Boolean)
                  .join("\n\n"),
              }),
              { status: 200 }
            );
          }) as never,
        }),
      }),
    }
  );
  const answer = (await runCatalogOperation(runtime, "library.import_works", {
    mode: "bibcode",
    text: "2020MNRAS.499.1234A,2021ApJ...900....1B; 2022A&A...650A...3C",
  })) as Answer;
  expect(answer).toMatchObject({
    ok: true,
    status: "ok",
    batch: true,
    requested: 3,
    created: 2,
    failed: 1,
  });
  expect((answer.entries ?? []).map((e) => [e.bibcode, e.status])).toEqual([
    ["2020MNRAS.499.1234A", "created"],
    ["2021ApJ...900....1B", "created"],
    ["2022A&A...650A...3C", "error"],
  ]);
  expect(valid("library.import_works", answer)).toBe(true);
  expect(exports).toHaveLength(1);
  expect(jobRecords()).toEqual([]);
});

// ---- attach_local_pdf ----------------------------------------------------------------------------- //
test("attach_local_pdf: in this process the PDF becomes a Doc and the command waits for the job; no copilot_file_tools setting is consulted", async () => {
  const file = join(root, "paper.pdf");
  copyFileSync(PDF, file);
  const answer = (await local("library.attach_local_pdf", {
    refId: W_DOCLESS,
    path: file,
  })) as Answer;
  expect(answer).toMatchObject({
    ok: true,
    status: "ok",
    job: { status: "done", kind: "upload" },
    source: { filename: "paper.pdf" },
  });
  expect(valid("library.attach_local_pdf", answer)).toBe(true);
  const docId = answer.docId as string;
  expect(workOnDisk(W_DOCLESS)?.doc_ids).toEqual([docId]);
  // The source is only read.
  expect(readFileSync(file).equals(pdfBytes)).toBe(true);
  // The same bytes again: the existing Doc, nothing new.
  const again = await local("library.attach_local_pdf", { refId: W_DOCLESS, path: file });
  expect(again).toMatchObject({ ok: true, status: "noop", docId });
  expect(workOnDisk(W_DOCLESS)?.doc_ids).toEqual([docId]);
  // The job is on disk and read_jobs sees it (a second run, no state shared with the first).
  const jobs = (await local("library.read_jobs", { refId: W_DOCLESS })) as {
    jobs: { status: string }[];
  };
  expect(jobs.jobs.every((j) => j.status === "done")).toBe(true);
  expect(jobs.jobs.length).toBeGreaterThanOrEqual(1);
});

test("attach_local_pdf: every refusal writes nothing and says why, on both paths", async () => {
  buildApp();
  const bad = join(root, "bad.pdf");
  copyFileSync(TRUNCATED, bad);
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      { refId: W_DOCLESS, path: "relative/paper.pdf" },
      { status: "rejected", reason: "path_not_absolute" },
    ],
    [
      { refId: W_DOCLESS, path: join(root, "missing.pdf") },
      { status: "not_found", reason: "source_not_found" },
    ],
    [
      { refId: "doi:10.1/none", path: join(root, "paper.pdf") },
      { status: "not_found", reason: "work_not_found" },
    ],
    [
      { refId: W_DOCLESS, path: bad },
      { status: "error", reason: "not_a_pdf" },
    ],
  ];
  copyFileSync(PDF, join(root, "paper.pdf"));
  const before = readFileSync(paths.libraryJson, "utf8");
  for (const [params, expected] of cases) {
    const here = (await local("library.attach_local_pdf", params)) as Record<string, unknown>;
    expect(here, JSON.stringify(params)).toMatchObject({ ok: false, ...expected });
    expect(valid("library.attach_local_pdf", here)).toBe(true);
    const there = await viaWorkbench("library.attach_local_pdf", params);
    expect(there.status).toBe(200);
    expect(there.body).toMatchObject({ ok: false, ...expected });
    expect(there.body.detail).toBe(here.detail);
  }
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
  expect(workOnDisk(W_DOCLESS)?.doc_ids).toEqual([]);
});

test("attach_local_pdf through the workbench: the PDF becomes a Doc of the Work and the answer has the in-process shape", async () => {
  buildApp();
  const file = join(root, "paper.pdf");
  copyFileSync(PDF, file);
  const answer = await viaWorkbench("library.attach_local_pdf", { refId: W_NOARXIV, path: file });
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({
    ok: true,
    status: "ok",
    job: { status: "done" },
    source: { filename: "paper.pdf" },
  });
  expect(valid("library.attach_local_pdf", answer.body)).toBe(true);
  expect(workOnDisk(W_NOARXIV)?.doc_ids).toEqual([answer.body.docId]);
});

// ---- ADS libraries -------------------------------------------------------------------------------- //
const LIB = { id: "lib_1-A", name: "Thesis", numDocuments: 230 };
const bibcodes = Array.from(
  { length: 230 },
  (_, i) => `2021MNRAS.${String(i).padStart(4, "0")}....B`
);
const stubLibraries = (): AdsLibrariesSource => ({
  list: async () => ({ ok: true, total: 1, libraries: [LIB], truncated: false }),
  readWindow: async (id, offset, limit) =>
    id === LIB.id
      ? {
          ok: true,
          library: LIB,
          total: 230,
          offset,
          bibcodes: bibcodes.slice(offset, offset + limit),
        }
      : { ok: false, reason: "not_found" },
});

test("list_ads_libraries and read_ads_library: windows of the library on both paths, read-only, errors told apart", async () => {
  adsLibraries = stubLibraries();
  buildApp();
  const before = readFileSync(paths.libraryJson, "utf8");
  const listed = await local("library.list_ads_libraries", {});
  expect(listed).toMatchObject({ ok: true, status: "ok", total: 1, libraries: [LIB] });
  expect(valid("library.list_ads_libraries", listed)).toBe(true);
  expect((await viaWorkbench("library.list_ads_libraries", {})).body).toEqual(listed);
  const page = await local("library.read_ads_library", { libraryId: LIB.id, limit: 200 });
  expect(page).toMatchObject({ ok: true, total: 230, offset: 0, nextOffset: 200 });
  expect((page as { bibcodes: string[] }).bibcodes).toHaveLength(200);
  expect(valid("library.read_ads_library", page)).toBe(true);
  const rest = await local("library.read_ads_library", { libraryId: LIB.id, offset: 200 });
  expect((rest as { bibcodes: string[]; nextOffset?: number }).bibcodes).toHaveLength(30);
  expect((rest as { nextOffset?: number }).nextOffset).toBeUndefined();
  expect(
    (await viaWorkbench("library.read_ads_library", { libraryId: LIB.id, offset: 200 })).body
  ).toEqual(rest);
  expect(await local("library.read_ads_library", { libraryId: "nope" })).toMatchObject({
    ok: false,
    status: "not_found",
    reason: "not_found",
  });
  // More than the batch import takes in one call, or a malformed id, is refused before anything runs.
  expect(
    (await viaWorkbench("library.read_ads_library", { libraryId: LIB.id, limit: 201 })).status
  ).toBe(400);
  expect((await viaWorkbench("library.read_ads_library", { libraryId: "a b" })).status).toBe(400);
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
});

test("list_ads_libraries in this process: no saved token is a failure told as no_token without a request; a host without ADS says unsupported", async () => {
  const stub = stubFetch(() => jsonResponse({}));
  const runtime = createLocalOperationRuntime(paths, {
    adsToken: async () => null,
    fetchImpl: stub.fetchImpl,
  });
  const none = await runCatalogOperation(runtime, "library.list_ads_libraries", {});
  expect(none).toMatchObject({ ok: false, status: "error", reason: "no_token" });
  expect(valid("library.list_ads_libraries", none)).toBe(true);
  expect(stub.calls).toHaveLength(0);
  expect(JSON.stringify(none)).not.toMatch(/Bearer|token":/);
  const bare = { ...runtime, library: { ...runtime.library, adsLibraries: undefined } };
  expect(await runCatalogOperation(bare, "library.list_ads_libraries", {})).toMatchObject({
    ok: false,
    status: "unsupported",
    reason: "unavailable",
  });
});

// ---- acquire_arxiv_pdf ---------------------------------------------------------------------------- //
test("acquire_arxiv_pdf: in this process the command waits for the job and the Doc is there; refusals match the dialog's", async () => {
  const answer = (await local("library.acquire_arxiv_pdf", { refId: W_DOCLESS })) as Answer;
  expect(answer).toMatchObject({
    ok: true,
    status: "ok",
    job: { status: "done", format: "arxiv-pdf" },
  });
  expect(valid("library.acquire_arxiv_pdf", answer)).toBe(true);
  expect(workOnDisk(W_DOCLESS)?.doc_ids).toEqual([answer.docId]);
  expect(await local("library.acquire_arxiv_pdf", { refId: W_NOARXIV })).toMatchObject({
    ok: false,
    status: "rejected",
    detail: "this work has no arXiv id",
  });
  expect(await local("library.acquire_arxiv_pdf", { refId: "arxiv:0000.00000" })).toMatchObject({
    ok: false,
    status: "not_found",
  });
  // A failing source is a failed job, reported with its text, and the Work keeps no Doc.
  arxivPdf = async () => {
    throw new Error("arXiv is down");
  };
  const seeded = seed("failing");
  const failed = await local("library.acquire_arxiv_pdf", { refId: W_DOCLESS }, seeded.paths);
  expect(failed).toMatchObject({ ok: false, status: "error", job: { status: "failed" } });
  expect((failed as { detail: string }).detail).toContain("arXiv is down");
  expect(workOnDisk(W_DOCLESS, seeded.paths)?.doc_ids).toEqual([]);
});

test("acquire_arxiv_pdf through the workbench: same answer shape; past the wait bound it answers pending and the job goes on", async () => {
  buildApp();
  const quick = await viaWorkbench("library.acquire_arxiv_pdf", { refId: W_DOCLESS });
  expect(quick.status).toBe(200);
  expect(quick.body).toMatchObject({ ok: true, status: "ok", job: { status: "done" } });
  expect(valid("library.acquire_arxiv_pdf", quick.body)).toBe(true);

  const slow = seed("slow");
  paths = slow.paths;
  dataDir = slow.dir;
  let release: (bytes: Buffer) => void = () => {};
  arxivPdf = () => new Promise<Buffer>((resolve) => (release = resolve));
  buildApp(80);
  const pending = await viaWorkbench("library.acquire_arxiv_pdf", { refId: W_DOCLESS });
  expect(pending.body).toMatchObject({ ok: true, status: "pending", job: { workId: W_DOCLESS } });
  expect(valid("library.acquire_arxiv_pdf", pending.body)).toBe(true);
  expect(workOnDisk(W_DOCLESS)?.doc_ids).toEqual([]);
  // The same call again does not queue a second job; the job finishes by itself and read_jobs shows its end.
  const reused = await viaWorkbench("library.acquire_arxiv_pdf", { refId: W_DOCLESS });
  expect(reused.body).toMatchObject({ status: "pending", reused: true });
  release(pdfBytes);
  const jobId = (pending.body.job as { id: string }).id;
  await runner.waitFor(jobId);
  const jobs = await viaWorkbench("library.read_jobs", { refId: W_DOCLESS });
  expect(jobs.body).toMatchObject({ ok: true, total: 1, jobs: [{ id: jobId, status: "done" }] });
  expect(workOnDisk(W_DOCLESS)?.doc_ids).toHaveLength(1);
});

// ---- attach_arxiv --------------------------------------------------------------------------------- //
test("attach_arxiv adds a Doc without a card, in this process and through the workbench", async () => {
  const here = (await local("library.attach_arxiv", { refId: W_DOCLESS })) as Answer;
  expect(here).toMatchObject({ ok: true, status: "ok", job: { status: "done", kind: "ingest" } });
  expect(valid("library.attach_arxiv", here)).toBe(true);
  expect(workOnDisk(W_DOCLESS)?.doc_ids).toEqual(["arxiv-2603.00001"]);
  expect(await local("library.attach_arxiv", { refId: W_NOARXIV })).toMatchObject({
    ok: false,
    status: "rejected",
    detail: "this work has no arXiv id",
  });
  const other = seed("other");
  paths = other.paths;
  dataDir = other.dir;
  buildApp();
  const there = await viaWorkbench("library.attach_arxiv", { refId: W_DOCLESS });
  expect(there.status).toBe(200);
  expect(there.body).toMatchObject({ ok: true, status: "ok", docId: "arxiv-2603.00001" });
  expect(await queue()).toEqual([]); // no card for an addition
});

test("attach_arxiv replacing an arXiv Doc needs a workbench: without one nothing is changed, queued or created", async () => {
  const before = refreshText();
  const libBefore = readFileSync(paths.libraryJson, "utf8");
  const answer = await local("library.attach_arxiv", { refId: W_REFRESH });
  expect(answer).toMatchObject({ ok: false, status: "workbench_required" });
  expect(valid("library.attach_arxiv", answer)).toBe(true);
  expect(refreshText()).toBe(before);
  expect(readFileSync(paths.libraryJson, "utf8")).toBe(libBefore);
  expect(jobRecords()).toEqual([]);
});

test("attach_arxiv replacing: approval submits the job, the decision call is told at once and the command gets the job's end", async () => {
  buildApp();
  const before = refreshText();
  const running = viaWorkbench("library.attach_arxiv", { refId: W_REFRESH });
  const [request] = await waitForQueue(1);
  expect(request).toMatchObject({
    state: "pending",
    card: {
      action: "refresh_arxiv_source",
      object: { kind: "doc", id: REFRESH_DOC, workId: W_REFRESH },
      label: `Work ${W_REFRESH}`,
      impact: { annotations: "known", count: 0 },
    },
    client: CLIENT,
  });
  // Nothing is written or queued while the card waits.
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(refreshText()).toBe(before);
  expect(runner.list()).toHaveLength(0);
  const decision = await decide(request?.id as string, "approve");
  expect(decision.status).toBe(200);
  const answer = await running;
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({
    ok: true,
    status: "ok",
    docId: REFRESH_DOC,
    job: { status: "done" },
  });
  expect(valid("library.attach_arxiv", answer.body)).toBe(true);
  expect(refreshText()).not.toContain("Hello world");
  expect(workOnDisk(W_REFRESH)?.doc_ids).toEqual([REFRESH_DOC]);
  expect(runner.list().filter((j) => j.kind === "ingest")).toHaveLength(1);
});

test("attach_arxiv replacing: denial changes nothing and is answered denied", async () => {
  buildApp();
  const before = refreshText();
  const running = viaWorkbench("library.attach_arxiv", { refId: W_REFRESH });
  const [request] = await waitForQueue(1);
  expect((await decide(request?.id as string, "deny")).status).toBe(200);
  const answer = await running;
  expect(answer.body).toMatchObject({ ok: false, status: "denied" });
  expect(valid("library.attach_arxiv", answer.body)).toBe(true);
  expect(refreshText()).toBe(before);
  expect(runner.list()).toHaveLength(0);
});

test("attach_arxiv replacing: the command leaving withdraws the card and nothing is replaced", async () => {
  buildApp();
  const before = refreshText();
  const controller = new AbortController();
  const running = viaWorkbench("library.attach_arxiv", { refId: W_REFRESH }, controller.signal);
  const [request] = await waitForQueue(1);
  controller.abort();
  await running.catch(() => {});
  for (let i = 0; i < 200 && (await queue())[0]?.state !== "withdrawn"; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await queue())[0]?.state).toBe("withdrawn");
  // A withdrawn card can no longer be approved.
  expect((await decide(request?.id as string, "approve")).status).toBe(409);
  expect(refreshText()).toBe(before);
  expect(runner.list()).toHaveLength(0);
});

test("attach_arxiv replacing: a change after the click expires it and no job is submitted", async () => {
  buildApp();
  const before = refreshText();
  const running = viaWorkbench("library.attach_arxiv", { refId: W_REFRESH });
  const [request] = await waitForQueue(1);
  // An annotation appears on the Doc between the card and the click.
  saveAnnotationsFile(paths.dataDir, REFRESH_DOC, {
    version: 1,
    rev: 1,
    content_fingerprint: "f".repeat(64),
    annotations: [
      {
        id: "a_0123abcd",
        target: { type: "document" },
        body: "mine",
        created_at: "2026-09-10T10:00:00.000Z",
        updated_at: "2026-09-10T10:00:00.000Z",
      },
    ],
  });
  await decide(request?.id as string, "approve");
  const answer = await running;
  expect(answer.body).toMatchObject({ ok: false, status: "expired" });
  expect(refreshText()).toBe(before);
  expect(runner.list()).toHaveLength(0);
});

// ---- the catalog ---------------------------------------------------------------------------------- //
test("every Library entry added by this ticket is a handler on the workbench route and is refused when its parameters are wrong", async () => {
  buildApp();
  const ids = [
    "library.import_works",
    "library.attach_local_pdf",
    "library.list_ads_libraries",
    "library.read_ads_library",
    "library.acquire_arxiv_pdf",
    "library.attach_arxiv",
    "library.read_jobs",
  ];
  for (const id of ids) {
    expect(
      OPERATION_CATALOG.some((op) => op.id === id),
      id
    ).toBe(true);
    const refused = await viaWorkbench(id, { definitely: "not a parameter" });
    expect(refused.status, id).toBe(400);
  }
});
