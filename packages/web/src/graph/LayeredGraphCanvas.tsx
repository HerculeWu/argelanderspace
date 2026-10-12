/**
 * Layered graph canvas: the shared renderer's layered layout. Where `GraphCanvas`
 * runs a force layout for citation graphs, this one draws a directed graph in
 * rows (see `layered/layout.ts`), with
 *
 * - edges that carry a colour, a line style and an optional text label,
 *   several edges between the same two nodes fanned apart;
 * - nodes of one size, coloured by the caller, optionally double-ringed and
 *   marked with a small badge;
 * - a short label per node, at most two lines, on the right by default and on
 *   whichever other side is emptiest when the right is taken;
 * - chain focus: pick a node and its whole upstream and downstream chain stays
 *   lit while the rest dims;
 * - an optional drag-from-handle gesture that reports `(from, to, screen point)`;
 * - fit-to-window that keeps clear of the heading, legend and zoom controls,
 *   refits on resize until the user pans or zooms, and keeps the selection in view.
 *
 * It knows nothing about what the nodes and edges mean: colours, line styles,
 * badge text, tooltip content, legend and copy all arrive from the adapter.
 * The layout is derived from the nodes and edges; any change to their
 * structure, pins or labels recomputes it, so a drag lasts only until then.
 * Pan, wheel and pinch zoom, select and the zoom controls behave as in
 * `GraphCanvas`.
 */

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import { GraphZoomControls } from "./GraphZoomControls";
import { edgePath, focusChain, pairFan } from "./layered/geometry";
import { type LayoutPoint, layeredLayout } from "./layered/layout";
import { type Box, placeEdgeLabels, placeNodeLabels } from "./layered/placement";
import { LABEL_FONT_MAX, LABEL_ZOOM_FLOOR, labelWidth, textUnits, wrapLabel } from "./layered/text";

export interface LayeredNodeSpec {
  id: string;
  /** Short label drawn beside the node (wrapped to at most two lines). */
  label: string;
  /** Accessible name of the node. */
  name: string;
  /** CSS colour of the dot. */
  color: string;
  /** Double ring (a terminal node). */
  ringed?: boolean;
  /** `first`: pinned to the bottom row. `last`: pinned to the top row. */
  pin?: "first" | "last";
  /** Small badge on the node, with its accessible name; colours are the adapter's (the canvas has a neutral default). */
  mark?: { text: string; label: string; color?: string; textColor?: string };
}

export interface LayeredEdgeSpec {
  /** Unique within the graph. */
  id: string;
  from: string;
  to: string;
  /** Stroke colour while the edge is lit (hovered or in the focus chain). */
  color: string;
  /** Stroke colour at rest; omitted = the neutral edge colour. */
  restingColor?: string;
  dash?: "dashed" | "dotted";
  /** Text drawn on the edge while it is lit, or always when `showLabel`. */
  label?: string;
  showLabel?: boolean;
  /** Colour of the label text; omitted = the normal text colour. */
  labelColor?: string;
  /** Drawn a little heavier than the other edges, at rest and lit. */
  heavy?: boolean;
  /** Opaque adapter tag, exposed as `data-edge-tag`. */
  tag?: string;
}

export interface LayeredCanvasStash {
  pos?: Record<string, LayoutPoint>;
  view?: { tx: number; ty: number; k: number } | null;
  sig?: string;
  /** The view is still the automatic fit (no manual pan or zoom since). */
  auto?: boolean;
}

