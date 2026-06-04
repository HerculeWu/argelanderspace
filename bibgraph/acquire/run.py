"""Glue the acquisition layer onto the library store.

* :func:`add_bib_records` — turn parsed ``.bib`` entries into library works
  (upserted, so they merge with already-ingested papers by DOI/arXiv/title).
* :func:`enrich_and_plan` — run every work through the resolution chain
  (ADS▸Crossref▸OpenAlex) and the source planner, stamping ``Work.resolution``
  and ``Work.acquisition``.

The top-level ``acquire_references`` orchestration (load → seed → add bib →
enrich+plan → graph → save) lives in :mod:`bibgraph.library.build` so it can
reuse the store's write lock and graph cache.
"""

from __future__ import annotations

import logging

from ..library.graph import _cite_key
from ..library.sources.ads import ADS
from ..library.sources.crossref import Crossref
from ..library.sources.openalex import OpenAlex
from ..library.store import LibraryStore, Work, canonical_id
from .bibtex import BibRecord
from .planner import classify, plan_sources
from .resolve import resolve_work

log = logging.getLogger("bibgraph.acquire.run")


def work_from_bibrecord(rec: BibRecord) -> Work:
    """Build a library :class:`Work` from one parsed ``.bib`` entry."""
    _pub, label = classify(rec.doi, rec.journal)
    venue = label or rec.journal
    return Work(
        id=canonical_id(doi=rec.doi, arxiv=rec.arxiv_id, title=rec.title, year=rec.year),
        title=rec.title,
        authors=list(rec.authors),
        year=rec.year,
        venue=venue,
        journal=label or None,
        type="conf" if rec.is_conf else "article",
        doi=rec.doi,
        arxiv_id=rec.arxiv_id,
        origin="bib",
    )


def add_bib_records(store: LibraryStore, records: list[BibRecord]) -> list[Work]:
    """Upsert each record (merges with existing works on shared identity keys)."""
    out: list[Work] = []
    for rec in records:
        out.append(store.upsert(work_from_bibrecord(rec)))
    return out


def plan_for(w: Work):
    """Compute the acquisition plan for a (resolved) work."""
    return plan_sources(doi=w.doi, arxiv_id=w.arxiv_id, bibcode=w.bibcode,
                        title=w.title, year=w.year, journal=w.journal,
                        venue=w.venue)


def enrich_and_plan(store: LibraryStore, *, ads: ADS, crossref: Crossref,
                    oa: OpenAlex) -> LibraryStore:
    """Resolve metadata + compute the source plan for every saved work."""
    used_keys: set[str] = set()
    for w in store.works:
        resolve_work(w, ads=ads, crossref=crossref, oa=oa)
        # backfill the short journal label now that resolution may have found a
        # DOI (e.g. an arXiv-only ApJS work gains its 10.3847 DOI → "ApJS").
        pub, label = classify(w.doi, w.journal or w.venue)
        if pub and label and not w.journal:
            w.journal = label
        w.cite_key = _cite_key(w, used_keys)
        acq = plan_for(w).to_dict()
        if w.doc_ids:                       # already has a reader rendering
            acq["ingested_doc"] = w.doc_ids[0]
        w.acquisition = acq
    return store
