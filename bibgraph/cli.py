"""Command-line entry point.

    python -m bibgraph paper.pdf
    python -m bibgraph paper.pdf -o out.json --lang en
    python -m bibgraph paper.pdf --reuse        # reuse cached MinerU result
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .config import MineruConfig, PipelineConfig
from .pipeline import ingest_pdf


def _build_config(args) -> PipelineConfig:
    is_ocr = None
    if args.ocr:
        is_ocr = True
    elif args.no_ocr:
        is_ocr = False
    mineru = MineruConfig(
        model_version=args.model,
        language=args.lang,
        enable_formula=not args.no_formula,
        enable_table=not args.no_table,
        page_ranges=args.pages,
        is_ocr=is_ocr,
    )
    return PipelineConfig(mineru=mineru, use_pdf_links=not args.no_links)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="bibgraph",
                                description="Ingest a PDF into structured JSON.")
    p.add_argument("pdf", help="path to the input PDF")
    p.add_argument("-o", "--output", help="output JSON path")
    p.add_argument("--out-dir", help="working/cache dir (default: <pdf_dir>/<stem>)")
    p.add_argument("--model", default="vlm", help="MinerU model_version (default vlm)")
    p.add_argument("--lang", default="en", help="document language (default en)")
    p.add_argument("--pages", help="page ranges, e.g. '1-10'")
    p.add_argument("--no-formula", action="store_true", help="disable formula OCR")
    p.add_argument("--no-table", action="store_true", help="disable table OCR")
    p.add_argument("--no-links", action="store_true",
                   help="disable PyMuPDF hyperlink resolution (regex only)")
    p.add_argument("--ocr", action="store_true", help="force OCR on")
    p.add_argument("--no-ocr", action="store_true", help="force OCR off")
    p.add_argument("--reuse", action="store_true",
                   help="reuse cached MinerU artifacts if present (no API call)")
    p.add_argument("--fresh", action="store_true",
                   help="ignore cache and re-call the MinerU API")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        datefmt="%H:%M:%S")

    config = _build_config(args)
    out_dir = Path(args.out_dir) if args.out_dir else None
    try:
        doc = ingest_pdf(args.pdf, out_dir=out_dir, config=config,
                         use_mineru_cache=not args.fresh, write_json=True)
    except Exception as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    if args.output:
        import json
        Path(args.output).write_text(
            json.dumps(doc.to_dict(config.compact_json), ensure_ascii=False,
                       indent=2), "utf-8")
        print(f"wrote {args.output}")

    s = doc.to_dict(config.compact_json)["stats"]
    print("\n=== ingest summary ===")
    print(f"  title       : {doc.meta.get('title')}")
    print(f"  pages       : {doc.source.get('n_pages')}")
    for k in ("n_sections", "n_paragraphs", "n_figures", "n_tables",
              "n_equations", "n_code", "n_algorithms", "n_references"):
        print(f"  {k:<12}: {s.get(k, 0)}")
    print(f"  citations   : {s.get('n_citations', 0)} "
          f"({s.get('n_citations_resolved', 0)} resolved)")
    print(f"  crossrefs   : {s.get('n_crossrefs', 0)} "
          f"({s.get('n_crossrefs_resolved', 0)} resolved)")
    tf = doc.meta.get("textfix")
    if tf:
        print(f"  textfix     : repaired {tf.get('gaps_fixed', 0)}/"
              f"{tf.get('gaps_before', 0)} ?-gaps from the PDF text layer")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
