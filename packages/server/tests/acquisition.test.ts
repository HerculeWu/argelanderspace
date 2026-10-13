/**
 * Library acquisition / upload / manual import as its own module (ticket 46), tested without the app: a real
 * JobRunner (serial, persisted under a temp dir), real AsyncLocks, a real DocMutationRegistry, synthetic library data,
 * stub pipelines/sources and a fake arXiv PDF source. The app's one `runner.onEvent` hook is reproduced as
 * `acquisition.onJobEvent` (docs/contracts.md "本地 PDF Doc", "删除生命周期").
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, RefreshResponse } from "@argelanderspace/contracts";
import {
  arxivDocId,
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  publishPdfDoc,
  uploadDocId,
} from "@argelanderspace/core";
import { createLogger, createMemorySink } from "@argelanderspace/infra";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createAcquisition, createLockedRebuild } from "../src/acquisition.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { AsyncLock } from "../src/lock.js";
import { SERVER_LOG_EVENTS } from "../src/log.js";
import { stubPipelines, stubSources, UPLOAD_ZIP } from "./helpers.js";

const PDF_FIXTURE = new URL("./fixtures/pdf/scanned-no-text.pdf", import.meta.url);
const PAGES = [{ width: 612, height: 792, rotation: 0 }];
const W_ARXIV = "arxiv:2603.00301";
const W_PDF_ONLY = "arxiv:2603.00302";
const W_REFRESH = "arxiv:2603.00303";
const W_SKIP = "arxiv:2603.00304";
const W_PLAIN = "doi:10.1000/plain";

const work = (id: string, docIds: string[]) => ({
  id,
  title: `Work ${id}`,
  authors: ["Author"],
  year: 2026,
  venue: "arXiv",
  type: "article",
  doi: id.startsWith("doi:") ? id.slice(4) : undefined,
  arxiv_id: id.startsWith("arxiv:") ? id.slice(6) : undefined,
  cite_key: id.replace(/[^a-z0-9]/gi, ""),
  doc_ids: docIds,
});

let root: string;
let paths: LibraryPaths;
let runner: JobRunner;
let libraryLock: AsyncLock;
let annotationLock: AsyncLock;
let registry: DocMutationRegistry;
let changes: string[];
let autoIngest: boolean;
let rebuildImpl: () => Promise<RefreshResponse>;
let acquisition: ReturnType<typeof createAcquisition>;
let pipelines: ReturnType<typeof stubPipelines>;

/** What the acquisition wrote to the user-level log. */
const logged = createMemorySink();

function build(overrides: { runner?: JobRunner } = {}) {
  logged.lines.length = 0;
  const jobs = overrides.runner ?? runner;
  acquisition = createAcquisition({
    paths,
    runner: jobs,
    libraryLock,
    annotationLock,
    docMutations: registry,
    libraryChanged: (cause) => changes.push(cause),
    lockedRebuild: () => rebuildImpl(),
    pipelines,
    makeSources: () => stubSources(),
    fetchArxivPdf: async () => readFileSync(PDF_FIXTURE),
    autoIngestArxiv: () => autoIngest,
    pdfOwners: (docId) => LibraryStore.load(paths).works.filter((w) => w.doc_ids.includes(docId)),
    acquisitionWaitMs: 1234,
    log: createLogger({ events: SERVER_LOG_EVENTS, sink: logged }),
  });
  // The app's one hook: acquisition first (the PDF pin release), then the bus and the Copilot.
  jobs.onEvent = (type, job) => acquisition.onJobEvent(type, job);
}

/** Hold the serial runner on a job of its own until `release()`: everything submitted meanwhile stays queued. */
function holdRunner(): { release: () => void; job: Job } {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const job = runner.submit("refresh", async () => {
    await gate;
    return null;
  });
  return { release, job };
}

const settle = async (job: Job) => {
  const done = await runner.waitFor(job.id);
  // The module's own waitFor hooks were registered before ours; let their continuations run.
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

/** Wait for every job still queued or running, and for the module's own waitFor continuations. */
async function drain(): Promise<void> {
  await Promise.all(
    runner
      .list()
      .filter((job) => job.status === "queued" || job.status === "running")
      .map((job) => runner.waitFor(job.id))
  );
  await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "acquisition-module-"));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  mkdirSync(paths.outputDir, { recursive: true });
  writeFileSync(
    paths.libraryJson,
    JSON.stringify({
      version: 1,
      works: [
        work(W_ARXIV, []),
        work(W_PDF_ONLY, []),
        work(W_REFRESH, [arxivDocId("2603.00303")]),
        work(W_SKIP, ["upload-something-abc123"]),
        work(W_PLAIN, []),
      ],
    })
  );
  runner = new JobRunner({ dir: join(root, "jobs") });
  libraryLock = new AsyncLock();
  annotationLock = new AsyncLock();
  registry = new DocMutationRegistry();
  changes = [];
  autoIngest = true;
  rebuildImpl = async () => ({ works: 0 }) as unknown as RefreshResponse;
  pipelines = stubPipelines();
  build();
});

