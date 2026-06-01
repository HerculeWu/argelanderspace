"""End-to-end publisher-HTML -> structured JSON ingestion pipeline (Phase 4).

    url/DOI
     ├─ fetch          -> full-text HTML (cached on disk)
     ├─ adapter        -> section tree + floats + references  (per publisher)
     │                    citations/cross-refs tokenised AUTHORITATIVELY from
     │                    the page's own <a href="#R../#F.."> anchors
     ├─ annotate       -> regex fallback for any *unlinked* mention
     └─ index/stats    -> same Document shape the PDF pipeline emits
    -> Document -> <out_root>/<doc_id>/<doc_id>.json

The output JSON is identical in shape to the PDF path, so the reader UI and all
downstream tooling work unchanged.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from bs4 import BeautifulSoup

from .config import PipelineConfig
from .ingest.annotate import Match, apply_matches
from .ingest.citations import ReferenceResolver, detect_citations
from .ingest.crossrefs import XrefIndex, detect_crossrefs
from .ingest_html import adapter_for
from .ingest_html.fetch import Fetcher, doc_id_from_url, normalize_source
from .pipeline import _annotatable
from .schema import Document

log = logging.getLogger("bibgraph.pipeline_html")


def ingest_html(source: str, out_root: str | Path = "data/output",
                config: PipelineConfig | None = None,
                write_json: bool = True) -> Document:
    config = config or PipelineConfig()
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)

    # Shared on-disk page cache (keyed by URL) so re-runs need no network.
    fetcher = Fetcher(out_root / ".htmlcache",
                      user_agent=config.html.user_agent,
                      timeout=config.html.request_timeout,
                      use_cache=config.html.use_cache,
                      delay=config.html.request_delay)

    url0 = normalize_source(source)
    final_url, html = fetcher.get(url0)
    soup = BeautifulSoup(html, "html.parser")

    doc_id = doc_id_from_url(final_url)
    out_dir = out_root / doc_id
    asset_dir = out_dir / "assets"
    out_dir.mkdir(parents=True, exist_ok=True)

    adapter = adapter_for(final_url, soup)
    if adapter is None:
        raise ValueError(
            f"No HTML adapter matches {final_url!r}. Supported: A&A (aanda.org). "
            "Add a publisher adapter under bibgraph/ingest_html/.")
    log.info("adapter=%s doc_id=%s", adapter.name, doc_id)

    parsed = adapter.parse(soup, base_url=final_url, fetcher=fetcher,
                           asset_dir=asset_dir, config=config.html)

    doc = Document(
        doc_id=doc_id,
        source={"type": "html", "path": final_url,
                "filename": f"{doc_id}.html", "n_pages": 1,
                "url": final_url, **{k: v for k, v in parsed.source_extra.items()
                                     if k != "url"}},
        meta={"title": parsed.title, "html": parsed.meta},
        structure=parsed.sections,
        references=parsed.references,
    )

    _annotate_document(doc)

    # Guard against silently ingesting a hollow page (e.g. an abstract-only or
    # paywalled page that still had the expected container): a real article has
    # body text. Warn loudly rather than write a useless empty JSON unnoticed.
    n_blocks = sum(1 for _ in doc.iter_blocks())
    if n_blocks == 0:
        log.warning("%s: parsed 0 content blocks — the fetched page (%s) is "
                    "likely not the full text (abstract/paywall?).", doc_id, final_url)

    if write_json:
        out_json = out_dir / f"{doc_id}.json"
        out_json.write_text(
            json.dumps(doc.to_dict(config.compact_json), ensure_ascii=False,
                       indent=2), "utf-8")
        log.info("Wrote %s", out_json)
        doc.meta["output_path"] = str(out_json)
    return doc


def _annotate_document(doc: Document) -> None:
    """Splice inline tokens. Anchor matches from the adapter are authoritative;
    the regex detector only fills in *unlinked* author-year / "Fig. N" mentions
    (and is suppressed wherever it overlaps an anchor)."""
    resolver = ReferenceResolver(doc.references)
    xindex = XrefIndex(doc)
    for block in doc.iter_blocks():
        for holder in _annotatable(block):
            text = holder.text or ""
            if not text:
                continue
            anchors: list[Match] = list(getattr(holder, "_anchor_matches", []) or [])
            fallback = detect_citations(text, resolver) + detect_crossrefs(text, xindex)
            fallback = [m for m in fallback if not _overlaps(m, anchors)]
            new_text, cites, xrefs = apply_matches(text, anchors + fallback)
            holder.text = new_text
            holder.citations = cites
            holder.crossrefs = xrefs
            if hasattr(holder, "_anchor_matches"):
                del holder._anchor_matches


def _overlaps(m: Match, spans: list[Match]) -> bool:
    return any(m.start < s.end and s.start < m.end for s in spans)
