/**
 * LibraryView side list (Stage 3 / MS3): the color dot reads the persisted
 * `label` field (star→amber seeding only when no label is set), and read refs
 * get the dimmed title + "已读" marker. The library payload is served through
 * the real `api/library` module over a stubbed global fetch; `api/ws` is
 * mocked away (no WebSocket in tests).
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { effectiveLabel, labelColor, LibraryView } from "../src/library/LibraryView";
import type { LibraryData, LibraryRef } from "../src/library/types";

vi.mock("../src/api/ws", () => ({
  onArgumentGraphChanged: () => () => {},
  onLibraryChanged: () => () => {},
  onJobEvent: () => () => {},
}));

const REFS: LibraryRef[] = [
  {
    id: "w1",
    title: "Labeled Paper",
    authors: "Able",
    year: 2020,
    venue: "ApJ",
    type: "article",
    cite: "able2020",
    tags: [],
    pdf: true,
    read: false,
    star: false,
    label: "blue",
    doc_id: "d1",
  },
  {
    id: "w2",
    title: "Starred Unread Paper",
    authors: "Baker",
    year: 2021,
    venue: "MNRAS",
    type: "article",
    cite: "baker2021",
    tags: [],
    pdf: false,
    read: false,
    star: true,
  },
  {
    id: "w3",
    title: "Read Paper",
    authors: "Clark",
    year: 2022,
    venue: "AJ",
    type: "article",
    cite: "clark2022",
    tags: [],
    pdf: false,
    read: true,
    star: false,
  },
  {
    id: "w4",
    title: "Plain Unread Paper",
    authors: "Drew",
    year: 2023,
    venue: "A&A",
    type: "article",
    cite: "drew2023",
    tags: [],
    pdf: false,
    read: false,
    star: false,
  },
];

const PAYLOAD: LibraryData = {
  project: { name: "Test" },
  refs: REFS,
  tags: [],
  graph: {
    nodes: REFS.map((r) => ({ id: r.cite, ref: r.id, y: r.year, c: 1, a: r.authors, v: r.venue, t: r.title })),
    links: [],
  },
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

function rowOf(container: HTMLElement, title: string): HTMLElement {
  const rows = [...container.querySelectorAll<HTMLElement>(".side-ref")];
  const row = rows.find((r) => r.querySelector(".side-ref-title")?.textContent === title);
  if (!row) throw new Error(`side-ref row not found: ${title}`);
  return row;
}

describe("LibraryView side list: labels + read marker", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/library") {
          return { ok: true, json: async () => PAYLOAD } as Response;
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
      })
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("the dot comes from the effective label (structure; values pinned below)", async () => {
    const { container } = render(
      <WorkspaceProvider value={WORKSPACE}>
        <LibraryView />
      </WorkspaceProvider>
    );
    await waitFor(() => expect(container.querySelectorAll(".side-ref").length).toBe(4));

    // persisted label → dot, even unread (the dot replaces the unread dot)
    const labeled = rowOf(container, "Labeled Paper");
    expect(labeled.querySelector(".label-dot")).toBeTruthy();
    expect(labeled.querySelector(".unread-dot")).toBeNull();

    // no label → the star seeds amber (previous behavior) → dot
    const starred = rowOf(container, "Starred Unread Paper");
    expect(starred.querySelector(".label-dot")).toBeTruthy();
    expect(starred.querySelector(".unread-dot")).toBeNull();

    // neither label nor star → the unread dot
    const plain = rowOf(container, "Plain Unread Paper");
    expect(plain.querySelector(".label-dot")).toBeNull();
    expect(plain.querySelector(".unread-dot")).toBeTruthy();
  });

  it("read refs get the dimmed title and the 已读 marker; unread ones don't", async () => {
    const { container } = render(
      <WorkspaceProvider value={WORKSPACE}>
        <LibraryView />
      </WorkspaceProvider>
    );
    await waitFor(() => expect(container.querySelectorAll(".side-ref").length).toBe(4));

    const read = rowOf(container, "Read Paper");
    expect(read.className).toContain(" read");
    expect(read.className).not.toContain("unread");
    expect(read.querySelector(".side-ref-meta")?.textContent).toContain("已读");
    expect(read.querySelector(".unread-dot")).toBeNull();

    const unread = rowOf(container, "Plain Unread Paper");
    expect(unread.className).toContain("unread");
    expect(unread.querySelector(".side-ref-meta")?.textContent).not.toContain("已读");
  });
});

// Back from an opened Doc returns to the Library page with the same Work selected: a Doc pane replaces (unmounts) the page,
// so the workspace keeps the selected graph node per pane for the page to read when it mounts again.
describe("LibraryView: the selected Work across an unmount", () => {
  const selected = (container: HTMLElement) => container.querySelector(".side-ref.sel .side-ref-title")?.textContent ?? null;
  const withMemory = (memory: Map<number, string | null>): Workspace => ({
    ...WORKSPACE,
    librarySelection: { get: (paneId) => memory.get(paneId), set: (paneId, node) => void memory.set(paneId, node) },
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => (String(input) === "/api/library" ? ({ ok: true, json: async () => PAYLOAD } as Response) : ({ ok: false, status: 404, json: async () => ({}) } as unknown as Response))));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("a page mounted again for the same pane selects the Work it showed", async () => {
    const memory = new Map<number, string | null>();
    const first = render(<WorkspaceProvider value={withMemory(memory)}><LibraryView paneId={1} /></WorkspaceProvider>);
    await waitFor(() => expect(selected(first.container)).toBe("Labeled Paper")); // the default: the first Work
    fireEvent.click(rowOf(first.container, "Read Paper"));
    await waitFor(() => expect(selected(first.container)).toBe("Read Paper"));
    first.unmount();
    const again = render(<WorkspaceProvider value={withMemory(memory)}><LibraryView paneId={1} /></WorkspaceProvider>);
    await waitFor(() => expect(selected(again.container)).toBe("Read Paper"));
  });

  it("another pane keeps its own default, and a remembered node that is gone falls back to the default", async () => {
    const memory = new Map<number, string | null>([[1, "gone-node"]]);
    const other = render(<WorkspaceProvider value={withMemory(memory)}><LibraryView paneId={2} /></WorkspaceProvider>);
    await waitFor(() => expect(selected(other.container)).toBe("Labeled Paper"));
    other.unmount();
    const gone = render(<WorkspaceProvider value={withMemory(memory)}><LibraryView paneId={1} /></WorkspaceProvider>);
    await waitFor(() => expect(selected(gone.container)).toBe("Labeled Paper"));
  });
});

// happy-dom drops oklch() inline styles, so the dot's color *values* are
// pinned at the pure-function level instead of through the DOM.
describe("effectiveLabel / labelColor", () => {
  const base = REFS[3] as LibraryRef; // w4: no label, no star

  it("reads the persisted label field; a label beats the star seeding", () => {
    expect(effectiveLabel({ ...base, label: "blue" }, {})).toBe("blue");
    expect(effectiveLabel({ ...base, label: "red", star: true }, {})).toBe("red");
  });

  it("seeds amber from star only when no label is set", () => {
    expect(effectiveLabel({ ...base, star: true }, {})).toBe("amber");
    expect(effectiveLabel(base, {})).toBeUndefined();
  });

  it("the session overlay wins; an explicit null clears", () => {
    expect(effectiveLabel({ ...base, label: "blue" }, { w4: "green" })).toBe("green");
    expect(effectiveLabel({ ...base, label: "blue" }, { w4: null })).toBeUndefined();
  });

  it("labelColor maps known keys and passes raw color values through", () => {
    expect(labelColor("blue")).toBe("oklch(0.70 0.12 235)");
    expect(labelColor("#ff00ff")).toBe("#ff00ff");
  });
});
