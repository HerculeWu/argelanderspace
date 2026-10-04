/**
 * Discovery (explore mode) page context and operations for the Copilot `library` tool (copilot ticket 17).
 *
 * Discovery is a temporary, read-only, browser-side state (docs/discovery.md): the service keeps no session. So
 *  - what the model sees is `DiscoveryPage`, published by the bound view exactly as it shows it (the filtered nodes
 *    and the real citation edges among them, the open candidate, the history, the loading/error state);
 *  - every control of the explore UI is a bound-view action below, executed by that view through the same
 *    callbacks as the click (no new query semantics, no hops of its own);
 *  - the only durable write, "Add to library", is the server-side `save_candidate`, which uses the page's own
 *    `POST /api/library/works {mode: "bibcode"}` handler and then tells the view to mark the node saved in place.
 */
import { z } from "zod";
import { DiscoveryEdgeSchema, DiscoveryPaperSchema, DiscoveryWarningSchema } from "./discovery.js";

export const DISCOVERY_FILTERS = ["all", "related", "useful"] as const;
export const DISCOVERY_DISPLAYS = ["graph", "list"] as const;
export const DISCOVERY_DETAIL_TABS = ["abstract", "citations"] as const;
/** The graph's discrete buttons; the Discovery graph also has the "jump to origin" target button. */
export const DISCOVERY_GRAPH_CONTROLS = [
  "zoom_in",
  "zoom_out",
  "fit",
  "relayout",
  "focus_seed",
] as const;
export type DiscoveryFilter = (typeof DISCOVERY_FILTERS)[number];

const Bibcode = z.string().min(1).max(200);

/** A node as the page's list/graph shows it; the abstract is only shown in the open candidate's inspector (`detail`). */
export const DiscoveryNodeSchema = DiscoveryPaperSchema.omit({ abstract: true });
/** The most seeds one page report carries (the front end keeps the newest ones). */
export const DISCOVERY_HISTORY_LIMIT = 1000;

/** What the explore page shows right now (the content of the filtered result, not of the mounted rows). */
export const DiscoveryPageSchema = z
  .object({
    /** Back/Forward over the successful seed transitions of this tab: index of the shown one among `seeds`. */
    history: z
      .object({
        index: z.number().int().min(-1),
        seeds: z.array(z.string()).max(DISCOVERY_HISTORY_LIMIT),
      })
      .strict(),
    /** The graph of the current session; null until the first successful exploration (loading or failed). */
    graph: z
      .object({
        provider: z.literal("ads"),
        seed: z.string(),
        filter: z.enum(DISCOVERY_FILTERS),
        query: z.string(),
        /** The nodes the filter and search leave visible, the seed always included, in graph order. */
        nodes: z.array(DiscoveryNodeSchema),
        /** Real citation edges (citing → cited) between the visible nodes only. */
        edges: z.array(DiscoveryEdgeSchema),
        /** Counts of the whole session graph before filtering. */
        totals: z
          .object({
            nodes: z.number().int().nonnegative(),
            related: z.number().int().nonnegative(),
            useful: z.number().int().nonnegative(),
            saved: z.number().int().nonnegative(),
          })
          .strict(),
        warnings: z.array(DiscoveryWarningSchema),
        /** The seed alone: ADS returned nothing related (the page shows its empty state, not a graph). */
        empty: z.boolean(),
      })
      .strict()
      .nullable(),
    display: z.enum(DISCOVERY_DISPLAYS),
    selectedBibcode: z.string().nullable(),
    /** The open candidate in full (abstract included) with its in-graph citations, as the inspector shows it. */
    detail: z
      .object({
        paper: DiscoveryPaperSchema,
        tab: z.enum(DISCOVERY_DETAIL_TABS),
        /** In-graph references (this → cited), as bibcodes of the whole session graph. */
        references: z.array(z.string()),
        citedBy: z.array(z.string()),
      })
      .strict()
      .nullable(),
    /** A request is in flight (an earlier graph, if any, stays shown under it). */
    loading: z.object({ seed: z.string() }).strict().nullable(),
    /** The last failed request (status 0 = network failure); an earlier graph, if any, stays shown. */
    error: z
      .object({ seed: z.string(), status: z.number().int().min(0) })
      .strict()
      .nullable(),
    /** "Add to library" progress: the candidate being saved and the one whose last save failed. */
    saving: z.object({ adding: z.string().nullable(), failed: z.string().nullable() }).strict(),
    graphView: z.object({ labelsOn: z.boolean() }).strict(),
  })
  .strict();
