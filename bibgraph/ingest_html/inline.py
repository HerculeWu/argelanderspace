"""Turn a run of inline publisher HTML into body text + occurrence records.

Publisher HTML mixes, inside a single paragraph: plain text, prose italics
(journal/object names), real inline math (single-letter italic variables,
``<sub>``/``<sup>``), footnote markers (``<sup><a href="#FN..">``), and — most
valuable — citation / cross-reference anchors (``<a href="#R26">``,
``<a href="#F1">``). We:

* tokenise citation/cross-ref anchors *authoritatively* (the ``href`` says
  exactly which reference/float they point at — no regex guessing), recording
  their character span so the pipeline can splice ``[[cite:..]]`` / ``[[xref:..]]``
  tokens and run the regex detector only as a fallback for *unlinked* mentions;
* render clear inline math (sub/sup + single-letter variables) into ``$...$``
  KaTeX fragments — conservatively, so prose italics stay plain text and we
  never emit invalid LaTeX;
* drop footnote markers and keep only the visible text of external links.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Callable

from bs4 import NavigableString, Tag

from ..schema import CitationOccurrence, CrossRefOccurrence
from ..ingest.annotate import Match

# Tags that never carry body math; flatten to their text.
_PROSE_TAGS = {"b", "strong", "em", "span", "abbr", "cite", "u", "small", "tt"}
# A single math variable: one latin/greek letter (optionally primed). The range
# covers Greek + Greek-extended incl. variant glyphs (ϵ U+03F5, ϕ U+03D5, …).
_VAR_RE = re.compile(r"^[A-Za-zͰ-Ͽἀ-῿](?:['′])?$")
# A trailing token usable as a sub/sup base in surrounding plain text.
_BASE_RE = re.compile(r"([A-Za-z]+|\d+(?:\.\d+)?)$")
_MULTI_ALPHA = re.compile(r"[A-Za-z]{2,}$")
_GREEK = {
    "α": r"\alpha", "β": r"\beta", "γ": r"\gamma", "δ": r"\delta",
    "ε": r"\epsilon", "ζ": r"\zeta", "η": r"\eta", "θ": r"\theta",
    "ι": r"\iota", "κ": r"\kappa", "λ": r"\lambda", "μ": r"\mu",
    "ν": r"\nu", "ξ": r"\xi", "π": r"\pi", "ρ": r"\rho", "σ": r"\sigma",
    "ς": r"\varsigma", "τ": r"\tau", "υ": r"\upsilon", "φ": r"\phi",
    "χ": r"\chi", "ψ": r"\psi", "ω": r"\omega", "Γ": r"\Gamma",
    "Δ": r"\Delta", "Θ": r"\Theta", "Λ": r"\Lambda", "Π": r"\Pi",
    "Σ": r"\Sigma", "Φ": r"\Phi", "Ψ": r"\Psi", "Ω": r"\Omega",
    # variant glyphs (Greek-extended block, used in scientific typography)
    "ϵ": r"\epsilon", "ϕ": r"\phi", "ϑ": r"\vartheta", "ϖ": r"\varpi",
    "ϱ": r"\varrho", "ϐ": r"\beta", "ϰ": r"\varkappa",
}


def _norm_ws(s: str) -> str:
    """Collapse runs of any whitespace (incl. NBSP) to a single ASCII space."""
    return re.sub(r"\s+", " ", s.replace("\xa0", " ").replace(" ", " "))


# Unicode math symbols KaTeX can't render in text mode -> LaTeX commands.
_MATH_UNICODE = {
    "‖": r"\Vert ", "×": r"\times ", "·": r"\cdot ", "−": "-", "∼": r"\sim ",
    "≈": r"\approx ", "≃": r"\simeq ", "≤": r"\le ", "≥": r"\ge ", "≪": r"\ll ",
    "≫": r"\gg ", "≠": r"\ne ", "⊙": r"\odot ", "⊕": r"\oplus ", "∘": r"\circ ",
    "°": r"^{\circ}", "±": r"\pm ", "∓": r"\mp ", "→": r"\to ", "∞": r"\infty ",
    "∝": r"\propto ", "⟨": r"\langle ", "⟩": r"\rangle ", "′": "'", "″": "''",
    "…": r"\dots ", "⋆": r"\star ", "∥": r"\parallel ", "⊥": r"\perp ",
}


def _sanitize_math(s: str) -> str:
    """Make a math snippet safe for KaTeX: escape comment/special chars and map
    unicode operators that have no text-mode glyph."""
    for u, tex in _MATH_UNICODE.items():
        s = s.replace(u, tex)
    s = re.sub(r"(?<!\\)%", r"\\%", s)     # % starts a LaTeX comment otherwise
    s = re.sub(r"(?<!\\)#", r"\\#", s)
    return re.sub(r"\s{2,}", " ", s).strip()


@dataclass
class AnchorTarget:
    """How an in-text ``<a href="#..">`` should be treated."""

    role: str                       # cite | xref | footnote | external | ignore
    ref_id: str | None = None       # for cite
    target_id: str | None = None    # for xref
    xref_kind: str | None = None    # figure|table|equation|section|appendix


# resolver: fragment ("R26"/"F1"/"FD1"/"S7"/"APP1"/"FN4") -> AnchorTarget|None
AnchorResolver = Callable[[str], "AnchorTarget | None"]


@dataclass
class InlineContext:
    resolve: AnchorResolver
    inline_math: str = "conservative"


# --------------------------------------------------------------------------- #
# Flatten the inline DOM into a list of atoms
# --------------------------------------------------------------------------- #

@dataclass
class _Atom:
    t: str                  # text | var | sub | sup | math | anchor
    s: str = ""             # text / latex / visible text
    raw: str = ""           # sub/sup: plain inner text (used when not mathified)
    role: str | None = None
    ref_id: str | None = None
    target_id: str | None = None
    xref_kind: str | None = None


def _frag(href: str) -> str | None:
    if not href:
        return None
    i = href.find("#")
    return href[i + 1:] if i >= 0 else None


def _is_footnote_sup(tag: Tag) -> bool:
    """A <sup>/<sub> whose only real content is a footnote anchor."""
    links = tag.find_all("a")
    if not links:
        return False
    return all((_frag(a.get("href", "")) or "").upper().startswith(("FN", "EN"))
               for a in links)


def _inner_latex(node: Tag) -> str:
    """Render the inside of a sub/sup to a latex-ish snippet (no $)."""
    txt = node.get_text().strip()
    txt = _GREEK.get(txt, txt)
    txt = txt.replace("\xa0", "").replace(" ", "")
    txt = _sanitize_math(txt)
    if re.fullmatch(r"[A-Za-z]{2,}", txt):
        return r"\mathrm{%s}" % txt
    return txt


def _var_latex(s: str) -> str:
    return _sanitize_math(_GREEK.get(s, s))


def _inline_math_latex(el: Tag) -> str:
    """LaTeX for an inline formula span: prefer pandoc(MathML) (KaTeX-clean),
    else the (sanitised) ``data-latex`` attribute."""
    from .mathml import mathml_to_latex, strip_math_delims
    math = el.find("math")
    if math is not None:
        tex = mathml_to_latex(str(math))
        if tex:
            return tex
    dl = el.get("data-latex")
    return _sanitize_math(strip_math_delims(dl)) if dl else ""


def _flatten(node, ctx: InlineContext, atoms: list[_Atom]) -> None:
    for child in node.children:
        _flatten_child(child, ctx, atoms)


def _flatten_child(child, ctx: InlineContext, atoms: list[_Atom]) -> None:
    if isinstance(child, NavigableString):
        atoms.append(_Atom("text", str(child)))
        return
    if not isinstance(child, Tag):
        return
    name = child.name.lower()
    classes = child.get("class") or []

    if name == "a":
        _flatten_anchor(child, ctx, atoms)
        return
    if name in ("sub", "sup"):
        if _is_footnote_sup(child):
            return                                    # drop footnote markers
        raw = re.sub(r"\s+", "", child.get_text())    # plain fallback form
        atoms.append(_Atom(name, _inner_latex(child), raw=raw))
        return
    if name in ("i", "var"):
        inner = child.get_text()
        stripped = inner.strip()
        if ctx.inline_math != "plain" and _VAR_RE.match(stripped):
            atoms.append(_Atom("var", _var_latex(stripped)))
        else:
            atoms.append(_Atom("text", inner))        # prose italics -> plain
        return
    if name == "br":
        atoms.append(_Atom("text", " "))
        return
    if name in ("script", "style"):
        return
    # Inline formula span (data-latex). Block equations (ressouce-equation-block)
    # are handled as standalone EquationBlocks by the adapter and never reach here.
    if child.get("data-latex") and "ressouce-equation-block" not in classes:
        if ctx.inline_math != "plain":
            latex = _inline_math_latex(child)
            if latex:
                atoms.append(_Atom("math", latex))
        return
    # everything else: recurse so we never drop its text
    _flatten(child, ctx, atoms)


def _flatten_anchor(a: Tag, ctx: InlineContext, atoms: list[_Atom]) -> None:
    visible = a.get_text()
    frag = _frag(a.get("href", ""))
    if not visible.strip():
        return                                        # empty back-ref anchor
    tgt = ctx.resolve(frag) if frag else None
    if tgt is None:
        atoms.append(_Atom("text", visible))          # external/unknown: text only
        return
    if tgt.role == "cite":
        atoms.append(_Atom("anchor", visible, role="cite", ref_id=tgt.ref_id))
    elif tgt.role == "xref":
        atoms.append(_Atom("anchor", visible, role="xref",
                           target_id=tgt.target_id, xref_kind=tgt.xref_kind))
    elif tgt.role in ("footnote", "ignore"):
        return
    else:
        atoms.append(_Atom("text", visible))


# --------------------------------------------------------------------------- #
# Assemble atoms -> (text, anchor matches)
# --------------------------------------------------------------------------- #

@dataclass
class _Seg:
    kind: str               # plain | math | anchor
    s: str = ""
    atom: _Atom | None = None


def _emit_plain(segs: list[_Seg], s: str) -> None:
    if not s:
        return
    if segs and segs[-1].kind == "plain":
        segs[-1].s += s
    else:
        segs.append(_Seg("plain", s))


def _attach_subsup(segs: list[_Seg], atom: _Atom, plain_base_ok: bool) -> None:
    """Attach a sub/sup atom to a base, mutating *segs*.

    A sub/sup on an explicit math base (a variable) is always attached. Pulling a
    base out of surrounding *plain* prose is only done at a word boundary
    (``plain_base_ok``): otherwise ``value<sub>2</sub>here`` would wrongly become
    ``$\\mathrm{value}_{2}$here`` instead of the plain ``value2here``. When not
    attached, the sub/sup's plain text is kept inline so no content is lost."""
    if not atom.s:
        return
    op = "_" if atom.t == "sub" else "^"
    frag = "%s{%s}" % (op, atom.s)
    if segs and segs[-1].kind == "math":
        segs[-1].s += frag
        return
    if plain_base_ok and segs and segs[-1].kind == "plain":
        m = _BASE_RE.search(segs[-1].s)
        if m and segs[-1].s.endswith(m.group(0)):
            base = m.group(0)
            segs[-1].s = segs[-1].s[: len(segs[-1].s) - len(base)]
            if not segs[-1].s:
                segs.pop()
            blatex = (r"\mathrm{%s}" % base) if _MULTI_ALPHA.fullmatch(base) else base
            segs.append(_Seg("math", blatex + frag))
            return
    # no usable base / mid-word: keep the sub/sup's *plain* text, no math.
    _emit_plain(segs, atom.raw or atom.s)


