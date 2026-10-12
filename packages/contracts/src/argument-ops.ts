/**
 * The argument graph view's page for the Copilot (argument graph ticket 04, ADR 0005): the Work, the graph as the view
 * read it, the audit and the selected argument. Like Discovery, the view publishes what it shows; the service keeps no
 * session of it. The Copilot's argument tools (ticket 09) read and edit through the page's own paths; this file is only
 * the page and its summary.
 *
 * Capacity. An argument graph can hold 500 arguments with six fields of 20 000 characters each, far more than a page
 * context should carry on every message. So the page has two forms, told apart by `partial`:
 *  - `partial: false`: the whole graph (`graph`), when its JSON is at most {@link ARGUMENT_PAGE_FULL_MAX} characters;
 *  - `partial: true`: every argument's id, short title, kind and which fields have text (`outline`), every edge, the audit,
 *    and the selected argument in full (`selected`). The omitted field text is not in the page; `note` says so.
 * The audit is carried in both forms (it is derived from the graph, so a partial page could not recompute it).
 */
import { z } from "zod";
import {
  ARGUMENT_GRAPH_LIMITS,
  type Argument,
  ArgumentEdgeSchema,
  type ArgumentGraph,
  ArgumentGraphSchema,
  ArgumentKindSchema,
  ArgumentSchema,
  auditArgumentGraph,
} from "./argument-graph.js";

/** The most JSON characters (UTF-16 code units) of `graph` a page carries whole; a bigger graph is published partial. */
export const ARGUMENT_PAGE_FULL_MAX = 100_000;

export const ARGUMENT_PAGE_PHASES = [
  "loading",
  "ready",
  "empty",
  "not-found",
  "corrupt",
  "error",
] as const;
export const ArgumentPagePhaseSchema = z.enum(ARGUMENT_PAGE_PHASES);
export type ArgumentPagePhase = z.infer<typeof ArgumentPagePhaseSchema>;

const Count = z.number().int().nonnegative();
const Id = z.string().min(1).max(ARGUMENT_GRAPH_LIMITS.idChars);

/** What the audit found, by argument id (the cycles' edges are in the graph/edges). */
export const ArgumentAuditPageSchema = z
  .object({
    total: Count,
    cycles: z.array(z.array(Id)),
    noPathToEnd: z.array(Id),
    noEnd: z.boolean(),
    endWithOutEdge: z.array(Id),
    nativeWithInEdge: z.array(Id),
    incomplete: z.array(
      z.object({ id: Id, missing: z.array(z.enum(["claim", "grounds", "warrant"])) }).strict()
    ),
  })
  .strict();
export type ArgumentAuditPage = z.infer<typeof ArgumentAuditPageSchema>;

/** One argument as a partial page lists it: no field text, only whether each field has any. */
export const ArgumentOutlineEntrySchema = z
  .object({
    id: Id,
    title: z.string().max(ARGUMENT_GRAPH_LIMITS.titleChars),
    kind: ArgumentKindSchema,
    filled: z
      .object({
        claim: z.boolean(),
        grounds: z.boolean(),
        warrant: z.boolean(),
        backing: z.boolean(),
        qualifier: z.boolean(),
        rebuttal: z.boolean(),
      })
      .strict(),
    warrantImplicit: z.boolean(),
    sources: Count,
  })
  .strict();
export type ArgumentOutlineEntry = z.infer<typeof ArgumentOutlineEntrySchema>;

