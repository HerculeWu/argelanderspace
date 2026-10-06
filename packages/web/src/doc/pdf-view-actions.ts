/**
 * The PDF Reader's controls as the Copilot presses them (copilot ticket 20), as ONE pure mapping from an action and the
 * Reader's current state to calls on the Reader's own controls. No React, no SDK: the mapping (zero-based API to the
 * one-based SDK page number, the controls disabled at the ends, what the search list offers, which outline entries
 * may be opened) is tested directly, and PdfReader only supplies the real controls as `deps`.
 */
import type { ReaderViewAction } from "@argelanderspace/contracts";
import { pdfTargetPageIndex } from "./pdf-navigation";

/** The search list shows this many results (the Reader's own list); `open_search_result` can reach those. */
export const PDF_SEARCH_LIST_MAX = 20;

export type PdfViewResult = { ok: boolean; detail?: "not_found" | "unavailable" | "disabled"; /** set_panel: the other panel the unfolding folded. */ folded?: "outline" | "right" };

export interface PdfViewState {
  /** Zero-based page the viewer is on. */
  currentPageIndex: number;
  pageCount: number;
  outlineIds: readonly string[];
  /** In-document or external targets of the outline, by entry id (what the panel would navigate to). */
  outlineTargets: ReadonlyMap<string, unknown>;
  searchLoading: boolean;
  /** Results the search found (the list shows at most PDF_SEARCH_LIST_MAX of them). */
  searchResultCount: number;
}

export interface PdfViewDeps {
  /** Pages are ONE-based here: the SDK's own numbering, as the toolbar's page box passes it. */
  scroll: {
    scrollToPage: (pageNumber: number) => void;
    scrollToNextPage: () => void;
    scrollToPreviousPage: () => void;
  } | null;
  zoom: { zoomIn: () => void; zoomOut: () => void; fit: (mode: "fit_width" | "fit_page") => void } | null;
  search: { run: (query: string) => boolean; open: (index: number) => "ok" | "not_found" | "unavailable" } | null;
  navigateTarget: (target: unknown) => void;
  openAnnotation: (annotationId: string) => "ok" | "not_found" | "unavailable";
  setPanel: (panel: "outline" | "right", collapsed: boolean) => "outline" | "right" | null;
  /** The user's own navigation marker: the reading position is saved after it, and a restore stops. */
  markUserNavigation: () => void;
}

const ok: PdfViewResult = { ok: true };
const refuse = (detail: NonNullable<PdfViewResult["detail"]>): PdfViewResult => ({ ok: false, detail });

export function runPdfViewAction(action: ReaderViewAction, state: PdfViewState, deps: PdfViewDeps): PdfViewResult {
  switch (action.action) {
    case "goto_page":
      if (action.pageIndex >= state.pageCount) return refuse("not_found");
      if (!deps.scroll) return refuse("unavailable");
      deps.markUserNavigation();
      deps.scroll.scrollToPage(action.pageIndex + 1);
      return ok;
    case "next_page":
      if (!deps.scroll) return refuse("unavailable");
      if (state.currentPageIndex + 1 >= state.pageCount) return refuse("disabled");
      deps.markUserNavigation();
      deps.scroll.scrollToNextPage();
      return ok;
    case "previous_page":
      if (!deps.scroll) return refuse("unavailable");
      if (state.currentPageIndex <= 0) return refuse("disabled");
      deps.markUserNavigation();
      deps.scroll.scrollToPreviousPage();
      return ok;
    case "open_outline_item": {
      if (!state.outlineIds.includes(action.outlineId)) return refuse("not_found");
      const target = state.outlineTargets.get(action.outlineId);
      // Only entries that go to a page of this document: an external link in an outline is the user's own click.
      if (target === undefined || pdfTargetPageIndex(target) === null) return refuse("disabled");
      deps.markUserNavigation();
      deps.navigateTarget(target);
      return ok;
    }
    case "search":
      if (!deps.search) return refuse("unavailable");
      // The box's Search button is disabled while a search runs.
      if (state.searchLoading) return refuse("disabled");
      return deps.search.run(action.query) ? ok : refuse("unavailable");
    case "open_search_result": {
      if (!deps.search) return refuse("unavailable");
      if (action.index >= Math.min(state.searchResultCount, PDF_SEARCH_LIST_MAX)) return refuse("not_found");
      const opened = deps.search.open(action.index);
      return opened === "ok" ? ok : refuse(opened);
    }
    case "open_annotation": {
      const opened = deps.openAnnotation(action.annotationId);
      return opened === "ok" ? ok : refuse(opened);
    }
    case "zoom":
      if (!deps.zoom) return refuse("unavailable");
      if (action.mode === "in") deps.zoom.zoomIn();
      else if (action.mode === "out") deps.zoom.zoomOut();
      else deps.zoom.fit(action.mode);
      return ok;
    case "set_panel": {
      const folded = deps.setPanel(action.panel, action.collapsed);
      return folded ? { ok: true, folded } : ok;
    }
    case "retry_sync":
      // Nothing to retry in an open Reader.
      return refuse("disabled");
    default:
      // The LaTeX Reader's own controls (anchors, references tabs, back button) do not exist in a PDF Reader.
      return refuse("unavailable");
  }
}

/** The pages a settled selection spans (zero-based, first <= last), whichever way it was dragged. */
export function selectionPageRange(range: { start: { page: number }; end: { page: number } }): { firstPage: number; lastPage: number } {
  return { firstPage: Math.min(range.start.page, range.end.page), lastPage: Math.max(range.start.page, range.end.page) };
}

/**
 * What the page tells the Copilot about the user's unsaved panel text (copilot ticket 21): presence and the blocked
 * state only, never the text. The session keeps a draft per annotation id (`draft:` ids are a new comment being
 * written, `style:` ids are a rectangle's style gesture and are not text). An id the annotations no longer have is
 * still listed: it is the user's text.
 */
export function pdfDraftsView(
  drafts: Readonly<Record<string, string>>,
  annotations: ReadonlyArray<{ id: string; body: string }>,
  blocked: boolean
): { create: boolean; edit: { annotationId: string; blocked: boolean }[] } {
  const bodies = new Map(annotations.map((annotation) => [annotation.id, annotation.body]));
  const edit: { annotationId: string; blocked: boolean }[] = [];
  let create = false;
  for (const [id, text] of Object.entries(drafts)) {
    if (id.startsWith("style:")) continue;
    if (id.startsWith("draft:")) {
      create = true;
      continue;
    }
    if (bodies.get(id) !== text) edit.push({ annotationId: id, blocked });
  }
  return { create, edit };
}
