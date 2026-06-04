"""Oxford University Press (Silverchair) HTML adapter — MNRAS et al.

OUP full text (``academic.oup.com/mnras/article/...``) is a Silverchair layout:

* body under ``div.article-body``; the abstract is a ``section.abstract`` with an
  ``h2.abstract-title``; numbered sections are nested ``<section>`` whose first
  child is an ``h2|h3|h4.section-title`` ("1 Introduction", "2.1 …");
* paragraphs are ``<p>``; in-text citations are ``<a class="xref-bibr"
  data-reveal-id="bibN">`` and cross-refs ``a.xref-fig`` / ``a.xref-sec`` —
  authoritative (the ``data-reveal-id`` says exactly which ref/float), but the
  ``href`` is ``javascript:;`` so we rewrite it to ``#<reveal-id>`` for the
  shared inline renderer;
* display equations are ``div.disp-formula`` — modern papers embed ``<math>``
  (→ LaTeX via pandoc); legacy papers ship a rendered IMAGE (kept as a figure);
* figures are ``div.fig.fig-section`` (img + caption); tables ``div.table-wrap``;
* references are ``div.ref-list`` → ``div.ref`` items in citation order (the
  data-reveal-id ``bibN`` is the N-th entry), each with [Crossref]/[Search ADS]
  links carrying the DOI / bibcode.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from urllib.parse import urljoin

from bs4 import BeautifulSoup, Tag

from ..config import HtmlConfig
from ..ingest.references import _parse_one
from ..schema import (EquationBlock, FigureBlock, ListBlock, Paragraph,
                      Reference, RichText, Section, TableBlock)
from .aanda import _IdGen, _clean_table_html
from .base import HtmlAdapter, ParsedDoc, register
from .fetch import Fetcher
from .inline import AnchorTarget, InlineContext, plain_text, render_inline
from .mathml import mathml_to_latex, strip_math_delims

log = logging.getLogger("bibgraph.html.oup")

_HEADING_NUM_RE = re.compile(r"^\s*((?:\d+\.)*\d+)\.?\s+(.*\S)\s*$")
_APPENDIX_RE = re.compile(r"^\s*APPENDIX\s+([A-Z0-9]+)\b\s*[:.]?\s*(.*)$", re.I)


@register
class OupAdapter(HtmlAdapter):
    name = "oup"
    publisher = "MNRAS"
    # OUP hosts MNRAS (modern) — legacy Wiley/Blackwell DOIs redirect here too.
    doi_prefixes = ("10.1093/mnras", "10.1093/mnrasl",
                    "10.1111/j.1365-2966", "10.1046/j.1365-8711")
    host_hints = ("academic.oup.com",)

    @classmethod
    def matches(cls, url: str, soup: BeautifulSoup) -> bool:
        if any(h in url.lower() for h in cls.host_hints):
            return True
        m = soup.find("meta", attrs={"name": "citation_publisher"})
        return bool(m and "oxford university press" in (m.get("content") or "").lower())

    # -- entry point -------------------------------------------------------- #
    def parse(self, soup: BeautifulSoup, *, base_url: str, fetcher: Fetcher,
              asset_dir: Path, config: HtmlConfig) -> ParsedDoc:
        body = soup.select_one("div.article-body") or soup.select_one("div.widget-ArticleFulltext")
        if body is None:
            raise ValueError("OUP: could not find the full-text body (div.article-body)")

        ids = _IdGen()
        amap: dict[str, AnchorTarget] = {}
        holders: list[tuple[RichText | Paragraph, object]] = []

        # rewrite reveal-id anchors to fragment hrefs the inline renderer reads
        self._rewrite_anchors(body)

        title = self._meta1(soup, "citation_title") or self._title(body)
        meta = self._meta(soup)

        # references first (so forward citations resolve), filling amap[bibN]
        references = self._references(soup, ids, amap)

        sections = self._walk(body, ids, amap, holders, base_url, fetcher,
                              asset_dir, config)

        ctx = InlineContext(resolve=amap.get, inline_math=config.inline_math)
        for holder, node in holders:
            text, matches = render_inline(node, ctx)
            holder.text = text
            holder._anchor_matches = matches

        return ParsedDoc(sections=sections, references=references, title=title,
                         meta=meta,
                         source_extra={"publisher": "Oxford University Press",
                                       "doi": meta.get("doi"), "url": base_url})

    # -- anchors ------------------------------------------------------------ #
    def _rewrite_anchors(self, body: Tag) -> None:
        for a in body.find_all("a"):
            rid = a.get("data-reveal-id") or a.get("reveal-id")
            if rid and not (a.get("href") or "").startswith("#"):
                a["href"] = "#" + rid

    # -- title / meta ------------------------------------------------------- #
    def _meta1(self, soup: BeautifulSoup, name: str) -> str | None:
        e = soup.find("meta", attrs={"name": name})
        return e.get("content").strip() if e and e.get("content") else None

    def _title(self, body: Tag) -> str | None:
        h = body.find(["h1", "h2"], class_=re.compile("article-title|wi-article-title"))
        return plain_text(h) if h else None

    def _meta(self, soup: BeautifulSoup) -> dict:
        authors = [e.get("content").strip()
                   for e in soup.find_all("meta", attrs={"name": "citation_author"})
                   if e.get("content")]
        return {"doi": self._meta1(soup, "citation_doi"),
                "journal": self._meta1(soup, "citation_journal_title"),
                "volume": self._meta1(soup, "citation_volume"),
                "year": self._meta1(soup, "citation_publication_date"),
                "authors": authors, "adapter": "oup"}

    # -- structural walk ---------------------------------------------------- #
    def _walk(self, body: Tag, ids: _IdGen, amap: dict, holders: list,
              base_url: str, fetcher: Fetcher, asset_dir: Path,
              config: HtmlConfig) -> list[Section]:
        roots: list[Section] = []
        stack: list[Section] = []
        current: Section | None = None

        # Abstract (Silverchair: section.abstract). Keep its prose only.
        abss = body.find("section", class_="abstract") or soup_abstract(body)
        if abss is not None:
            sec = Section(id=ids.next("sec"), level=1, heading="Abstract",
                          heading_raw="Abstract", page_idx=0)
            for p in abss.find_all("p", recursive=True):
                if plain_text(p):
                    para = Paragraph(id=ids.next("p"), page_idx=0, text="")
                    holders.append((para, p))
                    sec.blocks.append(para)
            if sec.blocks:
                roots.append(sec)
                stack.append(sec)
                current = sec

        def add_section(sec: Section, level: int) -> None:
            nonlocal current
            while stack and stack[-1].level >= level:
                stack.pop()
            (stack[-1].children if stack else roots).append(sec)
            stack.append(sec)
            current = sec

        # The body is a FLAT reading-order sequence (headings + <p> + floats) of
        # children under div.widget-items — not nested <section> elements.
        h0 = body.select_one("h2.section-title, h3.section-title, h4.section-title")
        container = h0.parent if h0 is not None else body
        for child in container.children:
            if not isinstance(child, Tag):
                continue
            name = child.name.lower()
            cls = child.get("class") or []
            if name in ("h2", "h3", "h4", "h5") and "section-title" in cls:
                level = {"h2": 1, "h3": 2, "h4": 3, "h5": 4}[name]
                add_section(self._make_section(child, level, ids, amap), level)
                continue
            blocks = self._blocks(child, ids, amap, holders, base_url, fetcher,
                                  asset_dir, config)
            if not blocks:
                continue
            if current is None:
                current = Section(id=ids.next("sec"), level=1, heading="", page_idx=0)
                roots.append(current)
                stack.append(current)
            current.blocks.extend(blocks)
        return roots

    def _make_section(self, h: Tag, level: int, ids: _IdGen, amap: dict) -> Section:
        raw = plain_text(h)
        number, heading = None, raw
        ma, mn = _APPENDIX_RE.match(raw), _HEADING_NUM_RE.match(raw)
        if ma:
            number, heading = ma.group(1), (ma.group(2).strip() or raw)
        elif mn:
            number, heading = mn.group(1), mn.group(2).strip()
        sec = Section(id=ids.next("sec"), level=level, heading=heading,
                      heading_raw=raw, number=number, page_idx=0)
        return sec

    # -- blocks ------------------------------------------------------------- #
    def _blocks(self, node: Tag, ids: _IdGen, amap: dict, holders: list,
                base_url: str, fetcher: Fetcher, asset_dir: Path,
                config: HtmlConfig) -> list:
        name = node.name.lower()
        cls = node.get("class") or []

        if name == "p":
            if not plain_text(node):
                return []
            para = Paragraph(id=ids.next("p"), page_idx=0, text="")
            holders.append((para, node))
            return [para]
        if name == "div" and ("fig" in cls or "fig-section" in cls):
            b = self._figure(node, ids, amap, holders, base_url, fetcher,
                             asset_dir, config)
            return [b] if b else []
        if name == "div" and ("disp-formula" in cls or "disp-formula-group" in cls):
            return self._equation(node, ids, amap, holders, base_url, fetcher,
                                  asset_dir, config)
        if name == "div" and any("table" in c for c in cls):
            b = self._table(node, ids, amap, holders)
            return [b] if b else []
        if name in ("ul", "ol"):
            b = self._list(node, ids, holders, name == "ol")
            return [b] if b else []
        if name == "section":
            return []                                    # handled by _section
        # wrapper div: recurse into its children so we never drop content
        if name == "div":
            out: list = []
            for c in node.children:
                if isinstance(c, Tag):
                    out.extend(self._blocks(c, ids, amap, holders, base_url,
                                            fetcher, asset_dir, config))
            return out
        return []

    def _next_num(self, ids: _IdGen, kind: str) -> str:
        ids._c[kind] = ids._c.get(kind, 0) + 1
        return str(ids._c[kind])

    def _figure(self, node: Tag, ids: _IdGen, amap: dict, holders: list,
                base_url: str, fetcher: Fetcher, asset_dir: Path,
                config: HtmlConfig):
        n = self._next_num(ids, "fignum")
        cap_node = node.find(class_=re.compile("fig-caption|caption")) or node.find("figcaption")
        cap = RichText(text="")
        if cap_node is not None:
            holders.append((cap, cap_node))
        img_path = None
        img = node.find("img")
        src = img.get("src") or img.get("data-src") if img else None
        if src:
            img_path = self._asset(urljoin(base_url, src), asset_dir, fetcher, config)
        blk = FigureBlock(id=ids.next("fig"), page_idx=0, number=n,
                          label=f"Figure {n}",
                          caption=cap if cap_node is not None else None,
                          img_path=img_path)
        amap[f"fig{n}"] = AnchorTarget("xref", target_id=blk.id, xref_kind="figure")
        fid = node.get("id")
        if fid:
            amap[fid] = AnchorTarget("xref", target_id=blk.id, xref_kind="figure")
        return blk

    def _equation(self, node: Tag, ids: _IdGen, amap: dict, holders: list,
                  base_url: str, fetcher: Fetcher, asset_dir: Path,
                  config: HtmlConfig) -> list:
        n = self._next_num(ids, "eqnum")
        math = node.find("math")
        if math is not None:
            latex = mathml_to_latex(str(math)) or ""
            blk = EquationBlock(id=ids.next("eq"), page_idx=0, number=n,
                                label=f"Equation {n}",
                                latex=strip_math_delims(latex))
            amap[f"disp-formula{n}"] = AnchorTarget("xref", target_id=blk.id,
                                                    xref_kind="equation")
            eid = node.get("id")
            if eid:
                amap[eid] = AnchorTarget("xref", target_id=blk.id, xref_kind="equation")
            return [blk]
        # legacy: the equation is a rendered image — keep it visible as a figure.
        img = node.find("img")
        if img is not None and (img.get("src") or img.get("data-src")):
            src = urljoin(base_url, img.get("src") or img.get("data-src"))
            path = self._asset(src, asset_dir, fetcher, config)
            blk = FigureBlock(id=ids.next("fig"), page_idx=0, number=n,
                              label=f"Equation {n}", img_path=path)
            eid = node.get("id")
            if eid:
                amap[eid] = AnchorTarget("xref", target_id=blk.id, xref_kind="equation")
            return [blk]
        return []

    def _table(self, node: Tag, ids: _IdGen, amap: dict, holders: list):
        n = self._next_num(ids, "tabnum")
        cap_node = node.find(class_=re.compile("caption|table-caption")) or node.find("caption")
        cap = RichText(text="")
        if cap_node is not None:
            holders.append((cap, cap_node))
        tbl = node.find("table")
        body_html = _clean_table_html(tbl) if tbl is not None else None
        blk = TableBlock(id=ids.next("tab"), page_idx=0, number=n,
                         label=f"Table {n}",
                         caption=cap if cap_node is not None else None,
                         table_body=body_html)
        amap[f"table{n}"] = AnchorTarget("xref", target_id=blk.id, xref_kind="table")
        tid = node.get("id")
        if tid:
            amap[tid] = AnchorTarget("xref", target_id=blk.id, xref_kind="table")
        return blk

    def _list(self, node: Tag, ids: _IdGen, holders: list, ordered: bool):
        items: list[RichText] = []
        for li in node.find_all("li", recursive=False):
            if not plain_text(li):
                continue
            rt = RichText(text="")
            holders.append((rt, li))
            items.append(rt)
        if not items:
            return None
        return ListBlock(id=ids.next("list"), page_idx=0, ordered=ordered, items=items)

    def _asset(self, url: str, asset_dir: Path, fetcher: Fetcher,
               config: HtmlConfig) -> str | None:
        if not config.download_assets:
            return url
        fn = re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("/")[-1].split("?")[0])
        if not re.search(r"\.[a-z0-9]+$", fn, re.I):
            fn += ".jpeg"
        dest = asset_dir / fn
        return f"assets/{fn}" if fetcher.download(url, dest) else None

    # -- references --------------------------------------------------------- #
    def _references(self, soup: BeautifulSoup, ids: _IdGen,
                    amap: dict) -> list[Reference]:
        reflist = soup.select_one("div.ref-list") or soup.select_one("section.ref-list")
        if reflist is None:
            return []
        items = reflist.select("div.ref") or reflist.find_all("li")
        refs: list[Reference] = []
        for i, li in enumerate(items, 1):
            rid = ids.next("ref")
            ref = _parse_oup_ref(li, rid)
            refs.append(ref)
            amap[f"bib{i}"] = AnchorTarget("cite", ref_id=rid)   # data-reveal-id
            own = li.get("id") or ""
            if own:
                amap[own] = AnchorTarget("cite", ref_id=rid)
        return refs


def soup_abstract(body: Tag) -> Tag | None:
    h = body.find(class_=re.compile("abstract-title"))
    return h.parent if h is not None else None


def _parse_oup_ref(li: Tag, ref_id: str) -> Reference:
    clone = BeautifulSoup(str(li), "html.parser")
    for a in clone.find_all("a"):
        a.decompose()
    raw = re.sub(r"\s+", " ", clone.get_text(" ")).strip(" .;,")
    raw = re.sub(r"\b(Crossref|Search ADS|PubMed|Google Scholar|OpenURL|"
                 r"WorldCat)\b", "", raw).strip(" .;,")
    ref = _parse_one(ref_id, raw, None)
    for a in li.find_all("a", href=True):
        href = a["href"]
        if ("doi.org/" in href or "/doi/" in href) and not ref.doi:
            m = re.search(r"(10\.\d{4,9}/[^\s\"'&]+)", href)
            if m:
                ref.doi = m.group(1).rstrip(".,);")
        if "arxiv" in href.lower() and not ref.arxiv_id:
            m = re.search(r"(\d{4}\.\d{4,5})", href)
            if m:
                ref.arxiv_id = m.group(1)
    return ref
