import { useEffect, useState } from "react";
import type { Doc } from "./types";
import { fetchPaper, fetchPapers } from "./api";
import { StoreProvider, useStore, useCanUndo } from "./store";
import { Reader } from "./components/Reader";
import { TocPanel } from "./components/TocPanel";
import { RightPanel } from "./components/RightPanel";

export function App() {
  const [papers, setPapers] = useState<string[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the available-papers list once, then pick the initial doc.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await fetchPapers();
        if (!alive) return;
        if (list.length === 0) throw new Error("No processed papers found in data/output/");
        setPapers(list);
        const want = new URL(window.location.href).searchParams.get("doc");
        setId(want && list.includes(want) ? want : list[0]);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => { alive = false; };
  }, []);

  // (Re)load the selected doc whenever the id changes.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    setDoc(null);
    (async () => {
      try {
        const d = await fetchPaper(id);
        if (alive) setDoc(d);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => { alive = false; };
  }, [id]);

  const selectPaper = (next: string) => {
    if (next === id) return;
    const url = new URL(window.location.href);
    url.searchParams.set("doc", next);
    window.history.replaceState(null, "", url);   // keep it on refresh / share
    setError(null);
    setId(next);
  };

  if (error) return <div className="error">Failed to load paper:{"\n"}{error}</div>;
  if (!doc) return <div className="loading">Loading paper…</div>;

  return (
    <StoreProvider key={doc.doc_id} doc={doc}>
      <Shell papers={papers} currentId={doc.doc_id} onSelect={selectPaper} />
    </StoreProvider>
  );
}

function Shell({
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
    <div className="app">
      <header className="topbar">
        <h1 title={doc.meta.title}>{doc.meta.title || doc.doc_id}</h1>
        {papers.length > 1 && (
          <select
            className="paper-switch"
            value={currentId}
            onChange={(e) => onSelect(e.target.value)}
            title="Switch paper"
          >
            {papers.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        )}
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
