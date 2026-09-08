/**
 * Port interface for the ingestion pipeline the acquisition executor routes
 * through (Python's `pipeline_latex.py::ingest_latex`).
 *
 * Stage 5 MS3a: the pipeline returns the stored render IR (`TexDocIr` —
 * DocIr superset with `version` + `source`/`meta` identity) and writes it to
 * `<outRoot>/<docId>/<docId>.json` itself. The implementation is the new
 * latexmk-based tex pipeline (core `pipelines/tex`, infra `tex/ingest.ts`);
 * the pandoc pipeline it replaced was deleted in MS3b.
 *
 * The PDF (MinerU) and publisher-HTML pipelines are archived on the
 * `ocr-features` branch; main ingests LaTeX sources only.
 */

import type { TexDocIr } from "@argelanderspace/contracts";

/** The ingestion pipeline, keyed by what it consumes. */
export interface IngestPipelines {
  /** arXiv e-print → stored IR (id derived as `arxiv-<id>`). */
  ingestLatex(arxivId: string): Promise<TexDocIr>;
  /**
   * Unpack a user-supplied LaTeX source zip into `<outRoot>/<docId>/src`
   * (clearing any previous tree — a re-upload overwrites) and ingest it in
   * directory mode with the doc id pinned (Stage 3.1 MS2 web upload).
   */
  ingestLatexZip(
    zipPath: string,
    opts: { outRoot: string; docId: string; onProgress?: (message: string) => void }
  ): Promise<TexDocIr>;
}
