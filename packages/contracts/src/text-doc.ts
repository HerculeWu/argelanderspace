/**
 * The text Doc (`argelander-text` v1, copilot ticket 25): a hand-written Markdown source that is turned into the
 * shared IR only when the user (or the agent) explicitly generates it.
 *
 * - {@link TextDocSourceSchema} is `<dataDir>/output/<docId>/text-source.json`: the whole Markdown as the user typed
 *   it (byte-exact round trip, syntactically invalid text included), a monotonic `rev` and the asset list.
 * - {@link TextDocIrSchema} is `<docId>.json` of a generated text Doc: the same sections/segments/manifests as the
 *   LaTeX IR plus an explicit `source.type = "text"`; it never pretends to have a LaTeX engine or main_tex.
 * - {@link StoredDocIrSchema} is the explicit union of the two stored IRs; the LaTeX schema and its serialized
 *   bytes are unchanged.
 */

import { z } from "zod";
import { DocIrSchema, ReferenceSchema } from "./doc-ir.js";
import { TEX_IR_VERSION, type TexDocIr, TexDocIrSchema, TexIrAuthorSchema } from "./tex-ir.js";

/** `argelander-text` input format version this build reads and writes. */
export const TEXT_INPUT_VERSION = 1;
/** The text IR shares the stored-IR version marker with the LaTeX IR. */
export const TEXT_IR_VERSION = TEX_IR_VERSION;
/** Doc ids of text Docs: `text-<UUID>`. */
export const TEXT_DOC_ID_PATTERN =
  /^text-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const IsoSchema = z.string().datetime({ offset: true });

/** Limits of the image assets of a text Doc (ticket 27): the Writer's 20 MiB per asset, bounded pixels, bounded count. */
export const TEXT_ASSET_MAX_BYTES = 20 * 1024 * 1024;
export const TEXT_ASSET_MAX_PIXELS = 64_000_000;
export const TEXT_ASSET_MAX_SIDE = 30_000;
export const TEXT_ASSET_MAX_COUNT = 500;
export const TextAssetMediaTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
export type TextAssetMediaType = z.infer<typeof TextAssetMediaTypeSchema>;
/** Controlled asset file names: `<stem>-<sha8>.<png|jpg|webp>`; no separators, no leading dot. */
export const TEXT_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:png|jpg|webp)$/;

/** A registered image asset of the source. Files are never overwritten: a changed image is a NEW name. */
export const TextSourceAssetSchema = z.strictObject({
  name: z.string().regex(TEXT_ASSET_NAME_PATTERN),
  sha256: Sha256Schema,
  byte_length: z.number().int().nonnegative(),
  /** Checked by magic bytes when the asset was added; absent in sources written before ticket 27 (none had assets). */
  media_type: TextAssetMediaTypeSchema.optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});
export type TextSourceAsset = z.infer<typeof TextSourceAssetSchema>;

/** The file relation to the source PDF: identity only, no page or box. */
export const TextSourcePdfSchema = z.strictObject({
  doc_id: z.string().min(1),
  sha256: Sha256Schema,
});
export type TextSourcePdf = z.infer<typeof TextSourcePdfSchema>;

export const TextDocSourceSchema = z.strictObject({
  version: z.literal(1),
  doc_id: z.string().min(1),
  /** Monotonic; every saved change (source text or asset list) increases it by one. */
  rev: z.number().int().nonnegative(),
  input_version: z.literal(TEXT_INPUT_VERSION),
  /** The complete Markdown, kept byte for byte. It may be syntactically invalid. */
  markdown: z.string(),
  assets: z.array(TextSourceAssetSchema),
  created_at: IsoSchema,
  updated_at: IsoSchema,
  source_pdf: TextSourcePdfSchema.optional(),
});
export type TextDocSource = z.infer<typeof TextDocSourceSchema>;

