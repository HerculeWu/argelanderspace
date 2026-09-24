import { readFile } from "node:fs/promises";
import { freemem } from "node:os";
import { fileURLToPath } from "node:url";
import { PDF_MAX_PAGES, PDF_MIN_IN_FLIGHT_HEADROOM_BYTES } from "@argelanderspace/contracts";
import { init } from "@embedpdf/pdfium";

export class PdfResourceError extends Error {
  constructor() {
    super("PDF processing requires at least 512 MiB of available memory headroom");
    this.name = "PdfResourceError";
  }
}

export class PdfInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfInputError";
  }
}

export interface ProbedPdf {
  pageCount: number;
  pages: Array<{ width: number; height: number; rotation: number }>;
}

let probeQueue: Promise<void> = Promise.resolve();

function timed<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PDF parser timed out")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

interface PdfTask<T> {
  toPromise(): Promise<T>;
}
interface PdfPage {
  size: { width: number; height: number };
  rotation: number;
}
interface PdfDocument {
  pageCount: number;
  pages: PdfPage[];
}
interface ProbeEngine {
  openDocumentBuffer(file: { id: string; content: ArrayBuffer }): PdfTask<PdfDocument>;
  isEncrypted(document: PdfDocument): PdfTask<boolean>;
  getPageGeometry(document: PdfDocument, page: PdfPage): PdfTask<unknown>;
  closeDocument(document: PdfDocument): PdfTask<unknown>;
  destroy(): PdfTask<unknown>;
}
interface PdfiumRuntime {
  PdfiumErrorCode: { Password: number };
  PdfiumNative: new (wasm: unknown, options: { fontFallback: null }) => unknown;
  PdfEngine: new (
    native: unknown,
    options: { imageConverter: (getImageData: () => unknown) => unknown }
  ) => ProbeEngine;
}
function toPromise<T>(task: PdfTask<T>): Promise<T> {
  return task.toPromise();
}

async function probe(bytes: Buffer): Promise<ProbedPdf> {
  if (freemem() < PDF_MIN_IN_FLIGHT_HEADROOM_BYTES) throw new PdfResourceError();
  const deadline = Date.now() + 10_000;
  const withinLimit = async <T>(promise: Promise<T>): Promise<T> => {
    const result = await timed(promise, Math.max(1, deadline - Date.now()));
    if (Date.now() > deadline) throw new Error("PDF parser timed out");
    return result;
  };
  const wasmPath = fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm"));
  const wasm = await readFile(wasmPath);
  const wasmBinary = Uint8Array.from(wasm).buffer;
  const module = await withinLimit(init({ wasmBinary }));
  const runtime = (await import("@embedpdf/engines/pdfium")) as unknown as PdfiumRuntime;
  const native = new runtime.PdfiumNative(module, { fontFallback: null });
  const engine = new runtime.PdfEngine(native, {
    imageConverter: (getImageData) => getImageData(),
  });
  let document: PdfDocument | undefined;
  try {
    const buffer = Uint8Array.from(bytes).buffer;
    try {
      document = await withinLimit(
        toPromise(engine.openDocumentBuffer({ id: "trusted-pdf-probe", content: buffer }))
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) throw error;
      const code = (error as { reason?: { code?: unknown } }).reason?.code;
      if (code === runtime.PdfiumErrorCode.Password) {
        throw new PdfInputError("password-protected PDFs are not supported");
      }
      throw new PdfInputError("file is not a valid, readable PDF");
    }
    if (await toPromise(engine.isEncrypted(document)))
      throw new PdfInputError("password-protected PDFs are not supported");
    if (document.pageCount < 1 || document.pageCount > PDF_MAX_PAGES)
      throw new PdfInputError(`PDF must contain 1-${PDF_MAX_PAGES} pages`);
    const pages: ProbedPdf["pages"] = [];
    for (const page of document.pages) {
      try {
        await withinLimit(toPromise(engine.getPageGeometry(document, page)));
      } catch (error) {
        if (error instanceof Error && error.message.includes("timed out")) throw error;
        throw new PdfInputError("PDF page geometry is invalid");
      }
      const rotation = [0, 90, 180, 270][page.rotation];
      if (
        rotation === undefined ||
        !Number.isFinite(page.size.width) ||
        !Number.isFinite(page.size.height)
      ) {
        throw new PdfInputError("PDF page geometry is invalid");
      }
      pages.push({ width: page.size.width, height: page.size.height, rotation });
    }
    return { pageCount: document.pageCount, pages };
  } finally {
    if (document) await toPromise(engine.closeDocument(document)).catch(() => undefined);
    await toPromise(engine.destroy()).catch(() => undefined);
  }
}

/** Serialize probes so only one trusted PDFium instance/document consumes the resource budget. */
export function probePdf(bytes: Buffer): Promise<ProbedPdf> {
  const current = probeQueue.then(() => probe(bytes));
  probeQueue = current.then(
    () => undefined,
    () => undefined
  );
  return current;
}
