/**
 * The argument graph (论证图) — Work-owned project data, ADR 0009.
 *
 * One graph per Work, stored as `<dataDir>/argument-graphs/<encoded work id>.json`
 * (core `argument-graphs/store.ts`). This module holds the shared, pure parts:
 * the `version: 1` zod schema, the write-time structural rules, and the six
 * 论证审计 findings. Web and server import the same functions.
 *
 * Structural rules (a violation is a write failure, `ArgumentGraphSchema`
 * reports it as a zod issue): ids unique; short title non-empty after trim;
 * both ends of every edge exist; no self-loop; at most one edge per
 * (from, to, role); size limits ({@link ARGUMENT_GRAPH_LIMITS}, lengths in UTF-16 code units). Cycles, a
 * missing Claim/Grounds/Warrant, an End with out-edges and a Native with
 * in-edges are NOT write failures — they are audit findings, computed from
 * the graph on demand and never persisted ({@link auditArgumentGraph}).
 */

import { z } from "zod";

// ---- Limits (user-approved 2026-10-12) ------------------------------------- //

export const ARGUMENT_GRAPH_LIMITS = {
  arguments: 500,
  edges: 5000,
  titleChars: 80,
  fieldChars: 20_000,
  sourcesPerArgument: 50,
  idChars: 64,
  /** `doc_id` and `anchor` of a source target. */
  targetChars: 512,
} as const;

const L = ARGUMENT_GRAPH_LIMITS;

// ---- Pieces ----------------------------------------------------------------- //

export const ArgumentKindSchema = z.enum(["native", "end", "normal"]);

/** Which Toulmin element the edge's source Claim plays in the target argument. */
export const ArgumentEdgeRoleSchema = z.enum(["grounds", "warrant", "backing", "rebuttal"]);

/**
 * Where a Source points. A shared-IR Doc: `doc_id` + structural `anchor`
 * (`sec-3`, `eq-2`, …); a PDF Doc: `doc_id` + `page` (1-based). Reference
 * only: never validated against the Work's Docs.
 */
export const ArgumentSourceTargetSchema = z
  .strictObject({
    doc_id: z.string().min(1).max(L.targetChars),
    anchor: z.string().min(1).max(L.targetChars).optional(),
    page: z.number().int().positive().optional(),
  })
  .refine((t) => (t.anchor === undefined) !== (t.page === undefined), {
    message: "a source target carries exactly one of anchor or page",
  });

export const ArgumentSourceSchema = z.strictObject({
  /** Display text, e.g. `Section 3.2` (never `§`). */
  text: z.string().min(1).max(L.fieldChars),
  target: ArgumentSourceTargetSchema.optional(),
});

const field = () => z.string().max(L.fieldChars).default("");

export const ArgumentSchema = z.strictObject({
  /** Stable id; any non-empty string (agents may write their own). */
  id: z.string().min(1).max(L.idChars),
  /** Short title: required, shown on the canvas node. */
  title: z
    .string()
    .max(L.titleChars)
    .refine((s) => s.trim().length > 0, { message: "title must not be blank" }),
  claim: field(),
  grounds: field(),
  warrant: field(),
  backing: field(),
  qualifier: field(),
  rebuttal: field(),
  warrant_implicit: z.boolean().default(false),
  kind: ArgumentKindSchema.default("normal"),
  sources: z.array(ArgumentSourceSchema).max(L.sourcesPerArgument).default([]),
});

export const ArgumentEdgeSchema = z.strictObject({
  from: z.string().min(1),
  to: z.string().min(1),
  role: ArgumentEdgeRoleSchema,
});

// ---- Structural validation --------------------------------------------------- //

export interface ArgumentGraphStructureIssue {
  path: (string | number)[];
  message: string;
}

