/**
 * LibraryView side list (Stage 3 / MS3): the color dot reads the persisted
 * `label` field (star→amber seeding only when no label is set), and read refs
 * get the dimmed title + "已读" marker. The library payload is served through
 * the real `api/library` module over a stubbed global fetch; `api/ws` is
 * mocked away (no WebSocket in tests).
 */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { effectiveLabel, labelColor, LibraryView } from "../src/library/LibraryView";
import type { LibraryData, LibraryRef } from "../src/library/types";

vi.mock("../src/api/ws", () => ({
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