export type DiscoveryPage = z.infer<typeof DiscoveryPageSchema>;

/**
 * The candidates a control may name: what the page lets the user reach, i.e. the visible nodes, the open candidate and
 * the nodes its inspector lists as references or citing papers. `save_candidate`, `explore_candidate`,
 * `select_candidate` and `view_candidate_in_library` all use exactly this set.
 */
export function discoveryReachableBibcodes(page: DiscoveryPage): Set<string> {
  const reachable = new Set<string>();
  for (const node of page.graph?.nodes ?? []) reachable.add(node.bibcode);
  if (page.detail) {
    reachable.add(page.detail.paper.bibcode);
    for (const code of [...page.detail.references, ...page.detail.citedBy]) reachable.add(code);
  }
  return reachable;
}

/** What a message records of the exploration it carried. */
export const DiscoveryContextSummarySchema = z
  .object({
    state: z.enum(["ready", "loading", "error"]),
    seed: z.string().nullable(),
    filter: z.enum(DISCOVERY_FILTERS),
    shown: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    selectedBibcode: z.string().nullable(),
  })
  .strict();
export type DiscoveryContextSummary = z.infer<typeof DiscoveryContextSummarySchema>;
export function summarizeDiscoveryPage(page: DiscoveryPage): DiscoveryContextSummary {
  return {
    state: page.loading ? "loading" : page.error ? "error" : page.graph ? "ready" : "loading",
    seed: page.graph?.seed ?? page.loading?.seed ?? page.error?.seed ?? null,
    filter: page.graph?.filter ?? "all",
    shown: page.graph?.nodes.length ?? 0,
    total: page.graph?.totals.nodes ?? 0,
    selectedBibcode: page.selectedBibcode,
  };
}

/** The explore search box's own predicate (title, authors, year, bibcode; case-insensitive substring). */
export function discoveryPaperMatches(
  paper: { title: string; authors: string[]; year: number | null; bibcode: string },
  query: string
): boolean {
  if (!query) return true;
  const haystack = `${paper.title} ${paper.authors.join(" ")} ${paper.year ?? ""} ${paper.bibcode}`;
  return haystack.toLowerCase().includes(query.toLowerCase());
}

/** The nodes the page shows for a filter and search: the seed always, the rest by role and text. */
export function discoveryVisibleNodes<
  T extends {
    roles: string[];
    title: string;
    authors: string[];
    year: number | null;
    bibcode: string;
  },
>(nodes: readonly T[], query: string, filter: DiscoveryFilter): T[] {
  return nodes.filter(
    (node) =>
      node.roles.includes("seed") ||
      (discoveryPaperMatches(node, query) && (filter === "all" || node.roles.includes(filter)))
  );
}

/**
 * The explore UI's controls as view actions. Each one is executed by the bound view with the callback the control
 * itself calls; an action whose control is absent or disabled right now answers `unavailable`/`disabled`.
 */
