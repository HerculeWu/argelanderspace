/**
 * Zod schemas for the document render IR (`GET /api/paper/{doc_id}/ir`).
 *
 * The IR (Stage 3 / MS2a) is the single source of truth every renderer
 * consumes: the CLI's LLM-friendly markdown (`core/documents/render.ts`), the
 * web reader, and any future export all project the same structure. It is a
 * *rendering projection* of the Document JSON — layout forensics (`page_idx`,
 * `bbox`, `heading_raw`, …) are dropped on purpose; the full-fidelity data
 * stays available via the Document JSON endpoint.
 *
 * Key conventions:
 * - Body text is pre-segmented into `IrSegment` runs: plain `text`, inline
 *   `math` (`$…$`, delimiters stripped), `cite` (one `[[cite:…]]` token — a
 *   group stays one segment), and `xref` (one `[[xref:…]]` token). Segments
 *   partition the source text losslessly.
 * - `cite`/`xref` segments carry `raw` when the token was paired with an
 *   occurrence record (same RichText-local array, zipped in order) — the
 *   reader shows the original matched text (e.g. "(Hunt & Reffert 2021)").
 * - `resolved`/`short`/`title`/`preview`/`heading` are computed in core;
 *   markdown-specific sanitizing/truncation stays on the export side.
 */

import { z } from "zod";

/**
 * A bibliography entry (the shared Reference contract used by the stored IR's
 * `references` and by library/graph consumers). Moved here from the retired
 * `document.ts` in MS4b — the only surviving part of that file.
 */
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
// Inline segments
// --------------------------------------------------------------------------- //

/** A run of plain text. */
export const IrTextSegmentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

/** Inline `$…$` math; `latex` is the content with the delimiters stripped. */
export const IrMathSegmentSchema = z.object({
  type: z.literal("math"),
  latex: z.string(),
});

/**
 * One ref inside a cite segment. `id` is the token's id; the pipeline's empty
 * / `?` unresolved marker normalizes to `id: "?"`, `resolved: false`. `short`
 * is the citeShort label ("Bok 1934", raw value — sanitizing is the exporter's
 * job); `title` only when the reference carries one.
 */
export const IrCiteRefSchema = z.object({
  id: z.string(),
  resolved: z.boolean(),
  short: z.string().optional(),
  title: z.string().optional(),
});

/** One `[[cite:…]]` token; a `;`-separated group stays one segment. */
export const IrCiteSegmentSchema = z.object({
  type: z.literal("cite"),
  refs: z.array(IrCiteRefSchema),
  /** Raw matched text of the paired occurrence; absent when unpaired. */
  raw: z.string().optional(),
});

/** The xref target kinds the renderer knows how to link to. */
export const IrXrefTargetTypeSchema = z.enum([
  "figure",
  "table",
  "equation",
  "code",
  "algorithm",
  "section",
]);

/**
 * An xref resolution. The pipeline's unresolved trailing `?` marker
 * (`[[xref:figure-9?]]` / `[[xref:?]]`) is stripped from `id` (`""` → `"?"`);
 * `targetType`/`number`/`preview`/`heading` are set only when resolved —
 * `preview` (floats) is the sanitized, truncated caption/latex excerpt,
 * `heading` (sections) the clean heading text.
 */
export const IrXrefTargetSchema = z.object({
  id: z.string(),
  resolved: z.boolean(),
  targetType: IrXrefTargetTypeSchema.optional(),
  number: z.string().optional(),
  preview: z.string().optional(),
  heading: z.string().optional(),
});

/** One `[[xref:…]]` token. */
export const IrXrefSegmentSchema = z.object({
  type: z.literal("xref"),
  target: IrXrefTargetSchema,
  /** Raw matched text of the paired occurrence; absent when unpaired. */
  raw: z.string().optional(),
});

export const IrSegmentSchema = z.discriminatedUnion("type", [
  IrTextSegmentSchema,
  IrMathSegmentSchema,
  IrCiteSegmentSchema,
  IrXrefSegmentSchema,
]);

