"""Detect in-text citations and link them to the reference list.

Two dominant styles are handled:

  * **author-year** — ``Hunt & Reffert (2021)`` (narrative) and
    ``(Cantat-Gaudin et al. 2020; Smith 2019)`` (parenthetical, possibly with
    extra years like ``Smith 2019, 2021``).
  * **numbered** — ``[12]``, ``[1, 2, 5]``, ``[1-3]`` (only when the parsed
    bibliography actually uses numeric labels).

Resolution is layered: regex matches are mapped to references by
``(surname, year)`` or numeric label; then, when ``use_pdf_links`` is on,
PDF hyperlink annotations overlapping the text block authoritatively resolve
matches the regex could not (and corroborate the rest).
"""

from __future__ import annotations

import re
from collections import defaultdict

from ..pdf_links import LinkAnnot, bbox_1000_to_frac, overlap_fraction, point_in_rect
from ..schema import CitationOccurrence, Reference
from .annotate import Match

# first char allows non-ASCII uppercase (Å, Ø, Ü, Ł, …) common in author names
_NAME = r"[A-ZÀ-ſ][A-Za-z'’À-ſ.\-]+"
# "Hunt & Reffert", "Cantat-Gaudin et al.", "Smith and Jones"
_AUTHORS = (rf"{_NAME}(?:\s+(?:&|and)\s+{_NAME})?(?:\s+et\s+al\.?)?")
_YEAR = r"\d{4}[a-z]?"
_EXTRA_YEARS = rf"(?:\s*,\s*{_YEAR})*"

NARRATIVE_RE = re.compile(rf"\b({_AUTHORS})\s*\(({_YEAR})({_EXTRA_YEARS})\)")
# any "(...)" that contains a 4-digit year
PAREN_RE = re.compile(r"\(([^()]*?(?:19|20)\d{2}[a-z]?[^()]*?)\)")
INNER_AY_RE = re.compile(rf"({_AUTHORS})\s+({_YEAR})({_EXTRA_YEARS})")
NUM_RE = re.compile(r"\[(\d{1,3}(?:\s*[,–\-]\s*\d{1,3})*)\]")
_SIGNAL_RE = re.compile(r"&|\band\b|\bet\s+al\b|;")


class ReferenceResolver:
    def __init__(self, references: list[Reference]):
        self.refs = references
        self.by_label = {r.label: r for r in references if r.label}
        self.by_doi = {r.doi.lower(): r for r in references if r.doi}
        self.by_arxiv = {r.arxiv_id.lower(): r for r in references if r.arxiv_id}
        self.ay: dict[tuple[str, int], list[Reference]] = defaultdict(list)
        self.ay_sur: dict[str, list[Reference]] = defaultdict(list)
        for r in references:
            if r.year and r.authors:
                sur = r.authors[0].lower()
                self.ay[(sur, r.year)].append(r)
                self.ay_sur[sur].append(r)
        self.numbered = bool(self.by_label)
        self.author_year = bool(self.ay)
        # bibliography entry boxes (fractional) for GoTo-hyperlink resolution
        self.boxes = [
            (r, r.src_page, bbox_1000_to_frac(r.src_bbox))
            for r in references
            if r.src_page is not None and r.src_bbox is not None
        ]

    def resolve_label(self, label: str) -> Reference | None:
        return self.by_label.get(label)

    def resolve_author_year(self, surname: str, year: int) -> Reference | None:
        rs = self.ay.get((surname.lower(), year))
        return rs[0] if rs else None

    def resolve_doi(self, doi: str) -> Reference | None:
        return self.by_doi.get(doi.lower())

    def resolve_arxiv(self, arxiv: str) -> Reference | None:
        return self.by_arxiv.get(arxiv.lower())

    def resolve_point(self, page: int | None, pt: tuple[float, float] | None
                      ) -> Reference | None:
        if page is None or pt is None:
            return None
        best = None
        best_d = 1e9
        for r, rp, rb in self.boxes:
            if rp != page or rb is None:
                continue
            if point_in_rect(pt, rb, pad=0.02):
                return r
            cx, cy = (rb[0] + rb[2]) / 2, (rb[1] + rb[3]) / 2
            d = ((cx - pt[0]) ** 2 + (cy - pt[1]) ** 2) ** 0.5
            if d < best_d:
                best_d, best = d, r
        return best if best_d < 0.05 else None


# --------------------------------------------------------------------------- #
# Detection
# --------------------------------------------------------------------------- #

def _expand_numbers(inner: str) -> list[str]:
    out: list[str] = []
    for part in inner.split(","):
        part = part.strip()
        m = re.fullmatch(r"(\d{1,3})\s*[–\-]\s*(\d{1,3})", part)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            if 0 < b - a < 100:
                out.extend(str(n) for n in range(a, b + 1))
                continue
        if part.isdigit():
            out.append(part)
    return out


def _first_surname(authors: str) -> str:
    authors = re.sub(r"\s+et\s+al\.?", "", authors, flags=re.I)
    first = re.split(r"\s+(?:&|and)\s+", authors)[0]
    first = first.split(",")[0]          # drop comma-separated initials
    return first.strip(" .,")


