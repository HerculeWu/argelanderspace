import type { AnchorLadder, DomQuery, TutorialAnchor, WorkbenchSnapshot } from "./types";

/** How long a missing anchor is waited for before the card says the interface has changed (spec section 5). */
export const ANCHOR_MISSING_MS = 3000;

const esc = (value: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&"));

/** The selector of an anchor, without its scope. */
export function anchorSelector(anchor: TutorialAnchor): string {
  return `[data-ui="${esc(anchor.ui)}"]` + (anchor.key !== undefined ? `[data-ui-key="${esc(anchor.key)}"]` : "");
}

/** Where an anchor is looked up: the document, or the active workspace pane for a scoped one. */
function rootOf(doc: Document, anchor: TutorialAnchor, activePaneId: number | null): ParentNode | null {
  let root: ParentNode | null = doc;
  if (anchor.scope === "active-pane") {
    if (activePaneId === null) return null;
    root = doc.querySelector(`[data-ui="workspace-pane"][data-ui-key="${activePaneId}"]`);
  }
  if (root && anchor.within) root = root.querySelector(anchorSelector(anchor.within));
  return root;
}

/** Every element the anchor names now, in document order. */
export function resolveAll(doc: Document, anchor: TutorialAnchor, activePaneId: number | null): Element[] {
  const root = rootOf(doc, anchor, activePaneId);
  return root ? [...root.querySelectorAll(anchorSelector(anchor))] : [];
}

const warned = new Set<string>();
const isDev = () => {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
};

/**
 * The one element an anchor names. Several: the first in document order, with a warning in a development build
 * (a definition error the static test should have caught, or a page showing the same thing twice).
 */
export function resolveAnchor(doc: Document, anchor: TutorialAnchor, activePaneId: number | null, warn = isDev()): Element | null {
  const all = resolveAll(doc, anchor, activePaneId);
  if (all.length > 1 && warn) {
    const sel = anchorSelector(anchor);
    if (!warned.has(sel)) {
      warned.add(sel);
      console.warn(`tutorial anchor ${sel} matches ${all.length} elements; the first is used`);
    }
  }
  return all[0] ?? null;
}

/**
 * Whether an element is drawn at all: it has a box of some size and is not invisible. A zero-size element (inside a
 * `display: none` parent, an empty placeholder) or a `visibility: hidden` one is not there for the ladder — it is
 * neither highlighted nor said to be out of view, and does not hide a lower rung.
 */
export function isRendered(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const view = el.ownerDocument.defaultView;
  const visibility = view ? view.getComputedStyle(el).visibility : "visible";
  return visibility !== "hidden" && visibility !== "collapse";
}

/** The ladder level to highlight: the last one present and drawn now; null when none is. */
export function resolveLadder(
  doc: Document,
  ladder: AnchorLadder,
  activePaneId: number | null,
  rendered: (el: Element) => boolean = () => true,
): { anchor: TutorialAnchor; element: Element } | null {
  for (let i = ladder.length - 1; i >= 0; i--) {
    const anchor = ladder[i]!;
    const element = resolveAnchor(doc, anchor, activePaneId);
    if (element && rendered(element)) return { anchor, element };
  }
  return null;
}

/** The rungs that apply now: those without a condition, and those whose condition holds for the snapshot. */
export function activeRungs(ladder: AnchorLadder, snapshot: WorkbenchSnapshot): AnchorLadder {
  return ladder.every((a) => !a.when) ? ladder : ladder.filter((a) => !a.when || a.when(snapshot));
}

/** The L3 query over a document. */
export function domQuery(doc: Document, activePaneId: number | null): DomQuery {
  return {
    present: (anchor) => resolveAll(doc, anchor, activePaneId).length > 0,
    attr: (anchor, name) => resolveAll(doc, anchor, activePaneId)[0]?.getAttribute(name) ?? null,
  };
}

export interface Measured {
  /** The rectangle to highlight (the visible part when clipped); null when nothing is shown. */
  rect: DOMRect | null;
  /** The element's whole box, clipped or not (for the chapter rail's overlap test); null when it has no size. */
  box?: DOMRect | null;
  /** At least half of the element is inside its scroll containers and the window. */
  visible: boolean;
}

/**
 * Whether an element is on screen: more than half of it cut off by a scroll container or the window is not; an element
 * larger than that view along a side is on screen when it fills more than half of the view along that side. The
 * containers are its ancestors up to the first fixed-position element (itself included): a fixed element is placed
 * against the window, so the containers above it do not cut it off (a popover or editor whose DOM sits inside the
 * reader's scroll container; ticket 21, F2). That fixed element's own overflow still clips what is inside it.
 */
export function measure(el: Element, win: Window = window): Measured {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return { rect: null, box: null, visible: false };
  // The view: the window cut down by every clipping container (as above).
  let top = 0;
  let left = 0;
  let right = win.innerWidth;
  let bottom = win.innerHeight;
  const fixed = (node: Element) => win.getComputedStyle(node).position === "fixed";
  for (let p = fixed(el) ? null : el.parentElement; p && p !== win.document.body; p = fixed(p) ? null : p.parentElement) {
    const cs = win.getComputedStyle(p);
    if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) {
      const pr = p.getBoundingClientRect();
      top = Math.max(top, pr.top);
      left = Math.max(left, pr.left);
      right = Math.min(right, pr.right);
      bottom = Math.min(bottom, pr.bottom);
    }
  }
  const viewW = right - left;
  const viewH = bottom - top;
  const w = Math.min(right, r.right) - Math.max(left, r.left);
  const h = Math.min(bottom, r.bottom) - Math.max(top, r.top);
  // More than half of itself is in view; or, for an anchor larger than the view along a side (a whole manuscript paper),
  // more than half of the view along that side is filled by it (each side measured against the smaller of the two).
  const fits = w > 0 && h > 0 && (w * h) / (r.width * r.height) >= 0.5;
  const larger = r.width > viewW || r.height > viewH;
  const fills = w > 0 && h > 0 && larger && (w / Math.min(r.width, viewW)) * (h / Math.min(r.height, viewH)) > 0.5;
  const visible = fits || fills;
  return { rect: visible ? new DOMRect(Math.max(left, r.left), Math.max(top, r.top), w, h) : null, box: r, visible };
}
