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
  /**
   * Why the example is shown: `unreachable` (no answer from the service) or `error` (it answered but the
   * library could not be read). Absent when `live`.
   */
  failure?: { kind: "unreachable" | "error"; reason: string };
}

export type DocProvenance = "arxiv" | "upload" | "pdf" | "arxiv-pdf" | "text" | "unknown";

/**
 * Read the explicit Doc descriptor for document-list presentation. Planner
 * labels and Doc ids are not provenance; unsupported or failed metadata stays unknown.
 */
export async function fetchDocProvenance(
  docId: string,
  signal?: AbortSignal
): Promise<DocProvenance> {
  try {
    const response = await fetch(`/api/paper/${encodeURIComponent(docId)}/description`, { signal });
    if (!response.ok) return "unknown";
    const body = (await response.json()) as { format?: unknown; acquired_via?: unknown };
    if (body.format === "pdf" && body.acquired_via === "arxiv_pdf") return "arxiv-pdf";
    if (body.format === "pdf" && body.acquired_via === "user_pdf_upload") return "pdf";
    if (body.format === "text") return "text";
    if (body.format !== "latex") return "unknown";
    if (body.acquired_via === "arxiv_eprint") return "arxiv";
    if (body.acquired_via === "user_latex_zip") return "upload";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export async function fetchLibrary(): Promise<LibraryLoad> {
  const example = (kind: "unreachable" | "error", reason: string): LibraryLoad => ({
    data: LIBRARY_FIXTURE,
    live: false,
    failure: { kind, reason },
  });
  let response: Response;
  try {
    response = await fetch("/api/library");
  } catch {
    return example("unreachable", "the service did not answer");
  }
  if (!response.ok) return example("error", `HTTP ${response.status}`);
  try {
    return { data: (await response.json()) as LibraryData, live: true };
  } catch {
    return example("error", "the response was not valid JSON");
  }
}

/**
 * The answer to a job start: the server's 202 with the queued (or already in-flight) job, or why it did not queue
 * one. `status` is the HTTP status (0: no answer); a busy document is 409 with the detail "document busy".
 */
export type StartResult = { ok: true; job: Job } | { ok: false; status: number; detail: string };

async function startJob(url: string, init: RequestInit, what: string): Promise<StartResult> {
  try {
    const r = await fetch(url, init);
    if (r.status !== 202) {
      const body = (await r.json().catch(() => null)) as { detail?: unknown } | null;
      const detail = typeof body?.detail === "string" ? body.detail : `${what} ${r.status}`;
      return { ok: false, status: r.status, detail };
    }
    const body = (await r.json()) as { job?: Job };
    return body.job ? { ok: true, job: body.job } : { ok: false, status: 500, detail: `${what} response did not contain a job` };
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

export type UploadPdfResult =
  | { ok: true; job: Job; resourceWarning: boolean }
  | { ok: false; status: number; detail: string };

export async function uploadPdf(workId: string, file: File): Promise<UploadPdfResult> {
  try {
    const r = await fetch(`/api/library/upload-pdf?id=${encodeURIComponent(workId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.name) },
      body: file,
    });
    if (r.status !== 202) {
      const body = (await r.json().catch(() => null)) as { detail?: string } | null;
      return { ok: false, status: r.status, detail: body?.detail ?? `PDF upload ${r.status}` };
    }
    const body = (await r.json()) as { job?: Job; resourceWarning?: boolean };
    return body.job
      ? { ok: true, job: body.job, resourceWarning: Boolean(body.resourceWarning) }
      : { ok: false, status: 500, detail: "PDF upload response did not contain a job" };
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

/** Attach a user-supplied LaTeX source zip to a work (server-side ingest).
 *  The zip rides as the raw request body; the work id is a query param.
 *  Async: the server answers 202 with the queued job immediately;
 *  watch /ws (`onJobEvent` in ./ws) for progress and the done/failed outcome,
 *  then reload the library. */
export async function uploadLatexZip(workId: string, file: File | Blob): Promise<StartResult> {
  return startJob(
    `/api/library/upload?id=${encodeURIComponent(workId)}`,
    { method: "POST", headers: { "Content-Type": "application/zip" }, body: file },
    "LaTeX upload"
  );
}

/** Queue a new arXiv PDF acquisition for a work (job kind `"upload"`, payload format `"arxiv-pdf"`). */
export async function acquireArxivPdf(workId: string): Promise<StartResult> {
  return startJob(
    `/api/library/acquire-arxiv-pdf?id=${encodeURIComponent(workId)}`,
    { method: "POST" },
    "arXiv PDF acquisition"
  );
}

/**
 * Stage 15: queue the arXiv e-print fetch (or in-place refresh) for a work —
 * job kind `"ingest"`, the work id rides as a query param. The server answers
 * 202 with the queued (or already in-flight) job; watch /ws (`onJobEvent`)
 * for progress and the done/failed outcome, then reload the library.
 * A 409 is a busy document, a Work that already has a non-arXiv Doc (scenario C) or a Work that changed.
 */
export async function attachArxiv(workId: string): Promise<StartResult> {
  return startJob(`/api/library/attach-arxiv?id=${encodeURIComponent(workId)}`, { method: "POST" }, "arXiv fetch");
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
