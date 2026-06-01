"""Harvest hyperlink annotations from a born-digital PDF with PyMuPDF.

MinerU's OCR -> markdown conversion discards the PDF's embedded link
annotations (the GoTo / URI destinations that make "[12]" or "Fig. 3"
clickable). For born-digital PDFs those annotations are the *authoritative*
source for resolving in-text citations and cross references, so we read them
straight from the original file and later align them to MinerU's text blocks
by bounding-box overlap.

All rectangles are returned in **fractional page coordinates** (x in [0,1]
left->right, y in [0,1] top->bottom) so they can be compared directly with
MinerU bboxes (which are normalized to 0-1000 of the page).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import fitz  # PyMuPDF

log = logging.getLogger("bibgraph.pdf_links")

DOI_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
ARXIV_RE = re.compile(
    r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})", re.I)

Rect = tuple[float, float, float, float]


@dataclass
class LinkAnnot:
    page_idx: int
    rect: Rect                      # source rect, fractional [0,1]
    kind: str                       # "uri" | "goto" | "other"
    uri: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    target_page: int | None = None          # 0-based, for goto
    target_point: tuple[float, float] | None = None   # fractional (x,y)
    dest_name: str | None = None    # hyperref named destination, e.g. "cite.Smith21"
    dest_kind: str | None = None    # "cite" | "figure" | "table" | "equation"
    #                                 | "section" | "algorithm" | "code" | "goto"


@dataclass
class PdfLinks:
    n_pages: int
    page_sizes: list[tuple[float, float]] = field(default_factory=list)  # (w,h) pts
    links: list[LinkAnnot] = field(default_factory=list)
    has_text: bool = True

    def links_on_page(self, page_idx: int) -> list[LinkAnnot]:
        return [l for l in self.links if l.page_idx == page_idx]


# --------------------------------------------------------------------------- #
# Geometry helpers (fractional rects)
# --------------------------------------------------------------------------- #

def rect_intersection_area(a: Rect, b: Rect) -> float:
    ix0, iy0 = max(a[0], b[0]), max(a[1], b[1])
    ix1, iy1 = min(a[2], b[2]), min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    return (ix1 - ix0) * (iy1 - iy0)


def rect_area(a: Rect) -> float:
    return max(0.0, a[2] - a[0]) * max(0.0, a[3] - a[1])


def overlap_fraction(small: Rect, big: Rect) -> float:
    """Fraction of *small* that lies inside *big* (0..1)."""
    s = rect_area(small)
    if s <= 0:
        return 0.0
    return rect_intersection_area(small, big) / s


def point_in_rect(pt: tuple[float, float], r: Rect, pad: float = 0.0) -> bool:
    x, y = pt
    return (r[0] - pad) <= x <= (r[2] + pad) and (r[1] - pad) <= y <= (r[3] + pad)


def bbox_1000_to_frac(bbox: list[float] | None) -> Rect | None:
    """Convert a MinerU bbox (normalized 0..1000) to fractional [0,1]."""
    if not bbox or len(bbox) < 4:
        return None
    return (bbox[0] / 1000.0, bbox[1] / 1000.0, bbox[2] / 1000.0, bbox[3] / 1000.0)


# --------------------------------------------------------------------------- #
# Extraction
# --------------------------------------------------------------------------- #

def _parse_uri(uri: str) -> tuple[str | None, str | None]:
    doi = None
    arxiv = None
    m = ARXIV_RE.search(uri)
    if m:
        arxiv = m.group(1)
    m = DOI_RE.search(uri)
    if m:
        doi = m.group(0).rstrip(").,;")
    return doi, arxiv


def _classify_dest(name: str | None) -> str | None:
    """Map a hyperref named destination to a semantic kind."""
    if not name:
        return None
    head = name.split(".")[0].split(":")[0].lower()
    if head == "cite":
        return "cite"
    if head in ("section", "subsection", "subsubsection", "appendix",
                "part", "chapter", "paragraph"):
        return "section"
    if head in ("figure", "fig"):
        return "figure"
    if head in ("table", "tab"):
        return "table"
    if head in ("equation", "eq"):
        return "equation"
    if head in ("algorithm", "algo", "alg"):
        return "algorithm"
    if head in ("lstlisting", "listing", "code"):
        return "code"
    return None         # Doc-Start, Hfootnote, page.N, Navigation, ...


def extract_links(pdf_path: str | Path) -> PdfLinks:
    pdf_path = Path(pdf_path)
    doc = fitz.open(pdf_path)
    try:
        n_pages = doc.page_count
        names = doc.resolve_names() if hasattr(doc, "resolve_names") else {}
        page_sizes: list[tuple[float, float]] = []
        annots: list[LinkAnnot] = []
        text_chars = 0
        sampled = 0

        def _to_frac(tp, to):
            # PyMuPDF gives link source rects in top-left page coords, but a
            # GoTo/named *destination* point in raw PDF user space (bottom-left
            # origin). Flip y so it matches MinerU's top-left bboxes.
            if to is not None and tp is not None and 0 <= tp < n_pages:
                tw, th = doc[tp].rect.width, doc[tp].rect.height
                if tw > 0 and th > 0:
                    tx = to[0] if not hasattr(to, "x") else to.x
                    ty = to[1] if not hasattr(to, "y") else to.y
                    return (tx / tw, 1.0 - (ty / th))
            return None

        for pno in range(n_pages):
            page = doc[pno]
            w, h = page.rect.width, page.rect.height
            page_sizes.append((w, h))
            if w <= 0 or h <= 0:
                continue
            if sampled < 6:
                text_chars += len(page.get_text("text").strip())
                sampled += 1
            for ln in page.get_links():
                kind_int = ln.get("kind")
                src = ln.get("from")
                if src is None:
                    continue
                rect = (src.x0 / w, src.y0 / h, src.x1 / w, src.y1 / h)
                if kind_int == fitz.LINK_URI:
                    uri = ln.get("uri", "")
                    doi, arxiv = _parse_uri(uri)
                    annots.append(LinkAnnot(pno, rect, "uri", uri=uri,
                                            doi=doi, arxiv_id=arxiv))
                elif kind_int in (fitz.LINK_GOTO, fitz.LINK_NAMED):
                    name = ln.get("nameddest") or ln.get("name")
                    tp = ln.get("page")
                    to = ln.get("to")
                    # named destinations may need resolving via the names table
                    if (tp is None or to is None) and name and name in names:
                        nd = names[name]
                        tp = nd.get("page", tp)
                        to = nd.get("to", to)
                    annots.append(LinkAnnot(
                        pno, rect, "goto", target_page=tp,
                        target_point=_to_frac(tp, to),
                        dest_name=name,
                        dest_kind=_classify_dest(name)
                        if kind_int == fitz.LINK_NAMED else "goto"))
                else:
                    annots.append(LinkAnnot(pno, rect, "other"))
        has_text = (text_chars / max(1, sampled)) > 80
        log.info("PDF %s: %d pages, %d links, has_text=%s",
                 pdf_path.name, n_pages, len(annots), has_text)
        return PdfLinks(n_pages=n_pages, page_sizes=page_sizes,
                        links=annots, has_text=has_text)
    finally:
        doc.close()


def has_text_layer(pdf_path: str | Path) -> bool:
    """Cheap check: does the PDF carry an extractable text layer?"""
    doc = fitz.open(pdf_path)
    try:
        chars = 0
        n = min(doc.page_count, 6)
        for pno in range(n):
            chars += len(doc[pno].get_text("text").strip())
        return (chars / max(1, n)) > 80
    finally:
        doc.close()
