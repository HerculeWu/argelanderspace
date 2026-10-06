/**
 * What the Writer reports to the Copilot (ticket 22): the page context built from the editor's own state. The saved
 * manuscript is what the server last confirmed (never the local edit); what the user has typed and not saved is the
 * draft, so the two can never be mistaken for each other.
 */
import {
  diffManuscriptDraft,
  type ManuscriptSummary,
  type WriterManuscript,
  type WriterNumberingResponse,
  type WriterPage,
  type WriterTemplate,
} from "@argelanderspace/contracts";

export type WriterEditorPage = NonNullable<WriterPage["editor"]>;

/** The controls of an open editor that a Copilot view action presses (copilot ticket 23). */
export interface WriterEditorControls {
  /** A click on a cell (or an outline row / cross-reference): active and scrolled into view. */
  select(cellId: string): "ok" | "not_found";
  /** The cell's pencil. */
  edit(cellId: string): "ok" | "not_found";
  /** The editing form's Render button / Shift+Enter: leave the form, save what is pending, render. */
  commit(cellId: string): Promise<"ok" | "not_found" | "refused">;
  /** The outline / References panels' fold buttons. */
  setPanel(panel: "outline" | "references", collapsed: boolean): void;
  setTab(tab: "references" | "crossrefs" | "comments"): void;
  /** The template warning's close button; "disabled" when no warning is showing. */
  dismissWarning(): "ok" | "disabled";
  /** The topbar's Export: pending save first, then the download; "blocked" when the save could not complete. */
  exportNow(): Promise<"ok" | "failed" | "blocked">;
}

export function captureEditorPage(input: {
  id: string;
  /** undefined = loading, null = not found. */
  doc: WriterManuscript | null | undefined;
  /** The last manuscript the server confirmed (the saved one). */
  base: WriterManuscript | null;
  templates: WriterTemplate[] | null;
  saveState: "saved" | "saving" | "error";
  activeId: string | null;
  editingId: string | null;
  caret: { cellId: string; field: string; start: number; end: number } | null;
  modal: "info" | "preamble" | null;
  modalDraft?: Record<string, unknown> | null;
  numbering: WriterNumberingResponse | null;
  rendering: boolean;
  panels?: { outlineCollapsed: boolean; referencesCollapsed: boolean; rightTab: "references" | "crossrefs" | "comments"; templateWarnings: number };
}): WriterEditorPage {
  const { doc, templates } = input;
  const phase = doc === undefined || templates === null ? "loading" : doc === null ? "missing" : "ready";
  const saved = phase === "ready" ? (input.base ?? doc ?? null) : null;
  const template = saved && templates ? templates.find((item) => item.id === saved.template) : undefined;
  return {
    manuscriptId: input.id as WriterEditorPage["manuscriptId"],
    phase,
    saved,
    saveState: input.saveState,
    draft: saved && doc ? diffManuscriptDraft(saved, doc) : null,
    template: saved
      ? {
          id: saved.template,
          label: template?.label ?? saved.template,
          found: !!template,
          types: template?.types ?? [],
        }
      : null,
    unsupportedCellIds: saved && template ? saved.cells.filter((cell) => !template.types.includes(cell.type)).map((cell) => cell.id) : [],
    activeCellId: input.activeId,
    editingCellId: input.editingId,
    caret: input.caret,
    modal: input.modal,
    ...(input.panels ? { panels: input.panels } : {}),
    modalDraft: input.modalDraft ? { unsaved: true, values: input.modalDraft } : null,
    preview: {
      status: input.numbering?.status ?? "unknown",
      failed: !!input.numbering?.lastError,
      warnings: input.numbering?.preview?.warnings.length ?? 0,
      rendering: input.rendering,
    },
  };
}

export function captureListPage(input: {
  phase: "loading" | "ready" | "error";
  rows: ManuscriptSummary[];
  templates: WriterTemplate[];
}): WriterPage {
  return {
    mode: "list",
    list: {
      phase: input.phase,
      manuscripts: input.phase === "ready" ? input.rows : [],
      templates: input.templates.map((template) => ({ id: template.id, label: template.label, types: [...template.types] })),
    },
    editor: null,
  };
}

/** How the Shell's page context states a Writer page: complete only with a loaded list or a loaded manuscript. */
export function writerPageStatus(page: WriterPage | null | undefined): "complete" | "unavailable" | "error" {
  if (!page) return "unavailable";
  if (page.list) return page.list.phase === "ready" ? "complete" : page.list.phase === "error" ? "error" : "unavailable";
  const editor = page.editor;
  if (!editor) return "unavailable";
  if (editor.phase === "missing") return "error";
  return editor.phase === "ready" && editor.saved ? "complete" : "unavailable";
}

/**
 * Approving a Copilot manuscript delete would discard unsaved edits of an open editor (or its Info/Preamble dialog):
 * true = go ahead (nothing unsaved, or the user agreed through `confirm`).
 */
export function manuscriptDeleteGuard(
  pages: Iterable<WriterPage | null | undefined>,
  manuscriptId: string,
  confirm: () => boolean
): boolean {
  for (const page of pages) {
    const editor = page?.editor;
    if (editor?.manuscriptId === manuscriptId && (!!editor.draft || editor.saveState !== "saved" || !!editor.modalDraft))
      return confirm();
  }
  return true;
}

/**
 * The Writer's side panels at their full width, and the narrowest reading column they may leave (ticket 18's rule).
 * The Writer keeps this 240 px rule alone: its panels fold by width only, and unfolding one never folds the other
 * (the Reader's floor rule, ticket 32, does not apply here).
 */
const WRITER_PANEL_FULL = { left: 220, right: 310, rail: 34 };
export const WRITER_MIN_COLUMN = 240;
/**
 * Which side panels fold on their own for a Writer pane of this width: none while the paper keeps its minimum with
 * both open; else the outline; else both. The same order and the same 240 px threshold as the Reader's automatic fold;
 * a panel the user or the Copilot unfolds by hand then stays as asked.
 */
export function writerAutoFold(width: number | null): { left: boolean; right: boolean } {
  if (!width) return { left: false, right: false };
  if (width - WRITER_PANEL_FULL.left - WRITER_PANEL_FULL.right >= WRITER_MIN_COLUMN) return { left: false, right: false };
  if (width - WRITER_PANEL_FULL.rail - WRITER_PANEL_FULL.right >= WRITER_MIN_COLUMN) return { left: true, right: false };
  return { left: true, right: true };
}
