/**
 * The PDF Reader's original-page material, page context and view actions for the Copilot (copilot ticket 20).
 *
 * Material is what the SERVER derives from the one verified original (the bytes whose SHA-256 is the Doc's
 * immutable identity), never from the browser's rendered pages or a screenshot: the real extractable text of every
 * page, the outline, and on request one page image. Page indexes are ZERO-BASED everywhere in this protocol; the
 * Reader's UI shows them one-based, and that conversion is the UI's alone.
 *
 * A page that has no text layer says so (`hasTextLayer: false`, `text: null`); nothing here ever invents text for
 * it, and an image is source material for a model that can see, not an OCR result.
 */
import { z } from "zod";
import { PdfAnnotationSchema } from "./pdf-doc.js";

const Count = z.number().int().nonnegative();
const Id = z.string().min(1).max(500);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Controlled resolution of a page image: the LONGER edge of the PNG in pixels (the page is scaled to it). */
export const PDF_IMAGE_LONG_EDGE = { min: 256, default: 1536, max: 4096 } as const;
/** Pixel budget of one page image whatever the aspect ratio (the scale is reduced to meet it, never refused). */
export const PDF_IMAGE_MAX_PIXELS = 12_000_000;
/** The outline listed for a PDF: at most this many entries (then `outlineTruncated`), titles cut to PDF_OUTLINE_TITLE_MAX. */
export const PDF_OUTLINE_MAX_ENTRIES = 5000;
export const PDF_OUTLINE_TITLE_MAX = 500;

/**
 * What an image costs a model, the ONE rule used by the tool (is there room for this page?) and by the history
 * budget (what do the images already in the conversation take?): ceil(width x height / 750) tokens, the usual
 * pixel-based estimate, never the base64 length. The service's byte budget counts a token as 2 bytes, like text.
 */
export function imageTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750);
}
export const IMAGE_BYTES_PER_TOKEN = 2;
/**
 * Byte limits on page images, independent of the token rule (a flat page is few bytes, a busy one many):
 *  - one image may be at most this many decoded PNG bytes, conservatively below the known per-image limits of
 *    providers (about 5 MB), so a provider can never reject a request because of one page;
 *  - all images of one conversation's history together may be at most PDF_IMAGE_HISTORY_MAX_BYTES, because the whole
 *    history is sent again with every turn.
 * An image over either limit is refused whole (smaller longEdge, or fewer pages), so it is never appended to the history.
 */
export const PDF_IMAGE_MAX_BYTES = 3_500_000;
export const PDF_IMAGE_HISTORY_MAX_BYTES = 16_000_000;
/** Width and height from the header of a base64 PNG (history image blocks carry no size); null for anything else. */
export function pngSizeOfBase64(data: string): { width: number; height: number } | null {
  if (data.length < 44) return null;
  let binary: string;
  try {
    binary = atob(data.slice(0, 44));
  } catch {
    return null;
  }
  const at = (i: number) => binary.charCodeAt(i);
  const u32 = (i: number) =>
    ((at(i) << 24) | (at(i + 1) << 16) | (at(i + 2) << 8) | at(i + 3)) >>> 0;
  if (binary.length < 24 || u32(0) !== 0x89504e47 || u32(4) !== 0x0d0a1a0a) return null;
  return { width: u32(16), height: u32(20) };
}

// ---- Material (HTTP and tool result) ----------------------------------------------------------------- //

export const PdfPageMaterialSchema = z
  .object({
    pageIndex: Count,
    /** Page size in PDF points as the viewer shows it (the page's own rotation, `rotation` degrees, already applied). */
    width: z.number().positive(),
    height: z.number().positive(),
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    /** False: the page has no extractable text (a scan or a pure picture); `text` is then null, not empty. */
    hasTextLayer: z.boolean(),
    text: z.string().nullable(),
  })
  .strict();
export type PdfPageMaterial = z.infer<typeof PdfPageMaterialSchema>;

export const PdfOutlineItemSchema = z
  .object({
    id: Id,
    title: z.string().max(PDF_OUTLINE_TITLE_MAX),
    level: z.number().int().min(1).max(6),
    /** Zero-based page of an in-document destination; null for an entry that goes nowhere inside the document. */
    pageIndex: Count.nullable(),
  })
  .strict();
export type PdfOutlineItem = z.infer<typeof PdfOutlineItemSchema>;

