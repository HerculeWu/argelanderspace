/**
 * `DELETE /api/paper/:doc_id` (Stage 8 MS2, roadmap §8): global physical
 * delete — `output/<doc>/` + `annotations/<doc>/` gone, the doc removed from
 * EVERY work's `doc_ids` (main-doc succession is positional), and a
 * `library.changed` broadcast — plus the delete↔job lifecycle lock
 * (DocMutationRegistry): busy 409 (never wait) while an upload of the doc is
 * queued/running or a refresh is in flight, the reverse 409 (upload refused
 * while a delete of the doc executes), and mid-delete failure leaving
 * library.json untouched. Hermetic: tmp data dirs, Hono `app.request`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "@argelanderspace/contracts";
import {
  type LibraryPaths,
  LibraryStore,
  libraryPaths,
  saveAnnotationsFile,
  uploadDocId,
} from "@argelanderspace/core";
import type { Hono } from "hono";
import { beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import {
  collectBroadcasts,
  KNOWN_WORK_ID,
  makeDataDir,
  stubPipelines,
  stubSources,
  UPLOAD_ZIP,
} from "./helpers.js";

const SECOND_WORK_ID = "doi:10.1051/0004-6361/202453302";

let dataDir: string;
let paths: LibraryPaths;
let app: Hono;
let runner: JobRunner;
let messages: ReturnType<typeof collectBroadcasts>["messages"];

beforeEach(() => {
  dataDir = makeDataDir();
  paths = libraryPaths(dataDir);
  runner = new JobRunner({ dir: join(dataDir, "jobs") });
  const collector = collectBroadcasts();
  messages = collector.messages;
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner,
    broadcast: collector.broadcast,
  });
});

const del = async (path: string, target: Hono = app): Promise<Response> =>
  target.request(path, { method: "DELETE" });
const upload = async (query: string, target: Hono = app): Promise<Response> =>
  target.request(`/api/library/upload${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: UPLOAD_ZIP,
  });

/** Both fixture works reference "demo" (the identity-merge case): as work A's
 *  main doc and as work B's secondary doc. */
function seedLibraryWithDemo(): void {
  const store = LibraryStore.load(paths);
  const a = store.get(KNOWN_WORK_ID);
  if (a) a.doc_ids = ["demo", "2603.03522", "arxiv-2603.03522"];
  const b = store.get(SECOND_WORK_ID);
  if (b) b.doc_ids = ["aa53302-24", "demo"];
  store.save(paths);
}