export interface LayeredGraphCanvasProps {
  nodes: LayeredNodeSpec[];
  edges: LayeredEdgeSpec[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Per-scene persistence bag (positions + viewport). */
  stash: LayeredCanvasStash;
  /** Identity of the scene: a change re-seeds positions and the view from the stash. */
  sceneKey: string;
  /** Prefix of the `data-ui` hooks (`<ui>-canvas`, `<ui>-node`, `<ui>-edge`, ...). */
  ui: string;
  heading: string;
  note: string;
  /** Legend body, rendered inside the legend card (adapter copy). */
  legend: ReactNode;
  /** Hover tooltip body for a node. */
  renderTooltip: (id: string) => ReactNode;
  /**
   * Drag-from-handle gesture: the selected node shows a handle; dropping it on a
   * node (including the node itself) calls this with `(from, to, screen point)`.
   * Omit to show no handle.
   */
  onConnect?: (from: string, to: string, at: { x: number; y: number }) => void;
  /** Tooltip of the handle. */
  connectHint?: string;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 3.2;
const R = 10;
const NEUTRAL = "var(--border)";
/** Fallback overlay clearance when the overlays cannot be measured. */
const INSET = { l: 24, r: 64, t: 78, b: 104 };
/** Keep-visible margins for the selected node (its label sits to its right). */
const KEEP = { l: 64, r: 176, t: 74, b: 96 };

type View = { tx: number; ty: number; k: number };
type Drag =
  | { mode: "pan"; x: number; y: number; tx: number; ty: number; moved: boolean }
  | { mode: "node"; id: string; x: number; y: number; moved: boolean }
  | { mode: "connect"; from: string }
  | { mode: "pinch"; d: number; k: number; wx: number; wy: number }
  | null;

export function LayeredGraphCanvas({
  nodes,
  edges,
  selectedId,
  onSelect,
  stash,
  sceneKey,
  ui,
  heading,
  note,
  legend,
  renderTooltip,
  onConnect,
  connectHint,
}: LayeredGraphCanvasProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const noteRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const [tipBox, setTipBox] = useState({ w: 280, h: 150 });
  const tipRef = useRef<HTMLDivElement>(null);
  const [rubber, setRubber] = useState<{ from: string; x: number; y: number } | null>(null);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>(nodes.map((n) => [n.id, new Set<string>()]));
    for (const e of edges) {
      m.get(e.from)?.add(e.to);
      m.get(e.to)?.add(e.from);
    }
    return m;
  }, [nodes, edges]);
  const chain = useMemo(
    () => (selectedId && nodeById.has(selectedId) ? focusChain(edges, selectedId) : null),
    [selectedId, edges, nodeById]
  );

  // The layout is a function of structure, pins and labels; colours, badges and tooltips do not move anything.
  const sig =
    sceneKey +
    "|" +
    nodes.map((n) => `${n.id}\u0001${n.pin ?? ""}\u0001${n.label}`).join("\u0002") +
    "|" +
    edges.map((e) => `${e.id}\u0001${e.from}\u0001${e.to}`).join("\u0002");
  const layout = useMemo(
    () =>
      layeredLayout({
        nodes: nodes.map((n) => ({ id: n.id, pin: n.pin, labelWidth: labelWidth(n.label) })),
        edges: edges.map((e) => ({ id: e.id, from: e.from, to: e.to })),
      }),
    [sig]
  );
  const P = useRef<Record<string, LayoutPoint>>({});
  if (stash.sig !== sig || !stash.pos) {
    stash.pos = Object.fromEntries(Object.entries(layout.pos).map(([k, v]) => [k, { ...v }]));
    stash.sig = sig;
  }
  P.current = stash.pos;

