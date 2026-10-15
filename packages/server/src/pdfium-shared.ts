/**
 * The ONE PDFium seam of the service process: a single serialized queue, a single engine/WASM initialisation and one
 * deadline helper, shared by the upload/arXiv probe (`pdfium-probe.ts`) and the original-page material
 * (`pdf-material.ts`). Only one trusted PDFium instance exists at any moment, whichever caller asks, so the
 * 512 MiB headroom budget is never spent twice.
 *
 * Requests that would sit in the queue holding a big Buffer are bounded (count and bytes): over the bound the caller
 * gets `PdfQueueFullError` immediately instead of the process holding N originals in memory.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { init } from "@embedpdf/pdfium";
import { serverFontFallback } from "./pdf-fonts.js";

/** Waiting requests the queue admits, and the originals' bytes they may hold together. */
export const PDF_QUEUE_MAX_WAITING = 8;
export const PDF_QUEUE_MAX_WAITING_BYTES = 256 * 1024 * 1024;

export class PdfQueueFullError extends Error {
  constructor() {
    super("PDF processing is busy; too many requests are waiting");
    this.name = "PdfQueueFullError";
  }
}

/** Counters a test can read: both engines and documents must be 0 when idle, `peakActive` 1 at most. */
export const pdfiumResources = {
  engines: 0,
  documents: 0,
  peakDocuments: 0,
  peakEngines: 0,
  /** Requests being processed (from their first line to their last), probe and material together. */
  active: 0,
  peakActive: 0,
  waiting: 0,
  waitingBytes: 0,
};

let queue: Promise<void> = Promise.resolve();

/**
 * Serialize: one request at a time across the whole process. `bound` (material reads) makes the request count against
 * the waiting limits and rejects at once when they are exceeded; the probe is not bounded (one upload, one job).
 */
export function serialized<T>(work: () => Promise<T>, bound?: { bytes: number }): Promise<T> {
  if (
    bound &&
    (pdfiumResources.waiting >= PDF_QUEUE_MAX_WAITING ||
      pdfiumResources.waitingBytes + bound.bytes > PDF_QUEUE_MAX_WAITING_BYTES)
  )
    return Promise.reject(new PdfQueueFullError());
  if (bound) {
    pdfiumResources.waiting++;
    pdfiumResources.waitingBytes += bound.bytes;
  }
  const run = async () => {
    if (bound) {
      pdfiumResources.waiting--;
      pdfiumResources.waitingBytes -= bound.bytes;
    }
    return work();
  };
  const current = queue.then(run);
  queue = current.then(
    () => undefined,
    () => undefined
  );
  return current;
}

/**
 * Counts a PDFium section as active for its whole duration (`pdfiumResources.active/peakActive`). Every section that
 * uses PDFium (probe and material) runs inside `serialized` AND `counted`, so a test can see that two of them never
 * overlapped.
 */
export async function counted<T>(work: () => Promise<T>): Promise<T> {
  pdfiumResources.active++;
  pdfiumResources.peakActive = Math.max(pdfiumResources.peakActive, pdfiumResources.active);
  try {
    return await work();
  } finally {
    pdfiumResources.active--;
  }
}

export function timed<T>(promise: Promise<T>, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("PDF parser timed out")),
      Math.max(1, deadline - Date.now())
    );
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export interface PdfiumTask<T> {
  toPromise(): Promise<T>;
}
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}
interface PdfiumRuntime {
  PdfiumNative: new (wasm: unknown, options: { fontFallback: object | null }) => unknown;
  PdfEngine: new (
    native: unknown,
    options: { imageConverter: (getData: () => RgbaImage, type: string) => unknown }
  ) => unknown;
}

/**
 * One engine over a fresh WASM module (counted in `pdfiumResources.engines` until the caller destroys it). Its font
 * fallback (desktop-app ticket 28) supplies the CJK fonts a PDF does not embed, read from the installed font packages
 * (`pdf-fonts.ts`); `fontFallback: false` is only for the test that shows such text is blank without it.
 */
export async function createPdfiumEngine<E>(
  imageConverter: (getData: () => RgbaImage, type: string) => unknown,
  deadline: number,
  options: { fontFallback?: boolean } = {}
): Promise<E> {
  const wasm = await readFile(fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")));
  const module = await timed(init({ wasmBinary: Uint8Array.from(wasm).buffer }), deadline);
  const runtime = (await import("@embedpdf/engines/pdfium")) as unknown as PdfiumRuntime;
  const native = new runtime.PdfiumNative(module, {
    fontFallback: options.fontFallback === false ? null : serverFontFallback(),
  });
  const engine = new runtime.PdfEngine(native, { imageConverter });
  pdfiumResources.engines++;
  pdfiumResources.peakEngines = Math.max(pdfiumResources.peakEngines, pdfiumResources.engines);
  return engine as E;
}
