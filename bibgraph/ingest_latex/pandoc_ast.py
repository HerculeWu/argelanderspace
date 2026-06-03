"""Thin wrapper around the ``pandoc`` CLI for the LaTeX pipeline.

pandoc is the engine: it reads LaTeX (expanding the preamble's ``\\newcommand``
macros, following ``\\input``/``\\include``) and emits its document AST as JSON.
We run it from the *source directory* so relative ``\\input`` / ``\\includegraphics``
paths resolve. It also reads ``.bib`` into CSL-JSON, which we use to build the
reference list when a paper ships raw BibTeX rather than a compiled ``.bbl``.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from pathlib import Path

log = logging.getLogger("bibgraph.latex.pandoc")

_PANDOC = shutil.which("pandoc")


def have_pandoc() -> bool:
    return _PANDOC is not None


class PandocError(RuntimeError):
    """pandoc could not parse the LaTeX (hard syntax error, missing binary…)."""


def _run(args: list[str], *, cwd: Path | None = None, stdin: str | None = None,
         timeout: float = 180.0) -> str:
    if not _PANDOC:
        raise PandocError("pandoc is not installed (required for LaTeX ingest)")
    try:
        proc = subprocess.run(
            [_PANDOC, *args], cwd=str(cwd) if cwd else None,
            input=stdin, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as e:               # pragma: no cover
        raise PandocError(f"pandoc timed out after {timeout}s") from e
    if proc.returncode != 0:
        tail = (proc.stderr or "").strip().splitlines()
        raise PandocError("; ".join(tail[-3:]) or f"pandoc rc={proc.returncode}")
    if proc.stderr.strip():
        log.debug("pandoc warnings: %s", proc.stderr.strip()[:500])
    return proc.stdout


def latex_to_ast(main_tex: Path) -> dict:
    """Parse *main_tex* into the pandoc JSON AST (run from its source dir)."""
    main_tex = Path(main_tex)
    name = main_tex.name
    # './'-prefix so a filename starting with '-' can't be read as a pandoc flag.
    arg = f"./{name}" if name.startswith("-") else name
    out = _run(["-f", "latex", "-t", "json", arg], cwd=main_tex.parent)
    return json.loads(out)


def fragment_to_blocks(latex: str, src_dir: Path | None = None) -> list[dict]:
    """Convert a free-standing LaTeX *fragment* to a list of AST blocks.

    Used for class-specific constructs pandoc's article reader ignores (the A&A
    ``\\abstract{…}`` command). Wrapped in a minimal article so ``$…$`` maths
    and ``\\cite`` keys still parse; run from *src_dir* so any ``\\input`` works.
    """
    doc = ("\\documentclass{article}\\usepackage{amsmath}"
           "\\begin{document}\n" + latex + "\n\\end{document}\n")
    try:
        out = _run(["-f", "latex", "-t", "json"], cwd=src_dir, stdin=doc)
    except PandocError as e:
        log.warning("abstract fragment did not parse: %s", e)
        return []
    return json.loads(out).get("blocks", [])


def bibtex_to_csl(bib_files: list[Path], src_dir: Path | None = None
                  ) -> list[dict]:
    """Read one or more ``.bib`` files into CSL-JSON entries (keyed by ``id``)."""
    # Absolute paths: bib files are resolved against CWD, not src_dir.
    files = [str(Path(p).resolve()) for p in bib_files if Path(p).is_file()]
    if not files:
        return []
    try:
        out = _run(["-f", "bibtex", "-t", "csljson", *files], cwd=src_dir)
    except PandocError as e:
        log.warning("bibtex -> csljson failed: %s", e)
        return []
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return []
