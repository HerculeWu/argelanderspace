export async function fetchPapers(): Promise<string[]> {
  const r = await fetch("/api/papers");
  if (!r.ok) throw new Error(`/api/papers ${r.status}`);
  return (await r.json()).papers as string[];
}

/** Build the concrete image endpoint; FigureImage adds the accepted SHA. */
export function imageUrl(docId: string, imgPath?: string): string | null {
  if (!imgPath) return null;
  return `/images/${encodeURIComponent(docId)}/${imgPath.split("/").map(encodeURIComponent).join("/")}`;
}
