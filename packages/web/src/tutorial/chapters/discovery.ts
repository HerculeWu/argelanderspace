import { SAMPLE_SEED_BIBCODE, SAMPLE_WORK_IDS } from "../sample-ids";
import type { ChapterDefinition, Requirement, WorkbenchSnapshot } from "../types";

/** The anchors of chapter 4, constants checked by the static anchor test. */
const LIBRARY_GRAPH_AREA = { ui: "library-graph-area" } as const;
/** The library's own graph (the exploration page draws another canvas). */
const LIBRARY_GRAPH = { ui: "graph-canvas", within: LIBRARY_GRAPH_AREA } as const;
const ROSER_ROW = { ui: "work-item", key: SAMPLE_WORK_IDS.roser2019 } as const;
/** The explore button of Röser's own detail (another Work's detail has the same button). */
const EXPLORE_FROM_ROSER = { ui: "explore-from-work", within: { ui: "work-detail", key: SAMPLE_WORK_IDS.roser2019 } } as const;
const DISCOVERY_VIEW = { ui: "discovery-view" } as const;
const DISCOVERY_RESULTS = { ui: "discovery-results" } as const;
const SHOW_GRAPH = { ui: "show-discovery-graph" } as const;
/** The exploration's graph: the canvas inside the exploration page's main area. */
const DISCOVERY_GRAPH = { ui: "graph-canvas", within: { ui: "discovery-main" } } as const;
const DISCOVERY_DETAIL = { ui: "discovery-detail" } as const;
const RETURN_TO_LIBRARY = { ui: "return-to-library" } as const;
/** The library toolbar's "Resume exploration": shown only once the exploration was left. */
const RESUME_EXPLORATION = { ui: "resume-exploration" } as const;

/** Every step of the chapter is on the library tab (the exploration replaces the library page inside it). */
const ON_LIBRARY: Requirement = {
  test: (s) => s.page.view === "library",
  where: "library",
  takeMeThere: { action: "switch_view", view: "library" },
};

const exploration = (s: WorkbenchSnapshot) => (s.page.view === "library" ? (s.page.discovery ?? null) : null);
/**
 * The exploration has real results: its graph loaded. Without an ADS token (or on any other failure) the page shows the
 * product's own error and no graph, and nothing here passes: the steps that need results are skipped.
 */
const withResults = (s: WorkbenchSnapshot) => {
  const page = exploration(s);
  return page?.graph ? page : null;
};

/**
 * Chapter 4, "discovery" (appendix A; revised by the user 2026-10-21: the sample ships no ADS cache): from Röser 2019,
 * with the user's own ADS token. Results are live and change over time, so no gate names a node or a count. Without a
 * token the explore request fails, the page shows the product's own error, and the steps that need results are skipped
 * (the tutorial does nothing special and never pretends there are results).
 */
export const DISCOVERY: ChapterDefinition = {
  id: "discovery",
  n: 4,
  steps: [
    {
      id: "discovery.library-graph",
      kind: "look",
      anchors: [LIBRARY_GRAPH_AREA, LIBRARY_GRAPH],
      requires: ON_LIBRARY,
    },
    {
      id: "discovery.start",
      kind: "do",
      anchors: [ROSER_ROW, EXPLORE_FROM_ROSER, DISCOVERY_VIEW],
      // The exploration from Röser has its graph: a failed request (no token) shows no graph and does not pass.
      gate: (s) => withResults(s)?.graph?.seed === SAMPLE_SEED_BIBCODE,
      requires: ON_LIBRARY,
    },
    {
      id: "discovery.roles",
      kind: "look",
      anchors: [RESUME_EXPLORATION, DISCOVERY_RESULTS],
      requires: ON_LIBRARY,
    },
    {
      id: "discovery.graph",
      kind: "do",
      anchors: [RESUME_EXPLORATION, SHOW_GRAPH, DISCOVERY_GRAPH],
      // The display alone is not enough: a failed exploration also reports the (default) graph display.
      gate: (s) => withResults(s)?.display === "graph",
      requires: ON_LIBRARY,
    },
    {
      id: "discovery.detail",
      kind: "do",
      // The result list in both displays (its rows open a candidate, as the graph's nodes do), then the candidate's detail.
      anchors: [RESUME_EXPLORATION, DISCOVERY_RESULTS, DISCOVERY_DETAIL],
      // A candidate, not the seed: a new exploration opens with the seed itself selected (its detail already shown).
      gate: (s) => {
        const page = withResults(s);
        return Boolean(page?.selectedBibcode) && page?.selectedBibcode !== page?.graph?.seed;
      },
      requires: ON_LIBRARY,
    },
    {
      id: "discovery.back",
      kind: "look",
      anchors: [RETURN_TO_LIBRARY, RESUME_EXPLORATION],
      requires: ON_LIBRARY,
    },
    {
      id: "discovery.agent",
      kind: "agent",
      anchors: [],
    },
  ],
};
