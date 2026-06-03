"""Resolve and rasterise ``\\includegraphics`` targets for the web reader.

arXiv figures are usually *vector* (PDF, occasionally EPS/PS) which a browser
``<img>`` cannot display, so we flatten them to PNG — PDF via PyMuPDF, EPS/PS via
Ghostscript — at a configurable DPI, capped to a sane pixel size. Already-raster
figures (PNG/JPG/…) are copied through. Output lands in the doc's ``assets/``
dir and is served by ``/images/<doc_id>/<file>`` exactly like the other pipelines.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("bibgraph.latex.assets")

_RASTER = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
_VECTOR_PDF = {".pdf"}
_VECTOR_EPS = {".eps", ".ps"}
# Extensions \includegraphics omits, in the order TeX would try them.
_TRY_EXT = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps", ".gif", ".PDF", ".PNG"]
_GS = shutil.which("gs")


def _within(base: Path, p: Path) -> bool:
    """True if *p* really resolves inside *base* (blocks ../ and symlink escape)."""
    try:
        return p.resolve().is_relative_to(base.resolve())
    except (OSError, ValueError):
        return False


class AssetResolver:
    """Resolves a graphics path argument to a served PNG basename (cached)."""

    def __init__(self, src_dir: Path, asset_dir: Path, *, dpi: int = 200,
                 max_px: int = 2200, enabled: bool = True):
        self.src_dir = Path(src_dir)
        self.asset_dir = Path(asset_dir)
        self.dpi = dpi
        self.max_px = max_px
        self.enabled = enabled
        self._cache: dict[str, str | None] = {}
        self._by_name: dict[str, Path] | None = None

    # -- locate ------------------------------------------------------------- #
    def _index(self) -> dict[str, Path]:
        if self._by_name is None:
            self._by_name = {}
            for p in self.src_dir.rglob("*"):
                if p.is_file():
                    self._by_name.setdefault(p.name, p)
                    self._by_name.setdefault(p.stem, p)
        return self._by_name

    def _locate(self, arg: str) -> Path | None:
        arg = arg.strip().strip('"').replace("\\", "/")
        cand = (self.src_dir / arg)
        if cand.is_file():
            return cand
        for ext in _TRY_EXT:
            if (self.src_dir / (arg + ext)).is_file():
                return self.src_dir / (arg + ext)
        # last resort: match by basename anywhere in the tree
        idx = self._index()
        return idx.get(Path(arg).name) or idx.get(Path(arg).stem)

    # -- public ------------------------------------------------------------- #
    def image(self, arg: str) -> str | None:
        """Return a basename under ``assets/`` for *arg*, or None if unusable."""
        if not arg or not self.enabled:
            return None
        if arg in self._cache:
            return self._cache[arg]
        out = self._resolve(arg)
        self._cache[arg] = out
        return out

    def _out_name(self, src: Path, suffix: str) -> str:
        rel = src.relative_to(self.src_dir) if self.src_dir in src.parents \
            else Path(src.name)
        # Encode the source extension so e.g. fig.pdf and fig.png (which the
        # reader resolves by basename) can't collide onto one output file.
        stem = str(rel.with_suffix("")).replace("/", "__")
        ext = src.suffix.lstrip(".").lower() or "img"
        return f"{stem}__{ext}{suffix}"

    def _resolve(self, arg: str) -> str | None:
        src = self._locate(arg)
        if src is None:
            log.debug("figure not found: %s", arg)
            return None
        # A \includegraphics path must stay inside the source tree — never let a
        # crafted "../../etc/x" disclose a host file through the /images route.
        if not _within(self.src_dir, src):
            log.warning("figure path escapes source tree, ignored: %s", arg)
            return None
        ext = src.suffix.lower()
        try:
            self.asset_dir.mkdir(parents=True, exist_ok=True)
            if ext in _RASTER:
                dest = self.asset_dir / self._out_name(src, src.suffix.lower())
                if not (dest.is_file() and dest.stat().st_size > 0):
                    shutil.copyfile(src, dest)
                return dest.name
            dest = self.asset_dir / self._out_name(src, ".png")
            if dest.is_file() and dest.stat().st_size > 0:
                return dest.name
            if ext in _VECTOR_PDF and self._pdf_to_png(src, dest):
                return dest.name
            if ext in _VECTOR_EPS and self._eps_to_png(src, dest):
                return dest.name
            log.warning("unhandled figure type %s (%s)", ext, src.name)
        except Exception as e:                           # never abort ingest on a figure
            log.warning("rasterise failed for %s: %s", src.name, e)
        return None

    # -- converters --------------------------------------------------------- #
    def _zoom_for(self, w_pt: float, h_pt: float) -> float:
        zoom = self.dpi / 72.0
        longest = max(w_pt, h_pt) * zoom
        if longest > self.max_px and max(w_pt, h_pt) > 0:
            zoom = self.max_px / max(w_pt, h_pt)
        return zoom

    def _pdf_to_png(self, src: Path, dest: Path) -> bool:
        import fitz                                       # PyMuPDF (already a dep)
        with fitz.open(src) as doc:
            if doc.page_count == 0:
                return False
            page = doc.load_page(0)
            r = page.rect
            zoom = self._zoom_for(r.width, r.height)
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
            tmp = dest.parent / (dest.name + ".part")
            tmp.write_bytes(pix.tobytes("png"))
            tmp.replace(dest)
        return dest.is_file() and dest.stat().st_size > 0

    def _eps_to_png(self, src: Path, dest: Path) -> bool:
        if not _GS:
            log.warning("Ghostscript not found; cannot rasterise %s", src.name)
            return False
        tmp = dest.parent / (dest.name + ".part")
        proc = subprocess.run(
            [_GS, "-q", "-dSAFER", "-dBATCH", "-dNOPAUSE", "-dEPSCrop",
             "-sDEVICE=png16m", f"-r{self.dpi}", f"-sOutputFile={tmp}",
             str(src.resolve())],          # absolute path: never flag-like ('-…')
            capture_output=True, text=True, timeout=120)
        if proc.returncode != 0 or not tmp.is_file():
            log.warning("gs failed on %s: %s", src.name, proc.stderr[-200:])
            return False
        tmp.replace(dest)
        return dest.stat().st_size > 0
