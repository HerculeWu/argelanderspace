/**
 * Argument graph -> layered canvas specs (pure). This is where the domain lives:
 * what Native / End / ordinary look like, which colour and line style each edge
 * role gets, which edges are on a cycle and which arguments carry an audit mark.
 * The audit comes from `@argelanderspace/contracts` (`auditArgumentGraph`); the
 * renderer sees only colours, dashes and badges.
 */

import type { Argument, ArgumentAudit, ArgumentEdge, ArgumentEdgeRole, ArgumentGraph, ArgumentKind } from "@argelanderspace/contracts";
import type { LayeredEdgeSpec, LayeredNodeSpec } from "../graph/LayeredGraphCanvas";

export const ARGUMENT_ROLES: ArgumentEdgeRole[] = ["grounds", "warrant", "backing", "rebuttal"];

/** Colour tokens live in argelander.css (`--ag-*`). */
export const KIND_COLOR: Record<ArgumentKind, string> = {
  native: "var(--ag-native)",
  end: "var(--ag-end)",
  normal: "var(--ag-normal)",
};
export const ROLE_COLOR: Record<ArgumentEdgeRole, string> = {
  grounds: "var(--ag-grounds)",
  warrant: "var(--ag-warrant)",
  backing: "var(--ag-backing)",
  rebuttal: "var(--ag-rebuttal)",
};
const CYCLE_COLOR = "var(--danger)";

export const argumentEdgeId = (e: Pick<ArgumentEdge, "from" | "to" | "role">): string => `${e.from}>${e.to}:${e.role}`;

/** How many audit findings name each argument (graph-level `noEnd` names none). */
export function auditCounts(audit: ArgumentAudit): Map<string, number> {
  const m = new Map<string, number>();
  const add = (id: string) => m.set(id, (m.get(id) ?? 0) + 1);
  for (const c of audit.cycles) for (const id of c.arguments) add(id);
  for (const id of audit.noPathToEnd) add(id);
  for (const id of audit.endWithOutEdge) add(id);
  for (const id of audit.nativeWithInEdge) add(id);
  for (const i of audit.incomplete) add(i.id);
  return m;
}

/** Ids of the edges inside a cycle's strongly connected component. */
export function cycleEdgeIds(audit: ArgumentAudit): Set<string> {
  return new Set(audit.cycles.flatMap((c) => c.edges.map(argumentEdgeId)));
}

export interface ArgumentCanvasText {
  roleName: (role: ArgumentEdgeRole) => string;
  auditMark: string;
}

export function buildArgumentCanvas(
  graph: Pick<ArgumentGraph, "arguments" | "edges">,
  audit: ArgumentAudit,
  text: ArgumentCanvasText,
  /** Edge ids whose role label stays on even when the edge is not lit. */
  labelled: ReadonlySet<string> = new Set()
): { nodes: LayeredNodeSpec[]; edges: LayeredEdgeSpec[] } {
  const marks = auditCounts(audit);
  const onCycle = cycleEdgeIds(audit);
  const nodes = graph.arguments.map(
    (a: Argument): LayeredNodeSpec => ({
      id: a.id,
      label: a.title,
      name: a.title,
      color: KIND_COLOR[a.kind],
      ringed: a.kind === "end",
      pin: a.kind === "native" ? "first" : a.kind === "end" ? "last" : undefined,
      mark: marks.has(a.id) ? { text: "!", label: text.auditMark } : undefined,
    })
  );
  const edges = graph.edges.map((e): LayeredEdgeSpec => {
    const id = argumentEdgeId(e);
    const cyc = onCycle.has(id);
    return {
      id,
      from: e.from,
      to: e.to,
      color: cyc ? CYCLE_COLOR : ROLE_COLOR[e.role],
      restingColor: cyc ? CYCLE_COLOR : undefined,
      dash: e.role === "backing" ? "dashed" : e.role === "rebuttal" ? "dotted" : undefined,
      label: text.roleName(e.role),
      showLabel: labelled.has(id),
      tag: e.role,
    };
  });
  return { nodes, edges };
}
