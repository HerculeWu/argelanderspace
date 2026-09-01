/**
 * Render-IR tests (Stage 3 / MS2a): `buildDocIr` against the 6 frozen golden
 * Documents — contracts validation, lossless segment partitioning, cite/xref
 * resolution (incl. the occurrence pairing), defensive mismatch handling, and
 * the `citationsByBlock` grouping.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Block,
  type CitationOccurrence,
  DocIrSchema,
  type Document,
  DocumentSchema,
  type IrBlock,
  type IrCiteSegment,
  type IrSection,
  type IrSegment,
  type IrXrefSegment,
  type Reference,
} from "@argelanderspace/contracts";
import { describe, expect, test } from "vitest";
import { buildDocIr } from "../src/documents/ir.js";
import { iterBlocks } from "../src/documents/traverse.js";

// packages/core/tests/ → repo root
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GOLDEN_DIR = join(REPO_ROOT, "tests", "golden");

const DOC_IDS = [
  "arxiv-2501.17225", // latex
  "arxiv-2012.05220", // latex (code blocks)
  "2603.03522", // pdf (unresolved xrefs)
  "ads-1983ApJ...270..365M", // pdf (OCR)
  "962260", // html
  "aa39341-20", // html
] as const;

function loadDoc(docId: string): Document {
  const raw = JSON.parse(readFileSync(join(GOLDEN_DIR, `${docId}.json`), "utf8"));
  return DocumentSchema.parse(raw);
}

const DOCS = new Map(DOC_IDS.map((id) => [id, loadDoc(id)]));

// --------------------------------------------------------------------------- //
// Helpers
// --------------------------------------------------------------------------- //

function irBlocks(sections: IrSection[]): IrBlock[] {
  const out: IrBlock[] = [];
  for (const s of sections) {
    out.push(...s.blocks);
    out.push(...irBlocks(s.children));
  }
  return out;
}

/** [source RichText text, IR segments] pairs of one block pair, in order. */
function richTextPairs(orig: Block, irb: IrBlock): [string, IrSegment[]][] {
  const out: [string, IrSegment[]][] = [];
  if (orig.type === "paragraph" && irb.type === "paragraph") {
    out.push([orig.text, irb.segments]);
  }
  if (orig.type === "list" && irb.type === "list") {
    expect(orig.items.length).toBe(irb.items.length);
    orig.items.forEach((it, i) => {
      const item = irb.items[i];
      if (item === undefined) throw new Error(`missing IR list item ${i} in ${orig.id}`);
      out.push([it.text, item.segments]);
    });
  }
  if ("caption" in orig && orig.caption !== undefined) {
    if (!("captionSegments" in irb) || irb.captionSegments === undefined) {
      throw new Error(`missing IR captionSegments in ${orig.id}`);
    }
    out.push([orig.caption.text, irb.captionSegments]);
  }
  return out;
}

const TOKEN_AT_CURSOR = /^\[\[(cite|xref):([^\]]+)\]\]/u;

/**
 * The segments must partition *text* exactly: every character is covered once,
 * text/math spans are verbatim, and each cite/xref segment sits on exactly the
 * token it was parsed from (ids checked against the token payload).
 */
function assertPartition(text: string, segments: IrSegment[]): void {
  let cursor = 0;
  for (const seg of segments) {
    if (seg.type === "text") {
      expect(text.startsWith(seg.text, cursor)).toBe(true);
      cursor += seg.text.length;
      continue;
    }
    if (seg.type === "math") {
      const raw = `$${seg.latex}$`;
      expect(text.startsWith(raw, cursor)).toBe(true);
      cursor += raw.length;
      continue;
    }
    const m = TOKEN_AT_CURSOR.exec(text.slice(cursor));
    const token = m?.[0];
    const kind = m?.[1];
    const inner = m?.[2];
    if (token === undefined || kind === undefined || inner === undefined) {
      throw new Error(`no token at offset ${cursor} in ${JSON.stringify(text)}`);
    }
    if (seg.type === "cite") {
      expect(kind).toBe("cite");
      const ids = inner.split(";").map((s) => s.trim());
      expect(seg.refs.map((r) => r.id)).toEqual(
        ids.map((id) => (id === "" || id === "?" ? "?" : id))
      );
    } else {
      expect(kind).toBe("xref");
      const stripped = inner.endsWith("?") ? inner.slice(0, -1) : inner;
      expect(seg.target.id).toBe(stripped === "" ? "?" : stripped);
    }
    cursor += token.length;
  }
  expect(cursor).toBe(text.length);
}

