import { PdfAnnotationsFileSchema, PdfReaderSnapshotSchema, type PdfAnnotationsFile } from "@argelanderspace/contracts";

export async function fetchPdfAnnotationsSnapshot(docId: string, contentSha256: string): Promise<PdfAnnotationsFile> {
  const response = await fetch(`/api/paper/${encodeURIComponent(docId)}/pdf/snapshot`, { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null;
    const error = new Error(body?.detail ?? `PDF snapshot GET ${response.status}`) as Error & { kind?: string };
    if (response.status === 409 && body?.detail === "document changed") error.kind = "document-changed";
    if (response.status === 409 && body?.detail === "document busy") error.kind = "busy";
    throw error;
  }
  const snapshot = PdfReaderSnapshotSchema.parse(await response.json());
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
    const response = await fetch(`/api/paper/${encodeURIComponent(docId)}/pdf/annotations/count`, { cache: "no-store" });
    const body = await response.json() as { count?: unknown; detail?: string };
    if (response.ok && Number.isInteger(body.count) && (body.count as number) >= 0) return { ok: true, count: body.count as number };
    return { ok: false, status: response.status, detail: body.detail ?? "PDF annotation count unavailable" };
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

export type SavePdfAnnotationsResult =
  | { ok: true; file: PdfAnnotationsFile }
  | { ok: false; kind: "document-changed" | "rev-mismatch" | "busy" | "error"; detail: string; rev?: number };

export async function savePdfAnnotations(docId: string, file: PdfAnnotationsFile): Promise<SavePdfAnnotationsResult> {
  try {
    const response = await fetch(`/api/paper/${encodeURIComponent(docId)}/pdf/annotations`, {
      method: "PUT",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(file),
    });
    const body = await response.json() as { detail?: string; rev?: number };
    if (response.ok) return { ok: true, file: PdfAnnotationsFileSchema.parse(body) };
    if (response.status === 409 && body.detail === "document changed") return { ok: false, kind: "document-changed", detail: body.detail };
    if (response.status === 409 && body.detail === "rev mismatch") return { ok: false, kind: "rev-mismatch", detail: body.detail, rev: body.rev };
    if (response.status === 409 && body.detail === "document busy") return { ok: false, kind: "busy", detail: body.detail };
    return { ok: false, kind: "error", detail: body.detail ?? `PDF annotations PUT ${response.status}` };
  } catch (error) {
    return { ok: false, kind: "error", detail: error instanceof Error ? error.message : String(error) };
  }
}
