/**
 * `POST /api/library/upload`: the new async flow (202 + job, stubbed OCR —
 * no MinerU) and the legacy `?sync=1` path kept byte-compatible with app.py.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Job, WsServerMessage } from "@argelanderspace/contracts";
import { libraryPaths, slug } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { JobRunner } from "../src/jobs.js";
import {
  collectBroadcasts,
  KNOWN_WORK_ID,
  makeDataDir,
  stubPipelines,
  stubSources,
} from "./helpers.js";

const PDF = "%PDF-1.4\n% fake bytes for the stub OCR\n";

let dataDir: string;
let app: Hono;
let runner: JobRunner;
let messages: WsServerMessage[];

beforeEach(() => {
  dataDir = makeDataDir();
  runner = new JobRunner({ dir: join(dataDir, "jobs") });
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths: libraryPaths(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner,
    broadcast: collector.broadcast,
  });
});

const upload = (query: string, body: string | Buffer = PDF) =>
  app.request(`/api/library/upload${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf" },
    body,
  });

describe("bad-request matrix (unchanged from app.py)", () => {
  test("400 without id/doi/arxiv", async () => {
    const res = await upload("");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "id, doi, or arxiv query param required" });
  });

  test("400 when the body is not a PDF", async () => {
    for (const body of ["", "not a pdf", "PDF-1.4"]) {
      const res = await upload(`?id=${KNOWN_WORK_ID}`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: "request body is not a PDF" });
    }
  });
});

describe("async flow (new default)", () => {
  test("202 immediately, job runs the OCR, library.changed follows job.done", async () => {
    const res = await upload(`?id=${KNOWN_WORK_ID}`);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    expect(job).toMatchObject({ kind: "upload", status: expect.stringMatching(/queued|running/) });
    expect(job.payload).toMatchObject({ workId: KNOWN_WORK_ID });

    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("done");
    const ref = (done.result as { ref: { id: string } }).ref;
    expect(ref.id).toBe(KNOWN_WORK_ID);

    // the stub OCR produced the reader doc where attachPdf put the PDF
    const docId = `upload-${slug(KNOWN_WORK_ID)}`;
    expect(existsSync(join(dataDir, "output", docId, `${docId}.json`))).toBe(true);
    expect(existsSync(join(dataDir, "output", docId, `${docId}.pdf`))).toBe(true);
    // the doc is listed by /api/papers now
    const papers = (await (await app.request("/api/papers")).json()) as { papers: string[] };
    expect(papers.papers).toContain(docId);
    // spool cleaned up
    const spool = join(dataDir, "jobs", "spool");
    const leftover = existsSync(spool) ? readdirSync(spool).filter((f) => f.endsWith(".pdf")) : [];
    expect(leftover).toHaveLength(0);
    // wire order: job.created → job.done → library.changed(upload)
    const types = messages.map((m) => m.type);
    expect(types[0]).toBe("job.created");
    expect(types.indexOf("job.done")).toBeLessThan(types.lastIndexOf("library.changed"));
    const changed = messages.find((m) => m.type === "library.changed");
    expect(changed).toMatchObject({ cause: "upload" });
  });

  test("an unknown work fails the job with attachPdf's message", async () => {
    const res = await upload("?id=doi:10.0000/ghost");
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("no matching work in the library");
    expect(messages.some((m) => m.type === "job.failed")).toBe(true);
    expect(messages.some((m) => m.type === "library.changed")).toBe(false);
  });

  test("pipeline onProgress accumulates in job.progress (attachPdf + pipeline + MinerU lines)", async () => {
    const pipelines = stubPipelines();
    const baseIngest = pipelines.ingestPdf;
    pipelines.ingestPdf = async (pdfPath, opts) => {
      opts.onProgress?.("MinerU task state: running (elapsed 0s)");
      return baseIngest(pdfPath, opts);
    };
    const collector = collectBroadcasts();
    const app2 = createApp({
      paths: libraryPaths(dataDir),
      makeSources: () => stubSources(),
      pipelines,
      runner,
      broadcast: collector.broadcast,
    });
    const res = await app2.request(`/api/library/upload?id=${KNOWN_WORK_ID}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: PDF,
    });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("done");
    expect(done.progress.map((p) => p.message)).toEqual([
      "Ingesting PDF (MinerU OCR)",
      "MinerU task state: running (elapsed 0s)",
      "Rebuilding library",
    ]);
    // every report was broadcast as its own job.progress event
    const progressed = collector.messages.filter((m) => m.type === "job.progress");
    expect(progressed).toHaveLength(3);
  });

  test("two uploads run strictly serially", async () => {
    const r1 = await upload(`?id=${KNOWN_WORK_ID}`);
    const r2 = await upload(`?id=${KNOWN_WORK_ID}`);
    const j1 = ((await r1.json()) as { job: Job }).job;
    const j2 = ((await r2.json()) as { job: Job }).job;
    const [d1, d2] = await Promise.all([runner.waitFor(j1.id), runner.waitFor(j2.id)]);
    expect(d1.status).toBe("done");
    expect(d2.status).toBe("done");
    expect(d1.startedAt && d2.startedAt && d1.finishedAt && d2.startedAt >= d1.finishedAt).toBe(
      true
    );
  });
});

describe("?sync=1 (app.py's legacy synchronous behavior)", () => {
  test("200 {ref} after the OCR completes", async () => {
    const res = await upload(`?id=${KNOWN_WORK_ID}&sync=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ref: { id: string } };
    expect(body.ref.id).toBe(KNOWN_WORK_ID);
  });

  test("404 with the raw message for an unmatched work", async () => {
    const res = await upload("?id=doi:10.0000/ghost&sync=1");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("no matching work in the library");
  });

  test("500 'ingest failed: …' for pipeline errors", async () => {
    const failing = stubPipelines();
    failing.ingestPdf = async () => {
      throw new Error("MinerU exploded");
    };
    const app2 = createApp({
      paths: libraryPaths(dataDir),
      makeSources: () => stubSources(),
      pipelines: failing,
      runner,
    });
    const res = await app2.request(`/api/library/upload?id=${KNOWN_WORK_ID}&sync=1`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: PDF,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: "ingest failed: MinerU exploded" });
  });
});