export const TextIrSourceSchema = z.strictObject({
  type: z.literal("text"),
  input_version: z.literal(TEXT_INPUT_VERSION),
  /** The `rev` of the text source this IR was generated from. */
  source_rev: z.number().int().nonnegative(),
  /** sha256 over the generating source (Markdown bytes and, later, the referenced asset hashes). */
  source_fingerprint: Sha256Schema,
});

export const TextIrMetaSchema = z.object({
  title: z.string().optional(),
  authors: z.array(z.string()).optional(),
  authorDetails: z.array(TexIrAuthorSchema).optional(),
  affiliations: z.array(z.string()).optional(),
  email: z.string().optional(),
});

export const TextDocIrSchema = DocIrSchema.extend({
  version: z.literal(TEXT_IR_VERSION),
  source: TextIrSourceSchema,
  meta: TextIrMetaSchema,
});
export type TextDocIr = z.infer<typeof TextDocIrSchema>;

/** What a Reader, annotation or description path may find in `<docId>.json`. */
export type StoredDocIr = TexDocIr | TextDocIr;
/**
 * Chosen by `source.type` BEFORE parsing, so a schema-invalid LaTeX IR still reports its own field paths (a plain
 * union would answer `<root>: Invalid input` and hide which field failed). An unknown or missing type is parsed as
 * LaTeX, the original contract.
 */
export const StoredDocIrSchema = z.unknown().transform((value, ctx): StoredDocIr => {
  const type = (value as { source?: { type?: unknown } } | null)?.source?.type;
  const result = (type === "text" ? TextDocIrSchema : TexDocIrSchema).safeParse(value);
  if (result.success) return result.data;
  for (const issue of result.error.issues)
    ctx.addIssue({ code: "custom", message: issue.message, path: issue.path });
  return z.NEVER;
});

/** Narrowing guards for the stored-IR union (`source.type` is nested, so it does not narrow the IR by itself). */
export function isTextDocIr(ir: StoredDocIr): ir is TextDocIr {
  return ir.source.type === "text";
}
export function isTexDocIr(ir: StoredDocIr): ir is TexDocIr {
  return ir.source.type === "latex";
}

// --------------------------------------------------------------------------- //
// Format v1 structure markers (ticket 26): the JSON of the three fenced marker blocks
// --------------------------------------------------------------------------- //

/** Ids of structure blocks and references: ASCII letters, digits and `_ . : -`, 1..128 characters. */
export const TEXT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const TextIdSchema = z.string().regex(TEXT_ID_PATTERN);

/** The first fenced block ``argelander-document``: identity shown with the text; never the Doc or Work identity. */
export const TextDocumentMetaSchema = z.strictObject({
  version: z.literal(1),
  title: z.string().min(1).optional(),
  authors: z.array(z.string().min(1)).optional(),
  authorDetails: z.array(TexIrAuthorSchema.strict()).optional(),
  affiliations: z.array(z.string().min(1)).optional(),
  email: z.string().min(1).optional(),
});
export type TextDocumentMeta = z.infer<typeof TextDocumentMetaSchema>;

/** ``argelander-block``: binds to the one block that follows it; which fields apply depends on that block. */
export const TextBlockMetaSchema = z.strictObject({
  id: TextIdSchema.optional(),
  kind: z
    .enum(["section", "paragraph", "list", "equation", "code", "algorithm", "figure", "table"])
    .optional(),
  /** The printed number; never derived from the id or the heading level. */
  number: z.string().min(1).max(64).optional(),
  /** The printed caption label such as "Algorithm 1". */
  label: z.string().min(1).max(256).optional(),
  /** Caption text: plain text with `$..$` math, `[cite: ..]` and `[ref: ..]`. */
  caption: z.string().min(1).optional(),
  /** Figures and tables only (ticket 27); the IR carries it only there. */
  footnote: z.string().min(1).optional(),
});
export type TextBlockMeta = z.infer<typeof TextBlockMetaSchema>;

/** ``argelander-references``: the document's complete bibliography; the existing Reference fields, id and raw required. */
export const TextReferenceSchema = ReferenceSchema.strict().extend({
  id: TextIdSchema,
  raw: z.string().min(1),
});
export const TextReferencesSchema = z.array(TextReferenceSchema);

