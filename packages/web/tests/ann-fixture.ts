/**
 * Shared fixture IR for the Stage 8 MS4 tests (ann-textmap / ann-selection):
 * one small hand-built document covering every text-annotation container kind
 * (paragraph content, list items, float captions) and every segment type in
 * one paragraph, so canonical offsets are fully under the test's control.
 */

import type { IrBlock, IrSegment, TexDocIr } from "@argelanderspace/contracts";

export const P1_SEGMENTS: IrSegment[] = [
  { type: "text", text: "Alpha " },
  { type: "math", latex: "\\beta" },
  { type: "text", text: " gamma " },
  {
    type: "cite",
    refs: [{ id: "ref-1", resolved: true, short: "A 1934" }],
    raw: "A (1934)",
  },
  { type: "text", text: " and " },
  {
    type: "cite",
    refs: [
      { id: "ref-1", resolved: true, short: "A 1934" },
      { id: "ref-2", resolved: true, short: "B 1940" },
    ],
    raw: "(A 1934; B 1940)",
  },
  { type: "text", text: " see " },
  {
    type: "xref",
    target: { id: "eq-1", resolved: true, targetType: "equation", number: "1" },
    raw: "Eq. 9",
  },
  { type: "text", text: " tail" },
] as IrSegment[];

/** canonical layout of P1_SEGMENTS (UTF-16 offsets):
 *  "Alpha " [0,6) | $\beta$ [6,13) | " gamma " [13,20) | A (1934) [20,28)
 *  " and " [28,33) | (A 1934; B 1940) [33,49) | " see " [49,54)
 *  Eq. 9 [54,59) | " tail" [59,64) */
export const P1 = {
  total: 64,
  math: [6, 13],
  cite1: [20, 28],
  multi: [33, 49],
  xref: [54, 59],
} as const;

export const P3_SEGMENTS: IrSegment[] = [
  { type: "text", text: "A" },
  { type: "text", text: "" }, // zero-length: React drops it, the mapper skips it
  { type: "math", latex: "z" },
  { type: "text", text: "B" },
] as IrSegment[];

export const FIG_CAPTION: IrSegment[] = [
  { type: "text", text: "Caption " },
  { type: "math", latex: "Y" },
  { type: "text", text: " end" },
] as IrSegment[];

// --- reviewer probe pins --------------------------------------------------- //

/** Adjacent text segments (React emits one text node per child — the mapper
 *  must tile them 1:1): "AB" [0,2) "CD" [2,4) $m$ [4,7) "EF" [7,9) "GH" [9,11). */
export const P4_SEGMENTS: IrSegment[] = [
  { type: "text", text: "AB" },
  { type: "text", text: "CD" },
  { type: "math", latex: "m" },
  { type: "text", text: "EF" },
  { type: "text", text: "GH" },
] as IrSegment[];

/** A cite atom at BOTH container boundaries: "[1]" [0,3) " versus " [3,11)
 *  "[2]" [11,14). */
export const P5_SEGMENTS: IrSegment[] = [
  {
    type: "cite",
    refs: [{ id: "ref-1", resolved: true, short: "A 1934" }],
    raw: "[1]",
  },
  { type: "text", text: " versus " },
  {
    type: "cite",
    refs: [{ id: "ref-2", resolved: true, short: "B 1940" }],
    raw: "[2]",
  },
] as IrSegment[];

/** Exactly one atomic segment in the container: "$Q$" [0,3). */
export const P6_SEGMENTS: IrSegment[] = [{ type: "math", latex: "Q" }] as IrSegment[];

/** UTF-16 byte-exactness: "αβ " [0,3) $\\pi$ [3,8) " x😀y " [8,14) (the emoji
 *  is TWO UTF-16 code units) "Café 2020" [14,23). */
export const P7_SEGMENTS: IrSegment[] = [
  { type: "text", text: "αβ " },
  { type: "math", latex: "\\pi" },
  { type: "text", text: " x😀y " },
  {
    type: "cite",
    refs: [{ id: "ref-9", resolved: true, short: "Café 2020" }],
    raw: "Café 2020",
  },
] as IrSegment[];

export const fixtureIr = {
  version: 1,
  docId: "testdoc",
  title: "Test Doc",
  sections: [
    {
      id: "sec-1",
      level: 1,
      number: "1",
      heading: "Intro",
      blocks: [
        { id: "p-1", type: "paragraph", segments: P1_SEGMENTS },
        {
          id: "p-2",
          type: "paragraph",
          segments: [{ type: "text", text: "Plain paragraph text here." }],
        },
        { id: "p-3", type: "paragraph", segments: P3_SEGMENTS },
        { id: "p-4", type: "paragraph", segments: P4_SEGMENTS },
        { id: "p-5", type: "paragraph", segments: P5_SEGMENTS },
        { id: "p-6", type: "paragraph", segments: P6_SEGMENTS },
        { id: "p-7", type: "paragraph", segments: P7_SEGMENTS },
        {
          id: "list-1",
          type: "list",
          ordered: false,
          items: [
            { segments: [{ type: "text", text: "First item " }, { type: "math", latex: "x^2" }] },
            { segments: [{ type: "text", text: "Second item text" }] },
          ],
        },
        {
          id: "fig-1",
          type: "figure",
          number: "1",
          label: "Figure 1",
          captionSegments: FIG_CAPTION,
        },
        { id: "eq-1", type: "equation", number: "1", latex: "a=b" },
        {
          id: "code-1",
          type: "code",
          captionSegments: [{ type: "text", text: "Code caption" }],
          body: "x = 1",
          lang: "python",
        },
      ],
      children: [],
    },
  ],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
} as unknown as TexDocIr;

/** Find a fixture block by id. */
export function fixtureBlock(id: string): IrBlock {
  const walk = (secs: TexDocIr["sections"]): IrBlock | null => {
    for (const s of secs) {
      for (const b of s.blocks) if (b.id === id) return b as IrBlock;
      const r = walk(s.children);
      if (r) return r;
    }
    return null;
  };
  const b = walk(fixtureIr.sections);
  if (!b) throw new Error(`${id} not in fixture`);
  return b;
}

/** All fixture blocks keyed by id (the shape store.blockById has). */
export function fixtureBlockById(): Map<string, IrBlock> {
  const byId = new Map<string, IrBlock>();
  const walk = (secs: TexDocIr["sections"]) => {
    for (const s of secs) {
      for (const b of s.blocks) byId.set(b.id, b as IrBlock);
      walk(s.children);
    }
  };
  walk(fixtureIr.sections);
  return byId;
}

/** First text node inside an element (document order). */
export function firstText(el: Element): Text {
  const w = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const n = w.nextNode();
  if (!n) throw new Error("no text node");
  return n as Text;
}

/** The IntersectionObserver stub every reader test needs (always intersecting). */
export class IOStub {
  constructor(private cb: IntersectionObserverCallback) {}
  observe(target: Element) {
    this.cb(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