/** Write-time rules beyond field shapes. Returns every violation found. */
export function checkArgumentGraphStructure(graph: {
  arguments: readonly { id: string }[];
  edges: readonly { from: string; to: string; role: string }[];
}): ArgumentGraphStructureIssue[] {
  const issues: ArgumentGraphStructureIssue[] = [];
  const ids = new Set<string>();
  graph.arguments.forEach((a, i) => {
    if (ids.has(a.id)) {
      issues.push({ path: ["arguments", i, "id"], message: `duplicate argument id ${a.id}` });
    }
    ids.add(a.id);
  });
  const seen = new Set<string>();
  graph.edges.forEach((e, i) => {
    for (const end of ["from", "to"] as const) {
      if (!ids.has(e[end])) {
        issues.push({
          path: ["edges", i, end],
          message: `edge ${end} refers to unknown argument ${e[end]}`,
        });
      }
    }
    if (e.from === e.to) {
      issues.push({ path: ["edges", i], message: `self-loop on argument ${e.from}` });
    }
    const key = JSON.stringify([e.from, e.to, e.role]);
    if (seen.has(key)) {
      issues.push({
        path: ["edges", i],
        message: `duplicate ${e.role} edge from ${e.from} to ${e.to}`,
      });
    }
    seen.add(key);
  });
  return issues;
}

// ---- The graph ----------------------------------------------------------------- //

/**
 * One Work's graph. `rev` is the persisted optimistic-lock version: a write
 * must carry the rev it read, and the store bumps it. A Work without a graph
 * reads as the empty graph at rev 0.
 */
export const ArgumentGraphSchema = z
  .strictObject({
    version: z.literal(1),
    rev: z.number().int().nonnegative(),
    work_id: z.string().min(1),
    arguments: z.array(ArgumentSchema).max(L.arguments),
    edges: z.array(ArgumentEdgeSchema).max(L.edges),
  })
  .superRefine((graph, ctx) => {
    for (const issue of checkArgumentGraphStructure(graph)) {
      ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
    }
  });

// ---- WebSocket message (server → client) ------------------------------------------ //

/**
 * Fired after a successful `PUT /api/works/:id/argument-graph` or when the
 * poller spotted an external write to a Work's graph file. `work_id` names the
 * Work (the raw id, not the file-name encoding).
 */
export const WsArgumentGraphChangedSchema = z.object({
  type: z.literal("argument-graph.changed"),
  cause: z.enum(["put", "external"]).optional(),
  work_id: z.string(),
  /** ISO-8601 timestamp. */
  at: z.string(),
});

// ---- Audit ---------------------------------------------------------------------------- //

export type ArgumentGraph = z.infer<typeof ArgumentGraphSchema>;
export type Argument = z.infer<typeof ArgumentSchema>;
export type ArgumentEdge = z.infer<typeof ArgumentEdgeSchema>;
export type ArgumentEdgeRole = z.infer<typeof ArgumentEdgeRoleSchema>;
export type ArgumentKind = z.infer<typeof ArgumentKindSchema>;
export type ArgumentSource = z.infer<typeof ArgumentSourceSchema>;
export type ArgumentSourceTarget = z.infer<typeof ArgumentSourceTargetSchema>;
export type WsArgumentGraphChanged = z.infer<typeof WsArgumentGraphChangedSchema>;

export type ArgumentIncompleteField = "claim" | "grounds" | "warrant";

export interface ArgumentAudit {
  /**
   * 1. Cycles: one entry per strongly connected component of two or more
   * arguments (ids in graph order) with the edges inside it.
   */
  cycles: { arguments: string[]; edges: ArgumentEdge[] }[];
  /**
   * 2. Non-End arguments with no path to any End argument (edges followed
   * from → to). Empty when the graph has no End at all: `noEnd` reports that.
   */
  noPathToEnd: string[];
  /** 3. The graph has arguments but none is an End. An empty graph has no findings. */
  noEnd: boolean;
  /** 4. End arguments that have an out-edge. */
  endWithOutEdge: string[];
  /** 5. Native arguments that have an in-edge. */
  nativeWithInEdge: string[];
  /**
   * 6. Incomplete arguments: no Claim text, or Grounds / Warrant with neither
   * text nor an in-edge of that role. `warrant_implicit` does not satisfy
   * the Warrant (the inferred warrant is still written down).
   */
  incomplete: { id: string; missing: ArgumentIncompleteField[] }[];
}

