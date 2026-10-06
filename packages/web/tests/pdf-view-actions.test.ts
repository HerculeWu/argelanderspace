/**
 * The PDF Reader's controls as the Copilot presses them: the pure mapping of an action to the Reader's own controls
 * (zero-based API to the SDK's one-based page number, controls disabled at the ends, the search list's limits, which
 * outline entries may be opened, which pages a selection spans).
 */
import { PdfActionType, PdfZoomMode, type PdfLinkTarget } from "@embedpdf/models";
import type { ReaderViewAction } from "@argelanderspace/contracts";
import { describe, expect, it, vi } from "vitest";
import { PDF_SEARCH_LIST_MAX, type PdfViewDeps, type PdfViewState, runPdfViewAction, selectionPageRange } from "../src/doc/pdf-view-actions";

const D = "doc";
const destination = (pageIndex: number): PdfLinkTarget => ({ type: "destination", destination: { pageIndex, zoom: { mode: PdfZoomMode.Unknown }, view: [] } });
const external: PdfLinkTarget = { type: "action", action: { type: PdfActionType.URI, uri: "https://example.org/x" } } as PdfLinkTarget;
const state = (over: Partial<PdfViewState> = {}): PdfViewState => ({
  currentPageIndex: 3,
  pageCount: 12,
  outlineIds: ["pdf-outline-0", "pdf-outline-1", "pdf-outline-2"],
  outlineTargets: new Map<string, unknown>([["pdf-outline-0", destination(5)], ["pdf-outline-1", external]]),
  searchLoading: false,
  searchResultCount: 30,
  ...over,
});
function deps(over: Partial<PdfViewDeps> = {}) {
  const calls: unknown[][] = [];
  const log = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  const d: PdfViewDeps = {
    scroll: { scrollToPage: log("scrollToPage"), scrollToNextPage: log("next"), scrollToPreviousPage: log("previous") },
    zoom: { zoomIn: log("zoomIn"), zoomOut: log("zoomOut"), fit: log("fit") },
    search: { run: (q) => { calls.push(["search", q]); return true; }, open: (i) => { calls.push(["open", i]); return "ok"; } },
    navigateTarget: log("navigate"),
    openAnnotation: (id) => { calls.push(["annotation", id]); return id === "pann_1" ? "ok" : "not_found"; },
    setPanel: (...args: [string, boolean]) => { calls.push(["panel", ...args]); return null; },
    markUserNavigation: log("mark"),
    ...over,
  };
  return { d, calls };
}
const run = (action: ReaderViewAction, s = state(), over: Partial<PdfViewDeps> = {}) => { const { d, calls } = deps(over); return { result: runPdfViewAction(action, s, d), calls }; };

describe("pages", () => {
  it("goto_page is ZERO-based in the action and ONE-based for the SDK, and takes the user's navigation marker", () => {
    expect(run({ action: "goto_page", docId: D, pageIndex: 0 })).toEqual({ result: { ok: true }, calls: [["mark"], ["scrollToPage", 1]] });
    expect(run({ action: "goto_page", docId: D, pageIndex: 11 }).calls).toEqual([["mark"], ["scrollToPage", 12]]);
    expect(run({ action: "goto_page", docId: D, pageIndex: 12 })).toEqual({ result: { ok: false, detail: "not_found" }, calls: [] });
  });
  it("next and previous are disabled at the ends exactly as the buttons are, and unavailable without a scroller", () => {
    expect(run({ action: "next_page", docId: D }).calls).toEqual([["mark"], ["next"]]);
    expect(run({ action: "next_page", docId: D }, state({ currentPageIndex: 11 })).result).toEqual({ ok: false, detail: "disabled" });
    expect(run({ action: "previous_page", docId: D }, state({ currentPageIndex: 0 })).result).toEqual({ ok: false, detail: "disabled" });
    expect(run({ action: "previous_page", docId: D }).calls).toEqual([["mark"], ["previous"]]);
    expect(run({ action: "next_page", docId: D }, state(), { scroll: null }).result).toEqual({ ok: false, detail: "unavailable" });
  });
});