function citeSegments(segments: IrSegment[]): IrCiteSegment[] {
  return segments.filter((s): s is IrCiteSegment => s.type === "cite");
}

function xrefSegments(segments: IrSegment[]): IrXrefSegment[] {
  return segments.filter((s): s is IrXrefSegment => s.type === "xref");
}

/** Every cite/xref segment of the doc (paragraphs, list items, captions). */
function collectSegments(doc: Document): { cites: IrCiteSegment[]; xrefs: IrXrefSegment[] } {
  const cites: IrCiteSegment[] = [];
  const xrefs: IrXrefSegment[] = [];
  for (const b of irBlocks(buildDocIr(doc).sections)) {
    if (b.type === "paragraph") {
      cites.push(...citeSegments(b.segments));
      xrefs.push(...xrefSegments(b.segments));
    }
    if (b.type === "list") {
      for (const it of b.items) {
        cites.push(...citeSegments(it.segments));
        xrefs.push(...xrefSegments(it.segments));
      }
    }
    if ("captionSegments" in b && b.captionSegments !== undefined) {
      cites.push(...citeSegments(b.captionSegments));
      xrefs.push(...xrefSegments(b.captionSegments));
    }
  }
  return { cites, xrefs };
}

// --------------------------------------------------------------------------- //
// Schema validation + lossless partitioning, all 6 goldens
// --------------------------------------------------------------------------- //