// --------------------------------------------------------------------------- //
// Blocks
// --------------------------------------------------------------------------- //

export const IrParagraphBlockSchema = z.object({
  id: z.string(),
  type: z.literal("paragraph"),
  segments: z.array(IrSegmentSchema),
});

export const IrListItemSchema = z.object({
  segments: z.array(IrSegmentSchema),
});

export const IrListBlockSchema = z.object({
  id: z.string(),
  type: z.literal("list"),
  ordered: z.boolean(),
  items: z.array(IrListItemSchema),
});

export const IrFigureBlockSchema = z.object({
  id: z.string(),
  type: z.literal("figure"),
  number: z.string().optional(),
  label: z.string().optional(),
  captionSegments: z.array(IrSegmentSchema).optional(),
  footnote: z.string().optional(),
  /** As stored in the Document JSON (may carry a subdirectory). */
  imgPath: z.string().optional(),
  /** Intrinsic size of the materialized image (CSS px) — lets the reader
   *  reserve the figure's box before the image loads (jump accuracy). */
  imgWidth: z.number().optional(),
  imgHeight: z.number().optional(),
  /** MinerU chart sub_type: line/bar/scatter… */
  chartType: z.string().optional(),
  /** MinerU's extracted chart data, if any. */
  content: z.string().optional(),
});

export const IrTableBlockSchema = z.object({
  id: z.string(),
  type: z.literal("table"),
  number: z.string().optional(),
  label: z.string().optional(),
  captionSegments: z.array(IrSegmentSchema).optional(),
  footnote: z.string().optional(),
  /** HTML serialization of the table. */
  tableBody: z.string().optional(),
  /** Fallback image when the table was not recognized. */
  imgPath: z.string().optional(),
});

export const IrEquationBlockSchema = z.object({
  id: z.string(),
  type: z.literal("equation"),
  number: z.string().optional(),
  label: z.string().optional(),
  latex: z.string(),
});

export const IrCodeBlockSchema = z.object({
  id: z.string(),
  type: z.literal("code"),
  number: z.string().optional(),
  label: z.string().optional(),
  captionSegments: z.array(IrSegmentSchema).optional(),
  lang: z.string().optional(),
  body: z.string().optional(),
});

/** Pseudocode / algorithm float. */
export const IrAlgorithmBlockSchema = z.object({
  id: z.string(),
  type: z.literal("algorithm"),
  number: z.string().optional(),
  label: z.string().optional(),
  captionSegments: z.array(IrSegmentSchema).optional(),
  body: z.string().optional(),
});

export const IrBlockSchema = z.discriminatedUnion("type", [
  IrParagraphBlockSchema,
  IrListBlockSchema,
  IrFigureBlockSchema,
  IrTableBlockSchema,
  IrEquationBlockSchema,
  IrCodeBlockSchema,
  IrAlgorithmBlockSchema,
]);

// --------------------------------------------------------------------------- //
// Sections (the structure tree, rendering projection)
// --------------------------------------------------------------------------- //

export interface IrSection {
  id: string;
  /** 1 = top-level heading. */
  level: number;
  /** Extracted number ("1", "3.2"); absent for unnumbered sections. */
  number?: string;
  /** Clean heading text; absent when empty. */
  heading?: string;
  blocks: IrBlock[];
  children: IrSection[];
}

export const IrSectionSchema: z.ZodType<IrSection> = z.lazy(() =>
  z.object({
    id: z.string(),
    level: z.number().int(),
    number: z.string().optional(),
    heading: z.string().optional(),
    blocks: z.array(IrBlockSchema),
    children: z.array(IrSectionSchema),
  })
);

// --------------------------------------------------------------------------- //
// Manifests (article_refs.jsonl / article_bib.jsonl row shapes)
// --------------------------------------------------------------------------- //

