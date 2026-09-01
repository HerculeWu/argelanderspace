/**
 * Wiring layer for the arXiv LaTeX pipeline: compose `@argelanderspace/core`'s
 * `ingestLatex` (pure composition) with the infra adapters — the pandoc CLI
 * (`latex/pandoc.ts`), the arXiv e-print fetcher/extractor
 * (`latex/arxiv-source.ts`), and the mupdf/Ghostscript rasterizers
 * (`pdf/raster.ts`). This lives in infra because those capabilities do
 * subprocess/network/mupdf I/O; the pipeline itself stays dep-clean in core.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ingestLatex as coreIngestLatex, type IngestLatexOptions } from "@argelanderspace/core";
import type { FetchImpl } from "../lib/http.js";
import { extractZip } from "../lib/unzip.js";
import { epsToPng, pdfToPng } from "../pdf/raster.js";
import { ArxivFetcher, acquireSource } from "./arxiv-source.js";
import {
  assertPandocVersion,
  bibtexToCsl,
  fragmentToBlocks,
  havePandoc,
  latexToAst,
} from "./pandoc.js";

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
      pandoc: { havePandoc, assertPandocVersion, latexToAst, fragmentToBlocks, bibtexToCsl },
      acquire: (src, outRoot, config, docId) =>
        acquireSource(src, outRoot, {
          fetcher: new ArxivFetcher(join(outRoot, ".latexcache"), {
            userAgent: config.userAgent,
            timeout: config.requestTimeout,
            useCache: config.useCache,
            delay: config.requestDelay,
            fetchImpl,
          }),
          docId,
        }),
      raster: { pdfToPng, epsToPng },
    },
    coreOpts
  );
}

export interface IngestLatexZipOptions {
  /** Pipeline output root; the source tree lands at `<outRoot>/<docId>/src`. */
  outRoot: string;
  /** Pinned doc id (idempotent upload: the same work always maps to it). */
  docId: string;
  /** `LatexConfig` overrides, forwarded to the pipeline. */
  config?: IngestLatexOptions["config"];
  /** HTTP implementation for the (unused in directory mode) arXiv fetcher. */
  fetchImpl?: FetchImpl;
  /** Stage sink — the upload job's progress reporter. */
  onProgress?: (message: string) => void;
}

/**
 * Unpack a user-supplied LaTeX source zip and ingest it in directory mode —
 * the Stage 3.1 MS2 web-upload path (`IngestPipelines.ingestLatexZip`). A
 * re-upload clears `<outRoot>/<docId>/src` before unpacking, so the doc is
 * overwritten in place, exactly like a re-fetched arXiv tarball.
 */
export async function ingestLatexZip(
  zipPath: string,
  opts: IngestLatexZipOptions
): Promise<IngestedLatexDocument> {
  const srcDir = join(opts.outRoot, opts.docId, "src");
  rmSync(srcDir, { recursive: true, force: true });
  extractZip(new Uint8Array(readFileSync(zipPath)), srcDir);
  opts.onProgress?.("Ingesting LaTeX source");
  return ingestLatex(srcDir, {
    outRoot: opts.outRoot,
    docId: opts.docId,
    config: opts.config,
    fetchImpl: opts.fetchImpl,
  });
}
