/**
 * Injected ports for the LaTeX pipeline (`bibgraph/pipeline_latex.py`).
 *
 * The pipeline composition (AST walk, references building, annotate) is pure
 * domain logic and lives in core; the side-effecting capabilities it consumes
 * are injected:
 *
 * - {@link LatexPandocPort} — the pandoc CLI (infers the JSON AST, expands
 *   fragments, reads .bib into CSL-JSON). Implemented by
 *   `@argelanderspace/infra` `latex/pandoc.ts`.
 * - {@link LatexRasterPort} — vector-figure rasterization (mupdf for PDF,
 *   Ghostscript for EPS). Implemented by infra `pdf/raster.ts`.
 * - {@link LatexAcquisitionPort} — arXiv e-print download/cache + unpack.
 *   Implemented by infra `latex/arxiv-source.ts`.
 *
 * The shapes here are structural twins of the infra adapters (verified by the
 * infra wiring layer), so core never imports infra.
 */

/** pandoc CLI surface the pipeline needs (`ingest_latex/pandoc_ast.py`). */
export interface LatexPandocPort {
  havePandoc(): boolean;
  /**
   * Throw an actionable error when the resolved pandoc is older than the
   * supported floor (pandoc < 3.9 strips display-math environments). Called
   * once at the pipeline entry; optional so minimal test doubles stay valid.
   */
  assertPandocVersion?(): void;
  /** Parse `mainTex` into the pandoc JSON AST (run from its directory). */
  latexToAst(mainTex: string): Record<string, unknown>;
  /** A free-standing LaTeX fragment → AST blocks; [] on parse failure. */
  fragmentToBlocks(latex: string, srcDir?: string): unknown[];
  /** Read one or more .bib files into CSL-JSON entries (keyed by `id`). */
  bibtexToCsl(bibFiles: readonly string[], srcDir?: string): Record<string, unknown>[];
}

/** Vector-figure rasterizers (`ingest_latex/assets.py`'s fitz/gs calls). */
export interface LatexRasterPort {
  /** Rasterize page 1 of a vector PDF to PNG at `dest`; false on failure. */
  pdfToPng(src: string, dest: string, opts: { dpi?: number; maxPx?: number }): boolean;
  /** Rasterize an EPS/PS file to PNG at `dest`; false on failure. */
  epsToPng(src: string, dest: string, opts: { dpi?: number; log?: (msg: string) => void }): boolean;
}

/** An unpacked arXiv LaTeX source tree (`ingest_latex/fetch.py` LatexSource). */
export interface LatexSource {
  /** Directory holding the unpacked .tex tree. */
  srcDir: string;
  /** The file carrying \documentclass + \begin{document}. */
  mainTex: string;
  docId: string;
  arxivId: string | null;
  /** The URL or local path we resolved. */
  origin: string;
}

/**
 * `acquire_source`: resolve a source spec to an unpacked LatexSource. A fixed
 * `docId` (the upload path pins `upload-<slug>-<hash>`) short-circuits the
 * source-derived `docIdFor`.
 */
export type LatexAcquisitionPort = (
  source: string,
  outRoot: string,
  config: LatexPipelineConfig,
  docId?: string
) => Promise<LatexSource>;

/** `LatexConfig` (+ the pipeline-wide `compact_json`) with Python defaults. */
export interface LatexPipelineConfig {
  userAgent: string;
  requestTimeout: number;
  useCache: boolean;
  downloadAssets: boolean;
  figureDpi: number;
  figureMaxPx: number;
  requestDelay: number;
  compactJson: boolean;
}

/** Defaults from `bibgraph/config.py` (`LatexConfig` + `PipelineConfig`). */
export const DEFAULT_LATEX_CONFIG: LatexPipelineConfig = {
  userAgent: "bibgraph/0.1 (https://arxiv.org; mailto:wuwenjiegogo@gmail.com)",
  requestTimeout: 60,
  useCache: true,
  downloadAssets: true,
  figureDpi: 200,
  figureMaxPx: 2200,
  requestDelay: 1.0,
  compactJson: true,
};

/** Everything {@link ingestLatex} needs from the outside world. */
export interface LatexPipelinePorts {
  pandoc: LatexPandocPort;
  acquire: LatexAcquisitionPort;
  /**
   * Vector-figure rasterization. When absent, vector figures resolve to
   * `undefined` (the Python pipeline always has PyMuPDF, so this is the
   * core-only degradation path); raster images are still copied through.
   */
  raster?: LatexRasterPort;
}
