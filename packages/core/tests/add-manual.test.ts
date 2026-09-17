/**
 * Stage 13 manual work creation (POST /api/library/works core): identifier
 * (DOI/arXiv), ADS bibcode, and raw-BibTeX batch modes, plus the incremental
 * citation-graph merge. All network is stubbed through the MetadataSources
 * ports (the `_StubSrc` pattern of library.test.ts).
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_GRAPH_VERSION, type GraphData } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import {
  addManualBibcode,
  addManualBibText,
  addManualIdentifier,
} from "../src/library/add-manual.js";
import { loadCurrentGraph } from "../src/library/build.js";
import { mergeWorkIntoGraph } from "../src/library/graph.js";
import type { MetadataSources, OpenAlexResolution } from "../src/library/sources.js";
import {
  emptyWork,
  LibraryStore,
  libraryPaths,
  type Work,
  workToBibtex,
} from "../src/library/store.js";

function tmpPaths() {
  return libraryPaths(mkdtempSync(join(tmpdir(), "aspace-manual-")));
}

/** Every source misses; ADS has no token. */
const nullSources: MetadataSources = {
  ads: { status: "no-token", resolve: async () => null, exportBibtex: async () => null },
  crossref: { resolve: async () => null },
  oa: { resolve: async () => null },
};

function oaMeta(id: string): OpenAlexResolution {
  return {
    openalex_id: id,
    doi: null,
    title: `Paper ${id}`,
    authors: ["Doe"],
    year: 2000,
    venue: "ApJ",
    type: "article",
    cited_by_count: 9,
    referenced_works: [],
    abstract: null,
    arxiv_id: null,
  };
}

// --------------------------------------------------------------------------- //
// identifier mode
// --------------------------------------------------------------------------- //

describe("addManualIdentifier", () => {
  test("DOI: full resolution, bibcode cite key, plan, incremental graph", async () => {
    const paths = tmpPaths();
    const sources: MetadataSources = {
      ads: {
        status: "ok",
        resolve: async () => ({
          bibcode: "2021A&A...646A.104H",
          doi: "10.1051/0004-6361/202039341",
          title: "Improving the open cluster census. I.",
          authors: ["Hunt", "Reffert"],
          year: 2021,
          venue: "Astronomy & Astrophysics",
          citation_count: 55,
          abstract: null,
          references: [],
        }),
        exportBibtex: async () => null,
      },
      crossref: { resolve: async () => null },
      oa: {
        resolve: async () => ({
          ...oaMeta("W3111835394"),
          doi: "10.1051/0004-6361/202039341",
          referenced_works: ["W1"],
        }),
      },
    };
    const r = await addManualIdentifier(paths, sources, {
      kind: "doi",
      doi: "10.1051/0004-6361/202039341",
    });
    expect(r.status).toBe("created");
    expect(r.ref?.id).toBe("doi:10.1051/0004-6361/202039341");
    // Stage 12 key rule: the resolved bibcode becomes the cite key
    expect(r.key).toBe("2021A&A...646A.104H");

    const store = LibraryStore.load(paths);
    const w = store.get("doi:10.1051/0004-6361/202039341");
    expect(w?.bibcode).toBe("2021A&A...646A.104H");
    expect(w?.cited_by_count).toBe(55); // ADS wins the count
    expect(w?.referenced_works).toEqual(["W1"]);
    expect(w?.origin).toBe("manual");
    expect(w?.acquisition).not.toBeNull();

    // incremental graph (Stage 14 saved-only): the saved node, no suggested neighbour
    const g = loadCurrentGraph(paths);
    expect(g?.nodes.some((n) => n.id === w?.id)).toBe(true);
    expect(g?.nodes.some((n) => n.id.startsWith("oa:"))).toBe(false);

    // second add is an exists no-op
    const r2 = await addManualIdentifier(paths, nullSources, {
      kind: "doi",
      doi: "10.1051/0004-6361/202039341",
    });
    expect(r2.status).toBe("exists");
    expect(LibraryStore.load(paths).works).toHaveLength(1);
  });

  test("arXiv: a total network miss still saves the bare stub (tolerant)", async () => {
    const paths = tmpPaths();
    const r = await addManualIdentifier(paths, nullSources, { kind: "arxiv", arxiv: "2603.05265" });
    expect(r.status).toBe("created");
    const w = LibraryStore.load(paths).get("arxiv:2603.05265");
    expect(w?.arxiv_id).toBe("2603.05265");
    expect(w?.cite_key).toBeTruthy();
    // the arXiv-only canonical id must never pose as a DOI work
    expect(w?.doi).toBeNull();
  });

  test("a throwing client degrades to the stub rather than failing creation", async () => {
    const paths = tmpPaths();
    const throwing: MetadataSources = {
      ads: {
        status: "error",
        resolve: async () => {
          throw new Error("boom");
        },
        exportBibtex: async () => null,
      },
      crossref: {
        resolve: async () => {
          throw new Error("boom");
        },
      },
      oa: {
        resolve: async () => {
          throw new Error("boom");
        },
      },
    };
    const r = await addManualIdentifier(paths, throwing, { kind: "doi", doi: "10.1/x" });
    expect(r.status).toBe("created");
    expect(LibraryStore.load(paths).get("doi:10.1/x")?.title).toBe("");
  });
});

