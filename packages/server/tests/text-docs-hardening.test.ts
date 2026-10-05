/** Text Doc hardening (copilot ticket 25, fix round 1): symlinked dataDir, source PDF verification, delete parity, relink. */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocDescription, WsServerMessage } from "@argelanderspace/contracts";
import { LibraryStore, libraryPaths, publishPdfDoc } from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import {
  collectBroadcasts,
  KNOWN_WORK_ID,
  makeDataDir,
  stubPipelines,
  stubSources,
} from "./helpers.js";

let dataDir: string;
let app: Hono;
let messages: WsServerMessage[];
let paths: ReturnType<typeof libraryPaths>;

function build(dir: string) {
  dataDir = dir;
  paths = libraryPaths(dir);
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths,
    statusDir: statusDirFor(dir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dir, "jobs") }),
    broadcast: collector.broadcast,
  });
}
beforeEach(() => build(makeDataDir()));

const call = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const create = (extra: object = {}, operationId = `op-${Math.random().toString(16).slice(2)}-xx`) =>
  call("POST", "/api/library/text-docs", { workId: KNOWN_WORK_ID, operationId, ...extra });
const PDF_ID = "pdf-12345678-1234-4234-8234-123456789abc";
const publishPdf = (docId = PDF_ID, workId = KNOWN_WORK_ID) =>
  publishPdfDoc(paths, {
    docId,
    workId,
    filename: "paper.pdf",
    bytes: Buffer.from("%PDF-1.4 synthetic bytes"),
    pages: [{ width: 612, height: 792, rotation: 0 }],
  });

describe("a symlinked dataDir", () => {
  test("create answers success, and the committed Doc can be described, edited and generated", async () => {
    const real = makeDataDir();
    const link = join(mkdtempSync(join(tmpdir(), "aspace-link-")), "data");
    symlinkSync(real, link);
    build(link);
    const res = await create();
    expect(res.status).toBe(201);
    const docId = ((await res.json()) as { description: DocDescription }).description.doc_id;
    const description = await call("GET", `/api/paper/${docId}/description`);
    expect(description.status).toBe(200);
    const put = await call("PUT", `/api/paper/${docId}/source`, {
      expectedRev: 0,
      markdown: "# T\n\nbody",
    });
    expect(put.status).toBe(200);
    const gen = await call("POST", `/api/paper/${docId}/source/generate`, {
      sourceRev: 1,
      operationId: "gen-link-00001",
    });
    expect(gen.status).toBe(200);
    const read = await call("GET", `/api/paper/${docId}/annotations?coherent=1`);
    expect(read.status).toBe(200);
  });
});

describe("source PDF (file relation, §11.1)", () => {
  test("original bytes are verified, not just the recorded hash", async () => {
    publishPdf();
    writeFileSync(join(dataDir, "output", PDF_ID, "original.pdf"), "%PDF-1.4 tampered");
    const res = await create({ sourcePdfDocId: PDF_ID });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ detail: "document changed" });
    expect(await (await call("GET", "/api/papers")).json()).not.toMatchObject({
      papers: [expect.stringMatching(/^text-/)],
    });
  });

  test("a PDF Doc held by two Works is a data error (500), nothing is created", async () => {
    publishPdf();
    const store = LibraryStore.load(paths);
    const other = store.works.find((w) => w.id !== KNOWN_WORK_ID);
    if (other) other.doc_ids = [...other.doc_ids, PDF_ID];
    store.save(paths);
    const res = await create({ sourcePdfDocId: PDF_ID });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ detail: expect.stringMatching(/ownership/) });
  });

  test("a verified PDF of this Work is recorded with its hash", async () => {
    const pdf = publishPdf();
    const res = await create({ sourcePdfDocId: PDF_ID });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { description: Extract<DocDescription, { format: "text" }> };
    expect(body.description.source_pdf).toEqual({ doc_id: PDF_ID, sha256: pdf.sha256 });
  });
});

