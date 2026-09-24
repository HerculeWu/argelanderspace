import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { createPluginRegistration } from "@embedpdf/core";
import { EmbedPDF } from "@embedpdf/core/react";
import { usePdfiumEngine } from "@embedpdf/engines/react";
import { BookmarkPluginPackage, useBookmarkCapability } from "@embedpdf/plugin-bookmark/react";
import { AnnotationLayer, AnnotationPluginPackage, LockModeType, useAnnotationCapability } from "@embedpdf/plugin-annotation/react";
import { DocumentContent, DocumentManagerPluginPackage, useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { GlobalPointerProvider, InteractionManagerPluginPackage, PagePointerProvider } from "@embedpdf/plugin-interaction-manager/react";
import { RenderLayer, RenderPluginPackage } from "@embedpdf/plugin-render/react";
import { Rotate, RotatePluginPackage } from "@embedpdf/plugin-rotate/react";
import { ScrollStrategy, Scroller, ScrollPluginPackage, useScrollCapability } from "@embedpdf/plugin-scroll/react";
import { SearchLayer, SearchPluginPackage, useSearchCapability } from "@embedpdf/plugin-search/react";
import { SelectionLayer, SelectionPluginPackage, useSelectionCapability } from "@embedpdf/plugin-selection/react";
import type { FormattedSelection } from "@embedpdf/plugin-selection";
import { PdfAnnotationSubtype, type PdfLinkAnnoObject, type PdfLinkTarget, type SearchResult } from "@embedpdf/models";
import { Viewport, ViewportPluginPackage, useViewportCapability } from "@embedpdf/plugin-viewport/react";
import { ZoomMode, ZoomPluginPackage, useZoomCapability } from "@embedpdf/plugin-zoom/react";
import type { DocDescription, PdfAnnotation, PdfAnnotationsFile, PdfReaderPositionRead, PdfReadingLocation, PdfReadingPosition, PdfReaderSnapshot } from "@argelanderspace/contracts";
import { PdfAnnotationsPanel } from "./PdfAnnotationsPanel";
import { OutlineList, type OutlineEntry } from "../components/TocPanel";
import { copyPlainText } from "./copy-text";
import { docRouteUrl } from "../lib/deeplink";
import { dispatchPdfLinkTarget, flattenPdfBookmarks, isPdfLinkTargetAllowed } from "./pdf-navigation";
import { PdfLinkHitLayer } from "./PdfLinkHitLayer";
import { PdfAnnotationSession } from "./PdfAnnotationSession";
import { buildPdfTextTarget, pdfPageRectFromVisible, pdfPageRectToVisible, pdfSelectionQuote } from "./pdf-text-target";
import { registerWorkspaceLeaveGuard, useWorkspace } from "../argelander/workspace";
import { fetchPdfDoc } from "../api/pdf";
import { PdfReadingPositionWriter, type PositionWriterFailure, type PositionWriterState } from "./PdfReadingPositionWriter";
import { Icon } from "../lib/icons";
import { IconButton } from "../ui";
import pdfiumWasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";
import "./pdf-reader.css";

type LoadState = { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; bytes: ArrayBuffer; snapshot: PdfReaderSnapshot };

export function PdfReader({ docId, description }: { docId: string; description: Extract<DocDescription, { format: "pdf" }> }) {
  const { t } = useTranslation();
  const workspace = useWorkspace();
  const [state, setState] = useState<LoadState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const failLoad = useCallback((message: string) => setState({ phase: "error", message }), []);
  const timeout = useCallback(() => failLoad("engine timeout"), [failLoad]);
  useEffect(() => {
    const abort = new AbortController();
    setState({ phase: "loading" });
    void fetchPdfDoc(docId, abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      if (!result.ok) setState({ phase: "error", message: result.detail });
      else if (result.snapshot.metadata.sha256 !== description.sha256) setState({ phase: "error", message: "document changed" });
      else setState({ phase: "ready", bytes: result.bytes, snapshot: result.snapshot });
    });
    return () => abort.abort();
  }, [docId, description.sha256, attempt]);

  if (state.phase === "loading") return <div className="pdf-reader-state" data-ui="pdf-loading" role="status">{t("pdfReader.loading")}</div>;
  if (state.phase === "error") {
    const message = state.message === "document changed" ? t("pdfReader.changed") : state.message === "engine timeout" ? t("pdfReader.engineTimeout") : state.message === "engine failed" ? t("pdfReader.engineFailed") : t("pdfReader.failed");
    return <div className="pdf-reader-state" data-ui="pdf-error" role={errorDismissed ? "status" : "alert"}>
      {!errorDismissed && <IconButton variant="ghost" label={t("pdfReader.dismiss")} data-ui="dismiss-pdf-error" icon={<Icon name="x" cls="ico-sm" />} onClick={() => setErrorDismissed(true)} />}
      <p>{errorDismissed ? t("pdfReader.failedSummary") : message}</p>
      <button type="button" data-ui="retry-pdf" onClick={() => { setErrorDismissed(false); setAttempt((value) => value + 1); }}>{t("pdfReader.retry")}</button>
    </div>;
  }
  return <PdfEngineReader key={docId} docId={docId} filename={description.display_name} workTitle={description.work_title} bytes={state.bytes} annotations={state.snapshot.annotations} pages={state.snapshot.metadata.pages} readingPosition={state.snapshot.reading_position} pendingAnchor={workspace.pendingAnchor} clearPendingAnchor={workspace.clearPendingAnchor} onTimeout={timeout} onFailure={failLoad} />;
}

function PdfEngineReader({ docId, filename, workTitle, bytes, annotations, pages, readingPosition, pendingAnchor, clearPendingAnchor, onTimeout, onFailure }: { docId: string; filename: string; workTitle: string; bytes: ArrayBuffer; annotations: PdfAnnotationsFile; pages: Array<{ width: number; height: number; rotation: number }>; readingPosition: PdfReaderPositionRead; pendingAnchor: string | null; clearPendingAnchor: () => void; onTimeout: () => void; onFailure: (message: string) => void }) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const wasmUrl = useMemo(() => new URL(pdfiumWasmUrl, window.location.href).href, []);
  const { engine, isLoading, error } = usePdfiumEngine({ wasmUrl, worker: true, encoderPoolSize: 2, fontFallback: null });
  const markReady = useCallback(() => setReady(true), []);
  const plugins = useMemo(() => [
    createPluginRegistration(DocumentManagerPluginPackage, {
      initialDocuments: [{ buffer: bytes.slice(0), name: filename, documentId: docId, scale: 1 }],
    }),
    createPluginRegistration(ViewportPluginPackage, { viewportGap: 12 }),
    createPluginRegistration(ScrollPluginPackage, { defaultStrategy: ScrollStrategy.Vertical }),
    createPluginRegistration(InteractionManagerPluginPackage),
    createPluginRegistration(ZoomPluginPackage, { defaultZoomLevel: 1 }),
    createPluginRegistration(RotatePluginPackage),
    createPluginRegistration(RenderPluginPackage),
    createPluginRegistration(SelectionPluginPackage),
    createPluginRegistration(BookmarkPluginPackage),
    createPluginRegistration(SearchPluginPackage),
    // Embedded PDF annotations are rendered but locked; only the separate workbench sidecar is editable.
    createPluginRegistration(AnnotationPluginPackage, { autoCommit: false, locked: { type: LockModeType.All }, autoOpenLinks: false }),
  ], [bytes, docId, filename]);

  useEffect(() => { if (error) onFailure("engine failed"); }, [error, onFailure]);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(onTimeout, 10_000);
    return () => clearTimeout(timer);
  }, [ready, onTimeout]);

  if (error) return <div className="pdf-reader-state" role="alert">{t("pdfReader.engineFailed")}: {String(error)}</div>;
  if (isLoading || !engine) return <div className="pdf-reader-state" role="status">{t("pdfReader.engineLoading")}</div>;
  return <div className="pdf-reader" data-ui="pdf-engine" data-ui-key={docId}>
    <EmbedPDF engine={engine} plugins={plugins}>
      {({ pluginsReady, activeDocumentId }) => pluginsReady ? <DocumentContent documentId={activeDocumentId ?? docId}>
        {({ documentState, isLoaded, isLoading: documentLoading, isError }) => (
          <LoadedPdfDocument
            docId={docId}
            filename={filename}
            workTitle={workTitle}
            bytes={bytes}
            annotations={annotations}
            pages={pages}
            readingPosition={readingPosition}
            pendingAnchor={pendingAnchor}
            clearPendingAnchor={clearPendingAnchor}
            isLoaded={isLoaded}
            isLoading={documentLoading}
            isError={isError}
            totalPages={documentState.document?.pageCount ?? 0}
            onReady={markReady}
            onFailure={onFailure}
          />
        )}
      </DocumentContent> : <div className="pdf-reader-state" role="status">{t("pdfReader.engineLoading")}</div>}
    </EmbedPDF>
  </div>;
}

