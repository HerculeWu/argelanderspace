import { PdfReaderSnapshotSchema, type PdfReaderSnapshot } from "@argelanderspace/contracts";
import { apiRequest, HttpError, underlyingError } from "./request";

export type PdfLoadResult =
  | { ok: true; snapshot: PdfReaderSnapshot; bytes: ArrayBuffer }
  | { ok: false; status: number; detail: string };

function sha256(bytes: ArrayBuffer): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then((hash) =>
    [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}

/** Fetch the protected snapshot and one raw byte buffer; only verified bytes leave this boundary. */
export async function fetchPdfDoc(docId: string, signal: AbortSignal): Promise<PdfLoadResult> {
  let what = "PDF snapshot";
  try {
    const snapshot = PdfReaderSnapshotSchema.parse(
      await apiRequest(`/api/paper/${encodeURIComponent(docId)}/pdf/snapshot`, { cache: "no-store" }, { signal })
    );
    if (snapshot.metadata.doc_id !== docId || snapshot.annotations.doc_id !== docId || snapshot.annotations.content_sha256 !== snapshot.metadata.sha256) {
      return { ok: false, status: 500, detail: "PDF snapshot identity or content binding mismatch" };
    }
    what = "PDF file";
    const fileResponse = await apiRequest<Response>(`/api/paper/${encodeURIComponent(docId)}/pdf`, { cache: "no-store" }, { signal, parse: "none" });
    const bytes = await fileResponse.arrayBuffer();
    // A local integrity failure, reported in the same shape as the server's content-changed conflict.
    if (bytes.byteLength !== snapshot.metadata.byte_length || await sha256(bytes) !== snapshot.metadata.sha256) {
      return { ok: false, status: 409, detail: "PDF content changed" };
    }
    return { ok: true, snapshot, bytes };
  } catch (error) {
    if (error instanceof HttpError && error.status > 0) {
      return { ok: false, status: error.status, detail: (error.body as { detail?: string } | null)?.detail ?? `${what} ${error.status}` };
    }
    if (signal.aborted) return { ok: false, status: 0, detail: "request aborted" };
    const cause = underlyingError(error);
    return { ok: false, status: 0, detail: cause instanceof Error ? cause.message : String(cause) };
  }
}
