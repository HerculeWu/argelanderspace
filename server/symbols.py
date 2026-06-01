"""Heuristic symbol-definition guessing for the reader UI.

Phase-1 ingestion deliberately stores NO symbol -> definition mapping
(lightweight symbols only).  The reader's right-hand panel, however, wants a
short human-readable description for each symbol.  We compute one here, at
serve time, with a best-effort heuristic over the body text:

  * find the math spans ($...$) in which the symbol actually appears,
  * look for a definition cue around that span
    ("the <noun phrase> $g$", "$g$ is the <noun phrase>",
     "where $a_0$ is ...", "$a_0 = ...$"),
  * return the first non-empty guess plus the block it came from.

The result is intentionally fallible (the user opted into a guess that may be
wrong or empty); when nothing matches we still return the first-occurrence
context sentence so the card is never blank.
"""

from __future__ import annotations

import re
from typing import Any

# Sentence splitter: break after . ! ? when the next token looks like a new
# sentence, but not after common abbreviations (e.g. / i.e. / et al. / Fig. ...)
# or decimals (the next char must be uppercase / '(' / '\' / '$', so digits are
# already excluded).
_SENT_SPLIT = re.compile(
    r"(?<!e\.g\.)(?<!i\.e\.)(?<! al\.)(?<!Fig\.)(?<!Eq\.)(?<!Eqs\.)(?<!cf\.)(?<!vs\.)"
    r"(?<=[.!?])\s+(?=[A-Z(\\$])"
)
# A math span: $...$ (single-dollar), not $$.
_MATH_SPAN = re.compile(r"(?<!\$)\$(?!\$)(.+?)(?<!\$)\$(?!\$)", re.S)

# Ordered longest-first: Python regex alternation is first-match, so multi-word
# phrases must precede the bare "is"/"are" or they could never win.
_DEF_VERBS = (
    r"is\s+defined\s+as|is\s+given\s+by|stands?\s+for|refers?\s+to|"
    r"denotes?|represents?|measures?|describes?|means?|gives?|"
    r"is|are|was|were"
)
# Stop words that should not start a definition noun phrase.
_NP_STOP = re.compile(r"^(?:the|a|an|its|their|our|this|that|some|each)\s+", re.I)


def _norm_math(s: str) -> str:
    """Collapse a LaTeX math fragment for substring comparison."""
    s = s.replace("\\left", "").replace("\\right", "")
    return re.sub(r"[\s{}]", "", s)


def _sym_regex(sym: str) -> re.Pattern | None:
    """Regex that matches the *atomic* symbol inside normalised math text."""
    if not sym:
        return None
    norm = _norm_math(sym)
    if not norm:
        return None
    esc = re.escape(norm)
    if norm.startswith("\\"):                       # \mu, \alpha, ...
        return re.compile(esc + r"(?![A-Za-z])")
    if len(norm) == 1 and norm.isalpha():           # single letter: g, a, N
        return re.compile(r"(?<![A-Za-z\\])" + esc + r"(?![A-Za-z])")
    return re.compile(esc)                           # a_0, g_M, ...


def _clean_phrase(p: str, max_words: int = 9) -> str:
    p = p.strip(" \t,;:.")
    p = re.sub(r"\s+", " ", p)
    # cut at clause boundaries
    p = re.split(r"[,.;:()]| such as | which | where | and | as ", p)[0].strip()
    words = p.split()
    if len(words) > max_words:
        words = words[:max_words]
    return " ".join(words).strip(" -")


def _guess_from_sentence(sent: str, sym: str, span_text: str) -> str | None:
    """Try the definition patterns on one sentence containing the symbol."""
    placeholder = "SYM"
    # Replace the *specific* math span carrying the symbol with a placeholder so
    # the surrounding-text patterns can anchor on it regardless of math noise.
    sent_ph = sent.replace(f"${span_text}$", placeholder, 1)

    # 1) "$sym$ is/denotes/... the <phrase>"
    m = re.search(
        placeholder + r"\s*(?:,\s*)?(?:" + _DEF_VERBS + r")\s+(.+)",
        sent_ph, re.I)
    if m:
        ph = _clean_phrase(_NP_STOP.sub("", m.group(1)))
        if len(ph) >= 3:
            return ph

    # 2) "the <noun phrase> $sym$"  (e.g. "the gravitational acceleration g")
    m = re.search(
        r"\b(?:the|a|an)\s+([a-z][a-z\- ]{2,40}?)\s*" + placeholder,
        sent_ph, re.I)
    if m:
        ph = _clean_phrase(m.group(1))
        if len(ph) >= 3:
            return ph

    # 3) equality inside the math span itself: "a_0 = 1.2e-10 ..."
    eqm = re.match(r"\s*[^=]{0,12}?(=|\\equiv)\s*([^=].+)", span_text)
    if eqm:
        rhs = _clean_phrase(eqm.group(2).replace("\\", ""), max_words=6)
        if len(rhs) >= 2:
            return f"= {rhs}".strip()
    return None


def _iter_sentences_with_symbol(text: str, rx: re.Pattern):
    """Yield (sentence, span_text) for math spans matching the symbol."""
    for sent in _SENT_SPLIT.split(text):
        for span in _MATH_SPAN.finditer(sent):
            if rx.search(_norm_math(span.group(1))):
                yield sent, span.group(1)


def enrich_symbols(doc: dict[str, Any]) -> None:
    """Mutate doc['symbols'] in place, adding def_guess / context / first_*."""
    block_text = _block_text_index(doc)
    for sym in doc.get("symbols", []):
        occ = sym.get("occurrences") or []
        if occ:
            sym["first_block_id"] = occ[0].get("block_id")
            sym["first_page"] = occ[0].get("page_idx")
        rx = _sym_regex(sym.get("symbol", ""))
        guess = None
        context = None
        def_block = None
        if rx is not None:
            for o in occ:
                bid = o.get("block_id")
                txt = block_text.get(bid)
                if not txt:
                    continue
                for sent, span in _iter_sentences_with_symbol(txt, rx):
                    if context is None:
                        context = _clean_phrase(sent, max_words=26)
                    g = _guess_from_sentence(sent, sym["symbol"], span)
                    if g:
                        guess, def_block = g, bid
                        break
                if guess:
                    break
        sym["def_guess"] = guess
        sym["def_block_id"] = def_block
        sym["context"] = context


def _block_text_index(doc: dict[str, Any]) -> dict[str, str]:
    """Map block_id -> renderable text (paragraphs + captions)."""
    out: dict[str, str] = {}

    def cap_text(cap: Any) -> str:
        if isinstance(cap, dict):
            return cap.get("text", "") or ""
        return cap or ""

    def walk(blocks: list[dict]) -> None:
        for b in blocks:
            bid = b.get("id")
            t = b.get("type")
            if t == "paragraph":
                out[bid] = b.get("text", "") or ""
            elif t in ("figure", "table"):
                out[bid] = cap_text(b.get("caption"))
            elif t == "equation":
                out[bid] = b.get("latex", "") or ""
            elif t == "list":
                out[bid] = " ".join(i.get("text", "") for i in b.get("items", []))

    def walk_sections(secs: list[dict]) -> None:
        for s in secs:
            walk(s.get("blocks", []))
            walk_sections(s.get("children", []))

    walk_sections(doc.get("structure", []))
    return out
