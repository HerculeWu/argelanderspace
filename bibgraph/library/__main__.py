"""CLI: rebuild the library from ingested papers + OpenAlex/ADS.

    python -m bibgraph.library            # full rebuild (network)
    python -m bibgraph.library --offline  # seed + cached enrichment only
"""

from __future__ import annotations

import argparse
import json
import logging

from .build import rebuild


def main() -> None:
    ap = argparse.ArgumentParser(prog="bibgraph.library", description=__doc__)
    ap.add_argument("--offline", action="store_true", help="skip live OpenAlex/ADS calls (use cache only)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
    )
    summary = rebuild(enrich_remote=not args.offline)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    if summary["ads_status"] != "ok":
        print(f"\n⚠ ADS enrichment was not applied (status: {summary['ads_status']}).")
        print("  Put a valid token in ~/.ads/dev_key or $ADS_DEV_KEY to enable astro citation counts.")


if __name__ == "__main__":
    main()
