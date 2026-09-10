import {
  canonicalSegmentText,
  type AnnotationTextContainer,
  type IrBlock,
  type IrSection,
  type IrSegment,
} from "@argelanderspace/contracts";

/**
 * offset ↔ DOM Range primitive for text annotations (Stage 8 MS4) — the
 * alignment layer between the contracts canonical annotation text (UTF-16
 * code-unit offsets, `canonicalSegmentText` rules) and the live reader DOM.
 *
 * DOM-ALIGNMENT RULES (pinned against `lib/segments.tsx` + `components/Block.tsx`;
 * the body DOM is never modified — no wrapper spans, walking/matching only):
 *
 * - A logical container is one of: a paragraph's `<p>` (content), a list
 *   item's `<li>`, or a float caption element (`<figcaption>` / `.tab-cap`).
 * - `text` segment → exactly the DOM text node(s) carrying its characters;
 *   adjacent runs are matched by CONTENT (joined node data must equal the
 *   canonical string), never by node count. Zero-length text segments and
 *   zero-length text nodes are skipped (React drops `""` children).
 * - `math` segment → ONE atomic element: the `Math` wrapper span, identified
 *   as the element whose first element child is `.katex` (or `.math-error`,
 *   the renderMathToString catch fallback). KaTeX glyph text inside NEVER
 *   participates in matching (canonical form `$latex$` ≠ visible glyphs);
 *   the whole wrapper subtree is one atomic unit.
 * - `cite`/`xref` segment → `.chip` span(s), atomic. A single-ref cite/xref is
 *   one chip whose visible text equals the canonical string. A multi-ref cite
 *   renders as open text + per-ref chips + "; " separator texts + close text
 *   (segments.tsx `splitCiteRaw`) whose joined visible text reproduces `raw`
 *   verbatim — so the atom's DOM footprint is a run of text AND chip units,
 *   matched by content against the whole canonical string.
 * - Skipped subtrees (never part of canonical text): `.ann-edge` (the MS3
 *   annotation affordance riding inside blocks) and `.cap-label` (the
 *   "Figure 1. " prefix preceding the caption segments).
 * - Any other element (the plain `<span>` wrapper `Segments` renders inside
 *   `<li>`/captions, etc.) is transparent: the walk descends into it.
 *
 * Alignment failures throw `ContainerMismatch` — a mismatch between the IR
 * segments and the rendered DOM means a renderer regression, not user data
 * trouble; callers catch and skip the container defensively.
 *
 * Atomic normalization is built into the coordinate mapping itself
 * (side-aware): a range START landing strictly inside an atomic segment maps
 * to the atom's canonical start, a range END to the atom's end. Stored text
 * targets therefore always span whole atoms, and `quote` is exactly
 * `canonical.slice(start, end)` of that expanded range.
 */

export class ContainerMismatch extends Error {}

// ---------------------------------------------------------------------------
// Piece model: the container's canonical text tiled by ordered pieces
// ---------------------------------------------------------------------------

/** A text segment's footprint: one DOM text node covering [start, end). */
interface TextPiece {
  kind: "text";
  node: Text;
  start: number;
  end: number;
}

/** One node of an atomic segment's footprint; `local` is its offset within
 *  the atom's canonical interval (text units of a multi-ref cite sit at
 *  nonzero locals, chip elements carry the local of their visible text). */
interface AtomUnit {
  node: Text | Element;
  local: number;
}

interface AtomPiece {
  kind: "atom";
  /** "chip" atoms (cite/xref) have canonical-equal visible text; "math"
   *  atoms don't (glyph text), so their interiors only map by side. */
  atom: "chip" | "math";
  units: AtomUnit[];
  start: number;
  end: number;
}

type Piece = TextPiece | AtomPiece;

export interface ContainerMap {
  containerEl: Element;
  /** The container's canonical annotation text (== contracts
   *  `canonicalContainerText` output for the same IR). */
  canonical: string;
  pieces: Piece[];
  /** Text node → its piece (text pieces) or owning atom piece + unit local. */
  textIndex: Map<Text, { piece: Piece; local: number }>;
  /** Atom unit ROOT elements (chips, math wrappers) → owning piece/unit. */
  atomRoots: Map<Element, { piece: AtomPiece; local: number }>;
}

const SKIP_CLASSES = ["ann-edge", "cap-label"];

function isSkipped(el: Element): boolean {
  return SKIP_CLASSES.some((c) => el.classList.contains(c));
}