function LoadedPdfDocument({
  docId, filename, workTitle, bytes, annotations, pages, readingPosition, pendingAnchor, clearPendingAnchor, isLoaded, isLoading, isError, totalPages, onReady, onFailure,
}: {
  docId: string; filename: string; workTitle: string; bytes: ArrayBuffer; annotations: PdfAnnotationsFile; pages: Array<{ width: number; height: number; rotation: number }>; readingPosition: PdfReaderPositionRead; pendingAnchor: string | null; clearPendingAnchor: () => void; isLoaded: boolean; isLoading: boolean;
  isError: boolean; totalPages: number; onReady: () => void; onFailure: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [selectionMode, setSelectionMode] = useState<"read" | "text" | "area">("read");
  const session = useMemo(() => new PdfAnnotationSession(docId, annotations.content_sha256, annotations), [docId, annotations.content_sha256]);
  const sessionState = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [currentPageIndex, setCurrentPageIndex] = useState(0);
  const [positionUi, setPositionUi] = useState<PositionWriterState>({ saving: false, failed: readingPosition.status === "error", saved: false, failure: readingPosition.status === "error" ? "restore" : null });
  const initialPositionFile = readingPosition.status === "ready" ? readingPosition.file : null;
  const pendingPosition = useRef<PdfReadingLocation | null>(null);
  const positionTimer = useRef<number | undefined>();
  const positionGeneration = useRef(0);
  const userTookControl = useRef(false);
  const userInputGeneration = useRef(0);
  const restoringPosition = useRef(false);
  const { provides: viewport } = useViewportCapability();
  const { provides: documentManager } = useDocumentManagerCapability();
  const { provides: scroll } = useScrollCapability();
  const { provides: bookmarks } = useBookmarkCapability();
  const { provides: sdkAnnotations } = useAnnotationCapability();
  const { provides: selectionControl } = useSelectionCapability();
  const [outlineEntries, setOutlineEntries] = useState<OutlineEntry[]>([]);
  const [pdfLinks, setPdfLinks] = useState<PdfLinkAnnoObject[]>([]);
  const [outlineTargets, setOutlineTargets] = useState<Map<string, PdfLinkTarget>>(new Map());
  const markUserNavigation = useCallback(() => { userTookControl.current = true; restoringPosition.current = false; }, []);
  const recoverPosition = useCallback((file: PdfReadingPosition) => {
    const saved = file.position;
    let anchor = pendingAnchor;
    if (!anchor) { try { anchor = decodeURIComponent(window.location.hash.slice(1)); } catch { anchor = "invalid-anchor"; } }
    if (!saved || anchor || userTookControl.current || !scroll || saved.page_index >= pages.length) return;
    const generation = positionGeneration.current;
    const userGeneration = userInputGeneration.current;
    const scope = scroll.forDocument(docId);
    scope.scrollToPage({ pageNumber: saved.page_index + 1, behavior: "instant" });
    requestAnimationFrame(() => placeReaderAtLocation(saved, () => generation === positionGeneration.current && userGeneration === userInputGeneration.current && !userTookControl.current));
  }, [docId, pages.length, pendingAnchor, scroll]);
  const positionWriter = useMemo(() => new PdfReadingPositionWriter(docId, annotations.content_sha256, initialPositionFile, setPositionUi, undefined, undefined, recoverPosition), [annotations.content_sha256, docId, initialPositionFile, recoverPosition]);
  useEffect(() => { session.start(); return () => session.stop(); }, [session]);
  useEffect(() => {
    if (!isLoaded || !bookmarks) { setOutlineEntries([]); setOutlineTargets(new Map()); return; }
    let live = true;
    void Promise.resolve().then(() => bookmarks.forDocument(docId).getBookmarks().toPromise()).then(({ bookmarks: tree }) => {
      if (!live) return;
      const flattened = flattenPdfBookmarks(tree, pages.length);
      setOutlineEntries(flattened.entries);
      setOutlineTargets(flattened.targets);
    }).catch(() => { if (live) { setOutlineEntries([]); setOutlineTargets(new Map()); } });
    return () => { live = false; };
  }, [bookmarks, docId, isLoaded]);
  const navigatePdfLink = useCallback((target: PdfLinkTarget) => {
    dispatchPdfLinkTarget(
      target,
      pages.length,
      (allowedTarget) => sdkAnnotations?.forDocument(docId).navigateTarget(allowedTarget).wait(() => undefined, () => undefined),
      (url) => window.open(url, "_blank", "noopener,noreferrer")
    );
  }, [docId, pages.length, sdkAnnotations]);
  useEffect(() => {
    if (!isLoaded || !sdkAnnotations) { setPdfLinks([]); return; }
    const scope = sdkAnnotations.forDocument(docId);
    const refresh = () => setPdfLinks(scope.getAnnotations().map((item) => item.object).filter((item): item is PdfLinkAnnoObject => item.type === PdfAnnotationSubtype.LINK && isPdfLinkTargetAllowed(item.target, pages.length)));
    refresh();
    return scope.onStateChange(refresh);
  }, [docId, isLoaded, pages.length, sdkAnnotations]);
  useEffect(() => {
    const remove = registerWorkspaceLeaveGuard(() => !session.hasUnsaved() || window.confirm(t("pdfReader.unsavedLeave")));
    return remove;
  }, [session, t]);
  useEffect(() => { if (sessionState.blocked) setSelectionMode("read"); }, [sessionState.blocked]);
  useLayoutEffect(() => {
    document.documentElement.dataset.pdfAreaMode = String(selectionMode === "area" && !sessionState.blocked);
    if (isLoaded && selectionControl) {
      selectionControl.enableForMode("pointerMode", { enableSelection: selectionMode === "text" && !sessionState.blocked, showSelectionRects: true, enableMarquee: false }, docId);
      if (selectionMode !== "text" || sessionState.blocked) selectionControl.clear(docId);
    }
    return () => { delete document.documentElement.dataset.pdfAreaMode; };
  }, [docId, isLoaded, selectionControl, selectionMode, sessionState.blocked]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setSelectionMode("read"); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!session.hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [session]);
  useEffect(() => { if (isLoaded) onReady(); }, [isLoaded, onReady]);
  useEffect(() => {
    if (!isLoaded || !viewport) return;
    for (const gate of viewport.getGates(docId)) viewport.releaseGate(gate, docId);
  }, [docId, isLoaded, viewport]);
  const persistPosition = useCallback((location: PdfReadingLocation) => {
    positionWriter.offer(location);
  }, [positionWriter]);
  useEffect(() => {
    positionGeneration.current++;
    userTookControl.current = false;
    if (!isLoaded || !scroll) return;
    let hash = "";
    try { hash = pendingAnchor ?? decodeURIComponent(window.location.hash.slice(1)); } catch { hash = "invalid-anchor"; }
    const pageMatch = /^(?:page[-=])(\d+)$/.exec(hash);
    const annotationId = hash.startsWith("ann-") ? hash.slice(4) : null;
    const explicitAnchor = hash.length > 0;
    let explicitPage: number | null = pageMatch ? Number(pageMatch[1]) - 1 : null;
    const linkedAnnotation = annotationId ? annotations.annotations.find((item) => item.id === annotationId) : undefined;
    if (linkedAnnotation) {
      if (typeof linkedAnnotation.page_index === "number") explicitPage = linkedAnnotation.page_index;
      else if (linkedAnnotation.kind === "highlight" || linkedAnnotation.kind === "underline" || linkedAnnotation.kind === "strikeout") explicitPage = linkedAnnotation.target.fragments[0]?.page_index ?? null;
    }
    if (explicitAnchor) {
      userTookControl.current = true;
      let cancelLayoutWait = () => undefined;
      if (explicitPage !== null && explicitPage >= 0 && explicitPage < pages.length) {
        const targetPageNumber = explicitPage + 1;
        const generationForLinkedPage = positionGeneration.current;
        const userGeneration = userInputGeneration.current;
        const scope = scroll.forDocument(docId);
        let unsubscribeLayout: (() => void) | undefined;
        let layoutTimer: number | undefined;
        let cancelled = false;
        cancelLayoutWait = () => { cancelled = true; unsubscribeLayout?.(); window.clearTimeout(layoutTimer); };
        const navigateToLinkedPage = () => {
          if (cancelled) return;
          if (generationForLinkedPage !== positionGeneration.current || userGeneration !== userInputGeneration.current) { cancelLayoutWait(); return; }
          const layout = scope.getLayout();
          if (scope.getTotalPages() !== pages.length || layout.totalContentSize.height <= 0) return;
          cancelLayoutWait();
          scope.scrollToPage({ pageNumber: targetPageNumber, behavior: "instant" });
        };
        unsubscribeLayout = scope.onLayoutChange(navigateToLinkedPage);
        layoutTimer = window.setTimeout(cancelLayoutWait, 5_000);
        requestAnimationFrame(navigateToLinkedPage);
        const targetLocation = linkedAnnotation ? pdfAnnotationLocation(linkedAnnotation) : null;
        if (targetLocation) {
          const userGeneration = userInputGeneration.current;
          placeReaderAtLocation(targetLocation, () => userInputGeneration.current === userGeneration);
        }
        requestAnimationFrame(() => document.getElementById(`pdf-annotation-${CSS.escape(annotationId ?? "")}`)?.scrollIntoView({ block: "nearest" }));
      } else if (!pageMatch && annotationId && linkedAnnotation?.kind === "document_comment") {
        requestAnimationFrame(() => document.getElementById(`pdf-annotation-${CSS.escape(annotationId)}`)?.scrollIntoView({ block: "nearest" }));
      }
      clearPendingAnchor();
      return cancelLayoutWait;
    }
    if (explicitAnchor) { clearPendingAnchor(); return; }
    const saved = readingPosition.status === "ready" ? readingPosition.file.position : null;
    if (!saved || saved.page_index >= pages.length) return;
    const generation = positionGeneration.current;
    restoringPosition.current = true;
    scroll.forDocument(docId).scrollToPage({ pageNumber: saved.page_index + 1 });
    let frames = 0;
    let stableFrames = 0;
    let previousTop: number | null = null;
    const started = performance.now();
    const place = () => {
      if (generation !== positionGeneration.current || userTookControl.current || frames++ > 90) { restoringPosition.current = false; return; }
      const scroller = document.querySelector<HTMLElement>(".pdf-viewport");
      const page = document.querySelector<HTMLElement>(`.pdf-area-layer[data-pdf-page-index="${saved.page_index}"]`);
      if (scroller && page && page.getBoundingClientRect().height > 0) {
        const pageRect = page.getBoundingClientRect();
        if (previousTop !== null && Math.abs(previousTop - pageRect.top) < 0.5) stableFrames++;
        else stableFrames = 0;
        previousTop = pageRect.top;
        if (performance.now() - started >= 180 && stableFrames >= 3) {
          const viewportRect = scroller.getBoundingClientRect();
          scroller.scrollTop += pageRect.top + saved.y * pageRect.height - (viewportRect.top + viewportRect.height / 2);
          scroller.scrollLeft += pageRect.left + saved.x * pageRect.width - (viewportRect.left + viewportRect.width / 2);
          restoringPosition.current = false;
          return;
        }
      }
      requestAnimationFrame(place);
    };
    requestAnimationFrame(place);
    return () => { positionGeneration.current++; restoringPosition.current = false; };
  }, [annotations.annotations, clearPendingAnchor, docId, isLoaded, pages.length, pendingAnchor, readingPosition, scroll]);
  useEffect(() => {
    if (!isLoaded) return;
    let frame = 0;
    let attempts = 0;
    let detach: (() => void) | null = null;
    const attach = () => {
      const scroller = document.querySelector<HTMLElement>(".pdf-scroller");
      const viewportElement = document.querySelector<HTMLElement>(".pdf-viewport");
      if (!scroller || !viewportElement) {
        if (attempts++ < 120) frame = requestAnimationFrame(attach);
        return;
      }
      const saveFromScroll = () => {
        if (restoringPosition.current || userTookControl.current === false && readingPosition.status === "ready" && readingPosition.file.position) return;
        const viewRect = viewportElement.getBoundingClientRect();
        const centerX = viewRect.left + viewRect.width / 2;
        const centerY = viewRect.top + viewRect.height / 2;
        const candidates = [...document.querySelectorAll<HTMLElement>(".pdf-area-layer[data-pdf-page-index]")]
          .map((element) => ({ element, rect: element.getBoundingClientRect(), pageIndex: Number(element.dataset.pdfPageIndex) }))
          .filter((candidate) => candidate.rect.width > 0 && candidate.rect.height > 0);
        const visible = candidates.find(({ rect }) => centerX >= rect.left && centerX <= rect.right && centerY >= rect.top && centerY <= rect.bottom);
        const nearest = visible ?? candidates.sort((a, b) => Math.abs((a.rect.top + a.rect.height / 2) - centerY) - Math.abs((b.rect.top + b.rect.height / 2) - centerY))[0];
        if (!nearest || !Number.isInteger(nearest.pageIndex) || nearest.pageIndex < 0 || nearest.pageIndex >= pages.length) return;
        const { rect: pageRect, pageIndex } = nearest;
        pendingPosition.current = { page_index: pageIndex, x: Math.max(0, Math.min(1, (centerX - pageRect.left) / pageRect.width)), y: Math.max(0, Math.min(1, (centerY - pageRect.top) / pageRect.height)) };
        setPositionUi((previous) => previous.failed ? previous : { saving: true, failed: false, saved: false, failure: null });
        window.clearTimeout(positionTimer.current);
        positionTimer.current = window.setTimeout(() => {
          const latest = pendingPosition.current;
          pendingPosition.current = null;
          if (latest) persistPosition(latest);
        }, 650);
      };
      const takeControl = () => { userInputGeneration.current++; userTookControl.current = true; restoringPosition.current = false; };
      const onKey = (event: KeyboardEvent) => { if (["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "].includes(event.key)) { takeControl(); requestAnimationFrame(saveFromScroll); } };
      const onWheel = () => { takeControl(); requestAnimationFrame(saveFromScroll); };
      const onPointer = (event: PointerEvent) => { if (event.target instanceof Element && event.target.closest(".pdf-scroller, .pdf-viewport")) takeControl(); };
      scroller.addEventListener("scroll", saveFromScroll, { passive: true });
      viewportElement.addEventListener("scroll", saveFromScroll, { passive: true });
      window.addEventListener("scroll", saveFromScroll, true);
      scroller.addEventListener("wheel", takeControl, { passive: true });
      viewportElement.addEventListener("wheel", takeControl, { passive: true });
      window.addEventListener("wheel", onWheel, true);
      window.addEventListener("pointerdown", onPointer, true);
      window.addEventListener("keydown", onKey, true);
      detach = () => {
        scroller.removeEventListener("scroll", saveFromScroll);
        viewportElement.removeEventListener("scroll", saveFromScroll);
        window.removeEventListener("scroll", saveFromScroll, true);
        scroller.removeEventListener("wheel", takeControl);
        viewportElement.removeEventListener("wheel", takeControl);
        window.removeEventListener("wheel", onWheel, true);
        window.removeEventListener("pointerdown", onPointer, true);
        window.removeEventListener("keydown", onKey, true);
      };
    };
    frame = requestAnimationFrame(attach);
    return () => {
      cancelAnimationFrame(frame);
      detach?.();
      window.clearTimeout(positionTimer.current);
      positionWriter.stop(pendingPosition.current ?? undefined);
      pendingPosition.current = null;
      positionGeneration.current++;
      userInputGeneration.current++;
    };
  }, [docId, isLoaded, pages.length, persistPosition, positionWriter, readingPosition]);
  useEffect(() => { if (isError) onFailure("document failed"); }, [isError, onFailure]);
  if (!isLoaded) return <div className="pdf-reader-state" role={isError ? "alert" : "status"}>{isLoading ? t("pdfReader.documentLoading") : isError ? t("pdfReader.documentFailed") : t("pdfReader.documentLoading")}</div>;
  return <>
    <PdfToolbar docId={docId} filename={filename} workTitle={workTitle} bytes={bytes} totalPages={totalPages} pages={pages} onUserNavigation={markUserNavigation} onCurrentPage={(page) => setCurrentPageIndex(page - 1)} />
    {(positionUi.failed || positionUi.saving || positionUi.saved) && <ReadingPositionWarning busy={positionUi.saving} retry={() => { void positionWriter.retry(); }} failed={positionUi.failed} saved={positionUi.saved} failure={positionUi.failure} />}
    <div className="pdf-reader-layout" data-ui="pdf-reader" data-ui-key={docId} data-reading-position-state={positionUi.failed ? positionUi.failure ?? "failed" : positionUi.saving ? "saving" : positionUi.saved ? "saved" : "idle"}>
      <aside className={`pdf-side pdf-side-left${leftCollapsed ? " collapsed" : ""}`} aria-label={t("pdfReader.outlineTitle")} data-ui="pdf-outline-panel">
        <button type="button" className="pdf-panel-toggle" data-ui="toggle-pdf-outline" aria-expanded={!leftCollapsed} aria-label={t(leftCollapsed ? "pdfReader.expandOutline" : "pdfReader.collapseOutline")} onClick={() => setLeftCollapsed((value) => !value)}>{leftCollapsed ? "»" : "«"}</button>
        {!leftCollapsed && <div className="pdf-side-content"><h2>{t("pdfReader.outlineTitle")}</h2>{outlineEntries.length ? <OutlineList items={outlineEntries} onSelect={(id) => {
          markUserNavigation();
          const target = outlineTargets.get(id);
          if (target) navigatePdfLink(target);
        }} /> : <p>{t("pdfReader.outlineEmpty")}</p>}</div>}
      </aside>
      <div className="pdf-viewer-area" data-ui="pdf-document-area">
        <GlobalPointerProvider documentId={docId}>
          <Viewport className="pdf-viewport" documentId={docId}>
            <Scroller documentId={docId} className="pdf-scroller" renderPage={(page) => (
              <PagePointerProvider documentId={docId} pageIndex={page.pageIndex} key={page.pageIndex}>
                <Rotate documentId={docId} pageIndex={page.pageIndex}>
                  <div className="pdf-page-content" data-ui="pdf-page-content" data-ui-key={page.pageIndex} onDragStart={(event) => { if (event.target instanceof HTMLImageElement) event.preventDefault(); }}>
                    <RenderLayer documentId={docId} pageIndex={page.pageIndex} />
                    <AnnotationLayer documentId={docId} pageIndex={page.pageIndex} />
                    <PdfLinkHitLayer pageIndex={page.pageIndex} pageCount={pages.length} geometry={documentManager?.getDocument(docId)?.pages[page.pageIndex]} links={pdfLinks} onNavigate={navigatePdfLink} />
                    <SelectionLayer documentId={docId} pageIndex={page.pageIndex} />
                    <SearchLayer documentId={docId} pageIndex={page.pageIndex} />
                    <PdfTextAnnotationsLayer pageIndex={page.pageIndex} rotation={pages[page.pageIndex]?.rotation ?? 0} annotations={sessionState.blocked ? [] : session.projectedAnnotations() as PdfAnnotation[]} onActivate={(id) => document.getElementById(`pdf-annotation-${CSS.escape(id)}`)?.scrollIntoView({ block: "nearest" })} />
                    <PdfAreaLayer
                      pageIndex={page.pageIndex}
                      annotations={sessionState.blocked ? [] : session.projectedAnnotations() as PdfAnnotation[]}
                      blocked={sessionState.blocked}
                      onCreate={(annotation) => {
                        setSelectionMode("read");
                        session.create(annotation);
                      }}
                      onUpdate={(id, rectangle) => {
                        const after = session.projectedAnnotations().map((item) => item.id === id && item.kind === "rectangle" ? { ...item, rectangle } : item) as PdfAnnotation[];
                        session.mutate(after);
                      }}
                    />
                  </div>
                </Rotate>
              </PagePointerProvider>
            )} />
          </Viewport>
        </GlobalPointerProvider>
        <PdfTextTools docId={docId} session={session} pages={pages} blocked={sessionState.blocked} enabled={selectionMode === "text"} />
      </div>
      <aside className={`pdf-side pdf-side-right${rightCollapsed ? " collapsed" : ""}`} aria-label={t("pdfReader.annotationsTitle")} data-ui="pdf-annotations-panel">
        <button type="button" className="pdf-panel-toggle" data-ui="toggle-pdf-annotations" aria-expanded={!rightCollapsed} aria-label={t(rightCollapsed ? "pdfReader.expandAnnotations" : "pdfReader.collapseAnnotations")} onClick={() => setRightCollapsed((value) => !value)}>{rightCollapsed ? "«" : "»"}</button>
        {!rightCollapsed && <div className="pdf-side-content"><h2>{t("pdfReader.annotationsTitle")}</h2><p className="pdf-text-selection-hint">{t("pdfReader.selectTextHint")} {t("pdfReader.keyboardTextSelectionHint")}</p><PdfAnnotationsPanel
          session={session}
          currentPage={currentPageIndex}
          blocked={sessionState.blocked}
          onNavigatePage={(pageIndex) => scroll?.forDocument(docId).scrollToPage({ pageNumber: pageIndex + 1 })}
          selectionMode={selectionMode}
          onAddRectangle={() => setSelectionMode((previous) => previous === "area" ? "read" : "area")}
          onSelectText={() => setSelectionMode((previous) => previous === "text" ? "read" : "text")}
        /></div>}
      </aside>
    </div>
  </>;
}

function PdfAreaLayer({ pageIndex, blocked, annotations, onCreate, onUpdate }: {
  pageIndex: number; blocked: boolean; annotations: PdfAnnotation[];
  onCreate: (annotation: PdfAnnotation) => void;
  onUpdate: (id: string, rectangle: { x: number; y: number; width: number; height: number }) => void;
}) {
  const { t } = useTranslation();
  const drawingEnabled = () => document.documentElement.dataset.pdfAreaMode === "true" && !blocked;
  type Gesture = { id: string | null; mode: "draw" | "move" | "resize"; start: { x: number; y: number }; initial: { x: number; y: number; width: number; height: number } | null };
  type Rectangle = { x: number; y: number; width: number; height: number };
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [preview, setPreview] = useState<Rectangle | null>(null);
  const activeGesture = useRef<Gesture | null>(null);
  const activePreview = useRef<Rectangle | null>(null);
  const showPreview = (rect: Rectangle | null) => { activePreview.current = rect; setPreview(rect); };
  const clearGesture = () => { activeGesture.current = null; setGesture(null); showPreview(null); };
  const beginGesture = (next: Gesture) => { activeGesture.current = next; setGesture(next); showPreview(null); };
  const pagePoint = (event: { clientX: number; clientY: number }, element: HTMLElement) => {
    const bounds = element.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)) };
  };
  const area = (event: React.PointerEvent<HTMLDivElement>) => event.currentTarget;
  const items = annotations.filter((item) => item.kind === "rectangle" && item.page_index === pageIndex);
  const beginDraw = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawingEnabled() || blocked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const start = pagePoint(event, event.currentTarget);
    beginGesture({ id: null, mode: "draw", start, initial: null });
    showPreview({ ...start, width: 0, height: 0 });
  };
  const beginTransform = (event: React.PointerEvent<HTMLElement>, item: Extract<PdfAnnotation, { kind: "rectangle" }>, mode: "move" | "resize") => {
    if (blocked) return;
    event.stopPropagation();
    const layer = event.currentTarget.closest(".pdf-area-layer") as HTMLElement | null;
    if (!layer) return;
    layer.setPointerCapture(event.pointerId);
    beginGesture({ id: item.id, mode, start: pagePoint(event, layer), initial: item.rectangle });
  };
  const updatePreview = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = activeGesture.current;
    if (!current || blocked) return;
    const point = pagePoint(event, area(event));
    if (current.mode === "draw") {
      showPreview({ x: Math.min(current.start.x, point.x), y: Math.min(current.start.y, point.y), width: Math.abs(point.x - current.start.x), height: Math.abs(point.y - current.start.y) });
      return;
    }
    if (!current.initial) return;
    const dx = point.x - current.start.x;
    const dy = point.y - current.start.y;
    const rect = current.mode === "move"
      ? { ...current.initial, x: Math.max(0, Math.min(1 - current.initial.width, current.initial.x + dx)), y: Math.max(0, Math.min(1 - current.initial.height, current.initial.y + dy)) }
      : { ...current.initial, width: Math.max(0.006, Math.min(1 - current.initial.x, current.initial.width + dx)), height: Math.max(0.006, Math.min(1 - current.initial.y, current.initial.height + dy)) };
    showPreview(rect);
  };
  const commitGesture = (current: Gesture, rect: Rectangle) => {
    // The SDK can cancel a captured mouse pointer instead of delivering pointerup
    // on a virtualized page. The ref clears synchronously so competing completion
    // events cannot save the same gesture twice.
    clearGesture();
    if (blocked) return;
    if (current.mode === "draw") {
      if (rect.width >= 0.006 && rect.height >= 0.006) {
        const at = new Date().toISOString();
        onCreate({ id: `pann_${crypto.randomUUID()}`, kind: "rectangle", page_index: pageIndex, rectangle: rect, style: { color: "#f4c542", opacity: 0.35, line_width: 2 }, body: t("pdfReader.defaultBody"), created_at: at, updated_at: at });
      }
    } else if (current.id && current.initial && JSON.stringify(rect) !== JSON.stringify(current.initial)) onUpdate(current.id, rect);
  };
  const finishGesture = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = activeGesture.current;
    if (!current) return;
    const point = pagePoint(event, area(event));
    if (current.mode === "draw") {
      commitGesture(current, { x: Math.min(current.start.x, point.x), y: Math.min(current.start.y, point.y), width: Math.abs(point.x - current.start.x), height: Math.abs(point.y - current.start.y) });
    } else if (current.initial) {
      const dx = point.x - current.start.x;
      const dy = point.y - current.start.y;
      const rect = current.mode === "move"
        ? { ...current.initial, x: Math.max(0, Math.min(1 - current.initial.width, current.initial.x + dx)), y: Math.max(0, Math.min(1 - current.initial.height, current.initial.y + dy)) }
        : { ...current.initial, width: Math.max(0.006, Math.min(1 - current.initial.x, current.initial.width + dx)), height: Math.max(0.006, Math.min(1 - current.initial.y, current.initial.height + dy)) };
      commitGesture(current, rect);
    }
  };
  const finishOnLostCapture = () => {
    const current = activeGesture.current;
    const rect = activePreview.current;
    if (current && rect) commitGesture(current, rect);
    else if (current) clearGesture();
  };
  const keyMove = (event: React.KeyboardEvent<HTMLDivElement>, item: Extract<PdfAnnotation, { kind: "rectangle" }>) => {
    if (blocked || !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.05 : 0.01;
    const rect = { ...item.rectangle, x: Math.max(0, Math.min(1 - item.rectangle.width, item.rectangle.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0))), y: Math.max(0, Math.min(1 - item.rectangle.height, item.rectangle.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0))) };
    onUpdate(item.id, rect);
  };
  return <div data-pdf-page-index={pageIndex} className={`pdf-area-layer${drawingEnabled() ? " drawing" : ""}`} data-ui="pdf-area-layer" role="group" aria-label={t("pdfReader.areaLayer")}
    onPointerDown={beginDraw} onPointerMove={updatePreview} onPointerUp={finishGesture} onLostPointerCapture={finishOnLostCapture} onPointerCancel={(event) => {
      if (event.pointerType === "mouse" && event.buttons === 0) finishOnLostCapture();
      else clearGesture();
    }}>
    {items.map((item) => item.kind === "rectangle" ? <div key={item.id} role="group" aria-label={t("pdfReader.rectangleTarget", { page: pageIndex + 1 })} tabIndex={blocked ? -1 : 0} className="pdf-area-annotation" data-ui="pdf-rectangle" data-ui-key={item.id} onPointerDown={(event) => beginTransform(event, item, "move")} onKeyDown={(event) => keyMove(event, item)} style={{ left: `${(gesture?.id === item.id && preview ? preview.x : item.rectangle.x) * 100}%`, top: `${(gesture?.id === item.id && preview ? preview.y : item.rectangle.y) * 100}%`, width: `${(gesture?.id === item.id && preview ? preview.width : item.rectangle.width) * 100}%`, height: `${(gesture?.id === item.id && preview ? preview.height : item.rectangle.height) * 100}%`, borderColor: item.style.color, backgroundColor: item.style.color, opacity: item.style.opacity }}>
      <button type="button" tabIndex={blocked ? -1 : 0} aria-label={t("pdfReader.resizeRectangle", { page: pageIndex + 1 })} disabled={blocked} className="pdf-area-resize" data-ui="resize-pdf-rectangle" onPointerDown={(event) => beginTransform(event, item, "resize")} onClick={(event) => event.stopPropagation()} />
    </div> : null)}
    {preview && gesture?.mode === "draw" && <div className="pdf-area-preview" style={{ left: `${preview.x * 100}%`, top: `${preview.y * 100}%`, width: `${preview.width * 100}%`, height: `${preview.height * 100}%` }} />}
    <span className="pdf-area-hint">{t("pdfReader.drawRectangleHint")}</span>
  </div>;
}

