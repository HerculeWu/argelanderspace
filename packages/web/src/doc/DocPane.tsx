import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { DocLeaveScope, useUnsavedSource } from "../argelander/leave-dialog";
import { ReaderArgumentEntry } from "../argument/ArgumentEntry";
import { fetchDocDescription } from "../api/doc";
import { onTextDocPublished } from "../api/ws";
import type { DocDescription, PdfPage, ReaderPage, ReaderPanel, ReaderRightTab, TextSourcePage } from "@argelanderspace/contracts";
import { PdfReader } from "./PdfReader";
import { autoFold, MIN_READING_COLUMN, useAutoFoldedPanels } from "./auto-fold";
import { TextDocPane, TextPublishSync } from "./TextDocPane";
import { ActionButton, Select } from "../ui";
import { PdfBridgeContext, type PdfBridge, type PdfViewHandle, ReaderBridgeContext, type ReaderViewController, useReaderBridge, useReaderPublisher } from "./reader-bridge";
import { useActiveSectionId, useVisibleIds } from "../store";

// The document reader, hosted as ArgelanderSpace's Doc pane. Which paper is shown
// is driven by the shared workspace (so the Library's "open in Doc" works);
// the in-pane switcher changes it too.
export function DocPane({ paneId = 0, onContext, onPdfContext, onTextContext, onController }: {
  /** The pane this Reader lives in; what it reports and the controller it registers are for that pane (Copilot ticket 18). */
  paneId?: number;
  onContext?: (paneId: number, page: ReaderPage | null) => void;
  /** The PDF Reader's page for the Copilot (ticket 20). */
  onPdfContext?: (paneId: number, page: PdfPage | null) => void;
  /** A text Doc's source panel for the Copilot (ticket 29). */
  onTextContext?: (paneId: number, page: TextSourcePage | null) => void;
  onController?: (paneId: number, controller: ReaderViewController | null) => void;
} = {}) {
  const ws = useWorkspace();
  const { t } = useTranslation();
  const id = ws.currentDoc;
  const current = useRef(id);
  current.current = id;
  const pdfHandle = useRef<PdfViewHandle | null>(null);
  const bridge = useReaderPublisher(paneId, onContext, onController, () => current.current, pdfHandle);
  const pdfPublish = useRef(onPdfContext);
  pdfPublish.current = onPdfContext;
  const textPublish = useRef(onTextContext);
  textPublish.current = onTextContext;
  const publishText = useCallback((page: TextSourcePage | null) => textPublish.current?.(paneId, page), [paneId]);
  const pdfBridge = useMemo<PdfBridge>(() => ({
    publish: (page) => pdfPublish.current?.(paneId, page),
    setHandle: (handle) => { pdfHandle.current = handle; },
  }), [paneId]);
  if (!id) return <div className="reader-root" data-ui="doc-empty"><div className="loading">{t("doc.empty")}</div></div>;
  return <ReaderBridgeContext.Provider value={bridge}><PdfBridgeContext.Provider value={pdfBridge}><DocReadingEntry key={id} docId={id} publishText={publishText} /></PdfBridgeContext.Provider></ReaderBridgeContext.Provider>;
}

type DescriptionState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready"; description: DocDescription };

