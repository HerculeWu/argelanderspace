"""Build the ordered section tree from MinerU's ``content_list.json``.

MinerU returns a *flat* list of blocks in reading order; headings are marked by
``text_level`` (1 = H1, 2 = H2, ...) or by ``type == "title"``. We rebuild the
section hierarchy with a level stack, attach floats (figures/tables/equations/
code/algorithms/lists) as blocks, fold captions/footnotes in as subordinates,
and assign stable ids. ``ref_text`` blocks (bibliography entries) are *not*
placed in the tree — they are returned separately for the reference parser.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from ..schema import (AlgorithmBlock, Block, CodeBlock, EquationBlock,
                      FigureBlock, ListBlock, Paragraph, RichText, Section,
                      TableBlock)

log = logging.getLogger("bibgraph.structure")

# Block types we deliberately drop from the reading-order tree.
_NOISE_TYPES = {"header", "footer", "page_number", "page_footnote",
                "footnote", "discarded"}

FIG_NUM_RE = re.compile(r"^\s*(?:fig(?:ure)?|abb(?:ildung)?)\.?\s*([0-9]+[a-z]?)", re.I)
TAB_NUM_RE = re.compile(r"^\s*(?:tab(?:le)?|tabelle)\.?\s*([0-9]+[a-z]?)", re.I)
ALGO_NUM_RE = re.compile(r"^\s*(?:algorithm|algo)\.?\s*([0-9]+[a-z]?)", re.I)
LISTING_NUM_RE = re.compile(r"^\s*(?:listing|code)\.?\s*([0-9]+[a-z]?)", re.I)
# Heading number prefix, e.g. "3.2  Methods" / "A.1 Appendix" / "IV. Results"
HEADING_NUM_RE = re.compile(
    r"^\s*((?:[A-Z]\.)?\d+(?:\.\d+)*|[IVXLC]+|[A-Z])[.)]?\s+(.*\S)?\s*$")
# A bare equation tag like "(3)" or a \tag{3}
EQ_TAG_RE = re.compile(r"\\tag\{([^}]+)\}")
EQ_TRAILING_NUM_RE = re.compile(r"\(([0-9]+[a-z]?)\)\s*$")


class _IdGen:
    def __init__(self) -> None:
        self._counters: dict[str, int] = {}

    def next(self, prefix: str) -> str:
        self._counters[prefix] = self._counters.get(prefix, 0) + 1
        return f"{prefix}-{self._counters[prefix]}"


@dataclass
class StructureResult:
    sections: list[Section]
    ref_text_items: list[dict[str, Any]] = field(default_factory=list)
    title_guess: str | None = None


def _join(value: Any) -> str:
    """MinerU captions/footnotes are lists of strings; join to one string."""
    if value is None:
        return ""
    if isinstance(value, list):
        return " ".join(str(v).strip() for v in value
                        if v is not None and str(v).strip()).strip()
    return str(value).strip()


def _bbox(item: dict[str, Any]) -> list[float] | None:
    b = item.get("bbox")
    if isinstance(b, list) and len(b) >= 4:
        try:
            return [float(x) for x in b[:4]]
        except (ValueError, TypeError):
            return None
    return None


def _is_heading(item: dict[str, Any]) -> int | None:
    """Return heading level (>=1) if *item* is a heading, else None."""
    t = item.get("type")
    lvl = item.get("text_level")
    if t == "title":
        return int(lvl) if isinstance(lvl, int) and lvl >= 1 else 1
    if t == "text" and isinstance(lvl, int) and lvl >= 1:
        return lvl
    return None


def _split_heading(text: str) -> tuple[str | None, str]:
    """Split "3.2 Methods" -> ("3.2", "Methods")."""
    m = HEADING_NUM_RE.match(text)
    if m and m.group(2):
        return m.group(1), m.group(2).strip()
    return None, text.strip()


def _split_caption(caption: str, regex: re.Pattern, prefix: str
                   ) -> tuple[str | None, str | None, str]:
    """Pull the leading "Figure 3" label off a caption.

    Returns ``(number, label, body)`` where *body* is the caption with its own
    label prefix removed, so the float's own label is never mistaken for a
    cross-reference to itself.
    """
    m = regex.match(caption)
    if m:
        num = m.group(1)
        # strip the label/caption separator once (e.g. ": " or ". " or " — "),
        # without eating a leading minus sign that belongs to the caption text.
        body = re.sub(r"^\s*[:.—–]?\s*", "", caption[m.end():])
        return num, f"{prefix} {num}", body
    return None, None, caption


def _eq_number(latex: str) -> str | None:
    m = EQ_TAG_RE.search(latex)
    if m:
        return m.group(1).strip()
    m = EQ_TRAILING_NUM_RE.search(latex.strip())
    if m:
        return m.group(1)
    return None


def build_structure(content_list: list[dict[str, Any]]) -> StructureResult:
    ids = _IdGen()
    roots: list[Section] = []
    stack: list[Section] = []          # open sections by increasing level
    front: Section | None = None
    current: Section | None = None
    ref_items: list[dict[str, Any]] = []
    title_guess: str | None = None

    def ensure_front() -> Section:
        nonlocal front
        if front is None:
            front = Section(id="sec-0", level=0, heading="", page_idx=0)
            roots.insert(0, front)
        return front

    for item in content_list:
        itype = item.get("type")

        # --- bibliography entries: collect, don't place in tree ---------- #
        if itype == "ref_text":
            ref_items.append(item)
            continue
        if itype in _NOISE_TYPES:
            continue

        # --- headings define sections ------------------------------------ #
        level = _is_heading(item)
        if level is not None:
            raw = _join(item.get("text"))
            if not raw:
                continue
            if title_guess is None and level == 1:
                title_guess = raw
            number, heading = _split_heading(raw)
            sec = Section(id=ids.next("sec"), level=level, heading=heading,
                          heading_raw=raw, number=number,
                          page_idx=item.get("page_idx"), bbox=_bbox(item))
            while stack and stack[-1].level >= level:
                stack.pop()
            if stack:
                stack[-1].children.append(sec)
            else:
                roots.append(sec)
            stack.append(sec)
            current = sec
            continue

        # --- content blocks ---------------------------------------------- #
        block = _make_block(item, ids)
        if block is None:
            continue
        target = current if current is not None else ensure_front()
        target.blocks.append(block)

    return StructureResult(sections=roots, ref_text_items=ref_items,
                           title_guess=title_guess)


def _make_block(item: dict[str, Any], ids: _IdGen) -> Block | None:
    itype = item.get("type")
    page = item.get("page_idx")
    bbox = _bbox(item)

    if itype in ("text", None):
        text = _join(item.get("text"))
        if not text:
            return None
        return Paragraph(id=ids.next("p"), page_idx=page, bbox=bbox, text=text)

    if itype in ("image", "chart", "figure"):
        # MinerU's VLM backend tags plots/graphs as type "chart" (with
        # chart_caption/chart_footnote/content), and photos as "image".
        caption = _join(item.get("img_caption") or item.get("chart_caption")
                        or item.get("figure_caption"))
        num, label, body = _split_caption(caption, FIG_NUM_RE, "Figure")
        return FigureBlock(
            id=ids.next("fig"), page_idx=page, bbox=bbox,
            number=num, label=label,
            caption=RichText(text=body) if body else None,
            footnote=_join(item.get("img_footnote")
                           or item.get("chart_footnote")) or None,
            img_path=item.get("img_path"),
            chart_type=item.get("sub_type") if itype == "chart" else None,
            content=(item.get("content") or None) if itype == "chart" else None)

    if itype == "table":
        caption = _join(item.get("table_caption"))
        num, label, body = _split_caption(caption, TAB_NUM_RE, "Table")
        return TableBlock(
            id=ids.next("tab"), page_idx=page, bbox=bbox,
            number=num, label=label,
            caption=RichText(text=body) if body else None,
            footnote=_join(item.get("table_footnote")) or None,
            table_body=item.get("table_body"),
            img_path=item.get("img_path"))

    if itype in ("equation", "interline_equation"):
        latex = _join(item.get("text") or item.get("latex"))
        if not latex:
            return None
        num = _eq_number(latex)
        return EquationBlock(
            id=ids.next("eq"), page_idx=page, bbox=bbox,
            number=num, label=(f"Equation {num}" if num else None),
            latex=latex)

    if itype == "algorithm" or (itype == "code" and item.get("sub_type") == "algorithm"):
        caption = _join(item.get("code_caption") or item.get("algorithm_caption"))
        body = _join(item.get("code_body") or item.get("text")
                     or item.get("algorithm_body"))
        num, label, cap_body = _split_caption(caption, ALGO_NUM_RE, "Algorithm")
        return AlgorithmBlock(
            id=ids.next("algo"), page_idx=page, bbox=bbox,
            number=num, label=label,
            caption=RichText(text=cap_body) if cap_body else None,
            body=body)

    if itype == "code":
        caption = _join(item.get("code_caption"))
        body = _join(item.get("code_body") or item.get("text"))
        num, label, cap_body = _split_caption(caption, LISTING_NUM_RE, "Listing")
        return CodeBlock(
            id=ids.next("code"), page_idx=page, bbox=bbox,
            number=num, label=label,
            caption=RichText(text=cap_body) if cap_body else None,
            lang=item.get("guess_lang") or item.get("language"),
            body=body)

    if itype == "list":
        items = _list_items(item)
        if not items:
            text = _join(item.get("text"))
            if not text:
                return None
            return Paragraph(id=ids.next("p"), page_idx=page, bbox=bbox, text=text)
        ordered = bool(item.get("ordered")) or item.get("sub_type") == "ordered"
        return ListBlock(id=ids.next("list"), page_idx=page, bbox=bbox,
                         ordered=ordered, items=items)

    if itype in ("phonetic", "aside_text", "index"):
        text = _join(item.get("text"))
        if not text:
            return None
        return Paragraph(id=ids.next("p"), page_idx=page, bbox=bbox, text=text)

    # Unknown type: keep its text if any, so we never silently drop content.
    text = _join(item.get("text"))
    if text:
        log.debug("Unknown content type %r kept as paragraph", itype)
        return Paragraph(id=ids.next("p"), page_idx=page, bbox=bbox, text=text)
    return None


def _list_items(item: dict[str, Any]) -> list[RichText]:
    raw = item.get("list_items") or item.get("items")
    out: list[RichText] = []
    if isinstance(raw, list):
        for it in raw:
            if isinstance(it, str):
                t = it.strip()
            elif isinstance(it, dict):
                t = _join(it.get("text"))
            else:
                t = str(it).strip()
            if t:
                out.append(RichText(text=t))
        return out
    # Fallback: split a blob on newlines / bullet markers.
    blob = _join(item.get("text"))
    if blob:
        for line in re.split(r"\n+|(?<=\S)\s*[•▪◦]\s+", blob):
            line = line.strip(" •-\t")
            if line:
                out.append(RichText(text=line))
    return out