function PdfTextTools({ docId, session, pages, blocked, enabled }: { docId: string; session: PdfAnnotationSession; pages: Array<{ width: number; height: number; rotation: number }>; blocked: boolean; enabled: boolean }) {
  const { t } = useTranslation();
  const { provides: selection } = useSelectionCapability();
  const [current, setCurrent] = useState<{ text: string; pages: FormattedSelection[] } | null>(null);
  const [geometryError, setGeometryError] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [toolbarPosition, setToolbarPosition] = useState<{ left: number; top: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const pointerSelecting = useRef(false);
  const selectionGeneration = useRef(0);
  const extendSelectionWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!current || blocked || !event.shiftKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight") || !selection) return;
    const scope = selection.forDocument(docId);
    const range = scope.getState().selection;
    if (!range) return;
    const end = { ...range.end };
    const geometry = scope.getState().geometry[end.page];
    const lastIndex = geometry?.runs.reduce((last, run) => Math.max(last, run.charStart + run.glyphs.length - 1), -1) ?? -1;
    if (event.key === "ArrowRight") {
      if (end.index < lastIndex) end.index++;
      else if (end.page + 1 < pages.length) { end.page++; end.index = 0; }
      else return;
    } else if (end.index > 0) end.index--;
    else if (end.page > range.start.page) {
      end.page--;
      end.index = scope.getState().geometry[end.page]?.runs.reduce((last, run) => Math.max(last, run.charStart + run.glyphs.length - 1), 0) ?? 0;
    } else return;
    event.preventDefault();
    scope.setSelection({ start: range.start, end }).wait(() => undefined, () => undefined);
  };
  useEffect(() => {
    if (!selection || !enabled) { setCurrent(null); return; }
    const scope = selection.forDocument(docId);
    const updateSelection = (range: unknown) => {
      const generation = ++selectionGeneration.current;
      if (!range || pointerSelecting.current || blocked || !session.isWritable()) { setCurrent(null); setGeometryError(false); return; }
      const formatted = scope.getFormattedSelection();
      if (!formatted.length) { setCurrent(null); return; }
      void scope.getSelectedText().toPromise().then((text) => {
        if (generation === selectionGeneration.current && session.isWritable()) { setCurrent({ text: pdfSelectionQuote(text), pages: formatted }); setGeometryError(false); }
      }).catch(() => { if (generation === selectionGeneration.current) setCurrent(null); });
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0 && event.target instanceof Element && event.target.closest(".pdf-page-content")) pointerSelecting.current = true;
    };
    const onPointerFinish = () => {
      if (!pointerSelecting.current) return;
      pointerSelecting.current = false;
      requestAnimationFrame(() => updateSelection(scope.getState().selection));
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerFinish, true);
    window.addEventListener("pointercancel", onPointerFinish, true);
    const unsubscribe = scope.onSelectionChange(updateSelection);
    const unsubscribeEnd = scope.onEndSelection(() => updateSelection(scope.getState().selection));
    updateSelection(scope.getState().selection);
    return () => {
      selectionGeneration.current++;
      pointerSelecting.current = false;
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerFinish, true);
      window.removeEventListener("pointercancel", onPointerFinish, true);
      unsubscribe();
      unsubscribeEnd();
    };
  }, [selection, docId, blocked, enabled, session]);
  const positionToolbar = useCallback(() => {
    const fragment = current?.pages[current.pages.length - 1];
    const geometry = fragment && pages[fragment.pageIndex];
    const pageElement = fragment && document.querySelector<HTMLElement>(`.pdf-area-layer[data-pdf-page-index="${fragment.pageIndex}"]`);
    const bounds = pageElement?.getBoundingClientRect();
    if (!fragment || !geometry || !bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const sdkRect = {
      x: fragment.rect.origin.x / geometry.width,
      y: fragment.rect.origin.y / geometry.height,
      width: fragment.rect.size.width / geometry.width,
      height: fragment.rect.size.height / geometry.height,
    };
    const rect = pdfPageRectToVisible(sdkRect, geometry.rotation);
    const anchorLeft = bounds.left + rect.x * bounds.width;
    const anchorRight = anchorLeft + rect.width * bounds.width;
    const anchorTop = bounds.top + rect.y * bounds.height;
    const anchorBottom = anchorTop + rect.height * bounds.height;
    const toolbar = toolbarRef.current?.getBoundingClientRect();
    const width = toolbar?.width ?? 300;
    const height = toolbar?.height ?? 68;
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, (anchorLeft + anchorRight - width) / 2));
    const above = anchorTop - height - 10;
    const top = above >= 8 ? above : Math.min(window.innerHeight - height - 8, anchorBottom + 10);
    setToolbarPosition((previous) => previous && Math.abs(previous.left - left) < 1 && Math.abs(previous.top - top) < 1 ? previous : { left, top });
  }, [current, pages]);
  useLayoutEffect(() => {
    if (!current) { setToolbarPosition(null); return; }
    const frame = requestAnimationFrame(positionToolbar);
    window.addEventListener("scroll", positionToolbar, true);
    window.addEventListener("resize", positionToolbar);
    const observer = new ResizeObserver(positionToolbar);
    if (toolbarRef.current) observer.observe(toolbarRef.current);
    for (const fragment of current.pages) {
      const page = document.querySelector<HTMLElement>(`.pdf-area-layer[data-pdf-page-index="${fragment.pageIndex}"]`);
      if (page) observer.observe(page);
    }
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", positionToolbar, true);
      window.removeEventListener("resize", positionToolbar);
      observer.disconnect();
    };
  }, [current, positionToolbar]);
  const copySelection = async () => {
    setCopyStatus(t("pdfReader.copying"));
    try {
      const copied = await copyPlainText(current?.text ?? "");
      setCopyStatus(t(copied ? "pdfReader.textCopied" : "pdfReader.copyFailed"));
    } catch { setCopyStatus(t("pdfReader.copyFailed")); }
  };
  const create = (kind: "highlight" | "underline" | "strikeout") => {
    if (!current || blocked || !session.isWritable()) return;
    const target = buildPdfTextTarget([current.text], current.pages, pages);
    if (!target) { setGeometryError(true); return; }
    const at = new Date().toISOString();
    const created = session.create({ id: `pann_${crypto.randomUUID()}`, kind, target, body: t("pdfReader.defaultBody"), created_at: at, updated_at: at });
    if (created) { selection?.forDocument(docId).clear(); setCurrent(null); setGeometryError(false); }
  };
  if (!enabled || !current) return null;
  return <div ref={toolbarRef} style={{ position: "fixed", left: toolbarPosition?.left ?? 8, top: toolbarPosition?.top ?? 8, zIndex: 20 }} className="pdf-text-tools" data-ui="pdf-selection-tools" role="toolbar" aria-label={t("pdfReader.textToolsTitle")} aria-live="polite" onKeyDown={extendSelectionWithKeyboard}>
    <blockquote>{current.text}</blockquote>
    {geometryError && <p role="alert">{t("pdfReader.textTargetGeometryError")}</p>}
    <button type="button" data-ui="copy-pdf-selection" onClick={() => void copySelection()}>{t("pdfReader.copySelection")}</button>
    {copyStatus && <span role="status">{copyStatus}</span>}
    <button type="button" disabled={blocked} data-ui="highlight-pdf-selection" onClick={() => create("highlight")}>{t("pdfReader.highlight")}</button>
    <button type="button" disabled={blocked} data-ui="underline-pdf-selection" onClick={() => create("underline")}>{t("pdfReader.underline")}</button>
    <button type="button" disabled={blocked} data-ui="strikeout-pdf-selection" onClick={() => create("strikeout")}>{t("pdfReader.strikeout")}</button>
  </div>;
}

