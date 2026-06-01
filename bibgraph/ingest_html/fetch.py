"""Fetching + on-disk caching for publisher HTML.

Accepts a DOI *or* a publisher URL, resolves it to the full-text HTML page, and
caches every network response (main page, per-float sub-pages, images) under the
document's output dir so re-runs are offline and fast.
"""

from __future__ import annotations

import hashlib
import logging
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup

log = logging.getLogger("bibgraph.html.fetch")

# A bare DOI: "10.<registrant>/<suffix>" (suffix may contain almost anything).
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$")
# A DOI embedded in a doi.org URL.
DOI_URL_RE = re.compile(r"doi\.org/(10\.\d{4,9}/\S+)$", re.I)


def looks_like_doi(s: str) -> bool:
    return bool(DOI_RE.match(s.strip()))


def normalize_source(source: str) -> str:
    """Turn a DOI / doi.org URL / publisher URL into a fetchable URL."""
    s = source.strip()
    if looks_like_doi(s):
        return "https://doi.org/" + s
    m = DOI_URL_RE.search(s)
    if m:
        return "https://doi.org/" + m.group(1)
    if not s.startswith(("http://", "https://")):
        # bare host/path or unknown token — assume https
        return "https://" + s
    return s


class Fetcher:
    """A caching HTTP client scoped to one document's working directory."""

    def __init__(self, cache_dir: Path, *, user_agent: str,
                 timeout: float = 30.0, use_cache: bool = True,
                 delay: float = 0.3):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout
        self.use_cache = use_cache
        self.delay = delay
        self._last_request = 0.0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})

    # -- low level ---------------------------------------------------------- #
    def _throttle(self) -> None:
        if self.delay <= 0:
            return
        wait = self.delay - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def _cache_path(self, key: str, suffix: str) -> Path:
        digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
        return self.cache_dir / f"{digest}{suffix}"

    # -- text pages --------------------------------------------------------- #
    def get(self, url: str) -> tuple[str, str]:
        """Return ``(final_url, html_text)``; cached by URL on disk."""
        cache = self._cache_path(url, ".html")
        meta = self._cache_path(url, ".url")
        if self.use_cache and cache.is_file() and meta.is_file():
            log.debug("cache hit %s", url)
            return meta.read_text("utf-8").strip(), cache.read_text("utf-8")
        self._throttle()
        log.info("GET %s", url)
        r = self.session.get(url, timeout=self.timeout, allow_redirects=True)
        r.raise_for_status()
        cache.write_text(r.text, "utf-8")
        meta.write_text(r.url, "utf-8")
        return r.url, r.text

    def get_soup(self, url: str) -> tuple[str, BeautifulSoup]:
        final, text = self.get(url)
        return final, BeautifulSoup(text, "html.parser")

    # -- binary assets ------------------------------------------------------ #
    def download(self, url: str, dest: Path, retries: int = 3) -> bool:
        """Stream *url* to *dest* (skipped if already present). Returns ok.

        Streamed with retries: the EDP Sciences server occasionally drops a
        large image connection mid-body (``IncompleteRead``); a fresh streamed
        request reliably completes it.
        """
        dest = Path(dest)
        if self.use_cache and dest.is_file() and dest.stat().st_size > 0:
            return True
        dest.parent.mkdir(parents=True, exist_ok=True)
        last: Exception | None = None
        for attempt in range(retries):
            try:
                self._throttle()
                with self.session.get(url, timeout=self.timeout, stream=True,
                                      allow_redirects=True) as r:
                    r.raise_for_status()
                    expected = int(r.headers.get("Content-Length") or 0)
                    chunks = bytearray()
                    for chunk in r.iter_content(64 * 1024):
                        chunks.extend(chunk)
                    if expected and len(chunks) < expected:
                        raise OSError(f"short read {len(chunks)}/{expected}")
                # Atomic write: a crash mid-write must not leave a truncated file
                # that the size>0 cache check would later accept as complete.
                tmp = dest.with_suffix(dest.suffix + ".part")
                tmp.write_bytes(bytes(chunks))
                tmp.replace(dest)
                return True
            except Exception as e:                   # transient: retry
                last = e
        log.warning("asset download failed %s (%s)", url, last)
        return False


def doc_id_from_url(url: str) -> str:
    """Derive a stable doc id from a full-text URL.

    A&A: ``.../aa39341-20/aa39341-20.html`` -> ``aa39341-20``. Falls back to the
    last meaningful path segment, sanitized for use as a directory name.
    """
    path = urlparse(url).path.rstrip("/")
    segs = [s for s in path.split("/") if s]
    stem = ""
    if segs:
        last = segs[-1]
        stem = re.sub(r"\.s?html?$", "", last, flags=re.I)
        # prefer the parent dir if the file stem is generic (index/fulltext)
        if stem.lower() in {"index", "fulltext", "full_html", ""} and len(segs) >= 2:
            stem = segs[-2]
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._")
    if stem:
        return stem
    # No usable path segment: fall back to the host so distinct sites don't
    # collide into one 'document' dir (and overwrite each other's output).
    host = (urlparse(url).hostname or "").replace(".", "-").strip("-")
    return host or "document"
