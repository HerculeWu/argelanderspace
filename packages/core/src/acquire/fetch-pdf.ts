/**
 * PDF acquisition tier: obtain a PDF for a work and OCR it via MinerU
 * (bibgraph/acquire/fetch_pdf.py).
 *
 * The fallback when the structured sources fail or are blocked:
 * - **arXiv PDF** (`arxiv.org/pdf/<id>`) — born-digital, has a real text layer, so
 *   MinerU extracts cleanly (no OCR); the universal fallback for arXiv papers whose
 *   LaTeX pandoc can't parse (AASTeX `\input{table}` etc.);
 * - **ADS scan** (`articles.adsabs.harvard.edu/pdf/<bibcode>`) — a true scan of an
 *   old article; forced through OCR.
 *
 * Each fetched PDF is ingested into `data/output/<doc_id>/` exactly like a
 * user-supplied PDF, then its `source` is stamped with the work's DOI / arXiv id
 * so `seedFromOutput` links the doc to the work.
 *
 * Port notes (bug-for-bug):
 * - The HTTP download ({@link PdfDownloader}) and the MinerU pipeline
 *   ({@link IngestPipelines.ingestPdf}) are M2/M3 infra ports; what lives here
 *   is the orchestration: `doc_id` slugging, download-skip-when-present, OCR
 *   forcing, and `_stamp_source`.
 * - Python's module constant `OUTPUT_DIR` becomes `deps.paths.outputDir`.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Document } from "@argelanderspace/contracts";
import { stripChars } from "../documents/pyregex.js";
import type { LibraryPaths, Work } from "../library/store.js";
import { normArxiv } from "../library/store.js";
import type { IngestPipelines, PdfDownloader } from "./pipelines.js";

/** Dependencies of the PDF-tier fetchers. */
export interface PdfFetchDeps {
  paths: LibraryPaths;
  downloader: PdfDownloader;
  pipelines: IngestPipelines;
}

/** `_slug`: doc-id-safe slug (unrelated to the store's title slug). */
export function pdfSlug(s: string | null | undefined): string {
  return stripChars((s || "").replace(/[^A-Za-z0-9._-]+/g, "-"), "-._");
}

/** Stamp the work's identifiers on the produced doc so seed links it back. */
export function stampSource(docJson: string, w: Work, via: string): void {
  const data = JSON.parse(readFileSync(docJson, "utf8")) as Record<string, unknown>;
  // Python `data.setdefault("source", {})` / `data.setdefault("meta", {})`
  if (data.source === null || data.source === undefined) data.source = {};
  const src = data.source as Record<string, unknown>;
  if (w.doi) src.doi = w.doi;
  if (w.arxiv_id) src.arxiv_id = w.arxiv_id;
  src.acquired_via = via;
  if (data.meta === null || data.meta === undefined) data.meta = {};
  const meta = data.meta as Record<string, unknown>;
  if (!meta.title && w.title) meta.title = w.title;
  writeFileSync(docJson, JSON.stringify(data, null, 2), "utf8");
}

async function ingestPdfFor(
  w: Work,
  opts: { url: string; docId: string; via: string; forceOcr: boolean },
  deps: PdfFetchDeps
): Promise<Document> {
  const outDir = join(deps.paths.outputDir, opts.docId);
  const pdfPath = join(outDir, `${opts.docId}.pdf`);
  if (!existsSync(pdfPath) || statSync(pdfPath).size === 0) {
    await deps.downloader.download(opts.url, pdfPath);
  }
  // null → auto-detect text layer
  const doc = await deps.pipelines.ingestPdf(pdfPath, {
    outDir,
    isOcr: opts.forceOcr ? true : null,
  });
  stampSource(join(outDir, `${opts.docId}.json`), w, opts.via);
  return doc;
}

export async function arxivPdfDoc(w: Work, deps: PdfFetchDeps): Promise<Document> {
  const aid = normArxiv(w.arxiv_id);
  if (!aid) throw new Error("no arXiv id");
  return ingestPdfFor(
    w,
    {
      url: `https://arxiv.org/pdf/${aid}`,
      docId: `arxivpdf-${pdfSlug(aid)}`,
      via: "arxiv_pdf",
      forceOcr: false,
    },
    deps
  );
}

export async function adsScanDoc(w: Work, deps: PdfFetchDeps): Promise<Document> {
  if (!w.bibcode) throw new Error("no ADS bibcode");
  const url = `https://articles.adsabs.harvard.edu/pdf/${w.bibcode}`;
  return ingestPdfFor(
    w,
    { url, docId: `ads-${pdfSlug(w.bibcode)}`, via: "ads_scan", forceOcr: true },
    deps
  );
}