  const view = useRef<View | null>(null);
  const viewKey = useRef<string | null>(null);
  if (viewKey.current !== sceneKey) {
    viewKey.current = sceneKey;
    view.current = stash.view ? { ...stash.view } : null;
  }
  const persist = () => {
    if (view.current) stash.view = { ...view.current };
  };

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0]!.contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (size.w > 0 && (view.current === null || stash.auto)) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, sceneKey, sig]);

  /**
   * How far the heading (top) and the legend (bottom) reach into the canvas. The zoom stack sits at the
   * right edge and is cleared by the right inset, so it does not enter the bottom inset.
   */
  function overlayInsets() {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const rect = (el: HTMLElement | null) => (wrap && el ? el.getBoundingClientRect() : null);
    const head = rect(noteRef.current);
    const leg = rect(legendRef.current);
    const top = head && head.height > 0 ? head.bottom - wrap!.top + 14 : 0;
    const bottom = leg && leg.height > 0 ? wrap!.bottom - leg.top + 14 : 0;
    return { t: Math.max(INSET.t, top), b: Math.max(INSET.b, bottom) };
  }

  function fitView() {
    const ps = nodes.map((n) => P.current[n.id]).filter((p): p is LayoutPoint => !!p);
    if (!ps.length || !size.w) return;
    const inset = { ...INSET, ...overlayInsets() };
    const widest = Math.max(...nodes.map((n) => textUnits(wrapLabel(n.label || "—")[0] ?? "")), 0) * LABEL_FONT_MAX;
    const minX = Math.min(...ps.map((p) => p.x)) - 34;
    const maxX = Math.max(...ps.map((p) => p.x)) + 34 + widest;
    const minY = Math.min(...ps.map((p) => p.y)) - 30;
    const maxY = Math.max(...ps.map((p) => p.y)) + 30;
    const w = Math.max(120, size.w - inset.l - inset.r);
    const h = Math.max(120, size.h - inset.t - inset.b);
    const k = Math.max(ZOOM_MIN, Math.min(1.4, Math.min(w / (maxX - minX || 1), h / (maxY - minY || 1))));
    view.current = {
      tx: inset.l + w / 2 - ((minX + maxX) / 2) * k,
      ty: inset.t + h / 2 - ((minY + maxY) / 2) * k,
      k,
    };
    persist();
    stash.auto = true;
    bump();
  }

  // A narrower canvas (a panel opening), a new selection or a new layout: keep the selected node, and its label, on screen.
  useEffect(() => {
    const p = selectedId ? P.current[selectedId] : null;
    const cur = view.current;
    if (!p || !cur || !size.w) return;
    const sx = p.x * cur.k + cur.tx;
    const sy = p.y * cur.k + cur.ty;
    const m = { ...KEEP, ...overlayInsets() };
    const dx = sx < KEEP.l ? KEEP.l - sx : sx > size.w - KEEP.r ? size.w - KEEP.r - sx : 0;
    const dy = sy < m.t - 4 ? m.t - 4 - sy : sy > size.h - m.b + 8 ? size.h - m.b + 8 - sy : 0;
    if (dx || dy) {
      view.current = { ...cur, tx: cur.tx + dx, ty: cur.ty + dy };
      persist();
      bump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, size.w, size.h, sig]);

  const zoomAt = (f: number, cx: number, cy: number) => {
    const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
    const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.k * f));
    const r = k / v.k;
    view.current = { tx: cx - (cx - v.tx) * r, ty: cy - (cy - v.ty) * r, k };
    persist();
    stash.auto = false;
    setHover(null);
    setTooltip(null);
    bump();
  };
  const relayout = () => {
    stash.pos = Object.fromEntries(Object.entries(layout.pos).map(([k, v]) => [k, { ...v }]));
    P.current = stash.pos;
    fitView();
  };

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<Drag>(null);
  const svgPoint = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (x: number, y: number) => {
    const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
    return { x: (x - v.tx) / v.k, y: (y - v.ty) / v.k };
  };
  /** The node of this canvas under a screen point; elements of other canvases or unknown ids do not count. */
  const nodeAt = (e: { clientX: number; clientY: number }) => {
    const el = document.elementFromPoint?.(e.clientX, e.clientY)?.closest("[data-node-id]");
    if (!el || !wrapRef.current?.contains(el)) return null;
    const id = el.getAttribute("data-node-id");
    return id && nodeById.has(id) ? id : null;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    e.preventDefault();
    const target = e.target as Element;
    const pt = svgPoint(e);
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // synthetic/legacy pointer streams may not hold an active pointer
    }
    pointers.current.set(e.pointerId, pt);
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const w = toWorld((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
      drag.current = { mode: "pinch", d: Math.hypot(a!.x - b!.x, a!.y - b!.y), k: (view.current ?? { k: 1 }).k, wx: w.x, wy: w.y };
      setRubber(null);
      return;
    }
    const handle = target.closest("[data-connect-from]")?.getAttribute("data-connect-from") ?? null;
    const id = target.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
    const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
    if (handle) {
      drag.current = { mode: "connect", from: handle };
      const w = toWorld(pt.x, pt.y);
      setRubber({ from: handle, x: w.x, y: w.y });
    } else {
      drag.current = id
        ? { mode: "node", id, x: pt.x, y: pt.y, moved: false }
        : { mode: "pan", x: pt.x, y: pt.y, tx: v.tx, ty: v.ty, moved: false };
    }
    setHover(null);
    setTooltip(null);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = svgPoint(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, pt);
    const d = drag.current;
    if (d?.mode === "pinch") {
      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const cx = (a!.x + b!.x) / 2;
        const cy = (a!.y + b!.y) / 2;
        const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (d.k * Math.hypot(a!.x - b!.x, a!.y - b!.y)) / (d.d || 1)));
        view.current = { tx: cx - d.wx * k, ty: cy - d.wy * k, k };
        persist();
        stash.auto = false;
        bump();
      }
      return;
    }
    if (d?.mode === "connect") {
      const w = toWorld(pt.x, pt.y);
      setRubber({ from: d.from, x: w.x, y: w.y });
      setHover(nodeAt(e));
      return;
    }
    if (d) {
      const dx = pt.x - d.x;
      const dy = pt.y - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.mode === "pan") {
        view.current = { tx: d.tx + dx, ty: d.ty + dy, k: (view.current ?? { k: 1 }).k };
        persist();
        if (d.moved) stash.auto = false;
      } else if (d.moved) {
        const w = toWorld(pt.x, pt.y);
        const p = P.current[d.id];
        if (p) {
          p.x = w.x;
          p.y = w.y;
        }
      }
      bump();
      return;
    }
    if (e.pointerType === "touch") return;
    const id = (e.target as Element).closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
    if (id && nodeById.has(id)) {
      setHover(id);
      setTooltip({ x: pt.x, y: pt.y });
    } else if (hover) {
      setHover(null);
      setTooltip(null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    pointers.current.delete(e.pointerId);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (d?.mode === "pinch") {
      drag.current = pointers.current.size > 0 ? d : null;
      return;
    }
    drag.current = null;
    if (d?.mode === "connect") {
      const to = nodeAt(e);
      setRubber(null);
      setHover(null);
      if (to) onConnect?.(d.from, to, { x: e.clientX, y: e.clientY });
      return;
    }
    if (d && !d.moved) onSelect(d.mode === "node" ? d.id : null);
    setHover(null);
    setTooltip(null);
  };

  const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
  const neighbors = hover ? adj.get(hover) : null;
  const lit = (id: string) => (hover ? id === hover || (neighbors?.has(id) ?? false) : chain ? chain.nodes.has(id) : true);
  const dimAll = !!hover || !!chain;

  // marker per distinct edge colour; ids are scoped to the scene so two canvases never share one
  const colors = [NEUTRAL, ...new Set(edges.flatMap((e) => [e.color, e.restingColor]).filter((c): c is string => !!c && c !== NEUTRAL))];
  const markerId = (color: string) => `${ui}-arrow-${sceneKey.replace(/[^a-z0-9]/gi, "")}-${colors.indexOf(color)}`;

  const fs = 10.5 / Math.max(v.k, LABEL_ZOOM_FLOOR);
  const lfs = 9.5 / Math.max(v.k, 0.7);
  const lines = new Map(nodes.map((n) => [n.id, wrapLabel(n.label || "—")]));

  // 1. edge geometry
  const fan = pairFan(edges);
  const geo = edges.map((e, i) => {
    const p = P.current[e.from];
    const q = P.current[e.to];
    if (!p || !q) return null;
    const on = (!!hover && (e.from === hover || e.to === hover)) || (chain?.edges.has(e.id) ?? false);
    const f = fan[i]!;
    const path = edgePath(p, q, R + 3, R + 9 / v.k + 2, layout.routes[e.id] ?? [], (f.index - (f.total - 1) / 2) * 30);
    return { e, on, d: path.d, samples: path.samples };
  });

  // 2. node labels
  const placed = placeNodeLabels(
    nodes.flatMap((n) => (P.current[n.id] ? [{ id: n.id, at: P.current[n.id]!, lines: lines.get(n.id)! }] : [])),
    { fs, radius: R, edgePoints: geo.flatMap((g) => g?.samples ?? []) }
  );

  // 3. edge labels avoid nodes, node labels and each other
  const nodeBoxes: Box[] = nodes.flatMap((n) => {
    const p = P.current[n.id];
    return p ? [{ l: p.x - R - 5, r: p.x + R + 5, t: p.y - R - 5, b: p.y + R + 5 }] : [];
  });
  const edgeLabelAt = placeEdgeLabels(
    geo.flatMap((g) => (g && g.e.label && (g.e.showLabel || g.on) ? [{ id: g.e.id, text: g.e.label, samples: g.samples }] : [])),
    [...nodeBoxes, ...[...placed.values()].map((s) => s.box)],
    lfs
  );

  const hoverNode = hover ? nodeById.get(hover) : null;
  const showTip = !!hoverNode && !!tooltip && !drag.current;
  // The tooltip is clamped by its measured size (its height depends on the text), before paint.
  const measureTip = () => {
    const el = tipRef.current;
    if (el) setTipBox((t) => (t.w === el.offsetWidth && t.h === el.offsetHeight ? t : { w: el.offsetWidth, h: el.offsetHeight }));
  };
  useLayoutEffect(measureTip);
  useEffect(() => {
    // fonts and math settle after the first paint and change the height
    const el = tipRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measureTip);
    ro.observe(el);
    return () => ro.disconnect();
  }, [showTip, hover]);
  const tipPos = tooltip
    ? { left: Math.max(8, Math.min(tooltip.x + 18, size.w - tipBox.w - 8)), top: Math.max(8, Math.min(tooltip.y + 15, size.h - tipBox.h - 8)) }
    : null;

  return (
    <div className="cg-wrap lg-canvas" ref={wrapRef} data-ui={`${ui}-canvas`} data-scene={sceneKey}>
      <svg
        className="cg-svg"
        ref={svgRef}
        width="100%"
        height="100%"
        role="img"
        aria-label={heading}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pointers.current.clear();
          drag.current = null;
          setRubber(null);
        }}
        onWheel={(e) => {
          const pt = svgPoint(e);
          zoomAt(Math.exp(-e.deltaY * 0.0014), pt.x, pt.y);
        }}
        onMouseLeave={() => {
          if (!drag.current) {
            setHover(null);
            setTooltip(null);
          }
        }}
      >
        <defs>
          {colors.map((c) => (
            <marker key={c} id={markerId(c)} markerWidth={7 / v.k} markerHeight={7 / v.k} refX={6 / v.k} refY={3.5 / v.k} orient="auto" markerUnits="userSpaceOnUse">
              <path d={`M0,0 L${7 / v.k},${3.5 / v.k} L0,${7 / v.k} z`} fill={c} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${v.tx} ${v.ty}) scale(${v.k})`}>
          <g className="cg-edges">
            {geo.map((g) => {
              if (!g) return null;
              const { e, on } = g;
              const stroke = on ? e.color : e.restingColor;
              const label = edgeLabelAt.get(e.id);
              return (
                <g key={e.id} className={"lg-edge-g" + (dimAll && !on ? " dim" : "")} data-ui={`${ui}-edge`} data-ui-key={e.id} data-edge-tag={e.tag}>
                  <path
                    d={g.d}
                    fill="none"
                    className={"cg-edge lg-edge" + (e.dash ? ` lg-edge-${e.dash}` : "") + (e.heavy ? " lg-edge-heavy" : "") + (on ? " on" : "")}
                    style={stroke ? { stroke } : undefined}
                    markerEnd={`url(#${markerId(stroke ?? NEUTRAL)})`}
                  />
                  {label && (
                    <text className="lg-edge-label" x={label.x} y={label.y + lfs * 0.35} textAnchor="middle" style={{ fontSize: lfs, strokeWidth: 4 / v.k, fill: e.labelColor }}>
                      {e.label}
                    </text>
                  )}
                </g>
              );
            })}
            {rubber && P.current[rubber.from] && (
              <line className="lg-rubber" x1={P.current[rubber.from]!.x} y1={P.current[rubber.from]!.y} x2={rubber.x} y2={rubber.y} />
            )}
          </g>
          {nodes.map((n) => {
            const p = P.current[n.id];
            if (!p) return null;
            const sel = n.id === selectedId;
            const side = placed.get(n.id)?.side ?? "right";
            const ls = lines.get(n.id)!;
            const showLabel = !chain || chain.nodes.has(n.id) || n.id === hover;
            return (
              <g
                key={n.id}
                data-node-id={n.id}
                data-ui={`${ui}-node`}
                data-ui-key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                className={"cg-node lg-node" + (sel ? " sel" : "") + (lit(n.id) ? "" : " dim")}
                tabIndex={0}
                role="button"
                aria-label={n.name}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSelect(n.id);
                  }
                }}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover((h) => (h === n.id ? null : h))}
              >
                <circle r={Math.max(R + 8, 18 / v.k)} fill="transparent" />
                {sel && <circle r={R + 6} className="cg-ring" />}
                {n.ringed && <circle r={R + 3.5} fill="none" stroke={n.color} strokeWidth={1.6} />}
                <circle r={n.ringed ? R - 1 : R} className="cg-dot" style={{ fill: n.color, stroke: "var(--cg-border)" }} />
                {n.mark && (
                  <g transform={`translate(${R * 0.85} ${-R * 0.85})`} className="lg-badge" data-ui={`${ui}-node-mark`}>
                    <title>{n.mark.label}</title>
                    <circle r={6.2} style={n.mark.color ? { fill: n.mark.color } : undefined} />
                    <text y={3.2} textAnchor="middle" style={n.mark.textColor ? { fill: n.mark.textColor } : undefined}>
                      {n.mark.text}
                    </text>
                  </g>
                )}
                {showLabel && (
                  <text
                    className="cg-label lg-label"
                    data-ui={`${ui}-title`}
                    data-side={side}
                    textAnchor={side === "right" ? "start" : side === "left" ? "end" : "middle"}
                    style={{ fontSize: fs, strokeWidth: 4 / v.k }}
                  >
                    {ls.map((l, i) => {
                      const lh = fs * 1.22;
                      const y0 = side === "below" ? R + 5 + fs * 0.85 : side === "above" ? -(R + 5) - (ls.length - 1) * lh - fs * 0.2 : ls.length === 1 ? fs * 0.35 : -fs * 0.28;
                      return (
                        <tspan key={i} x={side === "right" ? R + 9 : side === "left" ? -(R + 9) : 0} y={y0 + i * lh}>
                          {l}
                        </tspan>
                      );
                    })}
                  </text>
                )}
                {sel && !rubber && onConnect && (
                  <g
                    data-connect-from={n.id}
                    data-ui={`${ui}-connect-handle`}
                    transform={`translate(${side === "left" ? R + 15 : -(R + 15)} 0)`}
                    className="lg-handle"
                  >
                    {connectHint && <title>{connectHint}</title>}
                    <circle r={7.5} />
                    <path d="M-3.4,0 H3.4 M0,-3.4 V3.4" />
                  </g>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="graph-note" data-ui="graph-description" ref={noteRef}>
        <h3>{heading}</h3>
        <p>{note}</p>
      </div>

      <div className="cg-legend lg-legend" data-ui="graph-legend" ref={legendRef}>
        {legend}
      </div>

      <GraphZoomControls
        zoom={v.k}
        onZoomIn={() => zoomAt(1.25, size.w / 2, size.h / 2)}
        onZoomOut={() => zoomAt(0.8, size.w / 2, size.h / 2)}
        onFit={fitView}
        onRelayout={relayout}
      />

      {showTip && hoverNode && tipPos && (
        <div className="tooltip lg-tooltip" ref={tipRef} data-ui={`${ui}-node-tooltip`} data-ui-key={hoverNode.id} style={tipPos}>
          {renderTooltip(hoverNode.id)}
        </div>
      )}
    </div>
  );
}
