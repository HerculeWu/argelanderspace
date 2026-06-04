"""OpenAlex client: resolve a work, fetch metadata in batches, disk-cached.

OpenAlex is free and needs no key (we join the polite pool with a mailto). It
gives the citation network we need: ``cited_by_count`` (node size),
``publication_year`` (hue), and ``referenced_works`` (edges).

Resolution gotcha (observed): fetching an arXiv preprint by its arXiv DOI
returns a bare stub (cited_by 0, no references) — the *published* record, which
carries the citations and reference list, is found by title search. So we use
DOI lookup for works that have a journal DOI, and title+year search otherwise.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import requests

from ..store import CACHE_DIR, norm_arxiv, norm_doi, norm_title

log = logging.getLogger("bibgraph.library.openalex")

_BASE = "https://api.openalex.org"
_MAILTO = os.environ.get("OPENALEX_MAILTO", "wuwenjiegogo@gmail.com")
_CACHE = CACHE_DIR / "openalex"
_TIMEOUT = 30


def _short_id(oid: str | None) -> str | None:
    if not oid:
        return None
    return oid.rsplit("/", 1)[-1]


def _reconstruct_abstract(inv: dict | None) -> str | None:
    if not inv:
        return None
    pos: dict[int, str] = {}
    for word, idxs in inv.items():
        for i in idxs:
            pos[i] = word
    if not pos:
        return None
    return " ".join(pos[i] for i in sorted(pos))[:2500] or None


class OpenAlex:
    def __init__(self, delay: float = 0.12, enabled: bool = True):
        self.delay = delay
        self.enabled = enabled
        self.session = requests.Session()
        self.session.headers["User-Agent"] = f"HubbleSpace/0.1 (mailto:{_MAILTO})"
        _CACHE.mkdir(parents=True, exist_ok=True)

    # ---- low-level GET with disk cache ----
    def _get(self, path: str, params: dict | None = None) -> Any | None:
        params = dict(params or {})
        params["mailto"] = _MAILTO
        key = hashlib.sha1((path + "?" + json.dumps(params, sort_keys=True)).encode()).hexdigest()
        cf = _CACHE / f"{key}.json"
        if cf.is_file():
            try:
                return json.loads(cf.read_text("utf-8"))
            except ValueError:
                pass
        if not self.enabled:
            return None
        try:
            time.sleep(self.delay)
            r = self.session.get(_BASE + path, params=params, timeout=_TIMEOUT)
            if r.status_code == 404:
                cf.write_text(json.dumps({"__notfound__": True}), "utf-8")
                return {"__notfound__": True}
            r.raise_for_status()
            data = r.json()
        except (requests.RequestException, ValueError) as e:
            log.warning("openalex GET %s failed: %s", path, e)
            return None
        cf.write_text(json.dumps(data), "utf-8")
        return data

    # ---- normalization ----
    @staticmethod
    def _arxiv_from_locations(w: dict) -> str | None:
        """OpenAlex lists every hosting location; the published record links back
        to its arXiv preprint, so we can recover the arXiv id for a paper whose
        publisher HTML is bot-walled (IOP/APS) without any extra request."""
        pat = re.compile(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5}|[a-z\-]+/\d{7})",
                         re.I)
        for L in (w.get("locations") or []):
            for u in (L.get("landing_page_url"), L.get("pdf_url")):
                m = pat.search(u or "")
                if m:
                    return norm_arxiv(m.group(1))
        return None

    @staticmethod
    def normalize(w: dict) -> dict:
        loc = (w.get("primary_location") or {}).get("source") or {}
        venue = loc.get("display_name")
        oa_type = w.get("type") or "article"
        kind = "conf" if oa_type in ("proceedings-article", "proceedings", "book-chapter") else "article"
        authors = [
            (a.get("author") or {}).get("display_name", "").split()[-1]
            for a in (w.get("authorships") or [])
            if (a.get("author") or {}).get("display_name")
        ]
        return {
            "openalex_id": _short_id(w.get("id")),
            "doi": norm_doi(w.get("doi")),
            "title": w.get("display_name") or w.get("title") or "",
            "authors": authors,
            "year": w.get("publication_year"),
            "venue": venue,
            "type": kind,
            "cited_by_count": w.get("cited_by_count"),
            "referenced_works": [_short_id(x) for x in (w.get("referenced_works") or [])],
            "abstract": _reconstruct_abstract(w.get("abstract_inverted_index")),
            "arxiv_id": OpenAlex._arxiv_from_locations(w),
        }

    # ---- resolution ----
    def resolve(self, *, doi: str | None = None, arxiv: str | None = None,
                title: str | None = None, year: int | None = None) -> dict | None:
        d = norm_doi(doi)
        if d:
            w = self._get(f"/works/https://doi.org/{d}")
            if w and not w.get("__notfound__"):
                norm = self.normalize(w)
                # a journal DOI record is authoritative; use it
                if norm["referenced_works"] or norm["cited_by_count"]:
                    return norm
                # otherwise fall through to title search for the enriched record
        hit = self._search(title, year)
        if hit:
            return hit
        # last resort: the arXiv preprint record (thin, but carries real ids)
        a = norm_arxiv(arxiv)
        if a:
            w = self._get(f"/works/https://doi.org/10.48550/arXiv.{a}")
            if w and not w.get("__notfound__"):
                return self.normalize(w)
        return None

    def _search(self, title: str | None, year: int | None) -> dict | None:
        if not title:
            return None
        # title.search is tokenized; re-rank so the TITLE itself must match well —
        # the reference-count bonus is only a tiebreaker and cannot rescue a weak
        # title (else a longer unrelated paper that merely contains the query wins).
        data = self._get(
            "/works",
            {"filter": f"title.search:{re.sub(r'[^A-Za-z0-9 ]', ' ', title)}", "per-page": 8},
        )
        results = (data or {}).get("results") or []
        if not results:
            return None
        want = norm_title(title)
        best, best_total = None, -1.0
        for w in results:
            n = self.normalize(w)
            nt = norm_title(n["title"])
            ov = _token_overlap(want, nt)
            if nt == want:
                tscore = 10.0
            elif (want in nt or nt in want) and min(len(want), len(nt)) >= 16 and ov >= 0.6:
                tscore = 6.0
            else:
                tscore = ov * 6.0
            if tscore < 5.0:  # the title itself must be a strong match
                continue
            total = tscore
            if year and n["year"]:
                total -= min(3, abs(n["year"] - year)) * 0.5
            total += min(2.0, len(n["referenced_works"]) / 30.0)  # tiebreaker only
            if total > best_total:
                best, best_total = n, total
        return best

    # ---- batch metadata ----
    def fetch_many(self, ids: list[str]) -> dict[str, dict]:
        """openalex short ids → normalized records (batched, ≤50 per request)."""
        out: dict[str, dict] = {}
        uniq = [i for i in dict.fromkeys(ids) if i]
        for i in range(0, len(uniq), 50):
            chunk = uniq[i : i + 50]
            data = self._get("/works", {"filter": "openalex_id:" + "|".join(chunk), "per-page": 50})
            for w in (data or {}).get("results") or []:
                n = self.normalize(w)
                if n["openalex_id"]:
                    out[n["openalex_id"]] = n
        return out


def _token_overlap(a: str, b: str) -> float:
    sa, sb = set(a.split()), set(b.split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)
