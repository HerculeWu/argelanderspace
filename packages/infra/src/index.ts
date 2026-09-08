// @argelanderspace/infra — side-effect adapters behind the core ports:
// pandoc + arXiv source acquisition + mupdf/Ghostscript rasterization (the
// LaTeX pipeline), the ADS / Crossref / OpenAlex metadata sources, and the
// config file. Pure logic stays in @argelanderspace/core; everything here
// does fs / network / subprocess.
//
// The MinerU client, publisher-HTML fetcher, PDF downloader, and the mupdf
// text-layer/link adapters left with the PDF/HTML pipelines — archived on the
// `ocr-features` branch. (lib/unzip.ts stays: the LaTeX-zip upload reuses it.)
//
// tex/ (Stage 5, parallel build): the latexmk compile-execution layer behind
// the pipelines/tex ports — isolated tmpdir workspaces, the argelander.sty
// instrumentation wrapper, engine fallback + error taxonomy, and dvisvgm
// figure materialization.

export * from "./config.js";
export * from "./latex/arxiv-source.js";
export * from "./latex/assets.js";
export * from "./latex/pandoc.js";
export * from "./latex/pipeline.js";
export * from "./lib/http.js";
export * from "./lib/proc.js";
export * from "./lib/pyjson.js";
export * from "./lib/untar.js";
export * from "./lib/unzip.js";
export * from "./pdf/raster.js";
export * from "./sources/ads.js";
export * from "./sources/cache.js";
export * from "./sources/crossref.js";
export * from "./sources/openalex.js";
export * from "./tex/compile.js";
export * from "./tex/figures.js";
export * from "./tex/ingest.js";
export * from "./tex/instrument.js";
export * from "./tex/proc.js";
export * from "./tex/workspace.js";
