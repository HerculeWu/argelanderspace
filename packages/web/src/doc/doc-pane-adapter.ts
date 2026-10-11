/**
 * The Doc pane as a pane adapter (copilot ticket 37): the Reader of a LaTeX or text Doc, a PDF Doc's own Reader and a
 * text Doc's source panel. The status is the PDF Reader's when it shows, else the source panel's, else the Reader's:
 * complete only with the reading of an admitted epoch; updating is unavailable, a failed read is an error.
 *
 * Every Reader action names its Doc. When that Doc is not the open one it is opened first through the Shell's own
 * openDoc (leave-draft protection included) and the Reader is given longer, since it has to load. Retry and download
 * are buttons of an open Reader: nothing is opened for them (`existing-only`).
 */
import { type CopilotViewAction, type PdfPage, type ReaderPage, ReaderViewActionSchema, type ReaderViewAction, type TextSourcePage } from "@argelanderspace/contracts";
import { type PaneAdapter, registered, reported, unavailable, type ViewActionOutcome } from "../argelander/panes";
import type { ReaderViewController } from "./reader-bridge";

export interface DocPaneHost {
  /** The Doc the Doc panes show. */
  currentDoc: () => string | null;
  /** The Shell's openDoc for a library Doc, settled. */
  openDoc: (docId: string) => Promise<ViewActionOutcome>;
}

const docOf = (action: CopilotViewAction) => ("docId" in action ? action.docId : null);

export function createDocPane(notify: () => void, host: DocPaneHost) {
  const reader = reported<ReaderPage>(notify);
  const pdf = reported<PdfPage>(notify);
  const text = reported<TextSourcePage>(notify);
  const controller = registered<ReaderViewController>();
  const adapter: PaneAdapter = {
    page: "doc",
    status: () => {
      const pdfPage = pdf.get();
      if (pdfPage) return pdfPage.phase === "ready" ? "complete" : pdfPage.phase === "error" || pdfPage.phase === "changed" ? "error" : "unavailable";
      const textPage = text.get();
      if (textPage) return textPage.phase === "ready" ? "complete" : textPage.phase === "error" ? "error" : "unavailable";
      const readerPage = reader.get();
      return readerPage?.reading ? "complete" : readerPage?.sync.phase === "error" || readerPage?.sync.phase === "missing" ? "error" : "unavailable";
    },
    context: () => ({ reader: reader.get(), pdf: pdf.get(), textSource: text.get() }),
    handles: (action) => ReaderViewActionSchema.safeParse(action).success,
    // Retry has nothing to retry on a Doc that is not open (opening it is the open button, not a retry); download is
    // the PDF Reader's own toolbar button, which only an open Reader has.
    needsPane: (action) => (action.action === "retry_sync" || action.action === "download_original" ? "existing-only" : "any"),
    shows: (action) => host.currentDoc() === docOf(action),
    open: (action) => host.openDoc(docOf(action) ?? ""),
    apply: async (action) => {
      const current = controller.get();
      return current ? current.apply(action as ReaderViewAction) : unavailable();
    },
    timeouts: { readyMs: 0, applyMs: 2000, openedApplyMs: 5000 },
  };
  return { adapter, props: { onContext: reader.set, onPdfContext: pdf.set, onTextContext: text.set, onController: controller.set } };
}
