/**
 * Argument graphs follow a Work merge (ticket 06, ADR 0009): the four graph combinations, the two failure
 * paths (library save fails, graph transfer fails) and every call path that can fold two Works. Temp data
 * dirs only.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArgumentGraph } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { followWorkFolds, resolveFolds } from "../src/argument-graphs/merge.js";
import {
  argumentGraphDir,
  argumentGraphPath,
  loadArgumentGraph,
  replaceArgumentGraph,
} from "../src/argument-graphs/store.js";
import {
  addManualBibcode,
  addManualBibText,
  addManualIdentifier,
} from "../src/library/add-manual.js";
import { addDoiWork, rebuild } from "../src/library/build.js";
import type { MetadataSources } from "../src/library/sources.js";
import { LibraryStore, libraryPaths } from "../src/library/store.js";

const A = "doi:10.1/a"; // survivor
const C = "doi:10.1/c"; // absorbed
const D = "doi:10.1/d";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const nullSources: MetadataSources = {
  ads: { status: "no-token", resolve: async () => null, exportBibtex: async () => null },
  crossref: { resolve: async () => null },
  oa: { resolve: async () => null },
};

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "aspace-argmerge-"));
  dirs.push(dir);
  const paths = libraryPaths(dir);
  mkdirSync(paths.libraryDir, { recursive: true });
  const work = (id: string, title: string, doi: string, key: string) => ({
    id,
    title,
    authors: ["X"],
    year: 2001,
    doi,
    cite_key: key,
  });
  writeFileSync(
    paths.libraryJson,
    JSON.stringify(
      {
        version: 1,
        project: { name: "S", short: "S", field: "" },
        works: [
          work(A, "Alpha galaxies", "10.1/a", "a2001"),
          work(C, "Gamma", "10.1/c", "c2001"),
          work(D, "Delta", "10.1/d", "d2001"),
        ],
      },
      null,
      2
    ),
    "utf8"
  );
  return paths;
}

/** A graph for `workId`, written through the store (rev 1) and edited once more (rev 2). */
function putGraph(dataDir: string, workId: string, title: string): ArgumentGraph {
  const argument = {
    id: "a1",
    title,
    claim: "c",
    grounds: "g",
    warrant: "w",
    backing: "",
    qualifier: "",
    rebuttal: "",
    warrant_implicit: false,
    kind: "end" as const,
    sources: [],
  };
  const first = replaceArgumentGraph(dataDir, {
    version: 1,
    rev: 0,
    work_id: workId,
    arguments: [argument],
    edges: [],
  });
  if (!("saved" in first)) throw new Error("fixture");
  const second = replaceArgumentGraph(dataDir, { ...first.saved, arguments: [argument] });
  if (!("saved" in second)) throw new Error("fixture");
  return second.saved;
}

const read = (path: string) => readFileSync(path, "utf8");
const graphFiles = (dataDir: string) => {
  try {
    return readdirSync(argumentGraphDir(dataDir)).sort();
  } catch {
    return [];
  }
};
const libIds = (paths: ReturnType<typeof libraryPaths>) =>
  (JSON.parse(read(paths.libraryJson)).works as { id: string }[]).map((w) => w.id);

// A record carrying the DOI of A and the title of C bridges the two; A is the survivor.
const BRIDGE = "@article{b1,\n author={Ann},\n title={Gamma},\n year={2001},\n doi={10.1/a}\n}\n";

