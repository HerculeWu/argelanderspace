import type { PdfAnnotation } from "./pdf-doc.js";

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
      return {
        x: 1 - rect.x - rect.width,
        y: 1 - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      };
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
      return {
        x: 1 - rect.x - rect.width,
        y: 1 - rect.y - rect.height,
        width: rect.width,
        height: rect.height,
      };
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
      !Number.isInteger(pageIndex) ||
      pageIndex < 0 ||
      !page ||
      !Number.isFinite(page.width) ||
      !Number.isFinite(page.height) ||
      page.width <= 0 ||
      page.height <= 0 ||
      ![0, 90, 180, 270].includes(rotation) ||
      !segmentRects.length
    )
      return null;
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
      if (
        sdkRect.x < 0 ||
        sdkRect.y < 0 ||
        sdkRect.x + sdkRect.width > 1 + 1e-8 ||
        sdkRect.y + sdkRect.height > 1 + 1e-8
      )
        return null;
      const visibleRect = pdfPageRectToVisible(sdkRect, rotation);
      if (
        ![visibleRect.x, visibleRect.y, visibleRect.width, visibleRect.height].every(
          Number.isFinite
        )
      )
        return null;
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

// ---- Text geometry: character range -> page rectangles --------------------------------------------------- //
//
// The page's selection rectangles are computed from the engine's page geometry (its runs of glyphs), exactly as
// the Reader's selection layer does it (EmbedPDF plugin-selection 2.15.1, MIT, `rectsWithinSlice` and the helpers it
// merges with). The Reader runs it on the browser's copy of the geometry and the Copilot's text targets run it on
// the geometry the server's PDFium reads from the same verified original, so a highlight made by either has the
// same rectangles for the same characters. `tests/pdf-text-target.test.ts` in the web package compares this
// function with the plugin's own.

/** One glyph of the engine's page geometry (a character cell in page space; `flags` 2 is a generated character). */
export interface PdfGeometryGlyph {
  x: number;
  y: number;
  width: number;
  height: number;
  flags?: number;
}
/** A run of consecutive characters (`charStart` is the index of its first character in the page's text). */
export interface PdfGeometryRun {
  charStart: number;
  glyphs: PdfGeometryGlyph[];
  fontSize?: number;
  rect?: { x: number; y: number; width: number; height: number };
}
export interface PdfGeometryPage {
  runs: PdfGeometryRun[];
}
export type PdfPageRect = {
  origin: { x: number; y: number };
  size: { width: number; height: number };
};

interface TextRunRect {
  rect: PdfPageRect;
  charCount: number;
  fontSize: number | undefined;
}

