/**
 * Stage 15: `POST /api/library/attach-arxiv` (the manual entry) and the
 * automatic arXiv fetch on `POST /api/library/works` (D1/D6/D10/D16) —
 * hermetic data dir, stubbed pipelines/sources (no network, no latexmk):
 *
 * - the endpoint's 400/404/409 matrix and the 202 + serial-job happy paths
 *   (attach for a docless work, refresh for a work already listing its
 *   arXiv doc — "new replaces old" in place);
 * - duplicate triggers never stack: a second POST answers 202 with the
 *   in-flight job;
 * - the works route auto-queues for identifier/bibcode modes (created AND
 *   exists), never for a bib batch, and stays off when the hidden
 *   `auto_ingest_arxiv` gate is false;
 * - failures land in `<dataDir>/logs/arxiv-fetch.jsonl` (D12) with the
 *   machine-readable `errorCode` for PDF-only submissions — and upload
 *   failures never enter this log;
 * - `job.done` precedes `library.changed{cause:"ingest"}` on the wire.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job, WsServerMessage } from "@argelanderspace/contracts";
import {
  type IngestPipelines,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  type MetadataSources,
  publishPdfDoc,
} from "@argelanderspace/core";
import { ArxivPdfOnlyError } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

/** Fixture work: docless, arXiv 1108.0941 (scenario A). */
const DOCLESS_WORK = "doi:10.1051/0004-6361/201117315";
/** Fixture work: docs ["aa39341-20"], arXiv 2012.04267 (scenario C). */
const USER_DOC_WORK = "doi:10.1051/0004-6361/202039341";
/** Fixture work: docs ["arxiv-2603.00229"], arXiv 2603.00229 (scenario B). */
const REFRESH_WORK = "arxiv:2603.00229";
/** Fixture work: docless, no arXiv id at all. */
const NO_ARXIV_WORK = "openalex:W3099878876";

let dataDir: string;
let paths: LibraryPaths;
let app: Hono;
let runner: JobRunner;
let pipelines: IngestPipelines;
let messages: WsServerMessage[];
let autoFlag: boolean;
let sources: MetadataSources;

beforeEach(() => {
  dataDir = makeDataDir();
  paths = libraryPaths(dataDir);
  runner = new JobRunner({ dir: join(dataDir, "jobs") });
  const collector = collectBroadcasts();
  messages = collector.messages;
  pipelines = stubPipelines();
  autoFlag = true;
  sources = stubSources();
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => sources,
    pipelines,
    fetchArxivPdf: async () =>
      readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url)),
    runner,
    broadcast: collector.broadcast,
    autoIngestArxiv: () => autoFlag,
  });
});

const attach = (query: string) =>
  app.request(`/api/library/attach-arxiv${query}`, { method: "POST" });