/** The `Math` component's wrapper span: first element child is the KaTeX root
 *  (or the `.math-error` fallback span when renderToString itself failed). */
function isMathRoot(el: Element): boolean {
  const first = el.firstElementChild;
  return (
    first !== null &&
    (first.classList.contains("katex") || first.classList.contains("math-error"))
  );
}

/**
 * Walk the container, matching DOM units against the IR segments, and build
 * the piece map. Throws `ContainerMismatch` when the DOM and the canonical
 * text disagree (extra/missing nodes, content drift, wrong unit kind).
 */
export function buildContainerMap(containerEl: Element, segments: IrSegment[]): ContainerMap {
  const expected = segments.map(canonicalSegmentText);
  const canonical = expected.join("");
  const pieces: Piece[] = [];
  const textIndex: ContainerMap["textIndex"] = new Map();
  const atomRoots: ContainerMap["atomRoots"] = new Map();

  let segIdx = 0;
  let segOff = 0; // chars consumed within the current segment
  let pos = 0; // canonical offset
  let openAtom: AtomPiece | null = null; // the atom piece collecting units (cite)

  const skipEmpties = () => {
    while (segIdx < segments.length && expected[segIdx]!.length === 0) {
      segIdx++;
      segOff = 0;
    }
  };

  const fail = (why: string): never => {
    throw new ContainerMismatch(
      `container misalignment at canonical ${pos} (segment ${segIdx}): ${why}`
    );
  };

  /** Consume `text` (from DOM unit `node`, an element when the unit is a
   *  chip) against the current segment; record the unit. */
  const feed = (node: Text | Element, text: string) => {
    skipEmpties();
    if (segIdx >= segments.length) fail(`extra DOM content ${JSON.stringify(text.slice(0, 24))}…`);
    const seg = segments[segIdx]!;
    const want = expected[segIdx]!;
    // node-kind discipline: text nodes belong to text segments or cite atoms
    // (open/"; "/close); chip elements to cite/xref atoms. Math is placed by
    // the walk itself (its glyphs never match canonical text).
    if (node.nodeType === 3 && seg.type !== "text" && seg.type !== "cite") {
      fail(`text node ${JSON.stringify(text.slice(0, 24))} inside a ${seg.type} segment`);
    }
    if (node.nodeType === 1 && seg.type !== "cite" && seg.type !== "xref") {
      fail("chip element where no cite/xref segment was expected");
    }
    if (want.slice(segOff, segOff + text.length) !== text) {
      fail(
        `content mismatch: DOM ${JSON.stringify(text.slice(0, 24))} vs canonical ` +
          JSON.stringify(want.slice(segOff, segOff + text.length))
      );
    }
    if (seg.type === "text") {
      pieces.push({ kind: "text", node: node as Text, start: pos, end: pos + text.length });
      textIndex.set(node as Text, { piece: pieces[pieces.length - 1]!, local: 0 });
    } else {
      // cite/xref atom: collect the unit into the segment's one piece
      if (openAtom === null) {
        openAtom = {
          kind: "atom",
          atom: "chip",
          units: [],
          start: pos,
          end: pos + want.length,
        };
        pieces.push(openAtom);
      }
      openAtom.units.push({ node, local: segOff });
      if (node.nodeType === 3) textIndex.set(node as Text, { piece: openAtom, local: segOff });
      else atomRoots.set(node as Element, { piece: openAtom, local: segOff });
    }
    segOff += text.length;
    pos += text.length;
    if (segOff === want.length) {
      segIdx++;
      segOff = 0;
      openAtom = null;
    }
  };

  const walk = (el: Element) => {
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        const t = child as Text;
        if (t.data.length === 0) continue; // React drops "" children; tolerate
        feed(t, t.data);
      } else if (child.nodeType === 1) {
        const cel = child as Element;
        if (isSkipped(cel)) continue;
        if (cel.classList.contains("chip")) {
          feed(cel, cel.textContent ?? "");
        } else if (isMathRoot(cel)) {
          // math atoms carry NO visible-text match — verify placement only,
          // then record the wrapper as the atom's single unit
          skipEmpties();
          if (segIdx >= segments.length || segments[segIdx]!.type !== "math") {
            fail("math element where no math segment was expected");
          }
          const want = expected[segIdx]!;
          const piece: AtomPiece = {
            kind: "atom",
            atom: "math",
            units: [{ node: cel, local: 0 }],
            start: pos,
            end: pos + want.length,
          };
          pieces.push(piece);
          atomRoots.set(cel, { piece, local: 0 });
          pos += want.length;
          segIdx++;
          segOff = 0;
          openAtom = null;
        } else {
          walk(cel); // transparent wrapper (Segments span, etc.)
        }
      }
      // comments / other node types: ignore
    }
  };

  walk(containerEl);
  skipEmpties();
  if (segIdx < segments.length) {
    fail(`DOM ended before segment ${segIdx} (${segments[segIdx]!.type}) was fully matched`);
  }

  return { containerEl, canonical, pieces, textIndex, atomRoots };
}

