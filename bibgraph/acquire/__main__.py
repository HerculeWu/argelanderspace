"""CLI: add a .bib's entries to the library and print the acquisition plan.

    python -m bibgraph.acquire references.bib            # resolve + plan + graph
    python -m bibgraph.acquire references.bib --offline  # cached metadata only
    python -m bibgraph.acquire references.bib --dry-run   # plan only, no library write

This is the Phase-1 entry point: it resolves citation metadata through
ADS▸Crossref▸OpenAlex and computes each paper's full-text source plan, but does
NOT fetch any journal page or PDF (that is Phase 2/3).
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from ..library.sources.ads import ADS
from ..library.sources.crossref import Crossref
from ..library.sources.openalex import OpenAlex
from ..library.store import LibraryStore
from .bibtex import parse_bibtex
from .run import add_bib_records, enrich_and_plan

_STATUS_MARK = {"ready": "✓ ready", "needs_adapter": "⊕ needs-adapter",
                "needs_access": "⊝ needs-access", "blocked": "⊘ bot-walled",
                "unavailable": "× none"}


def _row(w) -> str:
    acq = w.acquisition or {}
    chosen = acq.get("chosen_label") or "—"
    status = _STATUS_MARK.get(acq.get("status"), acq.get("status") or "—")
    ready = acq.get("ready") or "—"
    rb = (w.resolution or {}).get("count") or "—"
    cby = w.cited_by_count if w.cited_by_count is not None else "?"
    tag = "[in lib]" if acq.get("ingested_doc") else ""
    title = (w.title or w.id)[:46]
    return (f"  {chosen:<11} {status:<15} ready={ready:<12} "
            f"cite={rb:<9} n={cby:<6} {title} {tag}")


def main() -> int:
    ap = argparse.ArgumentParser(prog="bibgraph.acquire", description=__doc__)
    ap.add_argument("bib", help="path to a .bib file")
    ap.add_argument("--offline", action="store_true", help="use cached metadata only")
    ap.add_argument("--dry-run", action="store_true", help="plan only; do not write the library")
    ap.add_argument("--fetch", action="store_true",
                    help="after planning, fetch full text for ready works (A&A HTML + arXiv LaTeX)")
    ap.add_argument("--fetch-remaining", action="store_true",
                    help="fallback chain for stragglers: arXiv LaTeX → arXiv PDF → ADS scan (MinerU OCR)")
    ap.add_argument("--skip", default="", help="comma-separated work ids to skip when fetching")
    ap.add_argument("--limit", type=int, default=None, help="cap how many works --fetch ingests")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s")

    if args.dry_run:
        store = LibraryStore()
        add_bib_records(store, parse_bibtex(args.bib))
        enrich_remote = not args.offline
        enrich_and_plan(store, ads=ADS(), crossref=Crossref(enabled=enrich_remote),
                        oa=OpenAlex(enabled=enrich_remote))
        works = store.works
    else:
        from ..library.build import acquire_references, rebuild
        summary = acquire_references(args.bib, enrich_remote=not args.offline)
        if args.fetch:
            from .execute import fetch_ready_fulltext
            store = LibraryStore.load()
            results = fetch_ready_fulltext(store, limit=args.limit)
            ok = sum(1 for r in results if r.get("ok"))
            print(f"\n=== fetched {ok}/{len(results)} ready works ===")
            for r in results:
                if r.get("ok"):
                    print(f"  ✓ {r['doc_id']:<16} {r['tier']:<12} "
                          f"sec={r.get('sections')} fig={r.get('figures')} "
                          f"ref={r.get('refs')} blocks={r['blocks']}  {r.get('title','')}")
                else:
                    print(f"  ✗ {r['tier']:<12} {r.get('loc')}  ERR: {r.get('error')}")
            # relink the new reader docs to their works + refresh plans/graph
            summary = rebuild(enrich_remote=not args.offline)
        if args.fetch_remaining:
            from .execute import fetch_remaining
            store = LibraryStore.load()
            skip = {s.strip() for s in args.skip.split(",") if s.strip()}
            results = fetch_remaining(store, skip=skip, limit=args.limit)
            ok = sum(1 for r in results if r.get("ok"))
            print(f"\n=== fetch-remaining: recovered {ok}/{len(results)} ===")
            for r in results:
                if r.get("ok"):
                    print(f"  ✓ {r['doc_id']:<22} via {r['via']:<12} blocks={r['blocks']}  {r.get('title','')}")
                else:
                    print(f"  ✗ {r['id']}  {r.get('error')}")
            summary = rebuild(enrich_remote=not args.offline)
        store = LibraryStore.load()
        works = store.works
        print(json.dumps(summary, ensure_ascii=False, indent=2))

    print(f"\n=== acquisition plan ({len(works)} works) ===")
    for w in sorted(works, key=lambda x: (x.acquisition or {}).get("chosen") or "z"):
        print(_row(w))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
