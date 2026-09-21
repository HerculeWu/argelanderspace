/**
 * Document identities used by the existing manual acquisition endpoints.
 *
 * These functions mirror the server/core identity rules so RefDetail can bind
 * an annotation-risk check to the exact Doc the endpoint will replace. They do
 * not use provenance labels or guess from a `upload-` / `arxiv-` prefix.
 */

/** Mirrors core `normArxiv` + `arxivDocId` (unversioned latest-source target). */
export function arxivAcquisitionDocId(arxivId: string | undefined): string | null {
  if (!arxivId) return null;
  const normalized = arxivId.trim().toLowerCase().replace(/^arxiv:/, "").replace(/v\d+$/, "");
  if (!normalized) return null;
  const safe = normalized.replace(/[^a-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return safe ? `arxiv-${safe}` : null;
}

/** Mirrors core `uploadDocId(workId)`: `upload-<slug44>-<sha1[:6]>`. */
export async function uploadAcquisitionDocId(workId: string): Promise<string> {
  const slug =
    workId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 44) || "work";
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(workId)
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6);
  return `upload-${slug}-${hash}`;
}
