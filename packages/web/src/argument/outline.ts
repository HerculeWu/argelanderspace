/**
 * The argument outline (ticket 04, approved prototype variant C): End arguments are the roots, and each row expands
 * into the arguments that support it (the sources of its in-edges), each tagged with the role it plays. The same
 * argument may appear in several places; an argument that is already on the path above it is marked as a cycle and not
 * expanded. Arguments with no path to an End are their own group; with no End at all the group lists every argument.
 * Pure: only rows that are open are produced, so a large shared-support graph never expands in full.
 */
import type { ArgumentAudit, ArgumentEdgeRole, ArgumentGraph } from "@argelanderspace/contracts";

/** Levels open before the user touches anything: the End and the arguments directly supporting it. */
export const OUTLINE_DEFAULT_OPEN_DEPTH = 2;

export interface OutlineRow {
  /** Unique within the outline: the path of argument ids and roles down to this row. */
  key: string;
  id: string;
  /** The role this argument plays in the row above; null for a root. */
  role: ArgumentEdgeRole | null;
  depth: number;
  /** Already on the path above: marked, never expanded. */
  cycle: boolean;
  expandable: boolean;
  open: boolean;
}

export interface Outline {
  /** Visible rows of the End roots, in graph order. */
  ends: OutlineRow[];
  /** Visible rows of the group of arguments that do not reach an End (all arguments when there is no End). */
  orphans: OutlineRow[];
  /** The graph has arguments but no End: nothing can be expanded from a conclusion. */
  noEnd: boolean;
}

export function buildOutline(graph: ArgumentGraph, audit: ArgumentAudit, openState: ReadonlyMap<string, boolean>): Outline {
  const known = new Set(graph.arguments.map((a) => a.id));
  const supports = new Map<string, { from: string; role: ArgumentEdgeRole }[]>();
  for (const e of graph.edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    let list = supports.get(e.to);
    if (!list) supports.set(e.to, (list = []));
    list.push({ from: e.from, role: e.role });
  }
  const walk = (out: OutlineRow[], id: string, role: ArgumentEdgeRole | null, path: readonly string[], depth: number, parentKey: string) => {
    const key = `${parentKey}/${role ?? "-"}:${JSON.stringify(id)}`;
    const cycle = path.includes(id);
    const kids = cycle ? [] : (supports.get(id) ?? []);
    const open = kids.length > 0 && (openState.get(key) ?? depth < OUTLINE_DEFAULT_OPEN_DEPTH);
    out.push({ key, id, role, depth, cycle, expandable: kids.length > 0, open });
    if (open) for (const k of kids) walk(out, k.from, k.role, [...path, id], depth + 1, key);
  };
  const ends = graph.arguments.filter((a) => a.kind === "end");
  const endRows: OutlineRow[] = [];
  for (const a of ends) walk(endRows, a.id, null, [], 0, "end");
  const orphanIds = ends.length > 0 ? audit.noPathToEnd : graph.arguments.map((a) => a.id);
  const orphanRows: OutlineRow[] = [];
  for (const id of orphanIds) walk(orphanRows, id, null, [], 0, "orphan");
  return { ends: endRows, orphans: orphanRows, noEnd: graph.arguments.length > 0 && ends.length === 0 };
}
