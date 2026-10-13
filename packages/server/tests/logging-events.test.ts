/**
 * The events the server used to print to its console and now writes to the user-level log (desktop-app ticket 06),
 * each reached the way it is reached in use: a library import over HTTP that folds two Works. What is checked is
 * what the record says about the Works — and that a Work id made from a title is never in it.
 *
 * (An import that succeeds answers the page with its merge notes and logs none, as before the log existed; the
 * record is written when the notes could otherwise be lost: here, an import that fails after the merge was saved.)
 */

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArgumentGraphMergeNote, WsServerMessage } from "@argelanderspace/contracts";
import { emptyWork, LibraryStore, libraryPaths, replaceArgumentGraph } from "@argelanderspace/core";
import { createLogger } from "@argelanderspace/infra";
import type { Hono } from "hono";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createMemorySink } from "../../infra/tests/log-memory-sink.js";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { SERVER_LOG_EVENTS } from "../src/log.js";
import { makeDataDir, stubPipelines, stubSources } from "./helpers.js";

// The survivor is known by its DOI; the absorbed Work has no identifier, so its id is made from its title.
const SURVIVOR = "doi:10.1234/a";
const TITLE = "Zirconium Nebulae Quasiperiodic Wobble";
const ABSORBED = "work:zirconium-nebulae-quasiperiodic-wobble-2001";
const TITLE_WORDS = /zirconium|nebulae|quasiperiodic|wobble/i;
// How a title-made Work id is written: nothing but the id goes into the hash, so every run writes this.
const ABSORBED_IN_LOG = `work:#${createHash("sha256").update(ABSORBED).digest("hex").slice(0, 12)}`;
const BRIDGE = `@article{b1,\n author={Ann},\n title={${TITLE}},\n year={2001},\n doi={10.1234/a}\n}\n`;

let dataDir: string;
let app: Hono;
let failBroadcast: boolean;
const logged = createMemorySink();

beforeEach(() => {
  logged.lines.length = 0;
  failBroadcast = false;
  dataDir = makeDataDir();
  const paths = libraryPaths(dataDir);
  const store = LibraryStore.load(paths);
  store.works = [
    { ...emptyWork(SURVIVOR), title: "Alpha", doi: "10.1234/a", cite_key: "a2001", year: 2001 },
    { ...emptyWork(ABSORBED), title: TITLE, cite_key: "z2001", year: 2001 },
  ];
  store.save(paths);
  app = createApp({
    paths,
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: (message: WsServerMessage) => {
      if (failBroadcast && message.type === "argument-graph.changed") {
        throw new Error(`cannot tell the pages about ${TITLE}`);
      }
    },
    log: createLogger({ events: SERVER_LOG_EVENTS, sink: logged }),
  });
});

afterEach(() => {
  rmSync(dirname(dataDir), { recursive: true, force: true });
});

function putGraph(workId: string): void {
  const out = replaceArgumentGraph(dataDir, {
    version: 1,
    rev: 0,
    work_id: workId,
    arguments: [
      {
        id: "a1",
        title: "an argument",
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
}

async function importBridge(): Promise<{ status: number; notes: ArgumentGraphMergeNote[] }> {
  const res = await app.request("/api/library/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "bib", bib: BRIDGE }),
  });
  const body = (await res.json()) as { argument_graph_merges?: ArgumentGraphMergeNote[] };
  return { status: res.status, notes: body.argument_graph_merges ?? [] };
}

/** Nothing of the title, of the project's location or of a file named after a Work. */
function expectPublishable(): void {
  const text = logged.lines.join("\n");
  expect(text).not.toMatch(TITLE_WORDS);
  expect(text).not.toContain(dataDir);
  expect(text).not.toContain("argument-graphs");
  expect(text).not.toContain(".json");
  for (const record of logged.records()) {
    expect(Object.keys(record).filter((key) => key.endsWith("_file"))).toEqual([]);
  }
}

test("library.argument_graph_merged: the title-made id is a hash, the DOI id is itself, and no file is named", async () => {
  putGraph(SURVIVOR);
  putGraph(ABSORBED);
  // library.json is saved (the merge stands), then library.bib cannot be written: the import fails after the merge.
  const bib = libraryPaths(dataDir).libraryBib;
  rmSync(bib, { force: true });
  mkdirSync(bib);
  const { status, notes } = await importBridge();
  expect(status).toBeGreaterThanOrEqual(500);
  // The page is still told everything (ids and where the left-over file is); the log is not.
  expect(notes).toMatchObject([
    { outcome: "kept_survivor", absorbed_id: ABSORBED, survivor_id: SURVIVOR },
  ]);
  expect(notes[0]?.absorbed_file).toContain("argument-graphs/");

  const merged = logged.records().filter((r) => r.event === "library.argument_graph_merged");
  expect(merged).toEqual([
    {
      t: expect.any(String),
      level: "warn",
      event: "library.argument_graph_merged",
      outcome: "kept_survivor",
      absorbed: ABSORBED_IN_LOG,
      survivor: SURVIVOR,
    },
  ]);
  expectPublishable();
});

test("argument_graph.broadcast_failed: one record per Work, the title-made one under its hash", async () => {
  putGraph(ABSORBED);
  failBroadcast = true;
  const { status, notes } = await importBridge();
  expect(status).toBe(200);
  expect(notes).toMatchObject([{ outcome: "moved", absorbed_id: ABSORBED, survivor_id: SURVIVOR }]);

  const failed = logged.records().filter((r) => r.event === "argument_graph.broadcast_failed");
  expect(failed).toHaveLength(2);
  expect(failed.map((r) => r.work).sort()).toEqual([SURVIVOR, ABSORBED_IN_LOG].sort());
  for (const record of failed) {
    expect(record).toMatchObject({ level: "error", error: { name: "Error" } });
    expect((record.error as { message?: unknown }).message).toBeUndefined();
  }
  expectPublishable();
});
