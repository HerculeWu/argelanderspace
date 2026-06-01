"""Detect cross-references (Fig./Table/Eq./Section/Appendix/Algorithm/Listing)
and resolve them to element ids.

Resolution uses a label index built from the structure tree (by kind + printed
number) and, when ``use_pdf_links`` is on, GoTo hyperlink targets that land on
a specific float. Detected-but-unresolved cross-references are still tokenized
with a typed placeholder, e.g. ``[[xref:figure-3?]]``.
"""

from __future__ import annotations

import re

from ..pdf_links import LinkAnnot, bbox_1000_to_frac, point_in_rect
from ..schema import CrossRefOccurrence, Document
from .annotate import Match

# kind -> (compiled regex). Each regex exposes group(1) = number/letter.
# Case-insensitive: running text uses both "Figure 3" and "figure 3".
_IC = re.IGNORECASE
_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("figure", re.compile(r"\b(?:Figs?\.?|Figures?)\s*(\d+[a-z]?)", _IC)),
    ("table", re.compile(r"\b(?:Tabs?\.?|Tables?)\s*(\d+[a-z]?)", _IC)),
    ("equation", re.compile(r"\b(?:Eqs?\.?|Eqns?\.?|Equations?)\s*\(?(\d+[a-z]?)\)?", _IC)),
    ("algorithm", re.compile(r"\b(?:Algs?\.?|Algorithms?)\s*(\d+[a-z]?)", _IC)),
    ("code", re.compile(r"\b(?:Listings?|Codes?)\s*(\d+[a-z]?)", _IC)),
    ("appendix", re.compile(r"\bAppendix\s*([A-Z]{1,2}\b|\d+)", _IC)),
    ("section", re.compile(r"(?:\bSect(?:s|ion|ions)?\.?|§)\s*(\d+(?:\.\d+)*)", _IC)),
]


class XrefIndex:
    """Map (kind, number) -> element id, plus point-based GoTo resolution."""

    def __init__(self, doc: Document):
        self.by_kind: dict[tuple[str, str], str] = {}
        self.boxes: list[tuple[str, int, tuple]] = []   # (id, page, frac_bbox)
        bucket = {"figure": "figure", "table": "table", "equation": "equation",
                  "algorithm": "algorithm", "code": "code"}
        for b in doc.iter_blocks():
            kind = bucket.get(b.type)
            if not kind:                 # only floats are valid xref targets
                continue
            if getattr(b, "number", None):
                self.by_kind.setdefault((kind, b.number.lower()), b.id)
            fb = bbox_1000_to_frac(getattr(b, "bbox", None))
            if fb is not None and b.page_idx is not None:
                self.boxes.append((b.id, b.page_idx, fb))
        for s in doc.iter_sections():
            if s.number:
                self.by_kind.setdefault(("section", s.number.lower()), s.id)
            # appendix headings like "Appendix A"
            m = re.match(r"\s*Appendix\s+([A-Za-z0-9]+)", s.heading_raw or "")
            if m:
                key = m.group(1).lower()
                self.by_kind.setdefault(("appendix", key), s.id)
                self.by_kind.setdefault(("section", key), s.id)
            sb = bbox_1000_to_frac(s.bbox)
            if sb is not None and s.page_idx is not None:
                self.boxes.append((s.id, s.page_idx, sb))

    def resolve(self, kind: str, number: str) -> str | None:
        num = number.lower()
        hit = self.by_kind.get((kind, num))
        if hit:
            return hit
        # subfigure "3a" -> figure "3"
        m = re.match(r"(\d+)[a-z]$", num)
        if m:
            return self.by_kind.get((kind, m.group(1)))
        return None

    def resolve_point(self, page: int | None, pt: tuple[float, float] | None
                      ) -> str | None:
        if page is None or pt is None:
            return None
        best = None
        best_d = 1e9
        for bid, bp, bb in self.boxes:
            if bp != page:
                continue
            if point_in_rect(pt, bb, pad=0.01):
                return bid
            cx, cy = (bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2
            d = ((cx - pt[0]) ** 2 + (cy - pt[1]) ** 2) ** 0.5
            if d < best_d:
                best_d, best = d, bid
        return best if best_d < 0.05 else None


def detect_crossrefs(text: str, index: XrefIndex) -> list[Match]:
    matches: list[Match] = []
    claimed: list[tuple[int, int]] = []

    def claim(s: int, e: int) -> bool:
        for cs, ce in claimed:
            if s < ce and cs < e:
                return False
        claimed.append((s, e))
        return True

    for kind, rx in _PATTERNS:
        for m in rx.finditer(text):
            number = m.group(1)
            if not number:
                continue
            if not claim(m.start(), m.end()):
                continue
            target = index.resolve(kind, number)
            occ = CrossRefOccurrence(
                kind=kind, raw=m.group(0), target_id=target,
                number=number, via="regex", resolved=target is not None)
            matches.append(Match(m.start(), m.end(), occ))
    return matches


def enrich_crossrefs_with_links(xref_matches: list[Match],
                                block_links: list[LinkAnnot],
                                index: XrefIndex) -> None:
    """Resolve unresolved cross-refs in a block via overlapping GoTo links."""
    goto_targets: list[str] = []
    for ln in block_links:
        if ln.kind == "goto" and ln.dest_kind != "cite":
            tid = index.resolve_point(ln.target_page, ln.target_point)
            if tid:
                goto_targets.append(tid)
    if not goto_targets:
        return
    used = 0
    for m in xref_matches:
        occ = m.occ
        if not isinstance(occ, CrossRefOccurrence):
            continue
        if occ.resolved and occ.target_id:
            if occ.target_id in goto_targets:
                occ.via = "hyperlink+regex"
            continue
        if used < len(goto_targets):
            occ.target_id = goto_targets[used]
            used += 1
            occ.resolved = True
            occ.via = "hyperlink"
