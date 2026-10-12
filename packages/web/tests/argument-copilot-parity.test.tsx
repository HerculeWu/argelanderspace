/**
 * The argument graph view for the Copilot (argument graph ticket 04, ADR 0005): the page the assistant sees is built from
 * the view's own state. The real Shell, LibraryView and ArgumentGraphMode are rendered; only the Copilot panel, the
 * WebSocket (the real routing table, `createFakeBus`) and the canvas drawing are replaced. Like Discovery, the page
 * replaces the Library page while the view is open; the Library page's own actions are refused meanwhile.
 */
import { ARGUMENT_PAGE_FULL_MAX, type ArgumentGraph, type PageContext, PageContextSchema } from "@argelanderspace/contracts";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Shell } from "../src/argelander/Shell";
import i18n from "../src/i18n";
import type { LibraryData, LibraryRef } from "../src/library/types";
import { graphChanged } from "./fake-ws";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

const h = vi.hoisted(() => ({
  viewAction: null as null | ((action: unknown) => Promise<{ ok: boolean; detail?: string }>),
  context: null as null | PageContext,
  seen: [] as PageContext[],
}));
vi.mock("../src/api/ws", async () => (await import("./fake-ws")).wsModule());
vi.mock("../src/copilot/Copilot", () => ({
  Copilot: ({ onViewAction, context }: { onViewAction: typeof h.viewAction; context: PageContext }) => {
    h.viewAction = onViewAction;
    h.context = context;
    if (h.seen[h.seen.length - 1] !== context) h.seen.push(context);
    return null;
  },
}));
vi.mock("../src/argument/ArgumentGraphCanvas", () => ({ ArgumentGraphCanvas: () => <div data-ui="canvas-stub" /> }));
vi.mock("../src/graph/GraphCanvas", () => ({ GraphCanvas: () => <div data-ui="graph-stub" /> }));

const WORK = "doi:10.1000/p1";
const ref = (n: number): LibraryRef => ({ id: `doi:10.1000/p${n}`, title: `Paper ${n}`, authors: `Author${n}, Co`, year: 2001, venue: "MNRAS", type: "article", cite: `author${n}`, tags: [], pdf: false, read: false, star: false });
let graph: () => ArgumentGraph;
let answer: () => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.sessionStorage.clear();
  window.localStorage.clear();
  const refs = [ref(1), ref(2)];
  const data: LibraryData = { project: { name: "P" }, refs, tags: [], graph: { version: 2, nodes: refs.map((r) => ({ id: r.id, ref: r.id, y: 2001, c: 1, a: r.authors, v: "MNRAS", t: r.title })), links: [] } };
  graph = () => ({ ...ARGUMENT_FIXTURES.clean(), work_id: WORK, rev: 4 });
  answer = () => ({ status: 200, body: graph() });
  h.viewAction = null;
  h.context = null;
  h.seen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/plans") return ok({ version: 1, rev: 1, plans: [] });
      if (url === "/api/library") return ok(data);
      if (url === "/api/papers") return ok({ papers: [] });
      if (url === `/api/works/${encodeURIComponent(WORK)}/argument-graph`) {
        const { status, body } = await answer();
        return new Response(JSON.stringify(body), { status });
      }
      return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const arg = () => h.context!.argument!;
async function open() {
  render(<Shell />);
  await waitFor(() => expect(h.viewAction).not.toBeNull());
  expect(await h.viewAction!({ action: "switch_view", view: "library" })).toEqual({ ok: true });
  await waitFor(() => expect(h.context?.library?.refs.length).toBe(2));
  fireEvent.click(q('[data-ui="open-argument-graph"]')!);
  await waitFor(() => expect(q('[data-ui="argument-graph-view"]')).not.toBeNull());
}

