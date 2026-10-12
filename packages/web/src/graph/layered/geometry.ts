/** Edge curves for the layered layout (pure, world coordinates). */

import type { LayoutPoint } from "./layout";

const cubic = (a: LayoutPoint, c1: LayoutPoint, c2: LayoutPoint, b: LayoutPoint, t: number): LayoutPoint => {
  const u = 1 - t;
  const k0 = u * u * u;
  const k1 = 3 * u * u * t;
  const k2 = 3 * u * t * t;
  const k3 = t * t * t;
  return { x: k0 * a.x + k1 * c1.x + k2 * c2.x + k3 * b.x, y: k0 * a.y + k1 * c1.y + k2 * c2.y + k3 * b.y };
};

/**
 * Vertical-tangent curve from `p` to `q` through the layout's waypoints.
 * `samples` are points along the curve (for label placement and crowding).
 * `shift` fans out several edges between the same two nodes.
 */
export function edgePath(
  p: LayoutPoint,
  q: LayoutPoint,
  r1: number,
  r2: number,
  way: readonly LayoutPoint[],
  shift: number
): { d: string; samples: LayoutPoint[] } {
  const samples: LayoutPoint[] = [];
  if (!way.length && Math.abs(q.y - p.y) < 44) {
    // same row (or nearly): a bowed arc
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const a = { x: p.x + ux * r1, y: p.y + uy * r1 };
    const b = { x: q.x - ux * r2, y: q.y - uy * r2 };
    const c = { x: (a.x + b.x) / 2 - uy * (30 + shift), y: (a.y + b.y) / 2 + ux * (30 + shift) - 26 };
    for (let t = 0.05; t < 0.98; t += 0.05) samples.push(cubic(a, c, c, b, t));
    return { d: `M${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`, samples };
  }
  const s0 = Math.sign((way[0] ?? q).y - p.y) || -1;
  const sN = Math.sign(q.y - (way[way.length - 1] ?? p).y) || -1;
  const seq: LayoutPoint[] = [
    { x: p.x, y: p.y + s0 * r1 },
    ...way.map((w) => ({ x: w.x + shift, y: w.y })),
    { x: q.x, y: q.y - sN * r2 },
  ];
  // a one-row edge that points down the page bows sideways so it never hides an upward one
  const bow = way.length ? 0 : (s0 > 0 ? 72 : 0) + shift;
  let d = `M${seq[0]!.x},${seq[0]!.y}`;
  for (let i = 0; i + 1 < seq.length; i++) {
    const u = seq[i]!;
    const w = seq[i + 1]!;
    const my = (u.y + w.y) / 2;
    const c1 = { x: u.x + bow, y: my };
    const c2 = { x: w.x + bow, y: my };
    d += ` C${c1.x},${c1.y} ${c2.x},${c2.y} ${w.x},${w.y}`;
    for (let t = 0.05; t < 0.98; t += 0.05) samples.push(cubic(u, c1, c2, w, t));
  }
  return { d, samples };
}

/** Parallel edges between the same two nodes: index and count within their pair. */
export function pairFan(edges: readonly { from: string; to: string }[]): { index: number; total: number }[] {
  const total = new Map<string, number>();
  for (const e of edges) total.set(`${e.from}>${e.to}`, (total.get(`${e.from}>${e.to}`) ?? 0) + 1);
  const seen = new Map<string, number>();
  return edges.map((e) => {
    const k = `${e.from}>${e.to}`;
    const index = seen.get(k) ?? 0;
    seen.set(k, index + 1);
    return { index, total: total.get(k) ?? 1 };
  });
}

/** Everything that feeds `id` (transitively) plus everything it feeds, with the edges between. */
export function focusChain(
  edges: readonly { id: string; from: string; to: string }[],
  id: string
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set([id]);
  const used = new Set<string>();
  const walk = (up: boolean) => {
    const q = [id];
    const seen = new Set([id]);
    while (q.length) {
      const v = q.pop()!;
      for (const e of edges) {
        const hit = up ? e.to === v : e.from === v;
        const next = up ? e.from : e.to;
        if (!hit) continue;
        used.add(e.id);
        nodes.add(next);
        if (!seen.has(next)) {
          seen.add(next);
          q.push(next);
        }
      }
    }
  };
  walk(true);
  walk(false);
  return { nodes, edges: used };
}