/** ``argelander-table``: a table with merged cells. Cells carry text (inline `$..$` math allowed), header, spans. */
export const TextTableCellSchema = z.strictObject({
  text: z.string(),
  header: z.boolean().optional(),
  rowspan: z.number().int().min(1).optional(),
  colspan: z.number().int().min(1).optional(),
});
export const TextTableSchema = z.strictObject({
  rows: z.array(z.array(TextTableCellSchema).min(1)).min(1),
});
export type TextTable = z.infer<typeof TextTableSchema>;
/** Bounds of one table (rows, columns of the grid, total cells). */
export const TEXT_TABLE_MAX_ROWS = 2000;
export const TEXT_TABLE_MAX_COLS = 200;
export const TEXT_TABLE_MAX_CELLS = 40_000;

// --------------------------------------------------------------------------- //
// Diagnostics and the source/generation DTOs
// --------------------------------------------------------------------------- //

export const TextDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1),
  /** 1-based position in the source text; absent for whole-document diagnostics. */
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  /** `too_many_diagnostics` only: how many further diagnostics were found and are not listed. */
  count: z.number().int().positive().optional(),
  /** Metadata and reference diagnostics: the JSON path of the offending field, e.g. `authors[1]` or `[2].id`. */
  field: z.string().optional(),
  /** The offending value the page quotes in its own wording: a duplicated id, an unknown key, an unresolved target. */
  subject: z.string().optional(),
});
export type TextDiagnostic = z.infer<typeof TextDiagnosticSchema>;

export const TextStatsSchema = z.strictObject({
  sections: z.number().int().nonnegative(),
  paragraphs: z.number().int().nonnegative(),
  lists: z.number().int().nonnegative(),
  /** Scientific content (ticket 26); absent in stats written before it existed. */
  equations: z.number().int().nonnegative().optional(),
  codeBlocks: z.number().int().nonnegative().optional(),
  inlineMath: z.number().int().nonnegative().optional(),
  citations: z.number().int().nonnegative().optional(),
  crossRefs: z.number().int().nonnegative().optional(),
  references: z.number().int().nonnegative().optional(),
  /** Figures and tables (ticket 27). */
  figures: z.number().int().nonnegative().optional(),
  tables: z.number().int().nonnegative().optional(),
  /** cite/ref targets that were not found; they stay visible as unresolved and carry a warning. */
  unresolved: z.number().int().nonnegative().optional(),
});
export type TextStats = z.infer<typeof TextStatsSchema>;

/** `GET /api/paper/:id/source`, and the body of a successful `PUT`. */
export const TextSourceDtoSchema = z.strictObject({
  doc_id: z.string().min(1),
  rev: z.number().int().nonnegative(),
  input_version: z.literal(TEXT_INPUT_VERSION),
  markdown: z.string(),
  assets: z.array(TextSourceAssetSchema),
  created_at: IsoSchema,
  updated_at: IsoSchema,
  source_pdf: TextSourcePdfSchema.optional(),
  /** Whether a reading version exists, and from which source revision it was generated. */
  generated: z.boolean(),
  published_source_rev: z.number().int().nonnegative().nullable(),
});
export type TextSourceDto = z.infer<typeof TextSourceDtoSchema>;

/** `POST /api/paper/:id/source/assets`: the new source (rev + asset list) and the controlled name that was assigned. */
export const TextAssetAddedSchema = z.strictObject({
  source: TextSourceDtoSchema,
  asset: TextSourceAssetSchema,
  /** The same bytes were already registered: that asset is returned and the revision did not change. */
  reused: z.boolean(),
  /** With `reused`: the registered file was missing or damaged and has been written again from these bytes. */
  restored: z.boolean(),
});
export type TextAssetAdded = z.infer<typeof TextAssetAddedSchema>;