afterEach(async () => {
  vi.restoreAllMocks();
  // No job may keep running into a removed root.
  await drain();
  rmSync(root, { recursive: true, force: true });
});

// ---- the port --------------------------------------------------------------------------------------------- //

test("the port carries the runner as its job table and the configured wait", () => {
  expect(acquisition.jobs).toBe(runner);
  expect(acquisition.waitMs).toBe(1234);
});

// ---- Job reuse and the `reused` snapshot ------------------------------------------------------------------ //

test("startPdf: `reused` comes from the job table BEFORE the submit — a second start reuses the in-flight job", async () => {
  const hold = holdRunner();
  const first = acquisition.startPdf(W_ARXIV);
  const second = acquisition.startPdf(W_ARXIV);
  expect(first).toMatchObject({ kind: "queued", reused: false });
  expect(second).toMatchObject({ kind: "queued", reused: true });
  if (first.kind !== "queued" || second.kind !== "queued") throw new Error("not queued");
  expect(second.job.id).toBe(first.job.id);
  hold.release();
  await drain();
});

test("startSource: the LaTeX fetch reuses its in-flight job by (ingest, workId), with the same snapshot rule", async () => {
  const hold = holdRunner();
  const first = acquisition.startSource(W_ARXIV);
  const second = acquisition.startSource(W_ARXIV);
  expect(first).toMatchObject({ kind: "queued", reused: false });
  expect(second).toMatchObject({ kind: "queued", reused: true });
  if (first.kind !== "queued" || second.kind !== "queued") throw new Error("not queued");
  expect(second.job.id).toBe(first.job.id);
  expect(first.job.payload).toEqual({ workId: W_ARXIV, arxivId: "2603.00301" });
  hold.release();
  await drain();
});

test("a manual PDF acquisition is not swallowed by an automatic one in flight (and vice versa)", async () => {
  const hold = holdRunner();
  const auto = acquisition.submitArxivPdf(W_ARXIV, true);
  const manual = acquisition.startPdf(W_ARXIV);
  expect(auto).not.toBeNull();
  expect(manual).toMatchObject({ kind: "queued", reused: false });
  if (manual.kind !== "queued" || !auto) throw new Error("not queued");
  expect(manual.job.id).not.toBe(auto.id);
  expect(manual.job.payload).toMatchObject({ format: "arxiv-pdf", automatic: false });
  // A second automatic submit reuses the automatic job, not the manual one.
  expect(acquisition.submitArxivPdf(W_ARXIV, true)?.id).toBe(auto.id);
  hold.release();
  await drain();
});

test("startPdf / startSource answer not_found and no_arxiv without queueing", () => {
  expect(acquisition.startPdf("arxiv:9999.99999")).toEqual({ kind: "not_found" });
  expect(acquisition.startPdf(W_PLAIN)).toEqual({ kind: "no_arxiv" });
  expect(acquisition.startSource("arxiv:9999.99999")).toEqual({ kind: "not_found" });
  expect(acquisition.startSource(W_PLAIN)).toEqual({ kind: "no_arxiv" });
  expect(runner.list()).toEqual([]);
});

// ---- describeSource: the five plans --------------------------------------------------------------------- //

test("describeSource: attach, append, refresh, skip and busy", () => {
  publishPdfDoc(paths, {
    workId: W_PDF_ONLY,
    filename: "mine.pdf",
    bytes: readFileSync(PDF_FIXTURE),
    pages: PAGES,
  });
  const pdfDocs = LibraryStore.load(paths).get(W_PDF_ONLY)?.doc_ids ?? [];
  expect(acquisition.describeSource(W_ARXIV)).toEqual({
    kind: "attach",
    docId: "arxiv-2603.00301",
    title: `Work ${W_ARXIV}`,
    docIds: [],
  });
  expect(acquisition.describeSource(W_PDF_ONLY)).toEqual({
    kind: "append",
    docId: "arxiv-2603.00302",
    title: `Work ${W_PDF_ONLY}`,
    docIds: pdfDocs,
  });
  expect(acquisition.describeSource(W_REFRESH)).toMatchObject({
    kind: "refresh",
    docId: "arxiv-2603.00303",
  });
  expect(acquisition.describeSource(W_SKIP)).toEqual({ kind: "skip" });
  expect(registry.tryBeginDelete("arxiv-2603.00301")).toBe(true);
  expect(acquisition.describeSource(W_ARXIV)).toEqual({ kind: "busy" });
  // A busy plan queues nothing.
  expect(acquisition.startSource(W_ARXIV)).toEqual({ kind: "busy" });
  expect(runner.list()).toEqual([]);
});

