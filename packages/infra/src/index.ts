// @argelanderspace/infra — side-effect adapters behind the core ports:
// mupdf (PDF text layer / link annots / rasterization), pandoc, the ADS /
// Crossref / OpenAlex metadata sources, the caching HTML + arXiv fetchers,
// the MinerU extraction client, and the PDF downloader. Pure logic stays in
// @argelanderspace/core; everything here does fs / network / subprocess.

export * from "./acquire/pdf-downloader.js";
export * from "./config.js";
export * from "./html/fetcher.js";
export * from "./html/pipeline.js";
export * from "./latex/arxiv-source.js";
export * from "./latex/assets.js";
export * from "./latex/pandoc.js";
export * from "./latex/pipeline.js";
export * from "./lib/http.js";
export * from "./lib/proc.js";
export * from "./lib/pyjson.js";
export * from "./lib/untar.js";
export * from "./lib/unzip.js";
export * from "./mineru/client.js";
export * from "./pdf/links.js";
export * from "./pdf/pipeline.js";
export * from "./pdf/raster.js";
export * from "./pdf/text-provider.js";
export * from "./sources/ads.js";
export * from "./sources/cache.js";
export * from "./sources/crossref.js";
export * from "./sources/openalex.js";