export const RefManifestKindSchema = z.enum([
  "figure",
  "table",
  "equation",
  "code",
  "algorithm",
  "section",
]);

export const RefManifestRowSchema = z.object({
  id: z.string(),
  kind: RefManifestKindSchema,
  number: z.string().optional(),
  /** Full latex (equations) / token-expanded caption (floats) / heading (sections). */
  content: z.string(),
  /** Truncated preview of content. */
  short: z.string(),
  /** Containing section as `"2:Introduction"` (or just the heading). */
  section: z.string(),
  /** Nearest paragraph/list text before the float (reading order). */
  context_before: z.string().optional(),
  /** Nearest paragraph/list text after the float (reading order). */
  context_after: z.string().optional(),
});

export const BibManifestRowSchema = z.object({
  id: z.string(),
  /** `"Belokurov et al. 2006"`. */
  short: z.string(),
  title: z.string().optional(),
  /** Family names, `", "`-joined. */
  author: z.string().optional(),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  doi: z.string().optional(),
  arxiv_id: z.string().optional(),
  /** The raw bibliography entry text. */
  raw: z.string(),
});

// --------------------------------------------------------------------------- //
// DocIr
// --------------------------------------------------------------------------- //

/**
 * The render IR for one document. `citationsByBlock` groups the flattened
 * document-level `citations` by `block_id` (order preserved, `ref_ids`
 * flattened and deduped) — it powers the reader's right-panel citation cards,
 * including hyperlink-found occurrences that have no inline token.
 */
export const DocIrSchema = z.object({
  docId: z.string(),
  /** `meta.title`. */
  title: z.string().optional(),
  /** `source.n_pages` (PDF page count); absent for sources without one. */
  nPages: z.number().int().optional(),
  sections: z.array(IrSectionSchema),
  refsManifest: z.array(RefManifestRowSchema),
  bib: z.array(BibManifestRowSchema),
  /**
   * The document's references, passed through verbatim: the reader's
   * reference cards need the full fields (`authors`, `url`, …) that the bib
   * rows flatten away. Absent when the document carries none (compact
   * convention, like the other optional keys).
   */
  references: z.array(ReferenceSchema).optional(),
  citationsByBlock: z.record(z.string(), z.array(z.string())),
});

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type IrTextSegment = z.infer<typeof IrTextSegmentSchema>;
export type IrMathSegment = z.infer<typeof IrMathSegmentSchema>;
export type IrCiteRef = z.infer<typeof IrCiteRefSchema>;
export type IrCiteSegment = z.infer<typeof IrCiteSegmentSchema>;
export type IrXrefTargetType = z.infer<typeof IrXrefTargetTypeSchema>;
export type IrXrefTarget = z.infer<typeof IrXrefTargetSchema>;
export type IrXrefSegment = z.infer<typeof IrXrefSegmentSchema>;
export type IrSegment = z.infer<typeof IrSegmentSchema>;
export type IrParagraphBlock = z.infer<typeof IrParagraphBlockSchema>;
export type IrListItem = z.infer<typeof IrListItemSchema>;
export type IrListBlock = z.infer<typeof IrListBlockSchema>;
export type IrFigureBlock = z.infer<typeof IrFigureBlockSchema>;
export type IrTableBlock = z.infer<typeof IrTableBlockSchema>;
export type IrEquationBlock = z.infer<typeof IrEquationBlockSchema>;
export type IrCodeBlock = z.infer<typeof IrCodeBlockSchema>;
export type IrAlgorithmBlock = z.infer<typeof IrAlgorithmBlockSchema>;
export type IrBlock = z.infer<typeof IrBlockSchema>;
export type RefManifestKind = z.infer<typeof RefManifestKindSchema>;
export type RefManifestRow = z.infer<typeof RefManifestRowSchema>;
export type BibManifestRow = z.infer<typeof BibManifestRowSchema>;
export type DocIr = z.infer<typeof DocIrSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
