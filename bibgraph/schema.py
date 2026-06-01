"""Canonical data model for an ingested document + JSON serialization.

The emitted JSON has this top-level shape::

    {
      "doc_id":   str,
      "source":   {type, path, filename, n_pages, ...},
      "meta":     {title, mineru: {...}, ...},
      "structure":[ <section> ... ],     # ordered section tree (reading order)
      "index":    {figures, tables, equations, code, algorithms, sections},
      "references":[ <reference> ... ],  # global, structured
      "symbols":  [ <symbol> ... ],      # lightweight inventory
      "citations":[ <citation occurrence + block_id> ... ],  # flattened
      "crossrefs":[ <crossref occurrence + block_id> ... ],  # flattened
      "stats":    {...}
    }

In-text citations and cross-references are marked *inline* inside each text
body using placeholder tokens:

    "... as shown by [[cite:ref-12]] in [[xref:fig-3]] ..."

and the same occurrences are also recorded structurally per block (and
flattened at the document level) so the web UI can render either way.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

# --------------------------------------------------------------------------- #
# Inline token format
# --------------------------------------------------------------------------- #

CITE_TOKEN_RE = re.compile(r"\[\[cite:([^\]]+)\]\]")
XREF_TOKEN_RE = re.compile(r"\[\[xref:([^\]]+)\]\]")


def cite_token(ref_ids: list[str]) -> str:
    """``["ref-1","ref-2"]`` -> ``"[[cite:ref-1;ref-2]]"``."""
    return "[[cite:" + ";".join(ref_ids) + "]]"


def xref_token(target_id: str) -> str:
    """``"fig-3"`` -> ``"[[xref:fig-3]]"``."""
    return "[[xref:" + target_id + "]]"


def strip_tokens(text: str) -> str:
    """Return *text* with all ``[[cite:..]]`` / ``[[xref:..]]`` tokens removed."""
    text = CITE_TOKEN_RE.sub("", text)
    text = XREF_TOKEN_RE.sub("", text)
    return re.sub(r"\s{2,}", " ", text).strip()


# --------------------------------------------------------------------------- #
# Serialization helper
# --------------------------------------------------------------------------- #

def compact(value: Any) -> Any:
    """Recursively drop ``None`` and empty containers/strings.

    Numeric ``0`` and ``False`` are preserved (they are meaningful, e.g.
    ``page_idx == 0`` or ``resolved == False``).
    """
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            v = compact(v)
            if v is None:
                continue
            if isinstance(v, (list, dict, str)) and len(v) == 0:
                continue
            out[k] = v
        return out
    if isinstance(value, list):
        return [compact(v) for v in value]
    return value


# --------------------------------------------------------------------------- #
# Occurrences (in-text citations & cross references)
# --------------------------------------------------------------------------- #

@dataclass
class CitationOccurrence:
    """One in-text citation site (already replaced by a token in the body)."""

    ref_ids: list[str]          # bibgraph reference ids this site resolves to
    raw: str                    # original matched text, e.g. "(Hunt & Reffert 2021)"
    via: str = "regex"          # "regex" | "hyperlink" | "hyperlink+regex"
    resolved: bool = True       # False if we could not map to any reference
    doi: str | None = None      # authoritative target from a hyperlink, if any
    url: str | None = None

    @property
    def token(self) -> str:
        return cite_token(self.ref_ids) if self.ref_ids else "[[cite:?]]"

    def to_dict(self) -> dict[str, Any]:
        return {
            "ref_ids": self.ref_ids,
            "raw": self.raw,
            "via": self.via,
            "resolved": self.resolved,
            "doi": self.doi,
            "url": self.url,
        }


@dataclass
class CrossRefOccurrence:
    """One cross-reference site (already replaced by a token in the body)."""

    kind: str                   # figure|table|equation|section|algorithm|code|appendix|unknown
    raw: str                    # original matched text, e.g. "Fig. 3"
    target_id: str | None = None
    number: str | None = None   # referenced number/letter, e.g. "3" or "A"
    via: str = "regex"          # "regex" | "hyperlink" | "hyperlink+regex"
    resolved: bool = True
    target_page: int | None = None   # for unresolved GoTo links (0-based)
    url: str | None = None

    @property
    def token(self) -> str:
        if self.target_id:
            return xref_token(self.target_id)
        if self.number:            # typed but unresolved -> readable placeholder
            return f"[[xref:{self.kind}-{self.number}?]]"
        return "[[xref:?]]"

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "raw": self.raw,
            "target_id": self.target_id,
            "number": self.number,
            "via": self.via,
            "resolved": self.resolved,
            "target_page": self.target_page,
            "url": self.url,
        }


# --------------------------------------------------------------------------- #
# Blocks
# --------------------------------------------------------------------------- #

@dataclass
class RichText:
    """A run of body text that may carry inline tokens + occurrence records."""

    text: str = ""
    citations: list[CitationOccurrence] = field(default_factory=list)
    crossrefs: list[CrossRefOccurrence] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "citations": [c.to_dict() for c in self.citations],
            "crossrefs": [x.to_dict() for x in self.crossrefs],
        }


@dataclass
class Block:
    """Base class for everything that lives in a section's reading order."""

    id: str = ""
    type: str = "block"
    page_idx: int | None = None
    bbox: list[float] | None = None   # [x0,y0,x1,y1] normalized 0-1000

    def _base(self) -> dict[str, Any]:
        return {"id": self.id, "type": self.type,
                "page_idx": self.page_idx, "bbox": self.bbox}

    def to_dict(self) -> dict[str, Any]:
        return self._base()


