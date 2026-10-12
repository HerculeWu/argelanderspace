/**
 * Edit operations on an argument graph (论证图), the pure half of the one commit path (ticket 05).
 *
 * Every operation takes the graph the caller read plus its parameters and answers a new graph or a refusal; none touches
 * `rev` (the write that carries the graph does: `PUT /api/works/:id/argument-graph` bumps it) or the network. The page
 * and, later, the Copilot's argument-graph tools (ticket 09) call exactly these, so a page edit and a tool edit refuse
 * and accept the same things for the same reasons. Each result is checked against {@link ArgumentGraphSchema} before it
 * is returned, so "refused here" and "rejected by the server's 400" are the same rule set; a result the schema rejects
 * comes back as `invalid` with {@link ArgumentEditIssue}s a person can read.
 */

import {
  ARGUMENT_GRAPH_LIMITS,
  type Argument,
  type ArgumentEdge,
  type ArgumentEdgeRole,
  type ArgumentGraph,
  ArgumentGraphSchema,
  type ArgumentKind,
  type ArgumentSource,
} from "./argument-graph.js";

// ---- Results ---------------------------------------------------------------- //

/** Why a write was refused before it was sent (or why the server's structure check would refuse it). */
export type ArgumentEditIssue =
  | { code: "title_blank"; argumentId?: string }
  | { code: "title_too_long"; argumentId?: string; limit: number }
  | { code: "field_too_long"; argumentId?: string; field: string; limit: number }
  | { code: "source_text_blank"; argumentId?: string; index: number }
  | { code: "too_many_sources"; argumentId?: string; limit: number }
  | { code: "too_many_arguments"; limit: number }
  | { code: "too_many_edges"; limit: number }
  | { code: "duplicate_id"; argumentId: string }
  | { code: "other"; message: string };

export type ArgumentEditRejection =
  /** No argument has this id. */
  | { code: "not_found"; id: string }
  /** An argument cannot rest on itself. */
  | { code: "self_loop"; id: string }
  /** The same pair already has an edge of this role. */
  | { code: "duplicate_edge"; from: string; to: string; role: ArgumentEdgeRole }
  /** The edge to remove does not exist. */
  | { code: "edge_not_found"; from: string; to: string; role: ArgumentEdgeRole }
  /** The result would not be a valid graph. */
  | { code: "invalid"; issues: ArgumentEditIssue[] };

export type ArgumentEditResult<T extends object = Record<never, never>> =
  | ({ ok: true; graph: ArgumentGraph } & T)
  | { ok: false; rejection: ArgumentEditRejection };

/** What a caller supplies for an argument; everything but the short title may be left out. */
export interface ArgumentDraft {
  title: string;
  claim?: string;
  grounds?: string;
  warrant?: string;
  backing?: string;
  qualifier?: string;
  rebuttal?: string;
  warrant_implicit?: boolean;
  kind?: ArgumentKind;
  sources?: ArgumentSource[];
}

export const BLANK_ARGUMENT: Omit<Argument, "id"> = {
  title: "",
  claim: "",
  grounds: "",
  warrant: "",
  backing: "",
  qualifier: "",
  rebuttal: "",
  warrant_implicit: false,
  kind: "normal",
  sources: [],
};

/** The fields of an argument a person edits in one go (everything but its id). */
export const ARGUMENT_EDITABLE_FIELDS = [
  "title",
  "claim",
  "grounds",
  "warrant",
  "backing",
  "qualifier",
  "rebuttal",
  "warrant_implicit",
  "kind",
  "sources",
] as const;

// ---- Validation, readable ----------------------------------------------------- //

