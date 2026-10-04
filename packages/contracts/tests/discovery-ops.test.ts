import { describe, expect, it } from "vitest";
import {
  DISCOVERY_VIEW_ACTIONS,
  type DiscoveryPage,
  DiscoveryPageSchema,
  DiscoverySavedViewActionSchema,
  discoveryActionNeedsExploration,
  discoveryActionOpensLibrary,
  discoveryReachableBibcodes,
  discoveryVisibleNodes,
  LIBRARY_OPERATION_ACTIONS,
  LibraryReadDiscoverySchema,
  LibrarySaveCandidateSchema,
  LibraryViewActionSchema,
  PageContextSchema,
  summarizeDiscoveryPage,
  WsCopilotViewActionSchema,
} from "../src/index.js";

const paper = (bibcode: string, roles: ("seed" | "related" | "useful")[], title = bibcode) => ({
  bibcode,
  title,
  authors: ["Doe, J."],
  year: 2020,
  venue: null,
  abstract: null,
  citationCount: null,
  doi: null,
  arxivId: null,
  roles,
  libraryId: null,
});
const page = (over: Partial<DiscoveryPage> = {}): DiscoveryPage => ({
  history: { index: 0, seeds: ["S"] },
  graph: {
    provider: "ads",
    seed: "S",
    filter: "all",
    query: "",
    nodes: [paper("S", ["seed"]), paper("R", ["related"])],
    edges: [{ from: "S", to: "R", kind: "citation" }],
    totals: { nodes: 2, related: 1, useful: 0, saved: 0 },
    warnings: [],
    empty: false,
  },
  display: "graph",
  selectedBibcode: null,
  detail: null,
  loading: null,
  error: null,
  saving: { adding: null, failed: null },
  graphView: { labelsOn: false },
  ...over,
});
const context = (over: Record<string, unknown>) => ({
  version: 1,
  viewId: "7b1e9a74-0f43-4b9a-9d58-9f4a3f2f8c11",
  revision: 1,
  paneId: 1,
  view: "library",
  otherPanes: [],
  plan: null,
  ...over,
});

describe("Discovery page context", () => {
  it("accepts a shown exploration as complete and rejects a graph-less one as complete", () => {
    expect(
      PageContextSchema.safeParse(context({ status: "complete", library: null, discovery: page() }))
        .success
    ).toBe(true);
    expect(
      PageContextSchema.safeParse(
        context({
          status: "complete",
          library: null,
          discovery: page({ graph: null, loading: { seed: "S" } }),
        })
      ).success
    ).toBe(false);
    expect(
      PageContextSchema.safeParse(
        context({
          status: "unavailable",
          library: null,
          discovery: page({ graph: null, loading: { seed: "S" } }),
        })
      ).success
    ).toBe(true);
    expect(
      PageContextSchema.safeParse(
        context({
          status: "error",
          library: null,
          discovery: page({ graph: null, error: { seed: "S", status: 503 } }),
        })
      ).success
    ).toBe(true);
    // a complete graph is not "unavailable" either
    expect(
      PageContextSchema.safeParse(
        context({ status: "unavailable", library: null, discovery: page() })
      ).success
    ).toBe(false);
  });

  it("is closed: unknown keys and invalid edge kinds are rejected", () => {
    expect(DiscoveryPageSchema.safeParse({ ...page(), extra: 1 }).success).toBe(false);
    const bad = JSON.parse(JSON.stringify(page()));
    bad.graph.edges[0].kind = "similar";
    expect(DiscoveryPageSchema.safeParse(bad).success).toBe(false);
  });

  it("summarizes state, seed and counts for the message record", () => {
    expect(summarizeDiscoveryPage(page())).toEqual({
      state: "ready",
      seed: "S",
      filter: "all",
      shown: 2,
      total: 2,
      selectedBibcode: null,
    });
    expect(
      summarizeDiscoveryPage(page({ graph: null, error: { seed: "T", status: 0 } }))
    ).toMatchObject({ state: "error", seed: "T", shown: 0 });
    expect(summarizeDiscoveryPage(page({ loading: { seed: "T" } })).state).toBe("loading");
    // a failed request over a shown graph is an error, not "ready"
    expect(summarizeDiscoveryPage(page({ error: { seed: "T", status: 502 } }))).toMatchObject({
      state: "error",
      seed: "S",
      shown: 2,
    });
  });

  it("the filter always keeps the seed and uses title/authors/year/bibcode for search", () => {
    const nodes = [
      paper("S", ["seed"], "Origin"),
      paper("A", ["related"], "Alpha stars"),
      paper("B", ["useful"], "Beta methods"),
    ];
    expect(discoveryVisibleNodes(nodes, "", "useful").map((n) => n.bibcode)).toEqual(["S", "B"]);
    expect(discoveryVisibleNodes(nodes, "alpha", "all").map((n) => n.bibcode)).toEqual(["S", "A"]);
    expect(discoveryVisibleNodes(nodes, "2020", "related").map((n) => n.bibcode)).toEqual([
      "S",
      "A",
    ]);
  });
});

