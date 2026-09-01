import type { DocIr } from "@argelanderspace/contracts";

export async function fetchPapers(): Promise<string[]> {
  const r = await fetch("/api/papers");
  if (!r.ok) throw new Error(`/api/papers ${r.status}`);
  return (await r.json()).papers as string[];
}

// The reader consumes the shared render IR (Stage 3 / MS2): the server builds
// it with core's buildDocIr, so the shape is guaranteed and no client-side
// normalization is needed. Optional fields are handled defensively in the
// components instead.
export async function fetchPaper(docId: string): Promise<DocIr> {
  const r = await fetch(`/api/paper/${encodeURIComponent(docId)}/ir`);
  if (!r.ok) throw new Error(`/api/paper/${docId}/ir ${r.status}`);
  return (await r.json()) as DocIr;
}

/** Resolve a MinerU img_path ("images/<hash>.jpg", may carry a subdirectory)
 *  to a backend URL. The path is used verbatim — the server supports subpaths. */
export function imageUrl(docId: string, imgPath?: string): string | null {
  if (!imgPath) return null;
  return `/images/${encodeURIComponent(docId)}/${imgPath}`;
}
