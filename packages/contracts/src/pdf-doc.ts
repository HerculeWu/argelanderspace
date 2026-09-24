import { z } from "zod";

export const PDF_MAX_BYTES = 50 * 1024 * 1024;
export const PDF_RESOURCE_WARNING_BYTES = 25 * 1024 * 1024;
export const PDF_MAX_PAGES = 100;
export const PDF_MIN_IN_FLIGHT_HEADROOM_BYTES = 512 * 1024 * 1024;
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const PageGeometrySchema = z.strictObject({
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
});

/** Persistent identity of an immutable, server-probed PDF Doc. */
export const PdfDocMetadataSchema = z
  .strictObject({
    version: z.literal(1),
    doc_id: z.string().min(1),
    format: z.literal("pdf"),
    display_name: z.string().min(1).max(255),
    original_filename: z.string().min(1).max(255),
    acquired_via: z.enum(["user_pdf_upload", "arxiv_pdf"]),
    arxiv_id: z.string().min(1).optional(),
    acquired_at: z.string().datetime({ offset: true }),
    byte_length: z.number().int().positive().max(PDF_MAX_BYTES),
    sha256: Sha256Schema,
    page_count: z.number().int().positive().max(PDF_MAX_PAGES),
    pages: z.array(PageGeometrySchema).min(1).max(PDF_MAX_PAGES),
  })
  .superRefine((metadata, ctx) => {
    if (metadata.acquired_via === "arxiv_pdf" && metadata.arxiv_id === undefined) {
      ctx.addIssue({ code: "custom", path: ["arxiv_id"], message: "arXiv ID is required" });
    }
    if (metadata.acquired_via === "user_pdf_upload" && metadata.arxiv_id !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["arxiv_id"],
        message: "upload cannot claim an arXiv ID",
      });
    }
    if (metadata.pages.length !== metadata.page_count) {
      ctx.addIssue({
        code: "custom",
        path: ["pages"],
        message: "page geometry count does not match page_count",
      });
    }
  });
export type PdfDocMetadata = z.infer<typeof PdfDocMetadataSchema>;

const PdfAnnotationStyleSchema = z
  .object({
    color: z.string().min(1).max(32),
    opacity: z.number().finite().min(0).max(1),
    line_width: z.number().finite().positive().max(32),
  })
  .passthrough();
const PdfRectangleSchema = z
  .object({
    x: z.number().finite().min(0).max(1),
    y: z.number().finite().min(0).max(1),
    width: z.number().finite().positive().max(1),
    height: z.number().finite().positive().max(1),
  })
  .passthrough()
  .superRefine((rect, ctx) => {
    if (rect.x + rect.width > 1 || rect.y + rect.height > 1) {
      ctx.addIssue({ code: "custom", message: "rectangle must remain within its page" });
    }
  });
const PdfTextFragmentSchema = z
  .object({
    page_index: z.number().int().nonnegative(),
    rectangles: z.array(PdfRectangleSchema).min(1),
  })
  .passthrough();
const PdfTextTargetSchema = z
  .object({
    quote: z
      .string()
      .max(1_000_000)
      .refine((quote) => quote.trim().length > 0, "text target quote must not be blank"),
    fragments: z.array(PdfTextFragmentSchema).min(1),
  })
  .passthrough()
  .superRefine((target, ctx) => {
    if (
      new Set(target.fragments.map((fragment) => fragment.page_index)).size !==
      target.fragments.length
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["fragments"],
        message: "text fragments must be grouped by page",
      });
    }
  });
const PdfAnnotationBaseSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: z.enum([
      "rectangle",
      "page_comment",
      "document_comment",
      "highlight",
      "underline",
      "strikeout",
    ]),
    body: z
      .string()
      .max(1_000_000)
      .refine((body) => body.trim().length > 0, "annotation body must not be blank"),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
  })
  .passthrough();
