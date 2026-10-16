/**
 * Stage 10 M2b — Writer REST client (`/api/writer/*`, server app.ts).
 *
 * Mirrors api/plans.ts conventions: NO fixture fallback anywhere — a network
 * or server failure surfaces as an explicit error state in the view (never
 * disguised as empty data). The 409 PUT body carries the server's current
 * document (`{detail, rev, current}`) so the editor can adopt it directly
 * without a second round-trip.
 */

import type {
  ManuscriptSummary,
  WriterManuscript,
  WriterNumberingResponse,
  WriterTemplate,
} from "@argelanderspace/contracts";
import { apiRequest, HttpError, underlyingError } from "./request";

export interface TemplatesResult {
  templates: WriterTemplate[];
  warnings: string[];
}

/** null = unreachable/failed (caller shows an error state). */
export async function fetchTemplates(): Promise<TemplatesResult | null> {
  try {
    return await apiRequest<TemplatesResult>("/api/writer/templates");
  } catch {
    return null;
  }
}

export interface ManuscriptsResult {
  manuscripts: ManuscriptSummary[];
  warnings: string[];
}

/** null = unreachable/failed. */
export async function fetchManuscripts(): Promise<ManuscriptsResult | null> {
  try {
    return await apiRequest<ManuscriptsResult>("/api/writer/manuscripts");
  } catch {
    return null;
  }
}

/** null = 404 (deleted / never existed); throws nothing on network failure —
 *  a failed fetch of an existing doc also yields null, callers distinguish by
 *  context (initial load vs. refetch keeps the current doc on failure). */
export async function fetchManuscript(id: string): Promise<WriterManuscript | null> {
  try {
    return await apiRequest<WriterManuscript>(`/api/writer/manuscripts/${encodeURIComponent(id)}`);
  } catch {
    return null;
  }
}

/** Whether the server has the manuscript: `error` is a failed request, never reported as missing. */
export async function probeManuscript(id: string): Promise<"found" | "missing" | "error"> {
  try {
    await apiRequest(`/api/writer/manuscripts/${encodeURIComponent(id)}`, {}, { parse: "none" });
    return "found";
  } catch (e) {
    return e instanceof HttpError && e.status === 404 ? "missing" : "error";
  }
}

/** 400 (unknown template / bad input) and network failures both reject. */
export async function createManuscript(input: {
  template: string;
  title?: string;
}): Promise<WriterManuscript> {
  try {
    return await apiRequest<WriterManuscript>("/api/writer/manuscripts", { method: "POST", json: input });
  } catch (e) {
    if (e instanceof HttpError && e.status > 0) throw new Error(`create manuscript failed: ${e.status}`);
    throw underlyingError(e);
  }
}

export type PutManuscriptResult =
  | { ok: true; doc: WriterManuscript } // 200: persisted, rev bumped
  | { ok: false; conflict: WriterManuscript } // 409: server's current doc
  | { ok: false; conflict: null }; // other failure (network / 404 / 400)

/** Whole-document replace; the body carries the client's rev. */
export async function putManuscript(doc: WriterManuscript): Promise<PutManuscriptResult> {
  try {
    return {
      ok: true,
      doc: await apiRequest<WriterManuscript>(`/api/writer/manuscripts/${encodeURIComponent(doc.id)}`, { method: "PUT", json: doc }),
    };
  } catch (e) {
    // A 409 body without the current doc (not JSON, or null) is an ordinary failure.
    if (e instanceof HttpError && e.status === 409 && e.body !== null) {
      return { ok: false, conflict: (e.body as { current: WriterManuscript }).current };
    }
    return { ok: false, conflict: null };
  }
}

export async function deleteManuscript(id: string): Promise<boolean> {
  try {
    await apiRequest(`/api/writer/manuscripts/${encodeURIComponent(id)}`, { method: "DELETE" }, { parse: "none" });
    return true;
  } catch {
    return false;
  }
}

/** Raw-body upload; resolves to the stored asset name (may differ from the
 *  file's name on collision). Throws on any non-2xx. */
export async function uploadAsset(id: string, file: File): Promise<string> {
  let body: { name: string };
  try {
    body = await apiRequest(
      `/api/writer/manuscripts/${encodeURIComponent(id)}/assets?filename=${encodeURIComponent(file.name)}`,
      { method: "POST", raw: file }
    );
  } catch (e) {
    if (e instanceof HttpError && e.status > 0) throw new Error(`asset upload failed: ${e.status}`);
    throw underlyingError(e);
  }
  return body.name;
}

/** URL of the asset-serving route (figure <img src>). */
export function assetUrl(id: string, name: string): string {
  return `/api/writer/manuscripts/${encodeURIComponent(id)}/assets/${encodeURIComponent(name)}`;
}

/** URL of the server-assembled export zip (manuscript.tex + bib + assets). */
export function exportUrl(id: string): string {
  return `/api/writer/manuscripts/${encodeURIComponent(id)}/export`;
}

/** Numbering state (D14); 404 → null. */
export async function fetchNumbering(id: string): Promise<WriterNumberingResponse | null> {
  try {
    return await apiRequest<WriterNumberingResponse>(`/api/writer/manuscripts/${encodeURIComponent(id)}/numbering`);
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    if (e instanceof HttpError && e.status > 0) throw new Error(`numbering fetch failed: ${e.status}`);
    throw underlyingError(e);
  }
}

/** Force a numbering re-compile now (manual refresh). */
export async function refreshNumbering(
  id: string,
  opts: { copilot?: boolean } = {}
): Promise<WriterNumberingResponse> {
  try {
    return await apiRequest<WriterNumberingResponse>(`/api/writer/manuscripts/${encodeURIComponent(id)}/numbering/refresh`, {
      method: "POST",
      // The page marks a render it makes for a Copilot view action; the service no longer reads it (no sandbox gate since copilot ticket 59).
      ...(opts.copilot ? { headers: { "X-Copilot-Action": "1" } } : {}),
    });
  } catch (e) {
    if (e instanceof HttpError && e.status > 0) throw Object.assign(new Error(`numbering refresh failed: ${e.status}`), { status: e.status });
    throw underlyingError(e);
  }
}
