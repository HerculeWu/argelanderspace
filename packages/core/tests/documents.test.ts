/**
 * Documents-domain tests over hand-built Documents: annotate (token
 * application), citations, crossrefs (incl. the dormant hyperlink-enrichment
 * halves), traverse, and `documentToJson` serialization.
 *
 * The PDF-pipeline half of the old suite (buildDocument / buildStructure /
 * repairText / classifyDest / parseReferences over MinerU fixtures) left with
 * the OCR pipeline — archived on the `ocr-features` branch.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Block,
  Document,
  ListBlock,
  ParagraphBlock,
  Section,
} from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { applyMatches, isCitation, type Match } from "../src/documents/annotate.js";
import {
  detectCitations,
  enrichCitationsWithLinks,
  ReferenceResolver,
} from "../src/documents/citations.js";
import {
  detectCrossrefs,
  enrichCrossrefsWithLinks,
  XrefIndex,
} from "../src/documents/crossrefs.js";
import { annotatable, documentToJson } from "../src/documents/document.js";
import type { LinkAnnot } from "../src/documents/geom.js";
import { type ParsedReference, parseOne } from "../src/documents/references.js";
import { iterBlocks, iterSectionBlocks, iterSections } from "../src/documents/traverse.js";

// --------------------------------------------------------------------------- //
// Hand-built docs + the (regex-only) annotate pass, mirroring the LaTeX pipeline
// --------------------------------------------------------------------------- //

function para(id: string, text: string): ParagraphBlock {
  return { id, type: "paragraph", page_idx: 0, text };
}

/** The shared annotate stage: detect → apply, no link enrichment. */
function annotateDoc(doc: Document): void {
  const resolver = new ReferenceResolver(doc.references ?? []);
  const xindex = new XrefIndex(doc);
  for (const block of iterBlocks(doc)) {
    for (const holder of annotatable(block)) {
      if (!holder.text) continue;
      const result = applyMatches(holder.text, [
        ...detectCitations(holder.text, resolver),
        ...detectCrossrefs(holder.text, xindex),
      ]);
      holder.text = result.text;
      holder.citations = result.citations;
      holder.crossrefs = result.crossrefs;
    }
  }
}

function buildDoc(sections: Section[], references: ParsedReference[]): Document {
  const doc: Document = { doc_id: "syn", structure: sections, references };
  annotateDoc(doc);
  return doc;
}

/** The sample references (A&A author-year style), parsed by the real parser. */
function sampleRefs(): ParsedReference[] {
  return [
    parseOne(
      "ref-1",
      "Hunt, E. L. & Reffert, S. 2021, A&A, 646, A104. doi:10.1051/0004-6361/202039341",
      undefined
    ),
    parseOne("ref-2", "Cantat-Gaudin T., Anders F., 2020, A&A, 640, A1.", undefined),
  ];
}