/** Audit findings computed from the graph; pure, never persisted. */
export function auditArgumentGraph(graph: {
  arguments: readonly Argument[];
  edges: readonly ArgumentEdge[];
}): ArgumentAudit {
  const args = graph.arguments;
  const order = new Map(args.map((a, i) => [a.id, i]));
  const out = new Map<string, string[]>();
  const into = new Map<string, ArgumentEdge[]>();
  const outCount = new Map<string, number>();
  for (const a of args) {
    out.set(a.id, []);
    into.set(a.id, []);
    outCount.set(a.id, 0);
  }
  for (const e of graph.edges) {
    if (!order.has(e.from) || !order.has(e.to)) continue; // audit never throws on a dangling edge
    out.get(e.from)?.push(e.to);
    into.get(e.to)?.push(e);
    outCount.set(e.from, (outCount.get(e.from) ?? 0) + 1);
  }

  // 1. Cycles: Tarjan SCC, iterative (500 arguments but a chain can be deep).
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const root of args) {
    if (index.has(root.id)) continue;
    const work: { id: string; next: number }[] = [{ id: root.id, next: 0 }];
    index.set(root.id, counter);
    low.set(root.id, counter);
    counter++;
    stack.push(root.id);
    onStack.add(root.id);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { id: string; next: number };
      const succ = out.get(frame.id) as string[];
      if (frame.next < succ.length) {
        const w = succ[frame.next++] as string;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ id: w, next: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.id, Math.min(low.get(frame.id) as number, index.get(w) as number));
        }
      } else {
        work.pop();
        const parent = work[work.length - 1];
        if (parent) {
          low.set(parent.id, Math.min(low.get(parent.id) as number, low.get(frame.id) as number));
        }
        if (low.get(frame.id) === index.get(frame.id)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop() as string;
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.id);
          components.push(comp);
        }
      }
    }
  }
  const byOrder = (a: string, b: string) => (order.get(a) as number) - (order.get(b) as number);
  const cycles = components
    .filter((c) => c.length > 1)
    .map((c) => c.slice().sort(byOrder))
    .sort((a, b) => byOrder(a[0] as string, b[0] as string))
    .map((ids) => {
      const set = new Set(ids);
      return {
        arguments: ids,
        edges: graph.edges.filter((e) => set.has(e.from) && set.has(e.to)),
      };
    });

  // 2/3. Reachability to an End: reverse BFS from every End.
  const ends = args.filter((a) => a.kind === "end");
  const reaches = new Set<string>(ends.map((a) => a.id));
  const queue = [...reaches];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    for (const e of into.get(id) ?? []) {
      if (!reaches.has(e.from)) {
        reaches.add(e.from);
        queue.push(e.from);
      }
    }
  }
  // Without any End the graph-level `noEnd` says it all; listing every
  // argument as "no path" would only repeat it (approved prototype).
  const noPathToEnd =
    ends.length === 0
      ? []
      : args.filter((a) => a.kind !== "end" && !reaches.has(a.id)).map((a) => a.id);

  // 4/5. End with an out-edge, Native with an in-edge.
  const endWithOutEdge = ends.filter((a) => (outCount.get(a.id) ?? 0) > 0).map((a) => a.id);
  const nativeWithInEdge = args
    .filter((a) => a.kind === "native" && (into.get(a.id) ?? []).length > 0)
    .map((a) => a.id);

  // 6. Incomplete.
  const incomplete: ArgumentAudit["incomplete"] = [];
  for (const a of args) {
    const missing: ArgumentIncompleteField[] = [];
    const roles = new Set((into.get(a.id) ?? []).map((e) => e.role));
    if (a.claim.trim() === "") missing.push("claim");
    if (a.grounds.trim() === "" && !roles.has("grounds")) missing.push("grounds");
    if (a.warrant.trim() === "" && !roles.has("warrant")) missing.push("warrant");
    if (missing.length > 0) incomplete.push({ id: a.id, missing });
  }

  return {
    cycles,
    noPathToEnd,
    noEnd: args.length > 0 && ends.length === 0,
    endWithOutEdge,
    nativeWithInEdge,
    incomplete,
  };
}