export const ArgumentPageSchema = z
  .object({
    work: z.object({ id: z.string().min(1).max(500), title: z.string().max(2000) }).strict(),
    phase: ArgumentPagePhaseSchema,
    /** The graph file's revision as read; null while there is no graph (loading and the failures). */
    rev: Count.nullable(),
    counts: z.object({ arguments: Count, edges: Count }).strict(),
    /** Null while there is no graph. */
    audit: ArgumentAuditPageSchema.nullable(),
    /** The argument the panel shows (it exists in the graph). */
    selectedId: Id.nullable(),
    /** True: the page does not carry the field text of every argument (see the file comment). */
    partial: z.boolean(),
    graph: ArgumentGraphSchema.nullable(),
    outline: z.array(ArgumentOutlineEntrySchema).max(ARGUMENT_GRAPH_LIMITS.arguments).nullable(),
    edges: z.array(ArgumentEdgeSchema).max(ARGUMENT_GRAPH_LIMITS.edges).nullable(),
    selected: ArgumentSchema.nullable(),
    note: z.string().max(500).optional(),
  })
  .strict()
  .superRefine((page, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    const hasGraph = page.phase === "ready" || page.phase === "empty";
    if (page.partial) {
      if (page.phase !== "ready") bad("a partial page is a ready page");
      if (page.graph !== null || page.outline === null || page.edges === null)
        bad("a partial page lists, it carries no graph");
      if (page.outline && page.outline.length !== page.counts.arguments)
        bad("outline does not match counts");
      if (page.edges && page.edges.length !== page.counts.edges) bad("edges do not match counts");
      if ((page.selected?.id ?? null) !== page.selectedId)
        bad("selected does not match selectedId");
      if (page.selectedId !== null && !page.outline?.some((entry) => entry.id === page.selectedId))
        bad("selectedId is not in the outline");
    } else {
      if (page.outline !== null || page.edges !== null || page.selected !== null)
        bad("a whole page carries the graph only");
      if ((page.graph !== null) !== hasGraph)
        bad("graph is present exactly for ready and empty pages");
      if (
        page.graph &&
        (page.graph.arguments.length !== page.counts.arguments ||
          page.graph.edges.length !== page.counts.edges ||
          page.graph.rev !== page.rev)
      )
        bad("graph does not match counts");
      if (page.selectedId !== null && !page.graph?.arguments.some((a) => a.id === page.selectedId))
        bad("selectedId is not in the graph");
    }
    if (hasGraph !== (page.rev !== null) || hasGraph !== (page.audit !== null))
      bad("rev and audit are present exactly for ready and empty pages");
    if (page.phase === "empty" && page.counts.arguments !== 0)
      bad("an empty page has no arguments");
    if (page.phase === "ready" && page.counts.arguments === 0) bad("a ready page has arguments");
  });
export type ArgumentPage = z.infer<typeof ArgumentPageSchema>;

const auditPage = (graph: ArgumentGraph): ArgumentAuditPage => {
  const audit = auditArgumentGraph(graph);
  const cycles = audit.cycles.map((cycle) => cycle.arguments);
  return {
    total:
      cycles.length +
      (audit.noEnd ? 1 : 0) +
      audit.noPathToEnd.length +
      audit.endWithOutEdge.length +
      audit.nativeWithInEdge.length +
      audit.incomplete.length,
    cycles,
    noPathToEnd: audit.noPathToEnd,
    noEnd: audit.noEnd,
    endWithOutEdge: audit.endWithOutEdge,
    nativeWithInEdge: audit.nativeWithInEdge,
    incomplete: audit.incomplete,
  };
};

const outlineEntry = (a: Argument): ArgumentOutlineEntry => ({
  id: a.id,
  title: a.title,
  kind: a.kind,
  filled: {
    claim: a.claim.trim() !== "",
    grounds: a.grounds.trim() !== "",
    warrant: a.warrant.trim() !== "",
    backing: a.backing.trim() !== "",
    qualifier: a.qualifier.trim() !== "",
    rebuttal: a.rebuttal.trim() !== "",
  },
  warrantImplicit: a.warrant_implicit,
  sources: a.sources.length,
});

/** What a whole page says of itself (the system prompt stays short; the page explains what it is). */
export const ARGUMENT_WHOLE_NOTE =
  "this is the Library tab showing one Work's argument graph, read-only: page.graph is the whole graph and selectedId the argument the user has open; the Library page's own actions are unavailable while it is open";

export const ARGUMENT_PARTIAL_NOTE =
  "this is the Library tab showing one Work's argument graph, read-only. Partial: the field text of the arguments is not in this page (only the selected argument's), because the whole graph is too large to carry; the outline lists every argument and which fields have text. The argument tools come with a later release: until then say which text you cannot see, never guess it.";

