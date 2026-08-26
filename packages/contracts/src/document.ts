/**
 * Zod schemas for the ingested Document JSON.
 *
 * Source of truth: `bibgraph/schema.py` (Python pipeline, pre-TS-migration),
 * validated against the 6 frozen pipeline outputs in `tests/golden/`.
 *
 * Key serialization rule (bug-for-bug): the Python pipeline emits
 * `compact_json`, which recursively drops `None`, empty strings, and empty
 * containers — but preserves `0` and `false`. Consequently almost every field
 * that is nullable/has an empty default is *absent entirely* when unset, so
 * schemas use `.optional()` to match. Fields marked required are those that
 * are present in 100% of observed occurrences (see tests/golden survey).
 *
 * Inline token conventions (not enforced by validation): body text carries
 * in-text citation / cross-reference sites as placeholder tokens, e.g.
 * `"... as shown by [[cite:ref-12;ref-13]] in [[xref:fig-3]] ..."`. The same
 * occurrences are also recorded structurally per block and flattened at the
 * document level (`citations` / `crossrefs` with `block_id`).
 */

import { z } from "zod";

/** Matches `[[cite:ref-1;ref-2]]` inline tokens (capture: `;`-joined ref ids). */
export const CITE_TOKEN_RE = /\[\[cite:([^\]]+)\]\]/;
/** Matches `[[xref:fig-3]]` inline tokens (capture: target id). */
export const XREF_TOKEN_RE = /\[\[xref:([^\]]+)\]\]/;

/** MinerU-normalized bounding box `[x0, y0, x1, y1]` on a 0–1000 page grid. */
export const BboxSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

// --------------------------------------------------------------------------- //
// Occurrences (in-text citations & cross references)
// --------------------------------------------------------------------------- //

/** How an occurrence was found: regex on text, a hyperlink, or both. */
export const OccurrenceViaSchema = z.enum(["regex", "hyperlink", "hyperlink+regex"]);

/** Where an occurrence sits when it is not in the block body itself. */
export const OccurrenceContextSchema = z.enum(["caption", "list_item"]);

export const CitationOccurrenceSchema = z.object({
  /** bibgraph reference ids this site resolves to; absent when unresolved (`[[cite:?]]`). */
  ref_ids: z.array(z.string()).optional(),
  /** Original matched text, e.g. "(Hunt & Reffert 2021)". */
  raw: z.string(),
  via: OccurrenceViaSchema,
  resolved: z.boolean(),
  doi: z.string().optional(),
  url: z.string().optional(),
  /** Set only in the flattened document-level `citations` array. */
  block_id: z.string().optional(),
  in: OccurrenceContextSchema.optional(),
});

export const CrossRefKindSchema = z.enum([
  "figure",
  "table",
  "equation",
  "section",
  "algorithm",
  "code",
  "appendix",
  "unknown",
]);

export const CrossRefOccurrenceSchema = z.object({
  kind: CrossRefKindSchema,
  /** Original matched text, e.g. "Fig. 3". */
  raw: z.string(),
  /** Target element id; absent when unresolved (`[[xref:figure-3?]]` / `[[xref:?]]`). */
  target_id: z.string().optional(),
  /** Referenced number/letter as printed, e.g. "3" or "A". */
  number: z.string().optional(),
  via: OccurrenceViaSchema,
  resolved: z.boolean(),
  /** 0-based page for unresolved GoTo links. */
  target_page: z.number().int().optional(),
  url: z.string().optional(),
  /** Set only in the flattened document-level `crossrefs` array. */
  block_id: z.string().optional(),
  in: OccurrenceContextSchema.optional(),
});

// --------------------------------------------------------------------------- //
// Blocks
// --------------------------------------------------------------------------- //

/** A run of body text that may carry inline tokens + occurrence records. */
export const RichTextSchema = z.object({
  text: z.string(),
  citations: z.array(CitationOccurrenceSchema).optional(),
  crossrefs: z.array(CrossRefOccurrenceSchema).optional(),
});

const blockBase = {
  id: z.string(),
  /** 0-based page index; absent when the pipeline could not place the block. */
  page_idx: z.number().int().optional(),
  bbox: BboxSchema.optional(),
};

export const ParagraphBlockSchema = z.object({
  ...blockBase,
  type: z.literal("paragraph"),
  text: z.string(),
  citations: z.array(CitationOccurrenceSchema).optional(),
  crossrefs: z.array(CrossRefOccurrenceSchema).optional(),
});

export const ListBlockSchema = z.object({
  ...blockBase,
  type: z.literal("list"),
  ordered: z.boolean(),
  items: z.array(RichTextSchema),
});