function PdfTextAnnotationsLayer({ pageIndex, rotation, annotations, onActivate }: { pageIndex: number; rotation: number; annotations: PdfAnnotation[]; onActivate: (id: string) => void }) {
  const { t } = useTranslation();
  return <div className="pdf-text-annotations" data-ui="pdf-text-marks" data-pdf-page-index={pageIndex} role="group" aria-label={t("pdfReader.textAnnotations")}>
    {annotations.flatMap((annotation) => {
      if (!(annotation.kind === "highlight" || annotation.kind === "underline" || annotation.kind === "strikeout")) return [];
      const fragment = annotation.target.fragments.find((item) => item.page_index === pageIndex);
      if (!fragment) return [];
      return fragment.rectangles.map((rect, index) => {
        const sdkRect = pdfPageRectFromVisible(rect, rotation);
        return <button
        key={`${annotation.id}-${index}`} type="button" data-pdf-annotation-id={annotation.id} data-pdf-rectangle-index={index} data-ui="pdf-text-mark" data-ui-key={`${annotation.id}:${index}`} className={`pdf-text-mark ${annotation.kind}`}
        aria-label={t("pdfReader.textMarkLabel", { kind: t(`pdfReader.${annotation.kind}`), quote: annotation.target.quote })}
        title={annotation.target.quote}
        style={{ left: `${sdkRect.x * 100}%`, top: `${sdkRect.y * 100}%`, width: `${sdkRect.width * 100}%`, height: `${sdkRect.height * 100}%` }}
        onClick={() => onActivate(annotation.id)}
      />;
      });
    })}
  </div>;
}

