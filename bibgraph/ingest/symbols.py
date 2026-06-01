"""Lightweight symbol inventory.

Collects the *atomic* math symbols that appear in display equations and inline
math (``$...$`` / ``\\(...\\)``) and reports them deduplicated, with their
occurrences and total count. This is intentionally shallow: no attempt is made
to infer a symbol's meaning/definition (that was deferred to a later phase).
"""

from __future__ import annotations

import re
from typing import Iterable

from ..schema import Document, EquationBlock, Symbol, SymbolOccurrence

# Inline math: single $...$ (not $$) or \( ... \)
INLINE_MATH_RE = re.compile(r"(?<!\$)\$([^$]+?)\$(?!\$)|\\\((.+?)\\\)", re.S)

# brace group tolerating one level of nesting, e.g. {n_{i}}
_BRACE = r"\{(?:[^{}]|\{[^{}]*\})*\}"
_ATOMARG = r"(?:" + _BRACE + r"|\\[A-Za-z]+|[A-Za-z0-9])"
# any run of sub/superscripts, e.g. _{rot}^2
_SUPSUB = r"(?:[_^]" + _ATOMARG + r")*"

# Accents / font wrappers that bind to a following atom (+ its sub/superscripts),
# e.g. \hat{x}, \bar v, \mathbf{x}^2, \hat{v}_{rot}.
ACCENT_RE = re.compile(
    r"\\(hat|widehat|bar|overline|vec|tilde|dot|ddot|check|acute|grave"
    r"|mathbf|mathrm|mathcal|mathbb|mathit|mathsf|mathfrak|boldsymbol)\s*"
    r"(" + _BRACE + r"|\\[A-Za-z]+|[A-Za-z0-9])"
    r"(" + _SUPSUB + r")")

# A base atom (greek/macro or single latin letter) + any sub/superscripts.
_BASE = r"(?:\\[A-Za-z]+|[A-Za-z])"
TOKEN_RE = re.compile(_BASE + _SUPSUB)

# Macros that are operators / functions / layout — never variables.
_EXCLUDE = {
    "frac", "dfrac", "tfrac", "cfrac", "sum", "prod", "int", "iint", "iiint",
    "oint", "lim", "limsup", "liminf", "sqrt", "left", "right", "big", "Big",
    "bigg", "Bigg", "cdot", "cdots", "ldots", "dots", "vdots", "ddots",
    "times", "div", "pm", "mp", "ast", "star", "circ", "bullet",
    "approx", "sim", "simeq", "cong", "propto", "equiv", "leq", "geq", "neq",
    "ll", "gg", "to", "rightarrow", "leftarrow", "Rightarrow", "Leftarrow",
    "leftrightarrow", "mapsto", "implies", "iff", "in", "notin", "ni",
    "subset", "supset", "subseteq", "cup", "cap", "setminus", "emptyset",
    "forall", "exists", "nexists", "neg", "land", "lor", "wedge", "vee",
    "log", "ln", "lg", "exp", "sin", "cos", "tan", "cot", "sec", "csc",
    "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan", "max", "min",
    "arg", "det", "dim", "deg", "gcd", "Pr", "sup", "inf", "mod", "bmod",
    "quad", "qquad", "label", "tag", "nonumber", "begin", "end", "text",
    "textrm", "textbf", "textit", "operatorname", "mathop", "displaystyle",
    "scriptstyle", "nabla", "partial", "infty", "ldotp", "colon", "mid",
    "langle", "rangle", "lvert", "rvert", "lVert", "rVert", "vert", "Vert",
    "prime", "ddagger", "dagger", "sum_", "over",
}
# Single-letter function-ish names we still keep (variables) — none excluded.


def _strip_math_delims(s: str) -> str:
    s = s.strip()
    for a, b in (("$$", "$$"), ("\\[", "\\]"), ("\\(", "\\)"), ("$", "$")):
        if s.startswith(a) and s.endswith(b) and len(s) > len(a) + len(b) - 1:
            s = s[len(a):len(s) - len(b)]
            break
    return s.strip()


def _norm(sym: str) -> str:
    return re.sub(r"\s+", "", sym)


def _atoms(latex: str) -> list[str]:
    """Return the list of atomic symbol strings found in *latex*."""
    out: list[str] = []
    work = latex

    # 1) accent / font-wrapped atoms first (and blank them out)
    def _accent_sub(m: re.Match) -> str:
        out.append(_norm(f"\\{m.group(1)}{m.group(2)}{m.group(3)}"))
        return " " * len(m.group(0))

    work = ACCENT_RE.sub(_accent_sub, work)

    # 2) remaining base + sub/superscript atoms
    for m in TOKEN_RE.finditer(work):
        tok = m.group(0)
        base = tok.lstrip("\\").split("_")[0].split("^")[0]
        macro = re.match(r"\\([A-Za-z]+)", tok)
        if macro and macro.group(1) in _EXCLUDE:
            continue
        if not macro and tok and tok[0].isdigit():
            continue
        if not re.search(r"[A-Za-z]", tok):
            continue
        out.append(_norm(tok))
    return out


def _math_sources(doc: Document) -> Iterable[tuple[str, str, str, int | None]]:
    """Yield (latex, source_kind, block_id, page_idx)."""
    for b in doc.iter_blocks():
        if isinstance(b, EquationBlock) and b.latex:
            yield _strip_math_delims(b.latex), "equation", b.id, b.page_idx
        # inline math inside paragraph bodies / captions / list items
        for holder_text in _holder_texts(b):
            for m in INLINE_MATH_RE.finditer(holder_text):
                frag = m.group(1) or m.group(2) or ""
                if frag.strip():
                    yield frag, "inline", b.id, b.page_idx


def _holder_texts(block) -> list[str]:
    texts: list[str] = []
    if getattr(block, "text", None):
        texts.append(block.text)
    cap = getattr(block, "caption", None)
    if cap is not None and cap.text:
        texts.append(cap.text)
    for it in getattr(block, "items", []) or []:
        if it.text:
            texts.append(it.text)
    return texts


def extract_symbols(doc: Document, max_occ_per_symbol: int = 50) -> list[Symbol]:
    registry: dict[str, Symbol] = {}
    seen_block: dict[str, set[str]] = {}
    for latex, kind, block_id, page in _math_sources(doc):
        for atom in _atoms(latex):
            sym = registry.get(atom)
            if sym is None:
                sym = Symbol(symbol=atom, count=0, occurrences=[])
                registry[atom] = sym
                seen_block[atom] = set()
            sym.count += 1
            key = f"{block_id}:{kind}"
            if key not in seen_block[atom] and len(sym.occurrences) < max_occ_per_symbol:
                seen_block[atom].add(key)
                sym.occurrences.append(
                    SymbolOccurrence(block_id=block_id, page_idx=page, source=kind))
    return sorted(registry.values(), key=lambda s: (-s.count, s.symbol))


def fill_equation_symbols(doc: Document) -> None:
    """Populate each EquationBlock.symbols with its deduplicated atoms."""
    for b in doc.iter_blocks():
        if isinstance(b, EquationBlock) and b.latex:
            seen: set[str] = set()
            atoms: list[str] = []
            for a in _atoms(_strip_math_delims(b.latex)):
                if a not in seen:
                    seen.add(a)
                    atoms.append(a)
            b.symbols = atoms
