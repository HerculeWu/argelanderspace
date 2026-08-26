/**
 * Wiring layer for the arXiv LaTeX pipeline: compose `@argelanderspace/core`'s
 * `ingestLatex` (pure composition) with the infra adapters — the pandoc CLI
 * (`latex/pandoc.ts`), the arXiv e-print fetcher/extractor
 * (`latex/arxiv-source.ts`), and the mupdf/Ghostscript rasterizers
 * (`pdf/raster.ts`). This lives in infra because those capabilities do
 * subprocess/network/mupdf I/O; the pipeline itself stays dep-clean in core.
 */

import { join } from "node:path";
import { ingestLatex as coreIngestLatex, type IngestLatexOptions } from "@argelanderspace/core";
import type { FetchImpl } from "../lib/http.js";
import { epsToPng, pdfToPng } from "../pdf/raster.js";
import { ArxivFetcher, acquireSource } from "./arxiv-source.js";
import { bibtexToCsl, fragmentToBlocks, havePandoc, latexToAst } from "./pandoc.js";

export interface WiredIngestLatexOptions extends IngestLatexOptions {
  /** HTTP implementation for the arXiv fetcher (defaults to global fetch). */
  fetchImpl?: FetchImpl;
}

/** The ingested Document (shape from `@argelanderspace/contracts`). */
export type IngestedLatexDocument = Awaited<ReturnType<typeof coreIngestLatex>>;

/** `ingest_latex` with the real adapters: arXiv id / URL / local .tex → Document. */
export async function ingestLatex(
  source: string,
  opts: WiredIngestLatexOptions = {}
): Promise<IngestedLatexDocument> {
  const { fetchImpl, ...coreOpts } = opts;
  return coreIngestLatex(
    source,
    {
      pandoc: { havePandoc, latexToAst, fragmentToBlocks, bibtexToCsl },
      acquire: (src, outRoot, config) =>
        acquireSource(src, outRoot, {
          fetcher: new ArxivFetcher(join(outRoot, ".latexcache"), {
            userAgent: config.userAgent,
            timeout: config.requestTimeout,
            useCache: config.useCache,
            delay: config.requestDelay,
            fetchImpl,
          }),
        }),
      raster: { pdfToPng, epsToPng },
    },
    coreOpts
  );
}
