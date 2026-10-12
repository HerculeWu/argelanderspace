/**
 * Entries into the argument graph view and how it sits in the Library page (ticket 04): the work detail's entry (with
 * the argument count), entering and leaving with the history entry and the page's pane adapter, the exploration taking
 * the page over, the Reader's entry, and the deep link reaching a mounted Library page.
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/i18n";
import i18n from "../src/i18n";
import { type Workspace, WorkspaceProvider } from "../src/argelander/workspace";
import { argumentBus } from "../src/lib/argument-route";
import { ReaderArgumentEntry } from "../src/argument/ArgumentEntry";
import { LibraryView } from "../src/library/LibraryView";
import { createLibraryPane } from "../src/library/library-pane";
import type { LibraryData, LibraryRef } from "../src/library/types";
import { ARGUMENT_FIXTURES } from "./fixtures/argument-graphs";

vi.mock("../src/api/ws", () => ({
  onArgumentGraphChanged: () => () => {},
  onLibraryChanged: () => () => {},
  onJobEvent: () => () => {},
}));
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const REF = (id: string, title: string, extra: Partial<LibraryRef> = {}): LibraryRef => ({ id, title, authors: "Able", year: 2020, venue: "ApJ", type: "article", cite: id, tags: [], pdf: false, read: false, star: false, ...extra });
const REFS = [REF("arxiv:0000.00001", "Has a graph", { doc_ids: ["arxiv-0000.00001"], bibcode: "2020ApJ...1A" }), REF("w-bare", "No Doc, no graph")];
const PAYLOAD: LibraryData = { project: { name: "T" }, refs: REFS, tags: [], graph: { nodes: REFS.map((r) => ({ id: r.cite, ref: r.id, y: 2020, c: 1, a: "Able", v: "ApJ", t: r.title })), links: [] } };
const WORKSPACE: Workspace = { papers: [], currentDoc: null, setCurrentDoc: () => {}, openDoc: vi.fn(), pendingAnchor: null, clearPendingAnchor: () => {}, docDeleted: () => {}, tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true } };

beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  vi.stubGlobal("ResizeObserver", RO);
  window.history.replaceState(null, "", "/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/library") return new Response(JSON.stringify(PAYLOAD), { status: 200 });
      if (url === `/api/works/${encodeURIComponent("arxiv:0000.00001")}/argument-graph`) return new Response(JSON.stringify(ARGUMENT_FIXTURES.clean()), { status: 200 });
      if (url.startsWith("/api/works/")) return new Response(JSON.stringify({ ...ARGUMENT_FIXTURES.empty(), work_id: "w-bare" }), { status: 200 });
      return new Response("{}", { status: 404 });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mount = (props: Parameters<typeof LibraryView>[0] = {}) =>
  render(
    <WorkspaceProvider value={WORKSPACE}>
      <LibraryView {...props} />
    </WorkspaceProvider>
  );
const entry = (c: HTMLElement) => c.querySelector<HTMLButtonElement>('[data-ui="open-argument-graph"]');

describe("work detail entry", () => {
  it("sits beside the explore entry and says how many arguments the work has", async () => {
    const { container } = mount();
    await waitFor(() => expect(entry(container)).not.toBeNull());
    await waitFor(() => expect(entry(container)!.textContent).toBe("论证图 · 11 个论证"));
    expect(container.querySelector('[data-ui="explore-from-work"]')).not.toBeNull();
    expect(entry(container)!.disabled).toBe(false);
  });

  it("works without a bibcode or a Doc; a work with no graph says so", async () => {
    const { container } = mount();
    await waitFor(() => expect(entry(container)).not.toBeNull());
    fireEvent.click(container.querySelectorAll<HTMLElement>(".side-ref")[1]!);
    await waitFor(() => expect(entry(container)!.textContent).toBe("论证图 · —"));
    expect(container.querySelector<HTMLButtonElement>('[data-ui="explore-from-work"]')!.disabled).toBe(true);
    expect(entry(container)!.disabled).toBe(false);
  });
});

describe("entering and leaving", () => {
  it("opens the view with one history entry, publishes the page, and the return button leaves it again", async () => {
    const onArgument = vi.fn();
    const onContext = vi.fn();
    const { container } = mount({ paneId: 7, onArgument, onContext });
    await waitFor(() => expect(entry(container)).not.toBeNull());
    const before = window.history.length;
    fireEvent.click(entry(container)!);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-view"]')).not.toBeNull());
    expect(window.location.hash).toBe("#argument/arxiv%3A0000.00001");
    expect(window.history.length).toBe(before + 1);
    await waitFor(() => expect(onArgument.mock.calls.slice(-1)[0]![1]).toMatchObject({ phase: "ready", work: { id: "arxiv:0000.00001" } }));
    expect(onContext.mock.calls.slice(-1)[0]![1]).toBeNull(); // the Library page is not the page now
    fireEvent.click(container.querySelector('[data-ui="return-to-work"]')!);
    await waitFor(() => expect(container.querySelector('[data-ui="library-view"]')).not.toBeNull());
    expect(window.location.hash).toBe("");
    expect(onArgument.mock.calls.slice(-1)[0]![1]).toBeNull();
    // the work stays selected where the user left it
    expect(entry(container)).not.toBeNull();
  });

  it("a hash-driven request opens it without writing a history entry; a missing hash leaves it", async () => {
    const { container } = mount();
    await waitFor(() => expect(entry(container)).not.toBeNull());
    window.history.replaceState(null, "", "/#argument/w-bare");
    const before = window.history.length;
    argumentBus.request("w-bare");
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-view"]')?.getAttribute("data-ui-key")).toBe("w-bare"));
    expect(window.history.length).toBe(before);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-empty"]')).not.toBeNull());
    argumentBus.exit();
    await waitFor(() => expect(container.querySelector('[data-ui="library-view"]')).not.toBeNull());
  });

  it("a link to a work the library does not list is a normal state with a way back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/library" ? new Response(JSON.stringify(PAYLOAD), { status: 200 }) : new Response(JSON.stringify({ detail: "work 'zzz' not found" }), { status: 404 })))
    );
    const { container } = mount();
    await waitFor(() => expect(entry(container)).not.toBeNull());
    argumentBus.request("zzz");
    await waitFor(() => expect(container.querySelector('[data-ui="argument-graph-not-found"]')).not.toBeNull());
    fireEvent.click(container.querySelector('[data-ui="argument-graph-header"] [data-ui="return-to-work"]')!);
    await waitFor(() => expect(container.querySelector('[data-ui="library-view"]')).not.toBeNull());
  });
});

describe("pane adapter", () => {
  it("keeps the page for the Copilot and, until the contract has a field for it, reports the Library page as unavailable", () => {
    const { adapter, argument, props } = createLibraryPane(() => {});
    const page = { version: 1 as const, work: { id: "w", title: "T" }, phase: "ready" as const, graph: ARGUMENT_FIXTURES.clean(), selectedId: "m1" };
    props.onContext(1, null);
    props.onArgument(1, page);
    expect(argument.get()).toBe(page);
    expect(adapter.status()).toBe("unavailable");
    expect(adapter.context()).toMatchObject({ library: null, discovery: null });
    props.onArgument(1, null);
    expect(argument.get()).toBeNull();
  });
});

describe("Reader entry", () => {
  it("reads nothing until pressed; then finds the work the Doc belongs to and opens its graph", async () => {
    const open = vi.fn();
    const { container } = render(<ReaderArgumentEntry docId="arxiv-0000.00001" onOpen={open} />);
    const button = container.querySelector<HTMLButtonElement>('[data-ui="open-argument-graph-from-reader"]')!;
    expect(fetch).not.toHaveBeenCalled();
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(open).toHaveBeenCalledWith("arxiv:0000.00001"));
  });

  it("a Doc no listed work owns says so instead of opening anything", async () => {
    const open = vi.fn();
    const { container } = render(<ReaderArgumentEntry docId="orphan-doc" onOpen={open} />);
    fireEvent.click(container.querySelector('[data-ui="open-argument-graph-from-reader"]')!);
    await waitFor(() => expect(container.querySelector('[data-ui="argument-reader-entry-missing"]')).not.toBeNull());
    expect(open).not.toHaveBeenCalled();
  });
});
