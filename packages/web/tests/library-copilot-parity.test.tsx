/**
 * Library page for Copilot (ticket 13): the page the assistant sees is built from the loaded data and the
 * view state, not from mounted rows, and the bound-view actions drive the same state the controls do.
 * The real Shell and LibraryView are rendered; only the Copilot panel and the WebSocket are replaced.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { type CopilotViewAction, type PageContext, PageContextSchema } from "@argelanderspace/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import type { LibraryData, LibraryRef } from "../src/library/types";
import { installShellHarness } from "./shell-harness";

const h = vi.hoisted(() => ({
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
  context: null as null | PageContext,
}));
vi.mock("../src/api/ws", async () => (await import("./shell-stubs")).quietWs({ onArgumentGraphChanged: () => () => {} }));
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));
const g = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/graph/GraphCanvas", async () => {
  const { useEffect } = await import("react");
  return {
    GraphCanvas: ({ onController, labelsOn }: { onController?: (c: unknown) => void; labelsOn?: boolean }) => {
      useEffect(() => {
        onController?.({ zoomIn: () => g.calls.push("zoom_in"), zoomOut: () => g.calls.push("zoom_out"), fit: () => g.calls.push("fit"), relayout: () => g.calls.push("relayout") });
        return () => onController?.(null);
      }, [onController]);
      return <div data-ui="graph-stub" data-labels={String(labelsOn)} />;
    },
  };
});

const ref = (n: number, over: Partial<LibraryRef> = {}): LibraryRef => ({
  id: `doi:10.1000/p${n}`,
  title: `Paper ${n} on galaxies`,
  authors: `Author${n}, Co`,
  year: 2000 + (n % 20),
  venue: "MNRAS",
  type: "article",
  cite: `author${n}`,
  tags: [],
  pdf: false,
  read: false,
  star: false,
  note: n === 1 ? "A note nobody can edit here" : undefined,
  doc_id: n === 1 ? "d1" : undefined,
  doc_ids: n === 1 ? ["d1", "d2"] : undefined,
  ...over,
});
const COUNT = 320;
let data: LibraryData;
let libraryGets: number;
let writes: { url: string; method: string }[];
let down: false | "unreachable" | "error";
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

installShellHarness({
  routes: (url, init) => {
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push({ url, method });
    if (url === "/api/plans") return ok({ version: 1, rev: 1, plans: [] });
    if (url === "/api/library") {
      libraryGets++;
      if (down === "unreachable") throw new TypeError("network down");
      return down ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Response) : ok(data);
    }
    return null;
  },
});
beforeEach(() => {
  const refs = Array.from({ length: COUNT }, (_, i) => ref(i + 1));
  data = {
    project: { name: "P" },
    refs,
    tags: [],
    graph: {
      version: 2,
      nodes: refs.map((r) => ({ id: r.id, ref: r.id, y: r.year, c: 1, a: r.authors, v: r.venue, t: r.title })),
      links: [[refs[0]!.id, refs[1]!.id], [refs[1]!.id, refs[COUNT - 1]!.id]],
    },
  };
  libraryGets = 0;
  writes = [];
  down = false;
  g.calls = [];
  h.viewAction = null;
  h.context = null;
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)];
const run = async (action: CopilotViewAction) => h.viewAction!(action);
const lib = () => h.context!.library!;
async function boot() {
  render(<Shell />);
  await waitFor(() => expect(h.viewAction).not.toBeNull());
  expect(await run({ action: "switch_view", view: "library" })).toEqual({ ok: true });
  await waitFor(() => expect(h.context?.library?.refs.length).toBe(COUNT));
}

describe("the page the assistant receives", () => {
  it("is the whole filtered list, not the rows that happen to be mounted, and is a valid complete context", async () => {
    await boot();
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    await waitFor(() => expect(h.context).toMatchObject({ view: "library", status: "complete" }));
    await waitFor(() => expect(lib()).toMatchObject({ source: "live", total: COUNT, matched: COUNT, query: "" }));
    await waitFor(() => expect(lib().refs[lib().refs.length - 1]?.id).toBe(`doi:10.1000/p${COUNT}`));
    await waitFor(() => expect(lib().links).toEqual([
      ["doi:10.1000/p1", "doi:10.1000/p2"],
      ["doi:10.1000/p2", `doi:10.1000/p${COUNT}`],
    ]));
    expect(qa('[data-ui="work-item"]')).toHaveLength(COUNT);
  });

  it("follows the search box with the list's own predicate, and the rest of the library is only a count", async () => {
    await boot();
    fireEvent.change(q('[data-ui="search-library"]')!, { target: { value: "paper 31" } });
    await waitFor(() => expect(lib().matched).toBe(11)); // 31, 310-319
    expect(qa('[data-ui="work-item"]').map((el) => el.getAttribute("data-ui-key"))).toEqual(lib().refs.map((r) => r.id));
    await waitFor(() => expect(lib().total).toBe(COUNT));
    expect(JSON.stringify(h.context)).not.toContain("doi:10.1000/p5\"");
  });

  it("names the open work in full with the BibTeX tab text and the tab the user is on", async () => {
    await boot();
    fireEvent.click(qa('[data-ui="work-item"]')[0]!);
    await waitFor(() => expect(lib().selectedRefId).toBe("doi:10.1000/p1"));
    await waitFor(() => expect(lib().detail?.ref.note).toBe("A note nobody can edit here"));
    await waitFor(() => expect(lib().detail?.tab).toBe("meta"));
    fireEvent.click(q('[role="tab"][id$="bib"]') ?? qa('[role="tab"]').find((tab) => /bibtex/i.test(tab.textContent ?? ""))!);
    await waitFor(() => expect(lib().detail?.tab).toBe("bib"));
    expect(q('[data-ui="work-bibtex"] pre')?.textContent).toBe(lib().detail?.bibtex);
  });

  it("an unreachable service shows the example data and says so; it is never complete", async () => {
    down = "unreachable";
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    await run({ action: "switch_view", view: "library" });
    await waitFor(() => expect(h.context?.library).toBeTruthy());
    await waitFor(() => expect(h.context).toMatchObject({ status: "unavailable" }));
    await waitFor(() => expect(lib().source).toBe("demo"));
    await waitFor(() => expect(lib().error).toBeUndefined());
    expect(q('[data-ui="library-demo-notice"]')).not.toBeNull();
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
  });

  it("a library that could not be read is an error with its reason, not an example", async () => {
    down = "error";
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    await run({ action: "switch_view", view: "library" });
    await waitFor(() => expect(h.context?.library).toBeTruthy());
    await waitFor(() => expect(h.context).toMatchObject({ status: "error" }));
    await waitFor(() => expect(lib()).toMatchObject({ source: "error", error: "HTTP 500" }));
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
  });

  it("comes from the data, not from the DOM: with the list unmounted the whole filtered list is still in the context", async () => {
    await boot();
    expect(await run({ action: "set_sidebar", collapsed: true })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="library-sidebar"]')).toBeNull());
    expect(qa('[data-ui="work-item"]')).toHaveLength(0);
    await waitFor(() => expect(lib().refs).toHaveLength(COUNT));
    await waitFor(() => expect(lib().refs[COUNT - 1]?.id).toBe(`doi:10.1000/p${COUNT}`));
  });

  it("graph buttons are pressed through the graph's own callbacks; labels are state the context reports", async () => {
    await boot();
    for (const control of ["zoom_in", "zoom_out", "fit", "relayout"] as const)
      expect(await run({ action: "graph_control", control })).toEqual({ ok: true });
    expect(g.calls).toEqual(["zoom_in", "zoom_out", "fit", "relayout"]);
    await waitFor(() => expect(lib().graph.labelsOn).toBe(false));
    expect(await run({ action: "set_graph_labels", on: true })).toEqual({ ok: true });
    await waitFor(() => expect(lib().graph.labelsOn).toBe(true));
    expect(q('[data-ui="graph-stub"]')?.getAttribute("data-labels")).toBe("true");
    expect(writes).toEqual([]);
  });
});

describe("bound-view actions drive the controls' own state", () => {
  it("filter, select, tab, sidebar: UI and context agree, and none of them writes", async () => {
    await boot();
    expect(await run({ action: "filter_library", query: "paper 7" })).toEqual({ ok: true });
    await waitFor(() => expect((q('[data-ui="search-library"]') as HTMLInputElement).value).toBe("paper 7"));
    expect(await run({ action: "select_work", refId: "doi:10.1000/p1" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="work-detail"]')?.getAttribute("data-ui-key")).toBe("doi:10.1000/p1"));
    await waitFor(() => expect(lib().selectedRefId).toBe("doi:10.1000/p1")); // selected although the filter hides it
    expect(await run({ action: "set_detail_tab", tab: "files" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="work-fulltext"]')).not.toBeNull());
    await waitFor(() => expect(lib().detail?.tab).toBe("files"));
    expect(await run({ action: "set_sidebar", collapsed: true })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="library-sidebar"]')).toBeNull());
    await waitFor(() => expect(lib().sidebarCollapsed).toBe(true));
    expect(await run({ action: "select_work", refId: null })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="work-detail"]')).toBeNull());
    await waitFor(() => expect(lib().selectedRefId).toBeNull());
    expect(writes).toEqual([]);
  });

  it("an id the page does not know gets one reload, then is not found; a background import is found", async () => {
    await boot();
    const before = libraryGets;
    expect(await run({ action: "select_work", refId: "doi:10.1000/ghost" })).toEqual({ ok: false, detail: "not_found" });
    expect(libraryGets).toBe(before + 1);
    data = { ...data, refs: [...data.refs, ref(999)], graph: { ...data.graph, nodes: [...data.graph.nodes, { id: "doi:10.1000/p999", ref: "doi:10.1000/p999", y: 2001, c: 1, a: "A", v: "V", t: "T" }] } };
    expect(await run({ action: "select_work", refId: "doi:10.1000/p999" })).toEqual({ ok: true });
    await waitFor(() => expect(lib().selectedRefId).toBe("doi:10.1000/p999"));
  });

  it("a tab needs an open work; the temporary colour dot is display-only and never written", async () => {
    await boot();
    expect(await run({ action: "select_work", refId: null })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="work-detail"]')).toBeNull());
    // Without an open detail panel there is no tab control to press.
    expect(await run({ action: "set_detail_tab", tab: "bib" })).toEqual({ ok: false, detail: "disabled" });
    expect(await run({ action: "set_temp_label", refId: "doi:10.1000/p2", label: "red" })).toEqual({ ok: true });
    await waitFor(() => expect(lib().temporaryLabels).toEqual({ "doi:10.1000/p2": "red" }));
    expect(q('[data-ui="work-item"][data-ui-key="doi:10.1000/p2"] .label-dot')).not.toBeNull();
    await waitFor(() => expect(lib().refs.find((r) => r.id === "doi:10.1000/p2")?.label).toBeUndefined()); // not a stored label
    expect(await run({ action: "set_temp_label", refId: "doi:10.1000/p2", label: null })).toEqual({ ok: true });
    await waitFor(() => expect(lib().temporaryLabels).toEqual({ "doi:10.1000/p2": null }));
    expect(await run({ action: "set_temp_label", refId: "doi:10.1000/ghost", label: "blue" })).toEqual({ ok: false, detail: "not_found" });
    expect(writes).toEqual([]);
  });

  it("opens the Library first when another page is shown, instead of failing", async () => {
    render(<Shell />);
    await waitFor(() => expect(h.viewAction).not.toBeNull());
    expect(await run({ action: "filter_library", query: "paper 2" })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="library-view"]')).not.toBeNull());
    await waitFor(() => expect(h.context?.library?.query).toBe("paper 2"));
  });
});
