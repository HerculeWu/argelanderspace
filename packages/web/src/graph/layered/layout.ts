/**
 * Layered layout for directed graphs (pure, deterministic): the third layout
 * the shared graph renderer can draw, next to the force layout.
 *
 * Rows run bottom to top ("first" row at y = 0, higher rows at negative y).
 * Nodes pinned `first` sit on the bottom row, nodes pinned `last` on the top
 * row, everything else sits at its longest chain length from the bottom. An
 * edge that closes a cycle is ignored for layering only (the caller still
 * draws it). An edge that spans several rows gets invisible waypoints, one in
 * each row it crosses, that take a slot there so the edge runs between nodes
 * instead of through them. Every node's slot is as wide as its own label, so
 * there is no fixed column width.
 *
 * The module knows nothing about what the nodes are.
 */

export interface LayeredLayoutNode {
  id: string;
  /** `first`: bottom row. `last`: top row. */
  pin?: "first" | "last";
  /** Width of the node's label in layout units, at the largest size it is ever drawn. */
  labelWidth: number;
}

export interface LayeredLayoutEdge {
  /** Unique within the graph; keys {@link LayeredLayout.routes}. */
  id: string;
  from: string;
  to: string;
}

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayeredLayout {
  /** Node centres. */
  pos: Record<string, LayoutPoint>;
  /** Number of rows (at least 1). */
  layers: number;
  /** Row index of each node, 0 = bottom. */
  layerOf: Record<string, number>;
  /** Waypoints of the edges that span more than one row, from source to target. */
  routes: Record<string, LayoutPoint[]>;
  /** Ids of the edges that were ignored for layering because they close a cycle. */
  backEdges: string[];
}

/** Vertical distance between rows. */
export const ROW_GAP = 128;
const MIN_SLOT = 112;
const SLOT_PAD = 66;
/** Offset of a node's centre from the left end of its slot (circle on the left, label on the right). */
const CIRCLE_INSET = 31;
const WAYPOINT_SLOT = 64;