describe("create and the library notification", () => {
  test("completing a lost Work link announces library.changed", async () => {
    const operationId = "op-relink-server-1";
    const first = await create({}, operationId);
    const docId = ((await first.json()) as { description: DocDescription }).description.doc_id;
    const store = LibraryStore.load(paths);
    const work = store.get(KNOWN_WORK_ID);
    if (work) work.doc_ids = work.doc_ids.filter((d) => d !== docId);
    store.save(paths);
    messages.length = 0;
    const again = await create({}, operationId);
    expect(again.status).toBe(200);
    expect(messages.some((m) => m.type === "library.changed")).toBe(true);
    expect(LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids).toContain(docId);
    messages.length = 0;
    await create({}, operationId);
    expect(messages.some((m) => m.type === "library.changed")).toBe(false);
  });

  test("a damaged operation record is a clear 500, not a raw syntax error", async () => {
    await create();
    writeFileSync(join(dataDir, "library", "text-doc-operations.json"), "{ not json");
    const res = await create();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/operation record/);
  });
});

describe("delete confirmation parity", () => {
  async function draft(): Promise<string> {
    const res = await create();
    return ((await res.json()) as { description: DocDescription }).description.doc_id;
  }
  test("a never-generated draft with no annotations directory: known zero for the page", async () => {
    const docId = await draft();
    const impact = await (await call("GET", `/api/paper/${docId}/source/delete-impact`)).json();
    expect(impact).toEqual({ generated: false, annotations: { state: "known", count: 0 } });
  });
  test("an existing annotations directory is unknown, never inferred as zero", async () => {
    const docId = await draft();
    mkdirSync(join(dataDir, "annotations", docId), { recursive: true });
    const impact = await (await call("GET", `/api/paper/${docId}/source/delete-impact`)).json();
    expect(impact).toEqual({ generated: false, annotations: { state: "unknown" } });
  });
  test("a generated Doc is counted the ordinary way", async () => {
    const docId = await draft();
    await call("PUT", `/api/paper/${docId}/source`, { expectedRev: 0, markdown: "# T\n\nx" });
    await call("POST", `/api/paper/${docId}/source/generate`, {
      sourceRev: 1,
      operationId: "gen-parity-0001",
    });
    expect(await (await call("GET", `/api/paper/${docId}/source/delete-impact`)).json()).toEqual({
      generated: true,
    });
  });
  test("not a text Doc: 404", async () => {
    expect((await call("GET", "/api/paper/arxiv-2501.17225/source/delete-impact")).status).toBe(
      404
    );
  });
});

describe("refresh keeps a draft that lost its source", () => {
  test("no IR and no source file: the Work link survives the refresh, the Doc is reported and can still be deleted", async () => {
    const res = await create();
    const docId = ((await res.json()) as { description: DocDescription }).description.doc_id;
    rmSync(join(dataDir, "output", docId, "text-source.json"));
    const refreshed = await call("POST", "/api/library/refresh?offline=1");
    expect(refreshed.status).toBe(200);
    expect(
      ((await refreshed.json()) as { damaged_text_docs?: string[] }).damaged_text_docs
    ).toEqual([docId]);
    expect(LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids).toContain(docId);
    // the page can still reach it through the Work and remove it
    expect((await call("DELETE", `/api/paper/${docId}`)).status).toBe(200);
    expect(LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids).not.toContain(docId);
  });
});

describe("refresh reports damaged text Docs", () => {
  test("rebuild keeps their Work link and names them", async () => {
    const docId = await (async () => {
      const res = await create();
      return ((await res.json()) as { description: DocDescription }).description.doc_id;
    })();
    rmSync(join(dataDir, "output", docId, "text-source.json"));
    writeFileSync(join(dataDir, "output", docId, `${docId}.json`), "{ broken");
    const res = await call("POST", "/api/library/refresh?offline=1");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { damaged_text_docs?: string[] }).damaged_text_docs).toEqual([
      docId,
    ]);
    expect(LibraryStore.load(paths).get(KNOWN_WORK_ID)?.doc_ids).toContain(docId);
  });
});
