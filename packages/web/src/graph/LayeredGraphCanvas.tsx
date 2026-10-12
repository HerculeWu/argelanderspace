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
 * Pan, wheel and pinch zoom, node drag, hover, select and the zoom controls are the shared
 * `useGraphViewport`, the same state machine `GraphCanvas` runs.
 */

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { GraphZoomControls } from "./GraphZoomControls";
import { ZOOM_MIN, useGraphViewport } from "./useGraphViewport";
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

const R = 10;
const NEUTRAL = "var(--border)";
/** Fallback overlay clearance when the overlays cannot be measured. */
const INSET = { l: 24, r: 64, t: 78, b: 104 };
/** Keep-visible margins for the selected node (its label sits to its right). */
const KEEP = { l: 64, r: 176, t: 74, b: 96 };

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
  const noteRef = useRef<HTMLDivElement>(null);
  const legendRef = useRef<HTMLDivElement>(null);
  const [tipBox, setTipBox] = useState({ w: 280, h: 150 });
  const tipRef = useRef<HTMLDivElement>(null);
  const [rubber, setRubber] = useState<{ from: string; x: number; y: number } | null>(null);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const links = useMemo(() => edges.map((e) => [e.from, e.to] as [string, string]), [edges]);
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

  // The layered half of the shared viewport: a dragged node follows the pointer (until the next layout), and a
  // drag that starts on the connect handle is the rubber-band gesture.
  const vp = useGraphViewport({
    sceneKey,
    stash,
    nodes,
    links,
    onSelect,
    onNodeDrag: (id, w, moved) => {
      const p = P.current[id];
      if (moved && p) {
        p.x = w.x;
        p.y = w.y;
      }
      vp.redraw();
    },
    onUserView: () => {
      stash.auto = false;
    },
    gesture: (target, { world, setHover, nodeAt }) => {
      const from = target.closest("[data-connect-from]")?.getAttribute("data-connect-from");
      if (!from) return null;
      setRubber({ from, x: world.x, y: world.y });
      return {
        move: (e, w) => {
          setRubber({ from, x: w.x, y: w.y });
          setHover(nodeAt(e));
        },
        end: (e) => {
          const to = nodeAt(e);
          setRubber(null);
          if (to) onConnect?.(from, to, { x: e.clientX, y: e.clientY });
        },
        cancel: () => setRubber(null),
      };
    },
  });
  const { size, hover, tooltip } = vp;

  useEffect(() => {
    if (size.w > 0 && (!vp.hasView() || stash.auto)) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, sceneKey, sig]);

  /**
   * How far the heading (top) and the legend (bottom) reach into the canvas. The zoom stack sits at the
   * right edge and is cleared by the right inset, so it does not enter the bottom inset.
   */
  function overlayInsets() {
    const wrap = vp.wrapRef.current?.getBoundingClientRect();
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
    stash.auto = true;
    vp.setView({
      tx: inset.l + w / 2 - ((minX + maxX) / 2) * k,
      ty: inset.t + h / 2 - ((minY + maxY) / 2) * k,
      k,
    });
  }

  // A narrower canvas (a panel opening), a new selection or a new layout: keep the selected node, and its label, on screen.
  useEffect(() => {
    const p = selectedId ? P.current[selectedId] : null;
    const cur = vp.getView();
    if (!p || !cur || !size.w) return;
    const sx = p.x * cur.k + cur.tx;
    const sy = p.y * cur.k + cur.ty;
    const m = { ...KEEP, ...overlayInsets() };
    const dx = sx < KEEP.l ? KEEP.l - sx : sx > size.w - KEEP.r ? size.w - KEEP.r - sx : 0;
    const dy = sy < m.t - 4 ? m.t - 4 - sy : sy > size.h - m.b + 8 ? size.h - m.b + 8 - sy : 0;
    if (dx || dy) {
      vp.setView({ ...cur, tx: cur.tx + dx, ty: cur.ty + dy });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, size.w, size.h, sig]);

  const relayout = () => {
    stash.pos = Object.fromEntries(Object.entries(layout.pos).map(([k, v]) => [k, { ...v }]));
    P.current = stash.pos;
    fitView();
  };

  const v = vp.v;
  const lit = (id: string) => (hover ? vp.near(id) : chain ? chain.nodes.has(id) : true);
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
  const showTip = !!hoverNode && !!tooltip && !vp.dragging;
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
    <div className="cg-wrap lg-canvas" ref={vp.wrapRef} data-ui={`${ui}-canvas`} data-scene={sceneKey}>
      <svg
        className="cg-svg"
        ref={vp.svgRef}
        width="100%"
        height="100%"
        role="img"
        aria-label={heading}
        {...vp.svgProps}
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
                {...vp.nodeProps(n.id, n.name)}
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
        onZoomIn={() => vp.zoomCenter(1.25)}
        onZoomOut={() => vp.zoomCenter(0.8)}
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
