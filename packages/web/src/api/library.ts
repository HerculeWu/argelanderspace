import { ArgumentGraphMergeNoteSchema, type Job } from "@argelanderspace/contracts";
import type {
  LibraryData,
  LibraryRef,
  ManualWorkRequest,
  ManualWorkResponse,
} from "../library/types";
import { LIBRARY_FIXTURE } from "../library/fixture";
import { type ApiRequestInit, apiRequest, HttpError, underlyingError } from "./request";

// The ArgelanderSpace Library talks to /api/library/*. Each call tries live
// first and falls back to the ported design fixture when the backend is
// unreachable — the UI stays interactive and switches to real data
// automatically once the server is up.

async function tryJson<T>(url: string, init?: ApiRequestInit): Promise<T | null> {
  try {
    return await apiRequest<T>(url, init);
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
    const body = await apiRequest<{ format?: unknown; acquired_via?: unknown }>(
      `/api/paper/${encodeURIComponent(docId)}/description`,
      {},
      { signal }
    );
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
    response = await apiRequest<Response>("/api/library", {}, { parse: "none" });
  } catch (e) {
    if (e instanceof HttpError && e.status > 0) return example("error", `HTTP ${e.status}`);
    return example("unreachable", "the service did not answer");
  }
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

async function startJob(url: string, init: ApiRequestInit, what: string): Promise<StartResult> {
  const refused = (status: number, body: unknown): StartResult => {
    const detail = (body as { detail?: unknown } | null)?.detail;
    return { ok: false, status, detail: typeof detail === "string" ? detail : `${what} ${status}` };
  };
  try {
    let r: Response;
    try {
      r = await apiRequest<Response>(url, init, { parse: "none" });
    } catch (e) {
      if (e instanceof HttpError && e.status > 0) return refused(e.status, e.body);
      throw underlyingError(e);
    }
    // Only a 202 queued a job; any other ok status is a refusal too.
    if (r.status !== 202) return refused(r.status, await r.json().catch(() => null));
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
  const refused = (status: number, body: unknown): UploadPdfResult => ({
    ok: false,
    status,
    detail: (body as { detail?: string } | null)?.detail ?? `PDF upload ${status}`,
  });
  try {
    let r: Response;
    try {
      r = await apiRequest<Response>(
        `/api/library/upload-pdf?id=${encodeURIComponent(workId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/pdf", "X-Filename": encodeURIComponent(file.name) },
          raw: file,
        },
        { parse: "none" }
      );
    } catch (e) {
      if (e instanceof HttpError && e.status > 0) return refused(e.status, e.body);
      throw underlyingError(e);
    }
    if (r.status !== 202) return refused(r.status, await r.json().catch(() => null));
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
    { method: "POST", headers: { "Content-Type": "application/zip" }, raw: file },
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
  try {
    return await apiRequest<ManualWorkResponse>("/api/library/works", { method: "POST", json: req });
  } catch (error) {
    // The Work merge was saved but a later step failed: the answer carries what became of the argument graphs
    // (ticket 06), which the page must still show.
    const body = error instanceof HttpError ? (error.body as { argument_graph_merges?: unknown } | null) : null;
    const parsed = ArgumentGraphMergeNoteSchema.array().safeParse(body?.argument_graph_merges);
    if (parsed.success && parsed.data.length > 0)
      return { results: [], argument_graph_merges: parsed.data, failed_after_merge: true };
    return null;
  }
}

/** Persist a per-reference state change (color label, read flag, note, tags, main doc). */
export async function patchRef(
  id: string,
  patch: Partial<Pick<LibraryRef, "label" | "read" | "star" | "tags" | "doc_id">>
): Promise<boolean> {
  // work ids contain slashes/colons → id rides in the body, not the path
  const r = await tryJson<unknown>("/api/library/refs", { method: "PATCH", json: { id, ...patch } });
  return r !== null;
}