export function layeredLayout(input: {
  nodes: readonly LayeredLayoutNode[];
  edges: readonly LayeredLayoutEdge[];
}): LayeredLayout {
  const ids = input.nodes.map((n) => n.id);
  const pin = new Map(input.nodes.map((n) => [n.id, n.pin]));
  const out = new Map<string, string[]>(ids.map((i) => [i, []]));
  const edges = input.edges.filter((e) => out.has(e.from) && out.has(e.to) && e.from !== e.to);
  for (const e of edges) out.get(e.from)!.push(e.to);

  // cycle-closing edges: the back edges of a depth-first search (iterative: chains can be deep)
  const state = new Map<string, 0 | 1 | 2>();
  const back = new Set<string>();
  for (const root of ids) {
    if (state.get(root)) continue;
    state.set(root, 1);
    const work: { v: string; next: number }[] = [{ v: root, next: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const succ = out.get(frame.v)!;
      if (frame.next < succ.length) {
        const w = succ[frame.next++]!;
        const s = state.get(w) ?? 0;
        if (s === 1) back.add(`${frame.v}>${w}`);
        else if (s === 0) {
          state.set(w, 1);
          work.push({ v: w, next: 0 });
        }
      } else {
        state.set(frame.v, 2);
        work.pop();
      }
    }
  }
  const forward = edges.filter((e) => !back.has(`${e.from}>${e.to}`));

  // longest-chain layering over the acyclic part
  const hasFirst = input.nodes.some((n) => n.pin === "first");
  const layer = new Map<string, number>(ids.map((i) => [i, pin.get(i) === "first" || !hasFirst ? 0 : 1]));
  const indeg = new Map<string, number>(ids.map((i) => [i, 0]));
  for (const e of forward) indeg.set(e.to, indeg.get(e.to)! + 1);
  const queue = ids.filter((i) => indeg.get(i) === 0);
  const fwdOut = new Map<string, LayeredLayoutEdge[]>(ids.map((i) => [i, []]));
  for (const e of forward) fwdOut.get(e.from)!.push(e);
  for (let head = 0; head < queue.length; head++) {
    const v = queue[head]!;
    for (const e of fwdOut.get(v)!) {
      if (pin.get(e.to) !== "first") layer.set(e.to, Math.max(layer.get(e.to)!, layer.get(v)! + 1));
      indeg.set(e.to, indeg.get(e.to)! - 1);
      if (indeg.get(e.to) === 0) queue.push(e.to);
    }
  }
  const lower = ids.filter((i) => pin.get(i) !== "last").map((i) => layer.get(i)!);
  const top = Math.max(
    lower.length ? Math.max(...lower) + 1 : 0,
    ...ids.filter((i) => pin.get(i) === "last").map((i) => layer.get(i)!),
    0
  );
  for (const i of ids) if (pin.get(i) === "last") layer.set(i, top);
  const used = [...new Set(ids.map((i) => layer.get(i)!))].sort((a, b) => a - b);
  for (const i of ids) layer.set(i, used.indexOf(layer.get(i)!));
  const layers = Math.max(used.length, 1);

  // rows of real nodes plus waypoints for edges that span several rows
  const rows: string[][] = Array.from({ length: layers }, () => []);
  for (const i of ids) rows[layer.get(i)!]!.push(i);
  const nb = new Map<string, string[]>(ids.map((i) => [i, []]));
  const rowOf = new Map<string, number>(ids.map((i) => [i, layer.get(i)!]));
  const link = (a: string, b: string) => {
    nb.get(a)!.push(b);
    nb.get(b)!.push(a);
  };
  const chains = new Map<string, string[]>();
  for (const e of edges) {
    const a = layer.get(e.from)!;
    const b = layer.get(e.to)!;
    const step = Math.sign(b - a);
    let prev = e.from;
    const chain: string[] = [];
    for (let k = a + step; step !== 0 && k !== b; k += step) {
      const d = `~${e.id}~${k}`;
      nb.set(d, []);
      rowOf.set(d, k);
      rows[k]!.push(d);
      chain.push(d);
      link(prev, d);
      prev = d;
    }
    link(prev, e.to);
    if (chain.length) chains.set(e.id, chain);
  }

  // order within rows: barycentre sweeps
  const order = new Map<string, number>();
  const index = () => rows.forEach((r) => r.forEach((id, k) => order.set(id, k - (r.length - 1) / 2)));
  index();
  for (let sweep = 0; sweep < 8; sweep++) {
    const seq = sweep % 2 === 0 ? rows.map((_, k) => k) : rows.map((_, k) => rows.length - 1 - k);
    for (const k of seq) {
      const bary = new Map(
        rows[k]!.map((id) => {
          const ns = nb.get(id)!.filter((n) => rowOf.get(n) !== k);
          return [id, ns.length ? ns.reduce((s, n) => s + order.get(n)!, 0) / ns.length : order.get(id)!] as const;
        })
      );
      rows[k]!.sort((a, b) => bary.get(a)! - bary.get(b)!);
      index();
    }
  }

  // x: pack each row by slot width, then pull every circle towards its neighbours in adjacent rows
  const labelWidth = new Map(input.nodes.map((n) => [n.id, n.labelWidth]));
  const width = (id: string) => (id.startsWith("~") ? WAYPOINT_SLOT : Math.max(MIN_SLOT, labelWidth.get(id)! + SLOT_PAD));
  const off = (id: string) => (id.startsWith("~") ? 0 : CIRCLE_INSET - width(id) / 2);
  const x = new Map<string, number>();
  const cx = (id: string) => x.get(id)! + off(id);
  for (const r of rows) {
    let c = 0;
    const xs = r.map((id, i) => {
      if (i) c += (width(r[i - 1]!) + width(id)) / 2;
      return c;
    });
    r.forEach((id, i) => x.set(id, xs[i]! - c / 2));
  }
  for (let it = 0; it < 14; it++) {
    for (const k of it % 2 === 0 ? rows.map((_, j) => j) : rows.map((_, j) => rows.length - 1 - j)) {
      const r = rows[k]!;
      if (!r.length) continue;
      const want = r.map((id) => {
        const ns = nb.get(id)!.filter((n) => rowOf.get(n) !== k);
        return ns.length ? ns.reduce((sum, n) => sum + cx(n), 0) / ns.length - off(id) : x.get(id)!;
      });
      const sep = (i: number) => (width(r[i - 1]!) + width(r[i]!)) / 2;
      const f = [...want];
      const b = [...want];
      for (let i = 1; i < r.length; i++) f[i] = Math.max(f[i]!, f[i - 1]! + sep(i));
      for (let i = r.length - 2; i >= 0; i--) b[i] = Math.min(b[i]!, b[i + 1]! - sep(i + 1));
      r.forEach((id, i) => x.set(id, (f[i]! + b[i]!) / 2));
    }
  }

  const all = ids.map(cx);
  const mid = all.length ? (Math.min(...all) + Math.max(...all)) / 2 : 0;
  const pos: Record<string, LayoutPoint> = {};
  const layerOf: Record<string, number> = {};
  const routes: Record<string, LayoutPoint[]> = {};
  for (const i of ids) {
    pos[i] = { x: cx(i) - mid, y: 0 - layer.get(i)! * ROW_GAP };
    layerOf[i] = layer.get(i)!;
  }
  for (const [key, chain] of chains) routes[key] = chain.map((d) => ({ x: x.get(d)! - mid, y: 0 - rowOf.get(d)! * ROW_GAP }));
  const backEdges = edges.filter((e) => back.has(`${e.from}>${e.to}`)).map((e) => e.id);
  return { pos, layers, layerOf, routes, backEdges };
}
