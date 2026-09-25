import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyWork, LibraryStore, libraryPaths, type Work } from "@argelanderspace/core";
import type { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeWebDist, stubPipelines, stubSources } from "./helpers.js";

const roots: string[] = [];
const nodeFs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
function withReadFailure<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const originalRead = nodeFs.readFileSync;
  nodeFs.readFileSync = ((path: Parameters<typeof nodeFs.readFileSync>[0], ...args: unknown[]) => {
    if (String(path) === targetPath) throw new Error("injected read failure");
    return (originalRead as (...items: unknown[]) => unknown)(path, ...args);
  }) as typeof nodeFs.readFileSync;
  syncBuiltinESMExports();
  return run().finally(() => {
    nodeFs.readFileSync = originalRead;
    syncBuiltinESMExports();
  });
}
function withWriteFailure<T>(targetPath: string, run: () => Promise<T>): Promise<T> {
  const originalWrite = nodeFs.writeFileSync;
  nodeFs.writeFileSync = ((
    path: Parameters<typeof nodeFs.writeFileSync>[0],
    ...args: unknown[]
  ) => {
    if (String(path).startsWith(targetPath)) throw new Error("injected write failure");
    return (originalWrite as (...items: unknown[]) => unknown)(path, ...args);
  }) as typeof nodeFs.writeFileSync;
  syncBuiltinESMExports();
  return run().finally(() => {
    nodeFs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
  });
}
function withRenameFailure<T>(
  targetPath: (source: string, target: string) => boolean,
  run: () => Promise<T>
): Promise<T> {
  const originalRename = nodeFs.renameSync;
  nodeFs.renameSync = ((source, target) => {
    if (targetPath(String(source), String(target))) throw new Error("injected rename failure");
    return originalRename(source, target);
  }) as typeof nodeFs.renameSync;
  syncBuiltinESMExports();
  return run().finally(() => {
    nodeFs.renameSync = originalRename;
    syncBuiltinESMExports();
  });
}
function g0PdfFixture(name: string): Buffer {
  return readFileSync(new URL(`./fixtures/pdf/${name}`, import.meta.url));
}
function onePagePdf(label = "Synthetic PDF"): Buffer {
  const content = `BT /F1 12 Tf 50 700 Td (${label}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function twoPagePdf(): Buffer {
  const streams: [string, string] = [
    "BT /F1 12 Tf 50 700 Td (cross page first segment) Tj ET",
    "BT /F1 12 Tf 50 550 Td (cross page continuation) Tj ET",
  ];
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 800 600] /CropBox [20 20 780 580] /Rotate 90 /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>",
    `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}\nendstream`,
    `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function appForNewWork(
  options: {
    workId?: string;
    fetchArxivPdf?: (arxivId: string) => Promise<Buffer>;
    autoIngestArxiv?: () => boolean;
  } = {}
): {
  app: Hono;
  runner: JobRunner;
  dataDir: string;
  workId: string;
  docMutations: DocMutationRegistry;
  messages: ReturnType<typeof collectBroadcasts>["messages"];
} {
  const dataDir = mkdtempSync(join(tmpdir(), "pdf-upload-http-"));
  roots.push(dataDir);
  const workId = options.workId ?? "work:pdf-upload-test";
  const store = new LibraryStore([emptyWork(workId)]);
  store.save(libraryPaths(dataDir));
  const runner = new JobRunner({ dir: join(dataDir, "jobs") });
  const docMutations = new DocMutationRegistry();
  const collector = collectBroadcasts();
  const app = createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    ...(options.fetchArxivPdf ? { fetchArxivPdf: options.fetchArxivPdf } : {}),
    ...(options.autoIngestArxiv
      ? { autoIngestArxiv: options.autoIngestArxiv }
      : { autoIngestArxiv: () => false }),
    runner,
    docMutations,
    broadcast: collector.broadcast,
    webDist: makeWebDist(),
  });
  return { app, runner, dataDir, workId, docMutations, messages: collector.messages };
}

async function acquireArxivPdf(app: Hono, workId: string) {
  return app.request(`/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(workId)}`, {
    method: "POST",
  });
}

function updateWork(dataDir: string, workId: string, update: (work: Work) => void): void {
  const store = LibraryStore.load(libraryPaths(dataDir));
  const work = store.get(workId);
  if (!work) throw new Error(`missing test Work: ${workId}`);
  update(work);
  store.save(libraryPaths(dataDir));
}