export const FigureBlockSchema = z.object({
  ...blockBase,
  type: z.literal("figure"),
  /** Printed number, e.g. "3". */
  number: z.string().optional(),
  /** e.g. "Figure 3". */
  label: z.string().optional(),
  caption: RichTextSchema.optional(),
  footnote: z.string().optional(),
  img_path: z.string().optional(),
  /** MinerU chart sub_type: line/bar/scatter… */
  chart_type: z.string().optional(),
  /** MinerU's extracted chart data, if any. */
  content: z.string().optional(),
});

export const TableBlockSchema = z.object({
  ...blockBase,
  type: z.literal("table"),
  number: z.string().optional(),
  label: z.string().optional(),
  caption: RichTextSchema.optional(),
  footnote: z.string().optional(),
  /** HTML serialization of the table. */
  table_body: z.string().optional(),
  /** Fallback image when the table was not recognized. */
  img_path: z.string().optional(),
});

export const EquationBlockSchema = z.object({
  ...blockBase,
  type: z.literal("equation"),
  number: z.string().optional(),
  label: z.string().optional(),
  latex: z.string(),
});

export const CodeBlockSchema = z.object({
  ...blockBase,
  type: z.literal("code"),
  number: z.string().optional(),
  label: z.string().optional(),
  caption: RichTextSchema.optional(),
  lang: z.string().optional(),
  body: z.string().optional(),
});

/** Pseudocode / algorithm float. */
export const AlgorithmBlockSchema = z.object({
  ...blockBase,
  type: z.literal("algorithm"),
  number: z.string().optional(),
  label: z.string().optional(),
  caption: RichTextSchema.optional(),
  body: z.string().optional(),
});

export const BlockSchema = z.discriminatedUnion("type", [
  ParagraphBlockSchema,
  ListBlockSchema,
  FigureBlockSchema,
  TableBlockSchema,
  EquationBlockSchema,
  CodeBlockSchema,
  AlgorithmBlockSchema,
]);

// --------------------------------------------------------------------------- //
// Sections (the structure tree)
// --------------------------------------------------------------------------- //

export interface Section {
  id: string;
  type: "section";
  /** 1 = top-level heading. */
  level: number;
  /** Clean heading text ("Introduction"); absent when empty. */
  heading?: string;
  /** Heading as printed ("1 Introduction"); absent when empty. */
  heading_raw?: string;
  /** Extracted number ("1", "3.2"); absent for unnumbered sections. */
  number?: string;
  page_idx?: number;
  bbox?: [number, number, number, number];
  /** Absent when the section has only sub-sections (compacted out). */
  blocks?: Block[];
  children?: Section[];
}

export const SectionSchema: z.ZodType<Section> = z.lazy(() =>
  z.object({
    id: z.string(),
    type: z.literal("section"),
    level: z.number().int(),
    heading: z.string().optional(),
    heading_raw: z.string().optional(),
    number: z.string().optional(),
    page_idx: z.number().int().optional(),
    bbox: BboxSchema.optional(),
    blocks: z.array(BlockSchema).optional(),
    children: z.array(SectionSchema).optional(),
  })
);

// --------------------------------------------------------------------------- //
// References
// --------------------------------------------------------------------------- //

export const ReferenceSchema = z.object({
  id: z.string(),
  /** Raw bibliography entry text. */
  raw: z.string(),
  /** In-text marker for numbered styles ("12"). */
  label: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
  title: z.string().optional(),
  venue: z.string().optional(),
  volume: z.string().optional(),
  pages: z.string().optional(),
  doi: z.string().optional(),
  arxiv_id: z.string().optional(),
  url: z.string().optional(),
  /** Textual forms used for matching citations to this reference. */
  keys: z.array(z.string()).optional(),
});

// --------------------------------------------------------------------------- //
// Index (lightweight lookup for the web UI / xref resolution)
// --------------------------------------------------------------------------- //

export const IndexFloatSchema = z.object({
  id: z.string(),
  page_idx: z.number().int().optional(),
  number: z.string().optional(),
  label: z.string().optional(),
  /** Plain-text caption (no inline tokens). */
  caption: z.string().optional(),
});

export const IndexSectionSchema = z.object({
  id: z.string(),
  level: z.number().int(),
  number: z.string().optional(),
  heading: z.string().optional(),
  page_idx: z.number().int().optional(),
});

