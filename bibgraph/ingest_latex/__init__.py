"""arXiv LaTeX-source ingestion (Phase 5).

arXiv ships the author's own LaTeX, the most faithful source of all: the maths is
already LaTeX (no MathML/OCR round-trip), and every citation is a ``\\cite`` key
and every cross-reference a ``\\ref``/``\\label`` pair — so resolution is
*authoritative*, not regex-guessed. We let :mod:`pandoc` parse the LaTeX into its
document AST (expanding preamble macros, following ``\\input``), then walk that
AST into the very same :class:`bibgraph.schema.Document` the PDF/HTML pipelines
emit, so the reader UI and downstream tooling are unchanged.
"""

from __future__ import annotations

from .fetch import acquire_source, arxiv_id, looks_like_arxiv

__all__ = ["acquire_source", "arxiv_id", "looks_like_arxiv"]
