/**
 * Placement of node labels and edge labels (pure, world coordinates).
 *
 * A node's label sits on its right by default (the layout reserves that room).
 * It moves below, left or above only when another side is less crowded: by
 * another node, another label, or an edge running through it. Edge labels
 * then pick, along their own edge, a spot clear of nodes, node labels and the
 * labels already placed.
 */

import type { LayoutPoint } from "./layout";
import { monoUnits, textUnits } from "./text";

export type LabelSide = "right" | "below" | "left" | "above";
export interface Box {
  l: number;
  r: number;
  t: number;
  b: number;
}

export const boxesHit = (a: Box, o: Box): boolean => a.l < o.r && a.r > o.l && a.t < o.b && a.b > o.t;

const SIDES: LabelSide[] = ["right", "below", "left", "above"];
/** Prefer the default side, then below, left, above, unless another is clearly emptier. */
const BIAS: Record<LabelSide, number> = { right: 0, below: 1.5, left: 2.5, above: 3.5 };
const HIT_NODE = 60;
const HIT_LABEL = 40;
const HIT_EDGE = 2;

export interface LabelPlacementInput {
  id: string;
  at: LayoutPoint;
  /** The wrapped lines of the label. */
  lines: string[];
}

export interface LabelPlacement {
  side: LabelSide;
  box: Box;
}

export function labelBox(at: LayoutPoint, lines: readonly string[], side: LabelSide, fs: number, radius: number): Box {
  const w = Math.max(...lines.map(textUnits), 0) * fs;
  const h = lines.length * fs * 1.22;
  const gx = radius + 9;
  const gy = radius + 5;
  const l = side === "right" ? at.x + gx : side === "left" ? at.x - gx - w : at.x - w / 2;
  const t = side === "below" ? at.y + gy : side === "above" ? at.y - gy - h : at.y - h / 2;
  return { l, r: l + w, t, b: t + h };
}

export function placeNodeLabels(
  nodes: readonly LabelPlacementInput[],
  opts: { fs: number; radius: number; edgePoints: readonly LayoutPoint[] }
): Map<string, LabelPlacement> {
  const { fs, radius, edgePoints } = opts;
  const nodeBoxes = new Map<string, Box>();
  const placed = new Map<string, LabelPlacement>();
  for (const n of nodes) {
    nodeBoxes.set(n.id, { l: n.at.x - radius - 5, r: n.at.x + radius + 5, t: n.at.y - radius - 5, b: n.at.y + radius + 5 });
    placed.set(n.id, { side: "right", box: labelBox(n.at, n.lines, "right", fs, radius) });
  }
  for (let pass = 0; pass < 2; pass++) {
    for (const n of nodes) {
      let best: LabelSide = "right";
      let bestCost = Number.POSITIVE_INFINITY;
      for (const side of SIDES) {
        const k = labelBox(n.at, n.lines, side, fs, radius);
        let cost = BIAS[side];
        for (const [id, o] of nodeBoxes) if (id !== n.id && boxesHit(k, o)) cost += HIT_NODE;
        for (const [id, o] of placed) if (id !== n.id && boxesHit(k, o.box)) cost += HIT_LABEL;
        for (const q of edgePoints) if (q.x > k.l && q.x < k.r && q.y > k.t && q.y < k.b) cost += HIT_EDGE;
        if (cost < bestCost) {
          bestCost = cost;
          best = side;
        }
      }
      placed.set(n.id, { side: best, box: labelBox(n.at, n.lines, best, fs, radius) });
    }
  }
  return placed;
}

/** Candidate positions along an edge, middle first. */
const EDGE_LABEL_SPOTS = [0.5, 0.38, 0.62, 0.26, 0.74, 0.16, 0.84];

/** The label spot for each wanted edge label: the first spot clear of `obstacles` and of earlier labels, else the middle. */
export function placeEdgeLabels(
  wanted: readonly { id: string; text: string; samples: readonly LayoutPoint[] }[],
  obstacles: readonly Box[],
  fs: number
): Map<string, LayoutPoint> {
  const boxes: Box[] = [...obstacles];
  const at = new Map<string, LayoutPoint>();
  for (const g of wanted) {
    if (!g.samples.length) continue;
    // monospace face (`.lg-edge-label`): characters counted, a Latin one about 0.62em, a full-width one 1em
    const w = monoUnits(g.text) * fs + 4;
    const h = fs * 1.3;
    const box = (c: LayoutPoint): Box => ({ l: c.x - w / 2, r: c.x + w / 2, t: c.y - h / 2, b: c.y + h / 2 });
    const cands = EDGE_LABEL_SPOTS.map((f) => g.samples[Math.min(g.samples.length - 1, Math.floor(f * g.samples.length))]!);
    const pick = cands.find((c) => !boxes.some((o) => boxesHit(box(c), o))) ?? cands[0]!;
    at.set(g.id, pick);
    boxes.push(box(pick));
  }
  return at;
}