// ---------------------------------------------------------------------------
// offsets → DOM positions → Range
// ---------------------------------------------------------------------------

interface DomPoint {
  node: Node;
  offset: number;
}

function childIndex(parent: Node, child: Node): number {
  return Array.prototype.indexOf.call(parent.childNodes, child);
}

function beforeUnit(u: AtomUnit): DomPoint {
  const parent = u.node.parentNode;
  if (!parent) throw new ContainerMismatch("atom unit detached from the DOM");
  return { node: parent, offset: childIndex(parent, u.node) };
}

function afterUnit(u: AtomUnit): DomPoint {
  const parent = u.node.parentNode;
  if (!parent) throw new ContainerMismatch("atom unit detached from the DOM");
  return { node: parent, offset: childIndex(parent, u.node) + 1 };
}

function leading(p: Piece): DomPoint {
  return p.kind === "text" ? { node: p.node, offset: 0 } : beforeUnit(p.units[0]!);
}

function trailing(p: Piece): DomPoint {
  return p.kind === "text"
    ? { node: p.node, offset: p.node.data.length }
    : afterUnit(p.units[p.units.length - 1]!);
}

/**
 * The DOM position for a canonical offset. `side` breaks boundary ties the
 * way range endpoints need: a range START at a piece boundary takes the
 * following piece's leading edge, a range END the preceding piece's trailing
 * edge; an offset strictly inside an atom (never produced for stored
 * targets) snaps to the atom's leading/trailing edge by side.
 */
export function pointAtOffset(
  map: ContainerMap,
  offset: number,
  side: "start" | "end"
): DomPoint {
  const { pieces } = map;
  const total = map.canonical.length;
  const off = Math.max(0, Math.min(offset, total));
  if (pieces.length === 0) return { node: map.containerEl, offset: 0 };
  if (off === 0) return leading(pieces[0]!);
  if (off === total) return trailing(pieces[pieces.length - 1]!);
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    if (off > p.start && off < p.end) {
      if (p.kind === "text") return { node: p.node, offset: off - p.start };
      return side === "start" ? beforeUnit(p.units[0]!) : afterUnit(p.units[p.units.length - 1]!);
    }
    if (off === p.start && side === "start") return leading(p);
    if (off === p.end && side === "end") return trailing(p);
  }
  // offset sits exactly on a boundary claimed by neither side (start-of-piece
  // with side=end or end-of-piece with side=start): the pieces tile the text
  // contiguously, so the neighboring iteration arm above already covered it;
  // reaching here means the map is corrupt.
  throw new ContainerMismatch(`no piece covers canonical offset ${offset}`);
}

/**
 * Build the DOM Range for a canonical `[start, end)` interval. Returns null
 * for out-of-range/inverted offsets instead of throwing (stored annotations
 * are authoritative under the fingerprint guarantee; this is purely
 * defensive — a failed range just skips that annotation's painting).
 */
export function rangeForOffsets(map: ContainerMap, start: number, end: number): Range | null {
  const total = map.canonical.length;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end > total ||
    start >= end
  ) {
    return null;
  }
  try {
    const s = pointAtOffset(map, start, "start");
    const e = pointAtOffset(map, end, "end");
    const range = map.containerEl.ownerDocument.createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DOM positions → offsets
// ---------------------------------------------------------------------------

/** Offset of `node` (a text leaf at `nodeOff`) within a chip element unit. */
function offsetWithinElement(root: Element, node: Text, nodeOff: number): number {
  let total = 0;
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let cur: Node | null;
  while ((cur = walker.nextNode())) {
    if (cur === node) return total + nodeOff;
    total += (cur as Text).data.length;
  }
  return total;
}

/** Canonical length of pieces entirely preceding `node` in document order —
 *  the mapping for points inside skipped subtrees (.ann-edge trailing a
 *  paragraph, .cap-label preceding caption content) or stray DOM. */
function boundaryByOrder(map: ContainerMap, node: Node): number {
  let total = 0;
  for (const p of map.pieces) {
    const last = p.kind === "text" ? p.node : p.units[p.units.length - 1]!.node;
    if (last === node) return p.end;
    const pos = last.compareDocumentPosition(node);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) total = p.end; // node follows the piece
    else break; // node precedes the piece (or nests inside its last unit)
  }
  return total;
}

