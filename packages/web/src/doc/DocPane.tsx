import { useEffect, useState } from "react";
import type { Doc } from "../types";
import { fetchPaper } from "../api";
import { StoreProvider, useStore, useCanUndo } from "../store";
import { Reader } from "../components/Reader";
import { TocPanel } from "../components/TocPanel";
import { RightPanel } from "../components/RightPanel";
import { RichText } from "../lib/richtext";
import { useWorkspace } from "../argelander/workspace";

// The document reader, hosted as ArgelanderSpace's 文档 pane. Which paper is shown
// is driven by the shared workspace (so the Library's "open in 文档" works);
// the in-pane switcher changes it too.
export function DocPane() {
  const ws = useWorkspace();
  const id = ws.currentDoc;
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setDoc(null);
      return;
    }
    let alive = true;
    setDoc(null);
    setError(null);
    (async () => {
      try {
        const d = await fetchPaper(id);
        if (alive) setDoc(d);
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
  if (!doc)
    return (
      <div className="reader-root">
        <div className="loading">Loading paper…</div>
      </div>
    );

  return (
    <StoreProvider key={doc.doc_id} doc={doc}>
      <DocWorkspace papers={ws.papers} currentId={doc.doc_id} onSelect={ws.setCurrentDoc} />
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
  const { doc } = useStore();
  const [collapsedLeft, setCollapsedLeft] = useState(false);
  const [collapsedRight, setCollapsedRight] = useState(false);

  return (
    <div className="reader-root">
      <header className="topbar">
        <h1 title={doc.meta.title}>
          {doc.meta.title ? <RichText as="span" text={doc.meta.title} /> : doc.doc_id}
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
          {doc.source.n_pages} pp · {doc.stats.n_references} refs · {doc.stats.n_figures} figs
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
