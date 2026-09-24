import { PdfReadingPositionSchema, type PdfReadingLocation, type PdfReadingPosition } from "@argelanderspace/contracts";

export type ReadingPositionSaveResult =
  | { ok: true; file: PdfReadingPosition }
  | { ok: false; status: number; detail: string; rev?: number };

export async function fetchPdfReadingPosition(docId: string, contentSha256: string): Promise<PdfReadingPosition> {
  const response = await fetch(`/api/paper/${encodeURIComponent(docId)}/pdf/reading-position`, { cache: "no-store" });
  if (!response.ok) throw new Error(`reading position GET ${response.status}`);
  const body = await response.json() as { status?: unknown; file?: unknown };
  if (body.status !== "ready") throw new Error("reading position status mismatch");
  const file = PdfReadingPositionSchema.parse(body.file);
  if (file.doc_id !== docId || file.content_sha256 !== contentSha256)
    throw new Error("reading position binding mismatch");
  return file;
}

export async function savePdfReadingPosition(file: PdfReadingPosition): Promise<ReadingPositionSaveResult> {
  try {
    const response = await fetch(`/api/paper/${encodeURIComponent(file.doc_id)}/pdf/reading-position`, {
      method: "PUT", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(file),
    });
    const body = await response.json() as unknown;
    if (response.ok) {
      const saved = PdfReadingPositionSchema.parse(body);
      if (saved.doc_id !== file.doc_id || saved.content_sha256 !== file.content_sha256 || saved.rev !== file.rev + 1)
        return { ok: false, status: 500, detail: "reading position response binding or revision mismatch" };
      return { ok: true, file: saved };
    }
    const error = body && typeof body === "object" ? body as { detail?: string; rev?: number } : {};
    return { ok: false, status: response.status, detail: error.detail ?? `Reading position PUT ${response.status}`, rev: error.rev };
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function samePdfReadingLocation(a: PdfReadingLocation | null, b: PdfReadingLocation | null): boolean {
  return a === b || (a !== null && b !== null && a.page_index === b.page_index && a.x === b.x && a.y === b.y);
}