describe("the four combinations", () => {
  it("neither Work has a graph: nothing happens, no file, no note", async () => {
    const paths = seed();
    const out = await addManualBibText(paths, BRIDGE);
    expect(libIds(paths)).toEqual([A, D]);
    expect(out[0]?.argumentGraphMerges).toBeUndefined();
    expect(graphFiles(paths.dataDir)).toEqual([]);
  });

  it("only the absorbed Work has one: the survivor gets it (work_id rewritten, rev kept), the original stays", async () => {
    const paths = seed();
    const saved = putGraph(paths.dataDir, C, "from C");
    const originalBytes = read(argumentGraphPath(paths.dataDir, C));
    const out = await addManualBibText(paths, BRIDGE);
    expect(libIds(paths)).toEqual([A, D]);
    const note = out[0]?.argumentGraphMerges?.[0];
    expect(note).toMatchObject({
      outcome: "moved",
      absorbed_id: C,
      survivor_id: A,
      absorbed_file: argumentGraphPath(paths.dataDir, C),
      survivor_file: argumentGraphPath(paths.dataDir, A),
    });
    const survivor = loadArgumentGraph(paths.dataDir, A);
    expect(survivor).toEqual({ ...saved, work_id: A });
    expect(survivor.rev).toBe(saved.rev);
    // never touched, never removed
    expect(read(argumentGraphPath(paths.dataDir, C))).toBe(originalBytes);
    expect(graphFiles(paths.dataDir)).toHaveLength(2);
  });

  it("both have one: the survivor's is kept byte for byte, the absorbed one stays on disk and is reported", async () => {
    const paths = seed();
    putGraph(paths.dataDir, A, "from A");
    putGraph(paths.dataDir, C, "from C");
    const aBytes = read(argumentGraphPath(paths.dataDir, A));
    const cBytes = read(argumentGraphPath(paths.dataDir, C));
    const out = await addManualBibText(paths, BRIDGE);
    const note = out[0]?.argumentGraphMerges?.[0];
    expect(note).toMatchObject({
      outcome: "kept_survivor",
      absorbed_id: C,
      survivor_id: A,
      absorbed_file: argumentGraphPath(paths.dataDir, C),
    });
    expect(read(argumentGraphPath(paths.dataDir, A))).toBe(aBytes);
    expect(read(argumentGraphPath(paths.dataDir, C))).toBe(cBytes);
  });

  it("only the survivor has one: nothing to do, it is untouched", async () => {
    const paths = seed();
    putGraph(paths.dataDir, A, "from A");
    const aBytes = read(argumentGraphPath(paths.dataDir, A));
    const out = await addManualBibText(paths, BRIDGE);
    expect(out[0]?.argumentGraphMerges).toBeUndefined();
    expect(read(argumentGraphPath(paths.dataDir, A))).toBe(aBytes);
    expect(graphFiles(paths.dataDir)).toHaveLength(1);
  });

  it("a graph file the survivor's name already holds is never replaced, even an unreadable one", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    mkdirSync(argumentGraphDir(paths.dataDir), { recursive: true });
    writeFileSync(argumentGraphPath(paths.dataDir, A), "{not json", "utf8");
    const out = await addManualBibText(paths, BRIDGE);
    expect(out[0]?.argumentGraphMerges?.[0]?.outcome).toBe("kept_survivor");
    expect(read(argumentGraphPath(paths.dataDir, A))).toBe("{not json");
  });
});

describe("failure paths: the graph is still there", () => {
  it("the library save fails: the merge throws and the graph was not moved", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const libraryBefore = read(paths.libraryJson);
    // the library's scratch file name is taken by a directory: writing it fails
    mkdirSync(`${paths.libraryJson.replace(/\.json$/, ".json.tmp")}`);
    await expect(addManualBibText(paths, BRIDGE)).rejects.toThrow();
    expect(read(paths.libraryJson)).toBe(libraryBefore);
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
    expect(loadArgumentGraph(paths.dataDir, C).work_id).toBe(C);
  });

  it("the library save fails in a rebuild: no graph moved either", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const bib = join(paths.dataDir, "x.bib");
    writeFileSync(bib, BRIDGE, "utf8");
    mkdirSync(paths.libraryJson.replace(/\.json$/, ".json.tmp"));
    await expect(rebuild(paths, { sources: nullSources, bibPath: bib })).rejects.toThrow();
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
    expect(loadArgumentGraph(paths.dataDir, C).work_id).toBe(C);
  });

  it("the transfer fails: the merge stands, the note says so, the original is intact", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const cBytes = read(argumentGraphPath(paths.dataDir, C));
    // this module's scratch name for the survivor is taken by a directory
    mkdirSync(`${argumentGraphPath(paths.dataDir, A)}.merge-${process.pid}.tmp`);
    const out = await addManualBibText(paths, BRIDGE);
    expect(libIds(paths)).toEqual([A, D]);
    const note = out[0]?.argumentGraphMerges?.[0];
    expect(note?.outcome).toBe("transfer_failed");
    expect(note?.error).toBeTruthy();
    expect(note?.absorbed_file).toBe(argumentGraphPath(paths.dataDir, C));
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
    expect(read(argumentGraphPath(paths.dataDir, C))).toBe(cBytes);
  });

  it("an unreadable absorbed graph is reported as a failed transfer and left alone", async () => {
    const paths = seed();
    mkdirSync(argumentGraphDir(paths.dataDir), { recursive: true });
    writeFileSync(argumentGraphPath(paths.dataDir, C), "{broken", "utf8");
    const out = await addManualBibText(paths, BRIDGE);
    expect(out[0]?.argumentGraphMerges?.[0]?.outcome).toBe("transfer_failed");
    expect(read(argumentGraphPath(paths.dataDir, C))).toBe("{broken");
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
    // no scratch file is left behind
    expect(graphFiles(paths.dataDir)).toEqual([
      `${argumentGraphPath(paths.dataDir, C)}`.split("/").pop(),
    ]);
  });
});