describe("buildDocIr (all goldens)", () => {
  test.each(DOC_IDS)("%s: validates against DocIrSchema and JSON-round-trips", (id) => {
    const ir = buildDocIr(DOCS.get(id) as Document);
    const parsed = DocIrSchema.parse(JSON.parse(JSON.stringify(ir)));
    expect(parsed).toEqual(ir);
  });

  test.each(DOC_IDS)("%s: every RichText partitions losslessly into segments", (id) => {
    const doc = DOCS.get(id) as Document;
    const ir = buildDocIr(doc);
    const orig = [...iterBlocks(doc)];
    const flat = irBlocks(ir.sections);
    expect(flat.map((b) => b.id)).toEqual(orig.map((b) => b.id));
    let pairs = 0;
    for (const [i, b] of orig.entries()) {
      const irb = flat[i];
      if (irb === undefined) throw new Error(`missing IR block ${i}`);
      for (const [text, segments] of richTextPairs(b, irb)) {
        assertPartition(text, segments);
        pairs += 1;
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });

  test.each(DOC_IDS)("%s: layout forensics are projected out", (id) => {
    const ir = buildDocIr(DOCS.get(id) as Document);
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        v.forEach(walk);
        return;
      }
      if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    walk(ir);
    for (const dropped of ["page_idx", "bbox", "heading_raw", "img_path", "table_body"]) {
      expect(keys.has(dropped)).toBe(false);
    }
  });

  test.each(DOC_IDS)("%s: references pass through verbatim (absent when none)", (id) => {
    const doc = DOCS.get(id) as Document;
    const ir = buildDocIr(doc);
    if (doc.references !== undefined && doc.references.length > 0) {
      expect(ir.references).toEqual(doc.references);
    } else {
      expect("references" in ir).toBe(false);
    }
  });

  test.each(DOC_IDS)("%s: nPages mirrors source.n_pages (absent when unset)", (id) => {
    const doc = DOCS.get(id) as Document;
    const ir = buildDocIr(doc);
    if (doc.source?.n_pages !== undefined) {
      expect(ir.nPages).toBe(doc.source.n_pages);
    } else {
      expect("nPages" in ir).toBe(false);
    }
  });
});

// --------------------------------------------------------------------------- //
// cite / xref segment resolution (golden-pinned)
// --------------------------------------------------------------------------- //

describe("cite segments (arxiv-2501.17225)", () => {
  const { cites } = collectSegments(DOCS.get("arxiv-2501.17225") as Document);

  test("resolved: id, citeShort label, paired occurrence raw", () => {
    const seg = cites.find((c) => c.refs.length === 1 && c.refs[0]?.id === "ref-6");
    expect(seg).toBeDefined();
    expect(seg?.refs[0]).toMatchObject({ id: "ref-6", resolved: true, short: "Bok 1934" });
    expect(typeof seg?.raw).toBe("string");
  });

  test("a ;-group stays one segment with one ref per id", () => {
    // the golden's group token: [[cite:ref-21;ref-45;ref-32;ref-52;ref-58;ref-2;ref-44;ref-26]]
    const seg = cites.find((c) => c.refs.length > 1 && c.refs[0]?.id === "ref-21");
    expect(seg).toBeDefined();
    expect(seg?.refs.map((r) => r.id)).toEqual([
      "ref-21",
      "ref-45",
      "ref-32",
      "ref-52",
      "ref-58",
      "ref-2",
      "ref-44",
      "ref-26",
    ]);
    expect(seg?.refs[1]).toMatchObject({ id: "ref-45", resolved: true });
  });

  test("unresolved [[cite:?]] → {id: '?', resolved: false}", () => {
    const seg = cites.find((c) => c.refs.some((r) => r.id === "?"));
    expect(seg).toBeDefined();
    expect(seg?.refs.find((r) => r.id === "?")).toEqual({ id: "?", resolved: false });
  });
});

describe("xref segments (goldens)", () => {
  test("figure target: type, number, sanitized preview (arxiv-2501.17225)", () => {
    const { xrefs } = collectSegments(DOCS.get("arxiv-2501.17225") as Document);
    const seg = xrefs.find((x) => x.target.id === "fig-1" && x.target.resolved);
    expect(seg).toBeDefined();
    expect(seg?.target).toMatchObject({
      id: "fig-1",
      resolved: true,
      targetType: "figure",
      number: "1",
    });
    expect(seg?.target.preview).toContain("$X-Y$ plot of all");
    expect(typeof seg?.raw).toBe("string");
  });

  test("section target: type, number, heading (arxiv-2501.17225)", () => {
    const { xrefs } = collectSegments(DOCS.get("arxiv-2501.17225") as Document);
    const seg = xrefs.find((x) => x.target.id === "sec-3" && x.target.resolved);
    expect(seg?.target).toMatchObject({
      id: "sec-3",
      resolved: true,
      targetType: "section",
      number: "2",
      heading: "Data",
    });
  });

  test("trailing-? marker strips and stays unresolved (2603.03522)", () => {
    const { xrefs } = collectSegments(DOCS.get("2603.03522") as Document);
    const fig3 = xrefs.find((x) => x.target.id === "figure-3");
    expect(fig3).toBeDefined();
    expect(fig3?.target).toEqual({ id: "figure-3", resolved: false });
    const eq3 = xrefs.find((x) => x.target.id === "equation-3");
    expect(eq3?.target).toEqual({ id: "equation-3", resolved: false });
  });
});

// --------------------------------------------------------------------------- //
// citationsByBlock
// --------------------------------------------------------------------------- //

describe("citationsByBlock", () => {
  test.each(DOC_IDS)("%s: every doc-level occurrence's ref_ids land in its block group", (id) => {
    const doc = DOCS.get(id) as Document;
    const ir = buildDocIr(doc);
    for (const c of doc.citations ?? []) {
      if (c.block_id === undefined || c.ref_ids === undefined) continue;
      for (const refId of c.ref_ids) {
        expect(ir.citationsByBlock[c.block_id]).toContain(refId);
      }
    }
    for (const ids of Object.values(ir.citationsByBlock)) {
      expect(new Set(ids).size).toBe(ids.length); // deduped
    }
  });

  test("arxiv-2012.05220: order-preserving groups incl. token-less hyperlink occurrences", () => {
    const doc = DOCS.get("arxiv-2012.05220") as Document;
    const ir = buildDocIr(doc);
    // independent oracle: group in document order, flatten ref_ids, dedupe
    const expected: Record<string, string[]> = {};
    for (const c of doc.citations ?? []) {
      if (c.block_id === undefined || c.ref_ids === undefined) continue;
      const arr = expected[c.block_id] ?? [];
      expected[c.block_id] = arr;
      for (const refId of c.ref_ids) {
        if (!arr.includes(refId)) arr.push(refId);
      }
    }
    expect(ir.citationsByBlock).toEqual(expected);
    // the hyperlink-found occurrences (no inline token) must be in there
    const hyperlink = (doc.citations ?? []).filter((c) => c.via.includes("hyperlink"));
    expect(hyperlink.length).toBeGreaterThan(0);
    expect(hyperlink.every((c) => c.block_id !== undefined && c.ref_ids !== undefined)).toBe(true);
  });
});

// --------------------------------------------------------------------------- //
// Defensive pairing + math (synthetic docs)
// --------------------------------------------------------------------------- //

function synthDoc(blocks: Block[], references: Reference[] = []): Document {
  return {
    doc_id: "syn",
    structure: [{ id: "sec-1", type: "section", level: 1, blocks }],
    references,
  };
}

function firstParagraphSegments(doc: Document): IrSegment[] {
  const b = irBlocks(buildDocIr(doc).sections)[0];
  if (b === undefined || b.type !== "paragraph") throw new Error("expected a paragraph block");
  return b.segments;
}

describe("synthetic: occurrence pairing mismatches never throw", () => {
  test("fewer occurrences than tokens → the unpaired segments have no raw", () => {
    const occ: CitationOccurrence = {
      ref_ids: ["ref-1"],
      raw: "(Doe 2020)",
      via: "regex",
      resolved: true,
    };
    const doc = synthDoc(
      [
        {
          id: "p-1",
          type: "paragraph",
          text: "a [[cite:ref-1]] b [[cite:ref-1]] c",
          citations: [occ],
        },
      ],
      [{ id: "ref-1", raw: "Doe 2020", authors: ["Doe"], year: 2020 }]
    );
    const cites = citeSegments(firstParagraphSegments(doc));
    expect(cites).toHaveLength(2);
    expect(cites[0]?.raw).toBe("(Doe 2020)");
    expect(cites[1]?.raw).toBeUndefined();
  });

  test("more occurrences than tokens → surplus ignored", () => {
    const occ: CitationOccurrence = { raw: "x", via: "regex", resolved: false };
    const doc = synthDoc([
      { id: "p-1", type: "paragraph", text: "a [[cite:?]] b", citations: [occ, occ, occ] },
    ]);
    const cites = citeSegments(firstParagraphSegments(doc));
    expect(cites).toHaveLength(1);
    expect(cites[0]?.refs).toEqual([{ id: "?", resolved: false }]);
    expect(cites[0]?.raw).toBe("x");
  });

  test("unknown ids, empty group members, and title passthrough", () => {
    const doc = synthDoc(
      [
        {
          id: "p-1",
          type: "paragraph",
          text: "x [[cite:;ref-9;ref-1]] y [[xref:fig-9?]] z [[xref:?]]",
        },
      ],
      [{ id: "ref-1", raw: "Doe 2020", authors: ["Doe"], year: 2020, title: "A Paper" }]
    );
    const segs = firstParagraphSegments(doc);
    const cites = citeSegments(segs);
    expect(cites).toHaveLength(1);
    expect(cites[0]?.refs).toEqual([
      { id: "?", resolved: false }, // empty group member
      { id: "ref-9", resolved: false }, // unknown ref id
      { id: "ref-1", resolved: true, short: "Doe 2020", title: "A Paper" },
    ]);
    expect(xrefSegments(segs).map((x) => x.target)).toEqual([
      { id: "fig-9", resolved: false },
      { id: "?", resolved: false },
    ]);
  });

  test("math segments: $…$ captured, $$ untouched, deterministic", () => {
    const doc = synthDoc([
      { id: "p-1", type: "paragraph", text: "inline $x^2$ math and a $$ b left" },
    ]);
    expect(firstParagraphSegments(doc)).toEqual([
      { type: "text", text: "inline " },
      { type: "math", latex: "x^2" },
      { type: "text", text: " math and a $$ b left" },
    ]);
    expect(buildDocIr(doc)).toEqual(buildDocIr(doc));
  });
});
