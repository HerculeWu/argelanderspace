import { useEffect, useState } from "react";
import type { Doc } from "./types";
import { fetchPaper, fetchPapers } from "./api";
import { StoreProvider, useStore, useCanUndo } from "./store";
import { Reader } from "./components/Reader";
import { TocPanel } from "./components/TocPanel";
import { RightPanel } from "./components/RightPanel";

export function App() {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const url = new URL(window.location.href);
        let id = url.searchParams.get("doc");
        if (!id) {
          const papers = await fetchPapers();
          if (papers.length === 0) throw new Error("No processed papers found in data/output/");
          id = papers[0];
        }
        const d = await fetchPaper(id);
        if (alive) setDoc(d);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="error">Failed to load paper:{"\n"}{error}</div>;
  if (!doc) return <div className="loading">Loading paper…</div>;

  return (
    <StoreProvider doc={doc}>
      <Shell />
    </StoreProvider>
  );
}

function Shell() {
  const { doc } = useStore();
  const [collapsedLeft, setCollapsedLeft] = useState(false);
  const [collapsedRight, setCollapsedRight] = useState(false);

  return (
    <div className="app">
      <header className="topbar">
        <h1 title={doc.meta.title}>{doc.meta.title || doc.doc_id}</h1>
        <span className="doc-meta">
          {doc.source.n_pages} pp · {doc.stats.n_references} refs · {doc.stats.n_figures} figs
        </span>
      </header>

      <div className="main">
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