/** `GET /api/paper/:id/pdf/pages` */
export const PdfPagesResponseSchema = z
  .object({
    doc_id: Id,
    content_sha256: Sha256,
    page_count: z.number().int().positive(),
    /** The pages that were read, zero-based and inclusive. */
    range: z.object({ first: Count, last: Count }).strict(),
    pages: z.array(PdfPageMaterialSchema).min(1),
    outline: z.array(PdfOutlineItemSchema).max(PDF_OUTLINE_MAX_ENTRIES),
    outlineTruncated: z.boolean(),
    image: z
      .object({
        type: z.literal("image/png"),
        longEdge: z.object({ min: Count, default: Count, max: Count }).strict(),
      })
      .strict(),
  })
  .strict();
export type PdfPagesResponse = z.infer<typeof PdfPagesResponseSchema>;

/**
 * The whole PDF as the model reads it: every page's real text (null where the page has none), the outline and the
 * workbench annotations (read-only here), bound to the original's SHA-256.
 */
export const PdfReadingSchema = z
  .object({
    format: z.literal("pdf"),
    docId: Id,
    title: z.string().optional(),
    sha256: Sha256,
    pageCount: z.number().int().positive(),
    pages: z.array(PdfPageMaterialSchema).min(1),
    outline: z.array(PdfOutlineItemSchema).max(PDF_OUTLINE_MAX_ENTRIES),
    outlineTruncated: z.boolean(),
    annotations: z.array(PdfAnnotationSchema),
    annotationsRev: Count,
    coverage: z
      .object({
        pages: Count,
        pagesWithText: Count,
        pagesWithoutText: Count,
        characters: Count,
      })
      .strict(),
    /** Pages whose content is only in the page image (zero-based). */
    imageOnlyPages: z.array(Count),
    /** What a model that cannot take images must know: those pages cannot be read at all. */
    images: z
      .object({
        howToRead: z.string(),
        modelAcceptsImages: z.boolean(),
        notice: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type PdfReading = z.infer<typeof PdfReadingSchema>;

/**
 * What a message carries of the PDF material: the reading, or the true reason there is none (so a missing
 * reading is never mistaken for an empty document).
 */
export const PdfMaterialEnvelopeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), reading: PdfReadingSchema }).strict(),
  z
    .object({
      status: z.enum(["busy", "changed", "not_found", "error"]),
      detail: z.string(),
    })
    .strict(),
  /**
   * Copilot ticket 24: the material was not sent in this message. `held`: this very version (same original and
   * annotations revision) was already delivered whole earlier in the conversation. `omitted`: it did not fit the
   * room left in the model's window, or the provider rejected it. Either way the totals say what exists and
   * `reader read` fetches it from the live Doc.
   */
  z
    .object({
      status: z.enum(["held", "omitted"]),
      detail: z.string(),
      /** The selected model's own capability (what the full material states as `images.modelAcceptsImages`). */
      modelAcceptsImages: z.boolean(),
      coverage: z
        .object({
          pages: Count,
          pagesWithText: Count,
          pagesWithoutText: Count,
          characters: Count,
        })
        .strict(),
    })
    .strict(),
]);
export type PdfMaterialEnvelope = z.infer<typeof PdfMaterialEnvelopeSchema>;

/** What the service reads of one PDF Doc (everything in the reading except what depends on the model). */
export interface PdfSourceMaterial {
  docId: string;
  title?: string;
  sha256: string;
  pageCount: number;
  pages: PdfPageMaterial[];
  outline: PdfOutlineItem[];
  outlineTruncated: boolean;
  annotations: PdfReading["annotations"];
  annotationsRev: number;
}

/**
 * The reading a model gets. `modelAcceptsImages` is the SELECTED model's own capability: a model that cannot see
 * is told plainly that the image-only pages cannot be read, so it never guesses their text.
 */
export function buildPdfReading(
  source: PdfSourceMaterial,
  modelAcceptsImages: boolean
): PdfReading {
  const imageOnlyPages = source.pages
    .filter((page) => !page.hasTextLayer)
    .map((page) => page.pageIndex);
  let characters = 0;
  for (const page of source.pages) characters += page.text?.length ?? 0;
  const notice = pdfImageNotice(modelAcceptsImages, imageOnlyPages);
  return {
    format: "pdf",
    docId: source.docId,
    ...(source.title !== undefined ? { title: source.title } : {}),
    sha256: source.sha256,
    pageCount: source.pageCount,
    pages: source.pages,
    outline: source.outline,
    outlineTruncated: source.outlineTruncated,
    annotations: source.annotations,
    annotationsRev: source.annotationsRev,
    coverage: {
      pages: source.pages.length,
      pagesWithText: source.pages.length - imageOnlyPages.length,
      pagesWithoutText: imageOnlyPages.length,
      characters,
    },
    imageOnlyPages,
    images: {
      howToRead:
        "reader read_page_image {docId, pageIndex (zero-based), sha256} returns that original page as an image; every page of the original can be read this way, whatever the Reader has rendered",
      modelAcceptsImages,
      ...(notice ? { notice } : {}),
    },
  };
}

