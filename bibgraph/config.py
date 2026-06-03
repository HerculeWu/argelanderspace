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
class HtmlConfig:
    """Options for ingesting a publisher's HTML full-text (Phase 4).

    Unlike the PDF path there is no OCR: the publisher already gives us clean,
    semantically-marked-up HTML. We only fetch (with on-disk caching), walk the
    DOM with a per-publisher adapter, and convert the bits that aren't plain
    text (display-equation LaTeX, table sub-pages, figure images).
    """

    user_agent: str = (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120 Safari/537.36"
    )
    request_timeout: float = 30.0
    # Cache fetched pages/sub-pages on disk so re-runs need no network.
    use_cache: bool = True
    # Download figure images / equation GIFs locally (served via /images);
    # when False, the remote publisher URL is kept in img_path instead.
    download_assets: bool = True
    # Follow the per-float sub-pages (A&A puts table bodies on T<n>.html and the
    # full-resolution figure on F<n>.html). Off => caption-only floats.
    fetch_subpages: bool = True
    # Inline-math representation in body text. "conservative" wraps only clear
    # math (sub/sup, single-letter italic variables) in $...$ for KaTeX and
    # flattens prose italics; "plain" drops all inline-math markup.
    inline_math: str = "conservative"
    # Polite delay (s) between network requests to the publisher.
    request_delay: float = 0.3


@dataclass
class LatexConfig:
    """Options for ingesting an arXiv LaTeX source package (Phase 5).

    arXiv gives us the author's own LaTeX, which is the most faithful source
    there is: the maths is already LaTeX (no MathML/OCR round-trip) and — most
    valuable — every citation is a ``\\cite`` key and every cross-reference a
    ``\\ref``/``\\label`` pair, so resolution is *authoritative*. We let
    ``pandoc`` parse the LaTeX into its document AST, then walk that AST into the
    same :class:`~bibgraph.schema.Document` the PDF/HTML pipelines emit.
    """

    user_agent: str = (
        "bibgraph/0.1 (https://arxiv.org; mailto:wuwenjiegogo@gmail.com)"
    )
    request_timeout: float = 60.0
    # Cache the downloaded e-print tarball + extracted tree so re-runs are offline.
    use_cache: bool = True
    # Rasterise vector figures (PDF/EPS) to PNG for the web reader; served via
    # /images like the PDF/HTML pipelines. When False, figures are caption-only.
    download_assets: bool = True
    # Raster DPI for vector-figure -> PNG conversion (PyMuPDF / Ghostscript).
    figure_dpi: int = 200
    # Hard cap on a rasterised figure's longest side (px) to keep payloads sane.
    figure_max_px: int = 2200
    # Polite delay (s) between arXiv requests.
    request_delay: float = 1.0


@dataclass
class PipelineConfig:
    mineru: MineruConfig = field(default_factory=MineruConfig)
    html: HtmlConfig = field(default_factory=HtmlConfig)
    latex: LatexConfig = field(default_factory=LatexConfig)
    # When True, harvest PDF link annotations with PyMuPDF and use them to
    # authoritatively resolve citations / cross-references (hybrid mode).
    use_pdf_links: bool = True
    # When True, repair MinerU's '?'-gaps in body text from the PDF text layer
    # (see ingest/textfix.py). No-op on scanned PDFs (no text layer).
    use_textfix: bool = True
    # Drop None / empty fields from the emitted JSON for compactness.
    compact_json: bool = True
    # Poll interval (s) and overall timeout (s) for the MinerU async task.
    poll_interval: float = 5.0
    poll_timeout: float = 1800.0
