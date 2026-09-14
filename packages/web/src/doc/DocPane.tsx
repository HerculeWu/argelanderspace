import { useEffect, useRef, useState } from "react";
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

// The document reader, hosted as ArgelanderSpace's 文档 pane. Which paper is shown
// is driven by the shared workspace (so the Library's "open in 文档" works);
// the in-pane switcher changes it too.
export function DocPane() {
  const ws = useWorkspace();
  const id = ws.currentDoc;
  if (!id) return <div className="reader-root"><div className="loading">没有可显示的文档。处理一篇论文，或从 文献 中打开。</div></div>;
  return <ReaderSession key={id} docId={id}><SessionWorkspace /></ReaderSession>;
}

function SessionWorkspace() {
  const ws = useWorkspace();
  const { state, controller } = useReaderSession();
  const ir = state.accepted?.ir;
  return <div className="reader-session">
    {state.phase !== "ready" && <div className="reader-sync-status" role="status">
      {state.phase === "missing" ? "文档不存在。" : state.phase === "error" ? (ir ? "更新失败，当前为旧正文；图片及标注不可用。" : "文档载入失败，请手动重试。") : state.reason === "busy" ? "文档任务进行中，暂不可用。" : ir ? "正文更新中；保留旧文字，暂停图片及标注。" : "文档载入中…"}
      <button onClick={controller.retry}>手动重试</button>
    </div>}
    <RetainedDrafts />
    {ir && state.phase !== "missing" ? <StoreProvider ir={ir} anchorPending={!!ws.pendingAnchor}>
      <AnnotationProvider><DocWorkspace papers={ws.papers} currentId={ir.docId} onSelect={ws.setCurrentDoc} /></AnnotationProvider>
    </StoreProvider> : !ir && state.phase === "syncing" && <div className="loading">Loading paper…</div>}
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
    <div className="reader-root">
      <header className="topbar">
        <h1 title={ir.title}>
          {ir.title ? <MathText as="span" text={ir.title} /> : ir.docId}
        </h1>
        {papers.length > 1 && (
          <select
            className="paper-switch"
            value={currentId}
            onChange={(e) => onSelect(e.target.value)}
            title="Switch paper"
          >
            {papers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}
        <span className="doc-meta">
          {ir.nPages !== undefined && `${ir.nPages} pp · `}
          {ir.bib.length} refs · {nFigs} figs
        </span>
      </header>

      <span className="reader-position-note">更新后位置可能变化</span>
      <div className="reader-main">
        <aside className={"panel left" + (collapsedLeft ? " collapsed" : "")}>
          <button
            className="panel-toggle"
            title={collapsedLeft ? "Expand contents" : "Collapse contents"}
            onClick={() => setCollapsedLeft((v) => !v)}
          >
            {collapsedLeft ? "»" : "«"}
          </button>
          <span className="rail-label">Contents</span>
          <div className="panel-body">
            <TocPanel />
          </div>
        </aside>

        <div className="reader-col">
          <Reader />
          <UndoFab />
          <AnnotationToast />
        </div>

        <aside className={"panel right" + (collapsedRight ? " collapsed" : "")}>
          <button
            className="panel-toggle"
            title={collapsedRight ? "Expand references" : "Collapse references"}
            onClick={() => setCollapsedRight((v) => !v)}
          >
            {collapsedRight ? "«" : "»"}
          </button>
          <span className="rail-label">References</span>
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
  if (!ann.notice) return null;
  return (
    <div className="ann-toast view-in" role="status">
      <span>{ann.notice}</span>
      <button className="ann-toast-x" title="关闭" onClick={ann.dismissNotice}>
        ×
      </button>
    </div>
  );
}

function UndoFab() {
  const store = useStore();
  const canUndo = useCanUndo();
  if (!canUndo) return null;
  return (
    <button className="undo-fab" onClick={store.undo} title="Return to position before the jump">
      ↩ Back
    </button>
  );
}
