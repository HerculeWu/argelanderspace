"""Parse MinerU ``ref_text`` blocks into structured :class:`Reference` entries.

Reference strings are wildly inconsistent across publishers, so extraction is
deliberately best-effort and layered: the fields we can get *reliably* (raw
text, DOI, arXiv id, URL, year, author surnames, numbered label) are always
populated; title / venue / volume / pages are heuristic and frequently left
``None``. The reliable fields are exactly what the in-text citation matcher
needs (numbered label, or first-author surname + year).
"""

from __future__ import annotations

import re
from typing import Any

from ..pdf_links import ARXIV_RE, DOI_RE
from ..schema import Reference

_ARXIV_ID_RE = re.compile(
    r"arxiv\s*:?\s*(\d{4}\.\d{4,5}|[a-z\-]+(?:\.[A-Z]{2})?/\d{7})", re.I)
URL_RE = re.compile(r"https?://[^\s,);]+", re.I)
YEAR_RE = re.compile(r"\b(1[89]\d{2}|20\d{2})\b")
YEAR_PAREN_RE = re.compile(r"\((1[89]\d{2}|20\d{2})[a-z]?\)")
QUOTED_RE = re.compile(r"[\"“]([^\"”]{6,})[\"”]")
VOLUME_RE = re.compile(r",\s*(?:vol\.?\s*)?(\d{1,4})\s*[,:]")

# Numbered-entry markers. Bracket/paren forms may appear mid-line (MinerU often
# merges the whole bibliography into one block); the bare "n." form is only
# trusted at line starts to avoid splitting on sentence-final numbers.
LEADING_MARK_RE = re.compile(
    r"^\s*(?:\[(\d{1,3})\]|\((\d{1,3})\)|(\d{1,3})[.)])\s+")
BRACKET_MARK_RE = re.compile(r"(?:\A|(?<=\s))\[(\d{1,3})\]\s+")
PAREN_MARK_RE = re.compile(r"(?:\A|(?<=\s))\((\d{1,3})\)\s+")
DOT_MARK_RE = re.compile(r"(?m)^\s*(\d{1,3})[.)]\s+")


def parse_references(ref_items: list[dict[str, Any]]) -> list[Reference]:
    items = []
    for it in ref_items:
        t = it.get("text")
        if isinstance(t, list):
            t = " ".join(str(x) for x in t)
        t = (t or "").strip()
        if t:
            items.append((t, it.get("page_idx"), _bbox(it)))
    entries = _split_entries(items)
    refs: list[Reference] = []
    for i, (label, raw, page, bbox) in enumerate(entries, start=1):
        ref = _parse_one(f"ref-{i}", raw, label)
        ref.src_page = page
        ref.src_bbox = bbox
        refs.append(ref)
    return refs


def _bbox(item: dict[str, Any]) -> list[float] | None:
    b = item.get("bbox")
    if isinstance(b, list) and len(b) >= 4:
        try:
            return [float(x) for x in b[:4]]
        except (ValueError, TypeError):
            return None
    return None


def _clean_doi(s: str) -> str:
    s = s.rstrip(".,;")
    if s.endswith(")") and "(" not in s:    # trailing sentence paren, not DOI syntax
        s = s[:-1]
    return s


def _split_entries(
    items: list[tuple[str, Any, Any]],
) -> list[tuple[str | None, str, Any, Any]]:
    """Return ``[(label, raw_entry, page, bbox), ...]``.

    Numbered bibliographies (possibly merged into few MinerU blocks) are split
    on their ``[n]`` / ``n.`` markers; for those the per-entry source bbox is
    unknown, so page/bbox are ``None`` (numbered citations resolve by label).
    Author-year bibliographies keep one entry per MinerU block, retaining that
    block's page/bbox for GoTo-hyperlink resolution.
    """
    combined = "\n".join(t for t, _, _ in items)
    for rx in (BRACKET_MARK_RE, PAREN_MARK_RE, DOT_MARK_RE):
        markers = list(rx.finditer(combined))
        if len(markers) >= 2:
            entries: list[tuple[str | None, str, Any, Any]] = []
            for j, m in enumerate(markers):
                label = next((g for g in m.groups() if g), None)
                start = m.end()
                end = markers[j + 1].start() if j + 1 < len(markers) else len(combined)
                body = re.sub(r"\s{2,}", " ",
                              combined[start:end].replace("\n", " ")).strip()
                if body:
                    entries.append((label, body, None, None))
            return entries
    # Author-year (or unknown): one entry per MinerU ref_text block, keeping
    # that block's source page/bbox for GoTo-hyperlink resolution.
    out: list[tuple[str | None, str, Any, Any]] = []
    for t, page, bbox in items:
        m = LEADING_MARK_RE.match(t)
        label = None
        if m:
            label = next((g for g in m.groups() if g), None)
            t = t[m.end():]
        body = re.sub(r"\s{2,}", " ", t.replace("\n", " ")).strip()
        if body:
            out.append((label, body, page, bbox))
    return out


