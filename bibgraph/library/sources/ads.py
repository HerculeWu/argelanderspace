"""NASA ADS client: authoritative astronomy citation metrics, token-gated.

ADS is the gold standard for astro citation counts. It needs a personal API
token (``~/.ads/dev_key`` or ``$ADS_DEV_KEY``). When the token is missing or
rejected the client degrades to a no-op (``status`` records why) so the rest of
the library — seeded works + OpenAlex enrichment — keeps working; ADS metrics
light up automatically once a valid token is in place.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

import requests

from ..store import CACHE_DIR, norm_doi, norm_title

log = logging.getLogger("bibgraph.library.ads")

_BASE = "https://api.adsabs.harvard.edu/v1/search/query"
_CACHE = CACHE_DIR / "ads"
_FL = "bibcode,title,author,year,citation_count,pub,doi,abstract,reference"
_TIMEOUT = 30


def _read_token() -> str | None:
    tok = os.environ.get("ADS_DEV_KEY")
    if tok:
        return tok.strip()
    p = Path.home() / ".ads" / "dev_key"
    if p.is_file():
        try:
            return p.read_text("utf-8").strip() or None
        except OSError:
            return None
    return None


class ADS:
    def __init__(self, delay: float = 0.25):
        self.token = _read_token()
        self.delay = delay
        self.status = "no-token" if not self.token else "ok"  # ok|no-token|unauthorized|error
        self.session = requests.Session()
        if self.token:
            self.session.headers["Authorization"] = f"Bearer {self.token}"
        _CACHE.mkdir(parents=True, exist_ok=True)

    @property
    def enabled(self) -> bool:
        return self.status in ("ok",) and bool(self.token)

    def _query(self, q: str) -> list[dict] | None:
        key = hashlib.sha1(q.encode()).hexdigest()
        cf = _CACHE / f"{key}.json"
        if cf.is_file():
            try:
                return json.loads(cf.read_text("utf-8"))
            except ValueError:
                pass
        if not self.token or self.status not in ("ok",):
            return None
        try:
            time.sleep(self.delay)
            r = self.session.get(_BASE, params={"q": q, "fl": _FL, "rows": 1}, timeout=_TIMEOUT)
            if r.status_code in (401, 403):
                self.status = "unauthorized"
                log.warning("ADS token rejected (%s) — ADS enrichment disabled", r.status_code)
                return None
            r.raise_for_status()
            docs = r.json().get("response", {}).get("docs", [])
        except (requests.RequestException, ValueError) as e:
            self.status = "error"
            log.warning("ADS query failed: %s", e)
            return None
        cf.write_text(json.dumps(docs), "utf-8")
        return docs

    @staticmethod
    def normalize(doc: dict) -> dict:
        authors = [a.split(",")[0].strip() for a in (doc.get("author") or [])]
        title = doc.get("title") or [""]
        return {
            "bibcode": doc.get("bibcode"),
            "doi": norm_doi((doc.get("doi") or [None])[0]),
            "title": title[0] if isinstance(title, list) else title,
            "authors": authors,
            "year": int(doc["year"]) if doc.get("year") else None,
            "venue": doc.get("pub"),
            "citation_count": doc.get("citation_count"),
            "abstract": doc.get("abstract"),
            "references": doc.get("reference") or [],  # bibcodes this work cites
        }

    def resolve(self, *, doi: str | None = None, arxiv: str | None = None,
                title: str | None = None) -> dict | None:
        d = norm_doi(doi)
        if d:
            docs = self._query(f"doi:{d}")
            if docs:
                return self.normalize(docs[0])
        if arxiv:
            docs = self._query(f"arxiv:{arxiv}")
            if docs:
                return self.normalize(docs[0])
        if title:
            safe = title.replace('"', " ")
            docs = self._query(f'title:"{safe}"')
            if docs:
                n = self.normalize(docs[0])
                # the title query is fuzzy — confirm it really is the same paper
                if _title_matches(title, n["title"]):
                    return n
        return None


def _title_matches(a: str, b: str) -> bool:
    na, nb = norm_title(a), norm_title(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    sa, sb = set(na.split()), set(nb.split())
    return len(sa & sb) / len(sa | sb) >= 0.7
