/**
 * Argument graphs follow a Work merge (ticket 06, ADR 0009): the four graph combinations, the two failure
 * paths (library save fails, graph transfer fails) and every call path that can fold two Works. Temp data
 * dirs only.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArgumentGraph } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { followWorkFolds } from "../src/argument-graphs/merge.js";
import {
  argumentGraphDir,
  argumentGraphPath,
  listArgumentGraphWorkIds,
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
import { emptyWork, LibraryStore, libraryPaths } from "../src/library/store.js";

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

/** A cleared graph: still a file, zero arguments, rev bumped by the clear. */
function clearGraph(dataDir: string, saved: ArgumentGraph): ArgumentGraph {
  const r = replaceArgumentGraph(dataDir, { ...saved, arguments: [], edges: [] });
  if (!("saved" in r)) throw new Error("fixture");
  return r.saved;
}
const bibEntry = (key: string, title: string, doi: string) =>
  `@article{${key},\n author={Ann},\n title={${title}},\n year={2001},\n doi={${doi}}\n}\n`;
const titleOf = (dataDir: string, id: string) =>
  loadArgumentGraph(dataDir, id).arguments[0]?.title ?? "(empty)";

describe("the four combinations (a real move: one graph on disk afterwards)", () => {
  it("neither Work has a graph: nothing happens, no file, no note", async () => {
    const paths = seed();
    const out = await addManualBibText(paths, BRIDGE);
    expect(libIds(paths)).toEqual([A, D]);
    expect(out[0]?.argumentGraphMerges).toBeUndefined();
    expect(graphFiles(paths.dataDir)).toEqual([]);
  });

  it("only the absorbed Work has one: the survivor gets it and the absorbed file is gone", async () => {
    const paths = seed();
    const saved = putGraph(paths.dataDir, C, "from C");
    const out = await addManualBibText(paths, BRIDGE);
    expect(libIds(paths)).toEqual([A, D]);
    expect(out[0]?.argumentGraphMerges?.[0]).toMatchObject({
      outcome: "moved",
      absorbed_id: C,
      survivor_id: A,
      absorbed_file: argumentGraphPath(paths.dataDir, C),
      survivor_file: argumentGraphPath(paths.dataDir, A),
    });
    expect(out[0]?.argumentGraphMerges?.[0]?.absorbed_file_left).toBeUndefined();
    expect(loadArgumentGraph(paths.dataDir, A)).toEqual({ ...saved, work_id: A });
    expect(existsSync(argumentGraphPath(paths.dataDir, C))).toBe(false);
    expect(graphFiles(paths.dataDir)).toHaveLength(1);
  });

  it("a hand-written rev 0 graph arrives at rev 1, so a stale writer holding rev 0 gets a conflict", async () => {
    const paths = seed();
    mkdirSync(argumentGraphDir(paths.dataDir), { recursive: true });
    const hand = putGraph(paths.dataDir, D, "hand");
    writeFileSync(
      argumentGraphPath(paths.dataDir, C),
      JSON.stringify({ ...hand, work_id: C, rev: 0 }),
      "utf8"
    );
    rmSync(argumentGraphPath(paths.dataDir, D));
    await addManualBibText(paths, BRIDGE);
    const survivor = loadArgumentGraph(paths.dataDir, A);
    expect(survivor.rev).toBe(1);
    const stale = replaceArgumentGraph(paths.dataDir, { ...survivor, rev: 0, arguments: [] });
    expect(stale).toEqual({ conflictRev: 1 });
  });

  it("both have one: the survivor's is kept byte for byte, the absorbed one stays on disk and is reported", async () => {
    const paths = seed();
    putGraph(paths.dataDir, A, "from A");
    putGraph(paths.dataDir, C, "from C");
    const aBytes = read(argumentGraphPath(paths.dataDir, A));
    const cBytes = read(argumentGraphPath(paths.dataDir, C));
    const out = await addManualBibText(paths, BRIDGE);
    expect(out[0]?.argumentGraphMerges?.[0]).toMatchObject({
      outcome: "kept_survivor",
      absorbed_id: C,
      survivor_id: A,
      absorbed_file: argumentGraphPath(paths.dataDir, C),
    });
    expect(out[0]?.argumentGraphMerges?.[0]?.survivor_unreadable).toBeUndefined();
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
});

describe("zero-argument graphs count as no graph (2026-10-12)", () => {
  it("an empty survivor file is replaced by the absorbed Work's graph; rev is max+1 so a stale writer conflicts", async () => {
    const paths = seed();
    const emptyA = clearGraph(paths.dataDir, putGraph(paths.dataDir, A, "x")); // rev 3
    const cSaved = putGraph(paths.dataDir, C, "from C"); // rev 2
    const out = await addManualBibText(paths, BRIDGE);
    expect(out[0]?.argumentGraphMerges?.[0]).toMatchObject({ outcome: "moved", survivor_id: A });
    const survivor = loadArgumentGraph(paths.dataDir, A);
    expect(survivor.arguments[0]?.title).toBe("from C");
    expect(survivor.rev).toBe(Math.max(emptyA.rev, cSaved.rev) + 1);
    expect(survivor.work_id).toBe(A);
    expect(existsSync(argumentGraphPath(paths.dataDir, C))).toBe(false);
    expect(graphFiles(paths.dataDir)).toHaveLength(1);
    expect(replaceArgumentGraph(paths.dataDir, { ...emptyA })).toEqual({
      conflictRev: survivor.rev,
    });
  });

  it("an empty absorbed graph is not transferred and not reported; its file stays", async () => {
    const paths = seed();
    clearGraph(paths.dataDir, putGraph(paths.dataDir, C, "x"));
    const before = read(argumentGraphPath(paths.dataDir, C));
    const out = await addManualBibText(paths, BRIDGE);
    expect(out[0]?.argumentGraphMerges).toBeUndefined();
    expect(read(argumentGraphPath(paths.dataDir, C))).toBe(before);
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
  });

  it.each([
    ["corrupt JSON", (f: string) => writeFileSync(f, "{broken", "utf8")],
    ["a directory", (f: string) => mkdirSync(f)],
  ])(
    "an unreadable survivor file (%s) is not an empty graph: not overwritten, reported",
    async (_n, make) => {
      const paths = seed();
      putGraph(paths.dataDir, C, "from C");
      make(argumentGraphPath(paths.dataDir, A));
      const cBytes = read(argumentGraphPath(paths.dataDir, C));
      const out = await addManualBibText(paths, BRIDGE);
      const note = out[0]?.argumentGraphMerges?.[0];
      expect(note).toMatchObject({ outcome: "kept_survivor", survivor_unreadable: true });
      expect(read(argumentGraphPath(paths.dataDir, C))).toBe(cBytes);
      if (_n === "corrupt JSON") expect(read(argumentGraphPath(paths.dataDir, A))).toBe("{broken");
    }
  );
});

describe("failure paths: the graph is still there", () => {
  it("the library save fails: the merge throws and the graph was not moved", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const libraryBefore = read(paths.libraryJson);
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

  it.skipIf(process.getuid?.() === 0)(
    "the publish fails: transfer_failed with a fixed kind, the original is intact",
    async () => {
      const paths = seed();
      putGraph(paths.dataDir, C, "from C");
      const cBytes = read(argumentGraphPath(paths.dataDir, C));
      chmodSync(argumentGraphDir(paths.dataDir), 0o500);
      try {
        const out = await addManualBibText(paths, BRIDGE);
        expect(libIds(paths)).toEqual([A, D]);
        const note = out[0]?.argumentGraphMerges?.[0];
        expect(note).toMatchObject({ outcome: "transfer_failed", error: "write_failed" });
        expect(note?.absorbed_file).toBe(argumentGraphPath(paths.dataDir, C));
      } finally {
        chmodSync(argumentGraphDir(paths.dataDir), 0o700);
      }
      expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
      expect(read(argumentGraphPath(paths.dataDir, C))).toBe(cBytes);
    }
  );

  it("an unreadable absorbed graph is reported as a failed transfer and left alone", async () => {
    const paths = seed();
    mkdirSync(argumentGraphDir(paths.dataDir), { recursive: true });
    writeFileSync(argumentGraphPath(paths.dataDir, C), "{broken", "utf8");
    const out = await addManualBibText(paths, BRIDGE);
    expect(out[0]?.argumentGraphMerges?.[0]).toMatchObject({
      outcome: "transfer_failed",
      error: "absorbed_unreadable",
    });
    expect(read(argumentGraphPath(paths.dataDir, C))).toBe("{broken");
    expect(graphFiles(paths.dataDir)).toHaveLength(1);
  });

  it("library.json is saved but library.bib fails: the merge stands, the graph still follows, the error carries the note", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    mkdirSync(paths.libraryBib, { recursive: true });
    writeFileSync(join(paths.libraryBib, "keep"), "x");
    let error: (Error & { argumentGraphMerges?: { outcome: string }[] }) | null = null;
    try {
      await addManualBibText(paths, BRIDGE);
    } catch (e) {
      error = e as Error;
    }
    expect(error).not.toBeNull();
    expect(libIds(paths)).toEqual([A, D]);
    expect(titleOf(paths.dataDir, A)).toBe("from C");
    expect(existsSync(argumentGraphPath(paths.dataDir, C))).toBe(false);
    expect(error?.argumentGraphMerges?.[0]?.outcome).toBe("moved");
    expect(error?.message).toContain("argument graph");
    expect(error?.message.split("(the Work merge itself was saved")[1]).not.toContain(
      paths.dataDir
    );
  });

  it("the same half failure in a rebuild", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const bib = join(paths.dataDir, "x.bib");
    writeFileSync(bib, BRIDGE, "utf8");
    mkdirSync(paths.libraryBib, { recursive: true });
    writeFileSync(join(paths.libraryBib, "keep"), "x");
    let error: (Error & { argumentGraphMerges?: { outcome: string }[] }) | null = null;
    try {
      await rebuild(paths, { sources: nullSources, bibPath: bib });
    } catch (e) {
      error = e as Error;
    }
    expect(error?.argumentGraphMerges?.[0]?.outcome).toBe("moved");
    expect(titleOf(paths.dataDir, A)).toBe("from C");
  });
});

describe("folds are followed one step at a time, in the order they happened", () => {
  it("C into A (both have graphs), then A into D (D has none): D gets A's graph, C's stays", async () => {
    const paths = seed();
    putGraph(paths.dataDir, A, "from A");
    putGraph(paths.dataDir, C, "from C");
    const second = bibEntry("b2", "Alpha galaxies", "10.1/d");
    const out = await addManualBibText(paths, `${BRIDGE}\n${second}`);
    expect(libIds(paths)).toEqual([D]);
    expect(
      out.map((o) => o.argumentGraphMerges?.map((n) => [n.absorbed_id, n.survivor_id, n.outcome]))
    ).toEqual([[[C, A, "kept_survivor"]], [[A, D, "moved"]]]);
    expect(titleOf(paths.dataDir, D)).toBe("from A");
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
    expect(titleOf(paths.dataDir, C)).toBe("from C"); // the leftover stays where it was
  });

  it("the same chain through a rebuild", async () => {
    const paths = seed();
    putGraph(paths.dataDir, A, "from A");
    putGraph(paths.dataDir, C, "from C");
    const bib = join(paths.dataDir, "x.bib");
    writeFileSync(bib, `${BRIDGE}\n${bibEntry("b2", "Alpha galaxies", "10.1/d")}`, "utf8");
    const summary = await rebuild(paths, { sources: nullSources, bibPath: bib });
    expect(
      summary.argument_graph_merges?.map((n) => [n.absorbed_id, n.survivor_id, n.outcome])
    ).toEqual([
      [C, A, "kept_survivor"],
      [A, D, "moved"],
    ]);
    expect(titleOf(paths.dataDir, D)).toBe("from A");
  });

  it("an id that reappears inside the batch is a different Work: the graph of the stored one is not attached to an unrelated Work", async () => {
    const paths = seed();
    putGraph(paths.dataDir, A, "from the STORED A");
    // e1 folds the stored A into C; e2 creates a NEW Work with id A; e3 folds that new A into D
    const out = await addManualBibText(
      paths,
      [
        bibEntry("e1", "Alpha galaxies", "10.1/c"),
        bibEntry("e2", "Brand new", "10.1/a"),
        bibEntry("e3", "Brand new", "10.1/d"),
      ].join("\n")
    );
    expect(out.map((o) => o.status)).toEqual(["exists", "created", "exists"]);
    expect(libIds(paths).sort()).toEqual([C, D]);
    const notes = out.flatMap((o) => o.argumentGraphMerges ?? []);
    expect(notes.map((n) => [n.absorbed_id, n.survivor_id, n.outcome])).toEqual([[A, C, "moved"]]);
    expect(titleOf(paths.dataDir, C)).toBe("from the STORED A");
    expect(existsSync(argumentGraphPath(paths.dataDir, D))).toBe(false);
  });

  it("A into C, a new A appears, C into the new A (a cycle of ids): both steps are applied and reported, nothing is lost", async () => {
    const paths = seed();
    putGraph(paths.dataDir, A, "from the STORED A");
    putGraph(paths.dataDir, C, "from C");
    const out = await addManualBibText(
      paths,
      [
        bibEntry("e1", "Alpha galaxies", "10.1/c"),
        bibEntry("e2", "Brand new", "10.1/a"),
        bibEntry("e3", "Gamma", "10.1/a"),
      ].join("\n")
    );
    const notes = out.flatMap((o) => o.argumentGraphMerges ?? []);
    expect(notes.map((n) => [n.absorbed_id, n.survivor_id, n.outcome])).toEqual([
      [A, C, "kept_survivor"],
      [C, A, "kept_survivor"],
    ]);
    expect(graphFiles(paths.dataDir)).toHaveLength(2);
  });

  it("store.folds is emptied once followed: following the same store again reports nothing", () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const store = LibraryStore.load(paths);
    store.upsert({ ...emptyWork("x"), title: "Gamma", doi: "10.1/a" });
    expect(store.folds).toHaveLength(1);
    expect(followWorkFolds(paths.dataDir, store.folds)).toHaveLength(1);
    expect(store.folds).toHaveLength(0);
    expect(followWorkFolds(paths.dataDir, store.folds)).toEqual([]);
  });
});

describe("scratch files", () => {
  it("a merge removes its own stale scratch files and leaves a fresh one (another process may be writing it)", async () => {
    const paths = seed();
    putGraph(paths.dataDir, C, "from C");
    const stale = `${argumentGraphPath(paths.dataDir, A)}.merge-99999-1.tmp`;
    const fresh = `${argumentGraphPath(paths.dataDir, D)}.merge-99998-1.tmp`;
    writeFileSync(stale, "{}");
    writeFileSync(fresh, "{}");
    const old = new Date(Date.now() - 3 * 3600_000);
    utimesSync(stale, old, old);
    await addManualBibText(paths, BRIDGE);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(listArgumentGraphWorkIds(paths.dataDir)).toEqual([A]);
  });
});

describe("the call paths that can fold Works", () => {
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
    expect(existsSync(argumentGraphPath(paths.dataDir, C))).toBe(true);
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
    titleSlug.id = "work:alpha-galaxies-2001";
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
    expect(libIds(paths)).toEqual([A, C, D]);
    expect(loadArgumentGraph(paths.dataDir, C).work_id).toBe(C);
    expect(existsSync(argumentGraphPath(paths.dataDir, A))).toBe(false);
  });
});
