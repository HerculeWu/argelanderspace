/**
 * Port interface for the ingestion pipeline the acquisition executor routes
 * through (Python's `pipeline_latex.py::ingest_latex`).
 *
 * The pipeline itself is infra (pandoc / arXiv fetch / rasterization); it
 * ingests a source into `data/output/<doc_id>/` and returns the reader
 * `Document` (contracts type, JSON-written with `write_json=True`).
 *
 * The PDF (MinerU) and publisher-HTML pipelines are archived on the
 * `ocr-features` branch; main ingests LaTeX sources only.
 */

import type { Document } from "@argelanderspace/contracts";

/** The ingestion pipeline, keyed by what it consumes. */
export interface IngestPipelines {
  /** `ingest_latex(arxiv_id, config=…, write_json=True)` — arXiv e-print → Document. */
  ingestLatex(arxivId: string): Promise<Document>;
}