const postWorks = (body: unknown) =>
  app.request("/api/library/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const ingestJobs = (): Job[] => runner.list().filter((j) => j.kind === "ingest");
const autoPdfJobs = (): Job[] =>
  runner
    .list()
    .filter(
      (j) =>
        j.kind === "upload" &&
        (j.payload as { format?: unknown } | undefined)?.format === "arxiv-pdf"
    );

function loadWork(id: string) {
  return LibraryStore.load(paths).get(id);
}

/** Broadcast stream as `type` / `type:cause` strings for order assertions. */
function stream(): string[] {
  return messages.map((m) => (m.type === "library.changed" ? `${m.type}:${m.cause}` : m.type));
}

describe("POST /api/library/attach-arxiv", () => {
  test("400 without id; 404 unknown work; 400 no arXiv id; 409 scenario C", async () => {
    expect((await attach("")).status).toBe(400);
    const unknown = await attach("?id=arxiv:0000.00000");
    expect(unknown.status).toBe(404);
    const noArxiv = await attach(`?id=${encodeURIComponent(NO_ARXIV_WORK)}`);
    expect(noArxiv.status).toBe(400);
    expect(await noArxiv.json()).toEqual({
      detail: `work '${NO_ARXIV_WORK}' has no arXiv id`,
    });
    // scenario C (D16): only user content — never clobber it
    const skip = await attach(`?id=${encodeURIComponent(USER_DOC_WORK)}`);
    expect(skip.status).toBe(409);
    expect(((await skip.json()) as { detail: string }).detail).toContain(
      "already has a non-arXiv doc"
    );
    expect(ingestJobs()).toEqual([]);
  });

  test("ambiguous PDF ownership blocks LaTeX append without changing Work links or PDF files", async () => {
    const bytes = readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url));
    const pdf = publishPdfDoc(paths, {
      workId: DOCLESS_WORK,
      filename: "owned.pdf",
      bytes,
      pages: [{ width: 612, height: 792, rotation: 0 }],
    });
    const store = LibraryStore.load(paths);
    const secondOwner = store.get(USER_DOC_WORK);
    if (!secondOwner) throw new Error("fixture Work missing");
    secondOwner.doc_ids.push(pdf.doc_id);
    store.save(paths);
    const linksBefore = LibraryStore.load(paths).works.map((work) => [work.id, [...work.doc_ids]]);
    const dir = join(paths.outputDir, pdf.doc_id);
    const filesBefore = [
      "original.pdf",
      `${pdf.doc_id}.json`,
      "annotations.json",
      "reading-position.json",
    ].map((file) => readFileSync(join(dir, file)));

    const response = await attach(`?id=${encodeURIComponent(DOCLESS_WORK)}`);
    expect(response.status).toBe(500);
    expect(loadWork(DOCLESS_WORK)?.doc_ids).toEqual(
      linksBefore.find(([id]) => id === DOCLESS_WORK)?.[1]
    );
    expect(loadWork(USER_DOC_WORK)?.doc_ids).toEqual(
      linksBefore.find(([id]) => id === USER_DOC_WORK)?.[1]
    );
    ["original.pdf", `${pdf.doc_id}.json`, "annotations.json", "reading-position.json"].forEach(
      (file, index) => {
        expect(readFileSync(join(dir, file))).toEqual(filesBefore[index]);
      }
    );
    expect(ingestJobs()).toHaveLength(0);
  });

  test("a Work mixing PDF and LaTeX zip still keeps legacy Scenario C blocked", async () => {
    const bytes = readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url));
    const workBefore = loadWork(USER_DOC_WORK);
    if (!workBefore) throw new Error("fixture Work missing");
    publishPdfDoc(paths, {
      workId: USER_DOC_WORK,
      filename: "additional.pdf",
      bytes,
      pages: [{ width: 612, height: 792, rotation: 0 }],
    });
    const response = await attach(`?id=${encodeURIComponent(USER_DOC_WORK)}`);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { detail: string }).detail).toContain("non-arXiv doc");
    expect(ingestJobs()).toHaveLength(0);
  });

  test("PDF-only Work explicitly fetching LaTeX appends a distinct Doc without changing the PDF main or sidecars", async () => {
    const bytes = readFileSync(new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url));
    const pdf = publishPdfDoc(paths, {
      workId: DOCLESS_WORK,
      filename: "existing.pdf",
      bytes,
      pages: [{ width: 612, height: 792, rotation: 0 }],
    });
    const pdfDir = join(paths.outputDir, pdf.doc_id);
    const originalBefore = readFileSync(join(pdfDir, "original.pdf"));
    const annotationsBefore = readFileSync(join(pdfDir, "annotations.json"));
    const positionBefore = readFileSync(join(pdfDir, "reading-position.json"));
    const response = await attach(`?id=${encodeURIComponent(DOCLESS_WORK)}`);
    expect(response.status).toBe(202);
    const { job } = (await response.json()) as { job: Job };
    const done = await runner.waitFor(job.id);
    expect(done.status, done.error ?? "").toBe("done");
    expect((done.result as { status: string }).status).toBe("appended");
    expect(loadWork(DOCLESS_WORK)?.doc_ids).toEqual([pdf.doc_id, "arxiv-1108.0941"]);
    expect(readFileSync(join(pdfDir, "original.pdf"))).toEqual(originalBefore);
    expect(readFileSync(join(pdfDir, "annotations.json"))).toEqual(annotationsBefore);
    expect(readFileSync(join(pdfDir, "reading-position.json"))).toEqual(positionBefore);
  });

  test("202 attach: docless work gains the arXiv doc as main; broadcasts ordered", async () => {
    const res = await attach(`?id=${encodeURIComponent(DOCLESS_WORK)}`);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    expect(job.kind).toBe("ingest");
    expect(job.payload).toEqual({ workId: DOCLESS_WORK, arxivId: "1108.0941" });
    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("done");
    expect((done.result as { status: string }).status).toBe("attached");
    const w = loadWork(DOCLESS_WORK);
    expect(w?.doc_ids).toEqual(["arxiv-1108.0941"]);
    // the weld: identity + provenance stamped into the doc json
    const doc = JSON.parse(
      readFileSync(join(paths.outputDir, "arxiv-1108.0941", "arxiv-1108.0941.json"), "utf8")
    ) as { source: Record<string, unknown> };
    expect(doc.source.acquired_via).toBe("arxiv_eprint");
    expect(doc.source.arxiv_id).toBe("1108.0941");
    expect(doc.source.doi).toBe("10.1051/0004-6361/201117315");
    // job.done precedes library.changed{cause:"ingest"} (upload precedent)
    const s = stream();
    expect(s.indexOf("job.created")).toBeGreaterThanOrEqual(0);
    expect(s.lastIndexOf("job.done")).toBeLessThan(s.indexOf("library.changed:ingest"));
  });

  test("202 refresh: the same arXiv doc is overwritten in place", async () => {
    const res = await attach(`?id=${encodeURIComponent(REFRESH_WORK)}`);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("done");
    expect((done.result as { status: string }).status).toBe("refreshed");
    expect(loadWork(REFRESH_WORK)?.doc_ids).toEqual(["arxiv-2603.00229"]);
  });

  test("a duplicate trigger answers 202 with the in-flight job (no stacking)", async () => {
    const base = pipelines.ingestArxivEprint;
    let unblock: () => void = () => {};
    pipelines.ingestArxivEprint = (arxivId, opts) =>
      new Promise((resolve) => {
        unblock = () => {
          void base(arxivId, opts).then(resolve);
        };
      });
    const r1 = await attach(`?id=${encodeURIComponent(DOCLESS_WORK)}`);
    expect(r1.status).toBe(202);
    const j1 = ((await r1.json()) as { job: Job }).job;
    await new Promise((r) => setTimeout(r, 10)); // let the serial chain start it
    const r2 = await attach(`?id=${encodeURIComponent(DOCLESS_WORK)}`);
    expect(r2.status).toBe(202);
    const j2 = ((await r2.json()) as { job: Job }).job;
    expect(j2.id).toBe(j1.id);
    expect(ingestJobs()).toHaveLength(1);
    unblock();
    expect((await runner.waitFor(j1.id)).status).toBe("done");
  });

  test("failure: PDF-only is typed (errorCode) and logged with the extract stage", async () => {
    pipelines.ingestArxivEprint = async () => {
      throw new ArxivPdfOnlyError(
        "1108.0941.tar.gz is neither a tar nor a readable gzip stream (boom); " +
          "the submission may be PDF-only (no LaTeX source)."
      );
    };
    const res = await attach(`?id=${encodeURIComponent(DOCLESS_WORK)}`);
    const { job } = (await res.json()) as { job: Job };
    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("PDF-only");
    expect(done.errorCode).toBe("arxiv_pdf_only");
    const logPath = join(dataDir, "logs", "arxiv-fetch.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      jobId: job.id,
      workId: DOCLESS_WORK,
      arxivId: "1108.0941",
      stage: "extract",
    });
    expect(typeof lines[0]?.time).toBe("string");
    expect(String(lines[0]?.error)).toContain("PDF-only");
  });

  test("failure: a plain download error is logged without an errorCode", async () => {
    pipelines.ingestArxivEprint = async () => {
      throw new Error("connection reset by peer");
    };
    const res = await attach(`?id=${encodeURIComponent(DOCLESS_WORK)}`);
    const { job } = (await res.json()) as { job: Job };
    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("failed");
    expect(done.errorCode).toBeUndefined();
    const lines = readFileSync(join(dataDir, "logs", "arxiv-fetch.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ jobId: job.id, stage: "download" });
  });

  test("upload failures never enter the arXiv-fetch log (D12 scope)", async () => {
    pipelines.ingestLatexZip = async () => {
      throw new Error("broken user zip");
    };
    // minimal legal zip (stored entries, zeroed CRCs — extractZip never checks)
    const name = Buffer.from("main.tex", "utf8");
    const data = Buffer.from("\\documentclass{article}\n", "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length, 12);
    eocd.writeUInt32LE(30 + name.length + data.length, 16);
    const zip = Buffer.concat([local, name, data, central, name, eocd]);
    const res = await app.request(`/api/library/upload?id=${encodeURIComponent(DOCLESS_WORK)}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: zip,
    });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    expect((await runner.waitFor(job.id)).status).toBe("failed");
    expect(existsSync(join(dataDir, "logs", "arxiv-fetch.jsonl"))).toBe(false);
  });
});

describe("works route: automatic arXiv PDF acquisition", () => {
  test("identifier create queues a PDF and retains add notification ordering", async () => {
    const res = await postWorks({ mode: "identifier", value: "arXiv:2609.17036" });
    const body = (await res.json()) as { results: Array<{ status: string }> };
    expect(body.results[0]?.status).toBe("created");
    const job = autoPdfJobs()[0];
    expect(job?.payload).toMatchObject({
      workId: "arxiv:2609.17036",
      arxivId: "2609.17036",
      format: "arxiv-pdf",
      automatic: true,
    });
    expect((await runner.waitFor(job?.id ?? "")).status).toBe("done");
    const docs = loadWork("arxiv:2609.17036")?.doc_ids ?? [];
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatch(/^pdf-/);
    const s = stream();
    expect(s.indexOf("job.created")).toBeLessThan(s.indexOf("library.changed:add"));
  });

  test("DOI without resolved arXiv ID and bulk BibTeX never auto-fetch", async () => {
    await postWorks({ mode: "identifier", value: "10.1234/brand-new" });
    await postWorks({
      mode: "bib",
      bib: "@article{mykey2026,\n author={Doe, Jane},\n title={Batch},\n year={2026},\n eprint={2609.17037},\n archivePrefix={arXiv}\n}",
    });
    expect(autoPdfJobs()).toEqual([]);
  });

  test("disabled automatic setting leaves manual Stage 15 LaTeX acquisition available", async () => {
    autoFlag = false;
    await postWorks({ mode: "identifier", value: "arXiv:2609.17036" });
    expect(autoPdfJobs()).toEqual([]);
    const manual = await attach("?id=arxiv:2609.17036");
    const job = ((await manual.json()) as { job: Job }).job;
    expect((await runner.waitFor(job.id)).status).toBe("done");
    expect(loadWork("arxiv:2609.17036")?.doc_ids).toEqual(["arxiv-2609.17036"]);
  });

  test("exists re-add queues only while no PDF is registered", async () => {
    autoFlag = false;
    await postWorks({ mode: "identifier", value: "arXiv:2609.17036" });
    autoFlag = true;
    await postWorks({ mode: "identifier", value: "arXiv:2609.17036" });
    const job = autoPdfJobs()[0];
    expect(job).toBeDefined();
    expect((await runner.waitFor(job?.id ?? "")).status).toBe("done");
    await postWorks({ mode: "identifier", value: "arXiv:2609.17036" });
    expect(autoPdfJobs()).toHaveLength(1);
  });

  test("bibcode mode (Discovery add) auto-fetches when resolution supplies arXiv ID", async () => {
    sources = {
      ads: {
        status: "ok",
        resolve: async () => null,
        exportBibtex: async () =>
          "@article{2020ApJ...876L..6S,\n author={Smith, Jane},\n title={Stub ADS Paper},\n year={2020},\n eprint={2601.00099},\n archivePrefix={arXiv}\n}",
      },
      crossref: { resolve: async () => null },
      oa: { resolve: async () => null },
    };
    await postWorks({ mode: "bibcode", bibcode: "2020ApJ...876L..6S" });
    const job = autoPdfJobs()[0];
    expect(job?.payload).toMatchObject({
      workId: "arxiv:2601.00099",
      arxivId: "2601.00099",
      format: "arxiv-pdf",
    });
    expect((await runner.waitFor(job?.id ?? "")).status).toBe("done");
  });
});
