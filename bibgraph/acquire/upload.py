r"""Attach a user-supplied PDF to a library work.

The escape hatch for papers we can't fetch automatically — bot-walled
publishers (IOP/APS) or scans we have no open source for. The user provides the
PDF (from their browser / institutional access); we OCR it via MinerU and link
it to the work like any other reader rendering, stamping the work's DOI / arXiv
id on the produced doc so the library picks it up.
"""

from __future__ import annotations

import logging
import shutil
from pathlib import Path

from ..config import PipelineConfig
from ..library.store import (LibraryStore, Work, norm_arxiv, norm_doi,
                             norm_title, slug)
from .fetch_pdf import OUTPUT_DIR, _stamp_source

log = logging.getLogger("bibgraph.acquire.upload")


def find_work(store: LibraryStore, *, work_id: str | None = None,
              doi: str | None = None, arxiv: str | None = None,
              title: str | None = None) -> Work | None:
    if work_id:
        w = store.get(work_id)
        if w:
            return w
    keys = []
    d = norm_doi(doi)
    if d:
        keys.append("doi:" + d)
    a = norm_arxiv(arxiv)
    if a:
        keys.append("arxiv:" + a)
    w = store.match(*keys)
    if w:
        return w
    if title:
        nt = norm_title(title)
        return next((x for x in store.works if norm_title(x.title) == nt), None)
    return None


def attach_pdf(pdf_path: str | Path, *, work_id: str | None = None,
               doi: str | None = None, arxiv: str | None = None,
               title: str | None = None, force_ocr: bool | None = None,
               config: PipelineConfig | None = None) -> dict:
    """OCR *pdf_path* and link it to the matching work. Returns the work's ref."""
    from ..library.build import rebuild
    from ..library.graph import work_to_ref
    from ..pipeline import ingest_pdf

    pdf_path = Path(pdf_path)
    if not pdf_path.is_file():
        raise FileNotFoundError(pdf_path)

    store = LibraryStore.load()
    w = find_work(store, work_id=work_id, doi=doi, arxiv=arxiv, title=title)
    if w is None:
        raise ValueError("no matching work in the library "
                         f"(id={work_id!r} doi={doi!r} arxiv={arxiv!r})")

    config = config or PipelineConfig()
    config.mineru.is_ocr = force_ocr            # None → auto-detect text layer
    doc_id = f"upload-{slug(w.id)}"
    out_dir = OUTPUT_DIR / doc_id
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"{doc_id}.pdf"
    if pdf_path.resolve() != dest.resolve():
        shutil.copyfile(pdf_path, dest)

    doc = ingest_pdf(dest, out_dir=out_dir, config=config, write_json=True)
    _stamp_source(out_dir / f"{doc_id}.json", w, "user_pdf")
    log.info("attached %s → %s (%d blocks)", w.id, doc_id,
             sum(1 for _ in doc.iter_blocks()))

    rebuild()                                   # relink doc_ids + refresh graph
    store2 = LibraryStore.load()
    w2 = find_work(store2, work_id=w.id, doi=w.doi, arxiv=w.arxiv_id)
    return work_to_ref(w2) if w2 else {"id": w.id, "doc_id": doc_id}
