export async function fetchPapers(): Promise<string[]> {
  const r = await fetch("/api/papers");
  if (!r.ok) throw new Error(`/api/papers ${r.status}`);
  return (await r.json()).papers as string[];
}

/** The HTTP status of a Doc's description: 404 when the Doc is not there (deleted, never ingested). Rejects when unreachable. */
export async function docDescriptionStatus(docId: string): Promise<number> {
  const r = await fetch(`/api/paper/${encodeURIComponent(docId)}/description`, { cache: "no-store" });
  return r.status;
}

/** Build the concrete image endpoint; FigureImage adds the accepted SHA. */
export function imageUrl(docId: string, imgPath?: string): string | null {
  if (!imgPath) return null;
  return `/images/${encodeURIComponent(docId)}/${imgPath.split("/").map(encodeURIComponent).join("/")}`;
}