@dataclass
class Paragraph(Block):
    type: str = "paragraph"
    text: str = ""
    citations: list[CitationOccurrence] = field(default_factory=list)
    crossrefs: list[CrossRefOccurrence] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = self._base()
        d.update({
            "text": self.text,
            "citations": [c.to_dict() for c in self.citations],
            "crossrefs": [x.to_dict() for x in self.crossrefs],
        })
        return d


@dataclass
class ListBlock(Block):
    type: str = "list"
    ordered: bool = False
    items: list[RichText] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = self._base()
        d.update({"ordered": self.ordered,
                  "items": [it.to_dict() for it in self.items]})
        return d


@dataclass
class FigureBlock(Block):
    type: str = "figure"
    number: str | None = None          # printed number, e.g. "3"
    label: str | None = None           # e.g. "Figure 3"
    caption: RichText | None = None
    footnote: str | None = None
    img_path: str | None = None
    chart_type: str | None = None      # MinerU chart sub_type: line/bar/scatter…
    content: str | None = None         # MinerU's extracted chart data, if any

    def to_dict(self) -> dict[str, Any]:
        d = self._base()
        d.update({"number": self.number, "label": self.label,
                  "caption": self.caption.to_dict() if self.caption else None,
                  "footnote": self.footnote, "img_path": self.img_path,
                  "chart_type": self.chart_type, "content": self.content})
        return d


@dataclass
class TableBlock(Block):
    type: str = "table"
    number: str | None = None
    label: str | None = None
    caption: RichText | None = None
    footnote: str | None = None
    table_body: str | None = None      # HTML
    img_path: str | None = None        # fallback image when not recognized

    def to_dict(self) -> dict[str, Any]:
        d = self._base()
        d.update({"number": self.number, "label": self.label,
                  "caption": self.caption.to_dict() if self.caption else None,
                  "footnote": self.footnote, "table_body": self.table_body,
                  "img_path": self.img_path})
        return d


@dataclass
class EquationBlock(Block):
    type: str = "equation"
    number: str | None = None
    label: str | None = None
    latex: str = ""
    symbols: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        d = self._base()
        d.update({"number": self.number, "label": self.label,
                  "latex": self.latex, "symbols": self.symbols})
        return d


