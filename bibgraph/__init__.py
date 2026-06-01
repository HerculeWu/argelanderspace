"""bibgraph — literature ingestion pipeline.

Phase 1: PDF-only ingestion via MinerU (high-precision VLM OCR) + PyMuPDF
hyperlink harvesting, producing a structured JSON document with section
structure, floats (figures/tables/equations/code/algorithms), a global
reference list, and inline-tokenized in-text citations & cross-references.
MinerU's unreadable-glyph '?'-gaps in body text are repaired from the PDF
text layer (see ingest/textfix.py).
"""

__version__ = "0.1.0"
