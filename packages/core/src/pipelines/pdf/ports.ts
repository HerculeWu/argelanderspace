/**
 * Injected ports for the PDF pipeline (`bibgraph/pipeline.py`).
 *
 * The pipeline composition (OCR auto-detect, MinerU cache handling, hybrid link
 * resolution, textfix, annotate, JSON emission) is pure domain logic and lives in
 * core; the side-effecting capabilities it consumes are injected:
 *
 * - {@link PdfMineruExtract} — the MinerU v4 extraction client (upload + poll +
 *   unzip, or the on-disk cache). Implemented by `@argelanderspace/infra`
 *   `mineru/client.ts` (`MineruClient.extract`).
 * - {@link PdfLinksPort} — mupdf link-annotation harvest + text-layer probe
 *   (`bibgraph/pdf_links.py`). Implemented by infra `pdf/links.ts`.
 * - {@link PdfTextProviderFactory} — opens the PDF text layer for textfix
 *   (`bibgraph/ingest/textfix.py`'s `fitz.open`). Implemented by infra
 *   `pdf/text-provider.ts`.
 *
 * The shapes here are structural twins of the infra adapters (verified by the
 * infra wiring layer), so core never imports infra.
 */

import type { MineruArtifacts } from "../../documents/mineru.js";
import type { PdfLinks } from "../../documents/pdf-links.js";
import type { PdfTextProvider } from "../../documents/textfix.js";

/** `config.MineruConfig` — one extraction task's options (structural twin of infra's). */
export interface PdfMineruConfig {
  /** "vlm" = high precision (layout+OCR+formula+code). */
  modelVersion: string;
  /** 'ch' covers zh+en; 'en' for english papers. */
  language: string;
  enableFormula: boolean;
  enableTable: boolean;
  /** e.g. "1-10"; undefined = whole document. */
  pageRanges?: string;
  extraFormats: string[];
  /** null/undefined → auto-detect from the text layer; true/false → force. */
  isOcr: boolean | null;
}

/**
 * `MineruClient.extract`: run (or reuse) a MinerU extraction and return the
 * parsed artifacts. `opts.config.isOcr` carries the post-auto-detect value the
 * pipeline resolved. Implementations honour `useCache` exactly like the Python
 * client (including its literal-`content_list.json` probe).
 */
export type PdfMineruExtract = (
  pdfPath: string,
  outDir: string,
  opts: {
    config: PdfMineruConfig;
    pollInterval: number;
    pollTimeout: number;
    useCache: boolean;
    /** Coarse progress sink (Stage 3 / MS3): extraction-state transitions. */
    onProgress?: (message: string) => void;
  }
) => Promise<MineruArtifacts>;

/** `bibgraph/pdf_links.py`: link harvest + cheap text-layer probe (two separate opens). */
export interface PdfLinksPort {
  /** `has_text_layer(pdf_path)` — used by the OCR auto-detect. */
  hasTextLayer(pdfPath: string): boolean;
  /** `extract_links(pdf_path)` — all link annots + page sizes + text-layer flag. */
  extract(pdfPath: string): PdfLinks;
}

/** Open `pdfPath` as a {@link PdfTextProvider} for textfix (`fitz.open`). May throw. */
export type PdfTextProviderFactory = (pdfPath: string) => PdfTextProvider;

/**
 * `PipelineConfig`'s PDF-relevant fields (`config.py`). Note the Python
 * pipeline *mutates* `config.mineru.is_ocr` during auto-detect; the TS port
 * resolves it into a local copy instead — the emitted outputs are identical.
 */
export interface PdfPipelineConfig {
  mineru: PdfMineruConfig;
  /** Harvest link annotations for authoritative citation/xref resolution. */
  usePdfLinks: boolean;
  /** Repair MinerU '?'-gaps from the PDF text layer before tokenizing. */
  useTextfix: boolean;
  /** Drop null/empty fields from the emitted JSON. */
  compactJson: boolean;
  /** MinerU async-task poll interval (s). */
  pollInterval: number;
  /** MinerU async-task overall timeout (s). */
  pollTimeout: number;
}

/** Defaults from `bibgraph/config.py` (`PipelineConfig` + `MineruConfig`). */
export const DEFAULT_PDF_CONFIG: PdfPipelineConfig = {
  mineru: {
    modelVersion: "vlm",
    language: "en",
    enableFormula: true,
    enableTable: true,
    extraFormats: [],
    isOcr: null,
  },
  usePdfLinks: true,
  useTextfix: true,
  compactJson: true,
  pollInterval: 5.0,
  pollTimeout: 1800.0,
};

/** `ingestPdf` config overrides (deep-merged over {@link DEFAULT_PDF_CONFIG}). */
export type PdfPipelineConfigOverrides = Partial<Omit<PdfPipelineConfig, "mineru">> & {
  mineru?: Partial<PdfMineruConfig>;
};

/** Everything {@link ingestPdf} needs from the outside world. */
export interface PdfPipelinePorts {
  mineru: PdfMineruExtract;
  links: PdfLinksPort;
  openText: PdfTextProviderFactory;
}
