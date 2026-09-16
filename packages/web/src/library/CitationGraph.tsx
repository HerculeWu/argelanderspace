import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import type { GraphData, GraphLink, GraphNode } from "./types";

// Connected-Papers-style citation map: nodes = papers (radius ∝ citations,
// hue ∝ year), edges = citation links. Saved papers are filled, suggested ones
// hollow. Ported from the design's views/citegraph.jsx.

// year → hue offset around the (tweakable) accent hue. Older = cooler, newer = warmer.
function cgHue(y: number, minY: number, maxY: number): string {
  const t = maxY === minY ? 0.5 : (y - minY) / (maxY - minY);
  return ((0.5 - t) * 104).toFixed(1); // +52° (old) … −52° (new)
}
export function cgRadius(c: number): number {
  return Math.max(9, Math.min(34, 8 + Math.log10(c + 10) * 5.4));
}
function cgBorder(c: number): number {
  return Math.max(1, Math.min(6, (Math.log10(c) - 2) * 1.6 + 1));
}
export function cgKfmt(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : Number(k.toFixed(1).replace(/\.0$/, ""))) + "k";
  }
  return "" + n;
}

interface PNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}
type PMap = Record<string, PNode>;

// One physics step, mutating positions P in place. Shared by the synchronous
// pre-warm and the live (drag) loop so behaviour matches exactly.
function cgTick(P: PMap, R: Record<string, number>, ids: string[], links: GraphLink[], alpha: number) {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const p = P[ids[i]],
        q = P[ids[j]];
      let dx = p.x - q.x,
        dy = p.y - q.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) d2 = 1;
      const d = Math.sqrt(d2);
      const f = (12500 / d2) * alpha;
      const ux = dx / d,
        uy = dy / d;
      p.vx += ux * f;
      p.vy += uy * f;
      q.vx -= ux * f;
      q.vy -= uy * f;
      const minD = R[ids[i]] + R[ids[j]] + 22;
      if (d < minD) {
        const push = (minD - d) * 0.6 * alpha;
        p.vx += ux * push;
        p.vy += uy * push;
        q.vx -= ux * push;
        q.vy -= uy * push;
      }
    }
  }
  const L = 128;
  links.forEach(([s, t]) => {
    const p = P[s],
      q = P[t];
    if (!p || !q) return;
    let dx = q.x - p.x,
      dy = q.y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - L) * 0.045 * alpha;
    const ux = dx / d,
      uy = dy / d;
    p.vx += ux * f;
    p.vy += uy * f;
    q.vx -= ux * f;
    q.vy -= uy * f;
  });
  ids.forEach((id) => {
    const p = P[id];
    p.vx += (0 - p.x) * 0.012 * alpha;
    p.vy += (0 - p.y) * 0.012 * alpha;
    if (p.fx != null) {
      p.x = p.fx;
      p.y = p.fy!;
      p.vx = 0;
      p.vy = 0;
      return;
    }
    p.vx *= 0.86;
    p.vy *= 0.86;
    p.x += p.vx;
    p.y += p.vy;
  });
}

// Run the simulation to rest synchronously and return settled positions.
// `rnd` is a deterministic-ish jitter source (index-derived; Math.random is fine here).
function cgComputeLayout(nodes: GraphNode[], links: GraphLink[], iters: number): PMap {
  const P: PMap = {},
    R: Record<string, number> = {},
    ids = nodes.map((n) => n.id);
  nodes.forEach((n, i) => {
    const ang = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    P[n.id] = {
      x: Math.cos(ang) * 120 + (Math.random() - 0.5) * 40,
      y: Math.sin(ang) * 120 + (Math.random() - 0.5) * 40,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    };
    R[n.id] = cgRadius(n.c);
  });
  let alpha = 0.95;
  for (let it = 0; it < iters; it++) {
    cgTick(P, R, ids, links, alpha);
    alpha *= 0.984;
  }
  return P;
}

// Cached settled layout for the saved set, keyed by a signature so it survives
// view-switch remounts but recomputes if the library actually changes.
const cgCache: { sig: string | null; pos: PMap | null } = { sig: null, pos: null };

