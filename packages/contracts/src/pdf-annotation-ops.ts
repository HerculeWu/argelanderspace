/**
 * The Copilot's PDF workbench annotation operations (copilot ticket 21): the PDF Reader's own annotation controls
 * (the area, highlight, underline and strikeout tools, the page and document comment buttons, the panel's body editor,
 * rectangle style and highlight colour, the trash button, undo and redo) as typed requests.
 *
 * Every request names the immutable original it was planned against (`sha256` of `reading.sha256`) and the sidecar's
 * revision of that same reading (`rev` = `reading.annotationsRev`); the service refuses it when either is no longer
 * current, exactly as `PUT /api/paper/:doc_id/pdf/annotations` does. Pages are ZERO-BASED, as in the rest of the PDF
 * protocol. A text annotation is anchored to REAL text of a page's text layer: the quote must be text the page
 * really has, and its rectangles are computed by the service from the engine's geometry of the verified original,
 * never supplied by the caller. Nothing here can name a path, a rectangle for text or a PDF byte.
 */
import { z } from "zod";
import { PdfHighlightColorSchema } from "./pdf-doc.js";

const Count = z.number().int().nonnegative();
const Id = z.string().min(1).max(500);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const AnnotationId = z.string().min(1).max(128);

/** Longest annotation body one call may carry (input sanity; the panel's editor has no limit). */
export const PDF_ANNOTATION_BODY_MAX = 100_000;
/** The area tool ignores a drawn rectangle smaller than this (fraction of the page) on either side. */
export const PDF_RECTANGLE_MIN = 0.006;
/** The default look of a rectangle drawn with the area tool. */
export const PDF_RECTANGLE_DEFAULT_STYLE = {
  color: "#f4c542",
  opacity: 0.35,
  line_width: 2,
} as const;
/** A highlight with no `color` is yellow. */
export const PDF_HIGHLIGHT_DEFAULT_COLOR = "#ffd228";
/** The most pages one text annotation may span (every page of a PDF may be one). */
export const PDF_TEXT_PARTS_MAX = 100;

const Body = z
  .string()
  .max(PDF_ANNOTATION_BODY_MAX)
  .refine((body) => body.trim() !== "", { message: "body must not be empty" });

/** A rectangle on one page in fractions of the VISIBLE page (x/y from its top-left); what the area tool stores. */
export const PdfRectangleInputSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().min(PDF_RECTANGLE_MIN).max(1),
    height: z.number().finite().min(PDF_RECTANGLE_MIN).max(1),
  })
  .strict()
  .refine((r) => r.x + r.width <= 1 + 1e-9 && r.y + r.height <= 1 + 1e-9, {
    message: "the rectangle must stay inside its page",
  });
export type PdfRectangleInput = z.infer<typeof PdfRectangleInputSchema>;

/** The panel's rectangle style controls: a colour input, an opacity slider (0.1 to 1), a line width (1 to 32). */
export const PdfRectangleStyleInputSchema = z
  .object({
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    opacity: z.number().finite().min(0.1).max(1),
    line_width: z.number().int().min(1).max(32),
  })
  .partial()
  .strict()
  .refine((style) => Object.keys(style).length > 0, { message: "give at least one style field" });
export type PdfRectangleStyleInput = z.infer<typeof PdfRectangleStyleInputSchema>;

/**
 * One page's part of a text annotation: `quote` is text copied exactly from that page's text (`reading.pages[].text`),
 * and must occur there exactly once unless `occurrence` (zero-based, counting every start position in reading order)
 * says which one is meant. A quote across pages is one part per page: the stored quote joins the parts with a line
 * break, as the selection tools do, and the stored rectangles are grouped by page.
 */
export const PdfTextPartInputSchema = z
  .object({
    pageIndex: Count,
    quote: z.string().min(1).max(1_000_000),
    occurrence: Count.optional(),
  })
  .strict();
export type PdfTextPartInput = z.infer<typeof PdfTextPartInputSchema>;

export const PDF_TEXT_KINDS = ["highlight", "underline", "strikeout"] as const;
export const PDF_ANNOTATION_KINDS = [
  "rectangle",
  "page_comment",
  "document_comment",
  ...PDF_TEXT_KINDS,
] as const;

const WriteEpoch = { docId: Id, sha256: Sha256, rev: Count };

