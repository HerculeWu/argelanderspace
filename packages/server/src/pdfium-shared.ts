/**
 * The ONE PDFium seam of the service process: a single serialized queue, a single engine/WASM initialisation and one
 * deadline helper, shared by the upload/arXiv probe (`pdfium-probe.ts`) and the original-page material
 * (`pdf-material.ts`). Only one trusted PDFium instance exists at any moment, whichever caller asks, so the
 * 512 MiB headroom budget is never spent twice. The engine itself runs in a worker thread (`pdfium-worker.ts`,
 * shelf-followups 08), one thread per engine, so its synchronous WebAssembly never holds the service's event loop.
 *
 * Requests that would sit in the queue holding a big Buffer are bounded (count and bytes): over the bound the caller
 * gets `PdfQueueFullError` immediately instead of the process holding N originals in memory.
 */
import { Worker } from "node:worker_threads";
import { serverFontFallback } from "./pdf-fonts.js";
import {
  PDFIUM_WORKER_MARKER,
  type PdfiumWorkerData,
  type PdfiumWorkerError,
  type PdfiumWorkerMethod,
  type PdfiumWorkerRequest,
  type PdfRegion,
} from "./pdfium-worker.js";

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
export type { RgbaImage } from "./pdfium-worker.js";
/** A page drawn and encoded in the worker: the PNG bytes and the size of the image actually encoded. */
export interface RenderedPng {
  png: Buffer;
  width: number;
  height: number;
}

/**
 * The worker's file next to this module: `src/pdfium-worker.ts` in the tests, `dist/pdfium-worker.js` after `tsc`, and
 * in the app's single-file bundle (this code inlined into `dist/bin.js`) the copy `copy-assets.mjs` puts beside it.
 */
const WORKER_URL = new URL(
  import.meta.url.endsWith(".ts") ? "./pdfium-worker.ts" : "./pdfium-worker.js",
  import.meta.url
);
/** A system error (the thread died), never a judgement of the PDF: callers that classify input errors let it through. */
export const PDF_ENGINE_STOPPED = "PDF engine stopped unexpectedly";
const STOPPED = PDF_ENGINE_STOPPED;
const CLOSED = "PDF engine closed";
/** How long releasing an engine may wait for its thread to end (it is terminated, so this is only a safety net). */
const EXIT_WAIT_MS = 5000;

/**
 * One engine over a fresh WASM module in its own worker thread (shelf-followups 08), counted in
 * `pdfiumResources.engines` until the caller destroys it. Its calls run off the event loop; what they return and how
 * they fail is what the engine itself gives (see `pdfiumWorkerEngine`). Its font fallback (desktop-app ticket 28)
 * supplies the CJK fonts a PDF does not embed, read from the installed font packages (`pdf-fonts.ts`);
 * `fontFallback: false` is only for the test that shows such text is blank without it.
 */
export async function createPdfiumEngine<E>(
  deadline: number,
  options: { fontFallback?: boolean } = {}
): Promise<E> {
  const workerData: PdfiumWorkerData = {
    marker: PDFIUM_WORKER_MARKER,
    fonts: options.fontFallback === false ? null : serverFontFallback(),
  };
  let worker: Worker;
  try {
    worker = new Worker(WORKER_URL, { workerData });
  } catch {
    throw new Error("PDF engine could not be started");
  }
  const engine = await pdfiumWorkerEngine<E>(worker, deadline);
  pdfiumResources.engines++;
  pdfiumResources.peakEngines = Math.max(pdfiumResources.peakEngines, pdfiumResources.engines);
  return engine;
}

/** An error as the worker described it, with the engine's `reason` (the probe reads its code). */
function revive(described: PdfiumWorkerError): Error {
  const error = new Error(described.message) as Error & { reason?: unknown };
  error.name = described.name;
  if (described.reason !== undefined) error.reason = described.reason;
  return error;
}

/**
 * The engine object over a started worker thread: the engine's own methods (`PDFIUM_WORKER_METHODS`), each returning a
 * task whose promise settles with the worker's answer. The thread is bounded and never left hanging:
 *  - at `deadline` the thread is terminated and every call in flight (and the start) fails with "PDF parser timed
 *    out", the parser's existing timeout error; the abandoned page is not waited for;
 *  - a thread that dies (an uncaught error, an exit, a message it cannot read) fails the start or the calls in flight
 *    with "PDF engine stopped unexpectedly", and every later call fails at once;
 *  - `destroy()` terminates the thread (its WASM memory goes with it) and resolves when it has ended.
 * `openDocumentBuffer` hands its `content` buffer over to the thread (transferred, not copied): callers pass a copy.
 * `renderPage` takes an optional `crop` (the region of the rendered page to encode) and answers a `RenderedPng`.
 */
