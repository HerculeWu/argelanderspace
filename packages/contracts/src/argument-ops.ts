/**
 * The argument graph view's page for the Copilot (argument graph ticket 04, ADR 0005): the Work, the graph as the view
 * read it, the audit and the selected argument. Like Discovery, the view publishes what it shows; the service keeps no
 * session of it. The Copilot's argument tools (ticket 09) read and edit through the page's own paths; this file is only
 * the page and its summary.
 *
 * Capacity. An argument graph can hold 500 arguments with six fields of 20 000 characters each and 5000 edges, far more
 * than a page context should carry on every message. So the page has two forms, told apart by `partial`:
 *  - `partial: false`: the whole graph (`graph`), when its JSON is at most {@link ARGUMENT_PAGE_FULL_MAX} characters and
 *    the whole page at most {@link ARGUMENT_PAGE_MAX};
 *  - `partial: true`: a reduced page that lists instead of carrying (`outline`, `edges`, `selected`) and says what it
 *    left out in `reduction`. Four levels, each smaller than the one before, and the smallest that fits is used:
 *      1. every argument's id, short title, kind and which fields have text, every edge, the selected argument in full;
 *      2. the selected argument's fields and source texts cut to a given length (`reduction.truncated` names what);
 *      3. only the edges that touch the selected argument (`counts.edges` stays the total);
 *      4. the outline keeps only id, short title and kind (as many as fit), the audit's lists are capped.
 *    No page, whatever the graph and the selection, is longer than {@link ARGUMENT_PAGE_MAX} JSON characters, and a
 *    reduced page is never longer than the whole page it replaces.
 * The audit is carried in every form (it is derived from the graph, so a reduced page could not recompute it).
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

/** The most JSON characters (UTF-16 code units) of `graph` a page carries whole; a bigger graph is published reduced. */
export const ARGUMENT_PAGE_FULL_MAX = 100_000;
/** The hard ceiling for a whole page's JSON, in any form: audit, outline, edges and the selected argument included. */
export const ARGUMENT_PAGE_MAX = 150_000;

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

/** The longest note any form of any phase can carry (a test holds every form to it). */
export const ARGUMENT_NOTE_MAX = 900;
const NOTE_MAX = ARGUMENT_NOTE_MAX;
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

/**
 * One argument as a reduced page lists it: no field text, only whether each field has any. At reduction level 4 only
 * `id`, `title` and `kind` remain.
 */
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
      .strict()
      .optional(),
    warrantImplicit: z.boolean().optional(),
    sources: Count.optional(),
  })
  .strict();
export type ArgumentOutlineEntry = z.infer<typeof ArgumentOutlineEntrySchema>;

/** What a reduced page left out (see the file comment for the four levels). */
export const ArgumentReductionSchema = z
  .object({
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    /** Levels 2 and up: the most characters of a field / of a source text of `selected`; longer ones are cut. */
    textLimit: z.object({ field: Count, source: Count }).strict().nullable(),
    /** What of `selected` was cut: `claim`, `grounds`, ... and `sources.<index>.text`. */
    truncated: z.array(z.string().max(40)).max(60),
    /** Level 4: arguments the outline does not list (the selected one is always listed). */
    outlineOmitted: Count,
    /** Level 4: trailing sources of `selected` not listed. */
    sourcesOmitted: Count,
    /** Level 4: the audit's lists are capped (`audit.total` is still the real number of findings). */
    auditTruncated: z.boolean(),
  })
  .strict();
export type ArgumentReduction = z.infer<typeof ArgumentReductionSchema>;

