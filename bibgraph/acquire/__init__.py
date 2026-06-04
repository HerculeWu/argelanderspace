"""The library *acquisition* layer.

Two decision engines sit between a bare bibliographic record (a ``.bib`` entry,
a parsed reference, a DOI/arXiv id) and the reader:

* :mod:`~bibgraph.acquire.planner` — the **source-acquisition** order. For each
  paper it ranks where to get the readable full text by the user's priority
  ``journal-HTML ▸ journal-PDF(digital) ▸ arXiv-LaTeX ▸ ADS-scan-PDF``, limited
  to what we can actually fetch (it asks the live HTML-adapter registry whether
  a journal-HTML source exists yet).
* :mod:`~bibgraph.acquire.resolve` — the **citation-resolution** order. Citation
  metadata/counts come from ``NASA-ADS ▸ Crossref ▸ OpenAlex(title-match)`` in
  that priority, and each work records which source answered.

:mod:`~bibgraph.acquire.run` ties them together: parse a ``.bib``, resolve every
entry, plan its source, and upsert it into the HubbleSpace library.
"""

from __future__ import annotations

from .bibtex import BibRecord, parse_bibtex
from .planner import AcquisitionPlan, Candidate, plan_sources

__all__ = ["BibRecord", "parse_bibtex", "AcquisitionPlan", "Candidate", "plan_sources"]
