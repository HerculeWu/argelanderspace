r"""PDF acquisition tier: obtain a PDF for a work and OCR it via MinerU.

The fallback when the structured sources fail or are blocked:

* **arXiv PDF** (``arxiv.org/pdf/<id>``) — born-digital, has a real text layer, so
  MinerU extracts cleanly (no OCR); the universal fallback for arXiv papers whose
  LaTeX pandoc can't parse (AASTeX ``\input{table}`` etc.);
* **ADS scan** (``articles.adsabs.harvard.edu/pdf/<bibcode>``) — a true scan of an
  old article; forced through OCR.

Each fetched PDF is ingested into ``data/output/<doc_id>/`` exactly like a
user-supplied PDF, then its ``source`` is stamped with the work's DOI / arXiv id
so :func:`bibgraph.library.seed.seed_from_output` links the doc to the work.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

import requests

from ..config import PipelineConfig
from ..library.store import ROOT, Work, norm_arxiv

log = logging.getLogger("bibgraph.acquire.fetch_pdf")

OUTPUT_DIR = ROOT / "data" / "output"
_UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120 Safari/537.36")


def _slug(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "-", s or "").strip("-._")


def _download_pdf(url: str, dest: Path, *, timeout: float = 60.0) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with requests.get(url, headers={"User-Agent": _UA}, timeout=timeout,
                      stream=True, allow_redirects=True) as r:
        r.raise_for_status()
        ctype = r.headers.get("content-type", "")
        chunks = bytearray()
        for c in r.iter_content(64 * 1024):
            chunks.extend(c)
        if not chunks.startswith(b"%PDF") and "pdf" not in ctype.lower():
            raise ValueError(f"{url} did not return a PDF (content-type {ctype!r})")
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(bytes(chunks))
        tmp.replace(dest)


def _stamp_source(doc_json: Path, w: Work, via: str) -> None:
    """Stamp the work's identifiers on the produced doc so seed links it back."""
    data = json.loads(doc_json.read_text("utf-8"))
    src = data.setdefault("source", {})
    if w.doi:
        src["doi"] = w.doi
    if w.arxiv_id:
        src["arxiv_id"] = w.arxiv_id
    src["acquired_via"] = via
    meta = data.setdefault("meta", {})
    if not meta.get("title") and w.title:
        meta["title"] = w.title
    doc_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")


def _ingest_pdf_for(w: Work, *, url: str, doc_id: str, via: str,
                    force_ocr: bool, config: PipelineConfig):
    from ..pipeline import ingest_pdf

    out_dir = OUTPUT_DIR / doc_id
    pdf_path = out_dir / f"{doc_id}.pdf"
    if not pdf_path.is_file() or pdf_path.stat().st_size == 0:
        _download_pdf(url, pdf_path)
    config.mineru.is_ocr = True if force_ocr else None  # None → auto-detect text layer
    doc = ingest_pdf(pdf_path, out_dir=out_dir, config=config, write_json=True)
    _stamp_source(out_dir / f"{doc_id}.json", w, via)
    return doc


def arxiv_pdf_doc(w: Work, config: PipelineConfig):
    aid = norm_arxiv(w.arxiv_id)
    if not aid:
        raise ValueError("no arXiv id")
    return _ingest_pdf_for(w, url=f"https://arxiv.org/pdf/{aid}",
                           doc_id=f"arxivpdf-{_slug(aid)}", via="arxiv_pdf",
                           force_ocr=False, config=config)


def ads_scan_doc(w: Work, config: PipelineConfig):
    if not w.bibcode:
        raise ValueError("no ADS bibcode")
    url = f"https://articles.adsabs.harvard.edu/pdf/{w.bibcode}"
    return _ingest_pdf_for(w, url=url, doc_id=f"ads-{_slug(w.bibcode)}",
                           via="ads_scan", force_ocr=True, config=config)
