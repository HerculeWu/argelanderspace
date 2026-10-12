/**
 * Library at 1024 with the detail panel open (ticket 32 lane C finding D6, user ruling 2026-10-06): the 360 px detail
 * used to cover the 414 px graph. Same spirit as the Reader's auto-fold: when the pane cannot keep a graph column next
 * to the detail, the work list folds to its rail while a detail is open; the detail stays beside the graph, never over
 * it; a manual unfold wins until the width class changes; a wide pane is untouched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { libraryAutoFold, MIN_GRAPH_COLUMN } from "../src/library/layout";
import { LibraryView } from "../src/library/LibraryView";
import type { LibraryData, LibraryRef } from "../src/library/types";

vi.mock("../src/api/ws", () => ({ onArgumentGraphChanged: () => () => {}, onLibraryChanged: () => () => {}, onJobEvent: () => () => {} }));

describe("libraryAutoFold", () => {
  it("folds the work list only while a detail is open and the graph would fall below its minimum", () => {
    expect(libraryAutoFold(null, true)).toBe(false);
    expect(libraryAutoFold(612, false)).toBe(false); // nothing open: the list is the user's
    expect(libraryAutoFold(612, true)).toBe(true); // 1024 window with the Copilot open
    expect(libraryAutoFold(962, true)).toBe(false); // 1024 window without the Copilot: 250 + 392 + 320 graph
    expect(libraryAutoFold(250 + 392 + MIN_GRAPH_COLUMN, true)).toBe(false);
    expect(libraryAutoFold(250 + 392 + MIN_GRAPH_COLUMN - 1, true)).toBe(true);
    expect(libraryAutoFold(1440 - 62, true)).toBe(false);
  });
});

describe("the stylesheet never lays the detail over the graph", () => {
  it("the narrow-pane rule narrows the detail instead of absolutely positioning it", () => {
    const css = readFileSync(join(process.cwd(), "src/argelander.css"), "utf8");
    const rule = css.match(/@container \(max-width: 820px\) \{([^}]*\{[^}]*\}\s*)+\}/)?.[0] ?? "";
    expect(rule).toContain(".ref-detail");
    expect(rule).not.toMatch(/position:\s*absolute/);
  });
});

const REFS: LibraryRef[] = [1, 2, 3].map((n) => ({
  id: `w${n}`,
  title: `Paper ${n}`,
  authors: "Able",
  year: 2020 + n,
  venue: "ApJ",
  type: "article",
  cite: `able${n}`,
  tags: [],
  pdf: false,
  read: false,
  star: false,
}));
const PAYLOAD: LibraryData = {
  project: { name: "Test" },
  refs: REFS,
  tags: [],
  graph: { nodes: REFS.map((r) => ({ id: r.cite, ref: r.id, y: r.year, c: 1, a: r.authors, v: r.venue, t: r.title })), links: [] },
};
const WORKSPACE: Workspace = {
  papers: [],
  currentDoc: null,
  setCurrentDoc: () => {},
  openDoc: () => {},
  pendingAnchor: null,
  clearPendingAnchor: () => {},
  docDeleted: () => {},
  tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true },
};

let width = 612;
const observers = new Set<() => void>();
class RO {
  private readonly run = () => this.cb();
  constructor(private cb: () => void) {}
  observe(el: Element) {
    // only the pane's own width matters here; the graph canvas has its own observer, which stays idle
    if (el.getAttribute("data-ui") === "library-view") {
      observers.add(this.run);
    }
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.run);
  }
}
const real = Element.prototype.getBoundingClientRect;
const resize = async (next: number) => {
  width = next;
  await act(async () => observers.forEach((cb) => cb()));
};
const ui = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-ui="${id}"]`);

beforeEach(() => {
  width = 612;
  vi.stubGlobal("ResizeObserver", RO);
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.getAttribute("data-ui") === "library-view" ? ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON() {} } as DOMRect) : real.call(this);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/library" ? ({ ok: true, json: async () => PAYLOAD } as Response) : ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response))));
});
afterEach(() => {
  cleanup();
  Element.prototype.getBoundingClientRect = real;
  vi.unstubAllGlobals();
});

async function open() {
  const view = render(
    <WorkspaceProvider value={WORKSPACE}>
      <LibraryView />
    </WorkspaceProvider>
  );
  // the first work with a node is selected on arrival, so its detail is open from the start
  await waitFor(() => expect(ui(view.container, "work-detail")).not.toBeNull());
  return view;
}

describe("LibraryView in a narrow pane (1024 window with the Copilot open)", () => {
  it("folds the work list to its rail while a detail is open and brings it back when the detail closes", async () => {
    const { container } = await open();
    await waitFor(() => expect(ui(container, "expand-library-sidebar")).not.toBeNull());
    expect(ui(container, "library-sidebar")).toBeNull();
    fireEvent.click(ui(container, "close-work-detail")!);
    await waitFor(() => expect(ui(container, "work-detail")).toBeNull());
    expect(ui(container, "library-sidebar")).not.toBeNull();
    expect(ui(container, "expand-library-sidebar")).toBeNull();
    // choosing a work again folds it again
    fireEvent.click(container.querySelectorAll<HTMLElement>(".side-ref")[1]!);
    await waitFor(() => expect(ui(container, "work-detail")).not.toBeNull());
    await waitFor(() => expect(ui(container, "library-sidebar")).toBeNull());
  });

  it("a manual unfold wins until the width class changes; a wide pane is never folded; the user's own fold stays", async () => {
    const { container } = await open();
    await waitFor(() => expect(ui(container, "expand-library-sidebar")).not.toBeNull());
    fireEvent.click(ui(container, "expand-library-sidebar")!);
    expect(ui(container, "library-sidebar")).not.toBeNull();
    await resize(1200); // wide: nothing is folded
    expect(ui(container, "library-sidebar")).not.toBeNull();
    fireEvent.click(ui(container, "collapse-library-sidebar")!); // the user's own fold
    await resize(612);
    expect(ui(container, "library-sidebar")).toBeNull();
    expect(ui(container, "work-detail")).not.toBeNull();
    await resize(1200);
    expect(ui(container, "library-sidebar")).toBeNull(); // still the user's fold at a wide width
  });
});