function DocReadingEntry({ docId, publishText }: { docId: string; publishText: (page: TextSourcePage | null) => void }) {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DescriptionState>({ phase: "loading" });
  const bridge = useReaderBridge();
  // The load-error page's Retry is offered to the Copilot for as long as that page is shown.
  useEffect(() => {
    if (state.phase !== "error") return;
    const withdraw = bridge.addRetry(() => setAttempt((current) => current + 1));
    // the page says the Doc failed to load (an error with its reason), like the sync banner does
    bridge.setFailure(docId);
    return () => { withdraw(); bridge.setFailure(null); };
  }, [bridge, docId, state.phase]);
  // A Doc without a LaTeX session (loading, load error, PDF) has no Reader page to report.
  useEffect(() => {
    if (state.phase === "ready" && (state.description.format === "latex" || state.description.format === "text")) return;
    bridge.setSession(docId, null);
  }, [bridge, docId, state]);
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
    <ActionButton mode="text" label={t("doc.sync.manualRetry")} tooltip={t("doc.sync.manualRetry")} data-ui="retry-doc" onClick={() => setAttempt((current) => current + 1)}>{t("doc.sync.manualRetry")}</ActionButton>
  </div></div>;
  switch (state.description.format) {
    case "latex":
      return <DocLeaveScope><ReaderSession docId={docId}><SessionWorkspace /></ReaderSession></DocLeaveScope>;
    case "text":
      // The shared Reader on the last generated reading text; its admitted epoch and the source panel are offered to the Copilot.
      return <DocLeaveScope><TextDocPane key={docId} docId={docId} description={state.description} onPage={publishText} reader={<ReaderSession docId={docId}><TextPublishSync docId={docId} /><SessionWorkspace format="text" afterPublish /></ReaderSession>} /></DocLeaveScope>;
    case "pdf":
      return <DocLeaveScope><div className="reader-root" data-ui="pdf-doc" data-ui-key={docId}><PdfReader key={`${docId}:${state.description.sha256}`} docId={docId} description={state.description} /></div></DocLeaveScope>;
  }
}

/**
 * `afterPublish` (a text Doc): a sync failure after the server announced a new reading version is reported as exactly
 * that: published, but this view could not load it (the old text stays, nothing is rolled back).
 */