/** sec-1 Introduction + sec-2 Methods + Appendix A, with one float per kind. */
function sampleSections(): Section[] {
  const list: ListBlock = {
    id: "l-1",
    type: "list",
    ordered: false,
    page_idx: 0,
    items: [{ text: "See Figure 1 and (Hunt & Reffert 2021)." }],
  };
  return [
    {
      id: "sec-1",
      type: "section",
      level: 1,
      heading: "Introduction",
      number: "1",
      page_idx: 0,
      blocks: [
        para(
          "p-1",
          "We compare with the radial acceleration relation (Hunt & Reffert 2021; " +
            "Cantat-Gaudin et al. 2020). Numbers like [0, 1] stay plain. See Figure 1, " +
            "Table 1, Eq. (1) and Section 2."
        ),
        para("p-2", "Abstract. Hunt & Reffert (2021) showed this (Cantat-Gaudin et al. 2020)."),
        {
          id: "fig-1",
          type: "figure",
          number: "1",
          label: "Figure 1",
          page_idx: 0,
          bbox: [60, 60, 480, 270],
          caption: { text: "The radial acceleration relation (Hunt & Reffert 2021)." },
        },
        {
          id: "tab-1",
          type: "table",
          number: "1",
          label: "Table 1",
          page_idx: 0,
          caption: { text: "Cluster sample." },
        },
        {
          id: "eq-1",
          type: "equation",
          number: "1",
          label: "eq:rad",
          page_idx: 0,
          latex: "E = m c^2",
        },
        list,
      ],
    },
    {
      id: "sec-2",
      type: "section",
      level: 1,
      heading: "Methods",
      number: "2",
      page_idx: 1,
      blocks: [
        para("p-3", "We use the algorithm (Algorithm 1) and Listing 1 throughout."),
        { id: "alg-1", type: "algorithm", number: "1", page_idx: 1, body: "step" },
        { id: "code-1", type: "code", number: "1", page_idx: 1, body: "print(1)" },
      ],
    },
    {
      id: "sec-a",
      type: "section",
      level: 1,
      heading: "Appendix A",
      heading_raw: "Appendix A",
      page_idx: 2,
      blocks: [para("p-4", "Subsection content; see Appendix A for details.")],
    },
  ];
}

function findParagraph(doc: Document, needle: string): ParagraphBlock | undefined {
  for (const b of iterBlocks(doc)) {
    if (b.type === "paragraph" && b.text.includes(needle)) return b;
  }
  return undefined;
}

function firstBlock<T extends Block["type"]>(
  doc: Document,
  btype: T
): Extract<Block, { type: T }> | undefined {
  for (const b of iterBlocks(doc)) {
    if (b.type === btype) return b as Extract<Block, { type: T }>;
  }
  return undefined;
}

