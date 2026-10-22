/**
 * Discovery (explore mode) for Copilot (ticket 17): the page the assistant sees is built from the exploration's own
 * state, and every bound-view action drives the same state and requests the controls do. The real Shell, LibraryView
 * and ExploreMode are rendered; only the Copilot panel, the WebSocket and the canvas drawing are replaced.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import {
  type CopilotViewAction,
  type DiscoveryGraph,
  type DiscoveryPaper,
  type PageContext,
  PageContextSchema,
} from "@argelanderspace/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import type { LibraryData, LibraryRef } from "../src/library/types";
import { installShellHarness } from "./shell-harness";

const h = vi.hoisted(() => ({
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string; http?: number }>),
  context: null as null | PageContext,
  seen: [] as PageContext[],
}));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs({ onArgumentGraphChanged: () => () => {} }));
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));
const g = vi.hoisted(() => ({ calls: [] as string[], labelsOn: [] as boolean[] }));
vi.mock("../src/graph/GraphCanvas", async () => {
  const { useEffect } = await import("react");
  return {
    GraphCanvas: ({ onController, labelsOn }: { onController?: (c: unknown) => void; labelsOn?: boolean }) => {
      useEffect(() => {
        onController?.({
          zoomIn: () => g.calls.push("zoom_in"),
          zoomOut: () => g.calls.push("zoom_out"),
          fit: () => g.calls.push("fit"),
          relayout: () => g.calls.push("relayout"),
          focusSeed: () => g.calls.push("focus_seed"),
        });
        return () => onController?.(null);
      }, [onController]);
      g.labelsOn.push(!!labelsOn);
      return <div data-ui="graph-stub" data-labels={String(labelsOn)} />;
    },
  };
});

const paper = (bibcode: string, over: Partial<DiscoveryPaper> = {}): DiscoveryPaper => ({
  bibcode,
  title: `Title of ${bibcode}`,
  authors: ["Doe, J.", "Roe, K."],
  year: 2020,
  venue: "MNRAS",
  abstract: `Abstract of ${bibcode}`,
  citationCount: 10,
  doi: null,
  arxivId: null,
  roles: ["related"],
  libraryId: null,
  ...over,
});
/** seed S; related R1 R2; useful-only U1; edges S→R1, R1→U1, R2→U1 (real citations only). */
const graphFor = (seed: string): DiscoveryGraph => ({
  version: 1,
  provider: "ads",
  seed,
  nodes: [
    paper(seed, { roles: ["seed"], title: `Seed ${seed}` }),
    paper(`${seed}.R1`, { relatedRank: 1, title: "Alpha stars" }),
    paper(`${seed}.R2`, { relatedRank: 2, title: "Beta galaxies" }),
    paper(`${seed}.U1`, { roles: ["useful"], usefulRank: 1, title: "Gamma methods" }),
  ],
  edges: [
    { from: seed, to: `${seed}.R1`, kind: "citation" },
    { from: `${seed}.R1`, to: `${seed}.U1`, kind: "citation" },
    { from: `${seed}.R2`, to: `${seed}.U1`, kind: "citation" },
  ],
  warnings: [],
});

const ref = (n: number, over: Partial<LibraryRef> = {}): LibraryRef => ({
  id: `doi:10.1000/p${n}`,
  title: `Paper ${n}`,
  authors: `Author${n}, Co`,
  year: 2001,
  venue: "MNRAS",
  type: "article",
  cite: `author${n}`,
  tags: [],
  pdf: false,
  read: false,
  star: false,
  ...over,
});
let data: LibraryData;
let discoveryGets: string[];
let writes: { url: string; method: string; body?: unknown }[];
let answer: (seed: string, signal?: AbortSignal | null) => Promise<Response>;
let libraryLive: boolean;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;
const failing = (status: number) => ({ ok: false, status, json: async () => ({ detail: "x" }) }) as unknown as Response;

