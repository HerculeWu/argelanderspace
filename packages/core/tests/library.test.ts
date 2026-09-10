/**
 * Vitest port of the library/acquisition-domain tests from
 * `<repo>/tests/run_tests.py` (the offline Python suite is the specification;
 * one `test(...)` per Python test function, same checks, same order), plus the
 * M1b store round-trip test against the real `data/library/library.json`.
 *
 * Python baseline (2026-08-26, astro env): 210 checks / 0 fail across 58 test
 * functions. The 12 library-domain functions deferred from M1a are ported here:
 * - test_acq_* (9) — bibtex parser + source planner + publisher classify
 * - test_crossref_normalize (1) — Crossref message normalization
 * - test_resolve_chain_* (2 — the task brief says 3, but the Python file only
 *   ever defined 2; see tests/run_tests.py:1011,1032)
 *
 * The resolution-chain tests stub the MetadataSource ports
 * (`library/sources.ts`) exactly like Python's `_StubSrc`.
 */

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseBibtexText } from "../src/acquire/bibtex.js";
import { classify, planSources, planToDict } from "../src/acquire/planner.js";
import { resolveWork } from "../src/acquire/resolve.js";
import { enrichAndPlan } from "../src/acquire/run.js";
import { addDoiWork, removeDocFromWorks } from "../src/library/build.js";
import { workToRef } from "../src/library/graph.js";
import type {
  AdsResolution,
  CrossrefResolution,
  OpenAlexResolution,
} from "../src/library/sources.js";
import { normalizeCrossref } from "../src/library/sources.js";
import { emptyWork, LibraryStore, libraryPaths, type Work } from "../src/library/store.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

// --------------------------------------------------------------------------- //
// Acquisition layer: bibtex parser, source planner, resolution chain
// --------------------------------------------------------------------------- //

const SAMPLE_BIB = String.raw`
@article{HR1,
  author  = {Hunt, E.~L. and Reffert, S.},
  title   = {Improving the open cluster census. I.},
  journal = {Astronomy \& Astrophysics},
  year    = {2021},
  doi     = {10.1051/0004-6361/202039341}
}
@article{Kroupa2001,
  author  = {Kroupa, P.},
  title   = {On the variation of the initial mass function},
  journal = {Monthly Notices of the Royal Astronomical Society},
  year    = {2001},
  doi     = {10.1046/j.1365-8711.2001.04022.x}
}
@article{Huisjes2025,
  author  = {Huisjes, M. and Hern{\'a}ndez, X.},
  title   = {On the dynamics of low-mass open clusters},
  journal = {arXiv e-prints},
  year    = {2025},
  eprint  = {2603.03522},
  archivePrefix = {arXiv}
}
@article{GaiaDR3,
  author  = {{Gaia Collaboration} and Vallenari, A. and others},
  title   = {Gaia Data Release 3},
  journal = {Astronomy \& Astrophysics},
  year    = {2023},
  doi     = {10.1051/0004-6361/202243940},
  eprint  = {2208.00211},
  archivePrefix = {arXiv}
}
@article{Milgrom1983,
  author  = {Milgrom, M.},
  title   = {A modification of the Newtonian dynamics},
  journal = {Astrophysical Journal},
  year    = {1983},
  doi     = {10.1086/161130}
}
@article{Perryman1998,
  author  = {Perryman, M.~A.~C. and Brown, A.~G.~A. and others},
  title   = {The Hyades: distance, structure, dynamics, and age},
  journal = {Astronomy \& Astrophysics},
  year    = {1998}
}
`;

