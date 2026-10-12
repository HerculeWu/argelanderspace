/**
 * Work merge and argument graphs over HTTP (ticket 06): the import route reports what happened to the absorbed
 * Work's graph; the left-over file belongs to a Work that is no longer in the library, so GET answers 404 for
 * it and nothing deletes it. Without a graph the response body keeps its old shape. Tmp data dir only.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArgumentGraph, ArgumentGraphMergeNote } from "@argelanderspace/contracts";
import {
  argumentGraphPath,
  emptyWork,
  LibraryStore,
  libraryPaths,
  listArgumentGraphWorkIds,
  replaceArgumentGraph,
} from "@argelanderspace/core";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { collectBroadcasts, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const A = "doi:10.1/a";
const C = "doi:10.1/c";
const BRIDGE = "@article{b1,\n author={Ann},\n title={Gamma},\n year={2001},\n doi={10.1/a}\n}\n";

let dataDir: string;
let app: Hono;

beforeEach(() => {
  dataDir = makeDataDir();
  const paths = libraryPaths(dataDir);
  const store = LibraryStore.load(paths);
  store.works = [
    { ...emptyWork(A), title: "Alpha galaxies", doi: "10.1/a", cite_key: "a2001", year: 2001 },
    { ...emptyWork(C), title: "Gamma", doi: "10.1/c", cite_key: "c2001", year: 2001 },
  ];
  store.save(paths);
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: collectBroadcasts().broadcast,
  });
});

afterEach(() => {
  rmSync(dirname(dataDir), { recursive: true, force: true });
});

function putGraph(workId: string, title: string): ArgumentGraph {
  const out = replaceArgumentGraph(dataDir, {
    version: 1,
    rev: 0,
    work_id: workId,
    arguments: [
      {
        id: "a1",
        title,
        claim: "c",
        grounds: "",
        warrant: "",
        backing: "",
        qualifier: "",
        rebuttal: "",
        warrant_implicit: false,
        kind: "end",
        sources: [],
      },
    ],
    edges: [],
  });
  if (!("saved" in out)) throw new Error("fixture");
  return out.saved;
}
const importBridge = async () => {
  const res = await app.request("/api/library/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "bib", bib: BRIDGE }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    results: { status: string }[];
    argument_graph_merges?: ArgumentGraphMergeNote[];
  };
};
const getGraph = (workId: string) =>
  app.request(`/api/works/${encodeURIComponent(workId)}/argument-graph`);

describe("POST /api/library/works folds Works", () => {
  test("neither has a graph: the body is exactly the old shape", async () => {
    const body = await importBridge();
    expect(Object.keys(body)).toEqual(["results"]);
  });

  test("only the absorbed Work has one: the survivor serves it, the response says so", async () => {
    putGraph(C, "from C");
    const body = await importBridge();
    expect(body.argument_graph_merges).toHaveLength(1);
    expect(body.argument_graph_merges?.[0]).toMatchObject({ outcome: "moved", survivor_id: A });
    const res = await getGraph(A);
    expect(res.status).toBe(200);
    const served = (await res.json()) as ArgumentGraph;
    expect(served.work_id).toBe(A);
    expect(served.arguments[0]?.title).toBe("from C");
  });

  test("both have one: the survivor's is served; the other stays on disk, 404 by id, not an error", async () => {
    putGraph(A, "from A");
    putGraph(C, "from C");
    const leftBytes = readFileSync(argumentGraphPath(dataDir, C), "utf8");
    const body = await importBridge();
    expect(body.argument_graph_merges?.[0]).toMatchObject({
      outcome: "kept_survivor",
      absorbed_file: "argument-graphs/doi%3A10%2E1%2Fc.json", // relative to the data directory
      survivor_file: "argument-graphs/doi%3A10%2E1%2Fa.json",
    });
    expect(((await (await getGraph(A)).json()) as ArgumentGraph).arguments[0]?.title).toBe(
      "from A"
    );
    // the absorbed Work is gone from the library: 404, and the file is neither read nor removed
    expect((await getGraph(C)).status).toBe(404);
    expect(existsSync(argumentGraphPath(dataDir, C))).toBe(true);
    expect(readFileSync(argumentGraphPath(dataDir, C), "utf8")).toBe(leftBytes);
    // the watcher's file listing still sees it (it fingerprints files, not Works); nothing reads its content
    expect(listArgumentGraphWorkIds(dataDir)).toContain(C);
  });
});

describe("what the response may contain", () => {
  test("no absolute path and no raw system message, also when the transfer failed", async () => {
    mkdirSync(join(dataDir, "argument-graphs"), { recursive: true });
    writeFileSync(argumentGraphPath(dataDir, C), "{broken");
    const res = await app.request("/api/library/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bib", bib: BRIDGE }),
    });
    const text = await res.text();
    expect(text).not.toContain(dataDir);
    const body = JSON.parse(text) as { argument_graph_merges: ArgumentGraphMergeNote[] };
    expect(body.argument_graph_merges[0]).toMatchObject({
      outcome: "transfer_failed",
      error: "absorbed_unreadable",
    });
  });

  test("only the survivor's file is read after a move: the moved graph is the user's, byte-complete", async () => {
    const saved = putGraph(C, "from C");
    await importBridge();
    const served = (await (await getGraph(A)).json()) as ArgumentGraph;
    expect(served).toEqual({ ...saved, work_id: A });
    expect(existsSync(argumentGraphPath(dataDir, C))).toBe(false);
  });
});

describe("PUT on a Work that a merge removes while the body is still arriving", () => {
  test("404, nothing written, the survivor and the orphan file are untouched", async () => {
    const before = putGraph(C, "C v1");
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const edited = { ...before, arguments: [{ ...before.arguments[0], title: "C v2 (late)" }] };
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode(JSON.stringify(edited)));
        controller.close();
      },
    });
    const put = app.request(`/api/works/${encodeURIComponent(C)}/argument-graph`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      // node fetch needs duplex for streamed bodies
      duplex: "half",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await importBridge(); // C is merged into A and its graph moved while the PUT body has not arrived
    release();
    const res = await put;
    expect(res.status).toBe(404);
    expect(existsSync(argumentGraphPath(dataDir, C))).toBe(false);
    const survivor = (await (await getGraph(A)).json()) as ArgumentGraph;
    expect(survivor.arguments[0]?.title).toBe("C v1");
  });
});

describe("library.json saved, library.bib failed", () => {
  test("500 with the notes (relative paths) instead of a silent merge; the graph did follow", async () => {
    const paths = libraryPaths(dataDir);
    putGraph(C, "from C");
    rmSync(paths.libraryBib, { force: true });
    mkdirSync(paths.libraryBib, { recursive: true });
    writeFileSync(join(paths.libraryBib, "keep"), "x");
    const res = await app.request("/api/library/works", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "bib", bib: BRIDGE }),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain(dataDir);
    const body = JSON.parse(text) as {
      detail: string;
      argument_graph_merges: ArgumentGraphMergeNote[];
    };
    expect(body.argument_graph_merges[0]).toMatchObject({ outcome: "moved", survivor_id: A });
    expect(body.detail).toContain("argument graph");
    expect(((await (await getGraph(A)).json()) as ArgumentGraph).arguments[0]?.title).toBe(
      "from C"
    );
  });
});
