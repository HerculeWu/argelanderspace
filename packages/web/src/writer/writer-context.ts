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
  numbering: WriterNumberingResponse | null;
  rendering: boolean;
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
