/**
 * Injected ports for the publisher-HTML pipeline (`bibgraph/pipeline_html.py`).
 *
 * The pipeline composition (fetch → adapter walk → annotate → Document) is pure
 * domain logic and lives in core — including the cheerio DOM walk (decision 11
 * made cheerio the project's HTML parser; the adapters *are* DOM walkers, so a
 * cheerio-free core would have nothing left to compose). The side-effecting
 * capabilities are injected:
 *
 * - {@link HtmlPagePort} — the caching HTTP fetcher (pages as raw text; binary
 *   assets to disk). Implemented by infra `html/fetcher.ts` (`Fetcher`).
 * - {@link HtmlMathmlPort} — MathML → LaTeX via the pandoc CLI. Implemented by
 *   infra `latex/pandoc.ts` (`mathmlToLatex`).
 *
 * The shapes here are structural twins of the infra adapters, so core never
 * imports infra.
 */

/** The caching page/asset fetcher (`ingest_html/fetch.py` `Fetcher`). */
export interface HtmlPagePort {
  /** Return the final (post-redirect) URL and the page's raw HTML text. */
  get(url: string): Promise<{ finalUrl: string; text: string }>;
  /** Stream a binary asset to `dest`; resolves false on failure. */
  download(url: string, dest: string): Promise<boolean>;
}

/** MathML → LaTeX (`ingest_html/mathml.py` `mathml_to_latex`, via pandoc). */
export interface HtmlMathmlPort {
  /** One `<math>…</math>` HTML string → KaTeX-clean LaTeX, or undefined. */
  mathmlToLatex(mathHtml: string): string | undefined;
}

/** `HtmlConfig` (+ the pipeline-wide `compact_json`) with Python defaults. */
export interface HtmlPipelineConfig {
  userAgent: string;
  requestTimeout: number;
  useCache: boolean;
  downloadAssets: boolean;
  fetchSubpages: boolean;
  /** "conservative" | "plain" (see `config.py` HtmlConfig.inline_math). */
  inlineMath: string;
  requestDelay: number;
  compactJson: boolean;
}

/** Defaults from `bibgraph/config.py` (`HtmlConfig` + `PipelineConfig`). */
export const DEFAULT_HTML_CONFIG: HtmlPipelineConfig = {
  userAgent:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120 Safari/537.36",
  requestTimeout: 30,
  useCache: true,
  downloadAssets: true,
  fetchSubpages: true,
  inlineMath: "conservative",
  requestDelay: 0.3,
  compactJson: true,
};

/** Everything {@link ingestHtml} needs from the outside world. */
export interface HtmlPipelinePorts {
  fetcher: HtmlPagePort;
  mathml: HtmlMathmlPort;
}
