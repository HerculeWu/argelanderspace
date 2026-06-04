"""Crossref client: DOI metadata, citation counts, and reference lists.

Crossref is the registration agency for most journal DOIs (A&A, MNRAS, ApJ, PRL
all register here). It is free, keyless (we join the polite pool with a mailto),
and gives us three things the resolution chain wants between ADS and OpenAlex:

* ``is-referenced-by-count`` — a citation count (used when ADS has no token);
* ``reference`` — the work's own bibliography as DOIs (future graph fuel);
* ``link`` / ``resource`` — the publisher full-text URLs (HTML & PDF), which the
  acquisition executor (Phase 3) uses to fetch the journal page directly.

It mirrors :class:`~bibgraph.library.sources.openalex.OpenAlex`: ``resolve`` by
DOI or title+year, disk-cached, with a 404 sentinel so misses aren't re-fetched.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from typing import Any

import requests

from ..store import CACHE_DIR, arxiv_from_doi, norm_doi, norm_title

log = logging.getLogger("bibgraph.library.crossref")

_BASE = "https://api.crossref.org"
_MAILTO = os.environ.get("OPENALEX_MAILTO", "wuwenjiegogo@gmail.com")
_CACHE = CACHE_DIR / "crossref"
_TIMEOUT = 30


def _strip_jats(s: str | None) -> str | None:
    if not s:
        return None
    s = re.sub(r"<[^>]+>", " ", s)            # JATS/XML abstract → plain text
    s = re.sub(r"\s+", " ", s).strip()
    return s[:2500] or None


class Crossref:
    def __init__(self, delay: float = 0.15, enabled: bool = True):
        self.delay = delay
        self.enabled = enabled
        self.session = requests.Session()
        self.session.headers["User-Agent"] = (
            f"HubbleSpace/0.1 (https://github.com/; mailto:{_MAILTO})")
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
            log.warning("crossref GET %s failed: %s", path, e)
            return None
        cf.write_text(json.dumps(data), "utf-8")
        return data

    # ---- normalization ----
    @staticmethod
    def normalize(w: dict) -> dict:
        title = (w.get("title") or [""])
        title = title[0] if isinstance(title, list) and title else (title or "")
        venue = w.get("container-title") or []
        venue = venue[0] if isinstance(venue, list) and venue else (venue or None)
        authors = []
        for a in w.get("author") or []:
            fam = a.get("family") or a.get("name")
            if fam:
                authors.append(fam)
        year = None
        for k in ("published-print", "published-online", "published", "issued",
                  "created"):
            parts = ((w.get(k) or {}).get("date-parts") or [[None]])
            if parts and parts[0] and parts[0][0]:
                year = parts[0][0]
                break
        ref_dois = []
        for r in w.get("reference") or []:
            d = norm_doi(r.get("DOI"))
            if d:
                ref_dois.append(d)
        ctype = w.get("type") or "journal-article"
        kind = "conf" if "proceedings" in ctype else "article"
        # full-text links: publisher HTML / PDF (intended-application=text-mining)
        links = []
        for ln in w.get("link") or []:
            url = ln.get("URL")
            if url:
                links.append({"url": url,
                              "content_type": ln.get("content-type") or "",
                              "intended": ln.get("intended-application") or ""})
        return {
            "doi": norm_doi(w.get("DOI")),
            "title": title,
            "authors": authors,
            "year": year,
            "venue": venue,
            "type": kind,
            "cited_by_count": w.get("is-referenced-by-count"),
            "reference_dois": ref_dois,
            "n_references": w.get("references-count") or len(ref_dois),
            "abstract": _strip_jats(w.get("abstract")),
            "resource_url": (w.get("resource") or {}).get("primary", {}).get("URL"),
            "links": links,
        }

    # ---- resolution ----
    def resolve(self, *, doi: str | None = None, title: str | None = None,
                year: int | None = None, journal: str | None = None,
                first_author: str | None = None,
                expect_prefixes: tuple[str, ...] = ()) -> dict | None:
        d = norm_doi(doi)
        if d:
            w = self._get(f"/works/{d}")
            if w and not w.get("__notfound__"):
                msg = w.get("message")
                if msg:
                    return self.normalize(msg)
        return self._search(title, year, first_author, expect_prefixes)

    def _search(self, title: str | None, year: int | None,
                first_author: str | None,
                expect_prefixes: tuple[str, ...]) -> dict | None:
        """Title-only search. This is the user's lowest-priority *matched* tier,
        so it errs toward returning nothing rather than a wrong record: a match
        needs a near-exact title, a compatible year, the expected publisher (when
        known), and the first author present."""
        if not title:
            return None
        data = self._get("/works", {"query.bibliographic": title, "rows": 5,
                                    "select": ("DOI,title,author,container-title,"
                                               "issued,published-print,type,"
                                               "is-referenced-by-count,references-count")})
        items = ((data or {}).get("message") or {}).get("items") or []
        want = norm_title(title)
        fa = norm_title(first_author) if first_author else None
        best, best_score = None, 0.0
        for it in items:
            n = self.normalize(it)
            nt = norm_title(n["title"])
            if not nt:
                continue
            ov = _overlap(want, nt)
            substr = (want in nt or nt in want) and min(len(want), len(nt)) >= 20
            if not (nt == want or ov >= 0.85 or substr):
                continue
            if year and n["year"] and abs(n["year"] - year) > 1:
                continue
            # publisher gate: a title hit into a *different* journal is a false
            # positive (e.g. a famous A&A title reprinted in a Cambridge volume).
            nd = (n["doi"] or "").lower()
            if expect_prefixes and nd and not arxiv_from_doi(nd):
                if not any(nd.startswith(p) for p in expect_prefixes):
                    continue
            # the first author's surname must appear among the matched authors
            if fa and n["authors"]:
                if not any(fa in norm_title(au) or norm_title(au) in fa
                           for au in n["authors"]):
                    continue
            score = 1.0 if nt == want else ov
            if year and n["year"]:
                score -= min(3, abs(n["year"] - year)) * 0.05
            if score > best_score:
                best, best_score = n, score
        return best


def _overlap(a: str, b: str) -> float:
    sa, sb = set(a.split()), set(b.split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)