@dataclass
class CodeBlock(Block):
    type: str = "code"
    number: str | None = None
    label: str | None = None
    caption: RichText | None = None
    lang: str | None = None
    body: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = self._base()
        d.update({"number": self.number, "label": self.label,
                  "caption": self.caption.to_dict() if self.caption else None,
                  "lang": self.lang, "body": self.body})
        return d


@dataclass
class AlgorithmBlock(Block):
    """Pseudocode / algorithm float."""

    type: str = "algorithm"
    number: str | None = None
    label: str | None = None
    caption: RichText | None = None
    body: str = ""

    def to_dict(self) -> dict[str, Any]:
        d = self._base()
        d.update({"number": self.number, "label": self.label,
                  "caption": self.caption.to_dict() if self.caption else None,
                  "body": self.body})
        return d


# --------------------------------------------------------------------------- #
# Sections (the structure tree)
# --------------------------------------------------------------------------- #

@dataclass
class Section:
    id: str
    level: int                          # 1 = top-level heading
    heading: str = ""                   # clean heading text ("Introduction")
    heading_raw: str = ""               # as printed ("1 Introduction")
    number: str | None = None           # extracted number ("1", "3.2")
    page_idx: int | None = None
    bbox: list[float] | None = None     # heading bbox (MinerU 0..1000)
    blocks: list[Block] = field(default_factory=list)
    children: list["Section"] = field(default_factory=list)
    type: str = "section"

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "type": self.type, "level": self.level,
            "heading": self.heading, "heading_raw": self.heading_raw,
            "number": self.number, "page_idx": self.page_idx, "bbox": self.bbox,
            "blocks": [b.to_dict() for b in self.blocks],
            "children": [c.to_dict() for c in self.children],
        }

    def iter_blocks(self):
        """Yield every block in this subtree in reading order."""
        for b in self.blocks:
            yield b
        for c in self.children:
            yield from c.iter_blocks()

    def iter_sections(self):
        yield self
        for c in self.children:
            yield from c.iter_sections()


# --------------------------------------------------------------------------- #
# References & symbols
# --------------------------------------------------------------------------- #

@dataclass
class Reference:
    id: str
    raw: str
    label: str | None = None            # in-text marker for numbered styles ("12")
    authors: list[str] = field(default_factory=list)
    year: int | None = None
    title: str | None = None
    venue: str | None = None
    volume: str | None = None
    pages: str | None = None
    doi: str | None = None
    arxiv_id: str | None = None
    url: str | None = None
    keys: list[str] = field(default_factory=list)   # textual forms for matching
    # source location of the bibliography entry (for GoTo-hyperlink resolution);
    # not serialized into the output JSON.
    src_page: int | None = None
    src_bbox: list[float] | None = None             # MinerU 0..1000 bbox

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "raw": self.raw, "label": self.label,
            "authors": self.authors, "year": self.year, "title": self.title,
            "venue": self.venue, "volume": self.volume, "pages": self.pages,
            "doi": self.doi, "arxiv_id": self.arxiv_id, "url": self.url,
            "keys": self.keys,
        }


@dataclass
class SymbolOccurrence:
    block_id: str
    page_idx: int | None = None
    source: str = "inline"              # "inline" | "equation"

    def to_dict(self) -> dict[str, Any]:
        return {"block_id": self.block_id, "page_idx": self.page_idx,
                "source": self.source}


@dataclass
class Symbol:
    symbol: str                         # LaTeX form, e.g. "M_\\odot"
    count: int = 0
    occurrences: list[SymbolOccurrence] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {"symbol": self.symbol, "count": self.count,
                "occurrences": [o.to_dict() for o in self.occurrences]}


# --------------------------------------------------------------------------- #
# Document
# --------------------------------------------------------------------------- #

