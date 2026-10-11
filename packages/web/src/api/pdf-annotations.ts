import { PdfAnnotationsFileSchema, PdfReaderSnapshotSchema, type PdfAnnotationsFile } from "@argelanderspace/contracts";
import { apiRequest, conflictKind, HttpError, underlyingError } from "./request";

export async function fetchPdfAnnotationsSnapshot(docId: string, contentSha256: string): Promise<PdfAnnotationsFile> {
  let answer: unknown;
  try {
    answer = await apiRequest(`/api/paper/${encodeURIComponent(docId)}/pdf/snapshot`, { cache: "no-store" });
  } catch (e) {
    if (!(e instanceof HttpError) || e.status === 0) throw underlyingError(e);
    const body = e.body as { detail?: string } | null;
    const error = new Error(body?.detail ?? `PDF snapshot GET ${e.status}`) as Error & { kind?: string };
    const conflict = conflictKind(e);
    if (conflict === "changed") error.kind = "document-changed";
    if (conflict === "busy") error.kind = "busy";
    throw error;
  }
  const snapshot = PdfReaderSnapshotSchema.parse(answer);
  if (snapshot.metadata.doc_id !== docId || snapshot.metadata.sha256 !== contentSha256 || snapshot.annotations.doc_id !== docId || snapshot.annotations.content_sha256 !== contentSha256) {
    const error = new Error("document changed") as Error & { kind?: string };
    error.kind = "document-changed";
    throw error;
  }
  return snapshot.annotations;
}

export type PdfAnnotationCountResult = { ok: true; count: number } | { ok: false; status: number; detail: string };
export async function fetchPdfAnnotationCount(docId: string): Promise<PdfAnnotationCountResult> {
  try {
    let ok = true;
    let status: number;
    let body: { count?: unknown; detail?: string };
    try {
      const response = await apiRequest<Response>(`/api/paper/${encodeURIComponent(docId)}/pdf/annotations/count`, { cache: "no-store" }, { parse: "none" });
      status = response.status;
      body = await response.json() as typeof body;
    } catch (e) {
      // No usable answer (network, non-JSON) is reported as status 0 by the outer catch.
      if (!(e instanceof HttpError) || e.cause !== undefined) throw underlyingError(e);
      ok = false;
      status = e.status;
      body = e.body as typeof body;
    }
    if (ok && Number.isInteger(body.count) && (body.count as number) >= 0) return { ok: true, count: body.count as number };
    return { ok: false, status, detail: body.detail ?? "PDF annotation count unavailable" };
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

export type SavePdfAnnotationsResult =
  | { ok: true; file: PdfAnnotationsFile }
  | { ok: false; kind: "document-changed" | "rev-mismatch" | "busy" | "error"; detail: string; rev?: number };

export async function savePdfAnnotations(docId: string, file: PdfAnnotationsFile): Promise<SavePdfAnnotationsResult> {
  try {
    try {
      const saved = await apiRequest(`/api/paper/${encodeURIComponent(docId)}/pdf/annotations`, { method: "PUT", cache: "no-store", json: file });
      return { ok: true, file: PdfAnnotationsFileSchema.parse(saved) };
    } catch (e) {
      // No usable answer (network, non-JSON) and a schema failure are reported by the outer catch.
      if (!(e instanceof HttpError) || e.cause !== undefined) throw underlyingError(e);
      const body = e.body as { detail?: string; rev?: number };
      const conflict = conflictKind(e);
      if (conflict === "changed") return { ok: false, kind: "document-changed", detail: body.detail! };
      if (conflict === "rev-mismatch") return { ok: false, kind: "rev-mismatch", detail: body.detail!, rev: body.rev };
      if (conflict === "busy") return { ok: false, kind: "busy", detail: body.detail! };
      return { ok: false, kind: "error", detail: body.detail ?? `PDF annotations PUT ${e.status}` };
    }
  } catch (error) {
    return { ok: false, kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}