// --------------------------------------------------------------------------- //
// bibcode mode
// --------------------------------------------------------------------------- //

const ADS_TEXT = `@ARTICLE{2021A&A...646A.104H,
       author = {{Hunt}, Emily L. and {Reffert}, Sabine},
        title = {Improving the open cluster census. I.},
      journal = {\\aap},
         year = 2021,
        month = feb,
       volume = {646},
          eid = {A104},
        pages = {A104},
          doi = {10.1051/0004-6361/202039341},
       eprint = {2012.04267}
}`;

describe("addManualBibcode", () => {
  function adsWith(text: string | null): MetadataSources {
    return {
      ads: { status: "ok", resolve: async () => null, exportBibtex: async () => text },
      crossref: { resolve: async () => null },
      oa: { resolve: async () => null },
    };
  }

  test("creates from the ADS export: bibcode key, full fields, macro journal", async () => {
    const paths = tmpPaths();
    const r = await addManualBibcode(paths, adsWith(ADS_TEXT), "2021A&A...646A.104H");
    expect(r.status).toBe("created");
    expect(r.key).toBe("2021A&A...646A.104H");
    const w = LibraryStore.load(paths).works[0];
    expect(w?.id).toBe("doi:10.1051/0004-6361/202039341"); // doi > arxiv identity
    expect(w?.bibcode).toBe("2021A&A...646A.104H");
    expect(w?.cite_key).toBe("2021A&A...646A.104H");
    expect(w?.volume).toBe("646");
    expect(w?.pages).toBe("A104");
    expect(w?.eid).toBe("A104");
    expect(w?.month).toBe("02");
    expect(w?.journal_macro).toBe("aap");
    expect(w?.venue).toBe("A&A"); // publisher label from the DOI prefix
    expect(w?.bib_fields).toBe("ads");
    expect(w?.arxiv_id).toBe("2012.04267");
    // the generated library.bib carries the macro journal form
    expect(readFileSync(paths.libraryBib, "utf8")).toContain("{\\aap}");

    const again = await addManualBibcode(paths, adsWith(ADS_TEXT), "2021A&A...646A.104H");
    expect(again.status).toBe("exists");
    expect(LibraryStore.load(paths).works).toHaveLength(1);
  });

  test("fail-fast: ADS unavailable or no such record → error, nothing written", async () => {
    const paths = tmpPaths();
    const unavail = await addManualBibcode(paths, adsWith(null), "2021A&A...646A.104H");
    expect(unavail.status).toBe("error");
    expect(unavail.error).toContain("unavailable");
    const missing = await addManualBibcode(
      paths,
      adsWith("@ARTICLE{other2020, title={T}, year={2020}}"),
      "2021A&A...646A.104H"
    );
    expect(missing.status).toBe("error");
    expect(missing.error).toContain("not found");
    expect(LibraryStore.load(paths).works).toHaveLength(0);
    expect(existsSync(paths.libraryJson)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// bib mode
// --------------------------------------------------------------------------- //

const BATCH_BIB = String.raw`
@article{mykey2021,
  author  = {Hunt, E.~L. and Reffert, S.},
  title   = {Improving the open cluster census. I.},
  journal = {Astronomy \& Astrophysics},
  year    = {2021},
  volume  = {646},
  pages   = {A104},
  doi     = {10.1051/0004-6361/202039341}
}
@article{mackey2020,
  author  = {Doe, J.},
  title   = {A macro-journal paper},
  journal = {\aap},
  year    = {2020},
  number  = {3},
  eid     = {A1},
  month   = mar
}
`;

describe("addManualBibText", () => {
  test("batch create: user keys respected, full bib fields kept, bare graph nodes", async () => {
    const paths = tmpPaths();
    const out = await addManualBibText(paths, BATCH_BIB);
    expect(out.map((o) => o.status)).toEqual(["created", "created"]);
    expect(out.map((o) => o.key)).toEqual(["mykey2021", "mackey2020"]);

    const store = LibraryStore.load(paths);
    expect(store.works).toHaveLength(2);
    const a = store.works.find((w) => w.cite_key === "mykey2021");
    expect(a?.volume).toBe("646"); // BibRecord field kept (unlike build --bib)
    expect(a?.pages).toBe("A104");
    expect(a?.venue).toBe("A&A"); // publisher label from the DOI
    expect(a?.origin).toBe("bib");
    const b = store.works.find((w) => w.cite_key === "mackey2020");
    expect(b?.number).toBe("3");
    expect(b?.eid).toBe("A1");
    expect(b?.month).toBe("03");
    expect(b?.journal_macro).toBe("aap");
    expect(b?.venue).toBe("Astronomy & Astrophysics"); // macro expansion, not the bare "aap"

    // batch mode: saved nodes exist immediately, without any neighbour fetch
    const g = loadCurrentGraph(paths);
    for (const w of store.works) expect(g?.nodes.some((n) => n.id === w.id)).toBe(true);
    expect(g?.nodes.some((n) => n.id.startsWith("oa:"))).toBe(false);

    // a compiled bib entry escapes the A&A ampersand (I030 regression guard)
    expect(workToBibtex(b as Work)).toContain("{\\aap}");

    // re-import is an exists no-op
    const again = await addManualBibText(paths, BATCH_BIB);
    expect(again.map((o) => o.status)).toEqual(["exists", "exists"]);
    expect(LibraryStore.load(paths).works).toHaveLength(2);
  });

  test("a cite-key conflict fails only that entry (partial success)", async () => {
    const paths = tmpPaths();
    await addManualBibText(paths, BATCH_BIB);
    const conflict = `
@article{mykey2021,
  author = {Someone, E.},
  title   = {A completely different paper},
  year    = {1999}
}
@article{freshkey2000,
  author = {Other, O.},
  title   = {An unrelated fine paper},
  year    = {2000}
}
`;
    const out = await addManualBibText(paths, conflict);
    expect(out).toHaveLength(2);
    expect(out[0]?.status).toBe("error");
    expect(out[0]?.error).toContain("already used");
    expect(out[1]?.status).toBe("created");
    const store = LibraryStore.load(paths);
    expect(store.works).toHaveLength(3);
    // the conflicting entry did not clobber the original work's title
    expect(store.works.find((w) => w.cite_key === "mykey2021")?.title).toContain("open cluster");
  });

  test("unparseable text → a single error outcome, nothing written", async () => {
    const paths = tmpPaths();
    const out = await addManualBibText(paths, "this is not bibtex at all");
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toBe("error");
    expect(existsSync(paths.libraryJson)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// incremental graph merge
// --------------------------------------------------------------------------- //

describe("mergeWorkIntoGraph", () => {
  test("node + inbound/outbound saved↔saved edges; no suggested fetch (Stage 14)", () => {
    const store = new LibraryStore([]);
    const x = emptyWork("arxiv:x");
    x.title = "Existing work";
    x.openalex_id = "WX";
    x.referenced_works = ["WNEW"]; // X cites the new work
    store.upsert(x);

    const old = emptyWork("arxiv:old");
    old.title = "Old saved work";
    old.openalex_id = "WOLD";
    store.upsert(old);

    const w = emptyWork("arxiv:new");
    w.title = "New work";
    w.openalex_id = "WNEW";
    w.referenced_works = ["WOLD", "WMISS"]; // cites the saved old one + an unmapped id
    store.upsert(w);

    const graph: GraphData = {
      version: CURRENT_GRAPH_VERSION,
      nodes: [
        { id: "arxiv:x", ref: "arxiv:x", y: 2020, c: 1, a: "X", v: "", t: "Existing work" },
        {
          id: "arxiv:old",
          ref: "arxiv:old",
          y: 1999,
          c: 5,
          a: "Old",
          v: "ApJ",
          t: "Old saved work",
        },
      ],
      links: [] as [string, string][],
    };
    const out = mergeWorkIntoGraph(graph, store, w);
    expect(out.version).toBe(CURRENT_GRAPH_VERSION);
    expect(out.nodes.some((n) => n.id === "arxiv:new")).toBe(true);
    expect(out.nodes.every((n) => n.ref !== undefined)).toBe(true); // saved-only
    expect(out.links).toContainEqual(["arxiv:x", "arxiv:new"]); // inbound
    expect(out.links).toContainEqual(["arxiv:new", "arxiv:old"]); // outbound to a saved work
    expect(out.links.some(([, b]) => b === "oa:WMISS")).toBe(false); // unmapped ids are dropped
  });

  test("a work citing nothing visible adds the bare node only (batch bib mode)", () => {
    const store = new LibraryStore([]);
    const w = emptyWork("arxiv:solo");
    w.title = "Solo";
    w.referenced_works = ["W1"];
    store.upsert(w);
    const out = mergeWorkIntoGraph(
      { version: CURRENT_GRAPH_VERSION, nodes: [], links: [] },
      store,
      w
    );
    expect(out.nodes.map((n) => n.id)).toEqual(["arxiv:solo"]);
    expect(out.links).toEqual([]);
  });
});
