/**
 * The Reader's side panels fold on their own when the pane is too narrow to keep a reading column (user ruling
 * 2026-10-05): the outline first, then the right panel; the folded state is the one the toggles show, a manual choice
 * wins until the pane's width class changes, and a pane that is wide enough is untouched.
 */
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { TexDocIr } from "@argelanderspace/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProvider, type Workspace } from "../src/argelander/workspace";
import { DocPane, MIN_READING_COLUMN, autoFold } from "../src/doc/DocPane";

vi.mock("../src/api/ws", () => ({ onLibraryChanged: () => () => {}, onAnnotationChanged: () => () => {} }));

describe("autoFold", () => {
  it("keeps the layout while the column keeps its minimum, folds the outline first, then both", () => {
    expect(autoFold(null)).toEqual({ left: false, right: false });
    expect(autoFold(290 + 380 + MIN_READING_COLUMN)).toEqual({ left: false, right: false });
    expect(autoFold(290 + 380 + MIN_READING_COLUMN - 1)).toEqual({ left: true, right: false });
    expect(autoFold(34 + 380 + MIN_READING_COLUMN - 1)).toEqual({ left: true, right: true });
    expect(autoFold(612)).toEqual({ left: true, right: true });
  });
  it("the minimum is the 480 px reading column of ticket 32 (1440 with Copilot, pane 996, folds the outline)", () => {
    expect(MIN_READING_COLUMN).toBe(480);
    expect(autoFold(996)).toEqual({ left: true, right: false });
  });
});

const ir: TexDocIr = {
  version: 1,
  docId: "d",
  title: "T",
  source: { type: "latex", origin: "x", main_tex: "m.tex" },
  meta: {},
  sections: [{ id: "sec-1", level: 1, heading: "H", blocks: [{ id: "p-1", type: "paragraph", segments: [{ type: "text", text: "Body" }] }], children: [] }],
  refsManifest: [],
  bib: [],
  citationsByBlock: {},
};
let width = 1000;
const observers = new Set<() => void>();
class RO {
  constructor(private cb: () => void) {}
  observe() {
    observers.add(this.cb);
  }
  unobserve() {}
  disconnect() {
    observers.delete(this.cb);
  }
}
const real = Element.prototype.getBoundingClientRect;
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("IntersectionObserver", class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this.classList.contains("reader-main") ? ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON() {} } as DOMRect) : real.call(this);
  };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/paper/d/description") return { ok: true, json: async () => ({ doc_id: "d", format: "latex" }) } as Response;
    if (url.endsWith("coherent=1")) return { ok: true, status: 200, json: async () => ({ version: 1, ir, file: { version: 1, rev: 0, content_fingerprint: "fp", annotations: [] }, assets: [] }) } as Response;
    return { ok: false, status: 404, json: async () => ({}) } as unknown as Response;
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Element.prototype.getBoundingClientRect = real;
  observers.clear();
});
const ws: Workspace = { papers: ["d"], currentDoc: "d", setCurrentDoc: vi.fn(), openDoc: vi.fn(), pendingAnchor: null, clearPendingAnchor: vi.fn(), docDeleted: () => {}, tweaks: { theme: "dark", accent: "azure", density: "regular", labels: true } };
const folded = (key: "latex-outline-panel" | "latex-right-panel") => document.querySelector(`[data-ui="${key}"]`)?.classList.contains("collapsed");
const resize = async (next: number) => {
  width = next;
  await act(async () => { for (const cb of [...observers]) cb(); });
};
async function mount(initial: number) {
  width = initial;
  render(<WorkspaceProvider value={ws}><DocPane /></WorkspaceProvider>);
  await waitFor(() => expect(document.querySelector('[data-ui="latex-reader"]')).not.toBeNull());
}

describe("the Reader pane", () => {
  it("is untouched while it is wide enough (the width a closed Copilot leaves at 1280)", async () => {
    await mount(1200);
    expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([false, false]);
  });
  it("folds the outline, then both panels, as the pane narrows, and unfolds them as it widens", async () => {
    await mount(1400);
    await resize(900);
    await waitFor(() => expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([true, false]));
    await resize(612);
    await waitFor(() => expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([true, true]));
    await resize(1400);
    await waitFor(() => expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([false, false]));
  });
  it("the user's own fold or unfold wins over the automatic one until the width class changes", async () => {
    await mount(612);
    await waitFor(() => expect(folded("latex-outline-panel")).toBe(true));
    fireEvent.click(document.querySelector('[data-ui="toggle-latex-outline"]') as HTMLElement);
    await waitFor(() => expect(folded("latex-outline-panel")).toBe(false));
    await resize(620); // same width class: the choice stays
    expect(folded("latex-outline-panel")).toBe(false);
    await resize(1400);
    await resize(612); // a new narrow phase is automatic again
    await waitFor(() => expect(folded("latex-outline-panel")).toBe(true));
  });
  it("keeps the article from being squeezed out: unfolding the second panel folds the first (either order)", async () => {
    await mount(612); // both fold on their own
    await waitFor(() => expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([true, true]));
    fireEvent.click(document.querySelector('[data-ui="toggle-latex-outline"]') as HTMLElement);
    await waitFor(() => expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([false, true]));
    fireEvent.click(document.querySelector('[data-ui="toggle-latex-right-panel"]') as HTMLElement);
    await waitFor(() => expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([true, false]));
    fireEvent.click(document.querySelector('[data-ui="toggle-latex-outline"]') as HTMLElement);
    await waitFor(() => expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([false, true]));
  });
  it("lets both panels be open when the pane really has room for both", async () => {
    await mount(1300);
    fireEvent.click(document.querySelector('[data-ui="toggle-latex-outline"]') as HTMLElement);
    fireEvent.click(document.querySelector('[data-ui="toggle-latex-outline"]') as HTMLElement);
    expect([folded("latex-outline-panel"), folded("latex-right-panel")]).toEqual([false, false]);
  });
});
