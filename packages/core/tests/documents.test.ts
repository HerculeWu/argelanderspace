/**
 * Vitest port of the documents-domain tests from `<repo>/tests/run_tests.py` (the
 * offline Python suite is the specification; one `test(...)` per Python test
 * function, same checks, same order).
 *
 * Python baseline (2026-08-26, astro env): 210 checks passed, 0 failed across 58
 * test functions. The 21 documents-domain functions are ported here. The rest are
 * deferred to their owning milestones (they cover modules outside M1a, not PDF
 * plumbing):
 * - test_html_* (12) — HTML pipeline (bibgraph/ingest_html) → M3
 * - test_latex_* (13) — LaTeX pipeline (bibgraph/ingest_latex, needs pandoc) → M3
 * - test_acq_* (9) — acquisition planner/bibtex (library domain) → M1b
 * - test_crossref_normalize, test_resolve_chain_* (3) — library sources/resolve → M1b
 *
 * No documents test was skipped: the whole documents suite runs offline. Note the
 * Python suite's textfix path is exercised here with `pdfText` absent, matching the
 * Python tests where fitz cannot open the (nonexistent) fixture PDF and textfix
 * degrades to recorded zero stats.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Block, Document, ParagraphBlock, Reference } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { applyMatches, isCitation, type Match } from "../src/documents/annotate.js";
import { enrichCitationsWithLinks, ReferenceResolver } from "../src/documents/citations.js";
import { XrefIndex } from "../src/documents/crossrefs.js";
import { buildDocument, documentToJson } from "../src/documents/document.js";
import type { MineruArtifacts, MineruContentItem } from "../src/documents/mineru.js";
import { classifyDest, type LinkAnnot, type PdfLinks } from "../src/documents/pdf-links.js";
import { parseReferences } from "../src/documents/references.js";
import { buildStructure, FIG_NUM_RE, splitCaption } from "../src/documents/structure.js";
import { repairText } from "../src/documents/textfix.js";
import { iterBlocks, iterSectionBlocks, iterSections } from "../src/documents/traverse.js";

const FIXTURES = fileURLToPath(new URL("fixtures", import.meta.url));

function loadFixture(): MineruContentItem[] {
  return JSON.parse(
    readFileSync(join(FIXTURES, "sample_content_list.json"), "utf8")
  ) as MineruContentItem[];
}

/** DOI link sitting over the intro paragraph (page 0), pointing at ref-1. */
function syntheticLinks(): PdfLinks {
  return {
    nPages: 3,
    pageSizes: [
      [612.0, 792.0],
      [612.0, 792.0],
      [612.0, 792.0],
    ],
    links: [
      {
        pageIdx: 0,
        rect: [0.2, 0.25, 0.3, 0.27],
        kind: "uri",
        uri: "https://doi.org/10.1051/0004-6361/202039341",
        doi: "10.1051/0004-6361/202039341",
      },
    ],
    hasText: true,
  };
}

function build(withLinks: boolean): Document {
  const content = loadFixture();
  const mineru: MineruArtifacts = { contentList: content, middle: {}, batchId: "test-batch" };
  const links = withLinks ? syntheticLinks() : null;
  return buildDocument(
    mineru,
    { stem: "sample", path: join(FIXTURES, "sample.pdf"), filename: "sample.pdf" },
    links,
    { usePdfLinks: withLinks, mineru: { isOcr: false } }
  );
}

