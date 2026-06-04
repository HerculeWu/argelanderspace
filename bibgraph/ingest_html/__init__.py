"""Publisher-HTML ingestion (Phase 4).

Modern journals publish a clean, semantically-marked-up HTML full text that is
the most stable source there is: section structure, figures/tables, equations
(often with the original LaTeX in a ``data-latex`` attribute), and — crucially —
in-text citations / cross-references as real ``<a href="#R..">`` anchors, so
resolution is *authoritative* rather than regex-guessed.

Every publisher ships a different front-end, so each gets its own adapter (see
:mod:`bibgraph.ingest_html.aanda` for Astronomy & Astrophysics). An adapter
walks the DOM and emits the very same :class:`bibgraph.schema.Document` the PDF
pipeline produces, so the reader UI and all downstream tooling are unchanged.
"""

from __future__ import annotations

from .base import ADAPTERS, HtmlAdapter, adapter_for
from . import aanda  # noqa: F401  (registers the A&A adapter)
from . import oup    # noqa: F401  (registers the OUP / MNRAS adapter)

__all__ = ["ADAPTERS", "HtmlAdapter", "adapter_for"]
