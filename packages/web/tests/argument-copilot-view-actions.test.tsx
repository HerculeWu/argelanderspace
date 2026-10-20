/**
 * The argument graph view's navigation for the Copilot (argument graph ticket 09, ADR 0005): open a Work's graph, select an
 * argument, leave the view, as visible actions through the real pane manager. The real Shell, LibraryView and
 * ArgumentGraphMode are rendered; only the Copilot panel, the WebSocket and the canvas drawing are replaced. An unsaved
 * draft is the user's: the actions never ask about it and never discard it, they answer `leave_blocked`.
 */
import type { ArgumentGraph, PageContext } from "@argelanderspace/contracts";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import type { LibraryData, LibraryRef } from "../src/library/types";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";
import { installShellHarness } from "./shell-harness";

const h = vi.hoisted(() => ({
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
  context: null as null | PageContext,
  seen: [] as PageContext[],
}));
vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", async () => (await import("./shell-stubs")).copilotProbe(h));
vi.mock("../src/argument/ArgumentGraphCanvas", () => ({ ArgumentGraphCanvas: () => <div data-ui="canvas-stub" /> }));
vi.mock("../src/graph/GraphCanvas", () => ({ GraphCanvas: () => <div data-ui="graph-stub" /> }));

const WORK = "doi:10.1000/p1";
const ref = (n: number): LibraryRef => ({ id: `doi:10.1000/p${n}`, title: `Paper ${n}`, authors: `Author${n}, Co`, year: 2001, venue: "MNRAS", type: "article", cite: `author${n}`, tags: [], pdf: false, read: false, star: false });
let graph: () => ArgumentGraph;
let answer: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
let data: LibraryData;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

