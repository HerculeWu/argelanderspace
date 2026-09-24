import { PdfReaderSnapshotSchema, type PdfReaderSnapshot } from "@argelanderspace/contracts";

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
  try {
    const snapshotResponse = await fetch(`/api/paper/${encodeURIComponent(docId)}/pdf/snapshot`, {
      cache: "no-store",
      signal,
    });
    if (!snapshotResponse.ok) {
      const body = (await snapshotResponse.json().catch(() => null)) as { detail?: string } | null;
      return { ok: false, status: snapshotResponse.status, detail: body?.detail ?? `PDF snapshot ${snapshotResponse.status}` };
    }
    const snapshot = PdfReaderSnapshotSchema.parse(await snapshotResponse.json());
    if (snapshot.metadata.doc_id !== docId || snapshot.annotations.doc_id !== docId || snapshot.annotations.content_sha256 !== snapshot.metadata.sha256) {
      return { ok: false, status: 500, detail: "PDF snapshot identity or content binding mismatch" };
    }
    const fileResponse = await fetch(`/api/paper/${encodeURIComponent(docId)}/pdf`, { cache: "no-store", signal });
    if (!fileResponse.ok) {
      const body = (await fileResponse.json().catch(() => null)) as { detail?: string } | null;
      return { ok: false, status: fileResponse.status, detail: body?.detail ?? `PDF file ${fileResponse.status}` };
    }
    const bytes = await fileResponse.arrayBuffer();
    if (bytes.byteLength !== snapshot.metadata.byte_length || await sha256(bytes) !== snapshot.metadata.sha256) {
      return { ok: false, status: 409, detail: "PDF content changed" };
    }
    return { ok: true, snapshot, bytes };
  } catch (error) {
    if (signal.aborted) return { ok: false, status: 0, detail: "request aborted" };
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}
