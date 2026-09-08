/**
 * Documents-domain tests for the surviving layers: tree traversal
 * (traverse.ts) and reference-field extraction (references.ts, used by the
 * tex pipeline).
 *
 * Deleted in MS3b with their code: the annotate/citations/crossrefs regex
 * fallback suites, the geom link-enrichment halves, and the documentToJson
 * serialization suite. The old PDF-pipeline half left earlier (ocr-features).
 */

import type { Document, ParagraphBlock, Section } from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { type ParsedReference, parseOne } from "../src/documents/references.js";
import { iterSectionBlocks, iterSections } from "../src/documents/traverse.js";

function para(id: string, text: string): ParagraphBlock {
  return { id, type: "paragraph", page_idx: 0, text };
}

function buildDoc(sections: Section[], references: ParsedReference[]): Document {
  return {
    doc_id: "doc-test",
    structure: sections,
    references: references as Document["references"],
  };
}

function sampleRefs(): ParsedReference[] {
  return [
    parseOne("ref-1", "Hunt, E. L., & Reffert, S. 2021, A&A, 646, L1", undefined),
    parseOne("ref-2", "Bok, B. J. 1934, Harvard College Observatory Circular, 384, 1", undefined),
  ];
}

function sampleSections(): Section[] {
  return [
    {
      id: "sec-1",
      type: "section",
      level: 1,
      blocks: [
        para("p-1", "Body."),
        para("p-2", "More."),
        { id: "fig-1", type: "figure", caption: { text: "Cap" } },
        { id: "tab-1", type: "table" },
        { id: "eq-1", type: "equation", latex: "a=1" },
        { id: "l-1", type: "list", ordered: false, items: [{ text: "x" }] },
      ],
      children: [],
    },
    {
      id: "sec-2",
      type: "section",
      level: 1,
      blocks: [para("p-3", "Tail.")],
      children: [],
    },
    { id: "sec-a", type: "section", level: 1, blocks: [], children: [] },
  ];
}

describe("traverse", () => {
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

  test("parseOne extracts author/year/title/venue for cite chips", () => {
    const ref = sampleRefs()[0];
    expect(ref).toBeDefined();
    expect(ref?.authors).toEqual(["Hunt", "Reffert"]);
    expect(ref?.year).toBe(2021);
    const bok = sampleRefs()[1];
    expect(bok?.authors).toEqual(["Bok"]);
    expect(bok?.year).toBe(1934);
  });
});
