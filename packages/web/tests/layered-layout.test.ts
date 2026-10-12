/**
 * Layered layout, label placement and chain focus: pure functions, checked on the three
 * synthetic argument graphs (well-formed 11, flawed 13, large 28) and on small hand-made inputs.
 */
import { describe, expect, it } from "vitest";
import { edgePath, focusChain, pairFan } from "../src/graph/layered/geometry";
import { ROW_GAP, type LayeredLayoutNode, layeredLayout } from "../src/graph/layered/layout";
import { type Box, boxesHit, labelBox, placeEdgeLabels, placeNodeLabels } from "../src/graph/layered/placement";
import { LABEL_FONT_MAX, labelWidth, textUnits, wrapLabel } from "../src/graph/layered/text";
import { argumentEdgeId } from "../src/argument/canvasModel";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

function input(key: keyof typeof ARGUMENT_FIXTURES) {
  const g = ARGUMENT_FIXTURES[key]();
  return {
    g,
    nodes: g.arguments.map(
      (a): LayeredLayoutNode => ({ id: a.id, pin: a.kind === "native" ? "first" : a.kind === "end" ? "last" : undefined, labelWidth: labelWidth(a.title) })
    ),
    edges: g.edges.map((e) => ({ id: argumentEdgeId(e), from: e.from, to: e.to })),
  };
}
const slot = (n: LayeredLayoutNode) => Math.max(112, n.labelWidth + 66);

describe("layeredLayout: rows", () => {
  it("puts Native on the bottom row and End on the top row, the rest by longest support chain (well-formed graph)", () => {
    const { g, nodes, edges } = input("clean");
    const lay = layeredLayout({ nodes, edges });
    expect(lay.layers).toBe(5);
    for (const a of g.arguments) {
      if (a.kind === "native") expect(lay.layerOf[a.id]).toBe(0);
      if (a.kind === "end") expect(lay.layerOf[a.id]).toBe(4);
    }
    expect(lay.layerOf).toMatchObject({ m1: 1, m2: 2, m3: 2, m5: 2, m4: 3 });
    // y grows upward as negative values, one ROW_GAP per row
    expect(lay.pos.n1!.y).toBe(0);
    expect(lay.pos.e1!.y).toBe(-4 * ROW_GAP);
    expect(lay.pos.m4!.y).toBe(-3 * ROW_GAP);
    expect(lay.backEdges).toEqual([]);
  });

  it("every edge of an acyclic graph points up, except those into a Native or out of an End", () => {
    for (const key of ["clean", "large"] as const) {
      const { g, nodes, edges } = input(key);
      const kind = new Map(g.arguments.map((a) => [a.id, a.kind]));
      const lay = layeredLayout({ nodes, edges });
      for (const e of g.edges) {
        if (kind.get(e.to) === "native" || kind.get(e.from) === "end") continue;
        expect(lay.layerOf[e.to]!, `${key}: ${e.from}->${e.to}`).toBeGreaterThan(lay.layerOf[e.from]!);
      }
    }
  });

  it("ignores a cycle-closing edge for layering only: it is reported, and the rows stay finite and ordered", () => {
    const { nodes, edges } = input("flawed");
    const lay = layeredLayout({ nodes, edges });
    // m1 -> m2 -> m4 -> m1 is the cycle; the DFS closes it at m4 -> m1
    expect(lay.backEdges).toEqual(["m4>m1:warrant"]);
    expect(lay.layerOf.m1!).toBeLessThan(lay.layerOf.m2!);
    expect(lay.layerOf.m2!).toBeLessThan(lay.layerOf.m4!);
    for (const n of nodes) expect(Number.isFinite(lay.pos[n.id]!.x)).toBe(true);
    // End arguments stay on the top row even though one of them is used again (e1 -> m6)
    expect(lay.layerOf.e1).toBe(lay.layers - 1);
    expect(lay.layerOf.e2).toBe(lay.layers - 1);
  });

  it("handles an empty graph, a graph without Native, dangling edges and self-loops", () => {
    expect(layeredLayout({ nodes: [], edges: [] })).toMatchObject({ pos: {}, layers: 1, routes: {}, backEdges: [] });
    const lay = layeredLayout({
      nodes: [
        { id: "a", labelWidth: 10 },
        { id: "b", labelWidth: 10 },
      ],
      edges: [
        { id: "ab", from: "a", to: "b" },
        { id: "aa", from: "a", to: "a" },
        { id: "ax", from: "a", to: "missing" },
      ],
    });
    expect(lay.layerOf).toEqual({ a: 0, b: 1 });
    expect(lay.backEdges).toEqual([]);
  });

  it("does not overlap slots within a row, and the slot width follows the node's own label", () => {
    for (const key of ["clean", "flawed", "large"] as const) {
      const { nodes, edges } = input(key);
      const lay = layeredLayout({ nodes, edges });
      const byRow = new Map<number, LayeredLayoutNode[]>();
      for (const n of nodes) byRow.set(lay.layerOf[n.id]!, [...(byRow.get(lay.layerOf[n.id]!) ?? []), n]);
      for (const row of byRow.values()) {
        const sorted = [...row].sort((a, b) => lay.pos[a.id]!.x - lay.pos[b.id]!.x);
        for (let i = 0; i + 1 < sorted.length; i++) {
          const gap = lay.pos[sorted[i + 1]!.id]!.x - lay.pos[sorted[i]!.id]!.x;
          expect(gap, `${key}: ${sorted[i]!.id} | ${sorted[i + 1]!.id}`).toBeGreaterThanOrEqual(slot(sorted[i]!) - 1e-6);
        }
      }
    }
    // a longer label pushes its right-hand neighbour further away
    const gap = (w: number) => {
      const lay = layeredLayout({
        nodes: [
          { id: "a", pin: "first", labelWidth: w },
          { id: "b", pin: "first", labelWidth: 20 },
          { id: "c", labelWidth: 20 },
        ],
        edges: [
          { id: "ac", from: "a", to: "c" },
          { id: "bc", from: "b", to: "c" },
        ],
      });
      return Math.abs(lay.pos.b!.x - lay.pos.a!.x);
    };
    expect(gap(200)).toBeGreaterThan(gap(20) + 100);
    expect(labelWidth("短")).toBeLessThan(labelWidth("一个相当长的短标题文字"));
  });
});