/** A stale on-disk doc for *docId* (the re-upload overwrite target). */
function staleDocDir(docId: string): void {
  const dir = join(dataDir, "output", docId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${docId}.json`),
    JSON.stringify({
      version: 1,
      docId,
      sections: [],
      refsManifest: [],
      bib: [],
      citationsByBlock: {},
      source: { type: "latex", origin: "/tmp/old", main_tex: "main.tex" },
      meta: { title: "Old version" },
    })
  );
}

/** A controllable gate for stub pipelines / sources: `started` resolves when
 *  the gated call is entered, `release()` lets it through. */
function makeGate() {
  let markStarted: () => void = () => {};
  let release: () => void = () => {};
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  return { started, gate, release, markStarted };
}

/** An app whose zip ingest blocks at the gate (the upload job stays running). */
function gatedApp(g: ReturnType<typeof makeGate>, targetRunner = runner): Hono {
  const pipelines = stubPipelines();
  const base = pipelines.ingestLatexZip;
  pipelines.ingestLatexZip = async (zipPath, opts) => {
    g.markStarted();
    await g.gate;
    return base(zipPath, opts);
  };
  return createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines,
    runner: targetRunner,
  });
}

describe("DELETE /api/paper/:doc_id", () => {
  test("happy path: dirs gone, doc removed from BOTH works, positional main-doc succession, library.changed(patch)", async () => {
    seedLibraryWithDemo();
    saveAnnotationsFile(dataDir, "demo", {
      version: 1,
      rev: 3,
      content_fingerprint: "f".repeat(64),
      annotations: [
        {
          id: "a_0123abcd",
          target: { type: "document" },
          body: "将被一并删除",
          created_at: "2026-09-10T10:00:00.000Z",
          updated_at: "2026-09-10T10:00:00.000Z",
        },
      ],
    });
    mkdirSync(join(dataDir, "annotations", "demo", "archive"), { recursive: true });
    writeFileSync(
      join(dataDir, "annotations", "demo", "archive", "20260901T000000000Z-eeeeeeee.json"),
      "{}"
    );

    const res = await del("/api/paper/demo");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(existsSync(join(dataDir, "output", "demo"))).toBe(false);
    expect(existsSync(join(dataDir, "annotations", "demo"))).toBe(false); // archive included

    const store = LibraryStore.load(paths);
    // demo was doc_ids[0] of A → the next doc succeeds as main; B loses its tail
    expect(store.get(KNOWN_WORK_ID)?.doc_ids).toEqual(["2603.03522", "arxiv-2603.03522"]);
    expect(store.get(SECOND_WORK_ID)?.doc_ids).toEqual(["aa53302-24"]);
    expect(existsSync(paths.libraryBib)).toBe(true); // bib regenerated by the save

    const changed = messages.filter((m) => m.type === "library.changed");
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ type: "library.changed", cause: "patch" });
  });

  test("unknown doc → 404 (FastAPI repr detail); library untouched, no broadcast", async () => {
    const before = readFileSync(paths.libraryJson, "utf8");
    const res = await del("/api/paper/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ detail: "paper 'nope' not found" });
    expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
    expect(messages).toHaveLength(0);
  });

  test("traversal-ish doc id → 400", async () => {
    for (const bad of [".hidden", "a%2Fb", "a%5Cb"]) {
      const res = await del(`/api/paper/${bad}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ detail: "bad doc id" });
    }
  });

  test("busy 409 while the doc's upload job is RUNNING; delete proceeds once it finishes", async () => {
    const docId = uploadDocId(KNOWN_WORK_ID);
    staleDocDir(docId);
    const g = makeGate();
    const app2 = gatedApp(g);
    const res = await upload(`?id=${KNOWN_WORK_ID}`, app2);
    expect(res.status).toBe(202);
    const { job } = (await res.json()) as { job: Job };
    await g.started; // the ingest is mid-flight: the pin was taken at submit
    expect(runner.get(job.id)?.status).toBe("running");

    const busy = await del(`/api/paper/${docId}`, app2);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ detail: "document busy" });
    expect(existsSync(join(dataDir, "output", docId))).toBe(true); // nothing deleted

    g.release();
    expect((await runner.waitFor(job.id)).status).toBe("done");
    const after = await del(`/api/paper/${docId}`, app2);
    expect(after.status).toBe(200);
    expect(existsSync(join(dataDir, "output", docId))).toBe(false);
  });

  test("busy 409 while the doc's upload job is still QUEUED (pin taken at submit)", async () => {
    const docA = uploadDocId(KNOWN_WORK_ID);
    const docB = uploadDocId(SECOND_WORK_ID);
    staleDocDir(docA);
    staleDocDir(docB);
    const g = makeGate();
    const app2 = gatedApp(g);
    const resA = await upload(`?id=${KNOWN_WORK_ID}`, app2);
    const jobA = ((await resA.json()) as { job: Job }).job;
    await g.started; // A holds the serial runner…
    const resB = await upload(`?id=${encodeURIComponent(SECOND_WORK_ID)}`, app2);
    expect(resB.status).toBe(202);
    const jobB = ((await resB.json()) as { job: Job }).job;
    expect(runner.get(jobB.id)?.status).toBe("queued"); // …so B is queued, but already pinned

    expect((await del(`/api/paper/${docB}`, app2)).status).toBe(409);
    expect((await del(`/api/paper/${docA}`, app2)).status).toBe(409);

    g.release();
    expect((await runner.waitFor(jobA.id)).status).toBe("done");
    expect((await runner.waitFor(jobB.id)).status).toBe("done");
  });

  test("busy 409 while ANY refresh job is in flight (its target set is the whole library)", async () => {
    const g = makeGate();
    const sources = stubSources();
    sources.oa = {
      resolve: async () => null,
      fetchMany: async () => {
        g.markStarted();
        await g.gate;
        return new Map();
      },
    };
    const app2 = createApp({
      paths,
      statusDir: statusDirFor(dataDir),
      makeSources: () => sources,
      pipelines: stubPipelines(),
      runner,
    });
    const refreshPromise = app2.request("/api/library/refresh?offline=true", { method: "POST" });
    await g.started; // the rebuild is mid-graph, holding libraryLock

    const res = await del("/api/paper/demo", app2);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ detail: "document busy" });
    expect(existsSync(join(dataDir, "output", "demo"))).toBe(true);

    g.release();
    expect((await refreshPromise).status).toBe(200);
    expect((await del("/api/paper/demo", app2)).status).toBe(200);
  });

  test("a failed upload releases the pin (no stuck busy state)", async () => {
    const docId = uploadDocId(KNOWN_WORK_ID);
    staleDocDir(docId);
    const failing = stubPipelines();
    failing.ingestLatexZip = async () => {
      throw new Error("compile exploded");
    };
    const app2 = createApp({
      paths,
      statusDir: statusDirFor(dataDir),
      makeSources: () => stubSources(),
      pipelines: failing,
      runner,
    });
    const res = await upload(`?id=${KNOWN_WORK_ID}`, app2);
    const { job } = (await res.json()) as { job: Job };
    expect((await runner.waitFor(job.id)).status).toBe("failed");
    expect((await del(`/api/paper/${docId}`, app2)).status).toBe(200);
  });

  // MS2 adversarial review: a pin that survives its route's failure
  // busy-blocks DELETE forever (until restart). Both submission-time leak
  // sites are pinned down here (the handler-failure case is the test above).
  test("upload submit-time spool failure → 500; the orphaned job fails and the writer pin releases", async () => {
    const docId = uploadDocId(KNOWN_WORK_ID);
    staleDocDir(docId);
    // `<dataDir>/jobs/spool` as a regular file: `spoolPath`'s mkdir throws at
    // the route's spool write — AFTER submit succeeded and the terminal hook
    // was registered (the runner's boot cleanup ran in beforeEach, so plant
    // the file here, not in the fixture).
    writeFileSync(join(dataDir, "jobs", "spool"), "not a dir");
    const res = await upload(`?id=${KNOWN_WORK_ID}`);
    expect(res.status).toBe(500);
    // the submitted job never got its payload: it fails on its own…
    const jobs = runner.list();
    expect(jobs).toHaveLength(1);
    expect((await runner.waitFor((jobs[0] as Job).id)).status).toBe("failed");
    // …and the terminal hook released the pin — DELETE is NOT stuck at 409
    expect((await del(`/api/paper/${docId}`)).status).toBe(200);
    expect(existsSync(join(dataDir, "output", docId))).toBe(false);
  });

  test("refresh submit-time failure → 500, and the global refresh pin releases", async () => {
    // `<dataDir>/jobs` as a regular file: `runner.submit`'s persist write
    // throws (ENOTDIR) — file-where-dir-expected instead of chmod, which is a
    // no-op as root.
    rmSync(join(dataDir, "jobs"), { recursive: true });
    writeFileSync(join(dataDir, "jobs"), "not a dir");
    const res = await app.request("/api/library/refresh?offline=true", { method: "POST" });
    expect(res.status).toBe(500);
    expect((await del("/api/paper/demo")).status).toBe(200);
  });

  test("reverse direction: upload is refused 409 while a delete of its doc is in flight", async () => {
    const registry = new DocMutationRegistry();
    const app2 = createApp({
      paths,
      statusDir: statusDirFor(dataDir),
      makeSources: () => stubSources(),
      pipelines: stubPipelines(),
      runner,
      docMutations: registry,
    });
    const docId = uploadDocId(KNOWN_WORK_ID);
    expect(registry.tryBeginDelete(docId)).toBe(true); // an executing DELETE holds the slot

    const asyncRes = await upload(`?id=${KNOWN_WORK_ID}`, app2);
    expect(asyncRes.status).toBe(409);
    expect(await asyncRes.json()).toEqual({ detail: "document busy" });
    const syncRes = await upload(`?id=${KNOWN_WORK_ID}&sync=1`, app2);
    expect(syncRes.status).toBe(409);
    expect(runner.list()).toHaveLength(0); // no job was created for either attempt

    registry.endDelete(docId);
    const ok = await upload(`?id=${KNOWN_WORK_ID}`, app2);
    expect(ok.status).toBe(202);
    const { job } = (await ok.json()) as { job: Job };
    expect((await runner.waitFor(job.id)).status).toBe("done");
  });

  test("mid-delete fs failure → 500; library.json byte-untouched, annotations never reached, pin released", async () => {
    seedLibraryWithDemo();
    saveAnnotationsFile(dataDir, "demo", {
      version: 1,
      rev: 0,
      content_fingerprint: "f".repeat(64),
      annotations: [],
    });
    const libBefore = readFileSync(paths.libraryJson, "utf8");
    // rmSync can unlink demo/assets/logo.png but not nested/deep.png (a
    // non-writable directory) → the physical delete fails halfway through.
    const nested = join(dataDir, "output", "demo", "assets", "nested");
    chmodSync(nested, 0o555);
    try {
      const res = await del("/api/paper/demo");
      expect(res.status).toBe(500);
      expect(((await res.json()) as { detail: string }).detail).toMatch(/^delete failed: /);
      expect(readFileSync(paths.libraryJson, "utf8")).toBe(libBefore); // library step never ran
      expect(existsSync(join(dataDir, "annotations", "demo", "current.json"))).toBe(true);
      expect(messages).toHaveLength(0); // no library.changed on failure
    } finally {
      chmodSync(nested, 0o755);
    }
    // the delete slot was released: the retry succeeds
    expect((await del("/api/paper/demo")).status).toBe(200);
    expect(existsSync(join(dataDir, "output", "demo"))).toBe(false);
  });
});

