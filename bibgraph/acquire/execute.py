"""Acquisition executor: fetch full text for ready works per their plan.

The planner decided *where* to read each paper; the executor *does* it, routing
each ready work to the matching ingestion pipeline:

* ``journal_html`` → :func:`bibgraph.pipeline_html.ingest_html` (DOI → publisher
  page → reader Document);
* ``arxiv_latex``  → :func:`bibgraph.pipeline_latex.ingest_latex` (arXiv id →
  e-print LaTeX → reader Document);
* ``journal_pdf`` / ``ads_scan`` → PDF fetch + MinerU OCR (Phase 3, gated behind
  the OCR budget — handled by :mod:`bibgraph.acquire.fetch_pdf`).

It only touches works whose chosen tier is ``ready`` (an adapter/fetcher exists)
and that don't already have a reader rendering. Each result reports the produced
``doc_id`` and block count so a hollow page (old template, paywall) is visible.
After fetching, the caller rebuilds the library so the new docs link back to
their works via ``doc_ids``.
"""

from __future__ import annotations

import logging

from ..config import PipelineConfig
from ..library.store import LibraryStore, Work

log = logging.getLogger("bibgraph.acquire.execute")

# tiers the executor can fetch without MinerU (free, no OCR budget)
FREE_TIERS = ("journal_html", "arxiv_latex")


def _ingest_for(w: Work, config: PipelineConfig):
    tier = (w.acquisition or {}).get("chosen")
    if tier == "journal_html":
        from ..pipeline_html import ingest_html
        if not w.doi:
            raise ValueError("journal_html chosen but work has no DOI")
        return ingest_html(w.doi, config=config, write_json=True)
    if tier == "arxiv_latex":
        from ..pipeline_latex import ingest_latex
        if not w.arxiv_id:
            raise ValueError("arxiv_latex chosen but work has no arXiv id")
        return ingest_latex(w.arxiv_id, config=config, write_json=True)
    raise ValueError(f"tier {tier!r} is not auto-fetchable here (needs Phase-3 OCR)")


def fetch_ready_fulltext(store: LibraryStore, *, tiers=FREE_TIERS,
                         limit: int | None = None,
                         config: PipelineConfig | None = None) -> list[dict]:
    """Ingest full text for every ready, not-yet-ingested work in *tiers*."""
    config = config or PipelineConfig()
    results: list[dict] = []
    n = 0
    for w in store.works:
        acq = w.acquisition or {}
        if acq.get("ingested_doc"):
            continue
        if acq.get("status") != "ready" or acq.get("chosen") not in tiers:
            continue
        if limit is not None and n >= limit:
            break
        n += 1
        tier = acq.get("chosen")
        loc = w.doi if tier == "journal_html" else w.arxiv_id
        try:
            doc = _ingest_for(w, config)
            blocks = sum(1 for _ in doc.iter_blocks())
            stats = doc.to_dict(True).get("stats", {})
            results.append({
                "id": w.id, "tier": tier, "loc": loc, "doc_id": doc.doc_id,
                "blocks": blocks, "ok": blocks > 0,
                "title": (doc.meta.get("title") or "")[:48],
                "sections": stats.get("n_sections"),
                "figures": stats.get("n_figures"), "refs": stats.get("n_references"),
            })
            log.info("fetched %s → %s (%d blocks)", w.id, doc.doc_id, blocks)
        except Exception as e:                       # one failure must not abort the batch
            results.append({"id": w.id, "tier": tier, "loc": loc, "ok": False,
                            "error": str(e)[:200]})
            log.warning("FAILED %s (%s): %s", w.id, loc, e)
    return results


def fetch_remaining(store: LibraryStore, *, skip=(), limit: int | None = None) -> list[dict]:
    """Fallback chain for pending works whose primary source failed/blocked:
    free **arXiv LaTeX** → **arXiv PDF** (MinerU) → **ADS scan** (MinerU OCR).

    Used after :func:`fetch_ready_fulltext` for the stragglers (old-template
    journal pages, AASTeX papers pandoc can't parse, legacy scans)."""
    from ..pipeline_latex import ingest_latex
    from .fetch_pdf import ads_scan_doc, arxiv_pdf_doc

    skip = set(skip)
    results: list[dict] = []
    n = 0
    for w in store.works:
        acq = w.acquisition or {}
        if acq.get("ingested_doc") or w.id in skip:
            continue
        if limit is not None and n >= limit:
            break
        n += 1
        doc, via, errs = None, None, []
        attempts = []
        if w.arxiv_id:
            attempts.append(("arxiv_latex",
                             lambda c: ingest_latex(w.arxiv_id, config=c, write_json=True)))
            attempts.append(("arxiv_pdf", lambda c: arxiv_pdf_doc(w, c)))
        if w.bibcode:
            attempts.append(("ads_scan", lambda c: ads_scan_doc(w, c)))
        for name, fn in attempts:
            try:
                doc, via = fn(PipelineConfig()), name
                break
            except Exception as e:
                errs.append(f"{name}: {str(e)[:90]}")
        if doc is not None:
            blocks = sum(1 for _ in doc.iter_blocks())
            results.append({"id": w.id, "via": via, "doc_id": doc.doc_id,
                            "blocks": blocks, "ok": blocks > 0,
                            "title": (w.title or "")[:46]})
            log.info("recovered %s via %s → %s (%d blocks)", w.id, via, doc.doc_id, blocks)
        else:
            results.append({"id": w.id, "ok": False, "error": "; ".join(errs),
                            "title": (w.title or "")[:46]})
            log.warning("could not recover %s: %s", w.id, "; ".join(errs))
    return results
