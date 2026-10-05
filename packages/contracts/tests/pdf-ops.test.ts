import { describe, expect, it } from "vitest";
import {
  buildPdfReading,
  imageTokens,
  PDF_IMAGE_LONG_EDGE,
  PDF_NO_IMAGE_NOTICE,
  PdfPageSchema,
  PdfReadingSchema,
  type PdfSourceMaterial,
  PdfViewActionSchema,
  pngSizeOfBase64,
  READER_OPERATION_ACTIONS,
  ReaderReadPageImageOperationSchema,
  ReaderViewActionSchema,
  summarizePdfPage,
} from "../src/index.js";

const SHA = "d".repeat(64);
const material = (): PdfSourceMaterial => ({
  docId: "pdf-1",
  title: "A Work",
  sha256: SHA,
  pageCount: 3,
  pages: [
    {
      pageIndex: 0,
      width: 360,
      height: 480,
      rotation: 0,
      hasTextLayer: true,
      text: "PAGE 1 UNIQUE",
    },
    { pageIndex: 1, width: 240, height: 400, rotation: 90, hasTextLayer: true, text: "page two" },
    { pageIndex: 2, width: 280, height: 280, rotation: 0, hasTextLayer: false, text: null },
  ],
  outline: [{ id: "pdf-outline-0", title: "One", level: 1, pageIndex: 0 }],
  outlineTruncated: false,
  annotations: [],
  annotationsRev: 3,
});
const page = (over: object = {}) => ({
  docId: "pdf-1",
  format: "pdf" as const,
  phase: "ready" as const,
  sha256: SHA,
  pageCount: 3,
  currentPage: 0,
  zoom: { mode: "fit_width" as const, percent: 100 },
  outline: [],
  outlineTruncated: false,
  search: null,
  selection: null,
  panels: { outlineCollapsed: false, annotationsCollapsed: false },
  ...over,
});

describe("the PDF reading", () => {
  it("counts text and image-only pages truthfully; a page with no text layer has no text, not an empty one", () => {
    const reading = buildPdfReading(material(), true);
    expect(PdfReadingSchema.safeParse(reading).success).toBe(true);
    expect(reading.coverage).toEqual({
      pages: 3,
      pagesWithText: 2,
      pagesWithoutText: 1,
      characters: 21,
    });
    expect(reading.imageOnlyPages).toEqual([2]);
    expect(reading.pages[2]).toMatchObject({ hasTextLayer: false, text: null });
    expect(reading.images.modelAcceptsImages).toBe(true);
    expect(reading.images.notice).toBeUndefined();
  });

  it("tells a model that cannot see that the image-only pages cannot be read; nothing to say when every page has text", () => {
    const blind = buildPdfReading(material(), false);
    expect(blind.images).toMatchObject({ modelAcceptsImages: false, notice: PDF_NO_IMAGE_NOTICE });
    expect(PDF_NO_IMAGE_NOTICE).toMatch(/do not guess/);
    const textOnly = material();
    textOnly.pages = textOnly.pages.slice(0, 2);
    expect(buildPdfReading(textOnly, false).images.notice).toBeUndefined();
  });
});

describe("the PDF page", () => {
  it("is valid with a selection of its own original and refuses another original or a Reader that is not ready", () => {
    const selection = { sha256: SHA, text: "x", firstPage: 0, lastPage: 0 };
    expect(PdfPageSchema.safeParse(page({ selection })).success).toBe(true);
    expect(
      PdfPageSchema.safeParse(page({ selection: { ...selection, sha256: "e".repeat(64) } })).success
    ).toBe(false);
    expect(PdfPageSchema.safeParse(page({ phase: "loading", selection })).success).toBe(false);
    expect(PdfPageSchema.safeParse(page({ currentPage: -1 })).success).toBe(false);
    expect(PdfPageSchema.safeParse({ ...page(), extra: 1 }).success).toBe(false);
  });

  it("summarises what the message carried, one-based nowhere", () => {
    const summary = summarizePdfPage(page({ currentPage: 2 }), {
      status: "ok",
      reading: buildPdfReading(material(), true),
    });
    expect(summary).toMatchObject({
      docId: "pdf-1",
      currentPage: 2,
      selection: false,
      material: { status: "ok", pages: 3, pagesWithText: 2, pagesWithoutText: 1 },
    });
    expect(summarizePdfPage(page(), { status: "changed", detail: "x" }).material).toMatchObject({
      status: "changed",
      pages: 0,
    });
  });
});

describe("the image cost rule", () => {
  it("is pixel based, and the size comes from the PNG header of a base64 image", () => {
    expect(imageTokens(1152, 1536)).toBe(2360);
    expect(imageTokens(1, 1)).toBe(1);
    const header = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12);
    header.writeUInt32BE(640, 16);
    header.writeUInt32BE(480, 20);
    expect(pngSizeOfBase64(header.toString("base64"))).toEqual({ width: 640, height: 480 });
    expect(pngSizeOfBase64("AAAA")).toBeNull();
    expect(pngSizeOfBase64(Buffer.alloc(40).toString("base64"))).toBeNull();
  });
});

describe("the PDF operations", () => {
  it("pages are zero-based non-negative integers and the resolution is controlled, never free", () => {
    const op = { action: "read_page_image", docId: "d", pageIndex: 0, sha256: SHA };
    expect(ReaderReadPageImageOperationSchema.safeParse(op).success).toBe(true);
    for (const bad of [
      { pageIndex: -1 },
      { pageIndex: 1.5 },
      { longEdge: PDF_IMAGE_LONG_EDGE.min - 1 },
      { longEdge: PDF_IMAGE_LONG_EDGE.max + 1 },
      { sha256: "XYZ" },
      { path: "/etc/passwd" },
    ])
      expect(ReaderReadPageImageOperationSchema.safeParse({ ...op, ...bad }).success).toBe(false);
    expect(ReaderReadPageImageOperationSchema.safeParse({ ...op, longEdge: 2048 }).success).toBe(
      true
    );
  });

  it("every control is a closed bound-view action and part of the Reader's action union", () => {
    const actions = [
      { action: "goto_page", docId: "d", pageIndex: 4 },
      { action: "next_page", docId: "d" },
      { action: "previous_page", docId: "d" },
      { action: "open_outline_item", docId: "d", outlineId: "pdf-outline-0" },
      { action: "search", docId: "d", query: " term " },
      { action: "open_search_result", docId: "d", index: 0 },
      { action: "open_annotation", docId: "d", annotationId: "pann_1" },
      { action: "zoom", docId: "d", mode: "fit_width" },
    ];
    for (const action of actions) {
      expect(PdfViewActionSchema.safeParse(action).success).toBe(true);
      expect(ReaderViewActionSchema.safeParse(action).success).toBe(true);
      expect(READER_OPERATION_ACTIONS).toContain(action.action);
    }
    expect(
      PdfViewActionSchema.parse({ action: "search", docId: "d", query: " term " })
    ).toMatchObject({ query: "term" });
    for (const bad of [
      { action: "goto_page", docId: "d", pageIndex: -1 },
      { action: "search", docId: "d", query: "  " },
      { action: "zoom", docId: "d", mode: "huge" },
      { action: "download", docId: "d" },
      { action: "copy_selection", docId: "d" },
      { action: "goto_page", docId: "d", pageIndex: 1, selector: "#x" },
    ])
      expect(ReaderViewActionSchema.safeParse(bad).success).toBe(false);
    expect(READER_OPERATION_ACTIONS).toContain("read_page_image");
  });
});
