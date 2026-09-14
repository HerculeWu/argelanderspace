vi.mock("../src/doc/ReaderSession", () => import("./reader-unit-session"));
import { AnnotationProvider } from "../src/annotations/AnnotationStore";
/**
 * Stage 8 MS4: the offset ↔ DOM Range primitive (`annotations/textmap.ts`)
 * tested EXHAUSTIVELY against the real rendered DOM (StoreProvider + Reader,
 * same harness shape as annotations.test.tsx) — the renderer's byte-exact
 * output is what the mapper aligns to, so hand-built DOM would drift.
 *
 * Covered: mixed text/math/cite/xref paragraph alignment, caption containers
 * (cap-label exclusion), list-item addressing, atomic boundary expansion in
 * both directions, cite-chip visible-text offsets, skipped subtrees
 * (.ann-edge/.cap-label), cross-container rejection, misalignment failures,
 * range→offsets→range round-trips, and the highlight painter's registry
 * mechanics (faked deps — happy-dom has no CSS Custom Highlight API).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  canonicalContainerText,
  canonicalSegmentsText,
  type IrSegment,
} from "@argelanderspace/contracts";
import { StoreProvider } from "../src/store";
import { Reader } from "../src/components/Reader";
import {
  buildContainerMap,
  caretFromPoint,
  ContainerMismatch,
  offsetForPoint,
  offsetsForRange,
  pointAtOffset,
  rangeForOffsets,
  resolveContainerAt,
  sameContainer,
  segmentsForContainer,
} from "../src/annotations/textmap";
import { createHighlightPainter, type HighlightDeps } from "../src/annotations/highlights";
import {
  FIG_CAPTION,
  firstText,
  fixtureBlock,
  fixtureBlockById,
  fixtureIr,
  IOStub,
  P1,
  P1_SEGMENTS,
  P3_SEGMENTS,
  P4_SEGMENTS,
  P5_SEGMENTS,
  P6_SEGMENTS,
  P7_SEGMENTS,
} from "./ann-fixture";

vi.mock("../src/api/ws", () => ({
  onAnnotationChanged: () => () => {},
  onLibraryChanged: () => () => {},
  onPlanChanged: () => () => {},
  onJobEvent: () => () => {},
}));

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 1, rev: 0, content_fingerprint: "fp", annotations: [] }),
    }))
  );
}

async function renderReader() {
  const utils = render(
    <StoreProvider ir={fixtureIr}><AnnotationProvider>
      <Reader />
    </AnnotationProvider></StoreProvider>
  );
  await waitFor(() => expect(utils.container.querySelector("[data-block-id='p-1']")).toBeTruthy());
  await act(async () => {}); // flush the annotation provider's load
  return utils;
}

const block = (container: HTMLElement, id: string) =>
  container.querySelector<HTMLElement>(`[data-block-id='${id}']`)!;

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", IOStub);
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe("buildContainerMap: alignment against the real rendered DOM", () => {
  it("tiles a mixed text/math/cite/xref paragraph into contiguous pieces", async () => {
    const { container } = await renderReader();
    const el = block(container, "p-1");
    const map = buildContainerMap(el, P1_SEGMENTS);
    expect(map.canonical).toBe(canonicalSegmentsText(P1_SEGMENTS));
    expect(map.canonical).toBe(
      "Alpha $\\beta$ gamma A (1934) and (A 1934; B 1940) see Eq. 9 tail"
    );
    expect(map.pieces).toHaveLength(9);
    expect(map.pieces[0]!.start).toBe(0);
    for (let i = 1; i < map.pieces.length; i++) {
      expect(map.pieces[i]!.start).toBe(map.pieces[i - 1]!.end);
    }
    expect(map.pieces[map.pieces.length - 1]!.end).toBe(P1.total);
    // the .ann-edge affordance rides inside the <p> but is not a piece
    expect(el.querySelector(".ann-edge")).toBeTruthy();
  });

  it("caption containers: the .cap-label prefix is excluded from canonical text", async () => {
    const { container } = await renderReader();
    const fig = block(container, "fig-1");
    const cap = fig.querySelector("figcaption")!;
    expect(cap.querySelector(".cap-label")?.textContent).toBe("Figure 1. ");
    const map = buildContainerMap(cap, FIG_CAPTION);
    expect(map.canonical).toBe("Caption $Y$ end");
    expect(map.canonical).toBe(canonicalContainerText(fixtureBlock("fig-1"), { type: "caption" }));
  });

  it("list items map independently by index", async () => {
    const { container } = await renderReader();
    const lis = block(container, "list-1").querySelectorAll(".doc-list > li");
    const b = fixtureBlock("list-1");
    if (b.type !== "list") throw new Error("unreachable");
    const m0 = buildContainerMap(lis[0]!, b.items[0]!.segments);
    const m1 = buildContainerMap(lis[1]!, b.items[1]!.segments);
    expect(m0.canonical).toBe("First item $x^2$");
    expect(m1.canonical).toBe("Second item text");
  });

  it("tolerates zero-length text segments (React drops the empty child)", async () => {
    const { container } = await renderReader();
    const map = buildContainerMap(block(container, "p-3"), P3_SEGMENTS);
    expect(map.canonical).toBe("A$z$B");
    expect(map.pieces).toHaveLength(3);
  });

  it("throws ContainerMismatch when a chip's visible text drifts from canonical", async () => {
    const { container } = await renderReader();
    const el = block(container, "p-1");
    const chip = el.querySelector(".chip")!;
    chip.textContent = "CHANGED";
    expect(() => buildContainerMap(el, P1_SEGMENTS)).toThrow(ContainerMismatch);
  });

  it("throws when the math wrapper is missing from the DOM", async () => {
    const { container } = await renderReader();
    const el = block(container, "p-1");
    el.querySelector(".katex")!.parentElement!.remove();
    expect(() => buildContainerMap(el, P1_SEGMENTS)).toThrow(ContainerMismatch);
  });

  it("throws on extra trailing DOM text", async () => {
    const { container } = await renderReader();
    const el = block(container, "p-1");
    el.appendChild(el.ownerDocument.createTextNode("EXTRA"));
    expect(() => buildContainerMap(el, P1_SEGMENTS)).toThrow(ContainerMismatch);
  });
});

// ---------------------------------------------------------------------------

describe("rangeForOffsets + round-trips", () => {
  const ALIGNED: [number, number][] = [
    [0, 6],
    [6, 13],
    [13, 20],
    [20, 28],
    [28, 33],
    [33, 49],
    [49, 54],
    [54, 59],
    [59, 64],
    [0, 64],
    [6, 49],
    [20, 33],
  ];
  // non-atom-aligned pairs round-trip to their expanded form
  const EXPANDING: [number, number, number, number][] = [
    [2, 9, 2, 13], // end inside math → atom end
    [8, 20, 6, 20], // start inside math → atom start
    [21, 27, 20, 28], // inside the single cite chip
    [34, 48, 33, 49], // inside the multi-cite group
    [7, 55, 6, 59], // math interior … xref interior
  ];

  it("atom-aligned intervals round-trip exactly", async () => {
    const { container } = await renderReader();
    const map = buildContainerMap(block(container, "p-1"), P1_SEGMENTS);
    for (const [s, e] of ALIGNED) {
      const range = rangeForOffsets(map, s, e);
      expect(range, `range ${s}..${e}`).not.toBeNull();
      expect(offsetsForRange(map, range!)).toEqual({ start: s, end: e });
    }
  });

  it("atom-interior endpoints expand to the whole atom (both directions)", async () => {
    const { container } = await renderReader();
    const map = buildContainerMap(block(container, "p-1"), P1_SEGMENTS);
    for (const [s, e, ws, we] of EXPANDING) {
      const range = rangeForOffsets(map, s, e)!;
      expect(offsetsForRange(map, range), `expand ${s}..${e}`).toEqual({ start: ws, end: we });
    }
  });

  it("pure-text and cite-atom ranges carry their quote as visible range text", async () => {
    const { container } = await renderReader();
    const p1 = block(container, "p-1");
    const map = buildContainerMap(p1, P1_SEGMENTS);
    expect(rangeForOffsets(map, 0, 6)!.toString()).toBe("Alpha ");
    expect(rangeForOffsets(map, 59, 64)!.toString()).toBe(" tail");
    // cite chips: visible text IS the canonical text
    expect(rangeForOffsets(map, P1.cite1[0], P1.cite1[1])!.toString()).toBe("A (1934)");
    expect(rangeForOffsets(map, P1.multi[0], P1.multi[1])!.toString()).toBe("(A 1934; B 1940)");
    // math atoms: the range spans the whole wrapper (glyph text ≠ canonical)
    const mr = rangeForOffsets(map, P1.math[0], P1.math[1])!;
    const mathEl = p1.querySelector(".katex")!.parentElement!;
    expect(mr.startContainer).toBe(p1);
    expect(mr.startOffset).toBe(Array.prototype.indexOf.call(p1.childNodes, mathEl));
    expect(mr.endContainer).toBe(p1);
    expect(mr.endOffset).toBe(mr.startOffset + 1);
  });

  it("rejects out-of-range/inverted offsets defensively", async () => {
    const { container } = await renderReader();
    const map = buildContainerMap(block(container, "p-1"), P1_SEGMENTS);
    expect(rangeForOffsets(map, -1, 5)).toBeNull();
    expect(rangeForOffsets(map, 0, 65)).toBeNull();
    expect(rangeForOffsets(map, 10, 10)).toBeNull();
    expect(rangeForOffsets(map, 12, 10)).toBeNull();
  });

  it("pointAtOffset resolves boundary conventions (start→leading, end→trailing)", async () => {
    const { container } = await renderReader();
    const p1 = block(container, "p-1");
    const map = buildContainerMap(p1, P1_SEGMENTS);
    // 6 is the math atom's start: side=start lands BEFORE the wrapper,
    // side=end lands at the trailing edge of the preceding text node
    const s = pointAtOffset(map, 6, "start");
    expect(s.node).toBe(p1);
    expect(p1.childNodes[s.offset]).toBe(p1.querySelector(".katex")!.parentElement);
    const e = pointAtOffset(map, 6, "end");
    expect(e.node.nodeType).toBe(3);
    expect((e.node as Text).data).toBe("Alpha ");
    expect(e.offset).toBe(6);
  });
});

// ---------------------------------------------------------------------------

describe("offsetsForRange: DOM range → canonical offsets", () => {
  function rangeIn(el: Element, a: [Node, number], b: [Node, number]): Range {
    const r = el.ownerDocument.createRange();
    r.setStart(a[0], a[1]);
    r.setEnd(b[0], b[1]);
    return r;
  }

  it("a range inside a math glyph snaps to the atom boundary by side", async () => {
    const { container } = await renderReader();
    const p1 = block(container, "p-1");
    const map = buildContainerMap(p1, P1_SEGMENTS);
    const glyph = firstText(p1.querySelector(".katex")!);
    const gamma = map.pieces[2]!; // " gamma " text piece
    if (gamma.kind !== "text") throw new Error("unreachable");
    const r1 = rangeIn(p1, [glyph, 0], [gamma.node, 3]);
    expect(offsetsForRange(map, r1)).toEqual({ start: P1.math[0], end: 16 });
    // as an END point the glyph interior snaps to the atom's end
    const alpha = map.pieces[0]!;
    if (alpha.kind !== "text") throw new Error("unreachable");
    const r2 = rangeIn(p1, [alpha.node, 2], [glyph, 1]);
    expect(offsetsForRange(map, r2)).toEqual({ start: 2, end: P1.math[1] });
  });

  it("a range inside a cite chip expands to the whole chip", async () => {
    const { container } = await renderReader();
    const p1 = block(container, "p-1");
    const map = buildContainerMap(p1, P1_SEGMENTS);
    const chipText = firstText(p1.querySelector(".chip")!);
    expect(chipText.data).toBe("A (1934)");
    const r = rangeIn(p1, [chipText, 2], [chipText, 5]);
    expect(offsetsForRange(map, r)).toEqual({ start: P1.cite1[0], end: P1.cite1[1] });
  });

  it("multi-cite open/close text units belong to the atom (boundary-exact ends stay)", async () => {
    const { container } = await renderReader();
    const p1 = block(container, "p-1");
    const map = buildContainerMap(p1, P1_SEGMENTS);
    const piece = map.pieces.find((p) => p.start === P1.multi[0])!;
    if (piece.kind !== "atom") throw new Error("unreachable");
    const open = piece.units[0]!.node as Text;
    const close = piece.units[piece.units.length - 1]!.node as Text;
    expect(open.data).toBe("(");
    expect(close.data).toBe(")");
    // interior of the open text → atom start; exact close end → atom end
    expect(offsetsForRange(map, rangeIn(p1, [open, 1], [close, 1]))).toEqual({
      start: P1.multi[0],
      end: P1.multi[1],
    });
    // exact atom-start (before "(") does NOT expand backwards
    expect(offsetsForRange(map, rangeIn(p1, [open, 0], [close, 0]))).toEqual({
      start: P1.multi[0],
      end: P1.multi[1],
    });
  });

  it("points inside the trailing .ann-edge map past the canonical end", async () => {
    const { container } = await renderReader();
    const p1 = block(container, "p-1");
    const map = buildContainerMap(p1, P1_SEGMENTS);
    const edge = p1.querySelector(".ann-edge")!;
    expect(offsetForPoint(map, edge, 0)).toBe(P1.total);
    // a selection wholly inside the affordance collapses to an empty span
    const r = rangeIn(p1, [edge, 0], [edge, 0]);
    expect(offsetsForRange(map, r)).toEqual({ start: P1.total, end: P1.total });
  });

  it("points inside the .cap-label are UNMAPPABLE (chrome, not content)", async () => {
    const { container } = await renderReader();
    const cap = block(container, "fig-1").querySelector("figcaption")!;
    const map = buildContainerMap(cap, FIG_CAPTION);
    const labelText = firstText(cap.querySelector(".cap-label")!);
    // N1: no silent clamp to 0 — neither hit-testing nor range resolution
    expect(offsetForPoint(map, labelText, 3)).toBeNull();
    const r = cap.ownerDocument.createRange();
    r.setStart(labelText, 3);
    r.setEnd(firstText(cap.querySelector("span:not(.cap-label)")!), 2);
    expect(offsetsForRange(map, r)).toBeNull();
  });

  it("returns null for a range endpoint outside the container", async () => {
    const { container } = await renderReader();
    const p1 = block(container, "p-1");
    const map = buildContainerMap(p1, P1_SEGMENTS);
    const r = rangeIn(p1, [firstText(p1), 0], [firstText(block(container, "p-2")), 3]);
    expect(offsetsForRange(map, r)).toBeNull();
  });

  it("offsetForPoint: caret anywhere on a chip/math hits the atom interval", async () => {
    const { container } = await renderReader();
    const p1 = block(container, "p-1");
    const map = buildContainerMap(p1, P1_SEGMENTS);
    const chipText = firstText(p1.querySelector(".chip")!);
    expect(offsetForPoint(map, chipText, 3)).toBe(P1.cite1[0]); // interior → atom start
    const glyph = firstText(p1.querySelector(".katex")!);
    expect(offsetForPoint(map, glyph, 1)).toBe(P1.math[0]);
    // text caret stays exact; just after an atom is its end (end-exclusive)
    const tail = map.pieces[map.pieces.length - 1]!;
    if (tail.kind !== "text") throw new Error("unreachable");
    expect(offsetForPoint(map, tail.node, 0)).toBe(59);
    expect(offsetForPoint(map, tail.node, 5)).toBe(64);
  });
});

// ---------------------------------------------------------------------------

describe("container resolution", () => {
  it("resolves paragraph content / list items / captions from DOM nodes", async () => {
    const { container } = await renderReader();
    const root = container.querySelector("main.reader")!;
    const byId = fixtureBlockById();

    const p1 = resolveContainerAt(firstText(block(container, "p-1")), root, byId);
    expect(p1?.container).toEqual({ type: "content" });
    expect(p1?.el).toBe(block(container, "p-1"));

    const lis = block(container, "list-1").querySelectorAll("li");
    const li1 = resolveContainerAt(firstText(lis[1]!), root, byId);
    expect(li1?.container).toEqual({ type: "list_item", index: 1 });
    expect(li1?.el).toBe(lis[1]);

    const fig = resolveContainerAt(
      firstText(block(container, "fig-1").querySelector("figcaption")!),
      root,
      byId
    );
    expect(fig?.container).toEqual({ type: "caption" });

    const codeCap = resolveContainerAt(
      firstText(block(container, "code-1").querySelector(".tab-cap")!),
      root,
      byId
    );
    expect(codeCap?.container).toEqual({ type: "caption" });
  });

  it("rejects equation bodies, code bodies, section headings, and non-block nodes", async () => {
    const { container } = await renderReader();
    const root = container.querySelector("main.reader")!;
    const byId = fixtureBlockById();

    const eqGlyph = firstText(block(container, "eq-1").querySelector(".eqn-body")!);
    expect(resolveContainerAt(eqGlyph, root, byId)).toBeNull();
    const codeBody = firstText(block(container, "code-1").querySelector("pre.code")!);
    expect(resolveContainerAt(codeBody, root, byId)).toBeNull();
    const heading = firstText(block(container, "sec-1"));
    expect(resolveContainerAt(heading, root, byId)).toBeNull();
    expect(resolveContainerAt(root, root, byId)).toBeNull(); // not in any block
  });

  it("segmentsForContainer rejects wrong kinds, bad indexes, caption-less floats", () => {
    const fig = fixtureBlock("fig-1");
    const para = fixtureBlock("p-1");
    const list = fixtureBlock("list-1");
    expect(segmentsForContainer(fig, { type: "content" })).toBeNull();
    expect(segmentsForContainer(para, { type: "caption" })).toBeNull();
    expect(segmentsForContainer(list, { type: "list_item", index: 9 })).toBeNull();
    expect(segmentsForContainer(list, { type: "list_item", index: 1 })).not.toBeNull();
    const bare = { ...fig, captionSegments: undefined };
    expect(segmentsForContainer(bare, { type: "caption" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("reviewer probe pins", () => {
  it("adjacent text segments tile 1:1 and map independently", async () => {
    const { container } = await renderReader();
    const p4 = block(container, "p-4");
    const map = buildContainerMap(p4, P4_SEGMENTS);
    expect(map.canonical).toBe("ABCD$m$EFGH");
    // one piece per segment, contiguous
    expect(map.pieces.map((p) => [p.start, p.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 7],
      [7, 9],
      [9, 11],
    ]);
    // a range spanning three adjacent text nodes round-trips exactly
    const r = rangeForOffsets(map, 1, 10)!;
    expect(r.toString().startsWith("BCD")).toBe(true);
    expect(r.toString().endsWith("EFG")).toBe(true);
    expect(offsetsForRange(map, r)).toEqual({ start: 1, end: 10 });
    // the segment-internal boundary 2 is exact on both sides
    expect(offsetsForRange(map, rangeForOffsets(map, 2, 4)!)).toEqual({ start: 2, end: 4 });
    // the two text nodes really are siblings
    const texts = map.pieces.filter((p) => p.kind === "text");
    expect(texts).toHaveLength(4);
  });

  it("a cite atom at BOTH container boundaries maps exactly", async () => {
    const { container } = await renderReader();
    const p5 = block(container, "p-5");
    const map = buildContainerMap(p5, P5_SEGMENTS);
    expect(map.canonical).toBe("[1] versus [2]");
    // leading atom: range starts at (p5, 0) — element boundary before the chip
    const lead = rangeForOffsets(map, 0, 3)!;
    expect(lead.startContainer).toBe(p5);
    expect(lead.startOffset).toBe(0);
    expect(lead.toString()).toBe("[1]");
    expect(offsetsForRange(map, lead)).toEqual({ start: 0, end: 3 });
    // trailing atom: range ends at (p5, childNodes.length) — after the chip
    const trail = rangeForOffsets(map, 11, 14)!;
    expect(trail.toString()).toBe("[2]");
    expect(offsetsForRange(map, trail)).toEqual({ start: 11, end: 14 });
    // interior of the trailing atom expands to the very end
    const chipTexts = map.pieces[2]!;
    if (chipTexts.kind !== "atom") throw new Error("unreachable");
    const chipText = firstText(chipTexts.units[0]!.node as Element);
    const r = p5.ownerDocument.createRange();
    r.setStart(chipText, 1);
    r.setEnd(chipText, 2);
    expect(offsetsForRange(map, r)).toEqual({ start: 11, end: 14 });
  });

  it("a container with exactly one atom round-trips at element level", async () => {
    const { container } = await renderReader();
    const p6 = block(container, "p-6");
    const map = buildContainerMap(p6, P6_SEGMENTS);
    expect(map.canonical).toBe("$Q$");
    expect(map.pieces).toHaveLength(1);
    const r = rangeForOffsets(map, 0, 3)!;
    // element-level endpoints: (p6, 0) → (p6, 1)
    expect(r.startContainer).toBe(p6);
    expect(r.startOffset).toBe(0);
    expect(r.endContainer).toBe(p6);
    expect(r.endOffset).toBe(1);
    expect(offsetsForRange(map, r)).toEqual({ start: 0, end: 3 });
  });

  it("UTF-16 code units are the coordinate system (astral chars, accents)", async () => {
    const { container } = await renderReader();
    const p7 = block(container, "p-7");
    const map = buildContainerMap(p7, P7_SEGMENTS);
    expect(map.canonical).toBe("αβ $\\pi$ x😀y Café 2020");
    expect(map.canonical).toBe(canonicalSegmentsText(P7_SEGMENTS));
    expect(map.canonical.length).toBe(23); // the emoji counts TWO code units
    expect(map.pieces.map((p) => [p.start, p.end])).toEqual([
      [0, 3],
      [3, 8],
      [8, 14],
      [14, 23],
    ]);
    // the piece containing the emoji slices byte-exactly in code units
    expect(map.canonical.slice(8, 14)).toBe(" x😀y ");
    const r = rangeForOffsets(map, 8, 14)!;
    expect(r.toString()).toBe(" x😀y ");
    expect(offsetsForRange(map, r)).toEqual({ start: 8, end: 14 });
    // the accented cite chip: visible text == canonical text, exact offsets
    expect(rangeForOffsets(map, 14, 23)!.toString()).toBe("Café 2020");
    // a selection boundary between the surrogate pair's halves stays put
    expect(offsetsForRange(map, rangeForOffsets(map, 10, 11)!)).toEqual({ start: 10, end: 11 });
    expect(map.canonical.slice(10, 11)).toBe("😀".slice(0, 1)); // lone surrogate half
  });

  it("two coexisting painters dispose independently", () => {
    const live = new Map<string, { priority: number; ranges: Range[] }>();
    const deps: HighlightDeps = {
      registry: {
        set: (name, h) => {
          live.set(name, h as { priority: number; ranges: Range[] });
        },
        delete: (name) => {
          live.delete(name);
        },
      },
      makeHighlight: (ranges) => ({ priority: 0, ranges }),
    };
    const range = document.createRange();
    const k1 = createHighlightPainter(document, "k1", deps);
    const k2 = createHighlightPainter(document, "k2", deps);
    k1.paint([{ id: "a_00000001", range, active: false }]);
    k2.paint([{ id: "a_00000001", range, active: true }]);
    expect([...live.keys()].sort()).toEqual(["annhl-active-k2", "annhl-k1-a_00000001"]);
    expect(document.head.querySelectorAll("style[data-ann-highlights]")).toHaveLength(2);
    k1.dispose();
    expect([...live.keys()]).toEqual(["annhl-active-k2"]);
    expect(document.head.querySelectorAll("style[data-ann-highlights]")).toHaveLength(1);
    expect(document.head.querySelector("style[data-ann-highlights='k2']")).toBeTruthy();
    k2.dispose();
    expect(live.size).toBe(0);
    expect(document.head.querySelectorAll("style[data-ann-highlights]")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("small helpers", () => {
  it("sameContainer compares list-item indexes", () => {
    expect(sameContainer({ type: "content" }, { type: "content" })).toBe(true);
    expect(sameContainer({ type: "caption" }, { type: "content" })).toBe(false);
    expect(
      sameContainer({ type: "list_item", index: 1 }, { type: "list_item", index: 1 })
    ).toBe(true);
    expect(
      sameContainer({ type: "list_item", index: 1 }, { type: "list_item", index: 2 })
    ).toBe(false);
  });

  it("caretFromPoint returns null where neither vendor API exists (happy-dom)", () => {
    expect(caretFromPoint(document, 10, 10)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("highlight painter mechanics (faked registry)", () => {
  function fakeDeps() {
    const live = new Map<string, { priority: number; ranges: Range[] }>();
    const deps: HighlightDeps = {
      registry: {
        set: (name, h) => {
          live.set(name, h as { priority: number; ranges: Range[] });
        },
        delete: (name) => {
          live.delete(name);
        },
      },
      makeHighlight: (ranges) => ({ priority: 0, ranges }),
    };
    return { deps, live };
  }

  it("registers one named highlight per annotation; the active one gets priority 1", async () => {
    const { container } = await renderReader();
    const map = buildContainerMap(block(container, "p-2"), [
      { type: "text", text: "Plain paragraph text here." },
    ] as IrSegment[]);
    const r1 = rangeForOffsets(map, 6, 15)!;
    const r2 = rangeForOffsets(map, 10, 20)!;
    const { deps, live } = fakeDeps();
    const painter = createHighlightPainter(document, "t1", deps);
    expect(painter.supported).toBe(true);
    painter.paint([
      { id: "a_00000001", range: r1, active: false },
      { id: "a_00000002", range: r2, active: true },
    ]);
    expect([...live.keys()].sort()).toEqual(["annhl-active-t1", "annhl-t1-a_00000001"]);
    expect(live.get("annhl-t1-a_00000001")!.priority).toBe(0);
    expect(live.get("annhl-active-t1")!.priority).toBe(1);
    expect(live.get("annhl-active-t1")!.ranges[0]).toBe(r2);
    // the managed style element carries the ::highlight rules
    const style = document.head.querySelector("style[data-ann-highlights='t1']");
    expect(style?.textContent).toContain("::highlight(annhl-t1-a_00000001)");
    expect(style?.textContent).toContain("::highlight(annhl-active-t1)");
    painter.dispose();
  });

  it("repaint replaces previous names; dispose clears the registry and style", async () => {
    const { container } = await renderReader();
    const map = buildContainerMap(block(container, "p-2"), [
      { type: "text", text: "Plain paragraph text here." },
    ] as IrSegment[]);
    const r1 = rangeForOffsets(map, 6, 15)!;
    const { deps, live } = fakeDeps();
    const painter = createHighlightPainter(document, "t2", deps);
    painter.paint([{ id: "a_00000001", range: r1, active: false }]);
    expect(live.size).toBe(1);
    painter.paint([]);
    expect(live.size).toBe(0);
    painter.paint([{ id: "a_00000009", range: r1, active: true }]);
    expect([...live.keys()]).toEqual(["annhl-active-t2"]);
    painter.dispose();
    expect(live.size).toBe(0);
    expect(document.head.querySelector("style[data-ann-highlights='t2']")).toBeNull();
  });

  it("a null-deps painter (no CSS.highlights) is a supported:false no-op", () => {
    const painter = createHighlightPainter(document, "t3", null);
    expect(painter.supported).toBe(false);
    expect(() => painter.paint([])).not.toThrow();
    expect(() => painter.dispose()).not.toThrow();
    expect(document.head.querySelector("style[data-ann-highlights='t3']")).toBeNull();
  });
});