function buildTiny(
  content: MineruContentItem[],
  stem: string,
  links: PdfLinks | null,
  usePdfLinks: boolean
): Document {
  const mineru: MineruArtifacts = { contentList: content, middle: {} };
  return buildDocument(
    mineru,
    { stem, path: join(FIXTURES, `${stem}.pdf`), filename: `${stem}.pdf` },
    links,
    {
      usePdfLinks,
      mineru: { isOcr: false },
    }
  );
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
describe("documents domain (tests/run_tests.py port)", () => {
  test("test_structure", () => {
    const sr = buildStructure(loadFixture());
    const top = sr.sections;
    const headings = top.map((s) => s.heading);
    expect(sr.titleGuess).toBe("On the dynamics of low-mass open clusters");
    expect(headings).toContain("Introduction");
    expect(headings).toContain("Methods");
    const methods = top.find((s) => s.heading === "Methods");
    expect(methods?.number).toBe("2");
    expect(methods?.children?.some((c) => c.heading === "Data" && c.number === "2.1")).toBe(true);
    expect(sr.refTextItems).toHaveLength(2);
    // floats present
    const types: string[] = [];
    for (const s of top) {
      for (const b of iterSectionBlocks(s)) types.push(b.type);
    }
    for (const t of ["figure", "table", "equation", "algorithm", "code", "list"]) {
      expect(types).toContain(t);
    }
  });

  test("test_references", () => {
    const content = loadFixture();
    const refs = parseReferences(content.filter((c) => c.type === "ref_text"));
    expect(refs).toHaveLength(2);
    const r1 = refs[0];
    expect(r1?.authors?.slice(0, 2)).toEqual(["Hunt", "Reffert"]);
    expect(r1?.year).toBe(2021);
    expect(r1?.doi).toBe("10.1051/0004-6361/202039341");
    const r2 = refs[1];
    expect(r2?.authors?.[0]).toBe("Cantat-Gaudin");
    expect(r2?.year).toBe(2020);
  });

  test("test_references_author_styles", () => {
    // MNRAS/ADS style: "Surname I., Surname I., year"
    const r = parseReferences([
      { type: "ref_text", text: "Banik I., Zhao H., Famaey B., 2018, A&A, 614, A53." },
    ])[0];
    expect(r?.authors?.slice(0, 3)).toEqual(["Banik", "Zhao", "Famaey"]);
    expect(r?.year).toBe(2018);
    // A&A style: "Surname, I. J. & Surname, I."
    const r2 = parseReferences([
      { type: "ref_text", text: "Hunt, E. L. & Reffert, S. 2021, A&A, 646, A104." },
    ])[0];
    expect(r2?.authors).toEqual(["Hunt", "Reffert"]);
    // hyphenated + initials-first
    const r3 = parseReferences([
      { type: "ref_text", text: "Cantat-Gaudin T., Anders F., 2020, A&A, 640, A1." },
    ])[0];
    expect(r3?.authors?.slice(0, 2)).toEqual(["Cantat-Gaudin", "Anders"]);
  });

  test("test_references_numbered", () => {
    const items = [
      { type: "ref_text", text: '[1] A. Smith, "A title," Journal, 2019.' },
      { type: "ref_text", text: "[2] B. Jones and C. Lee, Another, 2020. doi:10.1/x" },
    ];
    const refs = parseReferences(items);
    expect(refs).toHaveLength(2);
    expect(refs[0]?.label).toBe("1");
    expect(refs[1]?.label).toBe("2");
    expect(refs[0]?.title).toBe("A title");
    // split a single merged block with two numbered entries
    const merged = [{ type: "ref_text", text: "[1] First ref 2001. [2] Second ref 2002." }];
    const refs2 = parseReferences(merged);
    expect(refs2).toHaveLength(2);
  });

  test("test_citations_regex", () => {
    const doc = build(false);
    const resolver = new ReferenceResolver(doc.references ?? []);
    expect(resolver.authorYear).toBe(true);
    expect(resolver.numbered).toBe(false);
    // find the intro paragraph (resolved by token presence)
    const intro = findParagraph(doc, "radial acceleration relation");
    expect(intro).toBeDefined();
    expect(intro?.text).toContain("[[cite:ref-1;ref-2]]");
    expect(intro?.citations).toHaveLength(1);
    expect(new Set(intro?.citations?.[0]?.ref_ids)).toEqual(new Set(["ref-1", "ref-2"]));
    // [0, 1] must NOT be a citation (author-year style)
    expect(intro?.text.split("Numbers like")[1] ?? "").not.toContain("[[cite:");
    // abstract narrative + parenthetical
    const abs = findParagraph(doc, "Abstract");
    expect(abs).toBeDefined();
    expect(abs?.text.match(/\[\[cite:/g) ?? []).toHaveLength(2);
  });

  test("test_crossrefs_regex", () => {
    const doc = build(false);
    const intro = findParagraph(doc, "radial acceleration relation");
    const fig = firstBlock(doc, "figure");
    const tab = firstBlock(doc, "table");
    const eq = firstBlock(doc, "equation");
    expect(intro?.text).toContain(`[[xref:${fig?.id}]]`);
    expect(intro?.text).toContain(`[[xref:${tab?.id}]]`);
    expect(intro?.text).toContain(`[[xref:${eq?.id}]]`);
    expect(intro?.text).toContain("[[xref:sec");
    const kinds = new Set((intro?.crossrefs ?? []).map((x) => x.kind));
    expect(kinds.has("figure")).toBe(true);
    expect(kinds.has("table")).toBe(true);
    expect(kinds.has("equation")).toBe(true);
    expect(kinds.has("section")).toBe(true);
    // methods paragraph: algorithm + listing
    const meth = findParagraph(doc, "We use the algorithm");
    const algo = firstBlock(doc, "algorithm");
    const code = firstBlock(doc, "code");
    expect(meth?.text).toContain(`[[xref:${algo?.id}]]`);
    expect(meth?.text).toContain(`[[xref:${code?.id}]]`);
    // appendix reference resolves
    const sub = findParagraph(doc, "Subsection content");
    expect(new Set((sub?.crossrefs ?? []).map((x) => x.kind)).has("appendix")).toBe(true);
    expect((sub?.crossrefs ?? []).every((x) => x.resolved)).toBe(true);
  });

  test("test_list_and_caption_annotation", () => {
    const doc = build(false);
    const lst = firstBlock(doc, "list");
    const joined = (lst?.items ?? []).map((it) => it.text).join(" ");
    expect(joined).toContain("[[xref:");
    expect(joined).toContain("[[cite:ref-1]]");
    const fig = firstBlock(doc, "figure");
    expect(fig?.caption).toBeDefined();
    expect(fig?.caption?.text).toContain("[[cite:ref-1]]");
    // the float's own label must NOT be tokenized as a self cross-reference
    expect(fig?.label).toBe("Figure 1");
    expect(fig?.caption?.text).not.toContain("[[xref:fig-1]]");
    expect(fig?.caption?.text.startsWith("The radial")).toBe(true);
  });

  test("test_hybrid_links_citation", () => {
    const doc = build(true);
    const intro = findParagraph(doc, "radial acceleration relation");
    const via = intro?.citations?.[0]?.via;
    expect(via).toBe("hyperlink+regex");
  });

  test("test_hybrid_links_crossref_goto", () => {
    // tiny doc: a paragraph referencing an unnumbered equation, resolved by GoTo
    const content = [
      { type: "text", text: "See Eq. (1) for details.", page_idx: 0, bbox: [100, 100, 900, 140] },
      { type: "equation", text: "E = m c^2", page_idx: 0, bbox: [300, 400, 700, 450] },
    ];
    const links: PdfLinks = {
      nPages: 1,
      pageSizes: [[612.0, 792.0]],
      links: [
        {
          pageIdx: 0,
          rect: [0.15, 0.12, 0.25, 0.14],
          kind: "goto",
          targetPage: 0,
          targetPoint: [0.5, 0.425],
        },
      ],
      hasText: true,
    };
    const doc = buildTiny(content, "tiny", links, true);
    const para = findParagraph(doc, "for details");
    const eq = firstBlock(doc, "equation");
    expect(para?.crossrefs).toHaveLength(1);
    const xr = para?.crossrefs?.[0];
    expect(xr?.target_id).toBe(eq?.id);
    expect(xr?.resolved).toBe(true);
    expect(xr?.via).toBe("hyperlink");
    expect(para?.text).toContain(`[[xref:${eq?.id}]]`);
  });

  test("test_classify_dest", () => {
    const cases: Array<[string, string | undefined]> = [
      ["cite.2000ApJ...533L..99M", "cite"],
      ["cite.Poggio21", "cite"],
      ["section.7", "section"],
      ["subsection.2.1", "section"],
      ["figure.3", "figure"],
      ["table.1", "table"],
      ["equation.2", "equation"],
      ["Doc-Start", undefined],
      ["Hfootnote.1", undefined],
      ["page.5", undefined],
    ];
    for (const [name, expected] of cases) {
      expect(classifyDest(name)).toBe(expected);
    }
  });

  test("test_named_dest_citation_resolution", () => {
    // A citation regex *detects* but cannot resolve (no matching ref); a hyperref
    // cite.* named link resolves it by pointing at the bib entry.
    const content = [
      {
        type: "text",
        text: "We follow (Smith & Jones 2019) here.",
        page_idx: 0,
        bbox: [100, 100, 900, 140],
      },
      { type: "text", text: "References", text_level: 1, page_idx: 0, bbox: [100, 200, 900, 220] },
      {
        type: "ref_text",
        text: "Different, A. 2019, Some Journal, 1, 1.",
        page_idx: 0,
        bbox: [100, 230, 900, 260],
      },
    ];
    const links: PdfLinks = {
      nPages: 1,
      pageSizes: [[612.0, 792.0]],
      links: [
        {
          pageIdx: 0,
          rect: [0.2, 0.11, 0.3, 0.13],
          kind: "goto",
          targetPage: 0,
          targetPoint: [0.5, 0.245],
          destName: "cite.Smith2019",
          destKind: "cite",
        },
      ],
      hasText: true,
    };
    const doc = buildTiny(content, "named", links, true);
    const para = findParagraph(doc, "We follow");
    expect(para?.citations).toHaveLength(1);
    const c = para?.citations?.[0];
    expect(c?.ref_ids).toEqual(["ref-1"]);
    expect(c?.resolved).toBe(true);
    expect(c?.via).toBe("hyperlink");
    expect(para?.text).toContain("[[cite:ref-1]]");
  });

  test("test_chart_as_figure", () => {
    // MinerU VLM tags plots as type "chart" with chart_caption/content
    const content = [
      {
        type: "chart",
        img_path: "images/c.jpg",
        sub_type: "line",
        content: "| col | col |",
        chart_caption: ["Figure 2. A nice plot."],
        chart_footnote: [],
        page_idx: 0,
        bbox: [60, 60, 480, 270],
      },
      { type: "text", text: "We refer to Fig. 2 here.", page_idx: 0, bbox: [60, 300, 480, 340] },
    ];
    const doc = buildTiny(content, "chart", null, false);
    const fig = firstBlock(doc, "figure");
    expect(fig).toBeDefined();
    expect(fig?.number).toBe("2");
    expect(fig?.label).toBe("Figure 2");
    expect(fig?.chart_type).toBe("line");
    expect(fig?.content).toBe("| col | col |");
    expect(fig?.caption?.text).toBe("A nice plot.");
    const para = findParagraph(doc, "We refer");
    expect(para?.text).toContain(`[[xref:${fig?.id}]]`);
  });

  test("test_unicode_author_citation", () => {
    const content = [
      { type: "text", text: "As found by Åström (2019).", page_idx: 0, bbox: [100, 100, 900, 140] },
      {
        type: "ref_text",
        text: "Åström, K. 2019, A&A, 1, 1.",
        page_idx: 1,
        bbox: [100, 100, 900, 130],
      },
    ];
    const doc = buildTiny(content, "uni", null, false);
    const para = findParagraph(doc, "As found by");
    expect(para?.citations).toHaveLength(1);
    expect(para?.citations?.[0]?.resolved).toBe(true);
  });

  test("test_lowercase_crossref", () => {
    const content = [
      { type: "text", text: "1 Intro", text_level: 1, page_idx: 0, bbox: [100, 80, 900, 100] },
      {
        type: "text",
        text: "see figure 1 and table 1 and section 2.",
        page_idx: 0,
        bbox: [100, 120, 900, 160],
      },
      { type: "image", img_caption: ["Figure 1: x"], page_idx: 0, bbox: [100, 200, 900, 400] },
      {
        type: "table",
        table_caption: ["Table 1: y"],
        table_body: "<table></table>",
        page_idx: 0,
        bbox: [100, 420, 900, 500],
      },
      { type: "text", text: "2 Methods", text_level: 1, page_idx: 0, bbox: [100, 520, 900, 540] },
    ];
    const doc = buildTiny(content, "lc", null, false);
    let para: ParagraphBlock | undefined;
    for (const b of iterBlocks(doc)) {
      if (b.type === "paragraph" && (b.crossrefs ?? []).length > 0) para = b;
    }
    const kinds = new Set((para?.crossrefs ?? []).map((x) => x.kind));
    expect(kinds.has("figure")).toBe(true);
    expect(kinds.has("table")).toBe(true);
    expect(kinds.has("section")).toBe(true);
    expect((para?.crossrefs ?? []).every((x) => x.resolved)).toBe(true);
  });

  test("test_citation_link_no_reuse", () => {
    // [review-1] corroborating a resolved citation must CONSUME its link target
    const refs: Reference[] = [
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

  test("test_textfix_repair", () => {
    // a ?-gap is filled from the aligned text layer
    let r = repairText("field of order ?? then", "field of order a0 then");
    expect(r.text).toBe("field of order a0 then");
    expect(r.fixed).toBe(1);
    // multiple gaps in one string
    r = repairText("with ?? and ????", "with N and Sgr");
    expect(r.text.includes("?")).toBe(false);
    expect(r.fixed).toBe(2);
    // single '?' (real question mark / unresolved token) is left untouched
    r = repairText("is it true? yes", "is it true? yes");
    expect(r.text).toBe("is it true? yes");
    expect(r.fixed).toBe(0);
    // if the text layer also failed (still '?'), leave the OCR gap as-is
    r = repairText("order ?? then", "order ?? then");
    expect(r.text).toBe("order ?? then");
    expect(r.fixed).toBe(0);
    // OCR baseline preserved where OCR/layer legitimately differ (British vs US)
    r = repairText("the colour ?? value", "the color a0 value");
    expect(r.text).toBe("the colour a0 value");
    expect(r.fixed).toBe(1);
    // REGRESSION: when the layer does NOT correspond to the OCR, real words next
    // to a gap must never be deleted/overwritten — leave the gap untouched.
    r = repairText("keep?? drop", "GONE");
    expect(r.text).toBe("keep?? drop");
    expect(r.fixed).toBe(0);
    // REGRESSION (the shipped footnote bug): a mismatched layer (e.g. a footnote
    // bbox returning table cells) must not splice garbage over real prose — the
    // correspondence gate leaves the whole holder untouched.
    const ocr = "Gas-rich galaxies only. ?? Corrected for X. ?? Based on density.";
    r = repairText(ocr, "Reference Na a0 Begeman (1991) Stark (2009) Lelli");
    expect(r.text).toBe(ocr);
    expect(r.fixed).toBe(0);
    // REGRESSION: a pure-symbol holder (no alphanumerics) cannot have its
    // correspondence verified -> fail closed, never splice.
    r = repairText("(??)", "(see Eq. 4 below)");
    expect(r.text).toBe("(??)");
    expect(r.fixed).toBe(0);
    // PERF: oversized / mid-large repetitive holders must return promptly
    // (no super-linear hang) — exercises the hard cap and the autojunk path.
    const big = "word ?? ".repeat(2000); // ~16k chars, over the hard length cap
    r = repairText(big, "word X0 ".repeat(2000));
    expect(r.text).toBe(big);
    expect(r.fixed).toBe(0);
    const mid = "alpha ?? beta ".repeat(500); // ~7k chars, over the autojunk threshold
    expect(typeof repairText(mid, "alpha qq beta ".repeat(500)).text).toBe("string");
  });

  test("test_caption_minus_preserved", () => {
    const { body } = splitCaption("Figure 1: -5 to 5 km/s", FIG_NUM_RE, "Figure");
    expect(body).toBe("-5 to 5 km/s");
  });

  test("test_xref_index_excludes_paragraphs", () => {
    const doc = build(false);
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

  test("test_apply_matches_overlap", () => {
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

  test("test_unresolved_xref_token", () => {
    // an equation reference with no matching element -> typed placeholder token
    const content = [
      { type: "text", text: "As in Fig. 9 we see.", page_idx: 0, bbox: [100, 100, 900, 140] },
    ];
    const doc = buildTiny(content, "x", null, false);
    const para = findParagraph(doc, "we see");
    expect(para?.text).toContain("[[xref:figure-9?]]");
    expect(para?.crossrefs?.[0]?.resolved).toBe(false);
  });

  test("test_full_json_serialization", () => {
    interface SampleJson {
      stats: Record<string, number>;
      index: { figures: unknown[] };
      structure: Array<{ blocks?: Array<{ type?: string; page_idx?: number | null }> }>;
    }
    const doc = build(true);
    const d = documentToJson(doc, true);
    // round-trips through JSON
    const d2 = JSON.parse(JSON.stringify(d)) as SampleJson;
    expect(d2.stats.n_references).toBe(2);
    expect(d2.stats.n_citations).toBeGreaterThanOrEqual(4);
    expect(d2.stats.n_crossrefs).toBeGreaterThanOrEqual(6);
    expect(d2.index.figures).toHaveLength(1);
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
