"""Parse a BibTeX file into normalized bibliographic records.

The acquisition layer consumes plain records, not LaTeX: author names are
de-accented to Unicode and reduced to family names (Zotero-style), titles lose
their brace-protection, and arXiv eprints / DOIs are normalized. We use
``bibtexparser`` for the grammar and layer astronomy-aware field handling on top
(``eprint``/``archivePrefix`` → arXiv id, ``journal = {arXiv e-prints}`` → no
real venue, brace-protected group authors like ``{Gaia Collaboration}`` kept
whole).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import bibtexparser
from bibtexparser.bparser import BibTexParser
from bibtexparser.latexenc import latex_to_unicode

from ..library.store import norm_arxiv, norm_doi

log = logging.getLogger("bibgraph.acquire.bibtex")

# Surname particles that stay attached to the family name ("van Leeuwen").
_PARTICLES = {"van", "von", "der", "den", "de", "del", "della", "di", "du",
              "da", "das", "dos", "la", "le", "ten", "ter", "vande"}
_ARXIV_BARE = re.compile(r"^\d{4}\.\d{4,5}(v\d+)?$")


@dataclass
class BibRecord:
    """One normalized ``.bib`` entry."""

    key: str                       # the cite key, e.g. "HR1"
    entry_type: str = "article"    # article | inproceedings | ...
    title: str = ""
    authors: list[str] = field(default_factory=list)  # family names, in order
    year: int | None = None
    journal: str | None = None     # None for arXiv-only preprints
    volume: str | None = None
    pages: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None

    @property
    def is_conf(self) -> bool:
        return self.entry_type in ("inproceedings", "conference", "proceedings")


# --------------------------------------------------------------------------- #
# Field cleaning
# --------------------------------------------------------------------------- #

def _clean_text(s: str) -> str:
    """LaTeX→unicode, de-brace, de-tilde and collapse whitespace in a bib field.

    We convert accents *here* (per field) rather than via a parser-wide
    ``convert_to_unicode`` customization, because that would strip the
    brace-protection around group authors (``{Gaia Collaboration}``) before we
    can detect them.
    """
    try:
        s = latex_to_unicode(s)
    except Exception:
        pass
    s = s.replace("~", " ")
    s = re.sub(r"[{}]", "", s)
    s = re.sub(r"\\[a-zA-Z]+", "", s)   # leftover control words (e.g. \degr)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _family(raw: str) -> str:
    """Extract the family name from one author token.

    ``"Hunt, E.~L."`` → ``"Hunt"``; ``"van Leeuwen, F."`` → ``"van Leeuwen"``;
    ``"{Gaia Collaboration}"`` → ``"Gaia Collaboration"`` (group author kept
    whole); ``"Pavel Kroupa"`` (no comma) → ``"Kroupa"`` with particles.
    """
    raw = raw.strip()
    # A fully brace-wrapped name is a protected group/corporate author.
    if raw.startswith("{") and raw.endswith("}") and raw[1:-1].count("{") == 0:
        return _clean_text(raw)
    s = _clean_text(raw)
    if not s:
        return ""
    if "," in s:                         # "Family, Given"
        return s.split(",", 1)[0].strip()
    toks = s.split(" ")                   # "Given M. Family"
    if len(toks) == 1:
        return toks[0]
    fam = [toks[-1]]
    i = len(toks) - 2
    while i >= 0 and toks[i].lower() in _PARTICLES:
        fam.insert(0, toks[i])
        i -= 1
    return " ".join(fam)


def _authors(field_value: str) -> list[str]:
    if not field_value:
        return []
    parts = re.split(r"\s+and\s+", field_value.strip())
    out = [_family(p) for p in parts if p.strip() and p.strip().lower() != "others"]
    return [a for a in out if a]


def _year(s: str | None) -> int | None:
    if not s:
        return None
    m = re.search(r"(\d{4})", s)
    return int(m.group(1)) if m else None


def _arxiv_from(entry: dict) -> str | None:
    """arXiv id from ``eprint`` (+ ``archivePrefix``/``primaryClass``)."""
    ep = (entry.get("eprint") or "").strip()
    if not ep:
        return None
    prefix = (entry.get("archiveprefix") or "").strip().lower()
    # accept when explicitly arXiv, or the eprint simply looks like an arXiv id
    if prefix in ("arxiv", "") and (_ARXIV_BARE.match(ep) or "/" in ep):
        return norm_arxiv(ep)
    if prefix == "arxiv":
        return norm_arxiv(ep)
    return None


_PREPRINT_VENUE = re.compile(r"arxiv|e-?print|preprint|submitted", re.I)


# --------------------------------------------------------------------------- #
# Entry/file parsing
# --------------------------------------------------------------------------- #

def _record_from_entry(entry: dict) -> BibRecord:
    journal = _clean_text(entry.get("journal") or entry.get("booktitle") or "")
    if not journal or _PREPRINT_VENUE.search(journal):
        journal = None
    return BibRecord(
        key=entry.get("ID") or entry.get("id") or "",
        entry_type=(entry.get("ENTRYTYPE") or "article").lower(),
        title=_clean_text(entry.get("title") or ""),
        authors=_authors(entry.get("author") or ""),
        year=_year(entry.get("year")),
        journal=journal,
        volume=_clean_text(entry.get("volume") or "") or None,
        pages=_clean_text(entry.get("pages") or "") or None,
        doi=norm_doi(entry.get("doi")),
        arxiv_id=_arxiv_from(entry),
    )


def parse_bibtex_text(text: str) -> list[BibRecord]:
    parser = BibTexParser(common_strings=True)
    # NB: no convert_to_unicode customization — we convert per field in
    # _clean_text so brace-protected group authors survive long enough to detect.
    parser.ignore_nonstandard_types = False
    db = bibtexparser.loads(text, parser=parser)
    records: list[BibRecord] = []
    for entry in db.entries:
        try:
            rec = _record_from_entry(entry)
        except Exception as e:                       # never let one bad entry abort
            log.warning("skipping bib entry %s: %s", entry.get("ID"), e)
            continue
        if rec.key:
            records.append(rec)
    return records


def parse_bibtex(path: str | Path) -> list[BibRecord]:
    """Parse a ``.bib`` file into normalized :class:`BibRecord` objects."""
    return parse_bibtex_text(Path(path).read_text("utf-8"))
