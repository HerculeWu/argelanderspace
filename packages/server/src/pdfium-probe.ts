import { PDF_MAX_PAGES, PDF_MIN_IN_FLIGHT_HEADROOM_BYTES } from "@argelanderspace/contracts";
import { availableMemory } from "./available-memory.js";
import {
  counted,
  createPdfiumEngine,
  PDF_ENGINE_STOPPED,
  pdfiumResources,
  serialized,
  timed,
} from "./pdfium-shared.js";

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

/** The parser's timeout and a dead engine thread are system failures, not a verdict on the file. */
export function isPdfSystemFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("timed out") || error.message === PDF_ENGINE_STOPPED)
  );
}

export interface ProbedPdf {
  pageCount: number;
  pages: Array<{ width: number; height: number; rotation: number }>;
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
function toPromise<T>(task: PdfTask<T>): Promise<T> {
  return task.toPromise();
}

async function probe(bytes: Buffer): Promise<ProbedPdf> {
  if ((await availableMemory()) < PDF_MIN_IN_FLIGHT_HEADROOM_BYTES) throw new PdfResourceError();
  const deadline = Date.now() + 10_000;
  const withinLimit = async <T>(promise: Promise<T>): Promise<T> => {
    const result = await timed(promise, deadline);
    if (Date.now() > deadline) throw new Error("PDF parser timed out");
    return result;
  };
  const engine = await createPdfiumEngine<ProbeEngine>(deadline);
  const { PdfiumErrorCode } = (await import("@embedpdf/engines/pdfium")) as unknown as {
    PdfiumErrorCode: { Password: number };
  };
  let document: PdfDocument | undefined;
  try {
    const buffer = Uint8Array.from(bytes).buffer;
    try {
      document = await withinLimit(
        toPromise(engine.openDocumentBuffer({ id: "trusted-pdf-probe", content: buffer }))
      );
    } catch (error) {
      if (isPdfSystemFailure(error)) throw error;
      const code = (error as { reason?: { code?: unknown } }).reason?.code;
      if (code === PdfiumErrorCode.Password) {
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
        if (isPdfSystemFailure(error)) throw error;
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
    pdfiumResources.engines--;
  }
}

/**
 * Serialize through the process-wide PDFium queue (shared with the original-page material), so a probe and a material
 * read never hold two PDFium instances at once.
 */
export function probePdf(bytes: Buffer): Promise<ProbedPdf> {
  return serialized(() => counted(() => probe(bytes)));
}