function pdfAnnotationLocation(annotation: PdfAnnotation): PdfReadingLocation | null {
  if (annotation.kind === "rectangle") return { page_index: annotation.page_index, x: annotation.rectangle.x + annotation.rectangle.width / 2, y: annotation.rectangle.y };
  if (annotation.kind === "page_comment") return { page_index: annotation.page_index, x: 0.5, y: 0 };
  if (annotation.kind === "highlight" || annotation.kind === "underline" || annotation.kind === "strikeout") {
    const fragment = annotation.target.fragments[0];
    const rectangle = fragment?.rectangles[0];
    return fragment && rectangle ? { page_index: fragment.page_index, x: rectangle.x + rectangle.width / 2, y: rectangle.y } : null;
  }
  return null;
}

function placeReaderAtLocation(location: PdfReadingLocation, stillCurrent: () => boolean): void {
  let attempts = 0;
  const place = () => {
    if (attempts++ > 90 || !stillCurrent()) return;
    const scroller = document.querySelector<HTMLElement>(".pdf-scroller");
    const page = document.querySelector<HTMLElement>(`.pdf-area-layer[data-pdf-page-index="${location.page_index}"]`);
    if (!scroller || !page || page.getBoundingClientRect().height <= 0) { requestAnimationFrame(place); return; }
    const pageRect = page.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    scroller.scrollTop += pageRect.top - scrollerRect.top + location.y * pageRect.height;
    scroller.scrollLeft += pageRect.left - scrollerRect.left + location.x * pageRect.width - scrollerRect.width / 2;
  };
  requestAnimationFrame(place);
}

