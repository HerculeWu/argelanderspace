import type { AddRefResponse, LibraryData, LibraryRef } from "../library/types";
import { LIBRARY_FIXTURE } from "../library/fixture";

// The HubbleSpace Library talks to /api/library/*. Those endpoints don't exist
// yet (backend lands after the ADS key arrives), so each call tries live first
// and falls back to the ported design fixture — the UI is fully interactive now
// and switches to real data automatically once the backend is up.

async function tryJson<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, init);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export interface LibraryLoad {
  data: LibraryData;
  live: boolean; // false → showing fixture/demo data
}

export async function fetchLibrary(): Promise<LibraryLoad> {
  const live = await tryJson<LibraryData>("/api/library");
  return live ? { data: live, live: true } : { data: LIBRARY_FIXTURE, live: false };
}

/** Add a suggested graph node to the library (resolves full metadata server-side). */
export async function addRef(nodeId: string): Promise<AddRefResponse | null> {
  return tryJson<AddRefResponse>("/api/library/refs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "graph-node", nodeId }),
  });
}

/** Attach a user-supplied PDF to a work and OCR it (MinerU, server-side).
 *  The PDF rides as the raw request body; the work id is a query param. Slow:
 *  the response waits for OCR. Returns the updated ref, or null on failure. */
export async function uploadPdf(workId: string, file: File | Blob): Promise<LibraryRef | null> {
  try {
    const r = await fetch("/api/library/upload?id=" + encodeURIComponent(workId), {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { ref?: LibraryRef };
    return j.ref ?? null;
  } catch {
    return null;
  }
}

/** Persist a per-reference state change (color label, read flag, note, tags). */
export async function patchRef(
  id: string,
  patch: Partial<Pick<LibraryRef, "label" | "read" | "star" | "tags">>
): Promise<boolean> {
  // work ids contain slashes/colons → id rides in the body, not the path
  const r = await tryJson<unknown>("/api/library/refs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...patch }),
  });
  return r !== null;
}