describe("the page the view publishes", () => {
  it("is a valid, complete context carrying the Work, the whole graph and the audit; the Library page is replaced", async () => {
    await open();
    await waitFor(() => expect(h.context?.argument?.phase).toBe("ready"));
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    expect(h.context).toMatchObject({ view: "library", status: "complete", library: null, discovery: null });
    expect(arg()).toMatchObject({ work: { id: WORK, title: "Paper 1" }, rev: 4, partial: false, selectedId: null, counts: { arguments: 11, edges: 13 }, audit: { total: 0 } });
    expect(arg().graph?.arguments).toHaveLength(11);
    expect(arg().graph?.edges).toHaveLength(13);
    expect(arg().outline).toBeNull();
  });

  it("follows the selection: one new context per click, the graph unchanged, the argument named", async () => {
    await open();
    await waitFor(() => expect(h.context?.argument?.phase).toBe("ready"));
    const before = h.seen.length;
    fireEvent.click(q('[data-ui="argument-outline-row"][data-ui-key="m4"]')!);
    await waitFor(() => expect(arg().selectedId).toBe("m4"));
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    expect(arg().graph?.arguments).toHaveLength(11);
    const afterOne = h.seen.length;
    expect(afterOne - before).toBeLessThanOrEqual(2); // the selection render; nothing re-sent on its own
    const settled = h.seen.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.seen.length).toBe(settled);
    fireEvent.click(q('[data-ui="close-argument-detail"]')!);
    await waitFor(() => expect(arg().selectedId).toBeNull());
  });

  it("a change of the graph on disk reaches the page with the new revision", async () => {
    await open();
    await waitFor(() => expect(h.context?.argument?.rev).toBe(4));
    graph = () => ({ ...ARGUMENT_FIXTURES.clean(), work_id: WORK, rev: 5 });
    act(() => graphChanged(WORK));
    await waitFor(() => expect(h.context?.argument?.rev).toBe(5));
    expect(h.context?.argument?.graph?.rev).toBe(5);
  });

  it("a graph past the budget is published partial: every argument listed, only the selected one in full", async () => {
    graph = () => {
      const big = ARGUMENT_FIXTURES.large();
      big.work_id = WORK;
      big.rev = 7;
      big.arguments = big.arguments.map((a) => ({ ...a, claim: "x".repeat(6000) }));
      expect(JSON.stringify(big).length).toBeGreaterThan(ARGUMENT_PAGE_FULL_MAX);
      return big;
    };
    await open();
    await waitFor(() => expect(h.context?.argument?.partial).toBe(true));
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    expect(arg()).toMatchObject({ graph: null, selected: null, selectedId: null });
    expect(arg().outline?.length).toBe(arg().counts.arguments);
    expect(arg().edges?.length).toBe(arg().counts.edges);
    const first = arg().outline!.find((entry) => entry.kind === "end")!.id;
    fireEvent.click(q(`[data-ui="argument-outline-row"][data-ui-key="${first}"]`)!);
    await waitFor(() => expect(arg().selected?.id).toBe(first));
    expect(arg().selected?.claim).toHaveLength(6000);
    expect(JSON.stringify(arg().outline)).not.toContain("xxxxxxxx");
  });

  it.each([
    ["loading", null, "unavailable"],
    ["not-found", { status: 404, body: { detail: "gone" } }, "error"],
    ["corrupt", { status: 500, body: { detail: "argument graph file is unreadable (corrupt)" } }, "error"],
    ["error", { status: 503, body: {} }, "error"],
  ] as const)("a %s read publishes that phase with no graph", async (phase, reply, status) => {
    // a read that never answers stays loading
    answer = phase === "loading" ? () => new Promise(() => {}) : () => reply!;
    await open();
    await waitFor(() => expect(h.context?.argument?.phase).toBe(phase));
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
    expect(h.context?.status).toBe(status);
    expect(arg()).toMatchObject({ graph: null, rev: null, audit: null, counts: { arguments: 0, edges: 0 } });
  });

  it("a graph with no arguments is an empty, complete page", async () => {
    answer = () => ({ status: 200, body: { ...ARGUMENT_FIXTURES.empty(), work_id: WORK } });
    await open();
    await waitFor(() => expect(h.context?.argument?.phase).toBe("empty"));
    expect(h.context?.status).toBe("complete");
    expect(PageContextSchema.safeParse(h.context).success).toBe(true);
  });

  it("the Library page's own actions are refused while the graph is open, and the page goes back when it closes", async () => {
    await open();
    await waitFor(() => expect(h.context?.argument?.phase).toBe("ready"));
    expect(await h.viewAction!({ action: "filter_library", query: "Paper" })).toEqual({ ok: false, detail: "unavailable" });
    fireEvent.click(q('[data-ui="argument-return-to-library"]')!);
    await waitFor(() => expect(h.context?.argument).toBeNull());
    await waitFor(() => expect(h.context?.library?.refs.length).toBe(2));
    expect(h.context?.status).toBe("complete");
  });
});
