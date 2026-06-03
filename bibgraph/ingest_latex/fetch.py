"""Acquire and unpack an arXiv LaTeX source package (Phase 5).

Accepts an arXiv id (``2501.17225``, ``arXiv:2501.17225v2``, ``astro-ph/0701001``),
an arXiv URL (``/abs/``, ``/pdf/``, ``/e-print/``), or a *local* path (a ``.tex``
file, a source directory, or a ``.tar.gz``/``.tar`` tarball). Network downloads
of ``https://arxiv.org/e-print/<id>`` are cached on disk so re-runs are offline.
"""

from __future__ import annotations

import gzip
import logging
import re
import tarfile
import time
from dataclasses import dataclass
from pathlib import Path

import requests

log = logging.getLogger("bibgraph.latex.fetch")

# Modern arXiv id (post-2007): YYMM.NNNNN, optional version. Old style:
# archive(.subclass)?/YYMMNNN.
_NEW_ID = r"\d{4}\.\d{4,5}(?:v\d+)?"
_OLD_ID = r"[a-z][a-z\-\.]+/\d{7}(?:v\d+)?"
_ID_RE = re.compile(rf"^(?:{_NEW_ID}|{_OLD_ID})$", re.I)
_ARXIV_URL_RE = re.compile(
    rf"arxiv\.org/(?:abs|pdf|e-print|format)/({_NEW_ID}|{_OLD_ID})", re.I)
_ARXIV_PREFIX_RE = re.compile(rf"^arxiv:\s*({_NEW_ID}|{_OLD_ID})$", re.I)

ARXIV_EPRINT = "https://arxiv.org/e-print/{id}"


def looks_like_arxiv(s: str) -> bool:
    """True for a bare arXiv id, an ``arXiv:`` prefix, or an arxiv.org URL."""
    s = s.strip()
    return bool(_ID_RE.match(s) or _ARXIV_PREFIX_RE.match(s)
                or _ARXIV_URL_RE.search(s))


def arxiv_id(s: str) -> str | None:
    """Extract the canonical arXiv id (version kept) from any accepted form."""
    s = s.strip()
    m = _ARXIV_PREFIX_RE.match(s)
    if m:
        return m.group(1)
    m = _ARXIV_URL_RE.search(s)
    if m:
        return re.sub(r"\.pdf$", "", m.group(1), flags=re.I)
    if _ID_RE.match(s):
        return s
    return None


def doc_id_for(arx: str | None, local: Path | None) -> str:
    """Stable doc id. arXiv ids are namespaced ``arxiv-<id>`` so a LaTeX ingest
    never collides with the same paper's PDF (``2603.03522``) or HTML doc."""
    if arx:
        safe = re.sub(r"[^A-Za-z0-9._-]+", "-", arx).strip("-._")
        return f"arxiv-{safe}"
    stem = (local.stem if local and local.is_file() else
            (local.name if local else "document"))
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", stem).strip("-._")
    return f"latex-{stem}" if stem else "latex-document"


@dataclass
class LatexSource:
    src_dir: Path          # directory holding the unpacked .tex tree
    main_tex: Path         # the file carrying \documentclass + \begin{document}
    doc_id: str
    arxiv_id: str | None = None
    origin: str = ""       # the URL or local path we resolved