describe("the outline", () => {
  it("opens an entry that goes to a page of the document", () => {
    expect(run({ action: "open_outline_item", docId: D, outlineId: "pdf-outline-0" }).calls).toEqual([["mark"], ["navigate", destination(5)]]);
  });
  it("never opens an external link of the outline: that is the user's own click (disabled), and nothing is navigated", () => {
    const { result, calls } = run({ action: "open_outline_item", docId: D, outlineId: "pdf-outline-1" });
    expect(result).toEqual({ ok: false, detail: "disabled" });
    expect(calls).toEqual([]);
  });
  it("an entry without a target is disabled, an unknown entry is not found", () => {
    expect(run({ action: "open_outline_item", docId: D, outlineId: "pdf-outline-2" }).result).toEqual({ ok: false, detail: "disabled" });
    expect(run({ action: "open_outline_item", docId: D, outlineId: "pdf-outline-9" }).result).toEqual({ ok: false, detail: "not_found" });
  });
});

describe("search", () => {
  it("runs the box's search; refused while one is running, as the button is disabled then", () => {
    expect(run({ action: "search", docId: D, query: "x" }).calls).toEqual([["search", "x"]]);
    expect(run({ action: "search", docId: D, query: "x" }, state({ searchLoading: true })).result).toEqual({ ok: false, detail: "disabled" });
  });
  it("open_search_result reaches only what the list shows: the first 20 results", () => {
    expect(PDF_SEARCH_LIST_MAX).toBe(20);
    expect(run({ action: "open_search_result", docId: D, index: 19 }).calls).toEqual([["open", 19]]);
    expect(run({ action: "open_search_result", docId: D, index: 20 }).result).toEqual({ ok: false, detail: "not_found" });
    expect(run({ action: "open_search_result", docId: D, index: 4 }, state({ searchResultCount: 4 })).result).toEqual({ ok: false, detail: "not_found" });
    expect(run({ action: "open_search_result", docId: D, index: 0 }, state({ searchResultCount: 0 })).result).toEqual({ ok: false, detail: "not_found" });
  });
});

describe("the other controls", () => {
  it("zoom, panels, annotations", () => {
    expect(run({ action: "zoom", docId: D, mode: "in" }).calls).toEqual([["zoomIn"]]);
    expect(run({ action: "zoom", docId: D, mode: "out" }).calls).toEqual([["zoomOut"]]);
    expect(run({ action: "zoom", docId: D, mode: "fit_page" }).calls).toEqual([["fit", "fit_page"]]);
    expect(run({ action: "zoom", docId: D, mode: "fit_width" }, state(), { zoom: null }).result).toEqual({ ok: false, detail: "unavailable" });
    expect(run({ action: "set_panel", docId: D, panel: "outline", collapsed: true }).calls).toEqual([["panel", "outline", true]]);
    expect(run({ action: "open_annotation", docId: D, annotationId: "pann_1" }).result).toEqual({ ok: true });
    expect(run({ action: "open_annotation", docId: D, annotationId: "pann_x" }).result).toEqual({ ok: false, detail: "not_found" });
  });
  it("set_panel reports the other panel an unfold folded (the floor rule)", () => {
    const { result } = run({ action: "set_panel", docId: D, panel: "outline", collapsed: false }, state(), { setPanel: () => "right" });
    expect(result).toEqual({ ok: true, folded: "right" });
  });
  it("retry has nothing to retry in an open Reader; the LaTeX Reader's controls do not exist here", () => {
    expect(run({ action: "retry_sync", docId: D }).result).toEqual({ ok: false, detail: "disabled" });
    for (const action of [{ action: "navigate", docId: D, anchor: "sec-1" }, { action: "jump_back", docId: D }, { action: "set_right_tab", docId: D, tab: "annotations" }] as const)
      expect(run(action).result).toEqual({ ok: false, detail: "unavailable" });
  });
});

describe("a selection's pages", () => {
  it("are first <= last whichever way it was dragged", () => {
    expect(selectionPageRange({ start: { page: 2 }, end: { page: 5 } })).toEqual({ firstPage: 2, lastPage: 5 });
    expect(selectionPageRange({ start: { page: 5 }, end: { page: 2 } })).toEqual({ firstPage: 2, lastPage: 5 });
    expect(selectionPageRange({ start: { page: 0 }, end: { page: 0 } })).toEqual({ firstPage: 0, lastPage: 0 });
  });
});
void vi;
