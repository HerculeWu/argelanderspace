/**
 * The layer of every argument in the current layout (0 = bottom), the number the panel's pickers filter by: "one layer
 * below" for what an argument rests on, "one layer above" for what uses it. The layout is the canvas's own pure function,
 * so a picker and the picture can never disagree.
 */
import type { ArgumentGraph } from "@argelanderspace/contracts";
import { layeredLayout } from "../graph/layered/layout";
import { labelWidth } from "../graph/layered/text";
import { argumentEdgeId } from "./canvasModel";

export function argumentLayers(graph: Pick<ArgumentGraph, "arguments" | "edges">): Record<string, number> {
  return layeredLayout({
    nodes: graph.arguments.map((a) => ({ id: a.id, pin: a.kind === "native" ? "first" : a.kind === "end" ? "last" : undefined, labelWidth: labelWidth(a.title) })),
    edges: graph.edges.map((e) => ({ id: argumentEdgeId(e), from: e.from, to: e.to })),
  }).layerOf;
}
