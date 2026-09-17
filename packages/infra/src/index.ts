// @argelanderspace/infra — side-effect adapters behind the core ports:
// the Stage 5 tex compile-execution layer (tex/: latexmk workspaces, the
// argelander.sty instrumentation wrapper, pdftocairo/gs figures, the wired ingest),
// arXiv source acquisition (latex/arxiv-source.ts), the ADS / Crossref /
// OpenAlex metadata sources, and the config file. Pure logic stays in
// @argelanderspace/core; everything here does fs / network / subprocess.
//
// The pandoc pipeline and mupdf/Ghostscript rasterization were deleted in
// Stage 5 MS3b (the tex pipeline replaced them); the MinerU client,
// publisher-HTML fetcher, and PDF downloader are archived on `ocr-features`.

export * from "./config.js";
export * from "./latex/arxiv-source.js";
export * from "./lib/http.js";
export * from "./lib/proc.js";
export * from "./lib/pyjson.js";
export * from "./lib/untar.js";
export * from "./lib/unzip.js";
export * from "./lib/zip.js";
export * from "./sources/ads.js";
export * from "./sources/ads-discovery.js";
export * from "./sources/cache.js";
export * from "./sources/crossref.js";
export * from "./sources/openalex.js";
export * from "./tex/compile.js";
export * from "./tex/figures.js";
export * from "./tex/ingest.js";
export * from "./tex/instrument.js";
export * from "./tex/proc.js";
export * from "./tex/workspace.js";