describe("DocMutationRegistry", () => {
  test("writer pins are counted: busy until the LAST pin releases", () => {
    const r = new DocMutationRegistry();
    r.pinWriter("d");
    r.pinWriter("d");
    expect(r.isBusy("d")).toBe(true);
    expect(r.tryBeginDelete("d")).toBe(false);
    r.unpinWriter("d");
    expect(r.isBusy("d")).toBe(true); // one pin still held
    r.unpinWriter("d");
    expect(r.isBusy("d")).toBe(false);
    expect(r.tryBeginDelete("d")).toBe(true);
  });

  test("a refresh pin busy-blocks every doc", () => {
    const r = new DocMutationRegistry();
    r.pinRefresh();
    expect(r.isBusy("anything")).toBe(true);
    expect(r.tryBeginDelete("anything")).toBe(false);
    r.unpinRefresh();
    expect(r.isBusy("anything")).toBe(false);
    expect(r.tryBeginDelete("anything")).toBe(true);
  });

  test("a claimed delete slot blocks a second delete and marks isDeleting", () => {
    const r = new DocMutationRegistry();
    expect(r.tryBeginDelete("d")).toBe(true);
    expect(r.isDeleting("d")).toBe(true);
    expect(r.tryBeginDelete("d")).toBe(false);
    r.endDelete("d");
    expect(r.isDeleting("d")).toBe(false);
    expect(r.tryBeginDelete("d")).toBe(true);
  });

  test("unpins tolerate imbalance (defensive floors)", () => {
    const r = new DocMutationRegistry();
    r.unpinWriter("ghost");
    r.unpinRefresh();
    expect(r.isBusy("ghost")).toBe(false);
    expect(r.isBusy("d")).toBe(false);
  });
});
