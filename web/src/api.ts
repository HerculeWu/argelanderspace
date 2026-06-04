import type { Doc } from "./types";

export async function fetchPapers(): Promise<string[]> {
  const r = await fetch("/api/papers");
  if (!r.ok) throw new Error(`/api/papers ${r.status}`);
  return (await r.json()).papers as string[];
}

export async function fetchPaper(docId: string): Promise<Doc> {
  const r = await fetch(`/api/paper/${encodeURIComponent(docId)}`);
  if (!r.ok) throw new Error(`/api/paper/${docId} ${r.status}`);
  return normalizeDoc(await r.json());
}

// The ingestion pipelines (PDF / HTML / LaTeX) emit *sparse* docs: a paper with
// no tables simply omits `index.tables`, an arXiv-PDF doc may omit `references`
// entirely. The reader's Doc type declares those arrays as required, so the
// components read `doc.index.tables.length` / iterate `doc.references` without
// guards — which threw and blanked the whole pane (no error boundary). Fill the
// gaps once, here at the boundary, so every consumer sees the shape it expects.
function normalizeDoc(d: Partial<Doc> & { doc_id: string }): Doc {
  const ix = (d.index ?? {}) as Partial<Doc["index"]>;
  return {
    ...d,
    structure: d.structure ?? [],
    index: {
      figures: ix.figures ?? [],
      tables: ix.tables ?? [],
      equations: ix.equations ?? [],
      sections: ix.sections ?? [],
    },
    references: d.references ?? [],
    citations: d.citations ?? [],
    crossrefs: d.crossrefs ?? [],
    stats: d.stats ?? {},
  } as Doc;
}

/** Resolve a MinerU img_path ("images/<hash>.jpg") to a backend URL. */
export function imageUrl(docId: string, imgPath?: string): string | null {
  if (!imgPath) return null;
  const file = imgPath.split("/").pop();
  if (!file) return null;
  return `/images/${encodeURIComponent(docId)}/${encodeURIComponent(file)}`;
}