/** Text a model-facing notice carries when the model cannot see pictures. */
export const PDF_NO_IMAGE_NOTICE =
  "this model cannot take images, so pages without a text layer (imageOnlyPages) cannot be read; do not guess their content from anything else. Tell the user to choose an image-capable model in the model selector.";

export function pdfImageNotice(
  accepts: boolean,
  imageOnlyPages: readonly number[]
): string | undefined {
  return !accepts && imageOnlyPages.length > 0 ? PDF_NO_IMAGE_NOTICE : undefined;
}

// ---- Page context ------------------------------------------------------------------------------------ //

export const PDF_ZOOM_MODES = ["custom", "fit_width", "fit_page"] as const;
export const PdfOutlineEntrySchema = PdfOutlineItemSchema.extend({
  /** An entry whose destination the Reader refuses (outside the document): shown disabled, navigates nowhere. */
  disabled: z.boolean(),
});
export type PdfOutlineEntry = z.infer<typeof PdfOutlineEntrySchema>;

export const PdfSearchStateSchema = z
  .object({
    query: z.string().max(1000),
    /**
     * Counts every search the Reader starts (box or tool). A tool that started a search waits for a settled state
     * with a LARGER generation, so it never reports the results of an earlier identical search.
     */
    generation: Count,
    status: z.enum(["searching", "done"]),
    /** All results the search found; `results` lists the first ones, as the Reader's list does. */
    count: Count,
    results: z
      .array(
        z
          .object({
            pageIndex: Count,
            before: z.string(),
            match: z.string(),
            after: z.string(),
          })
          .strict()
      )
      .max(20),
  })
  .strict();
export type PdfSearchState = z.infer<typeof PdfSearchStateSchema>;

/** A text selection made in the Reader's real text layer, bound to the original it was made in. */
export const PdfSelectionSchema = z
  .object({
    sha256: Sha256,
    text: z.string().min(1).max(1_000_000),
    firstPage: Count,
    lastPage: Count,
  })
  .strict();
export type PdfSelection = z.infer<typeof PdfSelectionSchema>;

/**
 * What the PDF Reader publishes. Content (the pages' text and images) is NOT here: the service derives it from the
 * verified original; this page is identity, position and the Reader's own control state.
 */