describe("library domain (tests/run_tests.py port)", () => {
  test("test_acq_bibtex_parse", () => {
    const recs = new Map(parseBibtexText(SAMPLE_BIB).map((r) => [r.key, r]));
    expect(recs.size, `parsed 6 entries, got ${recs.size}`).toBe(6);
    const hr1 = recs.get("HR1");
    expect(hr1?.authors).toEqual(["Hunt", "Reffert"]);
    expect(hr1?.doi).toBe("10.1051/0004-6361/202039341");
    expect(hr1?.journal?.includes("Astronomy")).toBeTruthy();
    const hu = recs.get("Huisjes2025");
    expect(hu?.arxivId).toBe("2603.03522");
    expect(hu?.journal, "arXiv e-prints journal flattened to None").toBeNull();
    expect(hu?.authors[1]?.includes("á"), `latex accent decoded: ${hu?.authors}`).toBe(true);
    const g = recs.get("GaiaDR3");
    expect(g?.authors[0], `group author kept whole: ${g?.authors[0]}`).toBe("Gaia Collaboration");
    expect(g?.arxivId === "2208.00211" && (g.doi?.endsWith("202243940") ?? false)).toBe(true);
    expect(recs.get("Perryman1998")?.authors).not.toContain("others");
  });

  test("test_acq_planner_aanda_needs_adapter", () => {
    // MS1: the HTML adapters are archived (ocr-features) and the live sites are
    // bot-walled — journal HTML is never READY on main.
    const p = planSources({
      doi: "10.1051/0004-6361/202039341",
      title: "x",
      year: 2021,
      journal: "A&A",
    });
    expect(p.chosen?.tier).toBe("journal_html");
    expect(p.chosen?.status).toBe("needs_adapter");
    expect(p.publisher).toBe("EDP Sciences");
  });

  test("test_acq_planner_mnras_needs_adapter", () => {
    // MNRAS (incl. legacy Wiley DOIs) had the OUP adapter; archived now.
    const p = planSources({
      doi: "10.1046/j.1365-8711.2001.04022.x",
      title: "imf",
      year: 2001,
      journal: "MNRAS",
    });
    expect(p.chosen?.tier).toBe("journal_html");
    expect(p.chosen?.status).toBe("needs_adapter");
    const tiers = p.candidates.map((c) => c.tier);
    expect(tiers).toContain("journal_pdf");
    expect(tiers, `modern MNRAS has no ADS-scan tier: ${tiers}`).not.toContain("ads_scan");
  });

  test("test_acq_planner_iop_blocked_routes_to_arxiv", () => {
    const p = planSources({
      doi: "10.3847/1538-4357/836/2/152",
      arxivId: "1610.08981",
      title: "rar",
      year: 2017,
    });
    expect(p.chosen?.tier).toBe("arxiv_latex");
    const html = p.candidates.find((c) => c.tier === "journal_html");
    expect(html?.status).toBe("blocked");
  });

  test("test_acq_planner_aps_blocked_no_arxiv_needs_upload", () => {
    const p = planSources({ doi: "10.1103/PhysRevLett.117.201101", title: "rar", year: 2016 });
    const d = planToDict(p);
    expect(d.status).toBe("blocked");
    expect(d.needs_upload).toBe(true);
    expect(d.chosen, "blocked tier surfaced as chosen").toBe("journal_html");
  });

  test("test_acq_planner_arxiv_only", () => {
    const p = planSources({ arxivId: "2603.03522", title: "x", year: 2025 });
    expect(p.chosen?.tier).toBe("arxiv_latex");
    expect(p.chosen?.status).toBe("ready");
  });

  test("test_acq_planner_old_chicago_scan", () => {
    const p = planSources({ doi: "10.1086/161130", title: "mond", year: 1983 });
    expect(p.chosen?.tier).toBe("ads_scan");
    const tiers = p.candidates.map((c) => c.tier);
    expect(tiers, `legacy UChicago has no digital tiers: ${tiers}`).not.toContain("journal_html");
    expect(tiers).not.toContain("journal_pdf");
  });

  test("test_acq_planner_arxiv_is_the_ready_tier", () => {
    // was test_acq_planner_html_beats_arxiv: with the adapters archived, the
    // journal-HTML candidate stays top-priority *chosen* (needs_adapter) but
    // arXiv LaTeX is the tier fetchable now.
    const p = planSources({
      doi: "10.1051/0004-6361/202243940",
      arxivId: "2208.00211",
      title: "gaia dr3",
      year: 2023,
      journal: "A&A",
    });
    expect(p.chosen?.tier).toBe("journal_html");
    expect(p.chosen?.status).toBe("needs_adapter");
    expect(p.ready?.tier).toBe("arxiv_latex");
  });

  test("test_acq_classify_aas_subjournal", () => {
    let [, label] = classify("10.3847/1538-4365/abc", null);
    expect(label).toBe("ApJS");
    [, label] = classify("10.3847/1538-3881/abd806", null);
    expect(label).toBe("AJ");
  });

  test("test_crossref_normalize", () => {
    const msg = {
      DOI: "10.1051/0004-6361/202039341",
      title: ["Improving the open cluster census. I."],
      author: [
        { family: "Hunt", given: "E. L." },
        { family: "Reffert", given: "S." },
      ],
      "container-title": ["Astronomy & Astrophysics"],
      issued: { "date-parts": [[2021, 2]] },
      type: "journal-article",
      "is-referenced-by-count": 142,
      "references-count": 60,
      reference: [{ DOI: "10.1051/0004-6361/201833476" }, { key: "ref2-no-doi" }],
      link: [
        {
          URL: "https://www.aanda.org/aa39341-20.html",
          "content-type": "text/html",
          "intended-application": "text-mining",
        },
      ],
      resource: { primary: { URL: "https://doi.org/10.1051/0004-6361/202039341" } },
    };
    const n = normalizeCrossref(msg);
    expect(n.cited_by_count).toBe(142);
    expect(n.year).toBe(2021);
    expect(n.authors).toEqual(["Hunt", "Reffert"]);
    expect(n.reference_dois).toEqual(["10.1051/0004-6361/201833476"]);
    expect(n.links).toHaveLength(1);
    expect(n.links[0]?.content_type).toBe("text/html");
  });

  // Python `_StubSrc`: a MetadataSource stub whose resolve returns a fixed payload.
  function stubSrc<T>(
    payload: T | null,
    status: "ok" | "no-token" | "unauthorized" | "error" = "ok"
  ) {
    return {
      status,
      resolve: async () => payload,
      fetchMany: async () => new Map<string, OpenAlexResolution>(),
    };
  }

  test("test_resolve_chain_ads_count_wins", async () => {
    const w: Work = {
      ...emptyWork("doi:10.1051/0004-6361/202039341"),
      doi: "10.1051/0004-6361/202039341",
      title: "x",
    };
    const ads = stubSrc<AdsResolution>({
      bibcode: "2021A&A...646A.104H",
      doi: null,
      title: "x",
      authors: ["Hunt", "Reffert"],
      year: 2021,
      venue: "A&A",
      citation_count: 200,
      abstract: null,
      references: ["a", "b", "c"],
    });
    const cr = stubSrc<CrossrefResolution>({
      doi: "10.1051/0004-6361/202039341",
      title: "x",
      authors: [],
      year: 2021,
      venue: "A&A",
      type: "article",
      cited_by_count: 150,
      reference_dois: ["x", "y"],
      n_references: 2,
      abstract: null,
      links: [{ url: "u", content_type: "", intended: "" }],
      resource_url: null,
    });
    const oa = stubSrc<OpenAlexResolution>({
      openalex_id: "W1",
      doi: "10.1051/0004-6361/202039341",
      title: "x",
      authors: [],
      year: 2021,
      venue: "A&A",
      type: "article",
      cited_by_count: 100,
      referenced_works: ["W2", "W3"],
      abstract: null,
      arxiv_id: null,
    });
    const prov = await resolveWork(w, { ads, crossref: cr, oa });
    expect(w.cited_by_count, "ADS count wins").toBe(200);
    expect(prov.count).toBe("ads");
    expect(w.bibcode, "bibcode set from ADS").toBe("2021A&A...646A.104H");
    expect(w.openalex_id).toBe("W1");
    expect(w.referenced_works, "OpenAlex ids kept for graph").toEqual(["W2", "W3"]);
    expect(prov.providers).toEqual(["ads", "crossref", "openalex"]);
  });

  test("test_resolve_chain_crossref_when_ads_empty", async () => {
    const w: Work = { ...emptyWork("doi:x"), doi: "10.1093/mnras/xxx", title: "y" };
    const ads = stubSrc<AdsResolution>(null, "no-token");
    const cr = stubSrc<CrossrefResolution>({
      doi: "10.1093/mnras/xxx",
      title: "y",
      authors: ["Kroupa"],
      year: 2001,
      venue: "MNRAS",
      type: "article",
      cited_by_count: 5000,
      reference_dois: [],
      n_references: 0,
      abstract: null,
      links: [],
      resource_url: null,
    });
    const oa = stubSrc<OpenAlexResolution>({
      openalex_id: "W9",
      doi: null,
      title: "y",
      authors: [],
      year: 2001,
      venue: "MNRAS",
      type: "article",
      cited_by_count: 4800,
      referenced_works: [],
      abstract: null,
      arxiv_id: null,
    });
    const prov = await resolveWork(w, { ads, crossref: cr, oa });
    expect(w.cited_by_count, "crossref count wins when ADS empty").toBe(5000);
    expect(prov.count).toBe("crossref");
    expect(w.authors, "authors filled from crossref").toEqual(["Kroupa"]);
    expect(prov.providers).toEqual(["crossref", "openalex"]);
  });
});