export interface CitationGraphProps {
  graph: GraphData;
  selId: string | null;
  onSel: (id: string | null) => void;
  query: string;
  showSug: boolean;
  loading: boolean;
  sugCount: number;
  onSugCount: (n: number) => void;
  sugDepth: number;
  onSugDepth: (n: number) => void;
  added: Set<string>;
  addingId: string | null;
}

export function CitationGraph({
  graph,
  selId,
  onSel,
  query,
  showSug,
  loading,
  sugCount,
  onSugCount,
  sugDepth,
  onSugDepth,
  added: addedSet,
  addingId,
}: CitationGraphProps) {
  const { t } = useTranslation();
  const nodes = graph.nodes,
    links = graph.links;
  const count = sugCount,
    depth = sugDepth;
  const savedNodes = useMemo(() => nodes.filter((n) => n.ref), [graph]);
  const savedSet = useMemo(() => new Set(savedNodes.map((n) => n.id)), [savedNodes]);
  const savedLinks = useMemo(
    () => links.filter(([a, b]) => savedSet.has(a) && savedSet.has(b)),
    [graph, savedSet]
  );
  const isSaved = (n: GraphNode) => !!n.ref || !!(addedSet && addedSet.has(n.id));
  const years = nodes.map((n) => n.y);
  const minY = Math.min(...years),
    maxY = Math.max(...years);
  const nodeById = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [graph]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 900, h: 640 });
  const [hover, setHover] = useState<string | null>(null);

  const adj = useMemo(() => {
    const m: Record<string, Set<string>> = {};
    nodes.forEach((n) => (m[n.id] = new Set()));
    links.forEach(([a, b]) => {
      m[a]?.add(b);
      m[b]?.add(a);
    });
    return m;
  }, [graph]);

  // hop distance of every node from the saved set (multi-source BFS)
  const hopDist = useMemo(() => {
    const dist: Record<string, number> = {};
    const queue: string[] = [];
    savedNodes.forEach((n) => {
      dist[n.id] = 0;
      queue.push(n.id);
    });
    for (let qi = 0; qi < queue.length; qi++) {
      const id = queue[qi];
      adj[id].forEach((nb) => {
        if (dist[nb] === undefined) {
          dist[nb] = dist[id] + 1;
          queue.push(nb);
        }
      });
    }
    return dist;
  }, [graph, savedNodes, adj]);
  const maxDepth = useMemo(
    () => Math.max(1, ...nodes.filter((n) => !n.ref && hopDist[n.id] != null).map((n) => hopDist[n.id])),
    [graph, hopDist]
  );
  const maxCount = 18;

  // highest-cited suggested papers within `depth` hops that stay connected
  const activeSug = useMemo(() => {
    if (!showSug) return new Set<string>();
    const pool = nodes
      .filter((n) => !isSaved(n) && hopDist[n.id] != null && hopDist[n.id] <= depth)
      .sort((a, b) => b.c - a.c);
    const visible = new Set(nodes.filter(isSaved).map((n) => n.id));
    const result = new Set<string>();
    let grew = true;
    while (result.size < count && grew) {
      grew = false;
      for (const n of pool) {
        if (result.size >= count) break;
        if (result.has(n.id)) continue;
        let ok = false;
        for (const nb of adj[n.id]) {
          if (visible.has(nb)) {
            ok = true;
            break;
          }
        }
        if (ok) {
          result.add(n.id);
          visible.add(n.id);
          grew = true;
        }
      }
    }
    return result;
  }, [graph, showSug, depth, count, addedSet, hopDist, adj]);

  const Rmap = useMemo(() => {
    const m: Record<string, number> = {};
    nodes.forEach((n) => (m[n.id] = cgRadius(n.c)));
    return m;
  }, [graph]);

  const P = useRef<PMap | null>(null);
  if (!P.current) {
    const sig =
      savedNodes.map((n) => n.id + ":" + n.c).join(",") + "|" + savedLinks.length;
    if (cgCache.sig !== sig) {
      cgCache.sig = sig;
      cgCache.pos = cgComputeLayout(savedNodes, savedLinks, 320);
    }
    const cache = cgCache.pos!;
    P.current = {};
    nodes.forEach((n) => {
      const c = cache[n.id] || { x: (Math.random() - 0.5) * 30, y: (Math.random() - 0.5) * 30 };
      P.current![n.id] = { x: c.x, y: c.y, vx: 0, vy: 0, fx: null, fy: null };
    });
  }

  // Position heal (Stage 13): a payload refresh can introduce node ids unseen
  // at first mount (manual work creation, a rebuild's new works). Initialize
  // each newcomer in place — reading P.current![id] for an unknown id used to
  // crash the render (TypeError reading 'x') and unmount the whole view.
  for (const n of nodes) {
    if (!P.current[n.id]) {
      const nb = [...(adj[n.id] ?? [])].find((x) => P.current![x] !== undefined);
      const base = nb ? P.current![nb] : { x: 0, y: 0 };
      P.current[n.id] = {
        x: base.x + (Math.random() - 0.5) * 36,
        y: base.y + (Math.random() - 0.5) * 36,
        vx: 0,
        vy: 0,
        fx: null,
        fy: null,
      };
    }
  }

  const visNodes = useMemo(
    () => nodes.filter((n) => isSaved(n) || activeSug.has(n.id)),
    [graph, activeSug, addedSet]
  );
  const visSet = useMemo(() => new Set(visNodes.map((n) => n.id)), [visNodes]);
  const visLinks = useMemo(() => links.filter(([a, b]) => visSet.has(a) && visSet.has(b)), [graph, visSet]);
  const simData = useRef<{ ids: string[]; links: GraphLink[] }>({ ids: [], links: [] });
  simData.current.ids = visNodes.map((n) => n.id);
  simData.current.links = visLinks;

  const view = useRef({ tx: null as number | null, ty: null as number | null, k: 1 });
  if (view.current.tx == null && size.w) {
    view.current.tx = size.w / 2;
    view.current.ty = size.h / 2;
  }

  const sim = useRef({ alpha: 0, running: false, raf: 0 });
  const [, bump] = useReducer((x: number) => x + 1, 0);

  function step() {
    cgTick(P.current!, Rmap, simData.current.ids, simData.current.links, sim.current.alpha);
  }
  function loop() {
    sim.current.running = true;
    step();
    sim.current.alpha *= 0.984;
    bump();
    if (sim.current.alpha > 0.02) sim.current.raf = requestAnimationFrame(loop);
    else sim.current.running = false;
  }
  function reheat(a: number) {
    sim.current.alpha = Math.max(sim.current.alpha, a);
    if (!sim.current.running) loop();
  }
  function relayout() {
    visNodes.forEach((n, i) => {
      const ang = (i / Math.max(1, visNodes.length)) * Math.PI * 2;
      const p = P.current![n.id];
      p.x = Math.cos(ang) * 120 + (Math.random() - 0.5) * 40;
      p.y = Math.sin(ang) * 120 + (Math.random() - 0.5) * 40;
      p.vx = 0;
      p.vy = 0;
      p.fx = null;
      p.fy = null;
    });
    reheat(0.95);
  }

  useEffect(() => () => cancelAnimationFrame(sim.current.raf), []);

  // when suggestions turn on / count grows, sprout new papers from a saved neighbour
  const prevActive = useRef<Set<string>>(new Set());
  useEffect(() => {
    let appeared = 0;
    activeSug.forEach((id) => {
      if (prevActive.current.has(id)) return;
      appeared++;
      const nb = [...adj[id]].find((x) => savedSet.has(x) || visSet.has(x));
      const base = nb ? P.current![nb] : { x: 0, y: 0 };
      const p = P.current![id];
      p.x = base.x + (Math.random() - 0.5) * 36;
      p.y = base.y + (Math.random() - 0.5) * 36;
      p.vx = 0;
      p.vy = 0;
      p.fx = null;
      p.fy = null;
    });
    if (appeared > 0) reheat(0.9);
    else if (prevActive.current.size !== activeSug.size) reheat(0.6);
    prevActive.current = new Set(activeSug);
  }, [activeSug]);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((es) => {
      const r = es[0].contentRect;
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // ---- interaction: pan / zoom / node drag ----
  const drag = useRef<any>(null);
  const toWorld = (cx: number, cy: number) => ({
    x: (cx - view.current.tx!) / view.current.k,
    y: (cy - view.current.ty!) / view.current.k,
  });

  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    onSel(null);
    drag.current = { mode: "pan", x: e.clientX, y: e.clientY, tx: view.current.tx, ty: view.current.ty };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const onNodeDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const rect = wrapRef.current!.getBoundingClientRect();
    drag.current = { mode: "node", id, moved: false, sx: e.clientX, sy: e.clientY, rect };
    P.current![id].fx = P.current![id].x;
    P.current![id].fy = P.current![id].y;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
  const onMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    if (d.mode === "pan") {
      view.current.tx = d.tx + (e.clientX - d.x);
      view.current.ty = d.ty + (e.clientY - d.y);
      bump();
    } else {
      if (Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) > 3) d.moved = true;
      const w = toWorld(e.clientX - d.rect.left, e.clientY - d.rect.top);
      P.current![d.id].fx = w.x;
      P.current![d.id].fy = w.y;
      P.current![d.id].x = w.x;
      P.current![d.id].y = w.y;
      reheat(0.35);
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    if (d && d.mode === "node") {
      P.current![d.id].fx = null;
      P.current![d.id].fy = null;
      if (!d.moved) onSel(d.id);
      reheat(0.25);
    }
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const rect = wrapRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left,
      cy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0014);
    const k2 = Math.max(0.4, Math.min(3.2, view.current.k * factor));
    const r = k2 / view.current.k;
    view.current.tx = cx - (cx - view.current.tx!) * r;
    view.current.ty = cy - (cy - view.current.ty!) * r;
    view.current.k = k2;
    bump();
  };
  const zoomBy = (f: number) => {
    const cx = size.w / 2,
      cy = size.h / 2;
    const k2 = Math.max(0.4, Math.min(3.2, view.current.k * f));
    const r = k2 / view.current.k;
    view.current.tx = cx - (cx - view.current.tx!) * r;
    view.current.ty = cy - (cy - view.current.ty!) * r;
    view.current.k = k2;
    bump();
  };
  const fitView = () => {
    if (!visNodes.length) return;
    const xs = visNodes.map((n) => P.current![n.id].x),
      ys = visNodes.map((n) => P.current![n.id].y);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY2 = Math.min(...ys),
      maxY2 = Math.max(...ys);
    const pad = 70;
    const k = Math.max(
      0.4,
      Math.min(2.4, Math.min((size.w - pad * 2) / (maxX - minX || 1), (size.h - pad * 2) / (maxY2 - minY2 || 1)))
    );
    view.current.k = k;
    view.current.tx = size.w / 2 - ((minX + maxX) / 2) * k;
    view.current.ty = size.h / 2 - ((minY2 + maxY2) / 2) * k;
    bump();
  };

  // ---- emphasis (hover / search drive dimming; selection only adds a ring) ----
  const q = (query || "").trim().toLowerCase();
  const matches = (n: GraphNode) => !!q && (n.t + " " + n.a).toLowerCase().includes(q);
  const focusId = hover;
  const neighbors = focusId ? adj[focusId] : null;
  const isLit = (id: string) => {
    if (focusId) return id === focusId || (neighbors !== null && neighbors.has(id));
    if (q) return matches(nodeById[id]);
    return true;
  };
  const dimAll = !!focusId || !!q;
  const v = view.current;

  return (
    <div className="cg-wrap" ref={wrapRef}>
      <svg className="cg-svg" width="100%" height="100%" onPointerDown={onBgDown} onWheel={onWheel}>
        <g transform={`translate(${v.tx || 0} ${v.ty || 0}) scale(${v.k})`}>
          <g className="cg-edges">
            {visLinks.map(([s, t], i) => {
              const p = P.current![s],
                qn = P.current![t];
              if (!p || !qn) return null;
              const on = !!focusId && (s === focusId || t === focusId);
              return (
                <line
                  key={i}
                  x1={p.x}
                  y1={p.y}
                  x2={qn.x}
                  y2={qn.y}
                  className={"cg-edge" + (on ? " on" : "") + (dimAll && !on ? " dim" : "")}
                />
              );
            })}
          </g>
          {visNodes.map((n) => {
            const p = P.current![n.id];
            const r = cgRadius(n.c);
            const lit = isLit(n.id);
            const sel = n.id === selId;
            const saved = isSaved(n);
            const fill = `oklch(var(--cg-l) var(--cg-c) calc(var(--accent-h) + ${cgHue(n.y, minY, maxY)}))`;
            const showLabel = saved || hover === n.id || v.k > 1.25 || matches(n);
            return (
              <g
                key={n.id}
                transform={`translate(${p.x} ${p.y})`}
                className={"cg-node" + (sel ? " sel" : "") + (lit ? "" : " dim")}
                onPointerDown={(e) => onNodeDown(e, n.id)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
              >
                {n.id === addingId && <circle r={r + 5} className="cg-adding-ring" />}
                {sel && <circle r={r + 6} className="cg-ring" />}
                <circle
                  r={r}
                  className={"cg-dot" + (saved ? "" : " sug")}
                  style={saved ? { fill, stroke: "var(--cg-border)", strokeWidth: cgBorder(n.c) } : { stroke: fill }}
                />
                {showLabel && (
                  <text className="cg-label" y={r + 13} textAnchor="middle">
                    {n.a.replace(/ et al\.| \+|\+$/, "+").split(" ")[0].replace(/,$/, "")} ’
                    {("" + n.y).slice(2)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {showSug && !loading && (
        <div className="cg-controls">
          <div className="cg-ctrl-row">
            <Icon name="git-fork" cls="ico-sm" />
            <span className="cg-ctrl-lab">{t("library.graph.depth")}</span>
            <input
              className="cg-range"
              type="range"
              min={1}
              max={maxDepth}
              step={1}
              value={Math.min(depth, maxDepth)}
              onChange={(e) => onSugDepth(+e.target.value)}
            />
            <span className="cg-ctrl-n mono">{t("library.graph.depthHops", { n: Math.min(depth, maxDepth) })}</span>
          </div>
          <div className="cg-ctrl-row">
            <Icon name="sparkles" cls="ico-sm" />
            <span className="cg-ctrl-lab">{t("library.graph.count")}</span>
            <input
              className="cg-range"
              type="range"
              min={3}
              max={maxCount}
              step={1}
              value={Math.min(count, maxCount)}
              onChange={(e) => onSugCount(+e.target.value)}
            />
            <span className="cg-ctrl-n mono">{activeSug.size}</span>
          </div>
        </div>
      )}

      <div className="cg-legend">
        <div className="cg-leg-row">
          <span className="cg-leg-cap mono">{t("library.detail.meta.year")}</span>
          <span className="cg-grad" />
          <span className="cg-leg-ends mono">{isFinite(minY) ? minY : ""}</span>
          <span className="cg-leg-ends mono">{isFinite(maxY) ? maxY : ""}</span>
        </div>
        <div className="cg-leg-row">
          <span className="cg-leg-cap mono">{t("library.graph.legendCitations")}</span>
          <span className="cg-size-dot" style={{ width: 12, height: 12, borderWidth: 1 }} />
          <span className="cg-size-dot" style={{ width: 19, height: 19, borderWidth: 4 }} />
          <span className="cg-leg-note">{t("library.graph.legendSize")}</span>
        </div>
        <div className="cg-leg-row">
          <span className="cg-leg-cap mono">{t("library.detail.meta.type")}</span>
          <span className="cg-leg-sample saved" />
          <span className="cg-leg-note">{t("library.graph.legendSaved")}</span>
          {showSug && (
            <>
              <span className="cg-leg-sample sug" />
              <span className="cg-leg-note">{t("library.graph.legendSug")}</span>
            </>
          )}
        </div>
      </div>

      {loading && (
        <div className="cg-loading">
          <div className="cg-spinner" />
          <div className="cg-loading-t">{t("library.graph.loading")}</div>
          <div className="cg-loading-d mono">{t("library.graph.loadingDesc")}</div>
        </div>
      )}

      <div className="cg-zoom">
        <button className="cg-zbtn" title={t("library.graph.zoomIn")} onClick={() => zoomBy(1.25)}>
          <Icon name="plus" cls="ico-sm" />
        </button>
        <button className="cg-zbtn" title={t("library.graph.zoomOut")} onClick={() => zoomBy(0.8)}>
          <Icon name="minus" cls="ico-sm" />
        </button>
        <button className="cg-zbtn" title={t("library.graph.fitView")} onClick={fitView}>
          <Icon name="maximize" cls="ico-sm" />
        </button>
        <button className="cg-zbtn" title={t("library.graph.relayout")} onClick={relayout}>
          <Icon name="shuffle" cls="ico-sm" />
        </button>
      </div>
    </div>
  );
}
