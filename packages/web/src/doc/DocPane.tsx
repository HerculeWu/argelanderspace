import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ReaderSession, useReaderSession } from "./ReaderSession";
import { RetainedDrafts } from "./RetainedDrafts";
import { StoreProvider, useStore, useCanUndo } from "../store";
import { AnnotationProvider, useAnnotations } from "../annotations/AnnotationStore";
import { Reader } from "../components/Reader";
import { TocPanel } from "../components/TocPanel";
import { RightPanel } from "../components/RightPanel";
import { MathText } from "../lib/segments";
import { applyAnchor, applyAnnotationAnchor, isAnnotationAnchor } from "../lib/deeplink";
import { useWorkspace } from "../argelander/workspace";
import { fetchDocDescription } from "../api/doc";
import type { DocDescription } from "@argelanderspace/contracts";
import { PdfReader } from "./PdfReader";

// The document reader, hosted as ArgelanderSpace's Doc pane. Which paper is shown
// is driven by the shared workspace (so the Library's "open in Doc" works);
// the in-pane switcher changes it too.
export function DocPane() {
  const ws = useWorkspace();
  const { t } = useTranslation();
  const id = ws.currentDoc;
  if (!id) return <div className="reader-root" data-ui="doc-empty"><div className="loading">{t("doc.empty")}</div></div>;
  return <DocReadingEntry key={id} docId={id} />;
}

type DescriptionState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; description: DocDescription };

function DocReadingEntry({ docId }: { docId: string }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DescriptionState>({ phase: "loading" });
  useEffect(() => {
    const abort = new AbortController();
    setState({ phase: "loading" });
    void fetchDocDescription(docId, abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      setState(result.ok ? { phase: "ready", description: result.description } : { phase: "error" });
    });
    return () => abort.abort();
  }, [docId, attempt]);

  if (state.phase === "loading") return <div className="reader-root" data-ui="doc-loading" data-ui-key={docId}><div className="loading">{t("doc.loadingPaper")}</div></div>;
  if (state.phase === "error") return <div className="reader-root" data-ui="doc-error" data-ui-key={docId}><div role="alert">
    {t("doc.sync.error")}
    <button data-ui="retry-doc" onClick={() => setAttempt((current) => current + 1)}>{t("doc.sync.manualRetry")}</button>
  </div></div>;
  switch (state.description.format) {
    case "latex":
      return <ReaderSession docId={docId}><SessionWorkspace /></ReaderSession>;
    case "pdf":
      return <div className="reader-root" data-ui="pdf-doc" data-ui-key={docId}><PdfReader key={`${docId}:${state.description.sha256}`} docId={docId} description={state.description} /></div>;
  }
}

function SessionWorkspace() {
  const ws = useWorkspace();
  const { state, controller } = useReaderSession();
  const { t } = useTranslation();
  const ir = state.accepted?.ir;
  return <div className="reader-session" data-ui="latex-session" data-ui-key={controller.docId}>
    {state.phase !== "ready" && <div className="reader-sync-status" role="status" data-ui="latex-sync-status">
      {state.phase === "missing" ? t("doc.sync.missing") : state.phase === "error" ? (ir ? t("doc.sync.errorRetained") : t("doc.sync.error")) : state.reason === "busy" ? t("doc.sync.busy") : ir ? t("doc.sync.updatingRetained") : t("doc.sync.loading")}
      <button data-ui="retry-latex-sync" onClick={controller.retry}>{t("doc.sync.manualRetry")}</button>
    </div>}
    <RetainedDrafts />
    {ir && state.phase !== "missing" ? <StoreProvider ir={ir} anchorPending={!!ws.pendingAnchor}>
      <AnnotationProvider><DocWorkspace papers={ws.papers} currentId={ir.docId} onSelect={ws.setCurrentDoc} /></AnnotationProvider>
    </StoreProvider> : !ir && state.phase === "syncing" && <div className="loading">{t("doc.loadingPaper")}</div>}
  </div>;
}

