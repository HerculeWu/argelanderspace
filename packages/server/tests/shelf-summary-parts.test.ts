/**
 * The argument count and the note preview of a Shelf (文献仓) entry (shelf follow-up 01; contracts「文献仓」;
 * docs/library.md「文献仓」「取入与查询」). The count is not content: `GET /api/shelf`, the summary and the Copilot list
 * give it. The note's opening is for the page only: `GET /api/shelf/entries/:id` gives it; the list and the Copilot
 * `shelf` tool never carry note text. A graph this build cannot read is no error: its count is unknown (null).
 * Everything runs on a throwaway Shelf directory and a throwaway project.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArgumentGraph,
  ShelfEntryResponse,
  ShelfListResponse,
} from "@argelanderspace/contracts";
import { type LibraryPaths, libraryPaths } from "@argelanderspace/core";
import { createShelfStore, type ShelfPutInput, type ShelfStore } from "@argelanderspace/infra";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createApp } from "../src/app.js";
import { createShelfTool, type ShelfOpDeps } from "../src/copilot-shelf-tool.js";
import { statusDirFor } from "../src/deps.js";
import { JobRunner } from "../src/jobs.js";
import { shelfListRows } from "../src/shelf-take.js";
import { collectBroadcasts, stubPipelines, stubSources } from "./helpers.js";

const NOTE = "Hyades tidal tails: compare with Röser 2019; the methods complement each other.";

const argument = (id: string) => ({
  id,
  title: `Argument ${id}`,
  claim: "C",
  grounds: "G",
  warrant: "W",
  backing: "",
  qualifier: "",
  rebuttal: "",
  warrant_implicit: false,
  kind: "normal" as const,
  sources: [],
});

const graph = (n: number): ArgumentGraph => ({
  version: 1,
  rev: 2,
  work_id: "doi:10.1234/parts",
  arguments: Array.from({ length: n }, (_, i) => argument(`a${i + 1}`)),
  edges: [],
});

const enc = (s: string) => Buffer.from(s, "utf8");

function input(doi: string, over: Partial<ShelfPutInput> = {}): ShelfPutInput {
  return {
    bibliography: { title: `Paper ${doi}`, authors: ["Argelander"], year: 2024, doi },
    source: { project: "/elsewhere/project", workId: `doi:${doi}` },
    docs: [],
    argumentGraph: enc(JSON.stringify(graph(3))),
    note: NOTE,
    ...over,
  };
}

let store: ShelfStore;
let shelfDir: string;
beforeEach(() => {
  shelfDir = mkdtempSync(join(tmpdir(), "shelf-parts-"));
  store = createShelfStore({ dir: shelfDir, lockStaleMs: 2000 });
});

async function put(i: ShelfPutInput) {
  const r = await store.put(i, { mode: "new" });
  if (!r.ok) throw new Error(`put failed: ${r.reason}`);
  return r.entry;
}

function project(): LibraryPaths {
  const paths = libraryPaths(join(mkdtempSync(join(tmpdir(), "shelf-parts-p-")), "data"));
  mkdirSync(paths.outputDir, { recursive: true });
  mkdirSync(paths.libraryDir, { recursive: true });
  writeFileSync(
    paths.libraryJson,
    JSON.stringify({ version: 1, project: { name: "S", short: "S", field: "" }, works: [] })
  );
  return paths;
}

function app() {
  const paths = project();
  return createApp({
    paths,
    statusDir: statusDirFor(paths.dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(paths.dataDir, "jobs") }),
    broadcast: collectBroadcasts().broadcast,
    shelf: store,
  });
}

describe("the argument count", () => {
  test("the list and the summary count the carried graph's arguments; no graph is null", async () => {
    const withGraph = await put(input("10.1234/one"));
    const without = await put(input("10.1234/two", { argumentGraph: null, note: null }));
    const a = app();
    const list = (await (await a.request("/api/shelf")).json()) as ShelfListResponse;
    const row = (id: string) => list.entries.find((e) => e.entryId === id);
    expect(row(withGraph.entryId)).toMatchObject({
      status: "ok",
      argumentGraph: true,
      argumentCount: 3,
    });
    expect(row(without.entryId)).toMatchObject({
      status: "ok",
      argumentGraph: false,
      argumentCount: null,
    });
    const summary = (await (
      await a.request(`/api/shelf/entries/${withGraph.entryId}`)
    ).json()) as ShelfEntryResponse;
    expect(summary).toMatchObject({ status: "ok", argumentGraph: true, argumentCount: 3 });
  });

  test("a graph of a later version, one that is not a graph, or one whose file changed has an unknown count, not an error", async () => {
    const later = await put(
      input("10.1234/later", { argumentGraph: enc(JSON.stringify({ ...graph(2), version: 2 })) })
    );
    const notAGraph = await put(
      input("10.1234/notagraph", { argumentGraph: enc('{"version":1,"arguments":"none"}') })
    );
    const changed = await put(input("10.1234/changed"));
    writeFileSync(
      join(shelfDir, "entries", `${changed.entryId}.r1`, "argument-graph.json"),
      JSON.stringify(graph(9))
    );
    const a = app();
    const res = await a.request("/api/shelf");
    expect(res.status).toBe(200);
    const list = (await res.json()) as ShelfListResponse;
    for (const e of [later, notAGraph, changed])
      expect(list.entries.find((r) => r.entryId === e.entryId)).toMatchObject({
        status: "ok",
        argumentGraph: true,
        argumentCount: null,
      });
  });
});

describe("the note preview", () => {
  test("only the summary gives the note's opening; the list never carries note text", async () => {
    const e = await put(input("10.1234/note"));
    const a = app();
    const listText = await (await a.request("/api/shelf")).text();
    expect(listText).not.toContain("Hyades tidal");
    expect(listText).not.toContain("notePreview");
    const summary = (await (
      await a.request(`/api/shelf/entries/${e.entryId}`)
    ).json()) as ShelfEntryResponse;
    expect(summary).toMatchObject({
      status: "ok",
      note: true,
      notePreview: { text: NOTE, truncated: false },
    });
  });

  test("a long note is cut to its first 200 characters (whole characters); no note is null", async () => {
    const long = "论".repeat(150) + "😀".repeat(100);
    const e = await put(input("10.1234/long", { note: long }));
    const none = await put(input("10.1234/none", { note: null }));
    const a = app();
    const summary = (await (await a.request(`/api/shelf/entries/${e.entryId}`)).json()) as Extract<
      ShelfEntryResponse,
      { status: "ok" }
    >;
    expect(summary.notePreview?.truncated).toBe(true);
    expect([...(summary.notePreview?.text ?? "")]).toHaveLength(200);
    expect(summary.notePreview?.text).toBe("论".repeat(150) + "😀".repeat(50));
    const noNote = (await (
      await a.request(`/api/shelf/entries/${none.entryId}`)
    ).json()) as ShelfEntryResponse;
    expect(noNote).toMatchObject({ status: "ok", note: false, notePreview: null });
  });
});

describe("the Copilot list", () => {
  test("gives the argument count and never the note's text", async () => {
    const e = await put(input("10.1234/copilot"));
    const deps: ShelfOpDeps = {
      writer: { add: vi.fn(), preview: vi.fn(), remove: vi.fn() },
      take: { take: vi.fn(), preview: vi.fn() } as never,
      // what app.ts wires: the rows of the route, over the real store
      list: async () => shelfListRows(store, await store.list()),
      work: () => null,
    };
    const tool = createShelfTool({
      admitting: () => true,
      confirm: { request: vi.fn() },
      shelf: deps,
    });
    const out = await (
      tool as unknown as {
        execute(id: string, p: unknown): Promise<{ content: { text: string }[] }>;
      }
    ).execute("call_1", { action: "list" });
    const text = out.content[0]?.text ?? "";
    expect(text).not.toContain("Hyades tidal");
    expect(text).not.toContain("notePreview");
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      entries: [{ entryId: e.entryId, argumentGraph: true, argumentCount: 3, note: true }],
    });
  });
});
