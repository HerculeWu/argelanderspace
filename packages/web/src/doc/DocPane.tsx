import { useEffect, useState } from "react";
import type { DocIr } from "@argelanderspace/contracts";
import { fetchPaper } from "../api";
import { StoreProvider, useStore, useCanUndo } from "../store";
import { Reader } from "../components/Reader";
import { TocPanel } from "../components/TocPanel";
import { RightPanel } from "../components/RightPanel";
import { MathText } from "../lib/segments";
import { applyAnchor } from "../lib/deeplink";
import { useWorkspace } from "../argelander/workspace";

// The document reader, hosted as ArgelanderSpace's 文档 pane. Which paper is shown
// is driven by the shared workspace (so the Library's "open in 文档" works);
// the in-pane switcher changes it too.
export function DocPane() {
  const ws = useWorkspace();
  const id = ws.currentDoc;
  const [ir, setIr] = useState<DocIr | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setIr(null);
      return;
    }
    let alive = true;
    setIr(null);
    setError(null);
    (async () => {
      try {
        const d = await fetchPaper(id);
        if (alive) setIr(d);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  if (!id)
    return (
      <div className="reader-root">
        <div className="loading">没有可显示的文档。处理一篇论文，或从 文献 中打开。</div>
      </div>
    );
  if (error)
    return (
      <div className="reader-root">
        <div className="error">Failed to load paper:{"\n"}{error}</div>
      </div>
    );
  if (!ir)
    return (
      <div className="reader-root">
        <div className="loading">Loading paper…</div>
      </div>
    );

  return (
    <StoreProvider key={ir.docId} ir={ir}>
      <DocWorkspace papers={ws.papers} currentId={ir.docId} onSelect={ws.setCurrentDoc} />
    </StoreProvider>
  );
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
  const store = useStore();
  const ws = useWorkspace();
  const [collapsedLeft, setCollapsedLeft] = useState(false);
  const [collapsedRight, setCollapsedRight] = useState(false);

  // Deep link: land on the URL's #anchor once the doc has rendered (the blocks
  // are in the DOM by the time this effect runs). Unknown anchors just leave
  // the doc open at the top.
  const anchor = ws.pendingAnchor;
  useEffect(() => {
    if (!anchor) return;
    ws.clearPendingAnchor();
    applyAnchor(store, anchor);
  }, [anchor, store, ws]);

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