const rectUnion = (a: PdfPageRect, b: PdfPageRect): PdfPageRect => {
  const left = Math.min(a.origin.x, b.origin.x);
  const top = Math.min(a.origin.y, b.origin.y);
  const right = Math.max(a.origin.x + a.size.width, b.origin.x + b.size.width);
  const bottom = Math.max(a.origin.y + a.size.height, b.origin.y + b.size.height);
  return { origin: { x: left, y: top }, size: { width: right - left, height: bottom - top } };
};
const rectIntersect = (a: PdfPageRect, b: PdfPageRect): PdfPageRect => {
  const left = Math.max(a.origin.x, b.origin.x);
  const top = Math.max(a.origin.y, b.origin.y);
  const right = Math.min(a.origin.x + a.size.width, b.origin.x + b.size.width);
  const bottom = Math.min(a.origin.y + a.size.height, b.origin.y + b.size.height);
  return {
    origin: { x: left, y: top },
    size: { width: Math.max(0, right - left), height: Math.max(0, bottom - top) },
  };
};
const rectIsEmpty = (r: PdfPageRect) => r.size.width <= 0 || r.size.height <= 0;
const verticalOverlap = (a: PdfPageRect, b: PdfPageRect): number => {
  if (rectIsEmpty(a) || rectIsEmpty(b)) return 0;
  const union = rectUnion(a, b);
  if (union.size.height === a.size.height || union.size.height === b.size.height) return 1;
  return rectIntersect(a, b).size.height / union.size.height;
};
function shouldMergeHorizontally(a: TextRunRect, b: TextRunRect): boolean {
  if (a.fontSize != null && b.fontSize != null && a.fontSize > 0 && b.fontSize > 0) {
    if (Math.max(a.fontSize, b.fontSize) / Math.min(a.fontSize, b.fontSize) > 1.5) return false;
  }
  if (verticalOverlap(a.rect, b.rect) < 0.8) return false;
  const averageWidth1 = a.rect.size.width / a.charCount;
  const averageWidth2 = b.rect.size.width / b.charCount;
  const left1 = a.rect.origin.x - averageWidth1;
  const right1 = a.rect.origin.x + a.rect.size.width + averageWidth1;
  const left2 = b.rect.origin.x - averageWidth2;
  const right2 = b.rect.origin.x + b.rect.size.width + averageWidth2;
  return left1 < right2 && right1 > left2;
}
function mergeAdjacentRects(runs: TextRunRect[]): PdfPageRect[] {
  const results: PdfPageRect[] = [];
  let previous: TextRunRect | null = null;
  let current: PdfPageRect | null = null;
  for (const run of runs) {
    if (previous && current) {
      if (shouldMergeHorizontally(previous, run)) current = rectUnion(current, run.rect);
      else {
        results.push(current);
        current = run.rect;
      }
    } else current = run.rect;
    previous = run;
  }
  if (current && !rectIsEmpty(current)) results.push(current);
  return results;
}

/** The index of the last character a page's geometry holds (-1 for none). */
export function pdfGeometryLastChar(geo: PdfGeometryPage): number {
  return geo.runs.reduce((last, run) => Math.max(last, run.charStart + run.glyphs.length - 1), -1);
}

/**
 * The selection rectangles of the characters `from..to` (inclusive indexes into the page's text) as the Reader's
 * selection layer draws them: runs split where the gap is large, then runs on the same line merged. Generated
 * characters (flags 2: the line breaks) have no rectangle.
 */
export function pdfRectsWithinSlice(geo: PdfGeometryPage, from: number, to: number): PdfPageRect[] {
  const textRuns: TextRunRect[] = [];
  for (const run of geo.runs) {
    const runStart = run.charStart;
    const runEnd = runStart + run.glyphs.length - 1;
    if (runEnd < from || runStart > to) continue;
    const startIndex = Math.max(from, runStart) - runStart;
    const endIndex = Math.min(to, runEnd) - runStart;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let charCount = 0;
    let widthSum = 0;
    let prevRight = -Infinity;
    const flush = () => {
      if (minX !== Infinity && charCount > 0)
        textRuns.push({
          rect: {
            origin: { x: minX, y: minY },
            size: { width: maxX - minX, height: maxY - minY },
          },
          charCount,
          fontSize: run.fontSize,
        });
      minX = Infinity;
      maxX = -Infinity;
      minY = Infinity;
      maxY = -Infinity;
      charCount = 0;
      widthSum = 0;
      prevRight = -Infinity;
    };
    for (let i = startIndex; i <= endIndex; i++) {
      const glyph = run.glyphs[i];
      if (!glyph || glyph.flags === 2) continue;
      if (charCount > 0 && prevRight > -Infinity) {
        const gap = Math.abs(glyph.x - prevRight);
        const averageWidth = widthSum / charCount;
        if (averageWidth > 0 && gap > 2.5 * averageWidth) flush();
      }
      minX = Math.min(minX, glyph.x);
      maxX = Math.max(maxX, glyph.x + glyph.width);
      minY = Math.min(minY, glyph.y);
      maxY = Math.max(maxY, glyph.y + glyph.height);
      charCount++;
      widthSum += glyph.width;
      prevRight = glyph.x + glyph.width;
    }
    flush();
  }
  return mergeAdjacentRects(textRuns);
}