@dataclass
class Document:
    doc_id: str
    source: dict[str, Any] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    structure: list[Section] = field(default_factory=list)
    references: list[Reference] = field(default_factory=list)
    symbols: list[Symbol] = field(default_factory=list)

    # ---- convenience iterators -------------------------------------------- #
    def iter_sections(self):
        for s in self.structure:
            yield from s.iter_sections()

    def iter_blocks(self):
        for s in self.structure:
            yield from s.iter_blocks()

    # ---- lightweight index for the web UI / xref resolution --------------- #
    def _build_index(self) -> dict[str, list[dict[str, Any]]]:
        idx: dict[str, list[dict[str, Any]]] = {
            "figures": [], "tables": [], "equations": [],
            "code": [], "algorithms": [], "sections": [],
        }
        bucket = {"figure": "figures", "table": "tables",
                  "equation": "equations", "code": "code",
                  "algorithm": "algorithms"}
        for b in self.iter_blocks():
            key = bucket.get(b.type)
            if not key:
                continue
            entry = {"id": b.id, "page_idx": b.page_idx,
                     "number": getattr(b, "number", None),
                     "label": getattr(b, "label", None)}
            cap = getattr(b, "caption", None)
            if cap is not None:
                entry["caption"] = cap.text
            idx[key].append(entry)
        for s in self.iter_sections():
            idx["sections"].append({"id": s.id, "level": s.level,
                                    "number": s.number, "heading": s.heading,
                                    "page_idx": s.page_idx})
        return idx

    def _flatten_occurrences(self):
        cites: list[dict[str, Any]] = []
        xrefs: list[dict[str, Any]] = []
        for b in self.iter_blocks():
            for c in getattr(b, "citations", []) or []:
                d = c.to_dict(); d["block_id"] = b.id; cites.append(d)
            for x in getattr(b, "crossrefs", []) or []:
                d = x.to_dict(); d["block_id"] = b.id; xrefs.append(d)
            # captions / list items carry occurrences too
            cap = getattr(b, "caption", None)
            if cap is not None:
                for c in cap.citations:
                    d = c.to_dict(); d["block_id"] = b.id; d["in"] = "caption"
                    cites.append(d)
                for x in cap.crossrefs:
                    d = x.to_dict(); d["block_id"] = b.id; d["in"] = "caption"
                    xrefs.append(d)
            for it in getattr(b, "items", []) or []:
                for c in it.citations:
                    d = c.to_dict(); d["block_id"] = b.id; d["in"] = "list_item"
                    cites.append(d)
                for x in it.crossrefs:
                    d = x.to_dict(); d["block_id"] = b.id; d["in"] = "list_item"
                    xrefs.append(d)
        return cites, xrefs

    def _stats(self, cites, xrefs) -> dict[str, Any]:
        idx = self._build_index()
        return {
            "n_sections": len(idx["sections"]),
            "n_paragraphs": sum(1 for b in self.iter_blocks()
                                if b.type == "paragraph"),
            "n_figures": len(idx["figures"]),
            "n_tables": len(idx["tables"]),
            "n_equations": len(idx["equations"]),
            "n_code": len(idx["code"]),
            "n_algorithms": len(idx["algorithms"]),
            "n_references": len(self.references),
            "n_symbols": len(self.symbols),
            "n_citations": len(cites),
            "n_citations_resolved": sum(1 for c in cites if c.get("resolved")),
            "n_crossrefs": len(xrefs),
            "n_crossrefs_resolved": sum(1 for x in xrefs if x.get("resolved")),
        }

    def to_dict(self, compact_json: bool = True) -> dict[str, Any]:
        cites, xrefs = self._flatten_occurrences()
        d = {
            "doc_id": self.doc_id,
            "source": self.source,
            "meta": self.meta,
            "structure": [s.to_dict() for s in self.structure],
            "index": self._build_index(),
            "references": [r.to_dict() for r in self.references],
            "symbols": [s.to_dict() for s in self.symbols],
            "citations": cites,
            "crossrefs": xrefs,
            "stats": self._stats(cites, xrefs),
        }
        return compact(d) if compact_json else d