/**
 * The canonical offset of a DOM point, with side-aware atomic normalization:
 * a point strictly inside an atomic segment maps to the atom's start (for a
 * range start) or end (for a range end). Returns null when the point lies
 * outside the container.
 */
export function pointToOffset(
  map: ContainerMap,
  node: Node,
  offset: number,
  side: "start" | "end"
): number | null {
  if (node !== map.containerEl && !map.containerEl.contains(node)) return null;

  // Descend (element, offset) points to the referenced leaf: child[offset]
  // at its start, or the last child's end when offset == childNodes.length.
  let n: Node = node;
  let off = offset;
  while (n.nodeType === 1) {
    const kids = n.childNodes;
    if (kids.length === 0) break; // empty element: resolve by document order
    if (off < kids.length) {
      n = kids[off]!;
      off = 0;
    } else {
      n = kids[kids.length - 1]!;
      off = n.nodeType === 3 ? (n as Text).data.length : n.childNodes.length;
    }
  }

  // The cap-label ("Figure 1. ") is chrome PRECEDING the canonical content,
  // not content: it has no offset. Unmappable (null) rather than clamped to
  // 0 — the capture layer rejects such selections with the standard toast,
  // and clicks there simply hit-test nothing. (The trailing .ann-edge stays
  // order-mapped instead: a selection tail dragged into the block's own
  // affordance means "to the end of the text", i.e. the canonical end.)
  {
    const leafHost = n.nodeType === 3 ? n.parentElement : (n as Element);
    if (leafHost && leafHost.closest(".cap-label")) return null;
  }

  if (n.nodeType === 3) {
    const t = n as Text;
    const direct = map.textIndex.get(t);
    if (direct) {
      const { piece, local } = direct;
      const raw = piece.start + local + off;
      if (piece.kind === "atom" && raw > piece.start && raw < piece.end) {
        return side === "start" ? piece.start : piece.end;
      }
      return raw;
    }
  }
  // a leaf inside an atom unit root (chip text, KaTeX glyph — incl. empty
  // element leaves like KaTeX's strut spans, where the descend stops)?
  for (const [root, { piece, local }] of map.atomRoots) {
    if (root === n || root.contains(n)) {
      if (piece.atom === "math") return side === "start" ? piece.start : piece.end;
      const raw =
        piece.start + local + (n.nodeType === 3 ? offsetWithinElement(root, n as Text, off) : 0);
      if (raw > piece.start && raw < piece.end) {
        return side === "start" ? piece.start : piece.end;
      }
      return raw;
    }
  }
  if (n === map.containerEl && map.pieces.length === 0) return 0;
  return boundaryByOrder(map, n);
}

/**
 * Resolve a DOM Range to canonical offsets within this container. Both
 * endpoints must land inside the container; atom-interior endpoints are
 * expanded to the whole atom (see `pointToOffset`). Returns null when either
 * endpoint is outside.
 */
