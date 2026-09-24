import type { PdfAnnotation } from "@argelanderspace/contracts";

type Geometry = { width: number; height: number; rotation?: number };
type PdfRect = { origin: { x: number; y: number }; size: { width: number; height: number } };
type NormalizedRect = { x: number; y: number; width: number; height: number };
type FormattedPage = { pageIndex: number; segmentRects: PdfRect[] };

export function pdfSelectionQuote(pageText: string[]): string {
  return pageText.join("\n");
}

/** Normalize a PDFium/EmbedPDF page-space rectangle into the visible rotated page. */
export function pdfPageRectToVisible(rect: NormalizedRect, rotation: number): NormalizedRect {
  switch (rotation) {
    case 0:
      return rect;
    case 90:
      return { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
    case 180:
      return { x: 1 - rect.x - rect.width, y: 1 - rect.y - rect.height, width: rect.width, height: rect.height };
    case 270:
      return { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width };
    default:
      return { x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN };
  }
}

/** Map a visible-page sidecar rectangle back into the page layer's pre-rotation CSS coordinate frame. */
export function pdfPageRectFromVisible(rect: NormalizedRect, rotation: number): NormalizedRect {
  switch (rotation) {
    case 0:
      return rect;
    case 90:
      return { x: rect.y, y: 1 - rect.x - rect.width, width: rect.height, height: rect.width };
    case 180:
      return { x: 1 - rect.x - rect.width, y: 1 - rect.y - rect.height, width: rect.width, height: rect.height };
    case 270:
      return { x: 1 - rect.y - rect.height, y: rect.x, width: rect.height, height: rect.width };
    default:
      return { x: Number.NaN, y: Number.NaN, width: Number.NaN, height: Number.NaN };
  }
}

/** Convert SDK page-space glyph rectangles to fixed, normalized visible-page space. */
export function buildPdfTextTarget(
  text: string[],
  selection: FormattedPage[],
  pages: Geometry[]
): Extract<PdfAnnotation, { kind: "highlight" }>["target"] | null {
  const quote = pdfSelectionQuote(text);
  if (!quote.trim() || !selection.length) return null;
  const fragments = [];
  for (const { pageIndex, segmentRects } of selection) {
    const page = pages[pageIndex];
    const rotation = page?.rotation ?? 0;
    if (
      !Number.isInteger(pageIndex) || pageIndex < 0 ||
      !page || !Number.isFinite(page.width) || !Number.isFinite(page.height) ||
      page.width <= 0 || page.height <= 0 || ![0, 90, 180, 270].includes(rotation) ||
      !segmentRects.length
    ) return null;
    const rectangles = [];
    for (const { origin, size } of segmentRects) {
      const values = [origin.x, origin.y, size.width, size.height];
      if (!values.every(Number.isFinite) || size.width <= 0 || size.height <= 0) return null;
      const sdkRect = {
        x: origin.x / page.width,
        y: origin.y / page.height,
        width: size.width / page.width,
        height: size.height / page.height,
      };
      if (sdkRect.x < 0 || sdkRect.y < 0 || sdkRect.x + sdkRect.width > 1 + 1e-8 || sdkRect.y + sdkRect.height > 1 + 1e-8) return null;
      const visibleRect = pdfPageRectToVisible(sdkRect, rotation);
      if (![visibleRect.x, visibleRect.y, visibleRect.width, visibleRect.height].every(Number.isFinite)) return null;
      rectangles.push({
        ...visibleRect,
        width: Math.min(visibleRect.width, 1 - visibleRect.x),
        height: Math.min(visibleRect.height, 1 - visibleRect.y),
      });
    }
    fragments.push({ page_index: pageIndex, rectangles });
  }
  return { quote, fragments };
}
