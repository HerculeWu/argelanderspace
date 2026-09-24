import { describe, expect, test } from "vitest";
import { PdfAnnotationSchema } from "@argelanderspace/contracts";
import { buildPdfTextTarget, pdfPageRectFromVisible, pdfPageRectToVisible, pdfSelectionQuote } from "../src/doc/pdf-text-target";

describe("buildPdfTextTarget", () => {
  test("joins actual PDF page slices with a line break, not literal backslash text", () => {
    expect(pdfSelectionQuote(["first page", "rotated page"])).toBe("first page\nrotated page");
  });

  test("maps rotation-270 SDK coordinates into visible-page coordinates and back without drift", () => {
    const sdkRect = { x: 0.05, y: 0.08, width: 0.24, height: 0.04 };
    const visible = pdfPageRectToVisible(sdkRect, 270);
    expect(visible).toEqual({ x: 0.08, y: 0.71, width: 0.04, height: 0.24 });
    const restored = pdfPageRectFromVisible(visible, 270);
    expect(restored.x).toBeCloseTo(sdkRect.x);
    expect(restored.y).toBeCloseTo(sdkRect.y);
    expect(restored.width).toBeCloseTo(sdkRect.width);
    expect(restored.height).toBeCloseTo(sdkRect.height);
  });

  test("builds a rotated page fragment in visible-page coordinates", () => {
    const target = buildPdfTextTarget(["rotated text"], [{ pageIndex: 0, segmentRects: [{ origin: { x: 30, y: 40 }, size: { width: 60, height: 8 } }] }], [{ width: 300, height: 400, rotation: 270 }]);
    expect(target?.fragments).toEqual([{ page_index: 0, rectangles: [{ x: 0.1, y: 0.7, width: 0.02, height: 0.2 }] }]);
  });

  test("persists one text snapshot with precise normalized rectangles grouped across heterogeneous pages", () => {
    const target = buildPdfTextTarget(["across ", "pages"], [
      { pageIndex: 0, segmentRects: [{ origin: { x: 10, y: 20 }, size: { width: 20, height: 8 } }] },
      { pageIndex: 1, segmentRects: [{ origin: { x: 30, y: 40 }, size: { width: 15, height: 10 } }] },
    ], [{ width: 100, height: 200 }, { width: 300, height: 400 }]);
    expect(target).toEqual({
      quote: "across \npages",
      fragments: [
        { page_index: 0, rectangles: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.04 }] },
        { page_index: 1, rectangles: [{ x: 0.1, y: 0.1, width: 0.05, height: 0.025 }] },
      ],
    });
    expect(PdfAnnotationSchema.safeParse({ id: "stable", kind: "highlight", target, body: "Research note", created_at: "2026-09-24T12:00:00.000Z", updated_at: "2026-09-24T12:00:00.000Z" }).success).toBe(true);
  });

  test("rejects a fragment if any SDK geometry rectangle is invalid instead of silently narrowing the target", () => {
    const valid = { origin: { x: 1, y: 1 }, size: { width: 2, height: 2 } };
    const invalid = { origin: { x: 9, y: 1 }, size: { width: 2, height: 2 } };
    expect(buildPdfTextTarget(["selected text"], [{ pageIndex: 0, segmentRects: [valid, invalid] }], [{ width: 10, height: 10 }])).toBeNull();
  });

  test("rejects missing text, empty rectangles, invalid page geometry, and out-of-page geometry", () => {
    expect(buildPdfTextTarget(["  "], [{ pageIndex: 0, segmentRects: [{ origin: { x: 1, y: 1 }, size: { width: 2, height: 2 } }] }], [{ width: 10, height: 10 }])).toBeNull();
    expect(buildPdfTextTarget(["real text"], [{ pageIndex: 0, segmentRects: [] }], [{ width: 10, height: 10 }])).toBeNull();
    expect(buildPdfTextTarget(["real text"], [{ pageIndex: 0, segmentRects: [{ origin: { x: 9, y: 1 }, size: { width: 2, height: 2 } }] }], [{ width: 10, height: 10 }])).toBeNull();
    expect(buildPdfTextTarget(["real text"], [{ pageIndex: 0, segmentRects: [{ origin: { x: 1, y: 1 }, size: { width: 2, height: 2 } }] }], [{ width: 0, height: 10 }])).toBeNull();
  });
});