export function offsetsForRange(
  map: ContainerMap,
  range: Range
): { start: number; end: number } | null {
  const start = pointToOffset(map, range.startContainer, range.startOffset, "start");
  const end = pointToOffset(map, range.endContainer, range.endOffset, "end");
  if (start === null || end === null) return null;
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Hit-testing variant for a collapsed caret point (click): atom interiors
 *  map to the atom's start, so a click anywhere on a chip/math hits an
 *  annotation covering the atom; boundaries are start-inclusive/end-exclusive. */
export function offsetForPoint(map: ContainerMap, node: Node, offset: number): number | null {
  return pointToOffset(map, node, offset, "start");
}

/** Container-spec equality (list items compare their index). */
export function sameContainer(
  a: AnnotationTextContainer,
  b: AnnotationTextContainer
): boolean {
  if (a.type !== b.type) return false;
  return a.type !== "list_item" || (b.type === "list_item" && a.index === b.index);
}

/**
 * Viewport point → caret position, behind the two vendor entry points
 * (Chrome/WebKit `caretRangeFromPoint`, Firefox `caretPositionFromPoint`).
 * Absent in happy-dom → returns null and click hit-testing silently no-ops.
 */
export function caretFromPoint(
  doc: Document,
  x: number,
  y: number
): { node: Node; offset: number } | null {
  if (typeof doc.caretRangeFromPoint === "function") {
    const r = doc.caretRangeFromPoint(x, y);
    return r ? { node: r.startContainer, offset: r.startOffset } : null;
  }
  if (typeof doc.caretPositionFromPoint === "function") {
    const p = doc.caretPositionFromPoint(x, y);
    return p ? { node: p.offsetNode, offset: p.offset } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Logical-container resolution (IR block + DOM node ↔ container spec)
// ---------------------------------------------------------------------------

export interface ResolvedContainer {
  blockId: string;
  container: AnnotationTextContainer;
  /** The container's DOM element (paragraph `<p>` / `<li>` / caption el). */
  el: Element;
  segments: IrSegment[];
}

/** The segments a container spec addresses on an IR block (null when the
 *  container does not exist there — wrong kind / missing caption / bad index). */
export function segmentsForContainer(
  node: IrBlock | IrSection,
  container: AnnotationTextContainer
): IrSegment[] | null {
  if ("blocks" in node) return null;
  switch (container.type) {
    case "content":
      return node.type === "paragraph" ? node.segments : null;
    case "list_item":
      return node.type === "list" ? (node.items[container.index]?.segments ?? null) : null;
    case "caption":
      return node.type === "figure" ||
        node.type === "table" ||
        node.type === "code" ||
        node.type === "algorithm"
        ? (node.captionSegments ?? null)
        : null;
  }
}

/** The DOM element carrying a container spec inside the block's element. */
export function containerElementFor(
  blockEl: Element,
  node: IrBlock | IrSection,
  container: AnnotationTextContainer
): Element | null {
  if ("blocks" in node) return null;
  switch (container.type) {
    case "content":
      return node.type === "paragraph" ? blockEl : null;
    case "list_item": {
      if (node.type !== "list") return null;
      const list = blockEl.querySelector(".doc-list");
      return (list?.children[container.index] as Element | undefined) ?? null;
    }
    case "caption":
      if (node.type === "figure") return blockEl.querySelector("figcaption");
      if (node.type === "table" || node.type === "code" || node.type === "algorithm") {
        return blockEl.querySelector(".tab-cap");
      }
      return null;
  }
}

/**
 * Resolve a DOM point to its logical text-annotation container: the nearest
 * `[data-block-id]` ancestor identifies the block (scoped to `root`, the
 * pane's `<main class="reader">`); the block's IR type then pins which
 * sub-element is the container. Returns null for every non-text-anchorable
 * position: outside any block, section headings, equation/code/algorithm
 * bodies, table bodies, figure images, and containers the IR doesn't carry.
 */
export function resolveContainerAt(
  node: Node,
  root: Element,
  blockById: Map<string, IrBlock>
): ResolvedContainer | null {
  const host = node.nodeType === 1 ? (node as Element) : node.parentElement;
  if (!host) return null;
  const blockEl = host.closest("[data-block-id]");
  if (!blockEl || !root.contains(blockEl)) return null;
  const blockId = (blockEl as HTMLElement).dataset.blockId;
  if (!blockId) return null;
  const irNode = blockById.get(blockId);
  if (!irNode || "blocks" in irNode) return null; // unknown / section heading

  let container: AnnotationTextContainer | null = null;
  if (irNode.type === "paragraph") {
    container = { type: "content" };
  } else if (irNode.type === "list") {
    const li = host.closest("li");
    if (!li || !blockEl.contains(li)) return null;
    const index = li.parentElement
      ? Array.prototype.indexOf.call(li.parentElement.children, li)
      : -1;
    if (index < 0 || index >= irNode.items.length) return null;
    container = { type: "list_item", index };
  } else if (irNode.type === "figure") {
    const cap = host.closest("figcaption");
    if (!cap || !blockEl.contains(cap)) return null;
    container = { type: "caption" };
  } else if (irNode.type === "table" || irNode.type === "code" || irNode.type === "algorithm") {
    const cap = host.closest(".tab-cap");
    if (!cap || !blockEl.contains(cap)) return null;
    container = { type: "caption" };
  } else {
    return null; // equation body
  }

  const el = containerElementFor(blockEl, irNode, container);
  const segments = segmentsForContainer(irNode, container);
  if (!el || !segments || !el.contains(host)) return null;
  return { blockId, container, el, segments };
}
