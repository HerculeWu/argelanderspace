import { describe, expect, it } from "vitest";
import {
  buildPdfTextTarget,
  PDF_ANNOTATION_ACTIONS,
  PdfAnnotationOperationSchema,
  pdfRectsWithinSlice,
  READER_OPERATION_ACTIONS,
} from "../src/index.js";

const SHA = "a".repeat(64);
const base = { docId: "pdf-1", sha256: SHA, rev: 2 };
const parse = (value: unknown) => PdfAnnotationOperationSchema.safeParse(value);

describe("PDF annotation operations", () => {
  it("are listed as reader tool actions", () => {
    for (const action of PDF_ANNOTATION_ACTIONS) expect(READER_OPERATION_ACTIONS).toContain(action);
  });

  it("accepts each kind of create with exactly its own fields", () => {
    expect(
      parse({
        ...base,
        action: "create_pdf_annotation",
        kind: "rectangle",
        pageIndex: 0,
        rectangle: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        style: { color: "#aabbcc", opacity: 0.5, line_width: 3 },
        body: "note",
      }).success
    ).toBe(true);
    expect(
      parse({
        ...base,
        action: "create_pdf_annotation",
        kind: "page_comment",
        pageIndex: 3,
        body: "b",
      }).success
    ).toBe(true);
    expect(
      parse({ ...base, action: "create_pdf_annotation", kind: "document_comment", body: "b" })
        .success
    ).toBe(true);
    expect(
      parse({
        ...base,
        action: "create_pdf_annotation",
        kind: "highlight",
        color: "#387bd1",
        parts: [
          { pageIndex: 0, quote: "x" },
          { pageIndex: 1, quote: "y", occurrence: 1 },
        ],
        body: "b",
      }).success
    ).toBe(true);
  });

  it("refuses fields that do not belong to the kind, and a missing anchor", () => {
    const create = { ...base, action: "create_pdf_annotation", body: "b" };
    // rectangles for text come from the text layer, never from the caller
    expect(
      parse({
        ...create,
        kind: "highlight",
        parts: [{ pageIndex: 0, quote: "x" }],
        rectangle: { x: 0, y: 0, width: 0.5, height: 0.5 },
      }).success
    ).toBe(false);
    expect(parse({ ...create, kind: "highlight" }).success).toBe(false);
    expect(
      parse({
        ...create,
        kind: "underline",
        parts: [{ pageIndex: 0, quote: "x" }],
        color: "#387bd1",
      }).success
    ).toBe(false);
    expect(parse({ ...create, kind: "document_comment", pageIndex: 0 }).success).toBe(false);
    expect(parse({ ...create, kind: "page_comment" }).success).toBe(false);
    expect(
      parse({ ...create, kind: "page_comment", pageIndex: 0, style: { color: "#aabbcc" } }).success
    ).toBe(false);
    expect(parse({ ...create, kind: "rectangle", pageIndex: 0 }).success).toBe(false);
  });

  it("applies the area tool's own limits: a minimum size, inside the page, a blank body is refused", () => {
    const rect = (rectangle: object) =>
      parse({
        ...base,
        action: "create_pdf_annotation",
        kind: "rectangle",
        pageIndex: 0,
        rectangle,
        body: "b",
      }).success;
    expect(rect({ x: 0, y: 0, width: 0.005, height: 0.5 })).toBe(false);
    expect(rect({ x: 0.9, y: 0, width: 0.2, height: 0.5 })).toBe(false);
    expect(rect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(
      parse({ ...base, action: "create_pdf_annotation", kind: "document_comment", body: "  \n" })
        .success
    ).toBe(false);
  });

  it("wants text parts in ascending page order, one per page", () => {
    const text = (parts: object[]) =>
      parse({ ...base, action: "create_pdf_annotation", kind: "strikeout", parts, body: "b" })
        .success;
    expect(
      text([
        { pageIndex: 1, quote: "a" },
        { pageIndex: 0, quote: "b" },
      ])
    ).toBe(false);
    expect(
      text([
        { pageIndex: 1, quote: "a" },
        { pageIndex: 1, quote: "b" },
      ])
    ).toBe(false);
    expect(
      text([
        { pageIndex: 1, quote: "a" },
        { pageIndex: 2, quote: "b" },
      ])
    ).toBe(true);
  });

  it("update needs something to change and the annotation's own state; delete and undo carry the epoch", () => {
    const at = "2026-10-05T10:00:00.000Z";
    expect(
      parse({
        ...base,
        action: "update_pdf_annotation",
        annotationId: "pann_1",
        expectedUpdatedAt: at,
      }).success
    ).toBe(false);
    expect(
      parse({ ...base, action: "update_pdf_annotation", annotationId: "pann_1", body: "n" }).success
    ).toBe(false);
    expect(
      parse({
        ...base,
        action: "update_pdf_annotation",
        annotationId: "pann_1",
        expectedUpdatedAt: at,
        color: "#40a25b",
      }).success
    ).toBe(true);
    expect(
      parse({
        ...base,
        action: "update_pdf_annotation",
        annotationId: "pann_1",
        expectedUpdatedAt: at,
        color: "#123456",
      }).success
    ).toBe(false);
    expect(
      parse({
        ...base,
        action: "delete_pdf_annotation",
        annotationId: "pann_1",
        expectedUpdatedAt: at,
      }).success
    ).toBe(true);
    expect(
      parse({ ...base, action: "delete_pdf_annotation", annotationId: "pann_1" }).success
    ).toBe(false);
    expect(parse({ ...base, action: "undo_pdf_annotation" }).success).toBe(true);
    expect(parse({ ...base, action: "redo_pdf_annotation", extra: 1 }).success).toBe(false);
    expect(parse({ action: "redo_pdf_annotation", docId: "pdf-1", rev: 0 }).success).toBe(false);
  });
});

describe("pdfRectsWithinSlice", () => {
  const glyph = (x: number, width = 10, flags = 0) => ({ x, y: 100, width, height: 12, flags });
  // "ab cd" on one run, a far-away run of two characters on the same line, then a second line
  const geo = {
    runs: [
      {
        charStart: 0,
        fontSize: 12,
        glyphs: [glyph(10), glyph(20), glyph(30, 5, 1), glyph(35), glyph(45)],
      },
      { charStart: 5, fontSize: 12, glyphs: [glyph(0, 0, 2), glyph(0, 0, 2)] },
      {
        charStart: 7,
        fontSize: 12,
        glyphs: [10, 20].map((x) => ({ x, y: 130, width: 10, height: 12, flags: 0 })),
      },
    ],
  };
  it("gives one rectangle per line of the character range and none for generated characters", () => {
    expect(pdfRectsWithinSlice(geo, 0, 4)).toEqual([
      { origin: { x: 10, y: 100 }, size: { width: 45, height: 12 } },
    ]);
    expect(pdfRectsWithinSlice(geo, 3, 8)).toEqual([
      { origin: { x: 35, y: 100 }, size: { width: 20, height: 12 } },
      { origin: { x: 10, y: 130 }, size: { width: 20, height: 12 } },
    ]);
    expect(pdfRectsWithinSlice(geo, 5, 6)).toEqual([]);
  });
  it("feeds buildPdfTextTarget the same way the Reader does", () => {
    const rects = pdfRectsWithinSlice(geo, 0, 1);
    const target = buildPdfTextTarget(
      ["ab"],
      [{ pageIndex: 0, segmentRects: rects }],
      [{ width: 200, height: 400, rotation: 0 }]
    );
    expect(target).toEqual({
      quote: "ab",
      fragments: [{ page_index: 0, rectangles: [{ x: 0.05, y: 0.25, width: 0.1, height: 0.03 }] }],
    });
  });
});
