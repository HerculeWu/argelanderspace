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
import { DocIrSchema } from "./doc-ir.js";
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

/** A registered image asset of the source (reserved: the asset operations come with the figure ticket). */
export const TextSourceAssetSchema = z.strictObject({
  name: z.string().min(1),
  sha256: Sha256Schema,
  byte_length: z.number().int().nonnegative(),
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
// Diagnostics and the source/generation DTOs
// --------------------------------------------------------------------------- //

export const TextDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  message: z.string().min(1),
  /** 1-based position in the source text; absent for whole-document diagnostics. */
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
export type TextDiagnostic = z.infer<typeof TextDiagnosticSchema>;

export const TextStatsSchema = z.strictObject({
  sections: z.number().int().nonnegative(),
  paragraphs: z.number().int().nonnegative(),
  lists: z.number().int().nonnegative(),
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

export const GenerateTextDocRequestSchema = z.strictObject({
  sourceRev: z.number().int().nonnegative(),
  operationId: z.string().min(8).max(128),
});
export type GenerateTextDocRequest = z.infer<typeof GenerateTextDocRequestSchema>;

export const TextGenerationResultSchema = z.strictObject({
  publishedSourceRev: z.number().int().nonnegative(),
  /** The annotation content fingerprint of the published reading text. */
  fingerprint: Sha256Schema,
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