// --------------------------------------------------------------------------- //
// Store round-trip against the real data/library/library.json (fixture copy)
// --------------------------------------------------------------------------- //

describe("library store round-trip", () => {
  test("library.json + library.bib round-trip losslessly", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "m1b-store-"));
    const paths = libraryPaths(dataDir);
    mkdirSync(paths.libraryDir, { recursive: true });
    copyFileSync(join(FIXTURES, "library.json"), paths.libraryJson);

    const store = LibraryStore.load(paths);
    store.save(paths);

    const want = JSON.parse(readFileSync(join(FIXTURES, "library.json"), "utf8"));
    const got = JSON.parse(readFileSync(paths.libraryJson, "utf8"));
    expect(got).toEqual(want);

    // the regenerated BibTeX export is byte-identical to the Python-written one
    const bib = readFileSync(paths.libraryBib, "utf8");
    expect(bib).toBe(readFileSync(join(FIXTURES, "library.bib"), "utf8"));
    expect(bib).toBe(store.toBibtex());
  });
});

// --------------------------------------------------------------------------- //
// API projection: note passthrough (Stage 3 / MS3 — no longer a boolean)
// --------------------------------------------------------------------------- //

describe("workToRef note projection", () => {
  test("the note text passes through verbatim; the key is absent when unset/empty", () => {
    const w = emptyWork("work:noted");
    w.note = "line one\nline two";
    expect(workToRef(w).note).toBe("line one\nline two");
    expect("note" in workToRef(emptyWork("work:plain"))).toBe(false);
    const wEmpty = emptyWork("work:empty-note");
    wEmpty.note = "";
    expect("note" in workToRef(wEmpty)).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// API projection: doc_ids version list (Stage 7 MS3 — doc_ids[0] = main doc)
// --------------------------------------------------------------------------- //

describe("workToRef doc_ids projection", () => {
  test("all docs listed in stored order, doc_id mirrors doc_ids[0]; absent when none", () => {
    const w = emptyWork("work:versioned");
    w.doc_ids = ["upload-work-versioned-a1b2c3", "arxiv-2603.03522"];
    const ref = workToRef(w);
    expect(ref.doc_ids).toEqual(["upload-work-versioned-a1b2c3", "arxiv-2603.03522"]);
    expect(ref.doc_id).toBe("upload-work-versioned-a1b2c3");
    expect("doc_ids" in workToRef(emptyWork("work:plain"))).toBe(false);
  });
});

// --------------------------------------------------------------------------- //
// enrichAndPlan cite_key semantics (Stage 7 MS1: assign-only, never rewrite)
// --------------------------------------------------------------------------- //

describe("enrichAndPlan cite_key (assign-only)", () => {
  const nullSources = {
    ads: { status: "no-token" as const, resolve: async () => null },
    crossref: { status: "ok" as const, resolve: async () => null },
    oa: {
      status: "ok" as const,
      resolve: async () => null,
      fetchMany: async () => new Map(),
    },
  };

  function kroupa(id: string): Work {
    const w = emptyWork(id);
    w.title = "On the variation of the initial mass function";
    w.authors = ["Kroupa"];
    w.year = 2001;
    return w;
  }

  test("an existing cite_key is never rewritten", async () => {
    const store = new LibraryStore([kroupa("work:a"), kroupa("work:b")]);
    const [a, b] = store.works;
    if (a === undefined || b === undefined) throw new Error("works missing");
    a.cite_key = "custom-key";
    await enrichAndPlan(store, nullSources);
    expect(a.cite_key).toBe("custom-key");
    expect(b.cite_key).toBe("kroupa2001");
  });

  test("a new work's assignment avoids keys already in the store", async () => {
    const store = new LibraryStore([kroupa("work:a"), kroupa("work:b"), kroupa("work:c")]);
    const [a, b, c] = store.works;
    if (a === undefined || b === undefined || c === undefined) throw new Error("works missing");
    a.cite_key = "kroupa2001";
    await enrichAndPlan(store, nullSources);
    expect(a.cite_key).toBe("kroupa2001");
    expect(b.cite_key).toBe("kroupa2001a");
    expect(c.cite_key).toBe("kroupa2001b");
  });
});

// --------------------------------------------------------------------------- //
// addDoiWork (Stage 7 MS4): CLI `ingest <doi>` → docless library stub entry
// --------------------------------------------------------------------------- //

describe("addDoiWork (Stage 7 MS4 DOI stub entries)", () => {
  const CR: CrossrefResolution = {
    doi: "10.1051/0004-6361/202039341",
    title: "Improving the open cluster census. I.",
    authors: ["Hunt", "Reffert"],
    year: 2021,
    venue: "Astronomy & Astrophysics",
    type: "article",
    cited_by_count: 142,
    reference_dois: [],
    n_references: 0,
    abstract: null,
    links: [],
    resource_url: null,
  };
  const crStub = (payload: CrossrefResolution | null, calls?: { n: number }) => ({
    resolve: async () => {
      if (calls) calls.n += 1;
      return payload;
    },
  });
  const tmpPaths = () => libraryPaths(mkdtempSync(join(tmpdir(), "ms4-doi-")));

  test("creates an enriched, docless, persisted work", async () => {
    const paths = tmpPaths();
    const r = await addDoiWork(paths, "10.1051/0004-6361/202039341", crStub(CR));
    expect(r?.created).toBe(true);
    expect(r?.enriched).toBe(true);
    expect(r?.ref.id).toBe("doi:10.1051/0004-6361/202039341");
    expect(r?.ref.pdf, "no reader doc yet").toBe(false);
    const w = LibraryStore.load(paths).get("doi:10.1051/0004-6361/202039341");
    expect(w?.title).toBe("Improving the open cluster census. I.");
    expect(w?.authors).toEqual(["Hunt", "Reffert"]);
    expect(w?.year).toBe(2021);
    expect(w?.journal, "publisher-classified short label").toBe("A&A");
    expect(w?.venue).toBe("A&A");
    expect(w?.cited_by_count).toBe(142);
    expect(w?.origin).toBe("manual");
    expect(w?.cite_key).toBe("hunt2021");
    expect(w?.doc_ids).toEqual([]);
    expect(w?.acquisition, "acquisition plan stamped without a rebuild").not.toBeNull();
  });

  test("Crossref null (offline / no record) → bare stub, still persisted", async () => {
    const paths = tmpPaths();
    const r = await addDoiWork(paths, "10.9999/nowhere", crStub(null));
    expect(r?.created).toBe(true);
    expect(r?.enriched).toBe(false);
    expect(r?.ref.id).toBe("doi:10.9999/nowhere");
    const w = LibraryStore.load(paths).get("doi:10.9999/nowhere");
    expect(w?.title).toBe("");
    expect(w?.doi).toBe("10.9999/nowhere");
    expect(w?.cite_key, "key assigned even without metadata").toBeTruthy();
  });

  test("a throwing Crossref client also degrades to a bare stub", async () => {
    const paths = tmpPaths();
    const r = await addDoiWork(paths, "10.9999/boom", {
      resolve: async () => {
        throw new Error("network down");
      },
    });
    expect(r?.created).toBe(true);
    expect(r?.enriched).toBe(false);
    expect(LibraryStore.load(paths).works).toHaveLength(1);
  });

  test("DOI already saved → no fetch, no write, created:false", async () => {
    const paths = tmpPaths();
    await addDoiWork(paths, "10.1051/0004-6361/202039341", crStub(CR));
    const before = readFileSync(paths.libraryJson, "utf8");
    const calls = { n: 0 };
    const r = await addDoiWork(paths, "10.1051/0004-6361/202039341", crStub(CR, calls));
    expect(r?.created).toBe(false);
    expect(r?.ref.id).toBe("doi:10.1051/0004-6361/202039341");
    expect(calls.n, "Crossref not consulted for a known DOI").toBe(0);
    expect(readFileSync(paths.libraryJson, "utf8"), "store untouched").toBe(before);
    expect(LibraryStore.load(paths).works).toHaveLength(1);
  });

  test("DOI matching is case-insensitive (normDoi lowercases both sides)", async () => {
    const paths = tmpPaths();
    const r1 = await addDoiWork(paths, "10.3847/1538-4357/AB1234", crStub(null));
    expect(r1?.created).toBe(true);
    expect(r1?.ref.id, "stored lowercased").toBe("doi:10.3847/1538-4357/ab1234");
    const calls = { n: 0 };
    const r2 = await addDoiWork(paths, "10.3847/1538-4357/ab1234", crStub(null, calls));
    expect(r2?.created).toBe(false);
    expect(calls.n).toBe(0);
    expect(LibraryStore.load(paths).works).toHaveLength(1);
  });

  test("bridges an existing title-only (bib) work instead of duplicating", async () => {
    const paths = tmpPaths();
    const store = new LibraryStore();
    store.upsert({
      ...emptyWork("work:improving-the-open-cluster-census-i-2021"),
      title: "Improving the open cluster census. I.",
      year: 2021,
      origin: "bib",
    });
    store.save(paths);
    const r = await addDoiWork(paths, "10.1051/0004-6361/202039341", crStub(CR));
    const works = LibraryStore.load(paths).works;
    expect(works, "one merged work, not a duplicate").toHaveLength(1);
    const w = works[0];
    expect(w?.doi).toBe("10.1051/0004-6361/202039341");
    expect(w?.origin, "the existing work's origin wins").toBe("bib");
    expect(w?.cite_key).toBe("hunt2021");
    expect(r?.ref.id, "the ref points at the surviving work").toBe(w?.id);
  });

  test("invalid DOI → null (nothing written)", async () => {
    const paths = tmpPaths();
    expect(await addDoiWork(paths, "not-a-doi", crStub(null))).toBeNull();
    expect(LibraryStore.load(paths).works).toHaveLength(0);
  });
});

describe("removeDocFromWorks (Stage 8 document delete)", () => {
  const tmpPaths = () => libraryPaths(mkdtempSync(join(tmpdir(), "ms8-rmdoc-")));

  /** Two works both holding "shared-doc" (identity-merge precedent), plus a
   *  third that doesn't. */
  function seedLibrary(paths: ReturnType<typeof libraryPaths>): void {
    const store = new LibraryStore();
    store.upsert({
      ...emptyWork("arxiv:2603.03522"),
      title: "Work A",
      doc_ids: ["shared-doc", "a-old"],
    });
    store.upsert({
      ...emptyWork("doi:10.1051/0004-6361/202453302"),
      title: "Work B",
      doc_ids: ["b-main", "shared-doc"],
    });
    store.upsert({ ...emptyWork("arxiv:2603.00229"), title: "Work C", doc_ids: ["c-doc"] });
    store.save(paths);
  }

  test("removes the doc from every work; remaining doc_ids[0] becomes the main doc", () => {
    const paths = tmpPaths();
    seedLibrary(paths);
    expect(removeDocFromWorks(paths, "shared-doc")).toBe(true);
    const store = LibraryStore.load(paths);
    expect(store.get("arxiv:2603.03522")?.doc_ids).toEqual(["a-old"]);
    expect(store.get("doi:10.1051/0004-6361/202453302")?.doc_ids).toEqual(["b-main"]);
    expect(store.get("arxiv:2603.00229")?.doc_ids).toEqual(["c-doc"]); // untouched
  });

  test("an unknown doc is a side-effect-free no-op (no save, returns false)", () => {
    const paths = tmpPaths();
    seedLibrary(paths);
    const before = readFileSync(paths.libraryJson, "utf8");
    expect(removeDocFromWorks(paths, "ghost-doc")).toBe(false);
    expect(readFileSync(paths.libraryJson, "utf8")).toBe(before);
  });
});