test("describeSource throws when a PDF Doc's owner is not unique", () => {
  const published = publishPdfDoc(paths, {
    workId: W_PDF_ONLY,
    filename: "mine.pdf",
    bytes: readFileSync(PDF_FIXTURE),
    pages: PAGES,
  });
  const file = JSON.parse(readFileSync(paths.libraryJson, "utf8"));
  file.works.find((w: { id: string }) => w.id === W_PLAIN).doc_ids = [published.doc_id];
  writeFileSync(paths.libraryJson, JSON.stringify(file));
  expect(() => acquisition.describeSource(W_PDF_ONLY)).toThrow(
    "PDF Doc has inconsistent Work ownership"
  );
});

// ---- the zip job ------------------------------------------------------------------------------------------ //

test("startZipJob: a delete in flight answers busy and queues nothing", () => {
  expect(registry.tryBeginDelete(uploadDocId(W_PLAIN))).toBe(true);
  const started = acquisition.startZipJob({ workId: W_PLAIN, doi: null, arxiv: null }, UPLOAD_ZIP);
  expect(started).toEqual({ kind: "busy" });
  expect(runner.list()).toEqual([]);
});

test("startZipJob: pins the upload Doc until the terminal state; done broadcasts upload, failed does not", async () => {
  rebuildImpl = createLockedRebuild(libraryLock).bind(null, paths, { sources: stubSources() });
  const uploadDoc = uploadDocId(W_PLAIN);
  const ok = acquisition.startZipJob({ workId: W_PLAIN, doi: null, arxiv: null }, UPLOAD_ZIP);
  if (ok.kind !== "queued") throw new Error("not queued");
  expect(registry.isBusy(uploadDoc)).toBe(true);
  expect((await settle(ok.job)).status).toBe("done");
  expect(registry.isBusy(uploadDoc)).toBe(false);
  expect(changes).toEqual(["upload"]);

  pipelines.ingestLatexZip = async () => {
    throw new Error("compile failed");
  };
  const bad = acquisition.startZipJob({ workId: W_PLAIN, doi: null, arxiv: null }, UPLOAD_ZIP);
  if (bad.kind !== "queued") throw new Error("not queued");
  expect((await settle(bad.job)).status).toBe("failed");
  expect(registry.isBusy(uploadDoc)).toBe(false);
  expect(changes).toEqual(["upload"]);
});

test("a `skipped` acquisition result is not broadcast: the automatic PDF job finds a PDF that arrived meanwhile", async () => {
  const hold = holdRunner();
  const auto = acquisition.submitArxivPdf(W_ARXIV, true);
  if (!auto) throw new Error("not queued");
  publishPdfDoc(paths, {
    workId: W_ARXIV,
    filename: "mine.pdf",
    bytes: readFileSync(PDF_FIXTURE),
    pages: PAGES,
  });
  hold.release();
  const done = await settle(auto);
  expect(done.status).toBe("done");
  expect(done.result).toMatchObject({ status: "skipped" });
  expect(changes).toEqual([]);
  expect(registry.isBusy((auto.payload as { docId: string }).docId)).toBe(false);
});

// ---- the PDF upload --------------------------------------------------------------------------------------- //

