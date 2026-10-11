import { PdfReadingPositionSchema, type PdfReadingLocation, type PdfReadingPosition } from "@argelanderspace/contracts";
import { apiRequest, HttpError, underlyingError } from "./request";

export type ReadingPositionSaveResult =
  | { ok: true; file: PdfReadingPosition }
  | { ok: false; status: number; detail: string; rev?: number };

export async function fetchPdfReadingPosition(docId: string, contentSha256: string): Promise<PdfReadingPosition> {
  let body: { status?: unknown; file?: unknown };
  try {
    body = await apiRequest(`/api/paper/${encodeURIComponent(docId)}/pdf/reading-position`, { cache: "no-store" });
  } catch (e) {
    if (e instanceof HttpError && e.status > 0) throw new Error(`reading position GET ${e.status}`);
    throw underlyingError(e);
  }
  if (body.status !== "ready") throw new Error("reading position status mismatch");
  const file = PdfReadingPositionSchema.parse(body.file);
  if (file.doc_id !== docId || file.content_sha256 !== contentSha256)
    throw new Error("reading position binding mismatch");
  return file;
}

export async function savePdfReadingPosition(file: PdfReadingPosition): Promise<ReadingPositionSaveResult> {
  try {
    let body: unknown;
    try {
      body = await apiRequest(`/api/paper/${encodeURIComponent(file.doc_id)}/pdf/reading-position`, { method: "PUT", cache: "no-store", json: file });
    } catch (e) {
      // No usable answer (network, non-JSON) is reported as status 0 by the outer catch.
      if (!(e instanceof HttpError) || e.cause !== undefined) throw underlyingError(e);
      const error = e.body && typeof e.body === "object" ? e.body as { detail?: string; rev?: number } : {};
      return { ok: false, status: e.status, detail: error.detail ?? `Reading position PUT ${e.status}`, rev: error.rev };
    }
    const saved = PdfReadingPositionSchema.parse(body);
    if (saved.doc_id !== file.doc_id || saved.content_sha256 !== file.content_sha256 || saved.rev !== file.rev + 1)
      return { ok: false, status: 500, detail: "reading position response binding or revision mismatch" };
    return { ok: true, file: saved };
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function samePdfReadingLocation(a: PdfReadingLocation | null, b: PdfReadingLocation | null): boolean {
  return a === b || (a !== null && b !== null && a.page_index === b.page_index && a.x === b.x && a.y === b.y);
}
