// @argelanderspace/core — pure domain logic.
//
// documents/: the surviving document stages — the markdown renderers and
// segment helpers (render.ts) and reference-field extraction (references.ts,
// used by the tex pipeline). The buildDocIr fallback and the old
// annotate/citations/crossrefs/tokens/traverse layers were deleted in
// Stage 5 (MS3b/MS4b).
//
// library/ + acquire/: TS ports of the literature-library domain (store, seed,
// citation graph, /api payload builders) and the acquisition layer (source
// planner, ADS▸Crossref▸OpenAlex resolution chain, .bib parsing). Metadata
// sources and the ingest pipeline arrive through the port interfaces in
// library/sources.ts and acquire/pipelines.ts.
//
// pipelines/tex/ (Stage 5): the latexmk compile-execution + fusion pipeline
// (source tree, bounded macros, numbering/cite/xref anchoring, IR assembly)
// and the pure parsers for the engine-agnostic compiler artifacts
// (.aux/.bbl/.toc/.lof/.lot/.fls + .argelander.jsonl event stream).
//
// plans/: the plan-page store (Stage 4) — plans.json load/save (atomic write,
// optimistic-lock rev), id generation, and the pure CRUD helpers.
//
// annotations/: the document-annotation store (Stage 8) —
// annotations/<doc>/current.json load/save (atomic write, optimistic-lock
// rev), id generation, pure CRUD, the content fingerprint (canonical
// projection + asset hashing), and the idempotent ensureCurrentAnnotations
// archive-on-mismatch guard.
//
// writer/: the Writer store (Stage 10) — manuscripts/m_<id>/manuscript.json
// (+ assets/) load/save/list/delete (atomic write, optimistic-lock rev,
// looseObject round-trip for agent-authored keys), id generation, and the
// templates merger (built-ins + user files, user overrides same-id).
//
// The pandoc LaTeX pipeline was deleted in Stage 5 MS3b (the tex pipeline
// replaced it); PDF (MinerU OCR) and publisher-HTML pipelines are archived
// on the `ocr-features` branch.

export * from "./acquire/attach-arxiv.js";
export * from "./acquire/bibtex.js";
export * from "./acquire/execute.js";
export { latexToUnicode } from "./acquire/latexenc.js";
export * from "./acquire/pipelines.js";
export * from "./acquire/planner.js";
export * from "./acquire/resolve.js";
export * from "./acquire/run.js";
export * from "./acquire/upload.js";
export { DocumentAssetError, readDocumentAsset } from "./annotations/assets.js";
export * from "./annotations/store.js";
export * from "./documents/references.js";
export * from "./documents/render.js";
export * from "./library/add-manual.js";
export * from "./library/build.js";
export * from "./library/discovery.js";
export * from "./library/graph.js";
export * from "./library/seed.js";
export * from "./library/sources.js";
export * from "./library/store.js";
export * from "./pdf-storage.js";
export * from "./pipelines/tex/facts/index.js";
export * from "./pipelines/tex/fuse/cite-format.js";
export * from "./pipelines/tex/fuse/figures.js";
export * from "./pipelines/tex/fuse/numbering.js";
export * from "./pipelines/tex/fuse/references.js";
export * from "./pipelines/tex/fuse/tables.js";
export * from "./pipelines/tex/fuse/text.js";
export * from "./pipelines/tex/fuse/walk.js";
export * from "./pipelines/tex/ir.js";
export * from "./pipelines/tex/pipeline.js";
export * from "./pipelines/tex/ports.js";
export * from "./pipelines/tex/source/macros.js";
export * from "./pipelines/tex/source/tree.js";
export * from "./plans/store.js";
export * from "./writer/export.js";
export * from "./writer/preview.js";
export * from "./writer/store.js";
