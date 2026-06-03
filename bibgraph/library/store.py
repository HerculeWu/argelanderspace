"""The HubbleSpace literature store.

The library is a small set of files on disk under ``data/library/`` so an agent
(or the user) can read and edit it with ordinary tools:

* ``library.json`` — the source of truth: saved *works* + per-work user state
  (tags, color label, read flag, note, star) + the project header;
* ``library.bib`` — a regenerated BibTeX export of the saved works;
* ``cache/`` — derived/enrichment artifacts (the citation graph, raw OpenAlex /
  ADS responses); never hand-edited, safe to delete.

A *work* is one canonical paper. Several ingested reader documents (the PDF /
LaTeX / HTML renderings of the same paper) collapse into a single work that
points back at all of them via ``doc_ids``.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
LIBRARY_DIR = ROOT / "data" / "library"
LIBRARY_JSON = LIBRARY_DIR / "library.json"
LIBRARY_BIB = LIBRARY_DIR / "library.bib"
CACHE_DIR = LIBRARY_DIR / "cache"


# --------------------------------------------------------------------------- #
# Identity helpers
# --------------------------------------------------------------------------- #

def norm_doi(doi: str | None) -> str | None:
    if not doi:
        return None
    d = doi.strip().lower()
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d)
    d = re.sub(r"^doi:", "", d)
    return d or None


def norm_arxiv(arxiv: str | None) -> str | None:
    if not arxiv:
        return None
    a = arxiv.strip().lower()
    a = re.sub(r"^arxiv:", "", a)
    a = re.sub(r"v\d+$", "", a)  # strip version
    return a or None


def norm_title(title: str | None) -> str:
    if not title:
        return ""
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def slug(s: str, n: int = 48) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")[:n] or "work"


def canonical_id(
    *, doi: str | None = None, arxiv: str | None = None,
    openalex: str | None = None, title: str | None = None, year: int | None = None,
) -> str:
    """Stable canonical id for a work (DOI ▸ arXiv ▸ OpenAlex ▸ title-slug)."""
    d = norm_doi(doi)
    if d:
        return "doi:" + d
    a = norm_arxiv(arxiv)
    if a:
        return "arxiv:" + a
    if openalex:
        return "openalex:" + openalex.rsplit("/", 1)[-1]
    return "work:" + slug(title) + (f"-{year}" if year else "")


def display_authors(authors: list[str]) -> str:
    """``["Hunt","Reffert","Smith"]`` → ``"Hunt et al."`` (Zotero-ish)."""
    a = [x for x in authors if x]
    if not a:
        return ""
    if len(a) == 1:
        return a[0]
    if len(a) == 2:
        return f"{a[0]} & {a[1]}"
    return f"{a[0]} et al."


# --------------------------------------------------------------------------- #
# Work model
# --------------------------------------------------------------------------- #

@dataclass
class Work:
    id: str
    title: str = ""
    authors: list[str] = field(default_factory=list)  # family names, in order
    year: int | None = None
    venue: str | None = None
    type: str = "article"  # article | conf
    doi: str | None = None
    arxiv_id: str | None = None
    bibcode: str | None = None
    openalex_id: str | None = None
    abstract: str | None = None
    cited_by_count: int | None = None
    cite_key: str | None = None
    referenced_works: list[str] = field(default_factory=list)  # openalex ids this work cites
    doc_ids: list[str] = field(default_factory=list)  # reader docs that ARE this work
    # ---- user state ----
    tags: list[str] = field(default_factory=list)
    label: str | None = None  # color-label key
    read: bool = False
    note: str | None = None
    star: bool = False
    origin: str = "ingested"  # ingested | manual | graph-node
    added_at: str | None = None

    def identity_keys(self) -> set[str]:
        """All keys by which this work may be matched to another (for dedup)."""
        keys: set[str] = set()
        d = norm_doi(self.doi)  # guard: a bare "doi:" normalizes to None
        if d:
            keys.add("doi:" + d)
        a = norm_arxiv(self.arxiv_id)
        if a:
            keys.add("arxiv:" + a)
        if self.openalex_id:
            keys.add("openalex:" + self.openalex_id.rsplit("/", 1)[-1])
        nt = norm_title(self.title)
        if nt:
            keys.add("title:" + nt)
        return keys

    def to_dict(self) -> dict[str, Any]:
        return {k: v for k, v in asdict(self).items() if v not in (None, [], "")}


# --------------------------------------------------------------------------- #
# Store
# --------------------------------------------------------------------------- #

DEFAULT_PROJECT = {"name": "我的文献库", "short": "Library", "field": ""}


class LibraryStore:
    def __init__(self, works: list[Work] | None = None, project: dict | None = None):
        self.works: list[Work] = works or []
        self.project: dict = project or dict(DEFAULT_PROJECT)
        self._by_key: dict[str, Work] = {}
        self._reindex()

    # ---- indexing ----
    def _reindex(self) -> None:
        self._by_key = {}
        for w in self.works:
            for k in w.identity_keys():
                self._by_key.setdefault(k, w)

    def get(self, work_id: str) -> Work | None:
        for w in self.works:
            if w.id == work_id:
                return w
        return None

    def match(self, *keys: str) -> Work | None:
        for k in keys:
            if k and k in self._by_key:
                return self._by_key[k]
        return None

    def upsert(self, w: Work) -> Work:
        """Add *w*, or merge it into the existing work(s) sharing any identity key.

        A bridging record (e.g. one carrying both a DOI and a title that two
        separate works each already hold) reconciles those works into one, so a
        single paper never persists as duplicates.
        """
        matches: list[Work] = []
        seen: set[int] = set()
        for k in w.identity_keys():
            m = self._by_key.get(k)
            if m is not None and id(m) not in seen:
                seen.add(id(m))
                matches.append(m)
        if not matches:
            self.works.append(w)
            self._reindex()
            return w
        survivor = matches[0]
        for extra in matches[1:]:  # collapse works the new record bridges
            _merge_into(survivor, extra)
            self.works.remove(extra)
        _merge_into(survivor, w)
        self._reindex()
        return survivor

    # ---- persistence ----
    @classmethod
    def load(cls) -> "LibraryStore":
        if not LIBRARY_JSON.is_file():
            return cls()
        data = json.loads(LIBRARY_JSON.read_text("utf-8"))
        works = [Work(**w) for w in data.get("works", [])]
        return cls(works=works, project=data.get("project") or dict(DEFAULT_PROJECT))

    def save(self) -> None:
        LIBRARY_DIR.mkdir(parents=True, exist_ok=True)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "project": self.project,
            "works": [w.to_dict() for w in self.works],
        }
        tmp = LIBRARY_JSON.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
        tmp.replace(LIBRARY_JSON)
        btmp = LIBRARY_BIB.with_suffix(".bib.tmp")
        btmp.write_text(self.to_bibtex(), "utf-8")
        btmp.replace(LIBRARY_BIB)

    # ---- exports ----
    def to_bibtex(self) -> str:
        return "\n\n".join(work_to_bibtex(w) for w in self.works) + "\n"


def _merge_into(dst: Work, src: Work) -> None:
    """Fold *src* into *dst*, filling blanks and unioning lists (dst wins on scalars)."""
    for f in ("title", "venue", "doi", "arxiv_id", "bibcode", "openalex_id",
              "abstract", "cite_key"):
        if not getattr(dst, f) and getattr(src, f):
            setattr(dst, f, getattr(src, f))
    for f in ("year", "cited_by_count"):  # numeric: 0 is a real value, not "blank"
        if getattr(dst, f) is None and getattr(src, f) is not None:
            setattr(dst, f, getattr(src, f))
    if not dst.authors and src.authors:
        dst.authors = src.authors
    if src.type and dst.type == "article":
        dst.type = src.type
    for f in ("doc_ids", "tags", "referenced_works"):
        merged = list(dict.fromkeys([*getattr(dst, f), *getattr(src, f)]))
        setattr(dst, f, merged)


# --------------------------------------------------------------------------- #
# BibTeX
# --------------------------------------------------------------------------- #

def _bib_authors(authors: list[str]) -> str:
    return " and ".join(authors) if authors else ""


def work_to_bibtex(w: Work) -> str:
    key = w.cite_key or slug(w.id)
    kind = "inproceedings" if w.type == "conf" else "article"
    fields = [
        ("title", w.title),
        ("author", _bib_authors(w.authors)),
        ("journal", w.venue),
        ("year", str(w.year) if w.year else ""),
        ("doi", w.doi),
        ("eprint", w.arxiv_id),
    ]
    body = ",\n".join(f"  {k:<8}= {{{v}}}" for k, v in fields if v)
    return f"@{kind}{{{key},\n{body}\n}}"