function ReadingPositionWarning({ busy, retry, failed, saved, failure }: { busy: boolean; retry: () => void; failed: boolean; saved: boolean; failure: PositionWriterFailure | null }) {
  const { t } = useTranslation();
  const [dismissed, setDismissed] = useState(false);
  const failureMessage = failure === "restore" ? "pdfReader.positionError"
    : failure === "revision-conflict" ? "pdfReader.positionRevisionConflict"
      : failure === "content-changed" ? "pdfReader.positionContentChanged"
        : failure === "read" ? "pdfReader.positionReadFailed"
          : "pdfReader.positionSaveFailed";
  const summaryMessage = failure === "restore" ? "pdfReader.positionErrorSummary"
    : failure === "revision-conflict" ? "pdfReader.positionRevisionConflictSummary"
      : failure === "content-changed" ? "pdfReader.positionContentChanged"
        : failure === "read" ? "pdfReader.positionReadFailed"
          : "pdfReader.positionSaveFailed";
  return (
    <div className="pdf-position-warning" data-ui="pdf-reading-position-notice" role={failed && !dismissed ? "alert" : "status"}>
      {failed && !dismissed && <IconButton variant="ghost" label={t("pdfReader.dismissPositionError")} data-ui="dismiss-pdf-position-error" icon={<Icon name="x" cls="ico-sm" />} onClick={() => setDismissed(true)} />}
      <span>{failed ? t(dismissed ? summaryMessage : failureMessage) : busy ? t("pdfReader.positionSaving") : saved ? t("pdfReader.positionSaved") : ""}</span>
      {failed && <button type="button" disabled={busy} data-ui="retry-pdf-reading-position" onClick={retry}>{t(failure === "revision-conflict" ? "pdfReader.positionCheckAgain" : "pdfReader.retry")}</button>}
    </div>
  );
}

