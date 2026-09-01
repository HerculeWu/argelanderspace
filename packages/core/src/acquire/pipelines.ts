/**
 * Port interfaces for the three ingestion pipelines the acquisition executor
 * routes through (Python's `bibgraph/pipeline.py::ingest_pdf`,
 * `pipeline_html.py::ingest_html`, `pipeline_latex.py::ingest_latex`).
 *
 * The pipelines themselves are M2/M3 (MinerU client + fetchers + pandoc); each
 * ingests a source into `data/output/<doc_id>/` and returns the reader
 * `Document` (contracts type, JSON-written with `write_json=True`). All return
 * Promises: the implementations do network/CPU-bound async work.
 */

import type { Document } from "@argelanderspace/contracts";

/** The three ingestion pipelines, keyed by what they consume. */
export interface IngestPipelines {
  /** `ingest_html(doi, config=…, write_json=True)` — publisher HTML → Document. */
  ingestHtml(doi: string): Promise<Document>;
  /** `ingest_latex(arxiv_id, config=…, write_json=True)` — arXiv e-print → Document. */
  ingestLatex(arxivId: string): Promise<Document>;
  /**
   * `ingest_pdf(pdf_path, out_dir=…, config=…, write_json=True)` — PDF →
   * MinerU (+OCR) → Document written into `opts.outDir`.
   *
   * `opts.isOcr` is `config.mineru.is_ocr`: `null` auto-detects the text layer,
   * `true`/`false` forces OCR on/off. `opts.onProgress` (Stage 3 / MS3) is a
   * coarse progress sink for the upload job's WS progress feed.
   */
  ingestPdf(
    pdfPath: string,
    opts: { outDir: string; isOcr: boolean | null; onProgress?: (message: string) => void }
  ): Promise<Document>;
}

/**
 * PDF download port (Python's `requests.get` streaming download in
 * `acquire/fetch_pdf.py::_download_pdf`). The M2 implementation must:
 * fetch with a browser User-Agent and redirects, verify the payload is a PDF
 * (`%PDF` magic or a pdf content-type; raise `ValueError`-equivalent
 * otherwise), and write atomically via a `.part` sibling.
 */
export interface PdfDownloader {
  download(url: string, destPath: string): Promise<void>;
}