installShellHarness({
  routes: (url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "/api/plans") return ok({ version: 1, rev: 1, plans: [] });
    if (url === "/api/library") {
      if (!libraryLive) throw new TypeError("network down");
      return ok(data);
    }
    if (url.startsWith("/api/library/discovery?bibcode=")) {
      const seed = decodeURIComponent(url.split("=")[1]!);
      discoveryGets.push(seed);
      return answer(seed, init?.signal);
    }
    if (url === "/api/library/works" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { bibcode: string };
      return ok({ results: [{ status: "created", ref: ref(9, { id: `bibcode:${body.bibcode}`, bibcode: body.bibcode }) }] });
    }
    return null;
  },
});
beforeEach(() => {
  const refs = [ref(1, { bibcode: "SEED1" }), ref(2), ref(3, { bibcode: "SEED3" })];
  data = {
    project: { name: "P" },
    refs,
    tags: [],
    graph: { version: 2, nodes: refs.map((r) => ({ id: r.id, ref: r.id, y: 2001, c: 1, a: r.authors, v: "MNRAS", t: r.title })), links: [] },
  };
  discoveryGets = [];
  writes = [];
  libraryLive = true;
  answer = async (seed) => ok(graphFor(seed));
  g.calls = [];
  g.labelsOn = [];
  h.viewAction = null;
  h.context = null;
  h.seen = [];
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const run = async (action: CopilotViewAction | Record<string, unknown>) => h.viewAction!(action);
const disc = () => h.context!.discovery!;
async function boot() {
  render(<Shell />);
  await waitFor(() => expect(h.viewAction).not.toBeNull());
  expect(await run({ action: "switch_view", view: "library" })).toEqual({ ok: true });
  await waitFor(() => expect(h.context?.library?.refs.length).toBe(3));
}
async function explore() {
  await boot();
  expect(await run({ action: "explore_work", refId: "doi:10.1000/p1" })).toEqual({ ok: true });
  await waitFor(() => expect(h.context?.discovery?.graph?.seed).toBe("SEED1"));
}

describe("entering an exploration", () => {
  it("shows seed, related and useful nodes with only real citation edges, and is a valid complete context", async () => {
    await explore();
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    await waitFor(() => expect(h.context!.status).toBe("complete"));
    await waitFor(() => expect(h.context!.library ?? null).toBeNull()); // the exploration replaces the Library page
    const graph = disc().graph!;
    expect(graph.nodes.map((n) => [n.bibcode, n.roles, n.relatedRank, n.usefulRank])).toEqual([
      ["SEED1", ["seed"], undefined, undefined],
      ["SEED1.R1", ["related"], 1, undefined],
      ["SEED1.R2", ["related"], 2, undefined],
      ["SEED1.U1", ["useful"], undefined, 1],
    ]);
    expect(graph.edges).toEqual(graphFor("SEED1").edges);
    expect(graph.totals).toEqual({ nodes: 4, related: 2, useful: 1, saved: 0 });
    // the DOM rows are the same set (the seed is the card, not a row)
    expect(qa('[data-ui="discovery-paper"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["SEED1.R1", "SEED1.R2", "SEED1.U1"]);
    // exactly one ADS request and nothing written
    expect(discoveryGets).toEqual(["SEED1"]);
    expect(writes).toEqual([]);
  });

  it("explore_work is disabled without an ADS bibcode, for an unknown work and without a live library", async () => {
    await boot();
    expect(await run({ action: "explore_work", refId: "doi:10.1000/p2" })).toEqual({ ok: false, detail: "disabled" });
    expect(await run({ action: "explore_work", refId: "nope" })).toEqual({ ok: false, detail: "not_found" });
    expect(discoveryGets).toEqual([]);
  });

  it("explore_work is disabled while the library is the built-in example", async () => {
    libraryLive = false;
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    await run({ action: "switch_view", view: "library" });
    await waitFor(() => expect(h.context?.library?.source).toBe("demo"));
    const first = h.context!.library!.refs[0]!.id;
    expect(await run({ action: "explore_work", refId: first })).toEqual({ ok: false, detail: "disabled" });
    expect(discoveryGets).toEqual([]);
  });
});

describe("filters, search, display and the open candidate", () => {
  it("the filtered nodes and edges the assistant gets are exactly what the page shows", async () => {
    await explore();
    expect(await run({ action: "filter_discovery", filter: "related" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.filter).toBe("related"));
    // the seed always stays; the useful-only node and every edge touching it leave
    await waitFor(() => expect(disc().graph!.nodes.map((n) => n.bibcode)).toEqual(["SEED1", "SEED1.R1", "SEED1.R2"]));
    await waitFor(() => expect(disc().graph!.edges).toEqual([{ from: "SEED1", to: "SEED1.R1", kind: "citation" }]));
    await waitFor(() => expect(disc().graph!.totals.nodes).toBe(4)); // totals describe the whole session
    expect(qa('[data-ui="discovery-paper"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["SEED1.R1", "SEED1.R2"]);
    expect(await run({ action: "search_discovery", query: "beta" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.nodes.map((n) => n.bibcode)).toEqual(["SEED1", "SEED1.R2"]));
    expect(qa('[data-ui="discovery-paper"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["SEED1.R2"]);
    expect(await run({ action: "search_discovery", query: "" })).toEqual({ ok: true });
    expect(await run({ action: "filter_discovery", filter: "all" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.nodes).toHaveLength(4));
    expect(discoveryGets).toEqual(["SEED1"]); // filtering never queries again
  });

  it("selects a candidate (never changing the seed), opens its citations tab and closes it", async () => {
    await explore();
    expect(await run({ action: "select_candidate", bibcode: "nope" })).toEqual({ ok: false, detail: "not_found" });
    expect(await run({ action: "select_candidate", bibcode: "SEED1.U1" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().selectedBibcode).toBe("SEED1.U1"));
    await waitFor(() => expect(disc().detail).toMatchObject({ tab: "abstract", references: [], citedBy: ["SEED1.R1", "SEED1.R2"] }));
    await waitFor(() => expect(disc().detail!.paper.abstract).toBe("Abstract of SEED1.U1"));
    expect(q('[data-ui="discovery-detail"]')?.getAttribute("data-ui-key")).toBe("SEED1.U1");
    expect(await run({ action: "set_discovery_tab", tab: "citations" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().detail!.tab).toBe("citations"));
    expect(qa('[data-ui="citation-paper"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(["SEED1.R1", "SEED1.R2"]);
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED1"));
    expect(discoveryGets).toEqual(["SEED1"]);
    // another candidate opens on its abstract again (the inspector used to remount per candidate)
    expect(await run({ action: "select_candidate", bibcode: "SEED1.R1" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().detail).toMatchObject({ tab: "abstract" }));
    expect(await run({ action: "select_candidate", bibcode: null })).toEqual({ ok: true });
    await waitFor(() => expect(disc().detail).toBeNull());
    expect(await run({ action: "set_discovery_tab", tab: "citations" })).toEqual({ ok: false, detail: "disabled" });
  });

  it("switches between the graph and the table, and the table lists the visible nodes", async () => {
    await explore();
    expect(q('[data-ui="graph-stub"]')).not.toBeNull();
    expect(await run({ action: "set_discovery_display", display: "list" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().display).toBe("list"));
    expect(q('[data-ui="graph-stub"]')).toBeNull();
    expect(qa('[data-ui="discovery-table-paper"]')).toHaveLength(4);
  });
});

describe("graph buttons of the exploration", () => {
  it("presses zoom/fit/relayout/jump-to-origin and sets the labels through the page's own callbacks", async () => {
    await explore();
    for (const control of ["zoom_in", "zoom_out", "fit", "relayout", "focus_seed"] as const) expect(await run({ action: "discovery_graph_control", control })).toEqual({ ok: true });
    expect(g.calls).toEqual(["zoom_in", "zoom_out", "fit", "relayout", "focus_seed"]);
    expect(await run({ action: "set_discovery_graph_labels", on: true })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graphView.labelsOn).toBe(true));
    expect(q('[data-ui="graph-stub"]')?.getAttribute("data-labels")).toBe("true");
  }, 20000);

  it("a hidden graph (table view) has no buttons to press", async () => {
    await explore();
    await run({ action: "set_discovery_display", display: "list" });
    await waitFor(() => expect(q('[data-ui="graph-stub"]')).toBeNull());
    // The page's report (and the buttons the Copilot may press) follow the display in a later effect than the DOM.
    await waitFor(() => expect(disc().display).toBe("list"));
    expect(await run({ action: "discovery_graph_control", control: "fit" })).toEqual({ ok: false, detail: "unavailable" });
    expect(g.calls).toEqual([]);
  }, 20000);
});

describe("history, continuing and leaving", () => {
  it("explore_candidate sends exactly one request for that seed and adds one history entry; Back/Forward re-send nothing", async () => {
    await explore();
    expect(await run({ action: "explore_candidate", bibcode: "SEED1" })).toEqual({ ok: false, detail: "disabled" }); // the origin has no such button
    expect(await run({ action: "explore_candidate", bibcode: "SEED1.R1" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED1.R1"));
    expect(discoveryGets).toEqual(["SEED1", "SEED1.R1"]); // no further hop of its own
    await waitFor(() => expect(disc().history).toEqual({ index: 1, seeds: ["SEED1", "SEED1.R1"] }));
    expect(await run({ action: "step_exploration", direction: "forward" })).toEqual({ ok: false, detail: "disabled" });
    expect(await run({ action: "step_exploration", direction: "back" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED1"));
    expect(await run({ action: "step_exploration", direction: "forward" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED1.R1"));
    expect(discoveryGets).toEqual(["SEED1", "SEED1.R1"]);
  });

  it("exit returns to the library page, which then offers the history; resume restores it without a request", async () => {
    await explore();
    expect(await run({ action: "filter_library", query: "x" })).toEqual({ ok: false, detail: "unavailable" }); // the library page is not shown
    expect(await run({ action: "exit_exploration" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.library?.exploration).toEqual({ sessions: 1, seed: "SEED1" }));
    await waitFor(() => expect(h.context!.discovery ?? null).toBeNull());
    await waitFor(() => expect(h.context!.status).toBe("complete"));
    expect(await run({ action: "exit_exploration" })).toEqual({ ok: false, detail: "unavailable" });
    expect(await run({ action: "resume_exploration" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.discovery?.graph?.seed).toBe("SEED1"));
    expect(discoveryGets).toEqual(["SEED1"]);
  }, 20000);

  it("resume is disabled when there is no history", async () => {
    await boot();
    expect(await run({ action: "resume_exploration" })).toEqual({ ok: false, detail: "disabled" });
  });

  it("view_candidate_in_library leaves the exploration and selects the saved work (only for a saved candidate)", async () => {
    await explore();
    expect(await run({ action: "view_candidate_in_library", bibcode: "SEED1.R1" })).toEqual({ ok: false, detail: "disabled" });
    expect(await run({ action: "discovery_saved", bibcode: "SEED1.R1", workId: "doi:10.1000/p2" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.totals.saved).toBe(1));
    expect(await run({ action: "view_candidate_in_library", bibcode: "SEED1.R1" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.discovery ?? null).toBeNull());
    await waitFor(() => expect(h.context?.library?.selectedRefId).toBe("doi:10.1000/p2"));
  });
});

describe("failure and cancellation", () => {
  it("a failed request is reported as failed with its status, keeps the earlier exploration, enters no history and is not retried by itself", async () => {
    await explore();
    answer = async () => failing(503);
    expect(await run({ action: "explore_candidate", bibcode: "SEED1.R1" })).toEqual({ ok: false, detail: "failed", http: 503 });
    await waitFor(() => expect(disc().error).toEqual({ seed: "SEED1.R1", status: 503 }));
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED1"));
    await waitFor(() => expect(disc().history).toEqual({ index: 0, seeds: ["SEED1"] }));
    expect(discoveryGets).toEqual(["SEED1", "SEED1.R1"]); // exactly one failed request; no automatic retry
    expect(writes).toEqual([]);
    // the Retry button's request is the same full request; it is sent once
    answer = async (seed) => ok(graphFor(seed));
    expect(await run({ action: "retry_exploration" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED1.R1"));
    await waitFor(() => expect(disc().error).toBeNull());
    expect(discoveryGets).toEqual(["SEED1", "SEED1.R1", "SEED1.R1"]);
    expect(await run({ action: "retry_exploration" })).toEqual({ ok: false, detail: "disabled" }); // nothing failed, nothing to retry
  });

  it("dismiss_discovery_error closes the banner and is disabled without one", async () => {
    await explore();
    expect(await run({ action: "dismiss_discovery_error" })).toEqual({ ok: false, detail: "disabled" });
    answer = async () => failing(429);
    await run({ action: "explore_candidate", bibcode: "SEED1.R2" });
    await waitFor(() => expect(disc().error?.status).toBe(429));
    expect(await run({ action: "dismiss_discovery_error" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().error).toBeNull());
  });

  it("the very first exploration failing leaves no graph, an error status and an error context", async () => {
    answer = async () => failing(404);
    await boot();
    expect(await run({ action: "explore_work", refId: "doi:10.1000/p1" })).toEqual({ ok: false, detail: "failed", http: 404 });
    await waitFor(() => expect(h.context?.discovery?.error).toEqual({ seed: "SEED1", status: 404 }));
    await waitFor(() => expect(h.context!.status).toBe("error"));
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    await waitFor(() => expect(disc().graph).toBeNull());
    await waitFor(() => expect(disc().history).toEqual({ index: -1, seeds: [] }));
  });

  it("cancel_exploration aborts the request for real; the action that started it reports cancelled and nothing is entered", async () => {
    await explore();
    let aborted = false;
    answer = (_seed, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    const pending = run({ action: "explore_candidate", bibcode: "SEED1.R1" });
    await waitFor(() => expect(h.context?.discovery?.loading).toEqual({ seed: "SEED1.R1" }));
    await waitFor(() => expect(h.context!.discovery!.graph!.seed).toBe("SEED1")); // the earlier graph stays under the loading overlay
    expect(await run({ action: "cancel_exploration" })).toEqual({ ok: true });
    expect(await pending).toEqual({ ok: false, detail: "cancelled" });
    expect(aborted).toBe(true);
    await waitFor(() => expect(disc().loading).toBeNull());
    await waitFor(() => expect(disc().error).toBeNull());
    await waitFor(() => expect(disc().history.seeds).toEqual(["SEED1"]));
    expect(await run({ action: "cancel_exploration" })).toEqual({ ok: false, detail: "disabled" });
  });
});

describe("saving a candidate", () => {
  it("the service's discovery_saved marks the node in place: no request, same seed, same selection", async () => {
    await explore();
    await run({ action: "select_candidate", bibcode: "SEED1.R2" });
    await waitFor(() => expect(disc().selectedBibcode).toBe("SEED1.R2"));
    expect(await run({ action: "discovery_saved", bibcode: "SEED1.R2", workId: "doi:10.1000/p2" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.totals.saved).toBe(1));
    await waitFor(() => expect(disc().graph!.nodes.find((n) => n.bibcode === "SEED1.R2")!.libraryId).toBe("doi:10.1000/p2"));
    await waitFor(() => expect(disc().detail!.paper.libraryId).toBe("doi:10.1000/p2"));
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED1"));
    await waitFor(() => expect(disc().selectedBibcode).toBe("SEED1.R2"));
    expect(discoveryGets).toEqual(["SEED1"]);
    expect(writes).toEqual([]); // the sync action writes nothing itself
    // an unknown candidate is ignored
    expect(await run({ action: "discovery_saved", bibcode: "other", workId: "w" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.totals.saved).toBe(1));
  });

  it("the page's own Add posts the bibcode import and marks the same node saved the same way", async () => {
    await explore();
    await run({ action: "select_candidate", bibcode: "SEED1.R1" });
    await waitFor(() => expect(q('[data-ui="save-discovery-paper"]')).not.toBeNull());
    fireEvent.click(q('[data-ui="save-discovery-paper"]')!);
    await waitFor(() => expect(disc().graph!.totals.saved).toBe(1));
    expect(writes).toEqual([{ url: "/api/library/works", method: "POST", body: { mode: "bibcode", bibcode: "SEED1.R1" } }]);
    await waitFor(() => expect(disc().graph!.nodes.find((n) => n.bibcode === "SEED1.R1")!.libraryId).toBe("bibcode:SEED1.R1"));
    expect(discoveryGets).toEqual(["SEED1"]);
  });
});

describe("repair round: controls, state and reports", () => {
  it("the graph label toggle resets when the display leaves the graph, as unmounting the canvas always did", async () => {
    await explore();
    await run({ action: "set_discovery_graph_labels", on: true });
    await waitFor(() => expect(disc().graphView.labelsOn).toBe(true));
    await run({ action: "set_discovery_display", display: "list" });
    await waitFor(() => expect(disc().display).toBe("list"));
    await waitFor(() => expect(disc().graphView.labelsOn).toBe(false));
    await run({ action: "set_discovery_display", display: "graph" });
    await waitFor(() => expect(q('[data-ui="graph-stub"]')).not.toBeNull());
    expect(q('[data-ui="graph-stub"]')?.getAttribute("data-labels")).toBe("false");
    // the page's own switch buttons do the same
    await run({ action: "set_discovery_graph_labels", on: true });
    await waitFor(() => expect(disc().graphView.labelsOn).toBe(true));
    fireEvent.click(q('[data-ui="show-discovery-list"]')!);
    await waitFor(() => expect(disc().display).toBe("list"));
    await waitFor(() => expect(disc().graphView.labelsOn).toBe(false));
  });

  it("choosing the open candidate again keeps its tab; choosing another one starts on the abstract", async () => {
    await explore();
    await run({ action: "select_candidate", bibcode: "SEED1.R1" });
    await run({ action: "set_discovery_tab", tab: "citations" });
    await waitFor(() => expect(disc().detail?.tab).toBe("citations"));
    await run({ action: "select_candidate", bibcode: "SEED1.R1" });
    fireEvent.click(q('[data-ui="discovery-paper"][data-ui-key="SEED1.R1"]')!);
    await waitFor(() => expect(disc().detail?.tab).toBe("citations"));
    await run({ action: "select_candidate", bibcode: "SEED1.R2" });
    await waitFor(() => expect(disc().detail?.tab).toBe("abstract"));
  });

  it("explore_candidate, view_candidate_in_library and select_candidate reach only what the page lets the user reach", async () => {
    await explore();
    await run({ action: "filter_discovery", filter: "related" });
    await run({ action: "search_discovery", query: "alpha" }); // only SEED1.R1 (and the seed) stay visible
    await waitFor(() => expect(disc().graph!.nodes.map((n) => n.bibcode)).toEqual(["SEED1", "SEED1.R1"]));
    // U1 is hidden by the filter and is not the open candidate's neighbour yet
    for (const action of [{ action: "explore_candidate", bibcode: "SEED1.U1" }, { action: "select_candidate", bibcode: "SEED1.U1" }, { action: "view_candidate_in_library", bibcode: "SEED1.U1" }])
      expect(await run(action), String(action.action)).toEqual({ ok: false, detail: "not_found" });
    expect(discoveryGets).toEqual(["SEED1"]);
    // opening R1 makes its in-graph neighbour U1 reachable, like the inspector's citation rows
    await run({ action: "select_candidate", bibcode: "SEED1.R1" });
    await waitFor(() => expect(disc().detail?.references).toEqual(["SEED1.U1"]));
    expect(await run({ action: "select_candidate", bibcode: "SEED1.U1" })).toEqual({ ok: true });
    expect(await run({ action: "explore_candidate", bibcode: "SEED1.U1" })).toEqual({ ok: true });
    expect(discoveryGets).toEqual(["SEED1", "SEED1.U1"]);
  });

  it("when a request failed AND the shown graph lacks its useful papers, Retry has two targets like the two buttons", async () => {
    await explore();
    // a graph whose useful request failed (warning) is on screen; then another request fails
    answer = async (seed) => ok({ ...graphFor(seed), warnings: [{ code: "useful_unavailable" }] });
    await run({ action: "explore_candidate", bibcode: "SEED1.R1" });
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED1.R1"));
    answer = async () => failing(502);
    await run({ action: "explore_candidate", bibcode: "SEED1.R1.R2" });
    await waitFor(() => expect(disc().error).toEqual({ seed: "SEED1.R1.R2", status: 502 }));
    answer = async (seed) => ok(graphFor(seed));
    expect(await run({ action: "retry_exploration", target: "current" })).toEqual({ ok: true }); // the useful note's button
    expect(discoveryGets[discoveryGets.length - 1]).toBe("SEED1.R1");
    await waitFor(() => expect(disc().error).toBeNull());
  });

  it("the default Retry re-sends the seed that failed", async () => {
    await explore();
    answer = async () => failing(502);
    await run({ action: "explore_candidate", bibcode: "SEED1.R2" });
    await waitFor(() => expect(disc().error?.seed).toBe("SEED1.R2"));
    answer = async (seed) => ok(graphFor(seed));
    expect(await run({ action: "retry_exploration" })).toEqual({ ok: true });
    expect(discoveryGets[discoveryGets.length - 1]).toBe("SEED1.R2");
    // nothing failed and no useful warning: the "current" retry has no button
    expect(await run({ action: "retry_exploration", target: "current" })).toEqual({ ok: false, detail: "disabled" });
  });

  it("explore_work uses the library as just re-read: a work the page did not know, in a library that is live now, can be explored", async () => {
    libraryLive = false;
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    await run({ action: "switch_view", view: "library" });
    await waitFor(() => expect(h.context?.library?.source).toBe("demo"));
    libraryLive = true;
    expect(await run({ action: "explore_work", refId: "doi:10.1000/p3" })).toEqual({ ok: true });
    expect(discoveryGets).toEqual(["SEED3"]);
  });

  it("a pane that leaves the Library page never publishes its old exploration when it comes back", async () => {
    await explore();
    await run({ action: "switch_view", view: "plan" });
    await waitFor(() => expect(h.context?.view).toBe("plan"));
    const mark = h.seen.length;
    await run({ action: "switch_view", view: "library" });
    await waitFor(() => expect(h.context?.library?.refs.length).toBe(3));
    expect(h.seen.slice(mark).filter((c) => c.view === "library").every((c) => (c.discovery ?? null) === null)).toBe(true);
    expect(await run({ action: "filter_discovery", filter: "related" })).toEqual({ ok: false, detail: "unavailable" });
  }, 20000);

  it("the nodes carry no abstract (only the open candidate does) and a very long history stays a valid report", async () => {
    await explore();
    await waitFor(() => expect(disc().graph!.nodes.every((n) => !("abstract" in n))).toBe(true));
    await run({ action: "select_candidate", bibcode: "SEED1.R1" });
    await waitFor(() => expect(disc().detail?.paper.abstract).toBe("Abstract of SEED1.R1"));
    const { captureDiscoveryPage } = await import("../src/copilot/discovery-context");
    const seeds = Array.from({ length: 1205 }, (_, i) => `S${i}`);
    const long = captureDiscoveryPage({ graph: graphFor("S1204"), seeds, index: 1204, loading: null, error: null, adding: null, addFailed: null, selection: null, query: "", filter: "all", display: "graph", detailTab: "abstract", labelsOn: false });
    expect(long.history.seeds).toHaveLength(1000);
    expect(long.history.index).toBe(999);
    expect(long.history.seeds[999]).toBe("S1204");
    expect(PageContextSchema.safeParse({ version: 1, viewId: "7b1e9a74-0f43-4b9a-9d58-9f4a3f2f8c11", revision: 1, paneId: 1, view: "library", status: "complete", otherPanes: [], plan: null, library: null, discovery: long }).success).toBe(true);
  });
});

describe("two Library panes", () => {
  /** pane 1 explores SEED1, pane 2 (split, active) explores SEED3. */
  async function twoExplorations() {
    // happy-dom (unlike a browser) fires hashchange for pushState; that would make the hash bus re-explore in pane 1
    const add = window.addEventListener.bind(window);
    vi.spyOn(window, "addEventListener").mockImplementation(((type: string, ...rest: unknown[]) => (type === "hashchange" ? undefined : (add as (...a: unknown[]) => void)(type, ...rest))) as never);
    await explore();
    expect(await run({ action: "split_pane" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.paneId).toBe(2));
    await waitFor(() => expect(h.context?.library?.refs.length).toBe(3));
    expect(await run({ action: "explore_work", refId: "doi:10.1000/p3" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.discovery?.graph?.seed).toBe("SEED3"));
  }

  it("controls and the published page are the active pane's; the other pane is untouched and is not focused", async () => {
    await twoExplorations();
    await waitFor(() => expect(h.context!.paneId).toBe(2));
    expect(await run({ action: "filter_discovery", filter: "useful" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.filter).toBe("useful"));
    await waitFor(() => expect(disc().graph!.seed).toBe("SEED3"));
    await waitFor(() => expect(h.context!.paneId).toBe(2)); // focus did not move
    // pane 1's own filter is still "all"
    expect(await run({ action: "select_pane", paneId: 1 })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.paneId).toBe(1));
    await waitFor(() => expect(h.context?.discovery?.graph?.seed).toBe("SEED1"));
    await waitFor(() => expect(disc().graph!.filter).toBe("all"));
    expect(await run({ action: "filter_discovery", filter: "related" })).toEqual({ ok: true });
    await waitFor(() => expect(disc().graph!.filter).toBe("related"));
    await waitFor(() => expect(h.context!.paneId).toBe(1));
  }, 20000);

  it("an active Library pane that is not exploring gets no control, while another pane explores: nothing moves", async () => {
    await explore();
    await run({ action: "split_pane" });
    await waitFor(() => expect(h.context?.paneId).toBe(2));
    await waitFor(() => expect(h.context?.library?.refs.length).toBe(3));
    await waitFor(() => expect(h.context!.discovery ?? null).toBeNull());
    expect(await run({ action: "filter_discovery", filter: "related" })).toEqual({ ok: false, detail: "unavailable" });
    expect(await run({ action: "explore_candidate", bibcode: "SEED1.R1" })).toEqual({ ok: false, detail: "unavailable" });
    await waitFor(() => expect(h.context!.paneId).toBe(2)); // not switched to the exploring pane
    expect(discoveryGets).toEqual(["SEED1"]);
  }, 20000);
});
