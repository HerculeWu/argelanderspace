/**
 * The viewport and pointer state machine both graph renderers share
 * (`GraphCanvas`, force layout; `LayeredGraphCanvas`, layered layout).
 *
 * It owns what is the same for any graph picture: the measured canvas size, the
 * view (`tx`/`ty`/`k`) and its per-scene stash, zoom about a point, screen/world
 * conversion, wheel, pan, two-finger pinch, node drag, hover with its tooltip
 * anchor, the hover neighbourhood, and the keyboard/focus shell of a node `g`.
 *
 * It does not know what a node is drawn as, how nodes are placed, or what a drag
 * does to them. Those stay with the renderer and arrive as callbacks:
 * `onNodeDrag` / `onNodeRelease` (force layout: pin and reheat; layered: move the
 * point), `onUserView` (the user took the view over: stop auto-fitting), and an
 * optional `gesture` factory for a drag that starts on a special target (the
 * layered renderer's connect handle). Fitting is the renderer's, because what
 * "fit" means differs; it calls `setView` with the result.
 *
 * A controller (zoom in/out, fit, relayout) is built by the renderer from
 * `zoomCenter`, its own `fit` and `relayout`; see `GraphCanvas`.
 */

import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject, type WheelEvent, useEffect, useMemo, useReducer, useRef, useState } from "react";

export const ZOOM_MIN = 0.3;
export const ZOOM_MAX = 3.2;

export type View = { tx: number; ty: number; k: number };
export type Point = { x: number; y: number };

/** The part of a per-scene stash the viewport reads and writes. */
export interface ViewStash {
  view?: View | null;
}

/** A drag that starts on a special target and replaces pan / node drag until the pointer lifts. */
export interface Gesture {
  move: (e: { clientX: number; clientY: number }, world: Point) => void;
  end: (e: { clientX: number; clientY: number }, world: Point) => void;
  cancel: () => void;
}

export interface ViewportOptions {
  /** A change re-reads the view from the stash. */
  sceneKey: string;
  stash: ViewStash;
  nodes: readonly { id: string }[];
  /** Undirected neighbourhood source: hovering a node lights it and the nodes these link it to. */
  links: readonly (readonly [string, string])[];
  onSelect: (id: string | null) => void;
  /** Nodes that can be dragged (default all); a non-draggable node pans the canvas instead. */
  canDrag?: (id: string) => boolean;
  /** A dragged node followed the pointer; `moved` is false until the pointer travelled a few pixels. */
  onNodeDrag?: (id: string, world: Point, moved: boolean) => void;
  onNodeRelease?: (id: string) => void;
  /** The user panned or zoomed. */
  onUserView?: () => void;
  /** Decide, from the pointer-down target, whether this drag is a special gesture. */
  gesture?: (
    target: Element,
    api: {
      world: Point;
      setHover: (id: string | null) => void;
      /** The node of this canvas under a screen point (elements of other canvases and unknown ids do not count). */
      nodeAt: (e: { clientX: number; clientY: number }) => string | null;
    }
  ) => Gesture | null;
  /** Where the tooltip sits for a hovered point; default the point itself. */
  tooltipAt?: (pt: Point, size: { w: number; h: number }) => Point;
}

type Drag =
  | { mode: "pan"; x: number; y: number; tx: number; ty: number; moved: boolean }
  | { mode: "node"; id: string; x: number; y: number; moved: boolean }
  | { mode: "pinch"; d: number; k: number; wx: number; wy: number }
  | { mode: "gesture"; g: Gesture }
  | null;

