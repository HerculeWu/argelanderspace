"""End-to-end PDF -> structured JSON ingestion pipeline.

    pdf
     ├─ PyMuPDF        -> text-layer probe (OCR auto-detect) + link annotations
     ├─ MinerU (VLM)   -> content_list.json + middle.json + images/
     ├─ structure      -> section tree + floats
     ├─ references     -> structured bibliography
     ├─ annotate       -> inline [[cite:..]] / [[xref:..]] tokens (regex+links)
     └─ symbols        -> lightweight symbol inventory
    -> Document -> <out_dir>/<stem>.json
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .config import PipelineConfig
from .mineru_client import MineruClient, MineruResult
from .pdf_links import (PdfLinks, bbox_1000_to_frac, extract_links,
                        has_text_layer, overlap_fraction)
from .schema import (Document, EquationBlock, FigureBlock, ListBlock,
                     Paragraph, RichText)
from .ingest.annotate import apply_matches
from .ingest.citations import (ReferenceResolver, detect_citations,
                               enrich_citations_with_links)
from .ingest.crossrefs import XrefIndex, detect_crossrefs, enrich_crossrefs_with_links
from .ingest.references import parse_references
from .ingest.structure import build_structure
from .ingest.symbols import extract_symbols, fill_equation_symbols

log = logging.getLogger("bibgraph.pipeline")


def ingest_pdf(pdf_path: str | Path, out_dir: str | Path | None = None,
               config: PipelineConfig | None = None,
               use_mineru_cache: bool = True,
               write_json: bool = True) -> Document:
    config = config or PipelineConfig()
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(pdf_path)
    out_dir = Path(out_dir) if out_dir else (pdf_path.parent / pdf_path.stem)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1) OCR auto-detect (only when caller didn't force it)
    if config.mineru.is_ocr is None:
        has_text = has_text_layer(pdf_path)
        config.mineru.is_ocr = not has_text
        log.info("OCR auto-detect: text_layer=%s -> is_ocr=%s",
                 has_text, config.mineru.is_ocr)

    # 2) MinerU extraction (cached if available)
    client = MineruClient(config.mineru)
    mineru = client.extract(pdf_path, out_dir,
                            poll_interval=config.poll_interval,
                            poll_timeout=config.poll_timeout,
                            use_cache=use_mineru_cache)

    # 3) PDF hyperlink annotations (hybrid resolution)
    pdf_links: PdfLinks | None = None
    if config.use_pdf_links:
        try:
            pdf_links = extract_links(pdf_path)
        except Exception as e:                       # never fail the whole run
            log.warning("Link extraction failed (%s); regex-only resolution", e)

    doc = build_document(mineru, pdf_path, pdf_links, config)

    if write_json:
        out_json = out_dir / f"{pdf_path.stem}.json"
        out_json.write_text(
            json.dumps(doc.to_dict(config.compact_json), ensure_ascii=False,
                       indent=2), "utf-8")
        log.info("Wrote %s", out_json)
        doc.meta["output_path"] = str(out_json)
    return doc


def build_document(mineru: MineruResult, pdf_path: Path,
                   pdf_links: PdfLinks | None,
                   config: PipelineConfig) -> Document:
    """Assemble a :class:`Document` from already-extracted artifacts.

    Separated from :func:`ingest_pdf` so the offline parsing stages can be
    exercised without calling the MinerU API.
    """
    structure = build_structure(mineru.content_list)
    references = parse_references(structure.ref_text_items)

    n_pages = pdf_links.n_pages if pdf_links else _max_page(mineru.content_list)
    doc = Document(
        doc_id=pdf_path.stem,
        source={"type": "pdf", "path": str(pdf_path), "filename": pdf_path.name,
                "n_pages": n_pages},
        meta={"title": structure.title_guess,
              "mineru": {"model_version": config.mineru.model_version,
                         "language": config.mineru.language,
                         "is_ocr": config.mineru.is_ocr,
                         "batch_id": mineru.batch_id}},
        structure=structure.sections,
        references=references,
    )

    resolver = ReferenceResolver(references)
    xindex = XrefIndex(doc)
    _annotate_document(doc, resolver, xindex, pdf_links,
                       use_links=config.use_pdf_links)

    fill_equation_symbols(doc)
    doc.symbols = extract_symbols(doc)
    return doc


def _annotate_document(doc: Document, resolver: ReferenceResolver,
                       xindex: XrefIndex, pdf_links: PdfLinks | None,
                       use_links: bool) -> None:
    for block in doc.iter_blocks():
        holders = _annotatable(block)
        if not holders:
            continue
        block_links = _links_for_block(block, pdf_links) if use_links else []
        for holder in holders:
            if not holder.text:
                continue
            cmatches = detect_citations(holder.text, resolver)
            xmatches = detect_crossrefs(holder.text, xindex)
            if block_links:
                enrich_citations_with_links(cmatches, block_links, resolver)
                enrich_crossrefs_with_links(xmatches, block_links, xindex)
            new_text, cites, xrefs = apply_matches(holder.text, cmatches + xmatches)
            holder.text = new_text
            holder.citations = cites
            holder.crossrefs = xrefs


def _annotatable(block) -> list:
    """Return the rich-text holders of a block (each has .text/.citations/.crossrefs)."""
    if isinstance(block, Paragraph):
        return [block]
    if isinstance(block, ListBlock):
        return list(block.items)
    if isinstance(block, EquationBlock):
        return []
    cap = getattr(block, "caption", None)
    return [cap] if isinstance(cap, RichText) else []


def _links_for_block(block, pdf_links: PdfLinks | None) -> list:
    if pdf_links is None or block.page_idx is None:
        return []
    bbox = bbox_1000_to_frac(getattr(block, "bbox", None))
    if bbox is None:
        return []
    return [ln for ln in pdf_links.links_on_page(block.page_idx)
            if overlap_fraction(ln.rect, bbox) > 0.5]


def _max_page(content_list: list[dict]) -> int:
    pages = [it.get("page_idx") for it in content_list
             if isinstance(it.get("page_idx"), int)]
    return (max(pages) + 1) if pages else 0