export const PdfPageSchema = z
  .object({
    docId: Id,
    format: z.literal("pdf"),
    /** `ready`: the document is open in the Reader. `changed`: the original no longer matches (Reader refuses it). */
    phase: z.enum(["loading", "ready", "error", "changed"]),
    sha256: Sha256.nullable(),
    pageCount: z.number().int().positive().nullable(),
    /** The page the viewer is on (zero-based); a hint. */
    currentPage: Count.nullable(),
    zoom: z
      .object({ mode: z.enum(PDF_ZOOM_MODES), percent: z.number().int().positive() })
      .strict()
      .nullable(),
    outline: z.array(PdfOutlineEntrySchema).max(PDF_OUTLINE_MAX_ENTRIES),
    /** The outline had more entries than listed here (the Reader's panel still shows all of them). */
    outlineTruncated: z.boolean(),
    search: PdfSearchStateSchema.nullable(),
    selection: PdfSelectionSchema.nullable(),
    panels: z.object({ outlineCollapsed: z.boolean(), annotationsCollapsed: z.boolean() }).strict(),
    /**
     * Annotation text the user has typed in the panel and not saved (the session's own retained drafts). Presence and the
     * blocked state only, never the text: a write the agent makes never replaces a draft, and a draft is never saved
     * for the user. `create` is a new comment being written; `edit` lists existing annotations being edited (a draft
     * whose annotation is gone is listed too, it is still the user's text).
     */
    drafts: z
      .object({
        create: z.boolean(),
        edit: z.array(z.object({ annotationId: Id, blocked: z.boolean() }).strict()).max(1000),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((page, ctx) => {
    if (page.phase !== "ready" && (page.selection !== null || page.search !== null))
      ctx.addIssue({
        code: "custom",
        message: "selection and search exist only in a ready Reader",
      });
    if (page.selection !== null && page.selection.sha256 !== page.sha256)
      ctx.addIssue({ code: "custom", message: "selection must name the original of the page" });
  });
export type PdfPage = z.infer<typeof PdfPageSchema>;

export const PdfContextSummarySchema = z
  .object({
    docId: Id,
    phase: z.enum(["loading", "ready", "error", "changed"]),
    sha256: Sha256.nullable(),
    pageCount: Count,
    currentPage: Count.nullable(),
    selection: z.boolean(),
    /** What the service attached of the original's material (identity and sizes; the content is in the history). */
    material: z
      .object({
        status: z.enum(["ok", "busy", "changed", "not_found", "error", "held", "omitted"]),
        /** The selected model's own capability when this was attached: what a model without it could not read. */
        modelAcceptsImages: z.boolean(),
        pages: Count,
        pagesWithText: Count,
        pagesWithoutText: Count,
        characters: Count,
        /** The whole document's counts (the fields above are what this message actually carries). */
        totals: z
          .object({
            pages: Count,
            pagesWithText: Count,
            pagesWithoutText: Count,
            characters: Count,
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PdfContextSummary = z.infer<typeof PdfContextSummarySchema>;

export function summarizePdfPage(
  page: PdfPage,
  material?: PdfMaterialEnvelope,
  modelAcceptsImages = true
): PdfContextSummary {
  // What the message actually carries (the pages of its material), beside the whole document's totals.
  const delivered =
    material?.status === "ok"
      ? {
          pages: material.reading.pages.length,
          pagesWithText: material.reading.pages.filter((item) => item.hasTextLayer).length,
          pagesWithoutText: material.reading.pages.filter((item) => !item.hasTextLayer).length,
          characters: material.reading.pages.reduce(
            (sum, item) => sum + (item.text?.length ?? 0),
            0
          ),
        }
      : undefined;
  const totals =
    material?.status === "ok"
      ? material.reading.coverage
      : material?.status === "held" || material?.status === "omitted"
        ? material.coverage
        : undefined;
  return {
    docId: page.docId,
    phase: page.phase,
    sha256: page.sha256,
    pageCount: page.pageCount ?? 0,
    currentPage: page.currentPage,
    selection: page.selection !== null,
    ...(material
      ? {
          material: {
            status: material.status,
            modelAcceptsImages:
              material.status === "ok"
                ? material.reading.images.modelAcceptsImages
                : material.status === "held" || material.status === "omitted"
                  ? material.modelAcceptsImages
                  : modelAcceptsImages,
            pages: delivered?.pages ?? 0,
            pagesWithText: delivered?.pagesWithText ?? 0,
            pagesWithoutText: delivered?.pagesWithoutText ?? 0,
            characters: delivered?.characters ?? 0,
            ...(totals ? { totals } : {}),
          },
        }
      : {}),
  };
}

// ---- Tool operations --------------------------------------------------------------------------------- //

/**
 * One original page as an image for a model that can see: `pageIndex` is zero-based, `sha256` (when given) is the
 * original of the reading it was planned from, and `longEdge` the controlled resolution in pixels.
 */
export const PdfReadPageImageOperationSchema = z
  .object({
    action: z.literal("read_page_image"),
    docId: Id,
    pageIndex: Count,
    /** Required: the original of the reading the page was chosen from, so another original is refused. */
    sha256: Sha256,
    longEdge: z.number().int().min(PDF_IMAGE_LONG_EDGE.min).max(PDF_IMAGE_LONG_EDGE.max).optional(),
  })
  .strict();
export type PdfReadPageImageOperation = z.infer<typeof PdfReadPageImageOperationSchema>;

/**
 * View operations of the PDF Reader, each one a control the toolbar or panels already have: previous/next page,
 * the page box + go, the outline, the search box + its result list, the zoom buttons. (The panel folds are the
 * Reader's `set_panel`; copy, copy-link and download are the browser's user-gesture boundary and stay the user's.)
 */
export const PdfViewActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto_page"), docId: Id, pageIndex: Count }).strict(),
  z.object({ action: z.literal("next_page"), docId: Id }).strict(),
  z.object({ action: z.literal("previous_page"), docId: Id }).strict(),
  z.object({ action: z.literal("open_outline_item"), docId: Id, outlineId: Id }).strict(),
  z
    .object({ action: z.literal("search"), docId: Id, query: z.string().trim().min(1).max(500) })
    .strict(),
  z.object({ action: z.literal("open_search_result"), docId: Id, index: Count }).strict(),
  /** The annotations panel's "go to" / the `#ann-<id>` link: the page (and the panel entry) of one workbench annotation. */
  z.object({ action: z.literal("open_annotation"), docId: Id, annotationId: Id }).strict(),
  z
    .object({
      action: z.literal("zoom"),
      docId: Id,
      mode: z.enum(["in", "out", "fit_width", "fit_page"]),
    })
    .strict(),
]);
export type PdfViewAction = z.infer<typeof PdfViewActionSchema>;
export const PDF_VIEW_ACTIONS = [
  "goto_page",
  "next_page",
  "previous_page",
  "open_outline_item",
  "search",
  "open_search_result",
  "open_annotation",
  "zoom",
] as const;
