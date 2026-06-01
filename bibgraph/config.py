"""Configuration & defaults for the bibgraph ingestion pipeline."""

from __future__ import annotations

import os
from dataclasses import dataclass, field

MINERU_BASE_URL = "https://mineru.net"
MINERU_API_KEY_ENV = "MINERU_API_KEY"


@dataclass
class MineruConfig:
    """Options for a MinerU v4 high-precision extraction task.

    Defaults target English-language born-digital + scanned research PDFs.
    `is_ocr` is normally auto-detected from the PDF text layer (see
    ``pdf_links.has_text_layer``); set ``force_ocr``/``no_ocr`` to override.
    """

    model_version: str = "vlm"          # vlm = high precision (layout+OCR+formula+code)
    language: str = "en"                # 'ch' covers zh+en; 'en' for english papers
    enable_formula: bool = True
    enable_table: bool = True
    page_ranges: str | None = None      # e.g. "1-10"; None = whole document
    extra_formats: list[str] = field(default_factory=list)  # e.g. ["html","docx"]
    # OCR control: None -> auto-detect from text layer; True/False -> force.
    is_ocr: bool | None = None

    def api_key(self) -> str:
        key = os.environ.get(MINERU_API_KEY_ENV, "").strip()
        if not key:
            raise RuntimeError(
                f"Environment variable {MINERU_API_KEY_ENV} is not set."
            )
        return key


@dataclass
class PipelineConfig:
    mineru: MineruConfig = field(default_factory=MineruConfig)
    # When True, harvest PDF link annotations with PyMuPDF and use them to
    # authoritatively resolve citations / cross-references (hybrid mode).
    use_pdf_links: bool = True
    # Drop None / empty fields from the emitted JSON for compactness.
    compact_json: bool = True
    # Poll interval (s) and overall timeout (s) for the MinerU async task.
    poll_interval: float = 5.0
    poll_timeout: float = 1800.0
