/**
 * Work merges inside background rebuilds (ticket 06): the argument-graph notes ride in the task's result so the page
 * can show them where the task was started (zip upload job and ?sync=1, the arXiv LaTeX fetch), with locations
 * relative to the data directory, and the Copilot's job view carries them. The rebuild is a stand-in that reports a
 * merge; the real merge paths are covered in core and in argument-graph-merge.test.ts.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArgumentGraphMergeNote, RefreshResponse } from "@argelanderspace/contracts";
import { argumentGraphPath, type LibraryPaths, libraryPaths } from "@argelanderspace/core";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createAcquisition } from "../src/acquisition.js";
import { DocMutationRegistry } from "../src/doc-mutations.js";
import { JobRunner } from "../src/jobs.js";
import { jobView } from "../src/library-actions.js";
import { AsyncLock } from "../src/lock.js";
import { stubPipelines, stubSources, UPLOAD_ZIP } from "./helpers.js";

const W = "arxiv:2603.00301";
const GONE = "doi:10.1/gone";

let root: string;
let paths: LibraryPaths;
let runner: JobRunner;
let acquisition: ReturnType<typeof createAcquisition>;
let note: ArgumentGraphMergeNote;
let reportMerge: boolean;
let failAfterMerge: boolean;
let announced: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "acq-argmerge-"));
  paths = libraryPaths(join(root, "data"));
  mkdirSync(paths.libraryDir, { recursive: true });
  mkdirSync(paths.outputDir, { recursive: true });
  writeFileSync(
    paths.libraryJson,
    JSON.stringify({
      version: 1,
      works: [
        {
          id: W,
          title: "Work",
          authors: ["A"],
          year: 2026,
          type: "article",
          arxiv_id: "2603.00301",
          cite_key: "w",
          doc_ids: [],
        },
      ],
    })
  );
  note = {
    outcome: "kept_survivor",
    absorbed_id: GONE,
    survivor_id: W,
    absorbed_file: argumentGraphPath(paths.dataDir, GONE),
    survivor_file: argumentGraphPath(paths.dataDir, W),
  };
  reportMerge = true;
  failAfterMerge = false;
  announced = [];
  runner = new JobRunner({ dir: join(root, "jobs") });
  acquisition = createAcquisition({
    paths,
    runner,
    libraryLock: new AsyncLock(),
    annotationLock: new AsyncLock(),
    docMutations: new DocMutationRegistry(),
    libraryChanged: () => {},
    argumentGraphChanged: (id) => announced.push(id),
    lockedRebuild: async () => {
      if (failAfterMerge)
        throw Object.assign(new Error("graph cache could not be written"), {
          argumentGraphMerges: [note],
        });
      return {
        works: 1,
        ...(reportMerge ? { argument_graph_merges: [note] } : {}),
      } as unknown as RefreshResponse;
    },
    pipelines: stubPipelines(),
    makeSources: () => stubSources(),
    autoIngestArxiv: () => false,
    pdfOwners: () => [],
  });
  runner.onEvent = (type, job) => acquisition.onJobEvent(type, job);
});

afterEach(async () => {
  await Promise.all(
    runner
      .list()
      .filter((j) => j.status === "queued" || j.status === "running")
      .map((j) => runner.waitFor(j.id))
  );
  rmSync(root, { recursive: true, force: true });
});

test("the zip upload job result carries the notes with relative locations", async () => {
  const started = acquisition.startZipJob({ workId: W, doi: null, arxiv: null }, UPLOAD_ZIP);
  if (started.kind !== "queued") throw new Error("not queued");
  const done = await runner.waitFor(started.job.id);
  expect(done.status).toBe("done");
  const merges = (done.result as { argument_graph_merges?: ArgumentGraphMergeNote[] })
    .argument_graph_merges;
  expect(merges).toHaveLength(1);
  expect(merges?.[0]?.absorbed_file).toMatch(/^argument-graphs\/[^/]+\.json$/);
  expect(merges?.[0]?.absorbed_file.startsWith("/")).toBe(false);
  expect(JSON.stringify(done)).not.toContain(root);
});

test("a task whose rebuild merged nothing keeps its result exactly as before", async () => {
  reportMerge = false;
  const started = acquisition.startZipJob({ workId: W, doi: null, arxiv: null }, UPLOAD_ZIP);
  if (started.kind !== "queued") throw new Error("not queued");
  const done = await runner.waitFor(started.job.id);
  expect(Object.keys(done.result as object).sort()).toEqual(["docId", "ref"]);
});

test("?sync=1 answers with the notes next to the ref", async () => {
  const out = await acquisition.attachZipSync({ workId: W, doi: null, arxiv: null }, UPLOAD_ZIP);
  if (out.kind !== "attached") throw new Error(JSON.stringify(out));
  expect(out.argument_graph_merges).toHaveLength(1);
  expect(out.argument_graph_merges[0]?.absorbed_file.startsWith("argument-graphs/")).toBe(true);
});

test("the arXiv LaTeX fetch job result carries the notes, and the Copilot's job view too", async () => {
  const started = acquisition.startSource(W);
  if (started.kind !== "queued") throw new Error(JSON.stringify(started));
  const done = await runner.waitFor(started.job.id);
  expect(done.status).toBe("done");
  const view = jobView(done);
  expect(view.argumentGraphMerges).toHaveLength(1);
  expect(view.argumentGraphMerges?.[0]).toMatchObject({ outcome: "kept_survivor", survivor_id: W });
  expect(JSON.stringify(view)).not.toContain(root);
});

test("a job view of a task without notes has no such key", async () => {
  reportMerge = false;
  const started = acquisition.startSource(W);
  if (started.kind !== "queued") throw new Error(JSON.stringify(started));
  const done = await runner.waitFor(started.job.id);
  expect("argumentGraphMerges" in jobView(done)).toBe(false);
});

test("a zip task whose rebuild failed AFTER the merge keeps the notes in its failed result", async () => {
  failAfterMerge = true;
  const z = acquisition.startZipJob({ workId: W, doi: null, arxiv: null }, UPLOAD_ZIP);
  if (z.kind !== "queued") throw new Error("not queued");
  const zipDone = await runner.waitFor(z.job.id);
  expect(zipDone.status).toBe("failed");
  expect(
    (zipDone.result as { argument_graph_merges?: ArgumentGraphMergeNote[] }).argument_graph_merges
  ).toHaveLength(1);
});

test("the same for the arXiv LaTeX fetch", async () => {
  failAfterMerge = true;
  const a = acquisition.startSource(W);
  if (a.kind !== "queued") throw new Error(JSON.stringify(a));
  const arxivDone = await runner.waitFor(a.job.id);
  expect(arxivDone.status).toBe("failed");
  expect(jobView(arxivDone).argumentGraphMerges).toHaveLength(1);
  expect(JSON.stringify(arxivDone)).not.toContain(root);
});

test("a failed task that merged nothing keeps result null", async () => {
  const failing = acquisition.startZipJob(
    { workId: "doi:10.9/none", doi: null, arxiv: null },
    UPLOAD_ZIP
  );
  if (failing.kind !== "queued") return; // no such work: refused up front
  const done = await runner.waitFor(failing.job.id);
  expect(done.status).toBe("failed");
  expect(done.result).toBeNull();
});

test("a merge that moved a graph is announced for both Works at once; one that did not move is not", async () => {
  note = { ...note, outcome: "moved" };
  const a = acquisition.startSource(W);
  if (a.kind !== "queued") throw new Error(JSON.stringify(a));
  await runner.waitFor(a.job.id);
  expect(announced.sort()).toEqual([GONE, W].sort());
  announced.length = 0;
  note = { ...note, outcome: "kept_survivor" };
  const b = acquisition.startSource(W);
  if (b.kind !== "queued") throw new Error(JSON.stringify(b));
  await runner.waitFor(b.job.id);
  expect(announced).toEqual([]);
});

test("a successful refresh keeps relative locations in the task record, not just in the response", async () => {
  const out = await acquisition.refreshLibrary(false);
  if (out.kind !== "done") throw new Error(JSON.stringify(out));
  const merges = out.summary.argument_graph_merges ?? [];
  expect(merges).toHaveLength(1);
  expect(merges[0]?.absorbed_file).toMatch(/^argument-graphs\/[^/]+\.json$/);
  const refresh = runner.list().find((j) => j.kind === "refresh");
  expect(refresh).toBeDefined();
  expect(JSON.stringify(refresh)).not.toContain(root);
  const dir = join(root, "jobs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) expect(readFileSync(join(dir, f), "utf8")).not.toContain(root);
});

test("?sync=1 whose ingest fails after the merge still reports the notes, relative", async () => {
  failAfterMerge = true;
  const out = await acquisition.attachZipSync({ workId: W, doi: null, arxiv: null }, UPLOAD_ZIP);
  if (out.kind !== "failed") throw new Error(JSON.stringify(out));
  expect(out.argument_graph_merges).toHaveLength(1);
  expect(out.argument_graph_merges?.[0]?.absorbed_file).toMatch(/^argument-graphs\//);
  expect(JSON.stringify(out)).not.toContain(root);
});

test("?sync=1 that failed without any merge carries no such key", async () => {
  const out = await acquisition.attachZipSync(
    { workId: "doi:10.9/none", doi: null, arxiv: null },
    UPLOAD_ZIP
  );
  expect("argument_graph_merges" in out).toBe(false);
});
