/**
 * Shared graph canvas (Stage 14, D4): the single renderer behind both the
 * Library graph and the ADS Discovery graph. It owns SVG rendering, pan/zoom
 * (incl. pinch), directed edge arrows, collision-avoided labels, the hover
 * tooltip, selection, node dragging, the legend and the zoom control stack.
 *
 * Domain semantics stay in the adapters: node shape/role/styling arrive as
 * plain `CanvasNode` props (`filled` = in library, `diamond` = Useful,
 * `seed` = exploration origin), and the canvas has no idea what a "library"
 * or "discovery" is. Layout/view persistence lives in the caller-provided
 * mutable `stash` (a session object or a module-level bag), so restoring a
 * session restores its viewport.
 */

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import {
  cgComputeLayout,
  cgHue,
  cgKfmt,
  cgRadius,
  cgTick,
  type PMap,
} from "./graphPhysics";

export interface CanvasNode {
  id: string;
  title: string;
  /** Short label, e.g. "Hunt ’24". */
  label: string;
  year: number | null;
  citations: number;
  /** Filled = saved / in library; hollow = candidate. */
  filled: boolean;
  /** Diamond shape (Discovery Useful role). */
  diamond: boolean;
  /** Exploration origin: pinned at the layout center, ringed, not draggable. */
  seed: boolean;
  venue: string | null;
  /** Tooltip role line ("ORIGIN" / "RELATED" / "USEFUL"); null = no role line. */
  roleTag: string | null;
}

export interface GraphCanvasStash {
  layout?: PMap | null;
  view?: { tx: number; ty: number; k: number } | null;
}

export interface GraphCanvasProps {
  nodes: CanvasNode[];
  edges: [string, string][];
  /** The pinned origin node (Discovery); null for the Library graph. */
  seedId?: string | null;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Search query: non-matching nodes dim (title/label match). */
  query?: string;
  /** Per-scene persistence bag (layout + viewport). */
  stash: GraphCanvasStash;
  /** Identity of the scene — a change re-seeds positions from the stash. */
  layoutKey: string;
  /** Node currently being added to the library (dashed ring). */
  addingId?: string | null;
  /** Heading + note rendered top-left (domain copy via the adapter). */
  heading: string;
  note: string;
  /** Show the Useful diamond legend row (Discovery). */
  usefulLegend?: boolean;
  /** Show the "N papers without links" note (Discovery, when > 0). */
  isolatedNote?: boolean;
}

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 3.2;