function DocWorkspace({
  papers,
  currentId,
  onSelect,
}: {
  papers: string[];
  currentId: string;
  onSelect: (id: string) => void;
}) {
  const { ir } = useStore();
  const { canAnnotate } = useReaderSession();
  const store = useStore();
  const ws = useWorkspace();
  const { t } = useTranslation();
  const [collapsedLeft, setCollapsedLeft] = useState(false);
  const [collapsedRight, setCollapsedRight] = useState(false);

  // Deep link: land on the URL's #anchor once the doc has rendered (the blocks
  // are in the DOM by the time this effect runs). Unknown anchors just leave
  // the doc open at the top. `#ann-<id>` anchors are NOT handled here — they
  // resolve in AnnotationDeepLink once the annotations have loaded.
  const anchor = ws.pendingAnchor;
  const consumedAnchor = useRef<string | null>(null);
  useEffect(() => {
    if (!anchor) { consumedAnchor.current = null; return; }
    if (isAnnotationAnchor(anchor) || !canAnnotate || consumedAnchor.current === anchor) return;
    consumedAnchor.current = anchor;
    ws.clearPendingAnchor();
    applyAnchor(store, anchor);
  }, [anchor, store, ws, canAnnotate]);

  // ref/fig counts are derived from the IR; the page count rides it (nPages)
  const nFigs = ir.refsManifest.filter((r) => r.kind === "figure").length;

  return (
    <div className="reader-root" data-ui="latex-reader" data-ui-key={currentId}>
      <header className="topbar" data-ui="latex-toolbar">
        <h1 title={ir.title}>
          {ir.title ? <MathText as="span" text={ir.title} /> : ir.docId}
        </h1>
        {papers.length > 1 && (
          <select
            className="paper-switch"
            data-ui="switch-doc"
            value={currentId}
            onChange={(e) => onSelect(e.target.value)}
            title={t("doc.switchPaper")}
          >
            {papers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        <span className="doc-meta">
          {ir.nPages !== undefined && t("doc.metaPages", { n: ir.nPages })}
          {t("doc.metaRefsFigs", { refs: ir.bib.length, figs: nFigs })}
        </span>
      </header>

      <span className="reader-position-note">{t("doc.positionNote")}</span>
      <div className="reader-main" data-ui="latex-reader-layout">
        <aside data-ui="latex-outline-panel" className={"panel left" + (collapsedLeft ? " collapsed" : "")}>
          <button
            className="panel-toggle"
            data-ui="toggle-latex-outline"
            title={collapsedLeft ? t("doc.expandContents") : t("doc.collapseContents")}
            onClick={() => setCollapsedLeft((v) => !v)}
          >
            {collapsedLeft ? "»" : "«"}
          </button>
          <span className="rail-label">{t("doc.railContents")}</span>
          <div className="panel-body">
            <TocPanel />
          </div>
        </aside>

        <div className="reader-col" data-ui="latex-document-area">
          <Reader />
          <UndoFab />
          <AnnotationToast />
        </div>

        <aside data-ui="latex-right-panel" className={"panel right" + (collapsedRight ? " collapsed" : "")}>
          <button
            className="panel-toggle"
            data-ui="toggle-latex-right-panel"
            title={collapsedRight ? t("doc.expandRefs") : t("doc.collapseRefs")}
            onClick={() => setCollapsedRight((v) => !v)}
          >
            {collapsedRight ? "«" : "»"}
          </button>
          <span className="rail-label">{t("doc.railRefs")}</span>
          <div className="panel-body">
            <RightPanel />
          </div>
        </aside>
      </div>
      <AnnotationDeepLink />
    </div>
  );
}

/** Stage 8: resolve an `#ann-<id>` deep link once BOTH the IR and the
 *  annotations file have loaded — jump to the target block, activate the
 *  annotation, open its popover. Unknown/deleted ids are consumed silently
 *  (the unknown-anchor philosophy: no archive search, no migration). */
function AnnotationDeepLink() {
  const ws = useWorkspace();
  const store = useStore();
  const ann = useAnnotations();
  const anchor = ws.pendingAnchor;
  const consumedAnchor = useRef<string | null>(null);
  useEffect(() => {
    if (!anchor) { consumedAnchor.current = null; return; }
    if (!isAnnotationAnchor(anchor) || consumedAnchor.current === anchor) return;
    if (!ann.canAnnotate) return;
    consumedAnchor.current = anchor; // annotations not loaded yet — wait
    ws.clearPendingAnchor();
    applyAnnotationAnchor(store, ann, anchor);
  }, [anchor, ann, store, ws]);
  return null;
}

/** Transient annotation notice (409 reloads / save failures), mirroring the
 *  plan page's notice toast. */
function AnnotationToast() {
  const ann = useAnnotations();
  const { t } = useTranslation();
  if (!ann.notice) return null;
  return (
    <div className="ann-toast view-in" role="status" data-ui="latex-annotation-notice">
      <span>{ann.notice}</span>
      <button data-ui="dismiss-annotation-notice" className="ann-toast-x" title={t("common.close")} onClick={ann.dismissNotice}>
        ×
      </button>
    </div>
  );
}

function UndoFab() {
  const store = useStore();
  const { t } = useTranslation();
  const canUndo = useCanUndo();
  if (!canUndo) return null;
  return (
    <button data-ui="undo-latex-navigation" className="undo-fab" onClick={store.undo} title={t("doc.undoTitle")}>
      {t("doc.undoBack")}
    </button>
  );
}