describe("the call paths that can fold Works", () => {
  it("manual bib import (page, merge mode) — covered above; a chain inside one batch follows to the final survivor", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    putGraph(paths.dataDir, D, "from D");
    // entry 1 folds C into A; entry 2 (DOI of D, title of A) makes D the survivor of A, so C and A end in D
    const second =
      "@article{b2,\n author={Ann},\n title={Alpha galaxies},\n year={2001},\n doi={10.1/d}\n}\n";
    const out = await addManualBibText(paths, `${BRIDGE}\n${second}`);
    expect(out.map((o) => o.status)).toEqual(["exists", "exists"]);
    const notes = out.flatMap((o) => o.argumentGraphMerges ?? []);
    // whichever Work survives, every graph is still on disk and the survivor has exactly one graph
    const alive = libIds(paths);
    expect(alive).toHaveLength(1);
    expect(existsSync(argumentGraphPath(paths.dataDir, alive[0] as string))).toBe(true);
    expect(graphFiles(paths.dataDir).length).toBeGreaterThanOrEqual(2);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.survivor_id).toBe(alive[0]);
  });

  it("manual single identifier / bibcode (commitWork) follows the fold", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const sources: MetadataSources = {
      ...nullSources,
      ads: {
        status: "ok",
        resolve: async () => null,
        exportBibtex: async () =>
          "@ARTICLE{2020A&A...1..1X,\n author={{Ann}},\n title={Gamma},\n year={2001},\n doi={10.1/a}\n}",
      },
    };
    const out = await addManualBibcode(paths, sources, "2020A&A...1..1X");
    expect(out.argumentGraphMerges?.[0]).toMatchObject({ outcome: "moved", survivor_id: A });
    expect(loadArgumentGraph(paths.dataDir, A).work_id).toBe(A);
    // an identifier add that matches an existing Work writes nothing and folds nothing
    const again = await addManualIdentifier(paths, nullSources, { kind: "doi", doi: "10.1/a" });
    expect(again.argumentGraphMerges).toBeUndefined();
  });

  it("reject mode (the Copilot library tool) writes nothing and moves nothing", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const before = read(paths.libraryJson);
    const out = await addManualBibText(paths, BRIDGE, { bridge: "reject" });
    expect(out.every((o) => o.status === "error")).toBe(true);
    expect(read(paths.libraryJson)).toBe(before);
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
  });

  it("library build --bib / acquire / refresh (rebuild) reports the note in its summary", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const bib = join(paths.dataDir, "x.bib");
    writeFileSync(bib, BRIDGE, "utf8");
    const summary = await rebuild(paths, { sources: nullSources, bibPath: bib });
    expect(summary.argument_graph_merges).toHaveLength(1);
    expect(summary.argument_graph_merges?.[0]).toMatchObject({ outcome: "moved", survivor_id: A });
    expect(loadArgumentGraph(paths.dataDir, A).work_id).toBe(A);
  });

  it("a rebuild that folds nothing keeps its summary exactly as before (no new key)", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const summary = await rebuild(paths, { sources: nullSources });
    expect("argument_graph_merges" in summary).toBe(false);
  });

  it("a rebuild never changes a stored Work's id (so a graph is not orphaned by enrichment)", async () => {
    const paths = seed();
    const store = LibraryStore.load(paths);
    const titleSlug = store.works[0];
    if (!titleSlug) throw new Error("fixture");
    titleSlug.id = "work:alpha-galaxies-2001"; // a Work whose id was derived before it had a DOI
    store.save(paths);
    putGraph(paths.dataDir, "work:alpha-galaxies-2001", "mine");
    await rebuild(paths, { sources: nullSources });
    expect(libIds(paths)).toContain("work:alpha-galaxies-2001");
    expect(loadArgumentGraph(paths.dataDir, "work:alpha-galaxies-2001").arguments).toHaveLength(1);
  });

  it("CLI ingest of a DOI (addDoiWork) cannot fold: its record is a new DOI plus a title, at most one stored match", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const crossref = {
      resolve: async () => ({
        title: "Gamma",
        authors: ["Cy"],
        year: 2001,
        venue: null,
        type: "article" as const,
        abstract: null,
        cited_by_count: null,
      }),
    } as unknown as Parameters<typeof addDoiWork>[2];
    const r = await addDoiWork(paths, "10.1234/new", crossref);
    expect(r?.created).toBe(true);
    // the title matched C only (the new DOI matches nobody): nothing was removed, so no graph moves
    expect(libIds(paths)).toEqual([A, C, D]);
    expect(loadArgumentGraph(paths.dataDir, C).work_id).toBe(C);
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
  });
});

describe("resolveFolds", () => {
  it("collapses chains and drops folds of Works that were never stored", () => {
    expect(
      resolveFolds([
        { absorbed: "b", survivor: "a", stored: true },
        { absorbed: "a", survivor: "c", stored: true },
        { absorbed: "n", survivor: "c", stored: false },
      ])
    ).toEqual([
      { absorbed: "b", survivor: "c" },
      { absorbed: "a", survivor: "c" },
    ]);
  });

  it("followWorkFolds gives the first fold's graph to a survivor without one; the next is left in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "aspace-argmerge-"));
    dirs.push(dir);
    putGraph(dir, "b", "from b");
    putGraph(dir, "a", "from a");
    const notes = followWorkFolds(dir, [
      { absorbed: "b", survivor: "a", stored: true },
      { absorbed: "a", survivor: "c", stored: true },
    ]);
    expect(notes.map((n) => [n.absorbed_id, n.survivor_id, n.outcome])).toEqual([
      ["b", "c", "moved"],
      ["a", "c", "kept_survivor"],
    ]);
    expect(loadArgumentGraph(dir, "c").arguments[0]?.title).toBe("from b");
  });
});
