/**
 * `POST /api/library/upload` (Stage 3.1 MS2): LaTeX source zip attach — the
 * async flow (202 + job, stubbed ingest — no pandoc), the `?sync=1` legacy
 * path, and the failure probe (a failed job's error is persisted to
 * `<dataDir>/jobs/<id>.json` and replayed via the WS hello snapshot).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Job, WsServerMessage } from "@argelanderspace/contracts";
import { libraryPaths, uploadDocId } from "@argelanderspace/core";
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

/**
 * Build a minimal real zip (stored entries). CRC fields are zeroed —
 * `extractZip` never verifies them. This keeps the upload tests free of any
 * archiving dependency.
 */
function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 10); // method
    central.writeUInt32LE(data.length, 20); // compressed size
    central.writeUInt32LE(data.length, 24); // uncompressed size
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const count = Object.keys(entries).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory
  eocd.writeUInt16LE(count, 8); // entries on this disk
  eocd.writeUInt16LE(count, 10); // entries total
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...locals, cd, eocd]);
}

/** A minimal legal LaTeX project (the success path's payload). */
const ZIP = makeZip({
  "main.tex": [
    "\\documentclass{article}",
    "\\title{Uploaded Paper}",
    "\\begin{document}",
    "\\maketitle",
    "Hello world.",
    "\\end{document}",
    "",
  ].join("\n"),
});

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

const upload = (query: string, body: string | Buffer = ZIP) =>
  app.request(`/api/library/upload${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body,
  });

describe("bad-request matrix", () => {
  test("400 without id/doi/arxiv", async () => {
    const res = await upload("");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "id, doi, or arxiv query param required" });
  });

  test("400 when the body is not a zip (no PK magic)", async () => {
    for (const body of ["", "not a zip", "%PDF-1.4\nfake"]) {
      const res = await upload(`?id=${KNOWN_WORK_ID}`, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: "request body is not a zip" });
    }
  });

  test("400 when a PK header fronts a corrupt zip (trial unpack fails)", async () => {
    const res = await upload(
      `?id=${KNOWN_WORK_ID}`,
      Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(40)])
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ detail: "request body is not a zip" });
  });
});

describe("async flow (new default)", () => {
  test("202 immediately, job ingests+attaches, library.changed follows job.done", async () => {
    const res = await upload(`?id=${KNOWN_WORK_ID}`);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    expect(job).toMatchObject({ kind: "upload", status: expect.stringMatching(/queued|running/) });
    expect(job.payload).toMatchObject({ workId: KNOWN_WORK_ID });

    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("done");
    const ref = (done.result as { ref: { id: string; doc_id?: string } }).ref;
    expect(ref.id).toBe(KNOWN_WORK_ID);

    // the stub ingest produced the reader doc under the idempotent upload id
    const docId = uploadDocId(KNOWN_WORK_ID);
    expect(existsSync(join(dataDir, "output", docId, `${docId}.json`))).toBe(true);
    expect(ref.doc_id).toBe(docId);
    // the doc is listed by /api/papers now
    const papers = (await (await app.request("/api/papers")).json()) as { papers: string[] };
    expect(papers.papers).toContain(docId);
    // spool cleaned up
    const spool = join(dataDir, "jobs", "spool");
    const leftover = existsSync(spool) ? readdirSync(spool).filter((f) => f.endsWith(".zip")) : [];
    expect(leftover).toHaveLength(0);
    // wire order: job.created → job.done → library.changed(upload)
    const types = messages.map((m) => m.type);
    expect(types[0]).toBe("job.created");
    expect(types.indexOf("job.done")).toBeLessThan(types.lastIndexOf("library.changed"));
    const changed = messages.find((m) => m.type === "library.changed");
    expect(changed).toMatchObject({ cause: "upload" });
  });

  test("a re-upload lands on the same doc id (overwrite semantics)", async () => {
    const r1 = await upload(`?id=${KNOWN_WORK_ID}`);
    const j1 = ((await r1.json()) as { job: Job }).job;
    const d1 = await runner.waitFor(j1.id);
    const r2 = await upload(`?id=${KNOWN_WORK_ID}`);
    const j2 = ((await r2.json()) as { job: Job }).job;
    const d2 = await runner.waitFor(j2.id);
    expect(d1.status).toBe("done");
    expect(d2.status).toBe("done");
    const ref1 = (d1.result as { ref: { doc_id?: string } }).ref;
    const ref2 = (d2.result as { ref: { doc_id?: string } }).ref;
    expect(ref1.doc_id).toBe(uploadDocId(KNOWN_WORK_ID));
    expect(ref2.doc_id).toBe(ref1.doc_id);
    // strictly serial, and the doc is still singly attached
    expect(d1.finishedAt && d2.startedAt && d2.startedAt >= d1.finishedAt).toBe(true);
  });

  test("an unknown work fails the job with attach's message (and it persists)", async () => {
    const res = await upload("?id=doi:10.0000/ghost");
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("failed");
    expect(done.error).toContain("no matching work in the library");
    expect(messages.some((m) => m.type === "job.failed")).toBe(true);
    expect(messages.some((m) => m.type === "library.changed")).toBe(false);

    // failure probe (Q7): the error is on disk and in the hello snapshot
    const persisted = JSON.parse(
      readFileSync(join(dataDir, "jobs", `${job.id}.json`), "utf8")
    ) as Job;
    expect(persisted.status).toBe("failed");
    expect(persisted.error).toContain("no matching work in the library");
    const replayed = runner.list().find((j) => j.id === job.id);
    expect(replayed?.status).toBe("failed");
    expect(replayed?.error).toBe(persisted.error);
    // …and a fresh runner on the same dir (server restart) still reports it
    const rebooted = new JobRunner({ dir: join(dataDir, "jobs") });
    expect(rebooted.get(job.id)?.status).toBe("failed");
    expect(rebooted.get(job.id)?.error).toContain("no matching work in the library");
  });

  test("pipeline onProgress accumulates in job.progress (unpack → ingest → rebuild)", async () => {
    const pipelines = stubPipelines();
    const baseIngest = pipelines.ingestLatexZip;
    pipelines.ingestLatexZip = async (zipPath, opts) => {
      opts.onProgress?.("pandoc walk");
      return baseIngest(zipPath, opts);
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
      headers: { "Content-Type": "application/zip" },
      body: ZIP,
    });
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    const done = await runner.waitFor(job.id);
    expect(done.status).toBe("done");
    expect(done.progress.map((p) => p.message)).toEqual([
      "Unpacking LaTeX source zip",
      "pandoc walk",
      "Rebuilding library",
    ]);
    // every report was broadcast as its own job.progress event
    const progressed = collector.messages.filter((m) => m.type === "job.progress");
    expect(progressed).toHaveLength(3);
  });
});

describe("?sync=1 (legacy synchronous behavior)", () => {
  test("200 {ref} after the ingest completes", async () => {
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
    failing.ingestLatexZip = async () => {
      throw new Error("pandoc exploded");
    };
    const app2 = createApp({
      paths: libraryPaths(dataDir),
      makeSources: () => stubSources(),
      pipelines: failing,
      runner,
    });
    const res = await app2.request(`/api/library/upload?id=${KNOWN_WORK_ID}&sync=1`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: ZIP,
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ detail: "ingest failed: pandoc exploded" });
  });
});