/** Every bucket is optional: compact_json drops empty lists. */
export const DocumentIndexSchema = z.object({
  figures: z.array(IndexFloatSchema).optional(),
  tables: z.array(IndexFloatSchema).optional(),
  equations: z.array(IndexFloatSchema).optional(),
  code: z.array(IndexFloatSchema).optional(),
  algorithms: z.array(IndexFloatSchema).optional(),
  sections: z.array(IndexSectionSchema).optional(),
});

// --------------------------------------------------------------------------- //
// Source / meta / stats
// --------------------------------------------------------------------------- //

/**
 * Provenance of the ingested document. The Python model is a free-form dict;
 * known keys are typed below, unknown keys pass through (`type` observed:
 * "pdf" | "html" | "latex").
 */
export const DocumentSourceSchema = z.looseObject({
  type: z.string(),
  path: z.string(),
  filename: z.string(),
  n_pages: z.number().int().optional(),
  url: z.string().optional(),
  publisher: z.string().optional(),
  doi: z.string().optional(),
  arxiv_id: z.string().optional(),
  acquired_via: z.string().optional(),
});

/**
 * Document metadata. `title` is the only universal key; the pipeline-specific
 * blobs (`mineru` / `textfix` / `html` / `latex`) are present only for docs
 * that went through that pipeline, and their contents are free-form.
 */
export const DocumentMetaSchema = z.looseObject({
  title: z.string(),
  mineru: z.record(z.string(), z.unknown()).optional(),
  textfix: z.record(z.string(), z.unknown()).optional(),
  html: z.record(z.string(), z.unknown()).optional(),
  latex: z.record(z.string(), z.unknown()).optional(),
});

/** The 12 counters the Python pipeline always computes; extra numeric keys pass. */
export const DocumentStatsSchema = z
  .object({
    n_sections: z.number().int().optional(),
    n_paragraphs: z.number().int().optional(),
    n_figures: z.number().int().optional(),
    n_tables: z.number().int().optional(),
    n_equations: z.number().int().optional(),
    n_code: z.number().int().optional(),
    n_algorithms: z.number().int().optional(),
    n_references: z.number().int().optional(),
    n_citations: z.number().int().optional(),
    n_citations_resolved: z.number().int().optional(),
    n_crossrefs: z.number().int().optional(),
    n_crossrefs_resolved: z.number().int().optional(),
  })
  .catchall(z.number());

// --------------------------------------------------------------------------- //
// Document
// --------------------------------------------------------------------------- //

/**
 * The structured JSON produced by the ingestion pipeline
 * (`GET /api/paper/{doc_id}`). Only `doc_id` is unconditionally present;
 * every other key is dropped by compact_json when empty.
 */
export const DocumentSchema = z.object({
  doc_id: z.string(),
  source: DocumentSourceSchema.optional(),
  meta: DocumentMetaSchema.optional(),
  structure: z.array(SectionSchema).optional(),
  index: DocumentIndexSchema.optional(),
  references: z.array(ReferenceSchema).optional(),
  citations: z.array(CitationOccurrenceSchema).optional(),
  crossrefs: z.array(CrossRefOccurrenceSchema).optional(),
  stats: DocumentStatsSchema.optional(),
});

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type Bbox = z.infer<typeof BboxSchema>;
export type OccurrenceVia = z.infer<typeof OccurrenceViaSchema>;
export type OccurrenceContext = z.infer<typeof OccurrenceContextSchema>;
export type CitationOccurrence = z.infer<typeof CitationOccurrenceSchema>;
export type CrossRefKind = z.infer<typeof CrossRefKindSchema>;
export type CrossRefOccurrence = z.infer<typeof CrossRefOccurrenceSchema>;
export type RichText = z.infer<typeof RichTextSchema>;
export type ParagraphBlock = z.infer<typeof ParagraphBlockSchema>;
export type ListBlock = z.infer<typeof ListBlockSchema>;
export type FigureBlock = z.infer<typeof FigureBlockSchema>;
export type TableBlock = z.infer<typeof TableBlockSchema>;
export type EquationBlock = z.infer<typeof EquationBlockSchema>;
export type CodeBlock = z.infer<typeof CodeBlockSchema>;
export type AlgorithmBlock = z.infer<typeof AlgorithmBlockSchema>;
export type Block = z.infer<typeof BlockSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type IndexFloat = z.infer<typeof IndexFloatSchema>;
export type IndexSection = z.infer<typeof IndexSectionSchema>;
export type DocumentIndex = z.infer<typeof DocumentIndexSchema>;
export type DocumentSource = z.infer<typeof DocumentSourceSchema>;
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;
export type DocumentStats = z.infer<typeof DocumentStatsSchema>;
export type Document = z.infer<typeof DocumentSchema>;