function PdfSearchControls({ docId, pages, onUserNavigation }: { docId: string; pages: Array<{ width: number; height: number; rotation: number }>; onUserNavigation: () => void }) {
  const { t } = useTranslation();
  const { provides: search } = useSearchCapability();
  const { provides: scroll } = useScrollCapability();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  useEffect(() => {
    if (!search) return;
    const scope = search.forDocument(docId);
    return scope.onStateChange((state) => { setResults(state.results); setLoading(state.loading); });
  }, [docId, search]);
  const run = () => {
    if (!search) return;
    setSearched(true);
    const task = search.forDocument(docId).searchAllPages(query);
    task.wait((result) => { setResults(result.results); setLoading(false); }, () => setLoading(false));
    setLoading(true);
  };
  const navigate = (result: SearchResult, index: number) => {
    onUserNavigation();
    search?.forDocument(docId).goToResult(index);
    scroll?.forDocument(docId).scrollToPage({ pageNumber: result.pageIndex + 1 });
    const geometry = pages[result.pageIndex];
    const rect = result.rects[0];
    if (!geometry || !rect) return;
    const visible = pdfPageRectToVisible({ x: rect.origin.x / geometry.width, y: rect.origin.y / geometry.height, width: rect.size.width / geometry.width, height: rect.size.height / geometry.height }, geometry.rotation);
    let attempts = 0;
    const place = () => {
      if (attempts++ > 20) return;
      const scroller = document.querySelector<HTMLElement>(".pdf-scroller");
      const page = document.querySelector<HTMLElement>(`.pdf-area-layer[data-pdf-page-index="${result.pageIndex}"]`);
      if (!scroller || !page || page.getBoundingClientRect().height <= 0) { requestAnimationFrame(place); return; }
      const pageRect = page.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      scroller.scrollTop += pageRect.top - scrollerRect.top + visible.y * pageRect.height;
      scroller.scrollLeft += pageRect.left - scrollerRect.left + visible.x * pageRect.width;
    };
    requestAnimationFrame(place);
  };
  return <div className="pdf-search-controls" data-ui="pdf-search">
    <label><span className="sr-only">{t("pdfReader.search")}</span><input data-ui="pdf-search-query" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") run(); }} placeholder={t("pdfReader.search")} /></label>
    <button type="button" disabled={!search || !query.trim() || loading} data-ui="run-pdf-search" onClick={run}>{t("pdfReader.search")}</button>
    <span role="status">{loading ? t("pdfReader.searching") : searched && results.length === 0 ? t("pdfReader.searchNoResults") : searched ? t("pdfReader.searchCount", { count: results.length }) : ""}</span>
    {results.slice(0, 20).map((result, index) => <button type="button" className="pdf-search-result" data-ui="pdf-search-result" data-ui-key={`${result.pageIndex}:${result.charIndex}:${index}`} key={`${result.pageIndex}-${result.charIndex}-${index}`} onClick={() => navigate(result, index)}>{t("pdfReader.searchResult", { index: index + 1, page: result.pageIndex + 1 })} · {result.context?.before ?? ""}{result.context?.match ?? ""}{result.context?.after ?? ""}</button>)}
  </div>;
}

