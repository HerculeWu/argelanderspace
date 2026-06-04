"""Seed the library from already-ingested reader documents.

Every processed paper under ``data/output/`` becomes a library *work*. The PDF /
LaTeX / HTML renderings of one paper collapse into a single work (matched by
DOI, arXiv id, or normalized title) that lists all of them in ``doc_ids`` — so
"open in 文档" can jump straight to whichever rendering the reader has.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .store import ROOT, LibraryStore, Work, canonical_id

OUTPUT_DIR = ROOT / "data" / "output"
_ARXIV_RE = re.compile(r"^\d{4}\.\d{4,5}$")


def _iter_docs():
    if not OUTPUT_DIR.is_dir():
        return
    for d in sorted(OUTPUT_DIR.iterdir()):
        jf = d / f"{d.name}.json"
        if d.is_dir() and jf.is_file():
            try:
                yield d.name, json.loads(jf.read_text("utf-8"))
            except (ValueError, OSError):
                continue


def seed_from_output(store: LibraryStore) -> LibraryStore:
    """Create/merge a work per ingested paper. Idempotent (re-runnable)."""
    for doc_id, doc in _iter_docs():
        src = doc.get("source", {})
        meta = doc.get("meta", {})
        title = (meta.get("title") or "").strip()
        doi = src.get("doi")
        arxiv = src.get("arxiv_id")
        # the PDF pipeline names the dir by the arXiv id itself
        if not arxiv and _ARXIV_RE.match(doc_id):
            arxiv = doc_id
        venue = "A&A" if src.get("publisher") == "aanda" or (doi or "").startswith("10.1051/0004-6361") else None

        wid = canonical_id(doi=doi, arxiv=arxiv, title=title)
        w = Work(
            id=wid,
            title=title,
            doi=doi,
            arxiv_id=arxiv,
            venue=venue,
            doc_ids=[doc_id],
            origin="ingested",
        )
        store.upsert(w)
    _prune_missing_docs(store)
    return store


def _prune_missing_docs(store: LibraryStore) -> None:
    """Drop ``doc_ids`` whose output dir no longer exists (e.g. a hollow doc that
    was removed) so a deleted/failed ingest stops masquerading as coverage."""
    for w in store.works:
        kept = [d for d in w.doc_ids if (OUTPUT_DIR / d / f"{d}.json").is_file()]
        if kept != w.doc_ids:
            w.doc_ids = kept


def doc_reference_ids(doc_id: str) -> list[dict]:
    """The reference records of one ingested doc (for offline edge matching)."""
    jf = OUTPUT_DIR / doc_id / f"{doc_id}.json"
    if not jf.is_file():
        return []
    try:
        return json.loads(jf.read_text("utf-8")).get("references", [])
    except (ValueError, OSError):
        return []
