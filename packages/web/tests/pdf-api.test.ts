import { createHash } from "node:crypto";
import { PdfAnnotationsFileSchema } from "@argelanderspace/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPdfDoc } from "../src/api/pdf";
import { savePdfAnnotations } from "../src/api/pdf-annotations";
import { fetchPdfReadingPosition, savePdfReadingPosition } from "../src/api/pdf-reading-position";

const bytes = new TextEncoder().encode("original PDF bytes").buffer;
const sha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const snapshot = {
  metadata: {
    version: 1,
    doc_id: "pdf-123",
    format: "pdf",
    display_name: "paper.pdf",
    original_filename: "paper.pdf",
    acquired_via: "user_pdf_upload",
    acquired_at: "2026-09-24T12:00:00.000Z",
    byte_length: bytes.byteLength,
    sha256,
    page_count: 1,
    pages: [{ width: 612, height: 792, rotation: 0 }],
  },
  annotations: { version: 1, doc_id: "pdf-123", content_sha256: sha256, rev: 0, annotations: [] },
  reading_position: {
    status: "ready",
    file: { version: 1, doc_id: "pdf-123", content_sha256: sha256, rev: 0, position: null },
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("PDF reader HTTP boundary", () => {
  it("returns the verified bytes from the same response buffer used by the SDK caller", async () => {
    const digest = async (_algorithm: string, input: ArrayBuffer) => {
      const hash = createHash("sha256").update(new Uint8Array(input)).digest();
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    };
    vi.stubGlobal("crypto", { subtle: { digest } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const result = await fetchPdfDoc("pdf-123", new AbortController().signal);
    expect(result).toMatchObject({ ok: true, snapshot });
    if (result.ok) expect(result.snapshot.reading_position.status).toBe("ready");
    if (result.ok) expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array(bytes));
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/paper/pdf-123/pdf", expect.objectContaining({ cache: "no-store" }));
  });

  it("accepts a verified PDF body while keeping an independent progress-sidecar error explicit", async () => {
    const digest = async (_algorithm: string, input: ArrayBuffer) => {
      const hash = createHash("sha256").update(new Uint8Array(input)).digest();
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    };
    vi.stubGlobal("crypto", { subtle: { digest } });
    const progressErrorSnapshot = {
      ...snapshot,
      reading_position: { status: "error", detail: "PDF reading position could not be restored" },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(progressErrorSnapshot), { status: 200 }))
      .mockResolvedValueOnce(new Response(bytes, { status: 200 })));
    const result = await fetchPdfDoc("pdf-123", new AbortController().signal);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.snapshot.reading_position).toEqual(progressErrorSnapshot.reading_position);
      expect(new Uint8Array(result.bytes)).toEqual(new Uint8Array(bytes));
    }
  });

  it("sends expected revision and preserves explicit document-change and retry failure states", async () => {
    const file = PdfAnnotationsFileSchema.parse(snapshot.annotations);
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...file, rev: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: "document changed" }), { status: 409 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetch);
    expect(await savePdfAnnotations("pdf-123", file)).toMatchObject({ ok: true, file: { rev: 1 } });
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/paper/pdf-123/pdf/annotations", expect.objectContaining({ method: "PUT", cache: "no-store", body: JSON.stringify(file) }));
    expect(await savePdfAnnotations("pdf-123", file)).toMatchObject({ ok: false, kind: "document-changed" });
    expect(await savePdfAnnotations("pdf-123", file)).toMatchObject({ ok: false, kind: "error", detail: "offline" });
  });

  it("retries progress only from a bound sidecar and validates the saved revision response", async () => {
    const positionFile = { version: 1 as const, doc_id: "pdf-123", content_sha256: sha256, rev: 3, position: { page_index: 0, x: 0.2, y: 0.7 } };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready", file: positionFile }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...positionFile, rev: 4 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "ready", file: { ...positionFile, content_sha256: "b".repeat(64) } }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchPdfReadingPosition("pdf-123", sha256)).toEqual(positionFile);
    expect(await savePdfReadingPosition(positionFile)).toMatchObject({ ok: true, file: { rev: 4 } });
    await expect(fetchPdfReadingPosition("pdf-123", sha256)).rejects.toThrow(/binding/);
    expect(fetch).toHaveBeenNthCalledWith(1, "/api/paper/pdf-123/pdf/reading-position", expect.objectContaining({ cache: "no-store" }));
  });

  it("rejects mismatched bytes before returning a PDF to the reader", async () => {
    const digest = async (_algorithm: string, input: ArrayBuffer) => {
      const hash = createHash("sha256").update(new Uint8Array(input)).digest();
      return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength);
    };
    vi.stubGlobal("crypto", { subtle: { digest } });
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200 }))
      .mockResolvedValueOnce(new Response(new TextEncoder().encode("changed"), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const result = await fetchPdfDoc("pdf-123", new AbortController().signal);
    expect(result).toMatchObject({ ok: false, status: 409, detail: "PDF content changed" });
  });
});