export async function pdfiumWorkerEngine<E>(worker: Worker, deadline: number): Promise<E> {
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  let starting: { resolve(): void; reject(error: unknown): void } | null = null;
  let stopped: Error | null = null;
  let nextId = 1;
  const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
  const stop = (error: Error) => {
    if (stopped) return;
    stopped = error;
    clearTimeout(timer);
    for (const call of pending.values()) call.reject(error);
    pending.clear();
    starting?.reject(error);
    starting = null;
    void worker.terminate();
  };
  const timer = setTimeout(
    () => stop(new Error("PDF parser timed out")),
    Math.max(1, deadline - Date.now())
  );
  worker.on("message", (message: { ready?: true; failed?: PdfiumWorkerError; id?: number }) => {
    if (message?.ready) {
      starting?.resolve();
      starting = null;
      return;
    }
    if (message?.failed) {
      stop(revive(message.failed));
      return;
    }
    const call = message?.id === undefined ? undefined : pending.get(message.id);
    if (!call || message.id === undefined) return;
    pending.delete(message.id);
    const answer = message as { error?: PdfiumWorkerError; value?: unknown };
    if (answer.error) call.reject(revive(answer.error));
    else call.resolve(answer.value);
  });
  worker.on("error", (cause) => stop(new Error(STOPPED, { cause })));
  worker.on("messageerror", (cause) => stop(new Error(STOPPED, { cause })));
  worker.on("exit", (code) => stop(new Error(STOPPED, { cause: { exitCode: code } })));
  // the thread has ended (it is terminated, so the bound is only a safety net)
  const ended = async () => {
    let wait: NodeJS.Timeout | undefined;
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        wait = setTimeout(resolve, EXIT_WAIT_MS);
      }),
    ]);
    clearTimeout(wait);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      if (stopped) reject(stopped);
      else starting = { resolve, reject };
    });
  } catch (error) {
    // nobody gets an engine to destroy: wait for the thread here, so the queue never runs two PDFium instances
    await ended();
    throw error;
  }

  const call = (
    method: PdfiumWorkerMethod,
    args: unknown[],
    extra: { crop?: PdfRegion } = {},
    transfer: ArrayBuffer[] = []
  ): Promise<unknown> => {
    if (stopped) return Promise.reject(stopped);
    const id = nextId++;
    const request: PdfiumWorkerRequest = { id, method, args, ...extra };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage(request, transfer);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };
  const task = <T>(promise: Promise<T>): PdfiumTask<T> => {
    // observed by the caller through toPromise(); never an unhandled rejection when it is not
    promise.catch(() => undefined);
    return { toPromise: () => promise };
  };
  const forward =
    (method: PdfiumWorkerMethod) =>
    (...args: unknown[]) =>
      task(call(method, args));
  const engine = {
    openDocumentBuffer: (file: { id: string; content: ArrayBuffer }) =>
      task(call("openDocumentBuffer", [file], {}, [file.content])),
    isEncrypted: forward("isEncrypted"),
    getPageTextRuns: forward("getPageTextRuns"),
    getPageGeometry: forward("getPageGeometry"),
    extractText: forward("extractText"),
    getBookmarks: forward("getBookmarks"),
    closeDocument: forward("closeDocument"),
    renderPage: (document: unknown, page: unknown, options: { crop?: PdfRegion }) => {
      const { crop, ...rest } = options;
      return task(
        call("renderPage", [document, page, rest], crop ? { crop } : {}).then((value) => {
          const { png, width, height } = value as {
            png: Uint8Array;
            width: number;
            height: number;
          };
          return {
            png: Buffer.from(png.buffer, png.byteOffset, png.byteLength),
            width,
            height,
          } satisfies RenderedPng;
        })
      );
    },
    destroy: () =>
      task(
        (async () => {
          stop(new Error(CLOSED));
          await ended();
        })()
      ),
  };
  return engine as E;
}