/** The reduced form: the list of arguments, every edge and the selected argument in full. */
function partialOf(page: ArgumentPage & { graph: ArgumentGraph }, note: string): ArgumentPage {
  const graph = page.graph;
  return {
    ...page,
    partial: true,
    graph: null,
    outline: graph.arguments.map(outlineEntry),
    edges: graph.edges,
    selected: graph.arguments.find((a) => a.id === page.selectedId) ?? null,
    note,
  };
}

/**
 * The page for what the view shows. A graph whose JSON is within {@link ARGUMENT_PAGE_FULL_MAX} goes whole; a larger
 * one goes partial. Pure: the same input gives the same page.
 */
export function buildArgumentPage(input: {
  workId: string;
  title: string;
  phase: "loading" | "ready" | "not-found" | "corrupt" | "error";
  graph: ArgumentGraph | null;
  selectedId: string | null;
}): ArgumentPage {
  const { graph } = input;
  const base = { work: { id: input.workId, title: input.title } };
  if (!graph || input.phase !== "ready") {
    return {
      ...base,
      phase: input.phase === "ready" ? "loading" : input.phase,
      rev: null,
      counts: { arguments: 0, edges: 0 },
      audit: null,
      selectedId: null,
      partial: false,
      graph: null,
      outline: null,
      edges: null,
      selected: null,
    };
  }
  const selectedId = graph.arguments.some((a) => a.id === input.selectedId)
    ? input.selectedId
    : null;
  const whole: ArgumentPage & { graph: ArgumentGraph } = {
    ...base,
    phase: graph.arguments.length === 0 ? "empty" : "ready",
    rev: graph.rev,
    counts: { arguments: graph.arguments.length, edges: graph.edges.length },
    audit: auditPage(graph),
    selectedId,
    partial: false,
    graph,
    outline: null,
    edges: null,
    selected: null,
    note: ARGUMENT_WHOLE_NOTE,
  };
  return JSON.stringify(graph).length <= ARGUMENT_PAGE_FULL_MAX
    ? whole
    : partialOf(whole, ARGUMENT_PARTIAL_NOTE);
}

/** The key under which a task's context holds a whole graph at a revision (like a Reader's reading key). */
export const argumentKey = (workId: string, rev: number): string => `argument:${rev}:${workId}`;

/**
 * A page as a later observation shows it. A whole graph the task's context already holds (same Work and revision) is not
 * repeated: the observation is the partial form, which still carries the selection with the selected argument in full, so
 * clicking through arguments does not resend the graph. A graph the task's context does not hold stays whole.
 */
export function observationArgumentPage<T extends { argument?: ArgumentPage | null }>(
  source: T,
  held: ReadonlySet<string> = new Set()
): T {
  const page = source.argument;
  if (!page || page.partial || !page.graph || !held.has(argumentKey(page.work.id, page.graph.rev)))
    return source;
  const note = `the whole graph of revision ${page.graph.rev} is in the task's context; this page lists it and carries the selected argument in full. The argument tools come with a later release, so the held graph is the only copy of that text you have`;
  return { ...source, argument: partialOf(page as ArgumentPage & { graph: ArgumentGraph }, note) };
}

/** What a message records of the argument graph page it carried. */
export const ArgumentContextSummarySchema = z
  .object({
    state: ArgumentPagePhaseSchema,
    rev: Count.nullable(),
    arguments: Count,
    edges: Count,
    findings: Count,
    selectedId: Id.nullable(),
    partial: z.boolean(),
  })
  .strict();
export type ArgumentContextSummary = z.infer<typeof ArgumentContextSummarySchema>;
export function summarizeArgumentPage(page: ArgumentPage): ArgumentContextSummary {
  return {
    state: page.phase,
    rev: page.rev,
    arguments: page.counts.arguments,
    edges: page.counts.edges,
    findings: page.audit?.total ?? 0,
    selectedId: page.selectedId,
    partial: page.partial,
  };
}