test("startPdfUpload: a matching Doc that appears before the job runs is pinned as a duplicate and released at the end", async () => {
  const bytes = readFileSync(PDF_FIXTURE);
  const pinned: string[] = [];
  const unpinned: string[] = [];
  const pin = registry.pinWriter.bind(registry);
  const unpin = registry.unpinWriter.bind(registry);
  vi.spyOn(registry, "pinWriter").mockImplementation((id) => {
    pinned.push(id);
    pin(id);
  });
  vi.spyOn(registry, "unpinWriter").mockImplementation((id) => {
    unpinned.push(id);
    unpin(id);
  });
  const hold = holdRunner();
  const started = acquisition.startPdfUpload(W_PLAIN, bytes, "paper.pdf");
  if (started.kind !== "queued") throw new Error("not queued");
  const newDoc = (started.job.payload as { docId: string }).docId;
  // The same bytes reach the Work through another path while the upload waits for its turn.
  const existing = publishPdfDoc(paths, {
    workId: W_PLAIN,
    filename: "first.pdf",
    bytes,
    pages: PAGES,
  });
  hold.release();
  const done = await settle(started.job);
  expect(done.status).toBe("done");
  expect(done.result).toMatchObject({ status: "exists", doc: { doc_id: existing.doc_id } });
  expect(pinned).toEqual([newDoc, existing.doc_id]);
  expect(unpinned.sort()).toEqual([newDoc, existing.doc_id].sort());
  expect(registry.isBusy(existing.doc_id)).toBe(false);
  expect(registry.isBusy(newDoc)).toBe(false);
  // `exists` is not a new Doc: no notification.
  expect(changes).toEqual([]);
});

test("startPdfUpload: same-Work identical bytes reuse the Doc; busy and deleting answer busy without a job", () => {
  const bytes = readFileSync(PDF_FIXTURE);
  const existing = publishPdfDoc(paths, {
    workId: W_PLAIN,
    filename: "first.pdf",
    bytes,
    pages: PAGES,
  });
  registry.pinWriter(existing.doc_id);
  expect(acquisition.startPdfUpload(W_PLAIN, bytes, "again.pdf")).toEqual({ kind: "busy" });
  registry.unpinWriter(existing.doc_id);
  expect(runner.list()).toEqual([]);
  const reuse = acquisition.startPdfUpload(W_PLAIN, bytes, "again.pdf");
  if (reuse.kind !== "queued") throw new Error("not queued");
  expect((reuse.job.payload as { docId: string }).docId).toBe(existing.doc_id);
  expect(reuse.resourceWarning).toBe(false);
});

test("startPdfUpload: a spool write failure answers failed, and the job fails and releases the pin", async () => {
  class BrokenSpool extends JobRunner {
    override spoolPath(jobId: string): string {
      return join(root, "no-such-dir", `${jobId}.zip`);
    }
  }
  runner = new BrokenSpool({ dir: join(root, "jobs-broken") });
  build();
  const started = acquisition.startPdfUpload(W_PLAIN, readFileSync(PDF_FIXTURE), "paper.pdf");
  expect(started.kind).toBe("failed");
  if (started.kind !== "failed") throw new Error("unexpected");
  expect(started.detail).toMatch(/ENOENT/);
  const [job] = runner.list();
  if (!job) throw new Error("no job");
  const docId = (job.payload as { docId: string }).docId;
  expect(registry.isBusy(docId)).toBe(true);
  expect((await settle(job)).status).toBe("failed");
  expect(registry.isBusy(docId)).toBe(false);
  expect(changes).toEqual([]);
});

test("startPdfUpload: a submit that throws releases the pin and answers failed", () => {
  vi.spyOn(runner, "submit").mockImplementationOnce(() => {
    throw new Error("disk full");
  });
  const pinned: string[] = [];
  const pin = registry.pinWriter.bind(registry);
  vi.spyOn(registry, "pinWriter").mockImplementation((id) => {
    pinned.push(id);
    pin(id);
  });
  expect(acquisition.startPdfUpload(W_PLAIN, readFileSync(PDF_FIXTURE), "paper.pdf")).toEqual({
    kind: "failed",
    detail: "disk full",
  });
  expect(pinned).toHaveLength(1);
  expect(registry.isBusy(pinned[0] as string)).toBe(false);
});

// ---- the manual import ------------------------------------------------------------------------------------ //

test("importManualWorks: a failing automatic PDF submit is only logged; the Work stays and add is broadcast once", async () => {
  vi.spyOn(runner, "submit").mockImplementation(() => {
    throw new Error("queue unavailable");
  });
  const outcome = await acquisition.importManualWorks({
    mode: "identifier",
    value: "arXiv:2603.00399",
  });
  expect(outcome.results).toMatchObject([{ status: "created" }]);
  expect(LibraryStore.load(paths).get("arxiv:2603.00399")).toBeDefined();
  expect(logged.records()).toMatchObject([
    {
      level: "error",
      event: "arxiv_ingest.auto_submit_failed",
      work: "arxiv:2603.00399",
      error: { name: "Error" },
    },
  ]);
  // The error's own words stay out of the log.
  expect(logged.lines.join("")).not.toContain("queue unavailable");
  expect(changes).toEqual(["add"]);
  expect(registry.isBusy("anything")).toBe(false);
});

