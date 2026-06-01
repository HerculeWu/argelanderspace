"""bibgraph — literature ingestion pipeline.

Phase 1: PDF-only ingestion via MinerU (high-precision VLM OCR) + PyMuPDF
hyperlink harvesting, producing a structured JSON document with section
structure, floats (figures/tables/equations/code/algorithms), a global
reference list, inline-tokenized in-text citations & cross-references, and a
lightweight symbol inventory.
"""

__version__ = "0.1.0"