const SELECTED_TEXTS = ["claim", "grounds", "warrant", "backing", "qualifier", "rebuttal"] as const;

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
    /** Exactly the partial pages say what they left out. */
    reduction: ArgumentReductionSchema.nullable(),
    note: z.string().max(NOTE_MAX).optional(),
  })
  .strict()
  .superRefine((page, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    const hasGraph = page.phase === "ready" || page.phase === "empty";
    if (page.partial) {
      const reduction = page.reduction;
      if (page.phase !== "ready") bad("a partial page is a ready page");
      if (page.graph !== null || page.outline === null || page.edges === null)
        bad("a partial page lists, it carries no graph");
      if (!reduction) bad("a partial page says what it left out");
      if (
        page.outline &&
        page.outline.length + (reduction?.outlineOmitted ?? 0) !== page.counts.arguments
      )
        bad("outline does not match counts");
      if (page.edges && reduction) {
        if (
          reduction.level < 3
            ? page.edges.length !== page.counts.edges
            : page.edges.length > page.counts.edges
        )
          bad("edges do not match counts");
        if (
          reduction.level >= 3 &&
          page.edges.some(
            (e) =>
              page.selectedId === null || (e.from !== page.selectedId && e.to !== page.selectedId)
          )
        )
          bad("a reduced edge list holds only the selected argument's edges");
      }
      if ((page.selected?.id ?? null) !== page.selectedId)
        bad("selected does not match selectedId");
      if (page.selectedId !== null && !page.outline?.some((entry) => entry.id === page.selectedId))
        bad("selectedId is not in the outline");
      if (reduction) {
        const short = reduction.level === 4;
        if (
          page.outline?.some(
            (e) =>
              (e.filled === undefined) !== short ||
              (e.warrantImplicit === undefined) !== short ||
              (e.sources === undefined) !== short
          )
        )
          bad("the outline's detail does not match the reduction level");
        if (reduction.level >= 2 !== (reduction.textLimit !== null))
          bad("textLimit is set exactly from level 2");
        if (
          reduction.level === 1 &&
          (reduction.truncated.length > 0 ||
            reduction.outlineOmitted > 0 ||
            reduction.sourcesOmitted > 0 ||
            reduction.auditTruncated)
        )
          bad("level 1 omits nothing more than the field text");
        if (
          reduction.level < 4 &&
          (reduction.outlineOmitted > 0 || reduction.sourcesOmitted > 0 || reduction.auditTruncated)
        )
          bad("only level 4 omits arguments, sources or audit entries");
        const limit = reduction.textLimit;
        if (limit && page.selected) {
          if (
            SELECTED_TEXTS.some((f) => (page.selected as Argument)[f].length > limit.field) ||
            page.selected.sources.some((s) => s.text.length > limit.source)
          )
            bad("selected is longer than the text limit");
        }
      }
    } else {
      if (page.outline !== null || page.edges !== null || page.selected !== null)
        bad("a whole page carries the graph only");
      if (page.reduction !== null) bad("a whole page left nothing out");
      if ((page.graph !== null) !== hasGraph)
        bad("graph is present exactly for ready and empty pages");
      if (
        page.graph &&
        (page.graph.arguments.length !== page.counts.arguments ||
          page.graph.edges.length !== page.counts.edges ||
          page.graph.rev !== page.rev)
      )
        bad("graph does not match counts");
      if (page.graph && page.graph.work_id !== page.work.id) bad("graph belongs to another Work");
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
const shortEntry = (a: Argument): ArgumentOutlineEntry => ({
  id: a.id,
  title: a.title,
  kind: a.kind,
});

// ---- Notes: the page explains itself (the system prompt stays short) ------------------------------------------------ //

/** Every form of every phase says why a Library page action is refused while the view is open. */
export const ARGUMENT_ACTIONS_NOTE =
  "Library page actions (filters, selecting a Work, the exploration) are unavailable while the argument graph view is open, so a Library action that is refused is refused for that reason";
/** Appended when the last refresh of the graph failed and the view still shows the graph it had. */
export const ARGUMENT_STALE_NOTE =
  "The last attempt to refresh the graph failed: it may be out of date.";
const READ_ONLY = "this is the Library tab showing one Work's argument graph, read-only";
const LATER =
  "The argument tools come with a later release: until then say which text you cannot see, never guess it.";

/** What a whole page says of itself. */
export const ARGUMENT_WHOLE_NOTE = `${READ_ONLY}: page.graph is the whole graph and selectedId the argument the user has open. ${ARGUMENT_ACTIONS_NOTE}.`;

const PHASE_NOTES: Record<"loading" | "not-found" | "corrupt" | "error", string> = {
  loading: "the argument graph of this Work is still loading; this page carries no graph yet",
  "not-found": "the Work was not found in the library, so there is no argument graph to show",
  corrupt:
    "the Work's argument graph file is damaged and cannot be read; this is an error, never an empty graph",
  error:
    "the argument graph could not be read (a server or network failure); this page carries no graph",
};

type Reducing = { text: { field: number; source: number } | null; edges: number | null };
const SHAPES: Record<1 | 2 | 3 | 4, Reducing> = {
  1: { text: null, edges: null },
  2: { text: { field: 4000, source: 500 }, edges: null },
  3: { text: { field: 4000, source: 500 }, edges: 300 },
  4: { text: { field: 1000, source: 200 }, edges: 100 },
};
const AUDIT_CAP = { ids: 30, cycles: 5, cycleIds: 20 } as const;

function levelText(level: 1 | 2 | 3 | 4): string {
  const text = SHAPES[level].text;
  const cut = text
    ? `selected is the selected argument with each field cut to ${text.field} characters and each source text to ${text.source} (reduction.truncated says which)`
    : "selected is the selected argument in full";
  const list = "outline lists every argument and which fields have text, edges every edge";
  if (level < 3)
    return `the field text of the other arguments is not in this page; ${cut}; ${list}.`;
  if (level === 3)
    return `the field text of the other arguments is not in this page; ${cut}; outline lists every argument and which fields have text; edges lists only the selected argument's edges (counts.edges is the total).`;
  return `the field text of the other arguments is not in this page; ${cut}; outline lists id, title and kind only, and not every argument if the page would be too long (reduction.outlineOmitted); edges lists only the selected argument's edges (counts.edges is the total); the audit's lists are capped (audit.total is the real number).`;
}

function partialNote(level: 1 | 2 | 3 | 4, heldRev: number | null, stale: boolean): string {
  const intro =
    heldRev === null
      ? `${READ_ONLY}. Partial: the whole graph is too large to carry,`
      : `${READ_ONLY}. The whole graph of revision ${heldRev} is in the task's context and is not repeated; this page is partial:`;
  const tail =
    heldRev === null ? LATER : "The held graph is the only copy of the text omitted here.";
  return `${intro} ${levelText(level)} ${tail} ${ARGUMENT_ACTIONS_NOTE}.${stale ? ` ${ARGUMENT_STALE_NOTE}` : ""}`;
}
/** The level-1 partial note, for the callers that only need to recognise one. */
export const ARGUMENT_PARTIAL_NOTE = partialNote(1, null, false);

// ---- Reduction ------------------------------------------------------------------------------------------------------- //

type WholePage = ArgumentPage & { graph: ArgumentGraph; audit: ArgumentAuditPage };
const size = (value: unknown): number => JSON.stringify(value).length;

/**
 * The graph's JSON length, or just over `cap` as soon as it is known to exceed it. A graph at the limits is hundreds of
 * megabytes, which `JSON.stringify` cannot even build as one string, so it is measured piece by piece.
 */
function graphLength(graph: ArgumentGraph, cap: number): number {
  let total = size({ ...graph, arguments: [], edges: [] });
  for (const a of graph.arguments) {
    total += size(a) + 1;
    if (total > cap) return cap + 1;
  }
  for (const e of graph.edges) {
    total += size(e) + 1;
    if (total > cap) return cap + 1;
  }
  return total;
}

/** Cut to `n` UTF-16 units without leaving half a surrogate pair. */
function cut(text: string, n: number): string {
  if (text.length <= n) return text;
  const last = text.charCodeAt(n - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? n - 1 : n);
}

function truncateArgument(
  a: Argument,
  limit: { field: number; source: number }
): { argument: Argument; truncated: string[] } {
  const truncated: string[] = [];
  const out: Argument = { ...a };
  for (const name of SELECTED_TEXTS)
    if (a[name].length > limit.field) {
      out[name] = cut(a[name], limit.field);
      truncated.push(name);
    }
  out.sources = a.sources.map((source, i) => {
    if (source.text.length <= limit.source) return source;
    truncated.push(`sources.${i}.text`);
    return { ...source, text: cut(source.text, limit.source) };
  });
  return { argument: out, truncated };
}

function capAudit(audit: ArgumentAuditPage): { audit: ArgumentAuditPage; capped: boolean } {
  const capped: ArgumentAuditPage = {
    ...audit,
    cycles: audit.cycles.slice(0, AUDIT_CAP.cycles).map((c) => c.slice(0, AUDIT_CAP.cycleIds)),
    noPathToEnd: audit.noPathToEnd.slice(0, AUDIT_CAP.ids),
    endWithOutEdge: audit.endWithOutEdge.slice(0, AUDIT_CAP.ids),
    nativeWithInEdge: audit.nativeWithInEdge.slice(0, AUDIT_CAP.ids),
    incomplete: audit.incomplete.slice(0, AUDIT_CAP.ids),
  };
  return { audit: capped, capped: size(capped) !== size(audit) };
}

/**
 * The reduced form of a whole page at `level`. `heldRev` set: the whole graph of that revision is already in the task's
 * context (a later observation), which the note says. The result is never longer than {@link ARGUMENT_PAGE_MAX}.
 */
function partialAt(page: WholePage, level: 1 | 2 | 3 | 4, heldRev: number | null): ArgumentPage {
  const graph = page.graph;
  const shape = SHAPES[level];
  const picked = graph.arguments.find((a) => a.id === page.selectedId) ?? null;
  let selected = picked;
  let truncated: string[] = [];
  if (picked && shape.text)
    ({ argument: selected, truncated } = truncateArgument(picked, shape.text));
  let edges =
    shape.edges === null
      ? graph.edges
      : picked
        ? graph.edges
            .filter((e) => e.from === picked.id || e.to === picked.id)
            .slice(0, shape.edges)
        : [];
  const { audit, capped } =
    level === 4 ? capAudit(page.audit) : { audit: page.audit, capped: false };
  const note = partialNote(level, heldRev, !!page.note?.includes(ARGUMENT_STALE_NOTE));
  const make = (outline: ArgumentOutlineEntry[], omittedSources: number): ArgumentPage => ({
    ...page,
    audit,
    partial: true,
    graph: null,
    outline,
    edges,
    selected:
      selected && omittedSources
        ? {
            ...selected,
            sources: selected.sources.slice(0, selected.sources.length - omittedSources),
          }
        : selected,
    reduction: {
      level,
      textLimit: shape.text,
      truncated,
      outlineOmitted: graph.arguments.length - outline.length,
      sourcesOmitted: omittedSources,
      auditTruncated: capped,
    },
    note,
  });
  if (level < 4) return make(graph.arguments.map(outlineEntry), 0);
  // Level 4 is the one that must fit whatever the graph is: the parts of the page that are not the outline come first,
  // then as many outline entries as the room left allows (the selected one always).
  let omittedSources = 0;
  let base = make([], 0);
  while (size(base) > ARGUMENT_PAGE_MAX - 64) {
    if (selected && selected.sources.length > omittedSources) omittedSources++;
    else if (edges.length) edges = edges.slice(0, -1);
    else break;
    base = make([], omittedSources);
  }
  let room = ARGUMENT_PAGE_MAX - size(base) - 64;
  const chosen = new Set<number>();
  const selectedAt = graph.arguments.findIndex((a) => a.id === page.selectedId);
  if (selectedAt >= 0) {
    chosen.add(selectedAt);
    room -= size(shortEntry(graph.arguments[selectedAt] as Argument)) + 1;
  }
  for (let i = 0; i < graph.arguments.length; i++) {
    if (chosen.has(i)) continue;
    const cost = size(shortEntry(graph.arguments[i] as Argument)) + 1;
    if (cost > room) break;
    room -= cost;
    chosen.add(i);
  }
  return make(
    [...chosen].sort((a, b) => a - b).map((i) => shortEntry(graph.arguments[i] as Argument)),
    omittedSources
  );
}

/**
 * The smallest reduction of `page` that is within {@link ARGUMENT_PAGE_MAX} and strictly shorter than `ceiling` (the
 * whole page, when that is itself within the ceiling), or null when none is.
 */
function smallestFit(
  page: WholePage,
  heldRev: number | null,
  ceiling: number
): ArgumentPage | null {
  for (const level of [1, 2, 3, 4] as const) {
    const candidate = partialAt(page, level, heldRev);
    const length = size(candidate);
    if (length <= ARGUMENT_PAGE_MAX && length < ceiling) return candidate;
  }
  return null;
}

/**
 * The page for what the view shows. A graph whose JSON is within {@link ARGUMENT_PAGE_FULL_MAX} goes whole, as does any
 * graph whose whole page fits {@link ARGUMENT_PAGE_MAX} and that no reduction makes shorter; every other graph goes as
 * the smallest reduction within the ceiling. Pure: the same input gives the same page.
 */
export function buildArgumentPage(input: {
  workId: string;
  title: string;
  phase: "loading" | "ready" | "not-found" | "corrupt" | "error";
  graph: ArgumentGraph | null;
  selectedId: string | null;
  /** The last refresh failed and `graph` is the one the view had before. */
  stale?: boolean;
}): ArgumentPage {
  const { graph } = input;
  const base = { work: { id: input.workId, title: input.title } };
  const stale = input.stale ? ` ${ARGUMENT_STALE_NOTE}` : "";
  if (!graph || input.phase !== "ready") {
    const phase = input.phase === "ready" ? "loading" : input.phase;
    return {
      ...base,
      phase,
      rev: null,
      counts: { arguments: 0, edges: 0 },
      audit: null,
      selectedId: null,
      partial: false,
      graph: null,
      outline: null,
      edges: null,
      selected: null,
      reduction: null,
      note: `${PHASE_NOTES[phase]}. ${ARGUMENT_ACTIONS_NOTE}.`,
    };
  }
  const selectedId = graph.arguments.some((a) => a.id === input.selectedId)
    ? input.selectedId
    : null;
  const whole: WholePage = {
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
    reduction: null,
    note: `${ARGUMENT_WHOLE_NOTE}${stale}`,
  };
  const measured = graphLength(graph, ARGUMENT_PAGE_MAX);
  // A graph longer than the ceiling cannot make a whole page that fits; no need to measure the page then.
  const wholeLength = measured > ARGUMENT_PAGE_MAX ? Number.POSITIVE_INFINITY : size(whole);
  if (measured <= ARGUMENT_PAGE_FULL_MAX && wholeLength <= ARGUMENT_PAGE_MAX) return whole;
  const reduced = whole.phase === "ready" ? smallestFit(whole, null, wholeLength) : null;
  return reduced ?? (wholeLength <= ARGUMENT_PAGE_MAX ? whole : partialAt(whole, 4, null));
}

/** The key under which a task's context holds a whole graph at a revision (like a Reader's reading key). */
export const argumentKey = (workId: string, rev: number): string => `argument:${rev}:${workId}`;

/**
 * A page as a later observation shows it. A whole graph the task's context already holds (same Work and revision) is not
 * repeated: the observation is a reduced form, which still carries the selection with the selected argument, so clicking
 * through arguments does not resend the graph. Only a ready page is reduced (an empty one has nothing to list), and never
 * into something longer than the whole page it replaces. A graph the task's context does not hold stays whole.
 */
export function observationArgumentPage<T extends { argument?: ArgumentPage | null }>(
  source: T,
  held: ReadonlySet<string> = new Set()
): T {
  const page = source.argument;
  if (
    !page ||
    page.partial ||
    page.phase !== "ready" ||
    !page.graph ||
    !held.has(argumentKey(page.work.id, page.graph.rev))
  )
    return source;
  const reduced = smallestFit(page as WholePage, page.graph.rev, size(page));
  return reduced ? { ...source, argument: reduced } : source;
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
    /** The selected argument's short title (what the user sees; the id is not). */
    selectedTitle: z.string().max(ARGUMENT_GRAPH_LIMITS.titleChars).nullable().optional(),
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
    selectedTitle:
      page.selectedId === null
        ? null
        : (page.graph?.arguments.find((a) => a.id === page.selectedId)?.title ??
          page.selected?.title ??
          page.outline?.find((e) => e.id === page.selectedId)?.title ??
          null),
    partial: page.partial,
  };
}
