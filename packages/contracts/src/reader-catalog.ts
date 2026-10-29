/**
 * Reading and annotation entries of the operation catalog (release-0.2 ticket 07; ADR 0015).
 *
 * Domain `reader` is the Copilot `reader` tool. Its read actions (the whole reading of a Doc, a picture of a figure, a
 * page image) and its LaTeX/text and PDF annotation writes are cataloged; the Reader's view actions (navigate,
 * set_panel, zoom, goto_page, search, download_original ...) and the PDF undo/redo (a history that lives in one
 * Copilot conversation) are not. The writes are placed in the CLI group `annotation` (`cli`), the reads stay in the
 * group `reader`. Parameters are the action schemas of `reader-ops.ts` / `pdf-annotation-ops.ts` without `action`; a
 * refined schema (the PDF create and update) has an explicit params schema there that the action schema shares.
 *
 * The result of each entry is the object the Copilot tool returns (`ok`, `status`, `detail` ...), described loosely
 * here: the data a reading carries (entries, pages, annotations) has its own schemas in `reader-ops.ts` / `pdf-ops.ts`.
 * The picture reads add one field for the CLI: `data`, the picture as base64, which the Copilot tool delivers as an
 * image part instead.
 */
import { z } from "zod";
import { defineOperation } from "./operation-def.js";
import {
  PdfCreateAnnotationParamsSchema,
  PdfDeleteAnnotationOperationSchema,
  PdfUpdateAnnotationParamsSchema,
} from "./pdf-annotation-ops.js";
import {
  ReaderCreateAnnotationSchema,
  ReaderDeleteAnnotationSchema,
  ReaderReadImageOperationSchema,
  ReaderReadOperationSchema,
  ReaderReadPageImageOperationSchema,
  ReaderReadSvgImageOperationSchema,
  ReaderUpdateAnnotationSchema,
} from "./reader-ops.js";

/** A refusal that is part of the answer: nothing was read or written. */
const Failure = z
  .object({ ok: z.literal(false), status: z.string(), detail: z.string() })
  .passthrough();

/** What `reader.read` answers: the reading (LaTeX/text or PDF) with its batch descriptor, or a refusal. */
export const ReaderReadResultSchema = z.union([
  z.object({ ok: z.literal(true), status: z.literal("ok"), observed: z.string() }).passthrough(),
  Failure,
]);

/** A picture read: the picture's facts and its bytes as base64 (`data`); or a refusal. */
export const ReaderImageResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.literal("ok"),
      observed: z.string(),
      sha256: z.string(),
      data: z.string(),
    })
    .passthrough(),
  Failure,
]);

/** What an annotation write answers: saved/unchanged with the new epoch, or a refusal that wrote nothing. */
export const AnnotationWriteResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),
      status: z.enum(["ok", "noop"]),
      epoch: z.object({ annotationsRev: z.number().int().nonnegative() }).passthrough(),
    })
    .passthrough(),
  z.object({ ok: z.literal(false), status: z.string(), detail: z.string() }).passthrough(),
]);

export const READER_READ_OPERATION = defineOperation({
  domain: "reader",
  name: "read",
  summary:
    "Read a whole Doc from disk without opening it: the reading of a LaTeX/text Doc or the pages of a PDF Doc, with the content fingerprint (or SHA-256) and annotation revision that annotation writes are planned against",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: ReaderReadOperationSchema.omit({ action: true }),
  result: ReaderReadResultSchema,
});

export const READER_READ_IMAGE_OPERATION = defineOperation({
  domain: "reader",
  name: "read_image",
  summary:
    "Read one picture of a LaTeX/text Doc (PNG, JPEG or WebP; path and sha256 from the reading) as base64",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: ReaderReadImageOperationSchema.omit({ action: true }),
  result: ReaderImageResultSchema,
});

export const READER_READ_SVG_IMAGE_OPERATION = defineOperation({
  domain: "reader",
  name: "read_svg_image",
  summary:
    "Render one SVG figure of a LaTeX/text Doc to a bounded PNG (path and sha256 from the reading) as base64; nothing is stored",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: ReaderReadSvgImageOperationSchema.omit({ action: true }),
  result: ReaderImageResultSchema,
});

export const READER_READ_PAGE_IMAGE_OPERATION = defineOperation({
  domain: "reader",
  name: "read_page_image",
  summary:
    "Read one original page of a PDF Doc as a PNG (zero-based pageIndex, sha256 from the reading) as base64",
  effect: "read",
  confirm: "none",
  navigates: false,
  params: ReaderReadPageImageOperationSchema.omit({ action: true }),
  result: ReaderImageResultSchema,
});

export const READER_CREATE_ANNOTATION_OPERATION = defineOperation({
  domain: "reader",
  name: "create_annotation",
  summary:
    "Add an annotation to a LaTeX/text Doc (target document, structure or text; fingerprint and rev from the reading)",
  effect: "write",
  confirm: "none",
  navigates: false,
  cli: { group: "annotation", name: "create" },
  params: ReaderCreateAnnotationSchema.omit({ action: true }),
  result: AnnotationWriteResultSchema,
});

export const READER_UPDATE_ANNOTATION_OPERATION = defineOperation({
  domain: "reader",
  name: "update_annotation",
  summary:
    "Change the body of an annotation of a LaTeX/text Doc (expectedUpdatedAt from the reading; the target never changes)",
  effect: "write",
  confirm: "none",
  navigates: false,
  cli: { group: "annotation", name: "update" },
  params: ReaderUpdateAnnotationSchema.omit({ action: true }),
  result: AnnotationWriteResultSchema,
});

export const READER_DELETE_ANNOTATION_OPERATION = defineOperation({
  domain: "reader",
  name: "delete_annotation",
  summary:
    "Delete one annotation of a LaTeX/text Doc at once, as the trash button does (expectedUpdatedAt from the reading)",
  effect: "write",
  confirm: "none",
  navigates: false,
  cli: { group: "annotation", name: "delete" },
  params: ReaderDeleteAnnotationSchema.omit({ action: true }),
  result: AnnotationWriteResultSchema,
});

export const READER_CREATE_PDF_ANNOTATION_OPERATION = defineOperation({
  domain: "reader",
  name: "create_pdf_annotation",
  summary:
    "Add a workbench annotation to a PDF Doc (rectangle, page comment, document comment, or highlight/underline/strikeout of real text; sha256 and rev from the reading); the PDF is never changed",
  effect: "write",
  confirm: "none",
  navigates: false,
  cli: { group: "annotation", name: "create-pdf" },
  params: PdfCreateAnnotationParamsSchema,
  result: AnnotationWriteResultSchema,
});

export const READER_UPDATE_PDF_ANNOTATION_OPERATION = defineOperation({
  domain: "reader",
  name: "update_pdf_annotation",
  summary:
    "Change the body, rectangle, style or highlight colour of a PDF workbench annotation (expectedUpdatedAt from the reading)",
  effect: "write",
  confirm: "none",
  navigates: false,
  cli: { group: "annotation", name: "update-pdf" },
  params: PdfUpdateAnnotationParamsSchema,
  result: AnnotationWriteResultSchema,
});

export const READER_DELETE_PDF_ANNOTATION_OPERATION = defineOperation({
  domain: "reader",
  name: "delete_pdf_annotation",
  summary:
    "Delete one PDF workbench annotation at once, as the trash button does (expectedUpdatedAt from the reading)",
  effect: "write",
  confirm: "none",
  navigates: false,
  cli: { group: "annotation", name: "delete-pdf" },
  params: PdfDeleteAnnotationOperationSchema.omit({ action: true }),
  result: AnnotationWriteResultSchema,
});