describe("layeredLayout: edges spanning several rows", () => {
  it("routes them through one invisible waypoint per crossed row, clear of every argument in that row", () => {
    const { g, nodes, edges } = input("clean");
    const lay = layeredLayout({ nodes, edges });
    // n2 (row 0) -> e2 (row 4) is a backing edge across rows 1..3
    const key = argumentEdgeId({ from: "n2", to: "e2", role: "backing" });
    const route = lay.routes[key]!;
    expect(route.map((p) => p.y)).toEqual([-ROW_GAP, -2 * ROW_GAP, -3 * ROW_GAP]);
    for (const p of route) {
      for (const a of g.arguments) {
        if (lay.pos[a.id]!.y !== p.y) continue;
        expect(Math.abs(lay.pos[a.id]!.x - p.x), `${a.id} vs waypoint at y=${p.y}`).toBeGreaterThan(30);
      }
    }
    // an edge between adjacent rows has none
    expect(lay.routes[argumentEdgeId({ from: "n1", to: "m1", role: "grounds" })]).toBeUndefined();
  });

  it("also routes the long edges of the flawed and large graphs", () => {
    for (const key of ["flawed", "large"] as const) {
      const { nodes, edges } = input(key);
      const lay = layeredLayout({ nodes, edges });
      expect(Object.keys(lay.routes).length).toBeGreaterThan(0);
      for (const pts of Object.values(lay.routes)) for (const p of pts) expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("layeredLayout: determinism", () => {
  it("returns the same layout for the same input, however often it is computed", () => {
    for (const key of ["clean", "flawed", "large"] as const) {
      const a = JSON.stringify(layeredLayout(input(key)));
      const b = JSON.stringify(layeredLayout(input(key)));
      expect(b).toBe(a);
    }
  });
});

describe("label text", () => {
  it("wraps a short title to at most two lines and ends the second with an ellipsis when cut", () => {
    expect(wrapLabel("星团")).toEqual(["星团"]);
    const long = wrapLabel("这是一个非常非常长的短标题，超出两行的部分应当被截断");
    expect(long).toHaveLength(2);
    expect(long[1]!.endsWith("…")).toBe(true);
    expect(wrapLabel("Gaia DR3 proper motions are precise enough").length).toBeLessThanOrEqual(2);
    expect(labelWidth("abc")).toBeCloseTo(textUnits("abc") * LABEL_FONT_MAX);
  });
});

describe("placeNodeLabels: no overlaps", () => {
  const fs = LABEL_FONT_MAX; // the largest size titles are drawn at: the layout reserves room for it
  const R = 10;
  function check(items: { id: string; at: { x: number; y: number }; lines: string[] }[], edgePoints: { x: number; y: number }[] = []) {
    const placed = placeNodeLabels(items, { fs, radius: R, edgePoints });
    const nodeBox = (at: { x: number; y: number }): Box => ({ l: at.x - R, r: at.x + R, t: at.y - R, b: at.y + R });
    let labelLabel = 0;
    let labelNode = 0;
    const ids = items.map((i) => i.id);
    for (let i = 0; i < ids.length; i++) {
      for (let j = 0; j < ids.length; j++) {
        if (i === j) continue;
        const a = placed.get(ids[i]!)!.box;
        if (j > i && boxesHit(a, placed.get(ids[j]!)!.box)) labelLabel++;
        if (boxesHit(a, nodeBox(items[j]!.at))) labelNode++;
      }
    }
    return { placed, labelLabel, labelNode };
  }

  it("keeps every label on the right of an automatic layout of each fixture", () => {
    for (const key of ["clean", "flawed", "large"] as const) {
      const { g, nodes, edges } = input(key);
      const lay = layeredLayout({ nodes, edges });
      const items = g.arguments.map((a) => ({ id: a.id, at: lay.pos[a.id]!, lines: wrapLabel(a.title) }));
      const { placed, labelLabel, labelNode } = check(items);
      expect({ key, labelLabel, labelNode }).toEqual({ key, labelLabel: 0, labelNode: 0 });
      expect([...placed.values()].every((p) => p.side === "right")).toBe(true);
    }
  });

  it("moves a label off the right when another argument is dragged onto it, and still overlaps nothing", () => {
    for (const key of ["clean", "flawed", "large"] as const) {
      const { g, nodes, edges } = input(key);
      const lay = layeredLayout({ nodes, edges });
      const pos = Object.fromEntries(Object.entries(lay.pos).map(([k, v]) => [k, { ...v }]));
      // drag m2 (or the second node of the large graph) next to a neighbour, 46 units left of its centre
      const [moved, near] = key === "large" ? ["g1", "g2"] : ["m2", "m3"];
      pos[moved!] = { x: pos[near!]!.x - 46, y: pos[near!]!.y + 6 };
      const items = g.arguments.map((a) => ({ id: a.id, at: pos[a.id]!, lines: wrapLabel(a.title) }));
      const { placed, labelLabel, labelNode } = check(items);
      expect({ key, labelLabel, labelNode }).toEqual({ key, labelLabel: 0, labelNode: 0 });
      expect([...placed.values()].some((p) => p.side !== "right")).toBe(true);
    }
  });

  it("picks the emptiest side when the right is taken", () => {
    const placed = placeNodeLabels(
      [
        { id: "a", at: { x: 0, y: 0 }, lines: ["alpha"] },
        { id: "b", at: { x: 60, y: 0 }, lines: ["beta"] },
      ],
      { fs: 14, radius: 10, edgePoints: [] }
    );
    expect(placed.get("a")!.side).not.toBe("right");
    expect(placed.get("b")!.side).toBe("right");
    const box = labelBox({ x: 0, y: 0 }, ["alpha"], "left", 14, 10);
    expect(box.r).toBeLessThan(0);
  });
});

describe("placeEdgeLabels", () => {
  it("avoids obstacles and earlier labels along the edge", () => {
    const samples = Array.from({ length: 19 }, (_, i) => ({ x: i * 10, y: 0 }));
    const mid = samples[Math.floor(0.5 * samples.length)]!;
    const blocker: Box = { l: mid.x - 20, r: mid.x + 20, t: -10, b: 10 };
    const at = placeEdgeLabels([{ id: "e", text: "Grounds", samples }], [blocker], 9.5);
    const p = at.get("e")!;
    expect(p).not.toEqual(mid);
    const w = "Grounds".length * 9.5 * 0.62 + 4;
    expect(boxesHit({ l: p.x - w / 2, r: p.x + w / 2, t: p.y - 6, b: p.y + 6 }, blocker)).toBe(false);
  });
});

describe("edge geometry and chain focus", () => {
  it("fans out several edges between the same pair", () => {
    expect(pairFan([{ from: "a", to: "b" }, { from: "a", to: "b" }, { from: "b", to: "a" }])).toEqual([
      { index: 0, total: 2 },
      { index: 1, total: 2 },
      { index: 0, total: 1 },
    ]);
    const p = edgePath({ x: 0, y: 0 }, { x: 0, y: -128 }, 13, 21, [], 0);
    const q = edgePath({ x: 0, y: 0 }, { x: 0, y: -128 }, 13, 21, [], 30);
    expect(p.d).not.toBe(q.d);
  });

  it("collects the whole upstream and downstream chain of a node with the edges between", () => {
    const { g } = input("clean");
    const edges = g.edges.map((e) => ({ id: argumentEdgeId(e), from: e.from, to: e.to }));
    const c = focusChain(edges, "m4");
    expect([...c.nodes].sort()).toEqual(["e1", "e2", "m1", "m2", "m3", "m4", "n1", "n2", "n3", "n4"]);
    // m5 only feeds e1 and is fed by m1: not part of m4's chain
    expect(c.nodes.has("m5")).toBe(false);
    expect(c.edges.has(argumentEdgeId({ from: "m4", to: "e1", role: "grounds" }))).toBe(true);
    expect(c.edges.has(argumentEdgeId({ from: "m5", to: "e1", role: "grounds" }))).toBe(false);
  });

  it("terminates on a cycle", () => {
    const { g } = input("flawed");
    const edges = g.edges.map((e) => ({ id: argumentEdgeId(e), from: e.from, to: e.to }));
    const c = focusChain(edges, "m2");
    expect(c.nodes.has("m1") && c.nodes.has("m4")).toBe(true);
  });
});