function SessionWorkspace({ publish = true, afterPublish = false, format = "latex" }: { publish?: boolean; afterPublish?: boolean; format?: "latex" | "text" } = {}) {
  const ws = useWorkspace();
  const { state, controller } = useReaderSession();
  const { t } = useTranslation();
  const bridge = useReaderBridge();
  // Annotation drafts live and die with this Reader (docs/annotations.md): leaving the Doc view asks first (the Doc's one
  // leave question: the app's dialog for the person, a refusal for the Copilot) and closing the page gets the browser's own prompt.
  const leaveDialog = useUnsavedSource(() => (controller.hasUnsavedDraft() ? t("doc.drafts.unsavedLeave") : null));
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.hasUnsavedDraft()) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [controller]);
  const ir = state.accepted?.ir;
  const [publishedSinceReady, setPublishedSinceReady] = useState(false);
  useEffect(() => (afterPublish ? onTextDocPublished((message) => { if (message.doc_id === controller.docId) setPublishedSinceReady(true); }) : undefined), [afterPublish, controller]);
  useEffect(() => { if (state.phase === "ready") setPublishedSinceReady(false); }, [state.phase]);
  // The admitted epoch (never the mounted DOM) is what the Copilot reads; every state change is published.
  useEffect(() => { if (publish) bridge.setSession(controller.docId, state, format); }, [bridge, controller, state, publish, format]);
  useEffect(() => () => { if (publish) bridge.setSession(controller.docId, null); }, [bridge, controller, publish]);
  // The banner's Retry (and the annotations panel's) is the same controller.retry the Copilot may press.
  useEffect(() => {
    if (!publish || state.phase === "ready") return;
    return bridge.addRetry(controller.retry);
  }, [bridge, controller, state.phase, publish]);
  return <div className="reader-session" data-ui="latex-session" data-ui-key={controller.docId}>
    {state.phase !== "ready" && <div className="reader-sync-status" role="status" data-ui="latex-sync-status">
      {state.phase === "missing" ? t("doc.sync.missing") : state.phase === "error" ? (publishedSinceReady ? t("doc.text.syncAfterPublish") : ir ? t("doc.sync.errorRetained") : t("doc.sync.error")) : state.reason === "busy" ? t("doc.sync.busy") : ir ? t("doc.sync.updatingRetained") : t("doc.sync.loading")}
      <ActionButton mode="text" label={t("doc.sync.manualRetry")} tooltip={t("doc.sync.manualRetry")} data-ui="retry-latex-sync" onClick={controller.retry}>{t("doc.sync.manualRetry")}</ActionButton>
    </div>}
    <RetainedDrafts />
    {ir && state.phase !== "missing" ? <StoreProvider ir={ir} anchorPending={!!ws.pendingAnchor}>
      <AnnotationProvider><DocWorkspace papers={ws.papers} currentId={ir.docId} onSelect={ws.setCurrentDoc} /></AnnotationProvider>
    </StoreProvider> : !ir && state.phase === "syncing" && <div className="loading">{t("doc.loadingPaper")}</div>}
    {leaveDialog}
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
  // The two panels fold on their own when the pane is too narrow to keep a reading column (see autoFold); what the
  // user (or the Copilot) sets by hand wins until the pane's width class changes, except that unfolding a panel which
  // would leave the article under MIN_READING_COLUMN folds the other one. The folds shown are the effective ones.
  const mainRef = useRef<HTMLDivElement>(null);
  const { collapsedLeft, collapsedRight, setCollapsedLeft, setCollapsedRight, setPanelCollapsed } = useAutoFoldedPanels(mainRef);
  // Owned here (not by the right panel) so the Copilot's tab control is the user's own tab control.
  const [rightTab, setRightTab] = useState<"refs" | "annotations">("refs");
  const bridge = useReaderBridge();
  useEffect(() => {
    bridge.setPanels({ outlineCollapsed: collapsedLeft, rightCollapsed: collapsedRight, rightTab: rightTab === "refs" ? "references" : "annotations" });
  }, [bridge, collapsedLeft, collapsedRight, rightTab]);
  useEffect(() => () => bridge.setPanels(null), [bridge]);
  // Returns the other panel when unfolding this one folded it (the Copilot's answer says so).
  const setPanel = (panel: ReaderPanel, collapsed: boolean): ReaderPanel | null => {
    const folded = setPanelCollapsed(panel === "outline" ? "left" : "right", collapsed);
    return folded === null ? null : folded === "left" ? "outline" : "right";
  };
  const setTab = (tab: ReaderRightTab) => setRightTab(tab === "references" ? "refs" : "annotations");

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
          <Select
            className="paper-switch"
            data-ui="switch-doc"
            aria-label={t("doc.switchPaper")}
            value={currentId}
            onChange={onSelect}
            title={t("doc.switchPaper")}
            options={papers.map((p) => ({ value: p, label: p }))}
          />
        )}
        <span className="doc-meta">
          {ir.nPages !== undefined && t("doc.metaPages", { n: ir.nPages })}
          {t("doc.metaRefsFigs", { refs: ir.bib.length, figs: nFigs })}
        </span>
        <ReaderArgumentEntry docId={currentId} onOpen={ws.openArgumentGraph} />
      </header>

      <span className="reader-position-note">{t("doc.positionNote")}</span>
      <div className="reader-main" data-ui="latex-reader-layout" ref={mainRef}>
        <aside data-ui="latex-outline-panel" className={"panel left" + (collapsedLeft ? " collapsed" : "")}>
          <ActionButton
            mode="icon"
            iconName={collapsedLeft ? "chevron-right" : "chevron-left"}
            iconSize="small"
            label={t(collapsedLeft ? "doc.actions.expandOutline" : "doc.actions.collapseOutline")}
            tooltip={t(collapsedLeft ? "doc.actions.expandOutline" : "doc.actions.collapseOutline")}
            className="panel-toggle"
            unstyled
            data-ui="toggle-latex-outline"
            onClick={() => setCollapsedLeft((v) => !v)}
          />
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
          <ActionButton
            mode="icon"
            iconName={collapsedRight ? "chevron-left" : "chevron-right"}
            iconSize="small"
            label={t(collapsedRight ? "doc.actions.expandReferences" : "doc.actions.collapseReferences")}
            tooltip={t(collapsedRight ? "doc.actions.expandReferences" : "doc.actions.collapseReferences")}
            className="panel-toggle"
            unstyled
            data-ui="toggle-latex-right-panel"
            onClick={() => setCollapsedRight((v) => !v)}
          />
          <span className="rail-label">{t("doc.railRefs")}</span>
          <div className="panel-body">
            <RightPanel tab={rightTab} onTab={setRightTab} />
          </div>
        </aside>
      </div>
      <AnnotationDeepLink />
      <ReaderLive />
      <ReaderControls setPanel={setPanel} setTab={setTab} />
    </div>
  );
}