export function useGraphViewport(o: ViewportOptions) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHoverId] = useState<string | null>(null);
  /** Who set the hover: the pointer, or keyboard focus on a node. */
  const [hoverByFocus, setHoverByFocus] = useState(false);
  const setHover = (id: string | null) => {
    setHoverId(id);
    setHoverByFocus(false);
  };
  const [tooltip, setTooltip] = useState<Point | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of o.nodes) m.set(n.id, new Set());
    for (const [a, b] of o.links) {
      m.get(a)?.add(b);
      m.get(b)?.add(a);
    }
    return m;
  }, [o.nodes, o.links]);
  // A gesture lives from press to release; the node set it drops onto is the latest one, not the one at press.
  const adjRef = useRef(adj);
  adjRef.current = adj;

  const view = useRef<View | null>(null);
  const viewKey = useRef<string | null>(null);
  if (viewKey.current !== o.sceneKey) {
    viewKey.current = o.sceneKey;
    view.current = o.stash.view ? { ...o.stash.view } : null;
  }
  const persist = () => {
    if (view.current) o.stash.view = { ...view.current };
  };
  const fallback = (): View => ({ tx: size.w / 2, ty: size.h / 2, k: 1 });

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0]!.contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  /** Replace the view (a fit, a recentre), keep it in the stash and redraw. */
  const setView = (next: View) => {
    view.current = next;
    persist();
    bump();
  };

  const clearHover = () => {
    setHover(null);
    setTooltip(null);
  };

  const zoomAt = (f: number, cx: number, cy: number) => {
    const v = view.current ?? fallback();
    const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.k * f));
    const r = k / v.k;
    view.current = { tx: cx - (cx - v.tx) * r, ty: cy - (cy - v.ty) * r, k };
    persist();
    o.onUserView?.();
    clearHover();
    bump();
  };

  const svgPoint = (e: { clientX: number; clientY: number }): Point => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (x: number, y: number): Point => {
    const v = view.current ?? fallback();
    return { x: (x - v.tx) / v.k, y: (y - v.ty) / v.k };
  };

  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<Drag>(null);
  const idAt = (target: Element) => target.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
  const nodeAt = (e: { clientX: number; clientY: number }) => {
    const el = document.elementFromPoint?.(e.clientX, e.clientY)?.closest("[data-node-id]");
    if (!el || !wrapRef.current?.contains(el)) return null;
    const id = el.getAttribute("data-node-id");
    return id && adjRef.current.has(id) ? id : null;
  };
  const pair = () => {
    const [a, b] = [...pointers.current.values()];
    return { cx: (a!.x + b!.x) / 2, cy: (a!.y + b!.y) / 2, dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
  };

  /** Drop whatever drag is under way; a gesture is told, so it can clean up what it drew. */
  const endDrag = () => {
    if (drag.current?.mode === "gesture") drag.current.g.cancel();
    drag.current = null;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    e.preventDefault();
    svgRef.current?.focus({ preventScroll: true });
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // synthetic/legacy pointer streams may not hold an active pointer
    }
    const pt = svgPoint(e);
    pointers.current.set(e.pointerId, pt);
    endDrag();
    if (pointers.current.size === 2) {
      const p = pair();
      const w = toWorld(p.cx, p.cy);
      drag.current = { mode: "pinch", d: p.dist, k: (view.current ?? { k: 1 }).k, wx: w.x, wy: w.y };
      return;
    }
    const target = e.target as Element;
    const g = o.gesture?.(target, { world: toWorld(pt.x, pt.y), setHover, nodeAt });
    if (g) {
      drag.current = { mode: "gesture", g };
    } else {
      const id = idAt(target);
      const v = view.current ?? fallback();
      drag.current =
        id && (o.canDrag?.(id) ?? true)
          ? { mode: "node", id, x: pt.x, y: pt.y, moved: false }
          : { mode: "pan", x: pt.x, y: pt.y, tx: v.tx, ty: v.ty, moved: false };
    }
    clearHover();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const pt = svgPoint(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, pt);
    const d = drag.current;
    if (d?.mode === "pinch") {
      if (pointers.current.size >= 2) {
        const p = pair();
        const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (d.k * p.dist) / (d.d || 1)));
        view.current = { tx: p.cx - d.wx * k, ty: p.cy - d.wy * k, k };
        persist();
        o.onUserView?.();
        bump();
      }
      return;
    }
    if (d?.mode === "gesture") {
      d.g.move(e, toWorld(pt.x, pt.y));
      return;
    }
    if (d) {
      const dx = pt.x - d.x;
      const dy = pt.y - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.mode === "pan") {
        view.current = { tx: d.tx + dx, ty: d.ty + dy, k: (view.current ?? { k: 1 }).k };
        persist();
        if (d.moved) o.onUserView?.();
        bump();
      } else {
        o.onNodeDrag?.(d.id, toWorld(pt.x, pt.y), d.moved);
      }
      return;
    }
    if (e.pointerType === "touch") return;
    const id = idAt(e.target as Element);
    if (id && adj.has(id)) {
      setHover(id);
      setTooltip(o.tooltipAt ? o.tooltipAt(pt, size) : pt);
    } else if (hover) {
      clearHover();
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    pointers.current.delete(e.pointerId);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (d?.mode === "gesture") {
      const pt = svgPoint(e);
      drag.current = null;
      d.g.end(e, toWorld(pt.x, pt.y));
    } else {
      if (d?.mode === "node") o.onNodeRelease?.(d.id);
      if (d && d.mode !== "pinch" && !d.moved) o.onSelect(d.mode === "node" ? d.id : null);
      drag.current = pointers.current.size > 0 && d?.mode === "pinch" ? d : null;
    }
    clearHover();
  };

  const onPointerCancel = () => {
    endDrag();
    pointers.current.clear();
  };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const pt = svgPoint(e);
    zoomAt(Math.exp(-e.deltaY * 0.0014), pt.x, pt.y);
  };

  const onMouseLeave = () => {
    if (!drag.current) clearHover();
  };

  const neighbors = hover ? adj.get(hover) : null;

  return {
    wrapRef: wrapRef as RefObject<HTMLDivElement>,
    svgRef: svgRef as RefObject<SVGSVGElement>,
    size,
    /** The current view, or the centred identity before the first fit. */
    v: view.current ?? fallback(),
    /** The live view (effects need it fresher than the render snapshot `v`), or null before the first fit. */
    getView: () => view.current,
    /** False until a fit (or a stash) has given the scene a view. */
    hasView: () => view.current !== null,
    setView,
    zoomAt,
    /** Zoom about the canvas centre (the zoom buttons). */
    zoomCenter: (f: number) => zoomAt(f, size.w / 2, size.h / 2),
    redraw: bump,
    hover,
    /** The hover comes from keyboard focus on a node, not from the pointer. */
    hoverByFocus,
    setHover,
    tooltip,
    /** True while a pointer drag is under way (the tooltip stays hidden). */
    dragging: drag.current !== null,
    adj,
    /** With a hover: is this node the hovered one or next to it. */
    near: (id: string) => id === hover || (neighbors?.has(id) ?? false),
    /** Pointer and wheel handlers for the `<svg>`. */
    svgProps: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onWheel, onMouseLeave },
    /** Keyboard and focus shell of a node `g`: focusable button, Enter selects, focus lights the neighbourhood. */
    nodeProps: (id: string, name: string) => ({
      tabIndex: 0,
      role: "button" as const,
      "aria-label": name,
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          o.onSelect(id);
        }
      },
      onFocus: () => {
        setHoverId(id);
        setHoverByFocus(true);
      },
      onBlur: () => setHoverId((h) => (h === id ? null : h)),
    }),
  };
}
