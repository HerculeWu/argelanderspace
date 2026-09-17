/**
 * Shared citation-graph physics + geometry (Stage 14): one force layout used
 * by both the Library graph and the ADS Discovery graph (stage plan §14 D4 —
 * shared renderer, domain adapters decide node shape/role/styling).
 *
 * Constants follow the Stage 14 interaction prototype (itself ported from the
 * repo's original CitationGraph): repulsion 12500/d², node clearance padding
 * 39, link rest length 145 / stiffness 0.045, centering 0.012, damping 0.86.
 * The layout is deterministic per `layoutKey` (seeded RNG) so the same scene
 * re-renders identically; a `seedId` pins the origin node at (0,0).
 */

export interface PNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fx: number | null;
  fy: number | null;
}
export type PMap = Record<string, PNode>;

export interface LayoutNode {
  id: string;
  citations: number;
}
export type LayoutEdge = readonly [string, string];

/** Node radius from the citation count (log scale, clamped). */
export function cgRadius(c: number): number {
  return Math.max(9, Math.min(34, 8 + Math.log10(Math.max(0, c) + 10) * 5.4));
}

/** Year → hue offset around the accent hue. Older = cooler, newer = warmer. */
export function cgHue(y: number, minY: number, maxY: number): string {
  const t = maxY === minY ? 0.5 : (y - minY) / (maxY - minY);
  return ((0.5 - t) * 104).toFixed(1); // +52° (old) … −52° (new)
}

/** Compact count: 1234 → "1.2k", 27842 → "28k". */
export function cgKfmt(n: number): string {
  if (n >= 1000) {
    const k = n / 1000;
    return (k >= 100 ? Math.round(k) : Number(k.toFixed(1).replace(/\.0$/, ""))) + "k";
  }
  return "" + n;
}

/** Deterministic RNG seeded from the scene key (FNV-1a → LCG). */
export function seededRandom(text: string): () => number {
  let s = 2166136261;
  for (const c of text) {
    s ^= c.charCodeAt(0);
    s = Math.imul(s, 16777619);
  }
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** One physics step, mutating P in place (shared by pre-warm and live loop). */
export function cgTick(
  P: PMap,
  R: Record<string, number>,
  ids: string[],
  links: readonly LayoutEdge[],
  alpha: number
): void {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const p = P[ids[i]!];
      const q = P[ids[j]!];
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const d2 = Math.max(1, dx * dx + dy * dy);
      const d = Math.sqrt(d2);
      const f = (12500 / d2) * alpha;
      const ux = dx / d;
      const uy = dy / d;
      p.vx += ux * f;
      p.vy += uy * f;
      q.vx -= ux * f;
      q.vy -= uy * f;
      const minD = (R[ids[i]!] ?? 12) + (R[ids[j]!] ?? 12) + 39;
      if (d < minD) {
        const push = (minD - d) * 0.6 * alpha;
        p.vx += ux * push;
        p.vy += uy * push;
        q.vx -= ux * push;
        q.vy -= uy * push;
      }
    }
  }
  for (const [s, t] of links) {
    const p = P[s];
    const q = P[t];
    if (!p || !q) continue;
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    const f = (d - 145) * 0.045 * alpha;
    const ux = dx / d;
    const uy = dy / d;
    p.vx += ux * f;
    p.vy += uy * f;
    q.vx -= ux * f;
    q.vy -= uy * f;
  }
  for (const id of ids) {
    const p = P[id];
    p.vx += (0 - p.x) * 0.012 * alpha;
    p.vy += (0 - p.y) * 0.012 * alpha;
    if (p.fx != null) {
      p.x = p.fx;
      p.y = p.fy ?? p.y;
      p.vx = 0;
      p.vy = 0;
      continue;
    }
    p.vx *= 0.86;
    p.vy *= 0.86;
    p.x += p.vx;
    p.y += p.vy;
  }
}

/**
 * Run the simulation to rest synchronously. The seed node (when given) is
 * pinned at the origin; a final pass separates near-horizontal label rows
 * without touching the seed (visual clearance only — no graph semantics).
 */
export function cgComputeLayout(
  nodes: readonly LayoutNode[],
  links: readonly LayoutEdge[],
  layoutKey: string,
  seedId: string | null = null,
  salt = "0"
): PMap {
  const P: PMap = {};
  const R: Record<string, number> = {};
  const ids = nodes.map((n) => n.id);
  const rnd = seededRandom(layoutKey + salt);
  nodes.forEach((n, i) => {
    const a = (i / Math.max(1, nodes.length)) * Math.PI * 2;
    P[n.id] = {
      x: Math.cos(a) * 215 + (rnd() - 0.5) * 70,
      y: Math.sin(a) * 215 + (rnd() - 0.5) * 70,
      vx: 0,
      vy: 0,
      fx: n.id === seedId ? 0 : null,
      fy: n.id === seedId ? 0 : null,
    };
    R[n.id] = cgRadius(n.citations);
  });
  let alpha = 0.95;
  for (let it = 0; it < 320; it++) {
    cgTick(P, R, ids, links, alpha);
    alpha *= 0.984;
  }
  // label clearance: separate near-horizontal neighbours vertically
  for (let k = 0; k < 20; k++) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const p = P[ids[i]!];
        const q = P[ids[j]!];
        if (Math.abs(p.x - q.x) < 90 && Math.abs(p.y - q.y) < 34) {
          const d = (34 - Math.abs(p.y - q.y)) * 0.28;
          const sign = p.y < q.y ? -1 : 1;
          if (ids[i] !== seedId) p.y += sign * d;
          if (ids[j] !== seedId) q.y -= sign * d;
        }
      }
    }
  }
  return P;
}
