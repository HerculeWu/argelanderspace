"""Citation-resolution chain: NASA-ADS ▸ Crossref ▸ OpenAlex(title-match).

The user's resolution priority for a work's citation metadata:

    1. NASA / ADS        — the astronomy gold standard (authoritative counts +
                           reference lists), token-gated; no-op without a token.
    2. Crossref          — keyless DOI metadata + ``is-referenced-by-count`` +
                           reference DOIs + publisher full-text links.
    3. OpenAlex (match)  — title/DOI match; the only source of the *OpenAlex ids*
                           the citation graph is built on (referenced_works).

All three are consulted (OpenAlex always runs because the graph needs its ids),
but the **citation count** is taken from the first source in priority order that
supplies one, and every work records the provenance in ``Work.resolution``::

    {"count": "ads", "providers": ["ads","crossref","openalex"],
     "n_refs": {"ads": 56, "crossref": 60, "openalex": 58}, "links": 2}
"""

from __future__ import annotations

import logging

from ..library.sources.ads import ADS
from ..library.sources.crossref import Crossref
from ..library.sources.openalex import OpenAlex
from ..library.store import Work, arxiv_from_doi
from .planner import classify

log = logging.getLogger("bibgraph.acquire.resolve")


def _fill(w: Work, *, year=None, venue=None, authors=None, abstract=None) -> None:
    """Fill only blank scalar fields (earlier, higher-priority sources win)."""
    if w.year is None and year:
        w.year = year
    if not w.venue and venue:
        w.venue = venue
    if not w.authors and authors:
        w.authors = list(authors)
    if not w.abstract and abstract:
        w.abstract = abstract


def _accept_doi(w: Work, doi: str | None) -> None:
    """Adopt a resolved DOI — but route an arXiv DataCite DOI to ``arxiv_id``
    instead of ``doi`` so it never poses as a journal DOI."""
    if not doi:
        return
    aid = arxiv_from_doi(doi)
    if aid:
        w.arxiv_id = w.arxiv_id or aid
        return
    if not w.doi:
        w.doi = doi


def resolve_work(w: Work, *, ads: ADS, crossref: Crossref, oa: OpenAlex) -> dict:
    """Resolve one work's citation metadata through the chain. Mutates *w*."""
    prov: dict = {"providers": [], "n_refs": {}}
    count: int | None = None
    count_src: str | None = None

    # Scrub a previously-stored arXiv DOI masquerading as a journal DOI (makes
    # re-runs over an older library.json idempotent).
    _stale = arxiv_from_doi(w.doi)
    if _stale:
        w.arxiv_id = w.arxiv_id or _stale
        w.doi = None

    # 1) NASA / ADS — authoritative astro counts + reference list (bibcodes).
    a = ads.resolve(doi=w.doi, arxiv=w.arxiv_id, title=w.title)
    if a:
        prov["providers"].append("ads")
        w.bibcode = w.bibcode or a["bibcode"]
        _accept_doi(w, a.get("doi"))
        _fill(w, year=a["year"], venue=a["venue"], authors=a["authors"],
              abstract=a["abstract"])
        if a["citation_count"] is not None:
            count, count_src = a["citation_count"], "ads"
        if a.get("references"):
            prov["n_refs"]["ads"] = len(a["references"])

    # 2) Crossref — DOI metadata, count, reference DOIs, publisher full-text links.
    #    Pass the expected publisher prefixes so a title-only search can't match
    #    a different journal's record (false positives corrupt identity + graph).
    _epub = classify(None, w.journal or w.venue)[0]
    c = crossref.resolve(doi=w.doi, title=w.title, year=w.year,
                         journal=w.journal or w.venue,
                         first_author=(w.authors[0] if w.authors else None),
                         expect_prefixes=(_epub.doi_prefixes if _epub else ()))
    if c:
        prov["providers"].append("crossref")
        _accept_doi(w, c["doi"])
        _fill(w, year=c["year"], venue=c["venue"], authors=c["authors"],
              abstract=c["abstract"])
        if c["type"] == "conf" and w.type == "article":
            w.type = "conf"
        if count is None and c["cited_by_count"] is not None:
            count, count_src = c["cited_by_count"], "crossref"
        if c.get("reference_dois"):
            prov["n_refs"]["crossref"] = len(c["reference_dois"])
        if c.get("links"):
            prov["links"] = len(c["links"])

    # 3) OpenAlex — always: it is the only source of the graph's referenced_works
    #    ids and a reliable last-resort count.
    r = oa.resolve(doi=w.doi, arxiv=w.arxiv_id, title=w.title, year=w.year)
    if r:
        prov["providers"].append("openalex")
        w.openalex_id = w.openalex_id or r["openalex_id"]
        if r.get("arxiv_id"):                        # recovered from OA locations
            w.arxiv_id = w.arxiv_id or r["arxiv_id"]
        _accept_doi(w, r["doi"])
        _fill(w, year=r["year"], venue=r["venue"], authors=r["authors"],
              abstract=r["abstract"])
        if r["type"] and w.type == "article":
            w.type = r["type"]
        if r["referenced_works"]:
            w.referenced_works = r["referenced_works"]
            prov["n_refs"]["openalex"] = len(r["referenced_works"])
        if count is None and r["cited_by_count"] is not None:
            count, count_src = r["cited_by_count"], "openalex"

    if count is not None:
        w.cited_by_count = count
    prov["count"] = count_src
    w.resolution = prov
    log.info("resolved %s via %s; count=%s(%s) refs=%s", w.id,
             "+".join(prov["providers"]) or "none", w.cited_by_count, count_src,
             prov["n_refs"])
    return prov