class ArxivFetcher:
    """Downloads + caches arXiv e-print tarballs under a working directory."""

    def __init__(self, cache_dir: Path, *, user_agent: str,
                 timeout: float = 60.0, use_cache: bool = True,
                 delay: float = 1.0):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.timeout = timeout
        self.use_cache = use_cache
        self.delay = delay
        self._last = 0.0
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": user_agent})

    def _throttle(self) -> None:
        if self.delay <= 0:
            return
        wait = self.delay - (time.monotonic() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.monotonic()

    def download_eprint(self, arx: str) -> Path:
        """Fetch ``e-print/<id>`` to a cached file; return its path."""
        dest = self.cache_dir / f"{re.sub(r'[^A-Za-z0-9._-]+', '-', arx)}.tar.gz"
        if self.use_cache and dest.is_file() and dest.stat().st_size > 0:
            log.debug("cache hit %s", dest)
            return dest
        url = ARXIV_EPRINT.format(id=arx)
        self._throttle()
        log.info("GET %s", url)
        r = self.session.get(url, timeout=self.timeout, allow_redirects=True)
        r.raise_for_status()
        if not r.content:
            raise RuntimeError(f"empty e-print response for {arx}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        tmp.write_bytes(r.content)
        tmp.replace(dest)
        return dest


# Decompression-bomb guards: a small tarball must not expand without bound.
_MAX_EXTRACT_BYTES = 800 * 1024 * 1024      # 800 MB total uncompressed
_MAX_MEMBERS = 50_000


def _extract(archive: Path, dest: Path) -> None:
    """Unpack an arXiv source bundle (gzipped tar, plain tar, or a single
    gzipped file) into *dest*. arXiv strips file extensions from single-file
    submissions, so a lone gzip is materialised as ``main.tex``."""
    dest.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(archive, "r:*") as tf:
            members = tf.getmembers()
            if len(members) > _MAX_MEMBERS:
                raise RuntimeError(f"{archive.name}: {len(members)} members "
                                   f"exceeds cap ({_MAX_MEMBERS}); refusing.")
            total = sum(m.size for m in members if m.isreg())
            if total > _MAX_EXTRACT_BYTES:
                raise RuntimeError(f"{archive.name} expands to {total} bytes "
                                   f"(> {_MAX_EXTRACT_BYTES}); refusing (bomb?).")
            tf.extractall(dest, filter="data")        # 3.12+ path-traversal guard
        return
    except tarfile.ReadError:
        pass                                          # not a tar -> try gzip below
    except (EOFError, tarfile.TarError, OSError) as e:
        raise RuntimeError(f"{archive.name} is a corrupt/truncated tar: {e}") from e
    # Not a tar: try a single gzipped member (arXiv's one-file submissions),
    # reading at most the cap + 1 byte so a gzip bomb can't exhaust memory.
    try:
        with gzip.open(archive, "rb") as f:
            data = f.read(_MAX_EXTRACT_BYTES + 1)
    except (OSError, EOFError) as e:
        raise RuntimeError(
            f"{archive.name} is neither a tar nor a readable gzip stream ({e}); "
            "the submission may be PDF-only (no LaTeX source).") from e
    if len(data) > _MAX_EXTRACT_BYTES:
        raise RuntimeError(f"{archive.name} decompresses beyond the size cap "
                           f"({_MAX_EXTRACT_BYTES}); refusing (bomb?).")
    if b"\\documentclass" not in data and b"\\begin{document}" not in data:
        raise RuntimeError(
            f"{archive.name} unpacked to a non-LaTeX file (PDF-only source?).")
    (dest / "main.tex").write_bytes(data)


# Files that are #included but are never themselves the driver.
_NOT_MAIN = re.compile(r"(authors?|affil|institut)", re.I)


def find_main_tex(src_dir: Path) -> Path:
    """Pick the driver .tex: the one with ``\\documentclass`` + ``\\begin{document}``.

    arXiv packages routinely ship the body split across ``\\input`` fragments
    (author lists, appendices); only the driver has ``\\begin{document}``.
    """
    texs = sorted(src_dir.rglob("*.tex"))
    if not texs:
        raise RuntimeError(f"no .tex file found under {src_dir}")
    scored: list[tuple[int, Path]] = []
    for t in texs:
        try:
            head = t.read_text("utf-8", errors="replace")
        except OSError:
            continue
        score = 0
        if "\\begin{document}" in head:
            score += 100
        if "\\documentclass" in head:
            score += 50
        if _NOT_MAIN.search(t.name):
            score -= 200
        score += min(len(head) // 4000, 20)          # tie-break: prefer the big one
        scored.append((score, t))
    if not scored:
        raise RuntimeError(f"no readable .tex file under {src_dir}")
    scored.sort(key=lambda x: (-x[0], len(str(x[1]))))
    best_score, best = scored[0]
    if best_score < 100:
        log.warning("no .tex has \\begin{document}; guessing main=%s", best.name)
    return best


def acquire_source(source: str, work_root: Path, *, fetcher: ArxivFetcher
                   ) -> LatexSource:
    """Resolve *source* (arXiv id/url or local path) to an unpacked LatexSource."""
    work_root = Path(work_root)
    arx = arxiv_id(source)

    if arx is None:
        # Local path: a .tex, a directory, or a tarball.
        p = Path(source).expanduser()
        if not p.exists():
            raise FileNotFoundError(
                f"{source!r} is neither an arXiv id/URL nor an existing path")
        doc_id = doc_id_for(None, p)
        if p.is_dir():
            return LatexSource(p, find_main_tex(p), doc_id, None, str(p))
        if p.suffix.lower() == ".tex":
            return LatexSource(p.parent, p, doc_id, None, str(p))
        dest = work_root / doc_id / "src"
        _extract(p, dest)
        return LatexSource(dest, find_main_tex(dest), doc_id, None, str(p))

    doc_id = doc_id_for(arx, None)
    archive = fetcher.download_eprint(arx)
    dest = work_root / doc_id / "src"
    # Re-extract only when empty (cheap idempotence; the tarball itself is cached).
    if not dest.is_dir() or not any(dest.rglob("*.tex")):
        _extract(archive, dest)
    return LatexSource(dest, find_main_tex(dest), doc_id, arx,
                       ARXIV_EPRINT.format(id=arx))