def _parse_one(ref_id: str, raw: str, label: str | None) -> Reference:
    doi = None
    m = DOI_RE.search(raw)
    if m:
        doi = _clean_doi(m.group(0))

    arxiv = None
    m = _ARXIV_ID_RE.search(raw) or ARXIV_RE.search(raw)
    if m:
        arxiv = m.group(1)

    url = None
    m = URL_RE.search(raw)
    if m:
        url = m.group(0).rstrip(").,;")

    # year: prefer a parenthesized year; else the first year for author-year
    # styles ("Authors YEAR, ...") and the last for numbered styles (year trails).
    year = None
    mp = YEAR_PAREN_RE.search(raw)
    if mp:
        year = int(mp.group(1))
    else:
        ys = YEAR_RE.findall(raw)
        if ys:
            year = int(ys[-1] if label else ys[0])

    authors = _parse_authors(raw, year)

    title = None
    m = QUOTED_RE.search(raw)
    if m:
        title = m.group(1).strip().strip(",.;: ")

    volume = None
    m = VOLUME_RE.search(raw)
    if m:
        volume = m.group(1)

    keys = _match_keys(authors, year, label)

    return Reference(id=ref_id, raw=raw, label=label, authors=authors,
                     year=year, title=title, volume=volume, doi=doi,
                     arxiv_id=arxiv, url=url, keys=keys)


def _parse_authors(raw: str, year: int | None) -> list[str]:
    """Best-effort list of author *surnames* (used for citation matching)."""
    region = raw
    if year is not None:
        idx = raw.find(str(year))
        if idx > 5:                                   # year near start isn't the boundary
            region = raw[:idx]
    region = re.split(r"[\"“]", region)[0]            # stop at a title quote
    region = re.sub(r"\([^)]*\)", " ", region)        # remove parenthetical affiliations
    region = re.sub(r"\([^)]*$", "", region)          # and any dangling unclosed '('
    region = region.strip(" ,.;")
    if not region:
        return []
    region = re.sub(r"\bet\s+al\.?", "", region, flags=re.I)
    # Split on commas AND and/&/; so both styles are handled uniformly:
    #   A&A   : "Hunt, E. L. & Reffert, S."   -> Hunt | E. L. | Reffert | S.
    #   MNRAS : "Banik I., Zhao H., Famaey B."-> Banik I. | Zhao H. | Famaey B.
    chunks = re.split(r"\s*(?:,|;|&|\band\b)\s*", region)
    surnames: list[str] = []
    for ch in chunks:
        ch = ch.strip(" .")
        if not ch:
            continue
        # a chunk that is only initials belongs to the previous author (A&A style)
        if re.fullmatch(r"(?:[A-Z]\.?\s*){1,4}", ch + " "):
            continue
        words = ch.split()
        # strip trailing / leading single-capital initials ("Banik I." / "I. Banik")
        while len(words) > 1 and re.fullmatch(r"[A-Z]\.?", words[-1]):
            words.pop()
        while len(words) > 1 and re.fullmatch(r"[A-Z]\.?", words[0]):
            words.pop(0)
        surname = " ".join(words).strip(" .")
        if surname and not re.fullmatch(r"[A-Za-z]\.?", surname):
            surnames.append(surname)
    # de-dup while preserving order
    seen = set()
    uniq = []
    for s in surnames:
        if s.lower() not in seen:
            seen.add(s.lower())
            uniq.append(s)
    return uniq[:12]


def _match_keys(authors: list[str], year: int | None, label: str | None) -> list[str]:
    keys: list[str] = []
    if label:
        keys.append(f"[{label}]")
    if authors and year:
        a0 = authors[0]
        keys.append(f"{a0} {year}")
        keys.append(f"{a0} et al. {year}")
        if len(authors) >= 2:
            keys.append(f"{a0} & {authors[1]} {year}")
    return keys
