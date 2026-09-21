import type { Job } from "@argelanderspace/contracts";
import type {
  LibraryData,
  LibraryRef,
  ManualWorkRequest,
  ManualWorkResponse,
} from "../library/types";
import { LIBRARY_FIXTURE } from "../library/fixture";

// The ArgelanderSpace Library talks to /api/library/*. Each call tries live
// first and falls back to the ported design fixture when the backend is
// unreachable — the UI stays interactive and switches to real data
// automatically once the server is up.

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

export type DocProvenance = "arxiv" | "upload" | "unknown";

/**
 * Read only the stored IR's explicit acquisition provenance for document-list
 * presentation. This metadata request does not accept Reader content or touch
 * annotations; absent, unsupported, malformed, and failed responses all remain
 * honestly unknown.
 */
export async function fetchDocProvenance(
  docId: string,
  signal?: AbortSignal
): Promise<DocProvenance> {
  try {
    const response = await fetch(`/api/paper/${encodeURIComponent(docId)}/ir`, { signal });
    if (!response.ok) return "unknown";
    const body = (await response.json()) as unknown;
    if (body === null || typeof body !== "object" || Array.isArray(body)) return "unknown";
    const source = (body as Record<string, unknown>).source;
    if (source === null || typeof source !== "object" || Array.isArray(source)) return "unknown";
    const acquiredVia = (source as Record<string, unknown>).acquired_via;
    if (acquiredVia === "arxiv_eprint") return "arxiv";
    if (acquiredVia === "user_latex_zip") return "upload";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function fetchLibrary(): Promise<LibraryLoad> {
  const live = await tryJson<LibraryData>("/api/library");
  return live ? { data: live, live: true } : { data: LIBRARY_FIXTURE, live: false };
}

/** Attach a user-supplied LaTeX source zip to a work (server-side ingest).
 *  The zip rides as the raw request body; the work id is a query param.
 *  Async: the server answers 202 with the queued job immediately;
 *  watch /ws (`onJobEvent` in ./ws) for progress and the done/failed outcome,
 *  then reload the library. Returns the job, or null when the POST failed. */
export async function uploadLatexZip(workId: string, file: File | Blob): Promise<Job | null> {
  try {
    const r = await fetch(`/api/library/upload?id=${encodeURIComponent(workId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/zip" },
      body: file,
    });
    if (r.status !== 202) return null;
    const j = (await r.json()) as { job?: Job };
    return j.job ?? null;
  } catch {
    return null;
  }
}

/**
 * Stage 15: queue the arXiv e-print fetch (or in-place refresh) for a work —
 * job kind `"ingest"`, the work id rides as a query param. The server answers
 * 202 with the queued (or already in-flight) job; watch /ws (`onJobEvent`)
 * for progress and the done/failed outcome, then reload the library.
 * Returns the job, or null when the POST failed (e.g. 409 scenario C).
 */
export async function attachArxiv(workId: string): Promise<Job | null> {
  try {
    const r = await fetch(`/api/library/attach-arxiv?id=${encodeURIComponent(workId)}`, {
      method: "POST",
    });
    if (r.status !== 202) return null;
    const j = (await r.json()) as { job?: Job };
    return j.job ?? null;
  } catch {
    return null;
  }
}

/**
 * Manual work creation (Stage 13 import menu): one identifier / bibcode, or
 * a raw BibTeX batch. Per-entry outcomes ride in the 200 body; null = the
 * backend is unreachable or rejected the request wholesale.
 */
export async function createWorks(req: ManualWorkRequest): Promise<ManualWorkResponse | null> {
  return tryJson<ManualWorkResponse>("/api/library/works", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
}

/** Persist a per-reference state change (color label, read flag, note, tags, main doc). */
export async function patchRef(
  id: string,
  patch: Partial<Pick<LibraryRef, "label" | "read" | "star" | "tags" | "doc_id">>
): Promise<boolean> {
  // work ids contain slashes/colons → id rides in the body, not the path
  const r = await tryJson<unknown>("/api/library/refs", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, ...patch }),
  });
  return r !== null;
}