def detect_citations(text: str, resolver: ReferenceResolver) -> list[Match]:
    matches: list[Match] = []
    claimed: list[tuple[int, int]] = []

    def claim(s: int, e: int) -> bool:
        for cs, ce in claimed:
            if s < ce and cs < e:
                return False
        claimed.append((s, e))
        return True

    # 1) narrative author-year: "Hunt & Reffert (2021)"
    for m in NARRATIVE_RE.finditer(text):
        authors, year, extra = m.group(1), m.group(2), m.group(3)
        surname = _first_surname(authors)
        years = [year] + re.findall(_YEAR, extra or "")
        ref_ids, resolved_any = _resolve_years(resolver, surname, years)
        signal = bool(_SIGNAL_RE.search(authors))
        if not resolved_any and not signal:
            continue
        if not claim(m.start(), m.end()):
            continue
        occ = CitationOccurrence(ref_ids=ref_ids, raw=m.group(0),
                                 via="regex", resolved=bool(ref_ids))
        matches.append(Match(m.start(), m.end(), occ))

    # 2) parenthetical author-year: "(... 2020; ... 2019)"
    for pm in PAREN_RE.finditer(text):
        inner = pm.group(1)
        ref_ids: list[str] = []
        resolved_any = False
        signal = bool(_SIGNAL_RE.search(inner))
        n_inner = 0
        for im in INNER_AY_RE.finditer(inner):
            n_inner += 1
            surname = _first_surname(im.group(1))
            years = [im.group(2)] + re.findall(_YEAR, im.group(3) or "")
            ids, ok = _resolve_years(resolver, surname, years)
            ref_ids.extend(ids)
            resolved_any = resolved_any or ok
        if n_inner == 0:
            continue
        if not resolved_any and not signal and n_inner < 2:
            continue
        if not claim(pm.start(), pm.end()):
            continue
        ref_ids = _dedup(ref_ids)
        occ = CitationOccurrence(ref_ids=ref_ids, raw=pm.group(0),
                                 via="regex", resolved=bool(ref_ids))
        matches.append(Match(pm.start(), pm.end(), occ))

    # 3) numbered: "[1, 2, 5]" (only when the bibliography is numbered)
    if resolver.numbered:
        for nm in NUM_RE.finditer(text):
            nums = _expand_numbers(nm.group(1))
            if not nums:
                continue
            refs = [resolver.resolve_label(n) for n in nums]
            if not all(refs):           # avoid math intervals like [0,1]
                continue
            if not claim(nm.start(), nm.end()):
                continue
            ref_ids = _dedup([r.id for r in refs if r])
            occ = CitationOccurrence(ref_ids=ref_ids, raw=nm.group(0),
                                     via="regex", resolved=True)
            matches.append(Match(nm.start(), nm.end(), occ))

    return matches


def _resolve_years(resolver: ReferenceResolver, surname: str,
                   years: list[str]) -> tuple[list[str], bool]:
    ref_ids: list[str] = []
    resolved_any = False
    for y in years:
        yi = int(re.match(r"\d{4}", y).group(0))
        ref = resolver.resolve_author_year(surname, yi)
        if ref:
            ref_ids.append(ref.id)
            resolved_any = True
    return _dedup(ref_ids), resolved_any


def _dedup(xs: list[str]) -> list[str]:
    seen = set()
    out = []
    for x in xs:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


# --------------------------------------------------------------------------- #
# Hyperlink enrichment (block granularity)
# --------------------------------------------------------------------------- #

def link_targets(links: list[LinkAnnot], resolver: ReferenceResolver
                 ) -> list[Reference]:
    """References authoritatively pointed to by the given block's hyperlinks."""
    _XREF_DESTS = {"figure", "table", "equation", "section", "algorithm", "code"}
    found: list[Reference] = []
    for ln in links:
        ref = None
        if ln.kind == "uri":
            if ln.doi:
                ref = resolver.resolve_doi(ln.doi)
            if ref is None and ln.arxiv_id:
                ref = resolver.resolve_arxiv(ln.arxiv_id)
        elif ln.kind == "goto" and ln.dest_kind not in _XREF_DESTS:
            # cite.* / generic goto: spatial guard maps it to a bib entry (or None)
            ref = resolver.resolve_point(ln.target_page, ln.target_point)
        if ref is not None:
            found.append(ref)
    return _dedup_refs(found)


def enrich_citations_with_links(cite_matches: list[Match],
                                block_links: list[LinkAnnot],
                                resolver: ReferenceResolver) -> None:
    """Use a block's hyperlinks to resolve/corroborate its citation matches.

    Block granularity: links overlapping the *block* (not the exact citation
    glyphs) are paired with the block's citation sites in reading order. Used to
    fill in matches the regex left unresolved and to mark corroborated ones.
    """
    targets = link_targets(block_links, resolver)
    if not targets:
        return
    pool = list(targets)                 # remaining unconsumed link targets
    for m in cite_matches:
        occ = m.occ
        if not isinstance(occ, CitationOccurrence):
            continue
        if occ.resolved and occ.ref_ids:
            # corroborate, and CONSUME the matching target so it isn't reused
            for i, t in enumerate(pool):
                if t.id in occ.ref_ids:
                    occ.via = "hyperlink+regex"
                    pool.pop(i)
                    break
            continue
        if pool:                         # assign next unused link target
            t = pool.pop(0)
            occ.ref_ids = [t.id]
            occ.resolved = True
            occ.via = "hyperlink"
            occ.doi = t.doi
            occ.url = t.url


def _dedup_refs(refs: list[Reference]) -> list[Reference]:
    seen = set()
    out = []
    for r in refs:
        if r.id not in seen:
            seen.add(r.id)
            out.append(r)
    return out
