/**
 * The text Doc's page context and the closed operation union of the Copilot `text` tool (copilot ticket 29).
 *
 * The tool's actions are the text source panel's own controls run through the same handlers as its HTTP routes:
 * create (the Files tab's create button), read the source, save it (autosave's PUT with its expected revision), add an
 * image (the assets dialog's upload, or the same picture rendered from the source PDF), validate and generate. Opening
 * the Reader or the source tab is a view action of the `reader` tool (`set_text_view`); opening the source PDF is the
 * workspace's open_doc. Nothing here writes the reading text except the explicit generate, and a replacement of
 * annotated reading text is only ever confirmed by the real user.
 */
import { z } from "zod";
import { PdfRectangleInputSchema } from "./pdf-annotation-ops.js";
import { TextDiagnosticSchema, TextSourceAssetSchema, TextSourcePdfSchema } from "./text-doc.js";

const Id = z.string().min(1).max(500);
const Count = z.number().int().nonnegative();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** The longest source a page carries inline; a longer one is read with `read_source` in parts. */
export const TEXT_SOURCE_INLINE_MAX = 100_000;
/** The resolution of a picture rendered from the source PDF: its LONGER edge in pixels. */
export const TEXT_PDF_IMAGE_LONG_EDGE = { min: 256, default: 1600, max: 3000 } as const;
/** Pixel budget of one rendered picture (the scale is reduced to meet it, never refused for being large). */
export const TEXT_PDF_IMAGE_MAX_PIXELS = 9_000_000;

// ---- Page context ------------------------------------------------------------------------------------ //

/**
 * What the text Doc's source panel tells the Copilot: the editor's CURRENT text (which may be newer than the saved
 * source: `unsaved` says so and the text is then the user's draft, not the disk), the saved revision it is based on,
 * the image assets, the published revision, the diagnostics shown and the save/generation state.
 */
export const TextSourcePageSchema = z
  .object({
    docId: Id,
    view: z.enum(["reader", "source"]),
    phase: z.enum(["loading", "ready", "error"]),
    /** The saved source revision the editor is based on; null while loading or after a load error. */
    rev: Count.nullable(),
    save: z.enum(["saved", "dirty", "saving", "error", "conflict"]),
    /** The editor's text differs from the saved source: `markdown` is then the user's unsaved draft. */
    unsaved: z.boolean(),
    characters: Count,
    /** The whole editor text; null only when it is longer than TEXT_SOURCE_INLINE_MAX (`omitted` says so). */
    markdown: z.string().max(TEXT_SOURCE_INLINE_MAX).nullable(),
    omitted: z.string().optional(),
    assets: z.array(TextSourceAssetSchema).max(500),
    generated: z.boolean(),
    publishedSourceRev: Count.nullable(),
    diagnostics: z.array(TextDiagnosticSchema).max(200),
    generation: z.enum(["idle", "running", "validated", "generated", "failed", "cancelled"]),
    sourcePdf: TextSourcePdfSchema.optional(),
  })
  .strict()
  .superRefine((page, ctx) => {
    // an inline text is the whole editor text: its length is what `characters` says
    if (page.markdown !== null && page.markdown.length !== page.characters)
      ctx.addIssue({
        code: "custom",
        message: "characters must be the length of the inline markdown",
      });
  });
export type TextSourcePage = z.infer<typeof TextSourcePageSchema>;

/** What a message records of the text source it carried. */
export const TextContextSummarySchema = z
  .object({
    docId: Id,
    view: z.enum(["reader", "source"]),
    phase: z.enum(["loading", "ready", "error"]),
    rev: Count.nullable(),
    characters: Count,
    unsaved: z.boolean(),
    assets: Count,
    generated: z.boolean(),
    diagnostics: Count,
  })
  .strict();
export type TextContextSummary = z.infer<typeof TextContextSummarySchema>;
export function summarizeTextPage(page: TextSourcePage): TextContextSummary {
  return {
    docId: page.docId,
    view: page.view,
    phase: page.phase,
    rev: page.rev,
    characters: page.characters,
    unsaved: page.unsaved,
    assets: page.assets.length,
    generated: page.generated,
    diagnostics: page.diagnostics.length,
  };
}

// ---- Tool operations --------------------------------------------------------------------------------- //

/**
 * A region of a source PDF page in fractions of the VISIBLE page (x/y from its top-left), the same geometry and the
 * same validation as the PDF Reader's area tool; absent means the whole page.
 */
export const TextPdfRegionSchema = PdfRectangleInputSchema;
export type TextPdfRegion = z.infer<typeof TextPdfRegionSchema>;

/** The request of the source panel's "add image from the source PDF" and of the tool's add_pdf_image. */
export const AddPdfImageRequestSchema = z
  .object({
    expectedRev: Count,
    /** Defaults to the Doc's source PDF; any other PDF Doc must belong to a Work that also lists this Doc. */
    pdfDocId: Id.optional(),
    /** The SHA-256 of the original the caller looked at (required): a different original is refused. */
    sha256: Sha256,
    /** ZERO-BASED page index. */
    pageIndex: Count,
    region: TextPdfRegionSchema.optional(),
    longEdge: z
      .number()
      .int()
      .min(TEXT_PDF_IMAGE_LONG_EDGE.min)
      .max(TEXT_PDF_IMAGE_LONG_EDGE.max)
      .optional(),
  })
  .strict();
export type AddPdfImageRequest = z.infer<typeof AddPdfImageRequestSchema>;

export const TextOperationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      workId: Id,
      sourcePdfDocId: Id.optional(),
      operationId: z.string().min(8).max(128).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("read_source"),
      docId: Id,
      from: Count.optional(),
      version: z.string().min(1).max(100).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("save_source"),
      docId: Id,
      expectedRev: Count,
      markdown: z.string(),
      append: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("add_asset"),
      docId: Id,
      expectedRev: Count,
      attachmentId: z.string().uuid(),
      filename: z.string().min(1).max(200).optional(),
    })
    .strict(),
  z
    .object({ action: z.literal("add_pdf_image"), docId: Id, ...AddPdfImageRequestSchema.shape })
    .strict(),
  z.object({ action: z.literal("validate"), docId: Id, sourceRev: Count }).strict(),
  z
    .object({
      action: z.literal("generate"),
      docId: Id,
      sourceRev: Count,
      operationId: z.string().min(8).max(128).optional(),
    })
    .strict(),
  z.object({ action: z.literal("open_source_pdf"), docId: Id }).strict(),
]);
export type TextOperation = z.infer<typeof TextOperationSchema>;
export const TEXT_OPERATION_ACTIONS = [
  "create",
  "read_source",
  "save_source",
  "add_asset",
  "add_pdf_image",
  "validate",
  "generate",
  "open_source_pdf",
] as const;