export const DiscoveryViewActionSchemas = [
  /** The work detail's "explore related papers" button (needs a live library and a work with an ADS bibcode). */
  z.object({ action: z.literal("explore_work"), refId: z.string().min(1).max(500) }).strict(),
  /** The candidate inspector's "Explore from here": the only way to change the seed (clicking a node never does). */
  z.object({ action: z.literal("explore_candidate"), bibcode: Bibcode }).strict(),
  /** The Retry buttons: the same full request for the same seed (there is no useful-only request). */
  z
    .object({
      action: z.literal("retry_exploration"),
      /**
       * failed: the error banner's Retry (the seed that failed). current: the useful-unavailable note's and the empty
       * state's Retry (the seed shown). Omitted: failed when a request failed, else current.
       */
      target: z.enum(["failed", "current"]).optional(),
    })
    .strict(),
  /** The loading overlay's Cancel (a real abort). */
  z.object({ action: z.literal("cancel_exploration") }).strict(),
  /** The header's previous/next arrows over the seed history. */
  z
    .object({ action: z.literal("step_exploration"), direction: z.enum(["back", "forward"]) })
    .strict(),
  /** The header's "back to library". */
  z.object({ action: z.literal("exit_exploration") }).strict(),
  /** The Library toolbar's "resume exploration" (only while this tab has an exploration history). */
  z.object({ action: z.literal("resume_exploration") }).strict(),
  z.object({ action: z.literal("filter_discovery"), filter: z.enum(DISCOVERY_FILTERS) }).strict(),
  /** The explore search box (empty clears it). */
  z.object({ action: z.literal("search_discovery"), query: z.string().max(500) }).strict(),
  z
    .object({ action: z.literal("set_discovery_display"), display: z.enum(DISCOVERY_DISPLAYS) })
    .strict(),
  /** A result row, graph node, seed card or citation row; null closes the inspector. Never changes the seed. */
  z.object({ action: z.literal("select_candidate"), bibcode: Bibcode.nullable() }).strict(),
  z.object({ action: z.literal("set_discovery_tab"), tab: z.enum(DISCOVERY_DETAIL_TABS) }).strict(),
  z.object({ action: z.literal("dismiss_discovery_error") }).strict(),
  /** The inspector's "in library" button: leaves exploration and selects the saved work. */
  z.object({ action: z.literal("view_candidate_in_library"), bibcode: Bibcode }).strict(),
  z.object({ action: z.literal("set_discovery_graph_labels"), on: z.boolean() }).strict(),
  z
    .object({
      action: z.literal("discovery_graph_control"),
      control: z.enum(DISCOVERY_GRAPH_CONTROLS),
    })
    .strict(),
] as const;
export type DiscoveryViewAction = z.infer<(typeof DiscoveryViewActionSchemas)[number]>;
export const DISCOVERY_VIEW_ACTIONS: string[] = DiscoveryViewActionSchemas.map(
  (schema) => schema.shape.action.value
);

/** Actions that open the Library page first when it is not shown (the others only act on an open exploration). */
export function discoveryActionOpensLibrary(action: { action: string }): boolean {
  return action.action === "explore_work" || action.action === "resume_exploration";
}

export function isDiscoveryViewAction(action: { action: string }): action is DiscoveryViewAction {
  return DISCOVERY_VIEW_ACTIONS.includes(action.action);
}

/** The controls that only exist inside an open exploration (they never open the Library page themselves). */
export function discoveryActionNeedsExploration(action: { action: string }): boolean {
  return DISCOVERY_VIEW_ACTIONS.includes(action.action) && !discoveryActionOpensLibrary(action);
}

/**
 * Sent by the service (never callable by the model) to the bound view after the tool saved a candidate, so the view
 * marks that node saved in place exactly as its own "Add to library" does: no re-query, no new graph, selection,
 * viewport and seed untouched. A view that is not exploring (or does not hold the node) ignores it.
 */
export const DiscoverySavedViewActionSchema = z
  .object({
    action: z.literal("discovery_saved"),
    bibcode: Bibcode,
    workId: z.string().min(1).max(500),
  })
  .strict();
export type DiscoverySavedViewAction = z.infer<typeof DiscoverySavedViewActionSchema>;

/** `read_discovery`: the exploration the bound view last reported (there is no service-side session to read). */
export const LibraryReadDiscoverySchema = z
  .object({ action: z.literal("read_discovery") })
  .strict();

/**
 * The explore UI's "Add to library" for one candidate of the open exploration: the page's own bibcode import
 * (`POST /api/library/works`), nothing else. The candidate must be a node of the exploration the bound view shows.
 */
export const LibrarySaveCandidateSchema = z
  .object({ action: z.literal("save_candidate"), bibcode: Bibcode })
  .strict();
export type LibrarySaveCandidate = z.infer<typeof LibrarySaveCandidateSchema>;