export const PdfCreateAnnotationOperationSchema = z
  .object({
    action: z.literal("create_pdf_annotation"),
    ...WriteEpoch,
    kind: z.enum(PDF_ANNOTATION_KINDS),
    body: Body,
    pageIndex: Count.optional(),
    rectangle: PdfRectangleInputSchema.optional(),
    style: PdfRectangleStyleInputSchema.optional(),
    parts: z.array(PdfTextPartInputSchema).min(1).max(PDF_TEXT_PARTS_MAX).optional(),
    color: PdfHighlightColorSchema.optional(),
  })
  .strict()
  .superRefine((op, ctx) => {
    const forbid = (field: keyof typeof op, why: string) => {
      if (op[field] !== undefined)
        ctx.addIssue({ code: "custom", path: [field], message: `${why}` });
    };
    const need = (field: keyof typeof op, why: string) => {
      if (op[field] === undefined)
        ctx.addIssue({ code: "custom", path: [field], message: `${why}` });
    };
    switch (op.kind) {
      case "rectangle":
        need("pageIndex", "a rectangle needs the zero-based pageIndex");
        need("rectangle", "a rectangle needs its rectangle");
        forbid("parts", "only a text annotation has parts");
        forbid("color", "colour applies to highlights only");
        break;
      case "page_comment":
        need("pageIndex", "a page comment needs the zero-based pageIndex");
        forbid("rectangle", "only a rectangle has geometry");
        forbid("style", "style applies to rectangles only");
        forbid("parts", "only a text annotation has parts");
        forbid("color", "colour applies to highlights only");
        break;
      case "document_comment":
        forbid("pageIndex", "a document comment has no page");
        forbid("rectangle", "only a rectangle has geometry");
        forbid("style", "style applies to rectangles only");
        forbid("parts", "only a text annotation has parts");
        forbid("color", "colour applies to highlights only");
        break;
      default:
        need("parts", "a text annotation needs parts (the real text and its page)");
        forbid("pageIndex", "a text annotation takes its pages from parts");
        forbid("rectangle", "the rectangles of text come from the page's text layer, not from you");
        forbid("style", "style applies to rectangles only");
        if (op.kind !== "highlight") forbid("color", "colour applies to highlights only");
        if (op.parts) {
          for (let i = 1; i < op.parts.length; i++)
            if ((op.parts[i]?.pageIndex ?? 0) <= (op.parts[i - 1]?.pageIndex ?? 0))
              ctx.addIssue({
                code: "custom",
                path: ["parts", i, "pageIndex"],
                message: "parts must be in ascending page order, one per page",
              });
        }
    }
  });
export type PdfCreateAnnotationOperation = z.infer<typeof PdfCreateAnnotationOperationSchema>;

/**
 * The panel's editors: the body, a rectangle's geometry (move/resize) and style, a highlight's colour. What the
 * annotation is anchored to (kind, page, text, created time) never changes: moving it means deleting and creating.
 * `expectedUpdatedAt` is that annotation's `updated_at` as your latest reading or write result showed it.
 */
export const PdfUpdateAnnotationOperationSchema = z
  .object({
    action: z.literal("update_pdf_annotation"),
    ...WriteEpoch,
    annotationId: AnnotationId,
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    body: Body.optional(),
    rectangle: PdfRectangleInputSchema.optional(),
    style: PdfRectangleStyleInputSchema.optional(),
    color: PdfHighlightColorSchema.optional(),
  })
  .strict()
  .refine(
    (op) =>
      op.body !== undefined ||
      op.rectangle !== undefined ||
      op.style !== undefined ||
      op.color !== undefined,
    { message: "give at least one of body, rectangle, style or color" }
  );
export type PdfUpdateAnnotationOperation = z.infer<typeof PdfUpdateAnnotationOperationSchema>;

/** The trash button: one annotation at once (the UI asks no confirmation), undoable with undo_pdf_annotation. */
export const PdfDeleteAnnotationOperationSchema = z
  .object({
    action: z.literal("delete_pdf_annotation"),
    ...WriteEpoch,
    annotationId: AnnotationId,
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PdfDeleteAnnotationOperation = z.infer<typeof PdfDeleteAnnotationOperationSchema>;

/** The panel's Undo and Redo buttons, for the changes THIS service made for the Copilot to the Doc's annotations. */
export const PdfUndoAnnotationOperationSchema = z
  .object({ action: z.literal("undo_pdf_annotation"), ...WriteEpoch })
  .strict();
export const PdfRedoAnnotationOperationSchema = z
  .object({ action: z.literal("redo_pdf_annotation"), ...WriteEpoch })
  .strict();

export const PdfAnnotationOperationSchema = z.discriminatedUnion("action", [
  PdfCreateAnnotationOperationSchema,
  PdfUpdateAnnotationOperationSchema,
  PdfDeleteAnnotationOperationSchema,
  PdfUndoAnnotationOperationSchema,
  PdfRedoAnnotationOperationSchema,
]);
export type PdfAnnotationOperation = z.infer<typeof PdfAnnotationOperationSchema>;
export const PDF_ANNOTATION_ACTIONS = [
  "create_pdf_annotation",
  "update_pdf_annotation",
  "delete_pdf_annotation",
  "undo_pdf_annotation",
  "redo_pdf_annotation",
] as const;
