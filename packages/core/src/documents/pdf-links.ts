/**
 * Pure parts of bibgraph/pdf_links.py: link-annotation types, fractional-rect
 * geometry, and URI / named-destination classification.
 *
 * The PyMuPDF-backed extraction itself (`extract_links`, `has_text_layer`) is infra
 * and lands in packages/infra (M2); everything here is pure logic shared by the
 * citation/cross-reference resolvers.
 *
 * All rectangles are fractional page coordinates (x in [0,1] left->right, y in [0,1]
 * top->bottom) so they compare directly with MinerU bboxes (0..1000 grid).
 */

export const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/iu;
export const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/iu;

/** Fractional rect `[x0, y0, x1, y1]` in [0,1] page coordinates. */
export type FracRect = readonly [number, number, number, number];

/** One PDF hyperlink annotation (GoTo / URI), aligned to MinerU's page model. */
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

/** All link annotations harvested from one PDF. */
export interface PdfLinks {
  nPages: number;
  /** (w, h) in points per page. */
  pageSizes: Array<readonly [number, number]>;
  links: LinkAnnot[];
  hasText: boolean;
}

export function linksOnPage(pdfLinks: PdfLinks, pageIdx: number): LinkAnnot[] {
  return pdfLinks.links.filter((l) => l.pageIdx === pageIdx);
}

// --------------------------------------------------------------------------- //
// Geometry helpers (fractional rects)
// --------------------------------------------------------------------------- //

export function rectIntersectionArea(a: FracRect, b: FracRect): number {
  const ix0 = Math.max(a[0], b[0]);
  const iy0 = Math.max(a[1], b[1]);
  const ix1 = Math.min(a[2], b[2]);
  const iy1 = Math.min(a[3], b[3]);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  return (ix1 - ix0) * (iy1 - iy0);
}

export function rectArea(a: FracRect): number {
  return Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
}

/** Fraction of `small` that lies inside `big` (0..1). */
export function overlapFraction(small: FracRect, big: FracRect): number {
  const s = rectArea(small);
  if (s <= 0) return 0;
  return rectIntersectionArea(small, big) / s;
}

export function pointInRect(pt: readonly [number, number], r: FracRect, pad = 0): boolean {
  const [x, y] = pt;
  return r[0] - pad <= x && x <= r[2] + pad && r[1] - pad <= y && y <= r[3] + pad;
}

/** Convert a MinerU bbox (normalized 0..1000) to a fractional [0,1] rect. */
export function bbox1000ToFrac(bbox: readonly number[] | null | undefined): FracRect | undefined {
  if (!bbox || bbox.length < 4) return undefined;
  const [x0, y0, x1, y1] = bbox;
  if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
    return undefined;
  }
  return [x0 / 1000, y0 / 1000, x1 / 1000, y1 / 1000];
}

// --------------------------------------------------------------------------- //
// URI / destination classification
// --------------------------------------------------------------------------- //

/** Extract a DOI and/or arXiv id from a link URI. */
export function parseUri(uri: string): { doi?: string; arxivId?: string } {
  const am = ARXIV_RE.exec(uri);
  const dm = DOI_RE.exec(uri);
  return {
    doi: dm ? rstripPunct(dm[0]) : undefined,
    arxivId: am?.[1],
  };
}

/** Python `s.rstrip(").,;")`. */
function rstripPunct(s: string): string {
  return s.replace(/[).,;]+$/u, "");
}

/** Map a hyperref named destination to a semantic kind, else undefined. */
export function classifyDest(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const head = (name.split(".")[0] ?? "").split(":")[0]?.toLowerCase() ?? "";
  if (head === "cite") return "cite";
  if (
    head === "section" ||
    head === "subsection" ||
    head === "subsubsection" ||
    head === "appendix" ||
    head === "part" ||
    head === "chapter" ||
    head === "paragraph"
  ) {
    return "section";
  }
  if (head === "figure" || head === "fig") return "figure";
  if (head === "table" || head === "tab") return "table";
  if (head === "equation" || head === "eq") return "equation";
  if (head === "algorithm" || head === "algo" || head === "alg") return "algorithm";
  if (head === "lstlisting" || head === "listing" || head === "code") return "code";
  return undefined; // Doc-Start, Hfootnote, page.N, Navigation, ...
}