/** Turns the schema's verdict on a candidate graph into issues a person can read; `[]` when it is valid. */
export function checkArgumentGraphForWrite(graph: unknown): ArgumentEditIssue[] {
  const parsed = ArgumentGraphSchema.safeParse(graph);
  if (parsed.success) return [];
  const args = (graph as { arguments?: { id?: unknown }[] } | null)?.arguments ?? [];
  const idAt = (i: unknown) =>
    typeof i === "number" && typeof args[i]?.id === "string" ? (args[i]?.id as string) : undefined;
  const issues: ArgumentEditIssue[] = [];
  const seen = new Set<string>();
  for (const issue of parsed.error.issues) {
    const [root, index, field, sub, sub2] = issue.path;
    const argumentId = root === "arguments" ? idAt(index) : undefined;
    const withId = argumentId === undefined ? {} : { argumentId };
    let mapped: ArgumentEditIssue;
    if (root === "arguments" && index === undefined) {
      mapped = { code: "too_many_arguments", limit: ARGUMENT_GRAPH_LIMITS.arguments };
    } else if (root === "edges" && index === undefined) {
      mapped = { code: "too_many_edges", limit: ARGUMENT_GRAPH_LIMITS.edges };
    } else if (root === "arguments" && field === "title") {
      mapped =
        issue.code === "too_big"
          ? { code: "title_too_long", ...withId, limit: ARGUMENT_GRAPH_LIMITS.titleChars }
          : { code: "title_blank", ...withId };
    } else if (root === "arguments" && field === "id" && issue.code === "custom") {
      mapped = { code: "duplicate_id", argumentId: argumentId ?? "" };
    } else if (root === "arguments" && field === "sources" && sub === undefined) {
      mapped = {
        code: "too_many_sources",
        ...withId,
        limit: ARGUMENT_GRAPH_LIMITS.sourcesPerArgument,
      };
    } else if (root === "arguments" && field === "sources" && sub2 === "text") {
      mapped =
        issue.code === "too_big"
          ? {
              code: "field_too_long",
              ...withId,
              field: "sources",
              limit: ARGUMENT_GRAPH_LIMITS.fieldChars,
            }
          : { code: "source_text_blank", ...withId, index: Number(sub) };
    } else if (root === "arguments" && typeof field === "string" && issue.code === "too_big") {
      mapped = {
        code: "field_too_long",
        ...withId,
        field,
        limit: ARGUMENT_GRAPH_LIMITS.fieldChars,
      };
    } else {
      mapped = { code: "other", message: issue.message };
    }
    const key = JSON.stringify(mapped);
    if (!seen.has(key)) {
      seen.add(key);
      issues.push(mapped);
    }
  }
  return issues;
}

function finish<T extends object>(graph: ArgumentGraph, extra: T): ArgumentEditResult<T> {
  const issues = checkArgumentGraphForWrite(graph);
  if (issues.length > 0) return { ok: false, rejection: { code: "invalid", issues } };
  return { ok: true, graph, ...extra };
}

const refuse = (
  rejection: ArgumentEditRejection
): { ok: false; rejection: ArgumentEditRejection } => ({ ok: false, rejection });

// ---- Operations --------------------------------------------------------------- //

/** The alphabet of a generated id's random part (lowercase base 36: short, readable to a person, a CLI and the Copilot). */
const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyz";
const ID_RANDOM_LENGTH = 5;
/** Fresh random draws tried before the fallback (with 36^5 ids, a second draw is already unusual). */
const ID_DRAWS = 50;

/**
 * A fresh argument id: `a` and five random base-36 characters (`a7k3q2`). Not the smallest free number: an id a deleted
 * argument held must not come back for a different one, because conflict detection and Undo recognise an argument by its
 * id. The id differs from every argument now in `graph` (the draw is repeated, a bounded number of times, then lengthened by a counter); `random` is injectable
 * (a function giving a number in [0, 1)) so a test can pin it.
 */
export function nextArgumentId(
  graph: { arguments: readonly { id: string }[] },
  random: () => number = Math.random
): string {
  const used = new Set(graph.arguments.map((a) => a.id));
  const draw = (): string => {
    let id = "a";
    for (let i = 0; i < ID_RANDOM_LENGTH; i++)
      id += ID_CHARS[Math.min(ID_CHARS.length - 1, Math.floor(random() * ID_CHARS.length))];
    return id;
  };
  let id = draw();
  for (let attempt = 1; used.has(id) && attempt < ID_DRAWS; attempt++) id = draw();
  // A source that keeps giving a taken draw (a pinned test source, a broken generator) must not hold the page: the last
  // draw is lengthened by a counter instead, which ends because the graph has finitely many ids.
  for (let n = 1, base = id; used.has(id); n++) id = `${base}${n}`;
  return id;
}

/** Appends a new argument. `id` defaults to a fresh {@link nextArgumentId}; a taken id is refused as `invalid` (duplicate). */
export function createArgument(
  graph: ArgumentGraph,
  draft: ArgumentDraft,
  id?: string
): ArgumentEditResult<{ id: string }> {
  const newId = id ?? nextArgumentId(graph);
  const argument: Argument = {
    id: newId,
    title: draft.title,
    claim: draft.claim ?? "",
    grounds: draft.grounds ?? "",
    warrant: draft.warrant ?? "",
    backing: draft.backing ?? "",
    qualifier: draft.qualifier ?? "",
    rebuttal: draft.rebuttal ?? "",
    warrant_implicit: draft.warrant_implicit ?? false,
    kind: draft.kind ?? "normal",
    sources: structuredClone(draft.sources ?? []),
  };
  return finish({ ...graph, arguments: [...graph.arguments, argument] }, { id: newId });
}