// --------------------------------------------------------------------------- //
describe("documents domain", () => {
  test("citations: author-year narrative + parenthetical; [0, 1] stays plain", () => {
    const doc = buildDoc(sampleSections(), sampleRefs());
    const resolver = new ReferenceResolver(doc.references ?? []);
    expect(resolver.authorYear).toBe(true);
    expect(resolver.numbered).toBe(false);
    const intro = findParagraph(doc, "radial acceleration relation");
    expect(intro).toBeDefined();
    expect(intro?.text).toContain("[[cite:ref-1;ref-2]]");
    expect(intro?.citations).toHaveLength(1);
    expect(new Set(intro?.citations?.[0]?.ref_ids)).toEqual(new Set(["ref-1", "ref-2"]));
    // [0, 1] must NOT be a citation (author-year style)
    expect(intro?.text.split("Numbers like")[1] ?? "").not.toContain("[[cite:");
    // narrative + parenthetical both tokenized
    const abs = findParagraph(doc, "Abstract");
    expect(abs).toBeDefined();
    expect(abs?.text.match(/\[\[cite:/g) ?? []).toHaveLength(2);
  });

  test("citations: numbered labels tokenize when the bibliography is numbered", () => {
    const refs = [
      parseOne("ref-1", '[1] A. Smith, "A title," Journal, 2019.', "1"),
      parseOne("ref-2", "[2] B. Jones and C. Lee, Another, 2020. doi:10.1/x", "2"),
    ];
    const doc = buildDoc(
      [
        {
          id: "sec-1",
          type: "section",
          level: 1,
          heading: "Intro",
          number: "1",
          blocks: [para("p-1", "As shown [1, 2] and earlier [1].")],
        },
      ],
      refs
    );
    const p = findParagraph(doc, "As shown");
    expect(p?.text).toContain("[[cite:ref-1;ref-2]]");
    expect(p?.text).toContain("[[cite:ref-1]]");
  });

  test("crossrefs: figure/table/equation/section/appendix resolve by number", () => {
    const doc = buildDoc(sampleSections(), sampleRefs());
    const intro = findParagraph(doc, "radial acceleration relation");
    expect(intro?.text).toContain("[[xref:fig-1]]");
    expect(intro?.text).toContain("[[xref:tab-1]]");
    expect(intro?.text).toContain("[[xref:eq-1]]");
    expect(intro?.text).toContain("[[xref:sec-2]]");
    const kinds = new Set((intro?.crossrefs ?? []).map((x) => x.kind));
    expect(kinds.has("figure")).toBe(true);
    expect(kinds.has("table")).toBe(true);
    expect(kinds.has("equation")).toBe(true);
    expect(kinds.has("section")).toBe(true);
    // methods paragraph: algorithm + listing
    const meth = findParagraph(doc, "We use the algorithm");
    expect(meth?.text).toContain("[[xref:alg-1]]");
    expect(meth?.text).toContain("[[xref:code-1]]");
    // appendix reference resolves (both "appendix" and "section" keys map it)
    const sub = findParagraph(doc, "Subsection content");
    expect(new Set((sub?.crossrefs ?? []).map((x) => x.kind)).has("appendix")).toBe(true);
    expect((sub?.crossrefs ?? []).every((x) => x.resolved)).toBe(true);
  });

  test("list items and captions are annotated; the float's own label is not self-tokenized", () => {
    const doc = buildDoc(sampleSections(), sampleRefs());
    const lst = firstBlock(doc, "list");
    const joined = (lst?.items ?? []).map((it) => it.text).join(" ");
    expect(joined).toContain("[[xref:fig-1]]");
    expect(joined).toContain("[[cite:ref-1]]");
    const fig = firstBlock(doc, "figure");
    expect(fig?.caption?.text).toContain("[[cite:ref-1]]");
    expect(fig?.label).toBe("Figure 1");
    expect(fig?.caption?.text).not.toContain("[[xref:fig-1]]");
    expect(fig?.caption?.text.startsWith("The radial")).toBe(true);
  });

  test("unicode author surname resolves (Åström 2019)", () => {
    const doc = buildDoc(
      [
        {
          id: "sec-1",
          type: "section",
          level: 1,
          heading: "Intro",
          number: "1",
          blocks: [para("p-1", "As found by Åström (2019).")],
        },
      ],
      [parseOne("ref-1", "Åström, K. 2019, A&A, 1, 1.", undefined)]
    );
    const p = findParagraph(doc, "As found by");
    expect(p?.citations).toHaveLength(1);
    expect(p?.citations?.[0]?.resolved).toBe(true);
  });

  test("lowercase crossref mentions resolve too", () => {
    const doc = buildDoc(
      [
        {
          id: "sec-1",
          type: "section",
          level: 1,
          heading: "Intro",
          number: "1",
          blocks: [
            para("p-1", "see figure 1 and table 1 and section 2."),
            { id: "fig-1", type: "figure", number: "1", page_idx: 0, caption: { text: "x" } },
            { id: "tab-1", type: "table", number: "1", page_idx: 0, caption: { text: "y" } },
          ],
        },
        {
          id: "sec-2",
          type: "section",
          level: 1,
          heading: "Methods",
          number: "2",
          blocks: [],
        },
      ],
      []
    );
    const p = findParagraph(doc, "see");
    const kinds = new Set((p?.crossrefs ?? []).map((x) => x.kind));
    expect(kinds.has("figure")).toBe(true);
    expect(kinds.has("table")).toBe(true);
    expect(kinds.has("section")).toBe(true);
    expect((p?.crossrefs ?? []).every((x) => x.resolved)).toBe(true);
  });

  test("unresolved xref becomes a typed placeholder token", () => {
    const doc = buildDoc(
      [
        {
          id: "sec-1",
          type: "section",
          level: 1,
          heading: "Intro",
          number: "1",
          blocks: [para("p-1", "As in Fig. 9 we see.")],
        },
      ],
      []
    );
    const p = findParagraph(doc, "we see");
    expect(p?.text).toContain("[[xref:figure-9?]]");
    expect(p?.crossrefs?.[0]?.resolved).toBe(false);
  });

  test("xref index indexes floats + sections only, never paragraphs", () => {
    const doc = buildDoc(sampleSections(), sampleRefs());
    const idx = new XrefIndex(doc);
    const floatIds = new Set<string>();
    for (const b of iterBlocks(doc)) {
      if (["figure", "table", "equation", "code", "algorithm"].includes(b.type)) {
        floatIds.add(b.id);
      }
    }
    const secIds = new Set<string>();
    for (const s of iterSections(doc)) secIds.add(s.id);
    for (const box of idx.boxes) {
      expect(floatIds.has(box.id) || secIds.has(box.id)).toBe(true);
    }
  });

  test("applyMatches: a nested shorter match is dropped in favor of the longer one", () => {
    const text = "see (Smith 2019) here";
    const mLong: Match = {
      start: 4,
      end: 16, // the whole parenthetical
      occ: { ref_ids: ["ref-1"], raw: "(Smith 2019)", via: "regex", resolved: true },
    };
    const mShort: Match = {
      start: 5,
      end: 15, // nested, should be dropped
      occ: { kind: "section", raw: "Smith 2019", number: "1", via: "regex", resolved: false },
    };
    const { text: newText, citations, crossrefs } = applyMatches(text, [mShort, mLong]);
    expect(newText).toBe("see [[cite:ref-1]] here");
    expect(citations).toHaveLength(1);
    expect(crossrefs).toHaveLength(0);
  });

  // ---- hyperlink enrichment (dormant on main; no PDF link harvest) ---------- //

  test("link enrichment: a corroborating target is consumed, never reused", () => {
    const refs: ParsedReference[] = [
      { id: "ref-1", raw: "r1", doi: "10.1/a" },
      { id: "ref-2", raw: "r2", doi: "10.2/b" },
    ];
    const resolver = new ReferenceResolver(refs);
    const links: LinkAnnot[] = [
      { pageIdx: 0, rect: [0.1, 0.1, 0.2, 0.12], kind: "uri", uri: "x", doi: "10.1/a" },
      { pageIdx: 0, rect: [0.3, 0.1, 0.4, 0.12], kind: "uri", uri: "y", doi: "10.2/b" },
    ];
    const m1: Match = {
      start: 0,
      end: 5,
      occ: { ref_ids: ["ref-1"], raw: "a", via: "regex", resolved: true },
    };
    const m2: Match = {
      start: 6,
      end: 11,
      occ: { ref_ids: [], raw: "b", via: "regex", resolved: false },
    };
    enrichCitationsWithLinks([m1, m2], links, resolver);
    expect(isCitation(m1.occ) && m1.occ.via === "hyperlink+regex").toBe(true);
    expect(isCitation(m2.occ) && m2.occ.ref_ids?.join(",") === "ref-2").toBe(true);
  });

  test("link enrichment: a GoTo link resolves an otherwise unresolved xref by position", () => {
    // an unnumbered equation: no (kind, number) resolution, only its bbox box
    const doc: Document = {
      doc_id: "syn",
      structure: [
        {
          id: "sec-1",
          type: "section",
          level: 1,
          heading: "Intro",
          number: "1",
          blocks: [
            { id: "p-1", type: "paragraph", page_idx: 0, text: "See Eq. (1) for details." },
            { id: "eq-1", type: "equation", page_idx: 0, bbox: [300, 400, 700, 450], latex: "x" },
          ],
        },
      ],
      references: [],
    };
    const xindex = new XrefIndex(doc);
    const p = findParagraph(doc, "for details");
    if (p === undefined) throw new Error("no paragraph");
    const xmatches = detectCrossrefs(p.text, xindex);
    expect(xmatches).toHaveLength(1);
    const links: LinkAnnot[] = [
      {
        pageIdx: 0,
        rect: [0.15, 0.12, 0.25, 0.14],
        kind: "goto",
        targetPage: 0,
        targetPoint: [0.5, 0.425],
      },
    ];
    enrichCrossrefsWithLinks(xmatches, links, xindex);
    const result = applyMatches(p.text, xmatches);
    expect(result.crossrefs[0]?.target_id).toBe("eq-1");
    expect(result.crossrefs[0]?.resolved).toBe(true);
    expect(result.crossrefs[0]?.via).toBe("hyperlink");
    expect(result.text).toContain("[[xref:eq-1]]");
  });

  test("link enrichment: a cite.* named destination resolves an undetected reference", () => {
    const ref = parseOne("ref-1", "Different, A. 2019, Some Journal, 1, 1.", undefined);
    ref.src_page = 0;
    ref.src_bbox = [100, 230, 900, 260];
    const resolver = new ReferenceResolver([ref]);
    const text = "We follow (Smith & Jones 2019) here.";
    const cmatches = detectCitations(text, resolver);
    expect(cmatches).toHaveLength(1);
    expect(cmatches[0]?.occ.resolved).toBe(false);
    const links: LinkAnnot[] = [
      {
        pageIdx: 0,
        rect: [0.2, 0.11, 0.3, 0.13],
        kind: "goto",
        targetPage: 0,
        targetPoint: [0.5, 0.245],
        destName: "cite.Smith2019",
        destKind: "cite",
      },
    ];
    enrichCitationsWithLinks(cmatches, links, resolver);
    const occ = cmatches[0]?.occ;
    if (occ === undefined || !isCitation(occ)) throw new Error("expected a citation occurrence");
    expect(occ.ref_ids).toEqual(["ref-1"]);
    expect(occ.resolved).toBe(true);
    expect(occ.via).toBe("hyperlink");
  });

  // ---- traverse + serialization -------------------------------------------- //

  test("iterSectionBlocks walks one subtree in order", () => {
    const doc = buildDoc(sampleSections(), sampleRefs());
    const intro = doc.structure?.[0];
    expect(intro).toBeDefined();
    if (intro === undefined) return;
    expect([...iterSectionBlocks(intro)].map((b) => b.id)).toEqual([
      "p-1",
      "p-2",
      "fig-1",
      "tab-1",
      "eq-1",
      "l-1",
    ]);
    expect([...iterSections(doc)].map((s) => s.id)).toEqual(["sec-1", "sec-2", "sec-a"]);
  });

  test("full JSON serialization round-trips with computed stats", () => {
    interface SampleJson {
      stats: Record<string, number>;
      index: { figures: unknown[]; sections: unknown[] };
      structure: Array<{ blocks?: Array<{ type?: string; page_idx?: number | null }> }>;
    }
    const doc = buildDoc(sampleSections(), sampleRefs());
    const d = documentToJson(doc, true);
    // round-trips through JSON
    const d2 = JSON.parse(JSON.stringify(d)) as SampleJson;
    expect(d2.stats.n_sections).toBe(3);
    expect(d2.stats.n_references).toBe(2);
    expect(d2.stats.n_figures).toBe(1);
    expect(d2.stats.n_citations).toBeGreaterThanOrEqual(4);
    expect(d2.stats.n_crossrefs).toBeGreaterThanOrEqual(6);
    expect(d2.stats.n_citations_resolved).toBe(d2.stats.n_citations);
    expect(d2.index.figures).toHaveLength(1);
    expect(d2.index.sections).toHaveLength(3);
    const allParagraphsHavePageIdx = d2.structure.every((s) =>
      (s.blocks ?? []).every(
        (b) => b.type !== "paragraph" || (b.page_idx !== null && b.page_idx !== undefined)
      )
    );
    expect(allParagraphsHavePageIdx).toBe(true);
    // the Python suite writes sample_output.json next to the fixture for manual
    // inspection; the port keeps it out of the repo (system temp dir).
    writeFileSync(join(tmpdir(), "sample_output.json"), JSON.stringify(d, null, 2), "utf8");
  });
});