describe("what a control may name", () => {
  it("is the visible nodes, the open candidate and its in-graph citations; nothing else", () => {
    const shown = page();
    expect([...discoveryReachableBibcodes(shown)].sort()).toEqual(["R", "S"]);
    const open = page({
      detail: {
        paper: paper("H", ["related"]),
        tab: "citations",
        references: ["X"],
        citedBy: ["Y"],
      },
    });
    expect([...discoveryReachableBibcodes(open)].sort()).toEqual(["H", "R", "S", "X", "Y"]);
    expect(discoveryReachableBibcodes(page({ graph: null })).size).toBe(0);
  });
  it("the page's nodes carry no abstract; only the open candidate's detail does", () => {
    const withAbstract = page();
    (withAbstract.graph?.nodes[0] as unknown as { abstract: string }).abstract = "x";
    const parsed = DiscoveryPageSchema.parse(withAbstract);
    expect(parsed.graph?.nodes[0]).not.toHaveProperty("abstract");
  });
  it("a history longer than the report limit is refused by the schema", () => {
    expect(
      DiscoveryPageSchema.safeParse(
        page({ history: { index: 0, seeds: Array.from({ length: 1001 }, (_, i) => `S${i}`) } })
      ).success
    ).toBe(false);
  });
  it("retry_exploration names its target: failed or current", () => {
    expect(
      LibraryViewActionSchema.safeParse({ action: "retry_exploration", target: "current" }).success
    ).toBe(true);
    expect(
      LibraryViewActionSchema.safeParse({ action: "retry_exploration", target: "useful" }).success
    ).toBe(false);
  });
});

describe("Discovery operations", () => {
  const viewActions: { action: string; [key: string]: unknown }[] = [
    { action: "explore_work", refId: "doi:10.1/x" },
    { action: "explore_candidate", bibcode: "2020A" },
    { action: "retry_exploration" },
    { action: "cancel_exploration" },
    { action: "step_exploration", direction: "back" },
    { action: "exit_exploration" },
    { action: "resume_exploration" },
    { action: "filter_discovery", filter: "useful" },
    { action: "search_discovery", query: "" },
    { action: "set_discovery_display", display: "list" },
    { action: "select_candidate", bibcode: null },
    { action: "set_discovery_tab", tab: "citations" },
    { action: "dismiss_discovery_error" },
    { action: "view_candidate_in_library", bibcode: "2020A" },
    { action: "set_discovery_graph_labels", on: true },
    { action: "discovery_graph_control", control: "focus_seed" },
  ];
  it("every explore control is a closed view action, and the action list names them all", () => {
    expect(viewActions.map((a) => a.action).sort()).toEqual([...DISCOVERY_VIEW_ACTIONS].sort());
    for (const action of viewActions) {
      expect(LibraryViewActionSchema.safeParse(action).success, String(action.action)).toBe(true);
      expect(LIBRARY_OPERATION_ACTIONS).toContain(action.action);
      expect(LibraryViewActionSchema.safeParse({ ...action, extra: 1 }).success).toBe(false);
    }
    expect(
      LibraryViewActionSchema.safeParse({ action: "step_exploration", direction: "sideways" })
        .success
    ).toBe(false);
    expect(
      LibraryViewActionSchema.safeParse({ action: "filter_discovery", filter: "foundation" })
        .success
    ).toBe(false);
    expect(
      LibraryViewActionSchema.safeParse({ action: "discovery_graph_control", control: "pan" })
        .success
    ).toBe(false);
    // the graph's own buttons of the Library tool still refuse the Discovery-only jump
    expect(
      LibraryViewActionSchema.safeParse({ action: "graph_control", control: "focus_seed" }).success
    ).toBe(false);
  });

  it("only the entry actions open the Library page; the controls need an open exploration", () => {
    expect(viewActions.filter(discoveryActionOpensLibrary).map((a) => a.action)).toEqual([
      "explore_work",
      "resume_exploration",
    ]);
    expect(viewActions.filter(discoveryActionNeedsExploration)).toHaveLength(14);
    expect(discoveryActionNeedsExploration({ action: "set_sidebar" })).toBe(false);
  });

  it("the candidate save and the exploration read take no free-form target", () => {
    expect(
      LibrarySaveCandidateSchema.safeParse({ action: "save_candidate", bibcode: "2020A" }).success
    ).toBe(true);
    for (const bad of [
      { action: "save_candidate" },
      { action: "save_candidate", bibcode: "" },
      { action: "save_candidate", bibcode: "x", doi: "10.1/a" },
      { action: "save_candidate", bibcode: "x", path: "/etc" },
    ])
      expect(LibrarySaveCandidateSchema.safeParse(bad).success).toBe(false);
    expect(LibraryReadDiscoverySchema.safeParse({ action: "read_discovery" }).success).toBe(true);
    expect(
      LibraryReadDiscoverySchema.safeParse({ action: "read_discovery", bibcode: "x" }).success
    ).toBe(false);
    expect(LIBRARY_OPERATION_ACTIONS).toEqual(
      expect.arrayContaining(["read_discovery", "save_candidate"])
    );
  });

  it("discovery_saved is the service's own sync: never a tool action, but deliverable to the bound view", () => {
    const sync = { action: "discovery_saved", bibcode: "2020A", workId: "doi:10.1/x" };
    expect(DiscoverySavedViewActionSchema.safeParse(sync).success).toBe(true);
    expect(LibraryViewActionSchema.safeParse(sync).success).toBe(false);
    expect(LIBRARY_OPERATION_ACTIONS).not.toContain("discovery_saved");
    expect(
      WsCopilotViewActionSchema.safeParse({
        type: "copilot.view-action",
        viewId: "7b1e9a74-0f43-4b9a-9d58-9f4a3f2f8c11",
        actionId: "9a1b3c5d-1f2e-4a3b-8c4d-5e6f7a8b9c0d",
        action: sync,
      }).success
    ).toBe(true);
  });
});
