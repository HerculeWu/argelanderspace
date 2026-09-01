// @argelanderspace/core — pure domain logic.
//
// documents/: TS ports of the bibgraph document stages (references, citations,
// crossrefs, annotate) plus the serialization/render helpers (document, ir,
// render) and the fractional-rect geometry they share (geom).
//
// library/ + acquire/: TS ports of the literature-library domain (store, seed,
// citation graph, /api payload builders) and the acquisition layer (source
// planner, ADS▸Crossref▸OpenAlex resolution chain, .bib parsing). Metadata
// sources and the ingest pipeline arrive through the port interfaces in
// library/sources.ts and acquire/pipelines.ts.
//
// pipelines/latex/: the arXiv LaTeX ingestion pipeline (pandoc-AST walk,
// .bbl/.bib references, asset resolution) composed from the documents-domain
// stages; pandoc / rasterization / arXiv acquisition are injected ports
// (packages/core/src/pipelines/latex/ports.ts), wired by infra.
//
// The PDF (MinerU OCR) and publisher-HTML pipelines are archived on the
// `ocr-features` branch; main ingests LaTeX sources only.

export * from "./acquire/bibtex.js";
export * from "./acquire/execute.js";
export { latexToUnicode } from "./acquire/latexenc.js";
export * from "./acquire/pipelines.js";
export * from "./acquire/planner.js";
export * from "./acquire/resolve.js";
export * from "./acquire/run.js";
export * from "./acquire/upload.js";
export * from "./documents/annotate.js";
export * from "./documents/citations.js";
export * from "./documents/crossrefs.js";
export * from "./documents/document.js";
export * from "./documents/geom.js";
export * from "./documents/ir.js";
export * from "./documents/references.js";
export * from "./documents/render.js";
export * from "./documents/tokens.js";
export * from "./documents/traverse.js";
export * from "./library/build.js";
export * from "./library/graph.js";
export * from "./library/seed.js";
export * from "./library/sources.js";
export * from "./library/store.js";
export * from "./pipelines/latex/assets.js";
export * from "./pipelines/latex/pipeline.js";
export * from "./pipelines/latex/ports.js";
export * from "./pipelines/latex/references.js";
export * from "./pipelines/latex/walk.js";
