/**
 * End-to-end PDF -> structured JSON ingestion pipeline (`bibgraph/pipeline.py`).
 *
 *     pdf
 *      ├─ mupdf          -> text-layer probe (OCR auto-detect) + link annotations [port]
 *      ├─ MinerU (VLM)   -> content_list.json + middle.json + images/             [port]
 *      ├─ structure      -> section tree + floats
 *      ├─ references     -> structured bibliography
 *      ├─ textfix        -> repair VLM '?'-gaps from the PDF text layer           [port]
 *      └─ annotate       -> inline [[cite:..]] / [[xref:..]] tokens (regex+links)
 *     -> Document -> <out_dir>/<stem>.json
 *
 * The offline stages (structure / references / textfix / annotate / document
 * assembly) are the shared documents-domain pieces composed by
 * {@link buildDocument}; what lives here is the orchestration `ingest_pdf` adds
 * around them: OCR auto-detect, the MinerU call (cache-aware), the never-fail
 * link-extraction guard, and JSON emission.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import type { Document } from "@argelanderspace/contracts";
import { buildDocument, documentToJson } from "../../documents/document.js";
import type { PdfLinks } from "../../documents/pdf-links.js";
import type { PdfTextProvider } from "../../documents/textfix.js";
import {
  DEFAULT_PDF_CONFIG,
  type PdfMineruConfig,
  type PdfPipelineConfig,
  type PdfPipelineConfigOverrides,
  type PdfPipelinePorts,
} from "./ports.js";

export interface IngestPdfOptions {
  /** Output directory (Python `out_dir`, default `<pdf dir>/<pdf stem>`). */
  outDir?: string;
  /** `PipelineConfig` overrides; defaults come from `bibgraph/config.py`. */
  config?: PdfPipelineConfigOverrides;
  /** Reuse a previous MinerU unzip under `<out_dir>/mineru` (Python `use_mineru_cache`). */
  useMineruCache?: boolean;
  /** Write `<out_dir>/<stem>.json` (Python `write_json`). */
  writeJson?: boolean;
  /**
   * Coarse progress sink (Stage 3 / MS3): one line per stage transition
   * (MinerU extraction / link harvest / document build / JSON write), plus the
   * MinerU port's own extraction-state transitions. The upload job wires this
   * to the job runner's `report`.
   */
  onProgress?: (message: string) => void;
}

/** `ingest_pdf(pdf_path, out_dir, config, use_mineru_cache, write_json)`. */
export async function ingestPdf(
  pdfPath: string,
  ports: PdfPipelinePorts,
  opts: IngestPdfOptions = {}
): Promise<Document> {
  // The Python pipeline mutates config.mineru.is_ocr during auto-detect; resolve
  // into a local copy instead (caller-visible side effect dropped, outputs equal).
  const mineruConfig: PdfMineruConfig = { ...DEFAULT_PDF_CONFIG.mineru, ...opts.config?.mineru };
  const config: PdfPipelineConfig = {
    ...DEFAULT_PDF_CONFIG,
    ...opts.config,
    mineru: mineruConfig,
  };
  if (!existsSync(pdfPath)) {
    throw new Error(`PDF not found: ${pdfPath}`);
  }
  const stem = parse(pdfPath).name;
  const outDir = opts.outDir ?? join(dirname(pdfPath), stem);
  mkdirSync(outDir, { recursive: true });

  // 1) OCR auto-detect (only when the caller didn't force it)
  if (mineruConfig.isOcr === null || mineruConfig.isOcr === undefined) {
    mineruConfig.isOcr = !ports.links.hasTextLayer(pdfPath);
  }

  // 2) MinerU extraction (cached if available)
  opts.onProgress?.("MinerU extraction");
  const mineru = await ports.mineru(pdfPath, outDir, {
    config: mineruConfig,
    pollInterval: config.pollInterval,
    pollTimeout: config.pollTimeout,
    useCache: opts.useMineruCache ?? true,
    onProgress: opts.onProgress,
  });

  // 3) PDF hyperlink annotations (hybrid resolution) — a failed extraction never
  // fails the whole run; resolution degrades to regex-only.
  let pdfLinks: PdfLinks | null = null;
  if (config.usePdfLinks) {
    opts.onProgress?.("Extracting PDF links");
    try {
      pdfLinks = ports.links.extract(pdfPath);
    } catch {
      pdfLinks = null;
    }
  }

  // textfix opens the PDF itself in Python and records zeroed stats when that
  // open fails; buildDocument records the same zeroed stats without a provider.
  let pdfText: PdfTextProvider | undefined;
  if (config.useTextfix) {
    try {
      pdfText = ports.openText(pdfPath);
    } catch {
      pdfText = undefined;
    }
  }

  opts.onProgress?.("Building document");
  const doc = buildDocument(
    mineru,
    { stem, path: pdfPath, filename: basename(pdfPath) },
    pdfLinks,
    {
      usePdfLinks: config.usePdfLinks,
      useTextfix: config.useTextfix,
      mineru: {
        modelVersion: mineruConfig.modelVersion,
        language: mineruConfig.language,
        isOcr: mineruConfig.isOcr,
      },
      pdfText,
    }
  );

  if (opts.writeJson ?? true) {
    opts.onProgress?.("Writing document JSON");
    const outJson = join(outDir, `${stem}.json`);
    writeFileSync(
      outJson,
      JSON.stringify(documentToJson(doc, config.compactJson), null, 2),
      "utf-8"
    );
    // Python sets meta.output_path on the returned doc *after* serialization.
    if (doc.meta) doc.meta.output_path = outJson;
  }
  return doc;
}