test("importManualWorks: bib never queues, and auto_ingest_arxiv=false queues nothing", async () => {
  await acquisition.importManualWorks({
    mode: "bib",
    bib: "@article{k1, title={T}, author={A, B}, year={2026}, eprint={2603.00398}}",
  });
  autoIngest = false;
  await acquisition.importManualWorks({ mode: "identifier", value: "arXiv:2603.00397" });
  expect(runner.list()).toEqual([]);
  autoIngest = true;
  await acquisition.importManualWorks({ mode: "identifier", value: "arXiv:2603.00396" });
  expect(runner.list().map((job) => job.payload)).toMatchObject([
    { workId: "arxiv:2603.00396", format: "arxiv-pdf", automatic: true },
  ]);
});

// ---- the refresh ------------------------------------------------------------------------------------------ //

test("refreshLibrary: the refresh pin is held around the job and released on success, failure and a throwing submit", async () => {
  let busyDuring: boolean | null = null;
  rebuildImpl = async () => {
    busyDuring = registry.isBusy("any-doc");
    return { works: 3 } as unknown as RefreshResponse;
  };
  expect(await acquisition.refreshLibrary(false)).toEqual({
    kind: "done",
    summary: { works: 3 },
  });
  expect(busyDuring).toBe(true);
  expect(registry.isBusy("any-doc")).toBe(false);
  expect(changes).toEqual(["refresh"]);
  expect(runner.list()[0]).toMatchObject({ kind: "refresh", payload: { offline: false } });

  rebuildImpl = async () => {
    throw new Error("graph cache broke");
  };
  expect(await acquisition.refreshLibrary(true)).toEqual({
    kind: "failed",
    detail: "graph cache broke",
  });
  expect(registry.isBusy("any-doc")).toBe(false);
  expect(changes).toEqual(["refresh"]);

  vi.spyOn(runner, "submit").mockImplementationOnce(() => {
    throw new Error("cannot persist");
  });
  await expect(acquisition.refreshLibrary(false)).rejects.toThrow("cannot persist");
  expect(registry.isBusy("any-doc")).toBe(false);
});

// ---- the synchronous zip attach --------------------------------------------------------------------------- //

test("attachZipSync: refuses while the upload Doc is being deleted, and holds it against a delete while attaching", async () => {
  rebuildImpl = createLockedRebuild(libraryLock).bind(null, paths, { sources: stubSources() });
  const uploadDoc = uploadDocId(W_PLAIN);
  const real = pipelines.ingestLatexZip;
  const ingest = vi.spyOn(pipelines, "ingestLatexZip");
  expect(registry.tryBeginDelete(uploadDoc)).toBe(true);
  expect(
    await acquisition.attachZipSync({ workId: W_PLAIN, doi: null, arxiv: null }, UPLOAD_ZIP)
  ).toEqual({ kind: "busy" });
  expect(ingest).not.toHaveBeenCalled();
  registry.endDelete(uploadDoc);

  let deleteDuring: boolean | null = null;
  ingest.mockImplementation(async (zip, opts) => {
    deleteDuring = registry.tryBeginDelete(uploadDoc);
    return real(zip, opts);
  });
  const attached = await acquisition.attachZipSync(
    { workId: W_PLAIN, doi: null, arxiv: null },
    UPLOAD_ZIP
  );
  expect(attached).toMatchObject({ kind: "attached", ref: { id: W_PLAIN } });
  expect(deleteDuring).toBe(false);
  expect(registry.isBusy(uploadDoc)).toBe(false);
  expect(LibraryStore.load(paths).get(W_PLAIN)?.doc_ids[0]).toBe(uploadDoc);
  // The synchronous path broadcasts nothing itself (as before).
  expect(changes).toEqual([]);
});

test("attachZipSync: an unknown Work is no_work with the attach's own message; other failures are failed", async () => {
  const missing = await acquisition.attachZipSync(
    { workId: "doi:10.1000/missing", doi: null, arxiv: null },
    UPLOAD_ZIP
  );
  expect(missing.kind).toBe("no_work");
  if (missing.kind !== "no_work") throw new Error("unexpected");
  expect(missing.message).toMatch(/^no matching work in the library/);

  pipelines.ingestLatexZip = async () => {
    throw new Error("latexmk exploded");
  };
  expect(
    await acquisition.attachZipSync({ workId: W_PLAIN, doi: null, arxiv: null }, UPLOAD_ZIP)
  ).toEqual({ kind: "failed", message: "latexmk exploded" });
  expect(registry.isBusy(uploadDocId(W_PLAIN))).toBe(false);
});
