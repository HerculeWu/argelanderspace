/**
 * Work merges inside background rebuilds (ticket 06): the argument-graph notes ride in the task's result so the page
 * can show them where the task was started (zip upload job and ?sync=1, the arXiv LaTeX fetch), with locations
 * relative to the data directory, and the Copilot's job view carries them. The rebuild is a stand-in that reports a
 * merge; the real merge paths are covered in core and in argument-graph-merge.test.ts.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  runner = new JobRunner({ dir: join(root, "jobs") });
  acquisition = createAcquisition({
    paths,
    runner,
    libraryLock: new AsyncLock(),
    annotationLock: new AsyncLock(),
    docMutations: new DocMutationRegistry(),
    libraryChanged: () => {},
    lockedRebuild: async () =>
      ({
        works: 1,
        ...(reportMerge ? { argument_graph_merges: [note] } : {}),
      }) as unknown as RefreshResponse,
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
