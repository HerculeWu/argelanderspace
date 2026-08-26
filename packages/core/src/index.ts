// @argelanderspace/core — pure domain logic.
//
// documents/: TS ports of the bibgraph PDF-pipeline's pure document stages
// (structure, references, citations, crossrefs, annotate, textfix) plus the pure
// helpers they share with pdf_links.py and schema.py. Bug-for-bug compatible with
// the Python originals; PDF/MinerU/network access stays behind ports in infra.
//
// library/ + acquire/: TS ports of the literature-library domain (store, seed,
// citation graph, /api payload builders) and the acquisition layer (source
// planner, ADS▸Crossref▸OpenAlex resolution chain, .bib parsing, upload/PDF
// fetch orchestration). Metadata sources and the ingest pipelines arrive through
// the port interfaces in library/sources.ts and acquire/pipelines.ts (M2/M3).
//
// pipelines/latex/: the arXiv LaTeX ingestion pipeline (pandoc-AST walk,
// .bbl/.bib references, asset resolution) composed from the documents-domain
// stages; pandoc / rasterization / arXiv acquisition are injected ports
// (packages/core/src/pipelines/latex/ports.ts), wired by infra.
//
// pipelines/pdf/: the PDF ingestion pipeline (OCR auto-detect, MinerU extraction,
// hybrid link resolution, JSON emission) composed around the documents-domain
// buildDocument; MinerU / mupdf links / mupdf text layer are injected ports
// (packages/core/src/pipelines/pdf/ports.ts), wired by infra.

export * from "./acquire/bibtex.js";
export * from "./acquire/execute.js";
export * from "./acquire/fetch-pdf.js";
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
export * from "./documents/mineru.js";
export * from "./documents/pdf-links.js";
export * from "./documents/references.js";
export * from "./documents/structure.js";
export * from "./documents/textfix.js";
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
export * from "./pipelines/pdf/pipeline.js";
export * from "./pipelines/pdf/ports.js";
