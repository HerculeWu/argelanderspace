#!/usr/bin/env python
"""Re-apply the current ingestion pipeline to already-ingested papers — offline.

Rebuilds ``data/output/<doc_id>/<doc_id>.json`` from the **cached** MinerU
artifacts under ``data/output/<doc_id>/mineru/`` (no MinerU API call, no quota
spent).  Use this after changing an offline stage — e.g. the text-layer
``?``-gap correction (ingest/textfix.py) or dropping symbol extraction — to
refresh existing outputs without re-running OCR.

Usage:
    python scripts/reprocess.py                # every paper under data/output/
    python scripts/reprocess.py 2603.03522     # one (or more) specific doc ids
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bibgraph.config import PipelineConfig                       # noqa: E402
from bibgraph.mineru_client import MineruClient                  # noqa: E402
from bibgraph.pdf_links import extract_links                     # noqa: E402
from bibgraph.pipeline import build_document                     # noqa: E402

OUTPUT_DIR = ROOT / "data" / "output"
INPUT_DIR = ROOT / "data" / "input"
log = logging.getLogger("reprocess")


def _source_pdf(doc_id: str, cache_dir: Path) -> Path | None:
    """The PDF used for hyperlink resolution + text-layer ``?``-gap correction.

    Prefer the original ``data/input/<doc_id>.pdf`` (it carries the hyperlink
    annotations the citation/xref resolver relies on, matching the first ingest);
    fall back to MinerU's own ``*origin.pdf`` copy.  Both are the same paper, so
    the MinerU bboxes (normalized 0..1000) align with either one's geometry.
    """
    cand = INPUT_DIR / f"{doc_id}.pdf"
    if cand.is_file():
        return cand
    origins = sorted(cache_dir.glob("*origin.pdf"))
    return origins[0] if origins else None


def reprocess(doc_id: str, config: PipelineConfig) -> bool:
    out_dir = OUTPUT_DIR / doc_id
    cache_dir = out_dir / "mineru"
    if not (cache_dir.is_dir() and any(cache_dir.glob("*content_list.json"))):
        log.warning("%s: no cached MinerU artifacts (%s); skipping", doc_id, cache_dir)
        return False

    # Load straight from the cache (glob-based) — never calls the MinerU API.
    mineru = MineruClient.load_cached(cache_dir)
    src_pdf = _source_pdf(doc_id, cache_dir)
    if src_pdf is None:
        log.warning("%s: no source PDF for text-layer correction; skipping", doc_id)
        return False
    input_pdf = INPUT_DIR / f"{doc_id}.pdf"
    used_fallback = src_pdf != input_pdf
    if used_fallback:
        # MinerU re-serializes its origin.pdf and typically strips the hyperlink
        # annotations the citation/xref resolver relies on — so resolution may
        # silently degrade to regex-only. Make that loud rather than silent.
        log.warning("%s: %s missing; using %s — hyperlink-based citation/xref "
                    "resolution may degrade (regex fallback)", doc_id,
                    input_pdf.name, src_pdf.name)

    pdf_links = None
    if config.use_pdf_links:
        try:
            pdf_links = extract_links(src_pdf)
        except Exception as e:                       # never fail the whole run
            log.warning("%s: link extraction failed (%s); regex-only", doc_id, e)

    doc = build_document(mineru, src_pdf, pdf_links, config)
    # build_document derives doc_id/source from the PDF stem — pin them back to
    # the doc id, and record the PDF that was actually used (not a fabricated path).
    doc.doc_id = doc_id
    doc.source["filename"] = src_pdf.name if used_fallback else f"{doc_id}.pdf"
    doc.source["path"] = str(src_pdf if used_fallback else input_pdf)

    out_json = out_dir / f"{doc_id}.json"
    out_json.write_text(
        json.dumps(doc.to_dict(config.compact_json), ensure_ascii=False, indent=2),
        "utf-8")

    tf = doc.meta.get("textfix") or {}
    s = doc.to_dict(config.compact_json)["stats"]
    print(f"  {doc_id}: wrote {out_json.relative_to(ROOT)}  "
          f"(paras={s.get('n_paragraphs')}, refs={s.get('n_references')}, "
          f"textfix={tf.get('gaps_fixed', 0)}/{tf.get('gaps_before', 0)} ?-gaps)")
    return True


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO,
                        format="%(levelname)s %(name)s: %(message)s")
    argv = sys.argv[1:] if argv is None else argv
    if argv:
        doc_ids = argv
    else:
        doc_ids = sorted(d.name for d in OUTPUT_DIR.iterdir()
                         if d.is_dir() and (d / f"{d.name}.json").is_file()) \
            if OUTPUT_DIR.is_dir() else []
    if not doc_ids:
        print("no papers found under data/output/", file=sys.stderr)
        return 1

    print(f"reprocessing {len(doc_ids)} paper(s) from cache (no MinerU API):")
    ok = sum(reprocess(d, PipelineConfig()) for d in doc_ids)
    print(f"done: {ok}/{len(doc_ids)} reprocessed")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
