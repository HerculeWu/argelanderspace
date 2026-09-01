/**
 * Fractional-rect geometry and the link-annotation shape shared by the
 * citation/cross-reference resolvers (`documents/citations.ts`,
 * `documents/crossrefs.ts`).
 *
 * All rectangles are fractional page coordinates (x in [0,1] left->right, y in
 * [0,1] top->bottom). The hyperlink-enrichment halves of the resolvers are
 * dormant on main (no PDF link harvest — the OCR pipeline is archived on the
 * `ocr-features` branch), but stay exercised by the documents-domain tests.
 */

/** Fractional rect `[x0, y0, x1, y1]` in [0,1] page coordinates. */
export type FracRect = readonly [number, number, number, number];

/** One hyperlink annotation (GoTo / URI), aligned to a per-page model. */
export interface LinkAnnot {
  pageIdx: number;
  /** Source rect, fractional [0,1]. */
  rect: FracRect;
  kind: "uri" | "goto" | "other";
  uri?: string;
  doi?: string;
  arxivId?: string;
  /** 0-based target page, for goto. */
  targetPage?: number;
  /** Fractional (x, y) target point, top-left origin. */
  targetPoint?: readonly [number, number];
  /** hyperref named destination, e.g. "cite.Smith21". */
  destName?: string;
  /** "cite" | "figure" | "table" | "equation" | "section" | "algorithm" | "code" | "goto". */
  destKind?: string;
}

export function pointInRect(pt: readonly [number, number], r: FracRect, pad = 0): boolean {
  const [x, y] = pt;
  return r[0] - pad <= x && x <= r[2] + pad && r[1] - pad <= y && y <= r[3] + pad;
}

/** Convert a normalized 0..1000 bbox to a fractional [0,1] rect. */
export function bbox1000ToFrac(bbox: readonly number[] | null | undefined): FracRect | undefined {
  if (!bbox || bbox.length < 4) return undefined;
  const [x0, y0, x1, y1] = bbox;
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
    return undefined;
  }
  return [x0 / 1000, y0 / 1000, x1 / 1000, y1 / 1000];
}