export const CreateTextDocRequestSchema = z.strictObject({
  workId: z.string().min(1),
  sourcePdfDocId: z.string().min(1).optional(),
  /** The caller's identity for this creation: a retry with the same id finds the same Doc. */
  operationId: z.string().min(8).max(128),
});
export type CreateTextDocRequest = z.infer<typeof CreateTextDocRequestSchema>;

export const PutTextSourceRequestSchema = z.strictObject({
  expectedRev: z.number().int().nonnegative(),
  markdown: z.string(),
});
export type PutTextSourceRequest = z.infer<typeof PutTextSourceRequestSchema>;

export const ValidateTextSourceRequestSchema = z.strictObject({
  sourceRev: z.number().int().nonnegative(),
});
export type ValidateTextSourceRequest = z.infer<typeof ValidateTextSourceRequestSchema>;

export const TextValidationResultSchema = z.strictObject({
  sourceRev: z.number().int().nonnegative(),
  valid: z.boolean(),
  diagnostics: z.array(TextDiagnosticSchema),
  stats: TextStatsSchema,
});
export type TextValidationResult = z.infer<typeof TextValidationResultSchema>;

/**
 * What replacing the reading text of a Doc that has annotations puts at risk (copilot ticket 28). The server states it
 * when a generation would change annotation-addressable content over a non-empty current batch; the real user's
 * confirmation echoes exactly these values. Every field is re-derived inside the publish critical section, so a
 * confirmation made for any other source revision, published text, new text, annotation count or annotation revision
 * is refused and the user is asked again with the fresh values.
 */
export const TextReplacementImpactSchema = z.strictObject({
  /** The Doc the question was about: a confirmation made for another Doc is never valid here. */
  docId: z.string().min(1),
  /** The source revision the candidate was made from (the request's own `sourceRev`). */
  sourceRev: z.number().int().nonnegative(),
  /** The source revision of the reading text that would be replaced. */
  publishedSourceRev: z.number().int().nonnegative(),
  /** How many annotations of the current batch would be archived by the next annotations access. */
  annotations: z.number().int().positive(),
  /** The annotations file's revision at that time. */
  annotationsRev: z.number().int().nonnegative(),
  /** Annotation content fingerprint of the reading text that would be replaced. */
  oldFingerprint: Sha256Schema,
  /** Annotation content fingerprint of the candidate. */
  newFingerprint: Sha256Schema,
});
export type TextReplacementImpact = z.infer<typeof TextReplacementImpactSchema>;

export const GenerateTextDocRequestSchema = z.strictObject({
  sourceRev: z.number().int().nonnegative(),
  operationId: z.string().min(8).max(128),
  /** The user's confirmation of a replacement, only ever sent by a real click on the shown impact. */
  confirm: TextReplacementImpactSchema.optional(),
});
export type GenerateTextDocRequest = z.infer<typeof GenerateTextDocRequestSchema>;

export const TextGenerationResultSchema = z.strictObject({
  publishedSourceRev: z.number().int().nonnegative(),
  /** The annotation content fingerprint of the published reading text. */
  fingerprint: Sha256Schema,
  /** How many annotations this publish leaves for the next annotations access to archive (0: kept, or none). */
  replacedAnnotations: z.number().int().nonnegative(),
  diagnostics: z.array(TextDiagnosticSchema),
  stats: TextStatsSchema,
});
export type TextGenerationResult = z.infer<typeof TextGenerationResultSchema>;

export const WsTextSourceChangedSchema = z.strictObject({
  type: z.literal("text-source.changed"),
  doc_id: z.string().min(1),
  rev: z.number().int().nonnegative(),
  at: z.string(),
});
export type WsTextSourceChanged = z.infer<typeof WsTextSourceChangedSchema>;

export const WsTextDocPublishedSchema = z.strictObject({
  type: z.literal("text-doc.published"),
  doc_id: z.string().min(1),
  published_source_rev: z.number().int().nonnegative(),
  at: z.string(),
});
export type WsTextDocPublished = z.infer<typeof WsTextDocPublishedSchema>;
