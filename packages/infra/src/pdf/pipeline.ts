/**
 * Wiring layer for the PDF pipeline: compose `@argelanderspace/core`'s
 * `ingestPdf` (pure composition) with the infra adapters — the MinerU v4
 * extraction client (`mineru/client.ts`), the mupdf link harvest / text-layer
 * probe (`pdf/links.ts`), and the mupdf text-layer provider for textfix
 * (`pdf/text-provider.ts`). This lives in infra because those capabilities do
 * network/mupdf I/O; the pipeline itself stays dep-clean in core.
 */

import { ingestPdf as coreIngestPdf, type IngestPdfOptions } from "@argelanderspace/core";
import type { FetchImpl } from "../lib/http.js";
import { MineruClient } from "../mineru/client.js";
import { extractPdfLinks, hasPdfTextLayer } from "./links.js";
import { openPdfTextProvider } from "./text-provider.js";

export interface WiredIngestPdfOptions extends IngestPdfOptions {
  /** MinerU API key (default `$MINERU_API_KEY`; only needed on a cache miss). */
  apiKey?: string;
  /** MinerU API base URL override. */
  baseUrl?: string;
  /** HTTP implementation for the MinerU client (defaults to global fetch). */
  fetchImpl?: FetchImpl;
}

/** The ingested Document (shape from `@argelanderspace/contracts`). */
export type IngestedPdfDocument = Awaited<ReturnType<typeof coreIngestPdf>>;

/** `ingest_pdf` with the real adapters: a local PDF path → Document. */
export async function ingestPdf(
  pdfPath: string,
  opts: WiredIngestPdfOptions = {}
): Promise<IngestedPdfDocument> {
  const { apiKey, baseUrl, fetchImpl, ...coreOpts } = opts;
  return coreIngestPdf(
    pdfPath,
    {
      mineru: (path, outDir, o) =>
        // the client's log hook carries the poll state transitions to onProgress
        new MineruClient({
          config: o.config,
          apiKey,
          baseUrl,
          fetchImpl,
          log: o.onProgress,
        }).extract(path, outDir, o),
      links: { hasTextLayer: hasPdfTextLayer, extract: extractPdfLinks },
      openText: openPdfTextProvider,
    },
    coreOpts
  );
}