def render_inline(node, ctx: InlineContext) -> tuple[str, list[Match]]:
    """Render an inline-bearing element to ``(text, anchor_matches)``.

    *node* is a BeautifulSoup element (its children are walked) or a list of
    sibling nodes (used when a paragraph is split around block equations)."""
    atoms: list[_Atom] = []
    if isinstance(node, (list, tuple)):
        for n in node:
            _flatten_child(n, ctx, atoms)
    else:
        _flatten(node, ctx, atoms)

    segs: list[_Seg] = []
    for i, a in enumerate(atoms):
        if a.t == "text":
            _emit_plain(segs, a.s)
        elif a.t == "var":
            if segs and segs[-1].kind == "math":
                segs[-1].s += a.s                     # adjacent vars coalesce
            else:
                segs.append(_Seg("math", a.s))
        elif a.t == "math":
            segs.append(_Seg("math", a.s))
        elif a.t in ("sub", "sup"):
            # Only pull a base out of plain prose at a word boundary: if the very
            # next atom is text that begins with an alnum char it would join the
            # base mid-word, so leave the sub/sup as plain text instead.
            nxt = atoms[i + 1] if i + 1 < len(atoms) else None
            plain_base_ok = not (nxt is not None and nxt.t == "text"
                                 and nxt.s and nxt.s[0].isalnum())
            _attach_subsup(segs, a, plain_base_ok)
        elif a.t == "anchor":
            segs.append(_Seg("anchor", a.s, atom=a))

    # Assemble. Whitespace is squeezed *per piece* as we go so the recorded
    # anchor spans stay exact (no second pass / position re-derivation needed).
    out: list[str] = []
    matches: list[Match] = []
    pos = 0

    def emit(s: str) -> int:
        nonlocal pos
        out.append(s)
        start = pos
        pos += len(s)
        return start

    for seg in segs:
        if seg.kind == "plain":
            emit(_norm_ws(seg.s))
        elif seg.kind == "math":
            latex = seg.s.strip()
            if latex:
                emit("$" + latex + "$")
        else:  # anchor
            visible = _norm_ws(seg.s).strip()
            if not visible:
                continue
            start = emit(visible)
            matches.append(Match(start, pos, _anchor_occ(seg.atom, visible)))

    text = "".join(out)
    lstrip = len(text) - len(text.lstrip())
    if lstrip:
        text = text[lstrip:]
        matches = [Match(m.start - lstrip, m.end - lstrip, m.occ) for m in matches]
    text = text.rstrip()
    matches = [m for m in matches if 0 <= m.start < m.end <= len(text)]
    return text, matches


def _anchor_occ(atom: _Atom, visible: str):
    if atom.role == "cite":
        return CitationOccurrence(
            ref_ids=[atom.ref_id] if atom.ref_id else [], raw=visible,
            via="hyperlink", resolved=bool(atom.ref_id))
    return CrossRefOccurrence(
        kind=atom.xref_kind or "unknown", raw=visible, target_id=atom.target_id,
        via="hyperlink", resolved=bool(atom.target_id))


# Unicode helper kept for callers that want a plain-text rendering of a node.
def plain_text(node) -> str:
    return _norm_ws(node.get_text()).strip()