export const PdfAnnotationSchema = z
  .discriminatedUnion("kind", [
    PdfAnnotationBaseSchema.extend({
      kind: z.literal("rectangle"),
      page_index: z.number().int().nonnegative(),
      rectangle: PdfRectangleSchema,
      style: PdfAnnotationStyleSchema,
    }),
    PdfAnnotationBaseSchema.extend({
      kind: z.literal("page_comment"),
      page_index: z.number().int().nonnegative(),
    }),
    PdfAnnotationBaseSchema.extend({ kind: z.literal("document_comment") }),
    PdfAnnotationBaseSchema.extend({
      kind: z.literal("highlight"),
      target: PdfTextTargetSchema,
    }),
    PdfAnnotationBaseSchema.extend({
      kind: z.literal("underline"),
      target: PdfTextTargetSchema,
    }),
    PdfAnnotationBaseSchema.extend({
      kind: z.literal("strikeout"),
      target: PdfTextTargetSchema,
    }),
  ])
  .superRefine((annotation, ctx) => {
    if (annotation.kind !== "rectangle" && "style" in annotation)
      ctx.addIssue({
        code: "custom",
        path: ["style"],
        message: "style applies only to rectangles",
      });
    if (annotation.kind !== "rectangle" && ("rectangle" in annotation || "geometry" in annotation))
      ctx.addIssue({
        code: "custom",
        path: ["rectangle"],
        message: "rectangle geometry requires rectangle tool",
      });
  });
export type PdfAnnotation = z.infer<typeof PdfAnnotationSchema>;

/** Workbench sidecar is separate from the source PDF and preserves additive fields. */
export const PdfAnnotationsFileSchema = z
  .object({
    version: z.literal(1),
    doc_id: z.string().min(1),
    content_sha256: Sha256Schema,
    rev: z.number().int().nonnegative(),
    annotations: z.array(PdfAnnotationSchema),
  })
  .passthrough()
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    file.annotations.forEach((annotation, index) => {
      if (ids.has(annotation.id))
        ctx.addIssue({
          code: "custom",
          path: ["annotations", index, "id"],
          message: "annotation id must be unique",
        });
      ids.add(annotation.id);
    });
  });
export type PdfAnnotationsFile = z.infer<typeof PdfAnnotationsFileSchema>;

/** Page-local reader coordinates are normalized and independent of viewport pixels. */
export const PdfReadingLocationSchema = z.strictObject({
  page_index: z.number().int().nonnegative(),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
});
export type PdfReadingLocation = z.infer<typeof PdfReadingLocationSchema>;

/** Initial reading state is explicitly null; it is not page zero. */
export const PdfReadingPositionSchema = z.strictObject({
  version: z.literal(1),
  doc_id: z.string().min(1),
  content_sha256: Sha256Schema,
  rev: z.number().int().nonnegative(),
  position: PdfReadingLocationSchema.nullable(),
});
export type PdfReadingPosition = z.infer<typeof PdfReadingPositionSchema>;

export const PdfReaderPositionReadSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("ready"), file: PdfReadingPositionSchema }),
  z.strictObject({ status: z.literal("error"), detail: z.string().min(1) }),
]);
export type PdfReaderPositionRead = z.infer<typeof PdfReaderPositionReadSchema>;

export const WsPdfReadingPositionChangedSchema = z.strictObject({
  type: z.literal("pdf-reading-position.changed"),
  doc_id: z.string().min(1),
  rev: z.number().int().nonnegative(),
  at: z.string(),
});
export type WsPdfReadingPositionChanged = z.infer<typeof WsPdfReadingPositionChangedSchema>;

export const PdfReaderSnapshotSchema = z.strictObject({
  metadata: PdfDocMetadataSchema,
  annotations: PdfAnnotationsFileSchema,
  reading_position: PdfReaderPositionReadSchema,
});
export type PdfReaderSnapshot = z.infer<typeof PdfReaderSnapshotSchema>;