/** Replaces the given fields of one argument (its id and edges stay). */
export function updateArgument(
  graph: ArgumentGraph,
  id: string,
  patch: Partial<ArgumentDraft>
): ArgumentEditResult {
  const at = graph.arguments.findIndex((a) => a.id === id);
  if (at < 0) return refuse({ code: "not_found", id });
  const next: Argument = { ...(graph.arguments[at] as Argument) };
  for (const key of ARGUMENT_EDITABLE_FIELDS) {
    const value = patch[key];
    if (value !== undefined)
      (next as Record<string, unknown>)[key] = key === "sources" ? structuredClone(value) : value;
  }
  return finish({ ...graph, arguments: graph.arguments.map((a, i) => (i === at ? next : a)) }, {});
}

/** What deleting an argument took away; {@link restoreArgument} puts it back. */
export interface RemovedArgument {
  argument: Argument;
  /** Position in the argument list. */
  index: number;
  /** Every edge that touched it, with its position in the edge list. */
  edges: { edge: ArgumentEdge; index: number }[];
}

/** Removes an argument and every edge that touches it. */
export function deleteArgument(
  graph: ArgumentGraph,
  id: string
): ArgumentEditResult<{ removed: RemovedArgument }> {
  const index = graph.arguments.findIndex((a) => a.id === id);
  if (index < 0) return refuse({ code: "not_found", id });
  const edges = graph.edges.flatMap((edge, i) =>
    edge.from === id || edge.to === id ? [{ edge, index: i }] : []
  );
  const removed: RemovedArgument = {
    argument: structuredClone(graph.arguments[index] as Argument),
    index,
    edges: structuredClone(edges),
  };
  return finish(
    {
      ...graph,
      arguments: graph.arguments.filter((a) => a.id !== id),
      edges: graph.edges.filter((e) => e.from !== id && e.to !== id),
    },
    { removed }
  );
}

/** The inverse of {@link deleteArgument} on the graph it produced: argument and edges go back where they were. */
export function restoreArgument(
  graph: ArgumentGraph,
  removed: RemovedArgument
): ArgumentEditResult {
  const args = [...graph.arguments];
  args.splice(Math.min(removed.index, args.length), 0, structuredClone(removed.argument));
  const edges = [...graph.edges];
  for (const { edge, index } of [...removed.edges].sort((a, b) => a.index - b.index))
    edges.splice(Math.min(index, edges.length), 0, { ...edge });
  return finish({ ...graph, arguments: args, edges }, {});
}

/** `from`'s Claim plays `role` in `to`. Self-loops and a second edge of the same role between the pair are refused. */
export function addEdge(graph: ArgumentGraph, edge: ArgumentEdge): ArgumentEditResult {
  for (const id of [edge.from, edge.to])
    if (!graph.arguments.some((a) => a.id === id)) return refuse({ code: "not_found", id });
  if (edge.from === edge.to) return refuse({ code: "self_loop", id: edge.from });
  if (graph.edges.some((e) => e.from === edge.from && e.to === edge.to && e.role === edge.role)) {
    return refuse({ code: "duplicate_edge", from: edge.from, to: edge.to, role: edge.role });
  }
  return finish(
    { ...graph, edges: [...graph.edges, { from: edge.from, to: edge.to, role: edge.role }] },
    {}
  );
}

export function removeEdge(graph: ArgumentGraph, edge: ArgumentEdge): ArgumentEditResult {
  const at = graph.edges.findIndex(
    (e) => e.from === edge.from && e.to === edge.to && e.role === edge.role
  );
  if (at < 0)
    return refuse({ code: "edge_not_found", from: edge.from, to: edge.to, role: edge.role });
  return finish({ ...graph, edges: graph.edges.filter((_, i) => i !== at) }, {});
}

/** The empty graph at the same Work (the confirmation that guards it is the caller's). */
export function clearArgumentGraph(graph: ArgumentGraph): ArgumentEditResult {
  return finish({ ...graph, arguments: [], edges: [] }, {});
}

/** Whether two arguments hold the same content (the id included). */
export const sameArgument = (a: Argument, b: Argument): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

// ---- Sources ---------------------------------------------------------------------- //

/** The display text a source target gets when the person left the text empty: `Section 3.2`, `Figure 4`, `Page 5` (never `§`). */
export function autoSourceText(
  kind: "section" | "figure" | "table" | "equation" | "page",
  number: string | number
): string {
  const word =
    kind === "section"
      ? "Section"
      : kind === "figure"
        ? "Figure"
        : kind === "table"
          ? "Table"
          : kind === "equation"
            ? "Equation"
            : "Page";
  return `${word} ${number}`;
}