function PdfToolbar({ docId, filename, workTitle, bytes, totalPages, pages, onUserNavigation, onCurrentPage }: { docId: string; filename: string; workTitle: string; bytes: ArrayBuffer; totalPages: number; pages: Array<{ width: number; height: number; rotation: number }>; onUserNavigation: () => void; onCurrentPage: (page: number) => void }) {
  const { t } = useTranslation();
  const { provides: scroll } = useScrollCapability();
  const { provides: zoom } = useZoomCapability();
  const [page, setPage] = useState(1);
  const [copyStatus, setCopyStatus] = useState("");
  const [actualPage, setActualPage] = useState(1);
  useEffect(() => {
    if (!scroll) return;
    const scope = scroll.forDocument(docId);
    setActualPage(scope.getCurrentPage());
    onCurrentPage(scope.getCurrentPage());
    return scope.onPageChange((event) => { setActualPage(event.pageNumber); setPage(event.pageNumber); onCurrentPage(event.pageNumber); });
  }, [scroll, docId, onCurrentPage]);
  const moveToPage = () => {
    if (!scroll || !Number.isInteger(page) || page < 1 || page > totalPages) return;
    onUserNavigation();
    scroll.forDocument(docId).scrollToPage({ pageNumber: page });
  };
  const copyPageLink = async () => {
    try {
      const copied = await copyPlainText(new URL(docRouteUrl(docId, `page-${actualPage}`), window.location.origin).href);
      setCopyStatus(t(copied ? "pdfReader.linkCopied" : "pdfReader.copyFailed"));
    } catch { setCopyStatus(t("pdfReader.copyFailed")); }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return <header className="pdf-toolbar" data-ui="pdf-toolbar" role="toolbar" aria-label={t("pdfReader.toolbar")}>
    <div className="pdf-doc-context"><strong>{workTitle}</strong><code>{filename} · {docId}</code></div>
    <div className="pdf-page-controls" data-ui="pdf-page-controls">
      <button type="button" disabled={!scroll || actualPage <= 1} data-ui="previous-pdf-page" aria-label={t("pdfReader.previousPage")} onClick={() => { onUserNavigation(); scroll?.forDocument(docId).scrollToPreviousPage(); }}>{"‹"}</button>
      <input data-ui="pdf-page-number" aria-label={t("pdfReader.pageNumber")} type="number" min={1} max={totalPages} value={page} onChange={(event) => setPage(Number(event.target.value))} onBlur={() => setPage(actualPage)} onKeyDown={(event) => { if (event.key === "Enter") moveToPage(); }} />
      <span>{t("pdfReader.pageOf", { page: actualPage, total: totalPages })}</span>
      <button type="button" disabled={!scroll || actualPage >= totalPages} data-ui="next-pdf-page" aria-label={t("pdfReader.nextPage")} onClick={() => { onUserNavigation(); scroll?.forDocument(docId).scrollToNextPage(); }}>{"›"}</button>
      <button type="button" data-ui="go-to-pdf-page" onClick={moveToPage}>{t("pdfReader.goToPage")}</button>
      <button type="button" data-ui="copy-pdf-page-link" onClick={() => void copyPageLink()}>{t("pdfReader.copyPageLink")}</button>
      {copyStatus && <span role="status">{copyStatus}</span>}
    </div>
    <PdfSearchControls docId={docId} pages={pages} onUserNavigation={onUserNavigation} />
    <div className="pdf-zoom-controls" data-ui="pdf-zoom-controls">
      <button type="button" disabled={!zoom} data-ui="zoom-out-pdf" aria-label={t("pdfReader.zoomOut")} onClick={() => zoom?.forDocument(docId).zoomOut()}>−</button>
      <button type="button" data-ui="fit-pdf-width" disabled={!zoom} onClick={() => zoom?.forDocument(docId).requestZoom(ZoomMode.FitWidth)}>{t("pdfReader.fitWidth")}</button>
      <button type="button" data-ui="fit-pdf-page" disabled={!zoom} onClick={() => zoom?.forDocument(docId).requestZoom(ZoomMode.FitPage)}>{t("pdfReader.fitPage")}</button>
      <button type="button" disabled={!zoom} data-ui="zoom-in-pdf" aria-label={t("pdfReader.zoomIn")} onClick={() => zoom?.forDocument(docId).zoomIn()}>+</button>
    </div>
    <button type="button" data-ui="download-original-pdf" onClick={download}>{t("pdfReader.downloadOriginal")}</button>
  </header>;
}