export { autoFold, MIN_READING_COLUMN };

/** Reports where the user is reading (a hint) and whether the back button shows; renders nothing. */
function ReaderLive() {
  const bridge = useReaderBridge();
  const visible = useVisibleIds();
  const activeSection = useActiveSectionId();
  const canGoBack = useCanUndo();
  const ann = useAnnotations();
  // the popover the user has open, if it shows one annotation
  const openAnnotationId = ann.popover?.mode === "view" ? ann.popover.id : null;
  useEffect(() => {
    bridge.setLive({ position: { activeSectionId: activeSection, visibleBlockIds: visible.slice(0, 1000) }, canGoBack, openAnnotationId });
  }, [bridge, visible, activeSection, canGoBack, openAnnotationId]);
  useEffect(() => () => bridge.setLive(null), [bridge]);
  return null;
}

/**
 * The Reader's own controllers as the Copilot may drive them: the same anchor code the URL hash uses (jumpTo,
 * focusReference, the annotation deep link), the back button's undo and the panel folds. It answers
 * `unavailable` while the session is syncing or showing an error, exactly when the UI's own jumps do nothing.
 */
function ReaderControls({ setPanel, setTab }: { setPanel: (panel: ReaderPanel, collapsed: boolean) => ReaderPanel | null; setTab: (tab: ReaderRightTab) => void }) {
  const bridge = useReaderBridge();
  const store = useStore();
  const ann = useAnnotations();
  const { controller } = useReaderSession();
  const latest = useRef({ store, ann, controller, setPanel, setTab });
  latest.current = { store, ann, controller, setPanel, setTab };
  useEffect(() => {
    bridge.setHandle({
      navigate: (anchor) => {
        const { store: s, ann: a, controller: c } = latest.current;
        if (!c.canAnnotate()) return "unavailable";
        return (isAnnotationAnchor(anchor) ? applyAnnotationAnchor(s, a, anchor) : applyAnchor(s, anchor)) ? "ok" : "not_found";
      },
      jumpBack: () => {
        const { store: s, controller: c } = latest.current;
        if (!c.canAnnotate()) return "unavailable";
        if (!s.getCanUndo()) return "disabled";
        s.undo();
        return "ok";
      },
      setPanel: (panel, collapsed) => latest.current.setPanel(panel, collapsed),
      setRightTab: (tab) => latest.current.setTab(tab),
    });
    return () => bridge.setHandle(null);
  }, [bridge]);
  return null;
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
      <ActionButton unstyled mode="icon" iconSize="small" iconName="x" label={t("common.close")} tooltip={t("common.close")} className="ann-toast-x" data-ui="dismiss-annotation-notice" onClick={ann.dismissNotice} />
    </div>
  );
}

function UndoFab() {
  const store = useStore();
  const { t } = useTranslation();
  const canUndo = useCanUndo();
  if (!canUndo) return null;
  return (
    <ActionButton unstyled mode="icon" iconSize="small" iconName="undo-2" label={t("doc.actions.undoNavigation")} tooltip={t("doc.actions.undoNavigation")} data-ui="undo-latex-navigation" className="undo-fab" onClick={store.undo} />
  );
}
