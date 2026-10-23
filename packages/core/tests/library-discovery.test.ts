/**
 * Stage 14 core discovery assembly: provider orchestration + pure helpers
 * (node merge, citation-edge derivation, Library membership overlay). All
 * ADS access is stubbed through the `AdsDiscoverySource` port; the only
 * filesystem touch is the throwaway LibraryStore directory.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  type AdsDiscoveryRecord,
  type AdsDiscoverySource,
  discoverLiterature,
  discoveryEdges,
  libraryMembership,
  matchLibraryId,
  mergeDiscoveryNodes,
  RELATED_LIMIT,
  USEFUL_LIMIT,
} from "../src/library/discovery.js";
import { emptyWork, LibraryStore, libraryPaths, type Work } from "../src/library/store.js";

function rec(bibcode: string, over: Partial<AdsDiscoveryRecord> = {}): AdsDiscoveryRecord {
  return {
    bibcode,
    title: `Paper ${bibcode}`,
    authors: ["Doe, J."],
    year: 2020,
    venue: "A&A",
    abstract: `Abstract of ${bibcode}`,
    citation_count: 10,
    doi: null,
    arxiv_id: null,
    references: [],
    ...over,
  };
}

function storeWith(works: Work[]): LibraryStore {
  const store = LibraryStore.load(libraryPaths(mkdtempSync(join(tmpdir(), "aspace-disc-"))));
  for (const w of works) store.upsert(w);
  return store;
}

function ads(over: Partial<AdsDiscoverySource>): AdsDiscoverySource {
  return {
    getByBibcode: async () => null,
    similar: async () => [],
    useful: async () => [],
    ...over,
  };
}

const SEED = "2023A&A...673A.114H";

// --------------------------------------------------------------------------- //
// mergeDiscoveryNodes
// --------------------------------------------------------------------------- //

describe("mergeDiscoveryNodes", () => {
  const membership = {
    byBibcode: new Map<string, string>(),
    byDoi: new Map<string, string>(),
    byArxiv: new Map<string, string>(),
  };

  test("seed first, related by rank, useful-only by rank (deterministic)", () => {
    const nodes = mergeDiscoveryNodes(
      rec(SEED),
      [rec("R2"), rec("R1")].sort(() => 0), // keep provider order: R2 then R1
      [rec("U2"), rec("U1")],
      membership
    );
    expect(nodes.map((n) => n.bibcode)).toEqual([SEED, "R2", "R1", "U2", "U1"]);
    expect(nodes[0]?.roles).toEqual(["seed"]);
    expect(nodes[1]?.relatedRank).toBe(1);
    expect(nodes[2]?.relatedRank).toBe(2);
    expect(nodes[3]?.usefulRank).toBe(1);
    expect(nodes[4]?.usefulRank).toBe(2);
  });

  test("dual related+useful collapses to one node with both roles/ranks", () => {
    const nodes = mergeDiscoveryNodes(rec(SEED), [rec("R1")], [rec("R1"), rec("U1")], membership);
    expect(nodes.map((n) => n.bibcode)).toEqual([SEED, "R1", "U1"]);
    expect(nodes[1]?.roles).toEqual(["related", "useful"]);
    expect(nodes[1]?.relatedRank).toBe(1);
    expect(nodes[1]?.usefulRank).toBe(1);
  });

  test("useful returning the seed keeps roles [seed]", () => {
    const nodes = mergeDiscoveryNodes(rec(SEED), [rec("R1")], [rec(SEED), rec("U1")], membership);
    expect(nodes).toHaveLength(3);
    expect(nodes[0]?.roles).toEqual(["seed"]);
    expect(nodes[0]?.usefulRank).toBeUndefined();
  });

  test("related returning the seed is folded into the seed node", () => {
    const nodes = mergeDiscoveryNodes(rec(SEED), [rec(SEED), rec("R1")], [], membership);
    expect(nodes.map((n) => n.bibcode)).toEqual([SEED, "R1"]);
    expect(nodes[0]?.roles).toEqual(["seed"]);
  });
});

// --------------------------------------------------------------------------- //
// discoveryEdges
// --------------------------------------------------------------------------- //

describe("discoveryEdges", () => {
  test("only visible-to-visible citations become edges, direction citing → cited", () => {
    const edges = discoveryEdges([
      rec("A", { references: ["B", "C", "X"] }), // X not visible
      rec("B", { references: ["C"] }),
      rec("C", { references: ["C", "B"] }), // self-edge dropped
    ]);
    expect(edges).toEqual([
      { from: "A", to: "B", kind: "citation" },
      { from: "A", to: "C", kind: "citation" },
      { from: "B", to: "C", kind: "citation" },
      { from: "C", to: "B", kind: "citation" },
    ]);
  });

  test("exact duplicates removed; disconnected nodes produce no edges", () => {
    const edges = discoveryEdges([
      rec("A", { references: ["B", "B"] }),
      rec("B", { references: ["A"] }),
      rec("ISO"), // disconnected — valid, no edges
    ]);
    expect(edges).toEqual([
      { from: "A", to: "B", kind: "citation" },
      { from: "B", to: "A", kind: "citation" },
    ]);
  });

  test("deterministic ordering independent of input order", () => {
    const a = discoveryEdges([
      rec("Z", { references: ["A"] }),
      rec("B", { references: ["A"] }),
      rec("A"),
    ]);
    const b = discoveryEdges([
      rec("B", { references: ["A"] }),
      rec("A"),
      rec("Z", { references: ["A"] }),
    ]);
    expect(a).toEqual(b);
    expect(a.map((e) => `${e.from}->${e.to}`)).toEqual(["B->A", "Z->A"]);
  });
});

// --------------------------------------------------------------------------- //
// membership overlay
// --------------------------------------------------------------------------- //

describe("membership overlay", () => {
  test("exact stored bibcode matches; DOI fallback matches normalized both sides", () => {
    const w1 = { ...emptyWork("doi:10.1/x"), bibcode: "2020A&A...111A..1D" };
    const w2 = { ...emptyWork("doi:10.1051/y"), doi: "10.1051/Y" };
    const store = storeWith([w1, w2]);
    const m = libraryMembership(store);
    expect(matchLibraryId(m, "2020A&A...111A..1D", null)).toBe("doi:10.1/x");
    expect(matchLibraryId(m, "2099ZZZ........", "10.1051/y")).toBe("doi:10.1051/y");
    expect(matchLibraryId(m, "2099ZZZ........", null)).toBeNull();
  });

  test("arXiv fallback: only the arXiv id agrees (bibcode and DOI do not)", () => {
    // Work with only an arXiv id (versioned, prefixed: normalized like the Library identity rule).
    const w1 = { ...emptyWork("arxiv:2306.12345"), arxiv_id: "arXiv:2306.12345v2" };
    // Work whose only identifier is the DataCite arXiv DOI.
    const w2 = { ...emptyWork("doi:10.48550/arxiv.2401.00001"), doi: "10.48550/arXiv.2401.00001" };
    const store = storeWith([w1, w2]);
    const m = libraryMembership(store);
    // candidate arXiv id vs Work arxiv_id
    expect(matchLibraryId(m, "2099ZZZ........", null, "2306.12345")).toBe("arxiv:2306.12345");
    // candidate arXiv DataCite DOI vs Work arxiv_id
    expect(matchLibraryId(m, "2099ZZZ........", "10.48550/arXiv.2306.12345v1", null)).toBe(
      "arxiv:2306.12345"
    );
    // candidate arXiv id vs Work holding only the DataCite DOI
    expect(matchLibraryId(m, "2099ZZZ........", null, "arXiv:2401.00001")).toBe(
      "doi:10.48550/arxiv.2401.00001"
    );
    // a different arXiv id does not match
    expect(matchLibraryId(m, "2099ZZZ........", null, "2306.99999")).toBeNull();
  });

  test("match order: bibcode, then DOI, then arXiv", () => {
    const byBib = { ...emptyWork("work:bib"), title: "B", bibcode: "2020A&A...111A..1D" };
    const byDoi = { ...emptyWork("doi:10.1/z"), doi: "10.1/z" };
    const byArx = { ...emptyWork("arxiv:2306.12345"), arxiv_id: "2306.12345" };
    const m = libraryMembership(storeWith([byBib, byDoi, byArx]));
    expect(matchLibraryId(m, "2020A&A...111A..1D", "10.1/z", "2306.12345")).toBe("work:bib");
    expect(matchLibraryId(m, "2099ZZZ........", "10.1/z", "2306.12345")).toBe("doi:10.1/z");
    expect(matchLibraryId(m, "2099ZZZ........", "10.9/none", "2306.12345")).toBe(
      "arxiv:2306.12345"
    );
  });

  test("a candidate matched only by arXiv id gets libraryId (shown as in Library)", () => {
    const w = { ...emptyWork("arxiv:2306.12345"), arxiv_id: "2306.12345" };
    const m = libraryMembership(storeWith([w]));
    const nodes = mergeDiscoveryNodes(
      rec(SEED),
      [rec("2023X", { arxiv_id: "2306.12345", doi: "10.1051/journal" }), rec("2023Y")],
      [],
      m
    );
    expect(nodes.map((n) => n.libraryId)).toEqual([null, "arxiv:2306.12345", null]);
  });

  test("no fuzzy title membership", () => {
    const w = { ...emptyWork("arxiv:1234.5678"), title: "Identical Title Here" };
    const store = storeWith([w]);
    const m = libraryMembership(store);
    expect(matchLibraryId(m, "2099ZZZ........", null)).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// discoverLiterature
// --------------------------------------------------------------------------- //

describe("discoverLiterature", () => {
  test("seed + related + useful assembly; useful called with exact related bibcodes", async () => {
    const usefulCalls: string[][] = [];
    const source = ads({
      getByBibcode: async (b) => (b === SEED ? rec(SEED) : null),
      similar: async (b, limit) => {
        expect(b).toBe(SEED);
        expect(limit).toBe(RELATED_LIMIT);
        return [rec("R1", { references: [SEED] }), rec("R2")];
      },
      useful: async (bibcodes, limit) => {
        usefulCalls.push([...bibcodes]);
        expect(limit).toBe(USEFUL_LIMIT);
        return [rec("U1", { references: ["R1"] })];
      },
    });
    const g = await discoverLiterature(SEED, { ads: source, store: storeWith([]) });
    expect(g).not.toBeNull();
    expect(usefulCalls).toEqual([["R1", "R2"]]);
    expect(g?.seed).toBe(SEED);
    expect(g?.nodes.map((n) => n.bibcode)).toEqual([SEED, "R1", "R2", "U1"]);
    expect(g?.edges).toEqual([
      { from: "R1", to: SEED, kind: "citation" },
      { from: "U1", to: "R1", kind: "citation" },
    ]);
    expect(g?.warnings).toEqual([]);
  });

  test("seed miss returns null (server maps 404)", async () => {
    const g = await discoverLiterature("2099NONE.........", {
      ads: ads({}),
      store: storeWith([]),
    });
    expect(g).toBeNull();
  });

  test("zero related skips useful → seed-only graph", async () => {
    let usefulCalled = false;
    const source = ads({
      getByBibcode: async () => rec(SEED),
      similar: async () => [],
      useful: async () => {
        usefulCalled = true;
        return [];
      },
    });
    const g = await discoverLiterature(SEED, { ads: source, store: storeWith([]) });
    expect(usefulCalled).toBe(false);
    expect(g?.nodes.map((n) => n.bibcode)).toEqual([SEED]);
    expect(g?.edges).toEqual([]);
    expect(g?.warnings).toEqual([]);
  });

  test("useful failure after successful similar → partial graph + warning", async () => {
    const source = ads({
      getByBibcode: async () => rec(SEED),
      similar: async () => [rec("R1")],
      useful: async () => {
        throw new Error("ADS 500");
      },
    });
    const g = await discoverLiterature(SEED, { ads: source, store: storeWith([]) });
    expect(g?.nodes.map((n) => n.bibcode)).toEqual([SEED, "R1"]);
    expect(g?.warnings).toEqual([{ code: "useful_unavailable" }]);
  });

  test("similar failure is fatal (propagates)", async () => {
    const source = ads({
      getByBibcode: async () => rec(SEED),
      similar: async () => {
        throw new Error("ADS timeout");
      },
    });
    await expect(discoverLiterature(SEED, { ads: source, store: storeWith([]) })).rejects.toThrow(
      "ADS timeout"
    );
  });

  test("membership overlay lands on nodes (bibcode + DOI fallback)", async () => {
    const w1 = { ...emptyWork("doi:10.1/a"), bibcode: "R1" };
    const w2 = { ...emptyWork("doi:10.1/b"), doi: "10.1/b" };
    const source = ads({
      getByBibcode: async () => rec(SEED),
      similar: async () => [rec("R1"), rec("R2", { doi: "10.1/b" }), rec("R3", { doi: "10.1/c" })],
    });
    const g = await discoverLiterature(SEED, { ads: source, store: storeWith([w1, w2]) });
    const byBib = new Map(g?.nodes.map((n) => [n.bibcode, n.libraryId]));
    expect(byBib.get("R1")).toBe("doi:10.1/a");
    expect(byBib.get("R2")).toBe("doi:10.1/b");
    expect(byBib.get("R3")).toBeNull();
    expect(byBib.get(SEED)).toBeNull();
  });

  test("discovery never mutates the supplied LibraryStore", async () => {
    const w = { ...emptyWork("doi:10.1/a"), bibcode: "R1" };
    const store = storeWith([w]);
    const before = JSON.stringify(store.works);
    const source = ads({
      getByBibcode: async () => rec(SEED),
      similar: async () => [rec("R1")],
      useful: async () => [rec("U1")],
    });
    await discoverLiterature(SEED, { ads: source, store });
    expect(JSON.stringify(store.works)).toBe(before);
  });

  test("related fewer than the limit is fine", async () => {
    const source = ads({
      getByBibcode: async () => rec(SEED),
      similar: async () => [rec("R1")],
      useful: async () => [],
    });
    const g = await discoverLiterature(SEED, { ads: source, store: storeWith([]) });
    expect(g?.nodes).toHaveLength(2);
  });

  test("aborted useful propagates instead of degrading to a warning", async () => {
    const controller = new AbortController();
    const source = ads({
      getByBibcode: async () => rec(SEED),
      similar: async () => [rec("R1")],
      useful: async () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    await expect(
      discoverLiterature(SEED, { ads: source, store: storeWith([]) }, { signal: controller.signal })
    ).rejects.toThrow("aborted");
  });
});
