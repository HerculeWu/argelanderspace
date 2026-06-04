"""CLI: rebuild the library from ingested papers (+ an optional .bib).

    python -m bibgraph.library                       # full rebuild (network)
    python -m bibgraph.library --offline             # seed + cached metadata only
    python -m bibgraph.library --bib references.bib  # also add every .bib entry

Metadata is resolved through the chain ADS▸Crossref▸OpenAlex and each work gets
an acquisition plan (where to read its full text). No full text is fetched here.
"""

from __future__ import annotations

import argparse
import json
import logging

from .build import rebuild


def main() -> None:
    ap = argparse.ArgumentParser(prog="bibgraph.library", description=__doc__)
    ap.add_argument("--offline", action="store_true", help="skip live ADS/Crossref/OpenAlex calls (use cache only)")
    ap.add_argument("--bib", metavar="PATH", help="also add every entry of this .bib to the library")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    summary = rebuild(enrich_remote=not args.offline, bib_path=args.bib)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["ads_status"] != "ok":
        print(f"\n⚠ ADS enrichment was not applied (status: {summary['ads_status']}).")
        print("  Put a valid token in ~/.ads/dev_key or $ADS_DEV_KEY to enable astro citation counts;")
        print("  Crossref + OpenAlex still supply counts/metadata meanwhile.")


if __name__ == "__main__":
    main()
