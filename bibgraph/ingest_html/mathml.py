"""Convert presentation MathML to KaTeX-renderable LaTeX, via ``pandoc``.

This is a *fallback*: A&A (and most MathJax-rendered sites) expose the original
LaTeX directly (e.g. a ``data-latex`` attribute or a ``<annotation
encoding="application/x-tex">`` inside the MathML ``<semantics>``), which is
always preferred. Only when no source LaTeX is available do we hand the
presentation MathML to pandoc, which reads MathML embedded in HTML natively and
emits clean LaTeX (``\\frac``, ``^``, ``\\begin{array}`` …).
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess

log = logging.getLogger("bibgraph.html.mathml")

_PANDOC = shutil.which("pandoc")

# pandoc wraps display math in \[..\] and inline in \(..\); strip either.
_DELIMS = (("\\[", "\\]"), ("\\(", "\\)"), ("$$", "$$"), ("$", "$"))


def have_pandoc() -> bool:
    return _PANDOC is not None


def annotation_latex(math_el) -> str | None:
    """Original TeX from a MathML ``<annotation encoding="application/x-tex">``."""
    ann = math_el.find(
        "annotation", attrs={"encoding": ["application/x-tex", "application/x-latex"]}
    )
    if ann is None:
        # some emitters omit/spell the encoding differently
        for a in math_el.find_all("annotation"):
            enc = (a.get("encoding") or "").lower()
            if "tex" in enc:
                ann = a
                break
    if ann is not None:
        tex = ann.get_text().strip()
        return tex or None
    return None


def mathml_to_latex(math_html: str) -> str | None:
    """Convert one ``<math>...</math>`` HTML string to LaTeX (or None)."""
    if not _PANDOC or not math_html or "<math" not in math_html:
        return None
    doc = f"<!DOCTYPE html><html><body><p>{math_html}</p></body></html>"
    try:
        out = subprocess.run(
            [_PANDOC, "-f", "html", "-t", "latex"],
            input=doc, capture_output=True, text=True, timeout=20,
        )
    except Exception as e:                            # pragma: no cover
        log.warning("pandoc invocation failed: %s", e)
        return None
    if out.returncode != 0:
        log.debug("pandoc rc=%s: %s", out.returncode, out.stderr[:200])
        return None
    return _katexify(strip_math_delims(out.stdout.strip()))


# pandoc emits a few LaTeX commands KaTeX doesn't implement; map them to
# KaTeX-supported equivalents (spacing differences are cosmetic).
_MSPACE_RE = re.compile(r"\\mspace\s*\{[^}]*\}")


def _katexify(latex: str) -> str:
    latex = _MSPACE_RE.sub(r"\\;", latex)        # \mspace{6mu} -> \;
    latex = latex.replace("\\medspace", "\\;").replace("\\thickspace", "\\;")
    return latex


def strip_math_delims(latex: str) -> str:
    """Drop one layer of surrounding $/$$/\\[..\\]/\\(..\\) delimiters."""
    s = (latex or "").strip()
    for lo, hi in _DELIMS:
        if s.startswith(lo) and s.endswith(hi) and len(s) > len(lo) + len(hi):
            return s[len(lo):len(s) - len(hi)].strip()
    return s
