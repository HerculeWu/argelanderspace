import type { Doc } from "./types";

export async function fetchPapers(): Promise<string[]> {
  const r = await fetch("/api/papers");
  if (!r.ok) throw new Error(`/api/papers ${r.status}`);
  return (await r.json()).papers as string[];
}

export async function fetchPaper(docId: string): Promise<Doc> {
  const r = await fetch(`/api/paper/${encodeURIComponent(docId)}`);
  if (!r.ok) throw new Error(`/api/paper/${docId} ${r.status}`);
  return (await r.json()) as Doc;
}

/** Resolve a MinerU img_path ("images/<hash>.jpg") to a backend URL. */
export function imageUrl(docId: string, imgPath?: string): string | null {
  if (!imgPath) return null;
  const file = imgPath.split("/").pop();
  if (!file) return null;
  return `/images/${encodeURIComponent(docId)}/${encodeURIComponent(file)}`;
}