export function GraphCanvas({
  nodes,
  edges,
  seedId = null,
  selectedId,
  onSelect,
  query = "",
  stash,
  layoutKey,
  addingId = null,
  heading,
  note,
  usefulLegend = false,
  isolatedNote = false,
}: GraphCanvasProps) {
  const { t } = useTranslation();
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);
  const [labelsOn, setLabelsOn] = useState(false);
  const [, bump] = useReducer((x: number) => x + 1, 0);

  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const Rmap = useMemo(() => {
    const m: Record<string, number> = {};
    for (const n of nodes) m[n.id] = cgRadius(n.citations);
    return m;
  }, [nodes]);
  const years = nodes.map((n) => n.year).filter((y): y is number => y !== null);
  const minY = years.length ? Math.min(...years) : 0;
  const maxY = years.length ? Math.max(...years) : 0;

  const adj = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of nodes) m.set(n.id, new Set());
    for (const [a, b] of edges) {
      m.get(a)?.add(b);
      m.get(b)?.add(a);
    }
    return m;
  }, [nodes, edges]);

  const connected = useMemo(() => {
    const s = new Set<string>();
    for (const [a, b] of edges) {
      s.add(a);
      s.add(b);
    }
    return s;
  }, [edges]);
  const isolated = seedId
    ? nodes.filter((n) => n.id !== seedId && !connected.has(n.id)).length
    : 0;

  // ---- layout state: seeded per scene, healed for newcomers (Stage 13 fix) ----
  const P = useRef<PMap>({});
  const loadedKey = useRef<string | null>(null);
  if (loadedKey.current !== layoutKey) {
    loadedKey.current = layoutKey;
    const from = stash.layout ?? null;
    const fresh = cgComputeLayout(nodes, edges, layoutKey, seedId);
    const next: PMap = {};
    for (const n of nodes) {
      const b = from?.[n.id];
      const f = fresh[n.id];
      next[n.id] = b
        ? { x: b.x, y: b.y, vx: 0, vy: 0, fx: b.fx, fy: b.fy }
        : { x: f!.x, y: f!.y, vx: 0, vy: 0, fx: f!.fx, fy: f!.fy };
    }
    P.current = next;
    stash.layout = next;
  }
  for (const n of nodes) {
    if (!P.current[n.id]) {
      const nb = [...(adj.get(n.id) ?? [])].find((x) => P.current[x] !== undefined);
      const base = nb ? P.current[nb] : { x: 0, y: 0 };
      P.current[n.id] = { x: base.x + 90, y: base.y - 65, vx: 0, vy: 0, fx: null, fy: null };
    }
  }

  const view = useRef<{ tx: number; ty: number; k: number } | null>(null);
  const viewKey = useRef<string | null>(null);
  if (viewKey.current !== layoutKey) {
    viewKey.current = layoutKey;
    view.current = stash.view ? { ...stash.view } : null;
  }
  const persistView = () => {
    if (view.current) stash.view = { ...view.current };
  };

  // ---- live physics (drag reheat) ----
  const sim = useRef({ alpha: 0, running: false, raf: 0 });
  const step = () => cgTick(P.current, Rmap, nodes.map((n) => n.id), edges, sim.current.alpha);
  const loop = () => {
    sim.current.running = true;
    step();
    sim.current.alpha *= 0.984;
    bump();
    if (sim.current.alpha > 0.02) sim.current.raf = requestAnimationFrame(loop);
    else sim.current.running = false;
  };
  const reheat = (a: number) => {
    sim.current.alpha = Math.max(sim.current.alpha, a);
    if (!sim.current.running) loop();
  };
  useEffect(() => () => cancelAnimationFrame(sim.current.raf), []);

  // ---- sizing / initial fit ----
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
    if (size.w > 0 && view.current === null) fitView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, size.h, layoutKey]);

  function fitView() {
    if (!nodes.length || !size.w) return;
    const xs = nodes.map((n) => P.current[n.id]!.x);
    const ys = nodes.map((n) => P.current[n.id]!.y);
    const minX = Math.min(...xs) - 58;
    const maxX = Math.max(...xs) + 58;
    const minYv = Math.min(...ys) - 35;
    const maxYv = Math.max(...ys) + 55;
    const k = Math.max(
      ZOOM_MIN,
      Math.min(2.4, Math.min(size.w / (maxX - minX || 1), size.h / (maxYv - minYv || 1)))
    );
    view.current = {
      tx: size.w / 2 - ((minX + maxX) / 2) * k,
      ty: size.h / 2 - ((minYv + maxYv) / 2) * k,
      k,
    };
    persistView();
    bump();
  }

  const zoomAt = (f: number, cx: number, cy: number) => {
    const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
    const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v.k * f));
    const r = k / v.k;
    view.current = { tx: cx - (cx - v.tx) * r, ty: cy - (cy - v.ty) * r, k };
    persistView();
    setHover(null);
    setTooltip(null);
    bump();
  };

  const relayout = () => {
    const salt = String((stash.layout ? 1 : 0) + Date.now() % 100000);
    P.current = cgComputeLayout(nodes, edges, layoutKey, seedId, salt);
    stash.layout = P.current;
    reheat(0.3);
    fitView();
  };

  const focusSeed = () => {
    if (!seedId || !P.current[seedId]) return;
    onSelect(seedId);
    const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
    view.current = {
      ...v,
      tx: size.w / 2 - P.current[seedId].x * v.k,
      ty: size.h / 2 - P.current[seedId].y * v.k,
    };
    persistView();
    bump();
  };

  // ---- pointer interaction: pan / node drag / pinch ----
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const drag = useRef<
    | { mode: "pan"; x: number; y: number; tx: number; ty: number; moved: boolean }
    | { mode: "node"; id: string; x: number; y: number; moved: boolean }
    | { mode: "pinch"; d: number; k: number; wx: number; wy: number }
    | null
  >(null);

  const svgPoint = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, rect: r };
  };
  const toWorld = (x: number, y: number) => {
    const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
    return { x: (x - v.tx) / v.k, y: (y - v.ty) / v.k };
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 && e.pointerType !== "touch") return;
    e.preventDefault();
    svgRef.current?.focus({ preventScroll: true });
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // synthetic/legacy pointer streams may not hold an active pointer
    }
    const pt = svgPoint(e);
    pointers.current.set(e.pointerId, { x: pt.x, y: pt.y });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const cx = (a!.x + b!.x) / 2;
      const cy = (a!.y + b!.y) / 2;
      const w = toWorld(cx, cy);
      drag.current = {
        mode: "pinch",
        d: Math.hypot(a!.x - b!.x, a!.y - b!.y),
        k: (view.current ?? { k: 1 }).k,
        wx: w.x,
        wy: w.y,
      };
      return;
    }
    const g = (e.target as Element).closest("[data-node-id]");
    const id = g?.getAttribute("data-node-id") ?? null;
    const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
    drag.current =
      id && id !== seedId
        ? { mode: "node", id, x: pt.x, y: pt.y, moved: false }
        : { mode: "pan", x: pt.x, y: pt.y, tx: v.tx, ty: v.ty, moved: false };
    setHover(null);
    setTooltip(null);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const pt = svgPoint(e);
    if (pointers.current.has(e.pointerId)) {
      pointers.current.set(e.pointerId, { x: pt.x, y: pt.y });
    }
    const d = drag.current;
    if (!d) {
      // fall through to hover tracking below
    } else if (d.mode === "pinch") {
      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()];
        const cx = (a!.x + b!.x) / 2;
        const cy = (a!.y + b!.y) / 2;
        const nd = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const k = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (d.k * nd) / (d.d || 1)));
        view.current = { tx: cx - d.wx * k, ty: cy - d.wy * k, k };
        persistView();
        bump();
      }
      return;
    } else {
      const dx = pt.x - d.x;
      const dy = pt.y - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.mode === "pan") {
        const cur = view.current ?? { k: 1 };
        view.current = { tx: d.tx + dx, ty: d.ty + dy, k: cur.k };
        persistView();
        bump();
      } else {
        const w = toWorld(pt.x, pt.y);
        const p = P.current[d.id];
        if (p) {
          p.x = w.x;
          p.y = w.y;
          p.fx = w.x;
          p.fy = w.y;
          reheat(0.3);
        }
      }
      return;
    }
    if (e.pointerType === "touch") return;
    const g = (e.target as Element).closest("[data-node-id]");
    const id = g?.getAttribute("data-node-id") ?? null;
    if (id && nodeById.has(id)) {
      setHover(id);
      setTooltip({
        x: Math.max(8, Math.min(pt.x + 18, size.w - 268)),
        y: Math.max(8, Math.min(pt.y + 15, size.h - 165)),
      });
    } else if (hover) {
      setHover(null);
      setTooltip(null);
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    pointers.current.delete(e.pointerId);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    if (d && d.mode === "node") {
      const p = P.current[d.id];
      if (p) {
        p.fx = null;
        p.fy = null;
      }
      reheat(0.2);
    }
    if (d && d.mode !== "pinch" && !d.moved) {
      onSelect(d.mode === "node" ? d.id : null);
    }
    drag.current = pointers.current.size > 0 && d?.mode === "pinch" ? d : null;
    setHover(null);
    setTooltip(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const pt = svgPoint(e);
    zoomAt(Math.exp(-e.deltaY * 0.0014), pt.x, pt.y);
  };

  // ---- emphasis: hover neighbourhood / search matches dim the rest ----
  const q = query.trim().toLowerCase();
  const matchesQ = (n: CanvasNode) => !!q && (n.title + " " + n.label).toLowerCase().includes(q);
  const neighbors = hover ? adj.get(hover) : null;
  const isLit = (id: string) => {
    if (hover) return id === hover || (neighbors?.has(id) ?? false);
    if (q) return matchesQ(nodeById.get(id)!);
    return true;
  };
  const dimAll = !!hover || !!q;

  const v = view.current ?? { tx: size.w / 2, ty: size.h / 2, k: 1 };
  const markerId = `cg-arrow-${layoutKey.replace(/[^a-z0-9]/gi, "")}`;
  const hoverNode = hover ? nodeById.get(hover) : null;

  // collision-avoided label placement (screen space; priority: seed > selected
  // > hover > filled > rest; labels overlapping an earlier box or covering a
  // node are dropped)
  const labelIds = new Set<string>();
  {
    const boxes: { l: number; r: number; t: number; b: number }[] = [];
    const order = [...nodes].sort((a, b) => {
      const prio = (n: CanvasNode) =>
        n.seed ? 100 : n.id === selectedId ? 90 : n.id === hover ? 80 : n.filled ? 50 : 0;
      return prio(b) - prio(a);
    });
    for (const n of order) {
      if (!(labelsOn || n.filled || n.id === selectedId || n.id === hover || n.seed)) continue;
      const p = P.current[n.id];
      if (!p) continue;
      const r = cgRadius(n.citations);
      const cx = p.x * v.k + v.tx;
      const cy = (p.y + r) * v.k + v.ty + 15;
      const width = (n.label.length + 4) * 6.3;
      const box = { l: cx - width / 2 - 3, r: cx + width / 2 + 3, t: cy - 11, b: cy + 3 };
      const overlaps = boxes.some((o) => box.l < o.r && box.r > o.l && box.t < o.b && box.b > o.t);
      const coversNode = nodes.some((m) => {
        if (m.id === n.id) return false;
        const mp = P.current[m.id];
        if (!mp) return false;
        const nx = mp.x * v.k + v.tx;
        const ny = mp.y * v.k + v.ty;
        const rad = cgRadius(m.citations) * v.k + 2;
        const dx = nx - Math.max(box.l, Math.min(nx, box.r));
        const dy = ny - Math.max(box.t, Math.min(ny, box.b));
        return dx * dx + dy * dy < rad * rad;
      });
      if ((overlaps || coversNode) && !n.seed && n.id !== selectedId && n.id !== hover) continue;
      labelIds.add(n.id);
      boxes.push(box);
    }
  }

  return (
    <div className="cg-wrap" ref={wrapRef} data-testid="graph-canvas" data-scene={layoutKey} data-ui="graph-canvas">
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
        }}
        onWheel={onWheel}
        onMouseLeave={() => {
          if (!drag.current) {
            setHover(null);
            setTooltip(null);
          }
        }}
      >
        <defs>
          <marker
            id={markerId}
            markerWidth={6 / v.k}
            markerHeight={6 / v.k}
            refX={5 / v.k}
            refY={3 / v.k}
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d={`M0,0 L${6 / v.k},${3 / v.k} L0,${6 / v.k} z`} fill="var(--border)" />
          </marker>
          <marker
            id={`${markerId}-on`}
            markerWidth={6 / v.k}
            markerHeight={6 / v.k}
            refX={5 / v.k}
            refY={3 / v.k}
            orient="auto"
            markerUnits="userSpaceOnUse"
          >
            <path d={`M0,0 L${6 / v.k},${3 / v.k} L0,${6 / v.k} z`} fill="var(--accent-line)" />
          </marker>
        </defs>
        <g transform={`translate(${v.tx} ${v.ty}) scale(${v.k})`}>
          <g className="cg-edges">
            {edges.map(([a, b], i) => {
              const p = P.current[a];
              const qn = P.current[b];
              if (!p || !qn) return null;
              const dx = qn.x - p.x;
              const dy = qn.y - p.y;
              const d = Math.hypot(dx, dy) || 1;
              const rs = cgRadius(nodeById.get(a)?.citations ?? 10) + 3;
              const rt = cgRadius(nodeById.get(b)?.citations ?? 10) + 6 / v.k + 2;
              const on = !!hover && (a === hover || b === hover);
              return (
                <line
                  key={i}
                  x1={p.x + (dx / d) * rs}
                  y1={p.y + (dy / d) * rs}
                  x2={qn.x - (dx / d) * rt}
                  y2={qn.y - (dy / d) * rt}
                  className={"cg-edge" + (on ? " on" : "") + (dimAll && !on ? " dim" : "")}
                  markerEnd={`url(#${on ? `${markerId}-on` : markerId})`}
                />
              );
            })}
          </g>
          {nodes.map((n) => {
            const p = P.current[n.id];
            if (!p) return null;
            const r = cgRadius(n.citations);
            const lit = isLit(n.id);
            const sel = n.id === selectedId;
            const hue = cgHue(n.year ?? (minY + maxY) / 2, minY, maxY);
            const color = `oklch(var(--cg-l) var(--cg-c) calc(var(--accent-h) + ${hue}))`;
            return (
              <g
                key={n.id}
                data-node-id={n.id}
                data-ui="graph-node" data-ui-key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                className={"cg-node" + (sel ? " sel" : "") + (lit ? "" : " dim")}
                tabIndex={0}
                role="button"
                aria-label={n.title}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    onSelect(n.id);
                  }
                }}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover((h) => (h === n.id ? null : h))}
              >
                <circle r={Math.max(r + 7, 17 / v.k)} fill="transparent" />
                {n.seed && <circle r={r + 11} className="cg-seed-ring" />}
                {sel && <circle r={r + 6} className="cg-ring" />}
                {addingId === n.id && (
                  <circle r={r + 6} fill="none" stroke="var(--accent)" strokeDasharray="5 5" />
                )}
                {n.diamond ? (
                  <path
                    d={`M0,${-r * 1.05} L${r * 1.05},0 L0,${r * 1.05} L${-r * 1.05},0 Z`}
                    className={"cg-dot" + (n.filled ? "" : " sug")}
                    style={
                      n.filled
                        ? { fill: color, stroke: "var(--cg-border)", strokeWidth: 1.5 }
                        : { fill: "var(--bg-deep)", stroke: color, strokeWidth: 2.2 }
                    }
                  />
                ) : (
                  <circle
                    r={r}
                    className={"cg-dot" + (n.filled ? "" : " sug")}
                    style={
                      n.filled
                        ? { fill: color, stroke: "var(--cg-border)", strokeWidth: 1.5 }
                        : { fill: "var(--bg-deep)", stroke: color, strokeWidth: 2.2 }
                    }
                  />
                )}
                {n.seed && (
                  <circle r={3 / v.k} fill={n.filled ? "var(--accent-fg)" : "var(--accent)"} />
                )}
                {labelIds.has(n.id) && (
                  <text
                    className="cg-label"
                    y={r + 15 / v.k}
                    textAnchor="middle"
                    style={{ fontSize: 10.5 / v.k, strokeWidth: 4 / v.k }}
                  >
                    {n.label}
                  </text>
                )}
                {n.seed && (
                  <text
                    className="cg-role-label"
                    y={-r - 18 / v.k}
                    textAnchor="middle"
                    style={{ fontSize: 8 / v.k }}
                  >
                    ORIGIN
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className="graph-note" data-ui="graph-description">
        <h3>{heading}</h3>
        <p>{note}</p>
      </div>

      <div className="graph-top-actions" data-ui="graph-actions">
        <button
          className={"btn icon ghost hide-small" + (labelsOn ? " on" : "")}
          data-ui="toggle-graph-labels"
          title={t("graph.showLabels")}
          aria-label={t("graph.showLabels")}
          aria-pressed={labelsOn}
          onClick={() => setLabelsOn((v) => !v)}
        >
          <span className="mono" style={{ fontSize: 12, color: labelsOn ? "var(--accent)" : "var(--text-faint)" }}>
            Aa
          </span>
        </button>
        {seedId && (
          <button
            className="btn icon"
            data-ui="focus-graph-seed"
            title={t("graph.jumpSeed")}
            aria-label={t("graph.jumpSeed")}
            onClick={focusSeed}
          >
            <Icon name="target" cls="ico-sm" />
          </button>
        )}
      </div>

      <div className="cg-legend" data-ui="graph-legend">
        <div className="cg-leg-row">
          <span className="cg-leg-cap mono">{t("graph.legendYear")}</span>
          <span className="cg-leg-ends mono">{years.length ? minY : ""}</span>
          <span className="cg-grad" />
          <span className="cg-leg-ends mono">{years.length ? maxY : ""}</span>
          <span style={{ width: 8 }} />
          <span className="cg-leg-note">{t("graph.legendSize")}</span>
        </div>
        <div className="cg-leg-row">
          <span className="cg-leg-sample saved" />
          <span className="cg-leg-note">{t("graph.legendSaved")}</span>
          {(usefulLegend || nodes.some((n) => !n.filled)) && (
            <>
              <span className="cg-leg-sample sug" />
              <span className="cg-leg-note">{t("graph.legendCandidate")}</span>
            </>
          )}
          {usefulLegend && (
            <>
              <span className="cg-leg-sample diamond" />
              <span className="cg-leg-note">Useful</span>
            </>
          )}
        </div>
        <div className="cg-leg-row">
          <span className="cg-leg-cap mono">{"A → B"}</span>
          <span className="cg-leg-note">{t("graph.citesInView")}</span>
        </div>
      </div>

      {isolatedNote && isolated > 0 && (
        <div className="disconnected-note" data-ui="graph-isolated-notice">
          <Icon name="info" cls="ico-sm" />
          {t("graph.isolated", { count: isolated })}
        </div>
      )}

      <div className="cg-zoom" data-ui="graph-zoom-controls">
        <button
          className="cg-zbtn"
          data-testid="zoom-in" data-ui="zoom-in"
          aria-label={t("graph.zoomIn")}
          title={t("graph.zoomIn")}
          onClick={() => zoomAt(1.25, size.w / 2, size.h / 2)}
        >
          <Icon name="plus" cls="ico-sm" />
        </button>
        <span className="zoom-value mono">{Math.round(v.k * 100)}%</span>
        <button
          className="cg-zbtn"
          data-ui="zoom-out"
          aria-label={t("graph.zoomOut")}
          title={t("graph.zoomOut")}
          onClick={() => zoomAt(0.8, size.w / 2, size.h / 2)}
        >
          <Icon name="minus" cls="ico-sm" />
        </button>
        <button
          className="cg-zbtn"
          data-testid="fit-view" data-ui="fit-graph"
          aria-label={t("graph.fitView")}
          title={t("graph.fitView")}
          onClick={fitView}
        >
          <Icon name="expand" cls="ico-sm" />
        </button>
        <button
          className="cg-zbtn"
          data-ui="relayout-graph"
          aria-label={t("graph.relayout")}
          title={t("graph.relayout")}
          onClick={relayout}
        >
          <Icon name="rotate-ccw" cls="ico-sm" />
        </button>
      </div>

      {hoverNode && tooltip && !drag.current && (
        <div className="tooltip" data-ui="graph-node-tooltip" data-ui-key={hoverNode.id} style={{ left: tooltip.x, top: tooltip.y }}>
          <strong>{hoverNode.title}</strong>
          <div className="meta">
            {hoverNode.label} · {hoverNode.venue ?? "—"} ·{" "}
            {t("graph.citedCount", { count: cgKfmt(hoverNode.citations) })}
          </div>
          {hoverNode.roleTag && (
            <div className="role">
              {hoverNode.roleTag}
              {hoverNode.filled && (
                <span>
                  {" · ✓ "}
                  {t("graph.legendSaved")}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