async function upload(app: Hono, workId: string, bytes: Buffer) {
  return app.request(`/api/library/upload-pdf?id=${encodeURIComponent(workId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent("paper.pdf") },
    body: bytes,
  });
}

async function awaitJob(runner: JobRunner, response: Response) {
  const accepted = (await response.json()) as { job: { id: string } };
  return runner.waitFor(accepted.job.id);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("local PDF upload lifecycle", () => {
  test("publishes a verified PDF, reopens the same bytes, deduplicates per Work, and deletes its sidecars", async () => {
    const { app, runner, dataDir, workId } = appForNewWork();
    const bytes = onePagePdf();
    const firstResponse = await upload(app, workId, bytes);
    expect(firstResponse.status).toBe(202);
    const first = await awaitJob(runner, firstResponse);
    expect(first.status).toBe("done");
    expect(first.result).toMatchObject({ status: "created" });
    const doc = (first.result as { doc: { doc_id: string; sha256: string } }).doc;
    expect(doc.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));

    const description = await app.request(`/api/paper/${doc.doc_id}/description`);
    expect(description.status).toBe(200);
    expect(await description.json()).toMatchObject({
      format: "pdf",
      doc_id: doc.doc_id,
      display_name: "paper.pdf",
      page_count: 1,
      sha256: doc.sha256,
    });
    const snapshot = await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      annotations: { doc_id: doc.doc_id, content_sha256: doc.sha256, annotations: [] },
    });
    const downloaded = await app.request(`/api/paper/${doc.doc_id}/pdf`);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);

    const firstSidecar = readFileSync(join(dataDir, "output", doc.doc_id, "annotations.json"));
    expect(LibraryStore.load(libraryPaths(dataDir)).get(workId)?.doc_ids[0]).toBe(doc.doc_id);
    const second = await awaitJob(runner, await upload(app, workId, bytes));
    expect(second.status, second.error ?? "").toBe("done");
    expect(second.result).toMatchObject({ status: "exists", doc: { doc_id: doc.doc_id } });
    expect(readFileSync(join(dataDir, "output", doc.doc_id, "annotations.json"))).toEqual(
      firstSidecar
    );
    const secondWorkId = "work:pdf-upload-independent";
    const store = LibraryStore.load(libraryPaths(dataDir));
    store.works.push(emptyWork(secondWorkId));
    store.save(libraryPaths(dataDir));
    const independent = await awaitJob(runner, await upload(app, secondWorkId, bytes));
    expect(independent.status).toBe("done");
    const independentDoc = (independent.result as { doc: { doc_id: string } }).doc;
    expect(independentDoc.doc_id).not.toBe(doc.doc_id);
    const firstPath = join(dataDir, "output", doc.doc_id, "original.pdf");
    const independentPath = join(dataDir, "output", independentDoc.doc_id, "original.pdf");
    expect(statSync(firstPath).ino).not.toBe(statSync(independentPath).ino);

    const docDir = join(dataDir, "output", doc.doc_id);
    const annotationsPath = join(docDir, "annotations.json");
    const emptySidecar = JSON.parse(readFileSync(annotationsPath, "utf8")) as Record<
      string,
      unknown
    >;
    const deleteBody = {
      ...emptySidecar,
      annotations: [
        {
          id: "delete-with-annotation",
          kind: "document_comment",
          body: "Delete with PDF",
          created_at: "2026-09-24T12:00:00.000Z",
          updated_at: "2026-09-24T12:00:00.000Z",
        },
      ],
    };
    expect(
      (
        await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(deleteBody),
        })
      ).status
    ).toBe(200);
    expect(
      await (await app.request(`/api/paper/${doc.doc_id}/pdf/annotations/count`)).json()
    ).toMatchObject({ count: 1 });
    const annotationsBefore = readFileSync(annotationsPath);
    expect(await app.request(`/api/paper/${doc.doc_id}`, { method: "DELETE" })).toHaveProperty(
      "status",
      200
    );
    expect(existsSync(docDir)).toBe(false);
    expect(annotationsBefore.length).toBeGreaterThan(0);
    expect(
      Buffer.from(
        await (await app.request(`/api/paper/${independentDoc.doc_id}/pdf`)).arrayBuffer()
      )
    ).toEqual(bytes);
    const independentDir = join(dataDir, "output", independentDoc.doc_id);
    const protectedAnnotations = readFileSync(join(independentDir, "annotations.json"));
    const protectedProgress = readFileSync(join(independentDir, "reading-position.json"));
    writeFileSync(independentPath, Buffer.from("externally changed"));
    expect((await app.request(`/api/paper/${independentDoc.doc_id}/description`)).status).toBe(200);
    expect((await app.request(`/api/paper/${independentDoc.doc_id}/pdf`)).status).toBe(409);
    expect((await app.request(`/api/paper/${independentDoc.doc_id}/pdf/snapshot`)).status).toBe(
      409
    );
    expect(readFileSync(join(independentDir, "annotations.json"))).toEqual(protectedAnnotations);
    expect(readFileSync(join(independentDir, "reading-position.json"))).toEqual(protectedProgress);
    writeFileSync(independentPath, bytes);
    const corruptedAnnotationsPath = join(independentDir, "annotations.json");
    writeFileSync(corruptedAnnotationsPath, "not-json");
    const corruptedSidecar = readFileSync(corruptedAnnotationsPath);
    expect((await app.request(`/api/paper/${independentDoc.doc_id}/pdf/snapshot`)).status).toBe(
      500
    );
    expect(readFileSync(corruptedAnnotationsPath)).toEqual(corruptedSidecar);
    expect(readFileSync(independentPath)).toEqual(bytes);
    const futureSidecar = Buffer.from(
      JSON.stringify({
        version: 2,
        doc_id: independentDoc.doc_id,
        content_sha256: doc.sha256,
        rev: 0,
        annotations: [],
        future_field: "keep",
      })
    );
    writeFileSync(corruptedAnnotationsPath, futureSidecar);
    expect((await app.request(`/api/paper/${independentDoc.doc_id}/pdf/snapshot`)).status).toBe(
      500
    );
    expect(readFileSync(corruptedAnnotationsPath)).toEqual(futureSidecar);
    rmSync(corruptedAnnotationsPath);
    expect((await app.request(`/api/paper/${independentDoc.doc_id}/pdf/snapshot`)).status).toBe(
      500
    );
    expect(existsSync(corruptedAnnotationsPath)).toBe(false);
    expect(readFileSync(join(independentDir, "reading-position.json"))).toEqual(protectedProgress);
    expect(readFileSync(independentPath)).toEqual(bytes);
  });

  test("rejects unknown Works and oversized requests before queueing work", async () => {
    const { app, runner, workId } = appForNewWork();
    const unknown = await upload(app, "work:missing", onePagePdf());
    expect(unknown.status).toBe(404);
    const tooLarge = await app.request(`/api/library/upload-pdf?id=${encodeURIComponent(workId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(50 * 1024 * 1024 + 1),
      },
      body: Buffer.alloc(0),
    });
    expect(tooLarge.status).toBe(413);
    expect(runner.list()).toHaveLength(0);
  });

  test("returns busy for PDF snapshot and bytes while a known Doc mutation holds the pin", async () => {
    const { app, runner, workId, docMutations } = appForNewWork();
    const bytes = onePagePdf();
    const response = await upload(app, workId, bytes);
    const job = await awaitJob(runner, response);
    const doc = (job.result as { doc: { doc_id: string } }).doc;
    const jobCount = runner.list().length;
    docMutations.pinWriter(doc.doc_id);
    try {
      expect((await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)).status).toBe(409);
      expect((await app.request(`/api/paper/${doc.doc_id}/pdf`)).status).toBe(409);
      expect((await app.request(`/api/paper/${doc.doc_id}`, { method: "DELETE" })).status).toBe(
        409
      );
    } finally {
      docMutations.unpinWriter(doc.doc_id);
    }
    expect(docMutations.tryBeginDelete(doc.doc_id)).toBe(true);
    try {
      expect((await upload(app, workId, bytes)).status).toBe(409);
      expect(runner.list()).toHaveLength(jobCount);
    } finally {
      docMutations.endDelete(doc.doc_id);
    }
    const duplicate = await upload(app, workId, bytes);
    expect(duplicate.status).toBe(202);
    expect((await awaitJob(runner, duplicate)).status).toBe("done");
    expect(docMutations.isBusy(doc.doc_id)).toBe(false);
    expect(
      Buffer.from(await (await app.request(`/api/paper/${doc.doc_id}/pdf`)).arrayBuffer())
    ).toEqual(bytes);
  });

  test("preserves committed PDF bytes and Library state on staging and Library rename failures", async () => {
    const { app, runner, dataDir, workId, docMutations } = appForNewWork();
    const paths = libraryPaths(dataDir);
    const oldBytes = onePagePdf("committed PDF remains");
    const initial = await awaitJob(runner, await upload(app, workId, oldBytes));
    const oldDoc = (initial.result as { doc: { doc_id: string } }).doc;
    const oldDir = join(dataDir, "output", oldDoc.doc_id);
    const oldLibrary = readFileSync(paths.libraryJson);
    const oldBib = readFileSync(paths.libraryBib);
    const oldPdfFile = readFileSync(join(oldDir, "original.pdf"));
    const oldAnnotationFile = readFileSync(join(oldDir, "annotations.json"));
    const oldPositionFile = readFileSync(join(oldDir, "reading-position.json"));
    const stageBytes = onePagePdf("failed before publish");
    const stageJob = await withRenameFailure(
      (source, target) =>
        source.includes(".pdf-stage-") && target.startsWith(join(paths.outputDir, "pdf-")),
      async () => awaitJob(runner, await upload(app, workId, stageBytes))
    );
    const stageDocId = (stageJob.payload as { docId: string }).docId;
    expect(stageJob.status).toBe("failed");
    expect(stageJob.error).toMatch(/injected rename failure/);
    expect(existsSync(join(paths.outputDir, stageDocId))).toBe(false);
    expect(readFileSync(paths.libraryJson)).toEqual(oldLibrary);
    expect(readFileSync(join(oldDir, "original.pdf"))).toEqual(oldPdfFile);
    expect(readFileSync(join(oldDir, "annotations.json"))).toEqual(oldAnnotationFile);
    expect(readFileSync(join(oldDir, "reading-position.json"))).toEqual(oldPositionFile);
    expect(docMutations.isBusy(stageDocId)).toBe(false);

    const libraryBytes = onePagePdf("failed Library association");
    const libraryJob = await withRenameFailure(
      (_source, target) => target === paths.libraryJson,
      async () => awaitJob(runner, await upload(app, workId, libraryBytes))
    );
    const libraryDocId = (libraryJob.payload as { docId: string }).docId;
    expect(libraryJob.status).toBe("failed");
    expect(libraryJob.error).toMatch(/injected rename failure/);
    expect(existsSync(join(paths.outputDir, libraryDocId, "original.pdf"))).toBe(true);
    expect(readFileSync(paths.libraryJson)).toEqual(oldLibrary);
    expect(existsSync(`${paths.libraryJson}.tmp`)).toBe(false);
    expect(readFileSync(paths.libraryBib)).toEqual(oldBib);
    expect(LibraryStore.load(paths).get(workId)?.doc_ids).toEqual([oldDoc.doc_id]);
    const paperList = (await (await app.request("/api/papers")).json()) as { papers: string[] };
    expect(paperList.papers).toEqual([oldDoc.doc_id]);
    expect((await app.request(`/api/paper/${libraryDocId}/description`)).status).toBe(404);
    expect(readFileSync(join(oldDir, "original.pdf"))).toEqual(oldPdfFile);
    expect(readFileSync(join(oldDir, "annotations.json"))).toEqual(oldAnnotationFile);
    expect(readFileSync(join(oldDir, "reading-position.json"))).toEqual(oldPositionFile);
    expect(docMutations.isBusy(libraryDocId)).toBe(false);
  });

  test("rejects unsafe PDF path links without rewriting user sidecars", async () => {
    const { app, runner, dataDir, workId } = appForNewWork();
    const bytes = onePagePdf();
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string } }).doc;
    const docDir = join(dataDir, "output", doc.doc_id);
    const pdfPath = join(docDir, "original.pdf");
    const outsidePath = join(dataDir, "outside.pdf");
    const annotationsPath = join(docDir, "annotations.json");
    const progressPath = join(docDir, "reading-position.json");
    const annotationsBefore = readFileSync(annotationsPath);
    const progressBefore = readFileSync(progressPath);
    const validAnnotations = JSON.parse(annotationsBefore.toString("utf8"));
    writeFileSync(outsidePath, bytes);
    rmSync(pdfPath);
    symlinkSync(outsidePath, pdfPath);
    expect((await app.request(`/api/paper/${doc.doc_id}/pdf`)).status).toBe(500);
    expect(
      (
        await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validAnnotations),
        })
      ).status
    ).toBe(500);
    expect((await app.request("/api/paper/%2e%2e%2ftmp/description")).status).toBe(400);
    expect(readFileSync(annotationsPath)).toEqual(annotationsBefore);
    expect(readFileSync(progressPath)).toEqual(progressBefore);
  });

  test("rejects a PDF with non-unique Work ownership without changing its files", async () => {
    const { app, runner, dataDir, workId } = appForNewWork();
    const bytes = onePagePdf();
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string } }).doc;
    const paths = libraryPaths(dataDir);
    const library = LibraryStore.load(paths);
    const otherWork = emptyWork("work:corrupt-second-owner");
    otherWork.doc_ids = [doc.doc_id];
    library.works.push(otherWork);
    library.saveJson(paths);
    const docDir = join(dataDir, "output", doc.doc_id);
    const protectedBytes = readFileSync(join(docDir, "original.pdf"));
    const protectedAnnotations = readFileSync(join(docDir, "annotations.json"));
    const protectedProgress = readFileSync(join(docDir, "reading-position.json"));
    const validAnnotations = JSON.parse(protectedAnnotations.toString("utf8"));

    expect((await app.request(`/api/paper/${doc.doc_id}/description`)).status).toBe(500);
    expect((await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)).status).toBe(500);
    expect((await app.request(`/api/paper/${doc.doc_id}/pdf`)).status).toBe(500);
    expect(
      (
        await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validAnnotations),
        })
      ).status
    ).toBe(500);
    expect(readFileSync(join(docDir, "original.pdf"))).toEqual(protectedBytes);
    expect(readFileSync(join(docDir, "annotations.json"))).toEqual(protectedAnnotations);
    expect(readFileSync(join(docDir, "reading-position.json"))).toEqual(protectedProgress);
  });

  test("keeps a registered PDF's missing or corrupt metadata a system error without rewriting user files", async () => {
    const { app, runner, dataDir, workId } = appForNewWork();
    const bytes = onePagePdf();
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string } }).doc;
    const docDir = join(dataDir, "output", doc.doc_id);
    const metadataPath = join(docDir, `${doc.doc_id}.json`);
    const originalMetadata = readFileSync(metadataPath);
    const originalPdf = readFileSync(join(docDir, "original.pdf"));
    const originalAnnotations = readFileSync(join(docDir, "annotations.json"));
    const originalProgress = readFileSync(join(docDir, "reading-position.json"));
    const validAnnotations = JSON.parse(originalAnnotations.toString("utf8"));

    rmSync(metadataPath);
    expect((await app.request(`/api/paper/${doc.doc_id}/description`)).status).toBe(500);
    expect((await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)).status).toBe(500);
    expect(
      (
        await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validAnnotations),
        })
      ).status
    ).toBe(500);
    expect(readFileSync(join(docDir, "original.pdf"))).toEqual(originalPdf);
    expect(readFileSync(join(docDir, "annotations.json"))).toEqual(originalAnnotations);
    expect(readFileSync(join(docDir, "reading-position.json"))).toEqual(originalProgress);

    writeFileSync(metadataPath, originalMetadata);
    rmSync(join(docDir, "original.pdf"));
    expect(
      (
        await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validAnnotations),
        })
      ).status
    ).toBe(500);
    expect(readFileSync(join(docDir, "annotations.json"))).toEqual(originalAnnotations);
    expect(readFileSync(join(docDir, "reading-position.json"))).toEqual(originalProgress);
    writeFileSync(join(docDir, "original.pdf"), originalPdf);
    writeFileSync(metadataPath, JSON.stringify({ format: "pdf", version: 99, doc_id: doc.doc_id }));
    expect((await app.request(`/api/paper/${doc.doc_id}/description`)).status).toBe(500);
    expect((await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)).status).toBe(500);
    expect(
      (
        await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(validAnnotations),
        })
      ).status
    ).toBe(500);
    expect(readFileSync(join(docDir, "original.pdf"))).toEqual(originalPdf);
    expect(readFileSync(join(docDir, "annotations.json"))).toEqual(originalAnnotations);
    expect(readFileSync(join(docDir, "reading-position.json"))).toEqual(originalProgress);
    expect((await app.request("/api/paper/pdf-unowned-file/description")).status).toBe(404);
  });

  test("accepts a real no-text scan and rejects empty, encrypted, and truncated PDFs", async () => {
    const { app, runner, dataDir, workId } = appForNewWork();
    const scanned = g0PdfFixture("scanned-no-text.pdf");
    const scanJob = await awaitJob(runner, await upload(app, workId, scanned));
    expect(scanJob.status).toBe("done");
    const scannedDoc = (scanJob.result as { doc: { doc_id: string; page_count: number } }).doc;
    expect(scannedDoc.page_count).toBe(1);
    expect(readFileSync(join(dataDir, "output", scannedDoc.doc_id, "original.pdf"))).toEqual(
      scanned
    );

    const empty = await upload(app, workId, Buffer.alloc(0));
    expect(empty.status).toBe(400);
    for (const [name, expected] of [
      ["password-required.pdf", /password-protected/],
      ["truncated.pdf", /valid, readable PDF/],
    ] as const) {
      const rejected = await awaitJob(runner, await upload(app, workId, g0PdfFixture(name)));
      expect(rejected.status).toBe("failed");
      expect(rejected.error).toMatch(expected);
    }
    expect(LibraryStore.load(libraryPaths(dataDir)).get(workId)?.doc_ids).toEqual([
      scannedDoc.doc_id,
    ]);
  });

  test("same filename with different bytes creates a new immutable Doc", async () => {
    const { app, runner, dataDir, workId } = appForNewWork();
    const original = onePagePdf("same filename original");
    const originalJob = await awaitJob(runner, await upload(app, workId, original));
    const originalDoc = (originalJob.result as { doc: { doc_id: string } }).doc;
    const changed = onePagePdf("same filename different content");
    const changedJob = await awaitJob(runner, await upload(app, workId, changed));
    expect(changedJob.status).toBe("done");
    expect(changedJob.result).toMatchObject({ status: "created" });
    const changedDoc = (changedJob.result as { doc: { doc_id: string } }).doc;
    expect(changedDoc.doc_id).not.toBe(originalDoc.doc_id);
    expect(readFileSync(join(dataDir, "output", originalDoc.doc_id, "original.pdf"))).toEqual(
      original
    );
    expect(readFileSync(join(dataDir, "output", changedDoc.doc_id, "original.pdf"))).toEqual(
      changed
    );
    expect(LibraryStore.load(libraryPaths(dataDir)).get(workId)?.doc_ids[0]).toBe(
      originalDoc.doc_id
    );
  });

  test("keeps PDF body readable while missing, corrupt, future, or mismatched progress gets a separate error", async () => {
    const { app, runner, dataDir, workId } = appForNewWork();
    const bytes = onePagePdf();
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string; sha256: string } }).doc;
    const docDir = join(dataDir, "output", doc.doc_id);
    const positionPath = join(docDir, "reading-position.json");
    const annotationPath = join(docDir, "annotations.json");
    const originalPosition = readFileSync(positionPath);
    const originalAnnotations = readFileSync(annotationPath);

    const checkSeparateProgressFailure = async (raw: Buffer | null) => {
      const response = await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`);
      expect(response.status).toBe(200);
      const snapshot = (await response.json()) as {
        reading_position: { status: string; detail?: string };
      };
      expect(snapshot.reading_position.status).toBe("error");
      expect(snapshot.reading_position.detail).toMatch(/position could not be restored/);
      expect(readFileSync(join(docDir, "original.pdf"))).toEqual(bytes);
      expect(readFileSync(annotationPath)).toEqual(originalAnnotations);
      if (raw) expect(readFileSync(positionPath)).toEqual(raw);
      else expect(existsSync(positionPath)).toBe(false);
    };

    writeFileSync(positionPath, "not-json");
    await checkSeparateProgressFailure(readFileSync(positionPath));
    rmSync(positionPath);
    await checkSeparateProgressFailure(null);
    writeFileSync(
      positionPath,
      JSON.stringify({
        version: 2,
        doc_id: doc.doc_id,
        content_sha256: doc.sha256,
        rev: 0,
        position: null,
      })
    );
    await checkSeparateProgressFailure(readFileSync(positionPath));
    rmSync(positionPath);
    await checkSeparateProgressFailure(null);
    const wrongBinding = JSON.parse(originalPosition.toString("utf8")) as Record<string, unknown>;
    wrongBinding.content_sha256 = "b".repeat(64);
    writeFileSync(positionPath, JSON.stringify(wrongBinding));
    await checkSeparateProgressFailure(readFileSync(positionPath));
  });

  test("reads and saves reading position through an independent optimistic HTTP/WS contract", async () => {
    const { app, runner, dataDir, workId, messages } = appForNewWork();
    const bytes = onePagePdf();
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string; sha256: string } }).doc;
    const dir = join(dataDir, "output", doc.doc_id);
    const annotationsBefore = readFileSync(join(dir, "annotations.json"));
    const getPath = `/api/paper/${doc.doc_id}/pdf/reading-position`;
    const putPath = getPath;
    const first = await app.request(getPath);
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toContain("no-store");
    const initial = (await first.json()) as {
      status: string;
      file: { rev: number; position: unknown };
    };
    expect(initial).toMatchObject({ status: "ready", file: { rev: 0, position: null } });
    const position = { page_index: 0, x: 0.25, y: 0.6 };
    const body = { version: 1, doc_id: doc.doc_id, content_sha256: doc.sha256, rev: 0, position };
    const savedResponse = await app.request(putPath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(savedResponse.status).toBe(200);
    expect(await savedResponse.json()).toMatchObject({ rev: 1, position });
    expect(readFileSync(join(dir, "reading-position.json"), "utf8")).toContain('"y": 0.6');
    const committedPosition = readFileSync(join(dir, "reading-position.json"));
    expect(readFileSync(join(dir, "annotations.json"))).toEqual(annotationsBefore);
    expect(
      messages.filter((message) => message.type === "pdf-reading-position.changed")
    ).toHaveLength(1);
    const stale = await app.request(putPath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { detail?: string }).detail).toBe(
      "reading position rev mismatch"
    );
    expect(readFileSync(join(dir, "reading-position.json"))).toEqual(committedPosition);
    expect(
      messages.filter((message) => message.type === "pdf-reading-position.changed")
    ).toHaveLength(1);
    const invalidPage = await app.request(putPath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, rev: 1, position: { page_index: 1, x: 0.5, y: 0.5 } }),
    });
    expect(invalidPage.status).toBe(400);
    const changedBinding = await app.request(putPath, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, rev: 1, content_sha256: "0".repeat(64) }),
    });
    expect(changedBinding.status).toBe(409);
    expect(readFileSync(join(dir, "reading-position.json"))).toEqual(committedPosition);
  });

  test("serializes concurrent reading-position writes so one expected revision commits", async () => {
    const { app, runner, dataDir, workId, messages } = appForNewWork();
    const job = await awaitJob(runner, await upload(app, workId, onePagePdf()));
    const doc = (job.result as { doc: { doc_id: string; sha256: string } }).doc;
    const path = `/api/paper/${doc.doc_id}/pdf/reading-position`;
    const base = { version: 1, doc_id: doc.doc_id, content_sha256: doc.sha256, rev: 0 };
    const submit = (position: { page_index: number; x: number; y: number }) =>
      app.request(path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...base, position }),
      });
    const responses = await Promise.all([
      submit({ page_index: 0, x: 0.2, y: 0.3 }),
      submit({ page_index: 0, x: 0.8, y: 0.9 }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const stored = JSON.parse(
      readFileSync(join(dataDir, "output", doc.doc_id, "reading-position.json"), "utf8")
    );
    expect(stored.rev).toBe(1);
    expect([0.3, 0.9]).toContain(stored.position.y);
    expect(
      messages.filter((message) => message.type === "pdf-reading-position.changed")
    ).toHaveLength(1);
  });

  test("refuses an unknown Doc and refuses position writes after immutable PDF bytes change", async () => {
    const { app, runner, dataDir, workId, messages } = appForNewWork();
    const job = await awaitJob(runner, await upload(app, workId, onePagePdf()));
    const doc = (job.result as { doc: { doc_id: string; sha256: string } }).doc;
    const unknown = `/api/paper/unknown-pdf/pdf/reading-position`;
    expect((await app.request(unknown)).status).toBe(404);
    const unknownPut = await app.request(unknown, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        doc_id: "unknown-pdf",
        content_sha256: doc.sha256,
        rev: 0,
        position: null,
      }),
    });
    expect(unknownPut.status).toBe(404);
    const dir = join(dataDir, "output", doc.doc_id);
    const path = join(dir, "reading-position.json");
    const oldPosition = readFileSync(path);
    const oldAnnotations = readFileSync(join(dir, "annotations.json"));
    writeFileSync(join(dir, "original.pdf"), Buffer.from("changed PDF bytes"));
    const endpoint = `/api/paper/${doc.doc_id}/pdf/reading-position`;
    expect((await app.request(endpoint)).status).toBe(409);
    const write = await app.request(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        doc_id: doc.doc_id,
        content_sha256: doc.sha256,
        rev: 0,
        position: { page_index: 0, x: 0.5, y: 0.5 },
      }),
    });
    expect(write.status).toBe(409);
    expect(readFileSync(path)).toEqual(oldPosition);
    expect(readFileSync(join(dir, "annotations.json"))).toEqual(oldAnnotations);
    expect(
      messages.filter((message) => message.type === "pdf-reading-position.changed")
    ).toHaveLength(0);
  });

  test("preserves unavailable reading-position sidecars and committed bytes through busy and I/O errors", async () => {
    const { app, runner, dataDir, workId, docMutations, messages } = appForNewWork();
    const bytes = onePagePdf();
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string; sha256: string } }).doc;
    const path = join(dataDir, "output", doc.doc_id, "reading-position.json");
    const endpoint = `/api/paper/${doc.doc_id}/pdf/reading-position`;
    const original = readFileSync(path);
    const body = {
      version: 1,
      doc_id: doc.doc_id,
      content_sha256: doc.sha256,
      rev: 0,
      position: { page_index: 0, x: 0.5, y: 0.5 },
    };
    const deleteLock = docMutations.tryBeginDelete(doc.doc_id);
    expect(deleteLock).toBe(true);
    const busyRead = await app.request(endpoint);
    const busyWrite = await app.request(endpoint, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(busyRead.status).toBe(409);
    expect(busyWrite.status).toBe(409);
    docMutations.endDelete(doc.doc_id);
    await withRenameFailure(
      (_, target) => target === path,
      async () => {
        const failed = await app.request(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(failed.status).toBe(500);
      }
    );
    expect(readFileSync(path)).toEqual(original);
    expect(
      messages.filter((message) => message.type === "pdf-reading-position.changed")
    ).toHaveLength(0);
    await withWriteFailure(path, async () => {
      expect(
        (
          await app.request(endpoint, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status
      ).toBe(500);
    });
    expect(readFileSync(path)).toEqual(original);
    await withReadFailure(path, async () => {
      expect((await app.request(endpoint)).status).toBe(500);
      expect(
        (
          await app.request(endpoint, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          })
        ).status
      ).toBe(500);
    });
    expect(readFileSync(path)).toEqual(original);
    for (const corrupt of [
      Buffer.from("not json"),
      Buffer.from(
        JSON.stringify({
          version: 2,
          doc_id: doc.doc_id,
          content_sha256: doc.sha256,
          rev: 0,
          position: null,
        })
      ),
    ]) {
      writeFileSync(path, corrupt);
      expect((await app.request(endpoint)).status).toBe(500);
      const denied = await app.request(endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(denied.status).toBe(500);
      expect(readFileSync(path)).toEqual(corrupt);
      expect((await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)).status).toBe(200);
    }
    writeFileSync(path, original);
    rmSync(path);
    expect((await app.request(endpoint)).status).toBe(500);
    expect(
      (
        await app.request(endpoint, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
      ).status
    ).toBe(500);
    expect(existsSync(path)).toBe(false);
  });

  test("saves validated rectangle/page/document annotations with content and revision protection", async () => {
    const { app, runner, dataDir, workId, docMutations, messages } = appForNewWork();
    const bytes = onePagePdf();
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string; sha256: string } }).doc;
    const sidecar = join(dataDir, "output", doc.doc_id, "annotations.json");
    const initial = (await (await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)).json()) as {
      annotations: Record<string, unknown>;
    };
    const at = "2026-09-24T12:00:00.000Z";
    const candidate = {
      ...initial.annotations,
      annotations: [
        {
          id: "rect-1",
          kind: "rectangle",
          page_index: 0,
          rectangle: { x: 0.1, y: 0.2, width: 0.3, height: 0.25 },
          style: { color: "#f4c542", opacity: 0.4, line_width: 2 },
          body: "Research note **bold** $x^2$",
          created_at: at,
          updated_at: at,
        },
        {
          id: "page-1",
          kind: "page_comment",
          page_index: 0,
          body: "Page note",
          created_at: at,
          updated_at: at,
        },
        {
          id: "doc-1",
          kind: "document_comment",
          body: "Document note",
          created_at: at,
          updated_at: at,
        },
      ],
    };
    const originalPdf = readFileSync(join(dataDir, "output", doc.doc_id, "original.pdf"));
    const savedResponse = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate),
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()) as {
      rev: number;
      annotations: Array<{ kind: string; body: string }>;
    };
    expect(saved.rev).toBe(1);
    expect(messages.filter((message) => message.type === "annotation.changed")).toHaveLength(1);
    expect(saved.annotations.map(({ kind }) => kind)).toEqual([
      "rectangle",
      "page_comment",
      "document_comment",
    ]);
    expect(saved.annotations[0]?.body).toBe("Research note **bold** $x^2$");
    expect(readFileSync(sidecar).toString()).toContain("Research note **bold** $x^2$");
    expect(readFileSync(join(dataDir, "output", doc.doc_id, "original.pdf"))).toEqual(originalPdf);
    const committedAnnotationBytes = readFileSync(sidecar);
    const noOpSave = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saved),
    });
    expect(noOpSave.status).toBe(200);
    expect(await noOpSave.json()).toMatchObject({ rev: 1 });
    expect(readFileSync(sidecar)).toEqual(committedAnnotationBytes);
    expect(messages.filter((message) => message.type === "annotation.changed")).toHaveLength(1);

    const stale = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate),
    });
    expect(stale.status, await stale.clone().text()).toBe(409);
    expect(await stale.json()).toMatchObject({ detail: "rev mismatch", rev: 1 });
    const beforeBadPage = readFileSync(sidecar);
    const invalid = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...saved, annotations: [{ ...saved.annotations[0], page_index: 1 }] }),
    });
    expect(invalid.status).toBe(400);
    expect(readFileSync(sidecar)).toEqual(beforeBadPage);
    const geometryAndStyle = {
      ...saved,
      annotations: saved.annotations.map((annotation, index) =>
        index === 0
          ? {
              ...annotation,
              rectangle: { x: 0.4, y: 0.3, width: 0.2, height: 0.15 },
              style: { color: "#2266cc", opacity: 0.6, line_width: 3 },
              body: "Moved $x$",
            }
          : annotation
      ),
    };
    const editedResponse = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geometryAndStyle),
    });
    const edited = (await editedResponse.json()) as {
      rev: number;
      annotations: Array<Record<string, unknown>>;
    };
    expect(editedResponse.status).toBe(200);
    expect(edited.rev).toBe(2);
    expect(edited.annotations[0]).toMatchObject({
      id: "rect-1",
      created_at: at,
      rectangle: { x: 0.4, y: 0.3 },
      style: { color: "#2266cc", opacity: 0.6, line_width: 3 },
      body: "Moved $x$",
    });
    expect(edited.annotations[0]?.updated_at).not.toBe(at);
    const latestSidecar = readFileSync(sidecar);

    docMutations.pinWriter(doc.doc_id);
    try {
      const busy = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...edited, rev: 2 }),
      });
      expect(busy.status).toBe(409);
      expect(await busy.json()).toMatchObject({ detail: "document busy" });
    } finally {
      docMutations.unpinWriter(doc.doc_id);
    }
    expect(docMutations.tryBeginDelete(doc.doc_id)).toBe(true);
    try {
      const deleting = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...edited, rev: 2 }),
      });
      expect(deleting.status).toBe(409);
      expect(await deleting.json()).toMatchObject({ detail: "document busy" });
    } finally {
      docMutations.endDelete(doc.doc_id);
    }

    const mismatch = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...edited, rev: 2, content_sha256: "0".repeat(64) }),
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ detail: "document changed" });
    expect(messages.filter((message) => message.type === "annotation.changed")).toHaveLength(2);
    expect(readFileSync(sidecar)).toEqual(latestSidecar);
    expect(readFileSync(join(dataDir, "output", doc.doc_id, "original.pdf"))).toEqual(originalPdf);
  });

  test("persists text-tool targets as one immutable logical record with bounded normalized geometry", async () => {
    const { app, runner, dataDir, workId, messages } = appForNewWork();
    const bytes = onePagePdf("real synthetic text target");
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string } }).doc;
    const originalPdf = readFileSync(join(dataDir, "output", doc.doc_id, "original.pdf"));
    const initial = (await (await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)).json()) as {
      annotations: Record<string, unknown>;
    };
    const at = "2026-09-24T12:00:00.000Z";
    const target = {
      quote: "real synthetic text",
      fragments: [
        {
          page_index: 0,
          rectangles: [
            { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
            { x: 0.1, y: 0.25, width: 0.2, height: 0.04 },
          ],
        },
      ],
    };
    const records = (["highlight", "underline", "strikeout"] as const).map((kind) => ({
      id: `text-${kind}`,
      kind,
      target,
      body: "Default note",
      created_at: at,
      updated_at: at,
      ...(kind === "highlight" ? { future_annotation_field: { retained: true } } : {}),
    }));
    const savedResponse = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...initial.annotations, annotations: records }),
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()) as { rev: number; annotations: typeof records };
    expect(saved.rev).toBe(1);
    expect(saved.annotations).toHaveLength(3);
    expect(saved.annotations.map((item) => item.target)).toEqual([target, target, target]);
    expect(saved.annotations[0]).toMatchObject({ future_annotation_field: { retained: true } });
    const sidecar = join(dataDir, "output", doc.doc_id, "annotations.json");
    const recoloredResponse = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...saved,
        annotations: saved.annotations.map((item, index) =>
          index === 0 ? { ...item, color: "#387bd1" } : item
        ),
      }),
    });
    expect(recoloredResponse.status).toBe(200);
    const recolored = (await recoloredResponse.json()) as {
      rev: number;
      annotations: Array<Record<string, unknown>>;
    };
    expect(recolored.rev).toBe(2);
    expect(recolored.annotations[0]).toMatchObject({
      color: "#387bd1",
      future_annotation_field: { retained: true },
    });
    expect(recolored.annotations[0]?.updated_at).not.toBe(at);
    const committed = readFileSync(sidecar);
    const noOp = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(recolored),
    });
    expect(await noOp.json()).toMatchObject({ rev: 2 });
    expect(readFileSync(sidecar)).toEqual(committed);
    expect(readFileSync(join(dataDir, "output", doc.doc_id, "original.pdf"))).toEqual(originalPdf);
    const invalid = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...recolored,
        rev: 2,
        annotations: [
          {
            ...recolored.annotations[0],
            target: { ...target, fragments: [{ ...target.fragments[0], page_index: 1 }] },
          },
        ],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(readFileSync(sidecar)).toEqual(committed);
    const rebound = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...recolored,
        rev: 2,
        annotations: [
          {
            ...recolored.annotations[0],
            target: { ...target, quote: "same geometry, different words" },
          },
        ],
      }),
    });
    expect(rebound.status).toBe(500);
    expect(readFileSync(sidecar)).toEqual(committed);
    expect(messages.filter((message) => message.type === "annotation.changed")).toHaveLength(2);
  });

  test("stores a multi-page text selection as one sidecar item over heterogeneous rotated pages", async () => {
    const { app, runner, workId, dataDir, messages } = appForNewWork();
    const bytes = twoPagePdf();
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    expect(job.status).toBe("done");
    const doc = (job.result as { doc: { doc_id: string; page_count: number } }).doc;
    expect(doc.page_count).toBe(2);
    const snapshot = (await (
      await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)
    ).json()) as { annotations: Record<string, unknown> };
    const at = "2026-09-24T12:00:00.000Z";
    const logical = {
      id: "one-cross-page-id",
      kind: "underline",
      target: {
        quote: "first segment\ncontinuation",
        fragments: [
          { page_index: 0, rectangles: [{ x: 0.1, y: 0.8, width: 0.4, height: 0.03 }] },
          { page_index: 1, rectangles: [{ x: 0.12, y: 0.05, width: 0.35, height: 0.04 }] },
        ],
      },
      body: "One research note",
      created_at: at,
      updated_at: at,
    };
    const put = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot.annotations, annotations: [logical] }),
    });
    expect(put.status).toBe(200);
    const persisted = (await put.json()) as { annotations: Array<typeof logical> };
    expect(persisted.annotations).toEqual([logical]);
    expect(persisted.annotations[0]?.target.fragments.map((item) => item.page_index)).toEqual([
      0, 1,
    ]);
    const reopened = (await (
      await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)
    ).json()) as { annotations: { annotations: typeof persisted.annotations } };
    expect(reopened.annotations.annotations).toEqual([logical]);
    expect(readFileSync(join(dataDir, "output", doc.doc_id, "original.pdf"))).toEqual(bytes);
    expect(messages.filter((message) => message.type === "annotation.changed")).toHaveLength(1);
  });

  test("leaves corrupt/future sidecar bytes untouched and does not broadcast success", async () => {
    const { app, runner, dataDir, workId } = appForNewWork();
    const job = await awaitJob(runner, await upload(app, workId, onePagePdf()));
    const doc = (job.result as { doc: { doc_id: string } }).doc;
    const sidecar = join(dataDir, "output", doc.doc_id, "annotations.json");
    const snapshot = (await (
      await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)
    ).json()) as { annotations: object };
    const unknownFuture = Buffer.from(
      JSON.stringify({ ...snapshot.annotations, rev: 0, future: { preserved: true } })
    );
    writeFileSync(sidecar, unknownFuture);
    const failure = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot.annotations),
    });
    expect(failure.status).toBe(200);
    expect(((await failure.json()) as { future?: unknown }).future).toEqual({ preserved: true });
    expect((JSON.parse(readFileSync(sidecar, "utf8")) as { future?: unknown }).future).toEqual({
      preserved: true,
    });
    const malformed = Buffer.from("{ malformed");
    writeFileSync(sidecar, malformed);
    expect((await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)).status).toBe(500);
    expect(readFileSync(sidecar)).toEqual(malformed);
    const denied = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot.annotations),
    });
    expect(denied.status).toBe(500);
    expect(readFileSync(sidecar)).toEqual(malformed);
  });

  test("counts the PDF workbench sidecar and protects it on rename/content errors", async () => {
    const { app, runner, dataDir, workId, messages } = appForNewWork();
    const job = await awaitJob(runner, await upload(app, workId, onePagePdf()));
    const doc = (job.result as { doc: { doc_id: string; sha256: string } }).doc;
    const dir = join(dataDir, "output", doc.doc_id);
    const sidecar = join(dir, "annotations.json");
    const original = readFileSync(sidecar);
    expect(
      await (await app.request(`/api/paper/${doc.doc_id}/pdf/annotations/count`)).json()
    ).toMatchObject({ count: 0, content_sha256: doc.sha256 });
    expect((await app.request("/api/paper/pdf-unowned/pdf/annotations/count")).status).toBe(404);
    const snapshot = (await (
      await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)
    ).json()) as { annotations: Record<string, unknown> };
    const at = new Date().toISOString();
    const candidate = {
      ...snapshot.annotations,
      annotations: [
        {
          id: "counted-comment",
          kind: "document_comment",
          body: "Count me",
          created_at: at,
          updated_at: at,
        },
      ],
    };
    const failedWrite = await withRenameFailure(
      (_source, target) => target === sidecar,
      async () =>
        app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(candidate),
        })
    );
    expect(failedWrite.status).toBe(500);
    expect(readFileSync(sidecar)).toEqual(original);
    expect(messages.filter((message) => message.type === "annotation.changed")).toHaveLength(0);

    const saved = await app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(candidate),
    });
    expect(saved.status).toBe(200);
    expect(
      await (await app.request(`/api/paper/${doc.doc_id}/pdf/annotations/count`)).json()
    ).toMatchObject({ count: 1 });
    expect(messages.filter((message) => message.type === "annotation.changed")).toHaveLength(1);

    const currentSidecar = readFileSync(sidecar);
    const progress = readFileSync(join(dir, "reading-position.json"));
    writeFileSync(sidecar, "damaged sidecar");
    expect((await app.request(`/api/paper/${doc.doc_id}/pdf/annotations/count`)).status).toBe(500);
    expect(readFileSync(sidecar)).toEqual(Buffer.from("damaged sidecar"));
    writeFileSync(sidecar, currentSidecar);
    writeFileSync(join(dir, "original.pdf"), Buffer.from("externally changed"));
    expect((await app.request(`/api/paper/${doc.doc_id}/pdf/annotations/count`)).status).toBe(409);
    expect(readFileSync(sidecar)).toEqual(currentSidecar);
    expect(readFileSync(join(dir, "reading-position.json"))).toEqual(progress);
    expect((await app.request(`/api/paper/no-such-pdf/pdf/annotations/count`)).status).toBe(404);
  });

  test("fails closed across PDF content, metadata, missing-sidecar and future-sidecar states", async () => {
    const { app, runner, dataDir, workId, messages } = appForNewWork();
    const bytes = onePagePdf("PDF annotation failure matrix");
    const job = await awaitJob(runner, await upload(app, workId, bytes));
    const doc = (job.result as { doc: { doc_id: string; sha256: string } }).doc;
    const dir = join(dataDir, "output", doc.doc_id);
    const pdfPath = join(dir, "original.pdf");
    const metadataPath = join(dir, `${doc.doc_id}.json`);
    const annotationsPath = join(dir, "annotations.json");
    const progressPath = join(dir, "reading-position.json");
    const snapshot = (await (
      await app.request(`/api/paper/${doc.doc_id}/pdf/snapshot`)
    ).json()) as { annotations: object };
    const update = {
      ...snapshot.annotations,
      annotations: [
        {
          id: "protected-edit",
          kind: "document_comment",
          body: "must not be saved",
          created_at: "2026-09-24T12:00:00.000Z",
          updated_at: "2026-09-24T12:00:00.000Z",
        },
      ],
    };
    const put = () =>
      app.request(`/api/paper/${doc.doc_id}/pdf/annotations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
    const pdfBefore = readFileSync(pdfPath);
    const metadataBefore = readFileSync(metadataPath);
    const annotationsBefore = readFileSync(annotationsPath);
    const progressBefore = readFileSync(progressPath);
    expect((await app.request("/api/paper/pdf-unowned/pdf/annotations/count")).status).toBe(404);

    writeFileSync(pdfPath, Buffer.from("external replacement"));
    expect((await put()).status).toBe(409);
    expect(readFileSync(annotationsPath)).toEqual(annotationsBefore);
    expect(readFileSync(progressPath)).toEqual(progressBefore);
    expect(readFileSync(metadataPath)).toEqual(metadataBefore);
    writeFileSync(pdfPath, pdfBefore);

    writeFileSync(metadataPath, Buffer.from("broken metadata"));
    expect((await put()).status).toBe(500);
    expect(readFileSync(annotationsPath)).toEqual(annotationsBefore);
    expect(readFileSync(progressPath)).toEqual(progressBefore);
    writeFileSync(metadataPath, metadataBefore);

    rmSync(annotationsPath);
    expect((await put()).status).toBe(500);
    expect(existsSync(annotationsPath)).toBe(false);
    writeFileSync(annotationsPath, annotationsBefore);

    const future = Buffer.from(
      JSON.stringify({ ...snapshot.annotations, version: 2, future: { keep: true } })
    );
    writeFileSync(annotationsPath, future);
    expect((await put()).status).toBe(500);
    expect(readFileSync(annotationsPath)).toEqual(future);
    expect(readFileSync(progressPath)).toEqual(progressBefore);
    expect(readFileSync(pdfPath)).toEqual(pdfBefore);
    expect(messages.filter((message) => message.type === "annotation.changed")).toHaveLength(0);
    expect(existsSync(join(dir, "archive"))).toBe(false);
  });

  test("rejects fake PDF bytes without registering a Doc or touching Work associations", async () => {
    const { app, runner, workId, dataDir } = appForNewWork();
    const response = await upload(app, workId, Buffer.from("%PDF fake"));
    const job = await awaitJob(runner, response);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/valid, readable PDF/);
    const work = LibraryStore.load(libraryPaths(dataDir));
    expect(work.get(workId)?.doc_ids).toEqual([]);
  });

  test("manual arXiv reacquisition creates distinct immutable Docs even for identical bytes", async () => {
    let calls = 0;
    const bytes = g0PdfFixture("scanned-no-text.pdf");
    const { app, runner, workId, dataDir, messages } = appForNewWork({
      fetchArxivPdf: async (id) => {
        calls++;
        expect(id).toBe("2601.01234");
        return bytes;
      },
    });
    updateWork(dataDir, workId, (work) => {
      work.arxiv_id = "2601.01234";
    });

    const original = await awaitJob(runner, await upload(app, workId, bytes));
    const oldDoc = (original.result as { doc: { doc_id: string } }).doc.doc_id;
    const oldDir = join(dataDir, "output", oldDoc);
    const oldBytes = readFileSync(join(oldDir, "original.pdf"));
    const oldAnnotations = readFileSync(join(oldDir, "annotations.json"));
    const oldPosition = readFileSync(join(oldDir, "reading-position.json"));

    const firstResponse = await acquireArxivPdf(app, workId);
    expect(firstResponse.status).toBe(202);
    const firstAccepted = (await firstResponse.json()) as { job: { id: string } };
    const first = await runner.waitFor(firstAccepted.job.id);
    expect(first.status, first.error ?? "").toBe("done");
    expect(first.result).toMatchObject({
      status: "created",
      doc: {
        acquired_via: "arxiv_pdf",
        arxiv_id: "2601.01234",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
    });
    const firstDoc = (first.result as { doc: { doc_id: string; acquired_at: string } }).doc;
    expect(Date.parse(firstDoc.acquired_at)).not.toBeNaN();
    expect(firstDoc.doc_id).not.toBe(oldDoc);

    const secondResponse = await acquireArxivPdf(app, workId);
    const secondAccepted = (await secondResponse.json()) as { job: { id: string } };
    expect(secondAccepted.job.id).not.toBe(firstAccepted.job.id);
    const second = await runner.waitFor(secondAccepted.job.id);
    expect(second.status, second.error ?? "").toBe("done");
    const secondDoc = (second.result as { doc: { doc_id: string } }).doc.doc_id;
    expect(secondDoc).not.toBe(firstDoc.doc_id);
    expect(calls).toBe(2);
    expect(LibraryStore.load(libraryPaths(dataDir)).get(workId)?.doc_ids).toEqual([
      oldDoc,
      firstDoc.doc_id,
      secondDoc,
    ]);
    expect(readFileSync(join(oldDir, "original.pdf"))).toEqual(oldBytes);
    expect(readFileSync(join(oldDir, "annotations.json"))).toEqual(oldAnnotations);
    expect(readFileSync(join(oldDir, "reading-position.json"))).toEqual(oldPosition);
    const completion = messages.filter(
      (message) => message.type === "job.done" || message.type === "library.changed"
    );
    expect(completion.at(-2)?.type).toBe("job.done");
    expect(completion.at(-1)).toMatchObject({ type: "library.changed", cause: "upload" });
  });

  test("explicit manual acquisition is not swallowed by an automatic Job already in flight", async () => {
    const workId = "arxiv:2601.01234";
    const bytes = g0PdfFixture("scanned-no-text.pdf");
    let calls = 0;
    let release: () => void = () => {};
    let started: () => void = () => {};
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { app, runner, dataDir } = appForNewWork({
      workId,
      autoIngestArxiv: () => true,
      fetchArxivPdf: async () => {
        calls++;
        if (calls === 1) {
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return bytes;
      },
    });
    updateWork(dataDir, workId, (work) => {
      work.arxiv_id = "2601.01234";
    });
    await app.request("/api/library/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "identifier", value: "arXiv:2601.01234" }),
    });
    await fetching;
    const automatic = runner
      .list()
      .find((job) => (job.payload as { automatic?: unknown } | undefined)?.automatic === true);
    if (!automatic) throw new Error("automatic acquisition Job missing");
    const manualResponse = await acquireArxivPdf(app, workId);
    const manualAccepted = (await manualResponse.json()) as { job: { id: string } };
    expect(manualAccepted.job.id).not.toBe(automatic.id);
    release();
    expect((await runner.waitFor(automatic.id)).status).toBe("done");
    expect((await runner.waitFor(manualAccepted.job.id)).status).toBe("done");
    expect(LibraryStore.load(libraryPaths(dataDir)).get(workId)?.doc_ids).toHaveLength(2);
    expect(calls).toBe(2);
  });

  test("same in-flight arXiv PDF submission shares one Job", async () => {
    const bytes = g0PdfFixture("scanned-no-text.pdf");
    let release: () => void = () => {};
    let started: () => void = () => {};
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { app, runner, workId, dataDir } = appForNewWork({
      fetchArxivPdf: async () => {
        started();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return bytes;
      },
    });
    updateWork(dataDir, workId, (work) => {
      work.arxiv_id = "2601.01234";
    });
    const a = await acquireArxivPdf(app, workId);
    const acceptedA = (await a.json()) as { job: { id: string } };
    await fetching;
    const b = await acquireArxivPdf(app, workId);
    const acceptedB = (await b.json()) as { job: { id: string } };
    expect(acceptedB.job.id).toBe(acceptedA.job.id);
    release();
    expect((await runner.waitFor(acceptedA.job.id)).status).toBe("done");
  });

  test("automatic acquisition still runs for a Work with only a LaTeX Doc", async () => {
    const arxivWorkId = "arxiv:2601.01234";
    const bytes = g0PdfFixture("scanned-no-text.pdf");
    const { app, runner, dataDir } = appForNewWork({
      workId: arxivWorkId,
      fetchArxivPdf: async () => bytes,
      autoIngestArxiv: () => true,
    });
    updateWork(dataDir, arxivWorkId, (work) => {
      work.arxiv_id = "2601.01234";
      work.doc_ids = ["latex-existing"];
    });
    const legacyDir = join(dataDir, "output", "latex-existing");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "latex-existing.json"),
      JSON.stringify({
        version: 1,
        docId: "latex-existing",
        meta: {},
        source: { type: "latex" },
        sections: [],
      })
    );
    const response = await app.request("/api/library/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "identifier", value: "arXiv:2601.01234" }),
    });
    expect(response.status).toBe(200);
    const job = runner
      .list()
      .find(
        (item) =>
          item.kind === "upload" &&
          (item.payload as { format?: unknown } | undefined)?.format === "arxiv-pdf"
      );
    if (!job) throw new Error("automatic PDF Job missing");
    expect((await runner.waitFor(job.id)).status).toBe("done");
    const docs = LibraryStore.load(libraryPaths(dataDir)).get(arxivWorkId)?.doc_ids ?? [];
    expect(docs[0]).toBe("latex-existing");
    expect(docs[1]).toMatch(/^pdf-/);
  });

  test("an existing registered PDF blocks automatic reacquisition while manual remains available", async () => {
    const workId = "arxiv:2601.01234";
    const bytes = g0PdfFixture("scanned-no-text.pdf");
    const { app, runner, dataDir } = appForNewWork({
      workId,
      fetchArxivPdf: async () => bytes,
      autoIngestArxiv: () => true,
    });
    updateWork(dataDir, workId, (work) => {
      work.arxiv_id = "2601.01234";
    });
    const first = await awaitJob(runner, await upload(app, workId, bytes));
    expect(first.status).toBe("done");
    const firstDocId = (first.result as { doc: { doc_id: string } }).doc.doc_id;
    writeFileSync(join(dataDir, "output", firstDocId, `${firstDocId}.json`), "{malformed metadata");
    const response = await app.request("/api/library/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "identifier", value: "arXiv:2601.01234" }),
    });
    expect(response.status).toBe(200);
    expect(
      runner
        .list()
        .filter(
          (item) =>
            item.kind === "upload" &&
            (item.payload as { format?: unknown } | undefined)?.format === "arxiv-pdf"
        )
    ).toHaveLength(0);
    const manual = await acquireArxivPdf(app, workId);
    expect(manual.status).toBe(202);
    const manualJob = await awaitJob(runner, manual);
    expect(manualJob.status).toBe("done");
    expect((manualJob.result as { doc: { doc_id: string } }).doc.doc_id).not.toBe(firstDocId);
  });

  test("atomic publication failure releases its mutation pin and preserves every prior Doc byte", async () => {
    const bytes = g0PdfFixture("scanned-no-text.pdf");
    const { app, runner, workId, dataDir, docMutations } = appForNewWork({
      fetchArxivPdf: async () => bytes,
    });
    updateWork(dataDir, workId, (work) => {
      work.arxiv_id = "2601.01234";
    });
    const uploadJob = await awaitJob(runner, await upload(app, workId, bytes));
    const oldDoc = (uploadJob.result as { doc: { doc_id: string } }).doc.doc_id;
    const oldDir = join(dataDir, "output", oldDoc);
    const originalBefore = readFileSync(join(oldDir, "original.pdf"));
    const annotationsBefore = readFileSync(join(oldDir, "annotations.json"));
    const positionBefore = readFileSync(join(oldDir, "reading-position.json"));
    const result = await withRenameFailure(
      (source, target) => source.includes(".pdf-stage-") && /pdf-[0-9a-f-]+$/.test(target),
      async () => {
        const response = await acquireArxivPdf(app, workId);
        return await awaitJob(runner, response);
      }
    );
    expect(result.status).toBe("failed");
    expect(result.error).toContain("injected rename failure");
    expect(docMutations.isBusy((result.payload as { docId: string }).docId)).toBe(false);
    expect(readFileSync(join(oldDir, "original.pdf"))).toEqual(originalBefore);
    expect(readFileSync(join(oldDir, "annotations.json"))).toEqual(annotationsBefore);
    expect(readFileSync(join(oldDir, "reading-position.json"))).toEqual(positionBefore);
    expect(LibraryStore.load(libraryPaths(dataDir)).get(workId)?.doc_ids).toEqual([oldDoc]);
  });

  test("failed external content never creates a PDF Doc or changes existing Work order", async () => {
    const { app, runner, workId, dataDir } = appForNewWork({
      fetchArxivPdf: async () => Buffer.from("<!doctype html>error"),
    });
    updateWork(dataDir, workId, (work) => {
      work.arxiv_id = "2601.01234";
    });
    const before = [...(LibraryStore.load(libraryPaths(dataDir)).get(workId)?.doc_ids ?? [])];
    const response = await acquireArxivPdf(app, workId);
    const job = await awaitJob(runner, response);
    expect(job.status).toBe("failed");
    expect(job.error).toMatch(/valid, readable PDF/);
    expect(LibraryStore.load(libraryPaths(dataDir)).get(workId)?.doc_ids).toEqual(before);
  });
});
