"""Build the reference list for an arXiv LaTeX source.

A paper resolves its citations one of two ways, and we mirror both:

* a **compiled** bibliography — a ``.bbl`` file or an inline
  ``\\begin{thebibliography}`` — whose ``\\bibitem[…]{key}`` entries are exactly
  the cited works (BibTeX already pruned the rest);
* a **raw** ``.bib`` + ``\\bibliography{…}``, which we read with pandoc into
  CSL-JSON and then prune down to the keys actually cited.

Either way the crucial output is the ``key -> ref-id`` map: the AST walker turns
each ``\\cite`` key into the matching ``[[cite:ref-N]]`` token *authoritatively*,
with no author-year guessing.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

from ..ingest.references import _match_keys, _parse_one
from ..schema import Reference
from .pandoc_ast import bibtex_to_csl

log = logging.getLogger("bibgraph.latex.references")

# AAS / common astronomy journal-abbreviation macros (aastex, mn2e, aa.bst).
_JOURNAL_MACROS = {
    "aj": "AJ", "araa": "ARA&A", "apj": "ApJ", "apjl": "ApJL", "apjs": "ApJS",
    "ao": "Appl. Opt.", "apss": "Ap&SS", "aap": "A&A", "aapr": "A&A Rev.",
    "aaps": "A&AS", "azh": "AZh", "baas": "BAAS", "jrasc": "JRASC",
    "memras": "MmRAS", "mnras": "MNRAS", "pra": "Phys. Rev. A",
    "prb": "Phys. Rev. B", "prc": "Phys. Rev. C", "prd": "Phys. Rev. D",
    "pre": "Phys. Rev. E", "prl": "Phys. Rev. Lett.", "pasp": "PASP",
    "pasj": "PASJ", "qjras": "QJRAS", "skytel": "S&T", "solphys": "Sol. Phys.",
    "sovast": "Soviet Astron.", "ssr": "Space Sci. Rev.", "zap": "ZAp",
    "nat": "Nature", "iaucirc": "IAU Circ.", "aplett": "Astrophys. Lett.",
    "bain": "BAN", "grl": "Geophys. Res. Lett.", "jgr": "J. Geophys. Res.",
    "memsai": "Mem. Soc. Astron. Italiana", "physrep": "Phys. Rep.",
    "planss": "Planet. Space Sci.", "procspie": "Proc. SPIE", "nphysa": "Nucl. Phys. A",
}
_JOURNAL_RE = re.compile(
    r"\\(" + "|".join(sorted(_JOURNAL_MACROS, key=len, reverse=True)) + r")\b")
_FORMAT_CMD_RE = re.compile(
    r"\\(?:textit|textbf|textsc|textrm|emph|mbox|text|hbox|it|bf|natexlab)\s*\{")


# --------------------------------------------------------------------------- #
# Locating the bibliography
# --------------------------------------------------------------------------- #

def _find_bbl(main_tex: Path, src_dir: Path, raw: str) -> str | None:
    """The compiled bibliography text, from a ``.bbl`` file or inline env."""
    cand = main_tex.with_suffix(".bbl")
    if cand.is_file():
        return cand.read_text("utf-8", errors="replace")
    # prefer a .bbl next to the main file before falling back to a deep glob
    bbls = sorted(main_tex.parent.glob("*.bbl")) or sorted(src_dir.rglob("*.bbl"))
    if bbls:
        return bbls[0].read_text("utf-8", errors="replace")
    m = re.search(r"\\begin\{thebibliography\}(.*?)\\end\{thebibliography\}",
                  raw, re.S)
    return m.group(1) if m else None


def _bib_files(main_tex: Path, src_dir: Path, raw: str) -> list[Path]:
    """``.bib`` files named by ``\\bibliography{a,b}`` (or every .bib as fallback)."""
    names: list[str] = []
    for m in re.finditer(r"\\bibliography\{([^}]*)\}", raw):
        names += [n.strip() for n in m.group(1).split(",") if n.strip()]
    files: list[Path] = []
    for n in names:
        p = (src_dir / n)
        p = p if p.suffix == ".bib" else p.with_suffix(".bib")
        # \bibliography{../../secrets} must not read outside the source tree.
        if p.is_file() and _within(src_dir, p):
            files.append(p)
    return files or sorted(src_dir.rglob("*.bib"))


def _within(base: Path, p: Path) -> bool:
    try:
        return p.resolve().is_relative_to(base.resolve())
    except (OSError, ValueError):
        return False


# --------------------------------------------------------------------------- #
# Cleaning a \bibitem body
# --------------------------------------------------------------------------- #

def _balanced(s: str, i: int, lo: str, hi: str) -> tuple[str, int] | None:
    """If ``s[i]==lo``, return (inner, index-after-matching-hi); else None."""
    if i >= len(s) or s[i] != lo:
        return None
    depth = 0
    for j in range(i, len(s)):
        if s[j] == lo:
            depth += 1
        elif s[j] == hi:
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
    return s[i + 1:], len(s)


def _clean_bbl_text(s: str) -> str:
    """Turn a raw ``\\bibitem`` body into readable text (preserving DOI/arXiv)."""
    s = s.replace("\\newblock", " ").replace("\\nobreak", " ")
    s = _JOURNAL_RE.sub(lambda m: _JOURNAL_MACROS[m.group(1)], s)
    s = re.sub(r"\\doi\s*\{([^}]*)\}", r" doi:\1 ", s)
    s = re.sub(r"\\href\s*\{[^}]*\}\s*\{([^}]*)\}", r"\1", s)
    s = re.sub(r"\\url\s*\{([^}]*)\}", r"\1", s)
    s = re.sub(r"\\eprint\s*\{([^}]*)\}", r"arXiv:\1", s)
    # unwrap formatting commands \textit{...} -> ... (a few passes for nesting)
    for _ in range(4):
        new = _strip_one_format(s)
        if new == s:
            break
        s = new
    s = s.replace("\\&", "&").replace("~", " ").replace("\\ ", " ")
    s = re.sub(r"\\[a-zA-Z]+\b", " ", s)              # drop remaining commands
    s = s.replace("{", "").replace("}", "")
    return re.sub(r"\s+", " ", s).strip(" ,.;")


def _strip_one_format(s: str) -> str:
    out, i = [], 0
    while i < len(s):
        m = _FORMAT_CMD_RE.match(s, i)
        if m:
            inner = _balanced(s, m.end() - 1, "{", "}")
            if inner is not None:
                out.append(inner[0])
                i = inner[1]
                continue
        out.append(s[i])
        i += 1
    return "".join(out)


_DOI_URL_RE = re.compile(r"https?://(?:dx\.)?doi\.org/(10\.\d{4,9}/\S+)", re.I)


def _parse_bibitems(bbl: str, start: int = 1) -> list[tuple[str, str, str | None]]:
    """Return ``[(key, clean_text, opt_label), …]`` from a bibliography body."""
    out: list[tuple[str, str, str | None]] = []
    marks = [m.start() for m in re.finditer(r"\\bibitem", bbl)]
    for idx, pos in enumerate(marks):
        i = pos + len("\\bibitem")
        while i < len(bbl) and bbl[i] in " \t\r\n":
            i += 1
        opt = _balanced(bbl, i, "[", "]")
        label = None
        if opt is not None:
            label, i = _clean_bbl_text(opt[0]) or None, opt[1]
            while i < len(bbl) and bbl[i] in " \t\r\n":
                i += 1
        key_grp = _balanced(bbl, i, "{", "}")
        if key_grp is None:
            continue
        key = key_grp[0].strip()
        body_start = key_grp[1]
        body_end = marks[idx + 1] if idx + 1 < len(marks) else len(bbl)
        body = _clean_bbl_text(bbl[body_start:body_end])
        if key and body:
            out.append((key, body, label))
    return out


# --------------------------------------------------------------------------- #
# CSL-JSON -> Reference
# --------------------------------------------------------------------------- #

def _csl_year(entry: dict) -> int | None:
    parts = (entry.get("issued") or {}).get("date-parts") or []
    if parts and parts[0]:
        try:
            return int(parts[0][0])
        except (ValueError, TypeError):
            return None
    return None


def _csl_authors(entry: dict) -> list[str]:
    out: list[str] = []
    for a in entry.get("author") or []:
        name = a.get("family") or a.get("literal") or ""
        if name:
            out.append(name.strip())
    return out


def _ref_from_csl(ref_id: str, entry: dict) -> Reference:
    authors = _csl_authors(entry)
    year = _csl_year(entry)
    title = entry.get("title")
    venue = entry.get("container-title") or None
    url = entry.get("URL")
    arxiv = None
    if url:
        m = re.search(r"arxiv\.org/abs/([^\s/]+)", url, re.I)
        if m:
            arxiv = m.group(1)
    raw_bits = [", ".join(authors), str(year) if year else "", title or "",
                venue or "", entry.get("volume") or "", entry.get("page") or ""]
    raw = ", ".join(b for b in raw_bits if b)
    return Reference(
        id=ref_id, raw=raw, authors=authors, year=year, title=title,
        venue=venue, volume=entry.get("volume"), pages=entry.get("page"),
        doi=entry.get("DOI"), arxiv_id=arxiv, url=url,
        keys=_match_keys(authors, year, None))


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def build_references(main_tex: Path, src_dir: Path, raw: str,
                     cited_order: list[str]) -> tuple[list[Reference], dict[str, str]]:
    """Return ``(references, key->ref_id)``.

    *cited_order* is the cite keys in first-appearance order (used to order and
    prune the raw-.bib path; the compiled-.bbl path is kept verbatim)."""
    bbl = _find_bbl(main_tex, src_dir, raw)
    refs: list[Reference] = []
    key_to_id: dict[str, str] = {}

    if bbl and "\\bibitem" in bbl:
        for i, (key, text, label) in enumerate(_parse_bibitems(bbl), start=1):
            rid = f"ref-{i}"
            ref = _parse_one(rid, text, label)
            ref.keys = list(dict.fromkeys([*ref.keys]))  # author-year forms only
            refs.append(ref)
            key_to_id[key] = rid
        log.info("references: %d from compiled bibliography", len(refs))
        return refs, key_to_id

    csl = bibtex_to_csl(_bib_files(main_tex, src_dir, raw), src_dir)
    if csl:
        by_key = {e.get("id"): e for e in csl if e.get("id")}
        cited = [k for k in cited_order if k in by_key]
        # keep only cited entries (same set the .bbl path would have), in cite order
        for i, key in enumerate(cited, start=1):
            rid = f"ref-{i}"
            refs.append(_ref_from_csl(rid, by_key[key]))
            key_to_id[key] = rid
        log.info("references: %d cited of %d in .bib", len(refs), len(by_key))
        return refs, key_to_id

    log.warning("no bibliography found (.bbl / thebibliography / .bib)")
    return refs, key_to_id