installShellHarness({
  routes: async (url) => {
    if (url === "/api/plans") return ok({ version: 1, rev: 1, plans: [] });
    if (url === "/api/library") return ok(data);
    if (url === `/api/works/${encodeURIComponent(WORK)}/argument-graph`) {
      const { status, body } = await answer();
      return new Response(JSON.stringify(body), { status });
    }
    return null;
  },
});
beforeEach(() => {
  const refs = [ref(1), ref(2)];
  data = { project: { name: "P" }, refs, tags: [], graph: { version: 2, nodes: refs.map((r) => ({ id: r.id, ref: r.id, y: 2001, c: 1, a: r.authors, v: "MNRAS", t: r.title })), links: [] } };
  graph = () => ({ ...ARGUMENT_FIXTURES.clean(), work_id: WORK, rev: 4 });
  answer = () => ({ status: 200, body: graph() });
  h.viewAction = null;
  h.context = null;
  h.seen = [];
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const OTHER = "doi:10.1000/p2";
const act_ = (action: unknown) => h.viewAction!(action);
async function start() {
  render(<Shell />);
  await waitFor(() => expect(h.viewAction).not.toBeNull());
  await waitFor(() => expect(h.context).not.toBeNull());
}

describe("opening, selecting and leaving the argument graph", () => {
  it("open_argument_graph shows the Work's graph from any page: a Library page is made, the URL names the graph and the page is published", async () => {
    await start();
    // the shell starts on another page than the Library
    expect(await act_({ action: "switch_view", view: "plan" })).toEqual({ ok: true });
    expect(await act_({ action: "open_argument_graph", workId: WORK })).toEqual({ ok: true });
    await waitFor(() => expect(q('[data-ui="argument-graph-view"]')).not.toBeNull());
    await waitFor(() => expect(h.context?.argument?.phase).toBe("ready"));
    expect(h.context?.argument?.work.id).toBe(WORK);
    expect(window.location.hash).toBe(`#argument/${encodeURIComponent(WORK)}`);
    // asking again for the graph that is shown is done, not a second entry
    expect(await act_({ action: "open_argument_graph", workId: WORK })).toEqual({ ok: true });
  });

  it("a Work the library does not list is not_found and nothing opens", async () => {
    await start();
    expect(await act_({ action: "open_argument_graph", workId: "doi:10.1000/none" })).toEqual({ ok: false, detail: "not_found" });
    expect(q('[data-ui="argument-graph-view"]')).toBeNull();
  });

  it("select_argument selects (the panel opens on it and the published page follows), none closes the panel, an unknown id is not_found", async () => {
    await start();
    await act_({ action: "open_argument_graph", workId: WORK });
    await waitFor(() => expect(h.context?.argument?.phase).toBe("ready"));
    expect(await act_({ action: "select_argument", workId: WORK, argumentId: "m4" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.argument?.selectedId).toBe("m4"));
    expect(q('[data-ui="argument-detail"]')?.getAttribute("data-ui-key")).toBe("m4");
    expect(await act_({ action: "select_argument", workId: WORK, argumentId: "ghost" })).toEqual({ ok: false, detail: "not_found" });
    expect(h.context?.argument?.selectedId).toBe("m4");
    expect(await act_({ action: "select_argument", workId: WORK, argumentId: null })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.argument?.selectedId).toBeNull());
    // a graph of another Work is not the one shown
    expect(await act_({ action: "select_argument", workId: OTHER, argumentId: "m4" })).toEqual({ ok: false, detail: "unavailable" });
  });

  it("select_argument with no graph open is unavailable and opens nothing", async () => {
    await start();
    expect(await act_({ action: "select_argument", workId: WORK, argumentId: "m4" })).toEqual({ ok: false, detail: "unavailable" });
    expect(q('[data-ui="argument-graph-view"]')).toBeNull();
  });

  it("exit_argument_graph leaves the view and the Library page is back; with none open it is unavailable", async () => {
    await start();
    expect(await act_({ action: "exit_argument_graph" })).toEqual({ ok: false, detail: "unavailable" });
    await act_({ action: "open_argument_graph", workId: WORK });
    await waitFor(() => expect(h.context?.argument?.phase).toBe("ready"));
    expect(await act_({ action: "exit_argument_graph" })).toEqual({ ok: true });
    await waitFor(() => expect(h.context?.argument).toBeNull());
    expect(q('[data-ui="argument-graph-view"]')).toBeNull();
    expect(window.location.hash).toBe("");
  });

  it("an unsaved draft is never asked about by the Copilot: leave, switch Work and select are leave_blocked, no dialog appears, the draft stays", async () => {
    await start();
    await act_({ action: "open_argument_graph", workId: WORK });
    await waitFor(() => expect(h.context?.argument?.phase).toBe("ready"));
    fireEvent.click(q('[data-ui="create-argument"]')!);
    await waitFor(() => expect(q('[data-ui="argument-title-input"]')).not.toBeNull());
    fireEvent.change(q('[data-ui="argument-title-input"]')!, { target: { value: "My draft" } });
    expect(await act_({ action: "exit_argument_graph" })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(await act_({ action: "open_argument_graph", workId: OTHER })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(await act_({ action: "select_argument", workId: WORK, argumentId: "m4" })).toEqual({ ok: false, detail: "leave_blocked" });
    // switching the pane away is refused by the same rule (the pane manager's agent path)
    expect(await act_({ action: "switch_view", view: "plan" })).toEqual({ ok: false, detail: "leave_blocked" });
    expect(q('[data-ui="argument-leave-dialog"]')).toBeNull();
    expect((q('[data-ui="argument-title-input"]') as HTMLInputElement).value).toBe("My draft");
    expect(h.context?.argument?.work.id).toBe(WORK);
  });

  it("the page itself still asks the user (a click leaves through the dialog)", async () => {
    await start();
    await act_({ action: "open_argument_graph", workId: WORK });
    await waitFor(() => expect(h.context?.argument?.phase).toBe("ready"));
    fireEvent.click(q('[data-ui="create-argument"]')!);
    await waitFor(() => expect(q('[data-ui="argument-title-input"]')).not.toBeNull());
    fireEvent.change(q('[data-ui="argument-title-input"]')!, { target: { value: "My draft" } });
    fireEvent.click(q('[data-ui="argument-return-to-library"]')!);
    await waitFor(() => expect(q('[data-ui="argument-leave-dialog"]')).not.toBeNull());
  });
});
