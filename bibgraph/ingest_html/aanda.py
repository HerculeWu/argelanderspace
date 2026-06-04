"""Astronomy & Astrophysics (EDP Sciences) HTML adapter.

A&A full-text HTML (``aanda.org/articles/aa/full_html/...``) is laid out as a
flat reading-order sequence of children under ``div#contenu``:

* headings ``h2.sec`` / ``h3.sec2`` / ``h4.sec3`` (id ``S<n>``), the article
  title ``h2.title``, and appendix headings ``h2.app`` ("Appendix A: ...");
* paragraphs ``<p>`` — body text with inline ``<i>``/``<sub>``/``<sup>`` math
  and ``<a href="#R..">`` citation / ``#F``/``#T``/``#FD``/``#S`` cross-ref anchors;
* display equations: ``<p>`` → ``span.ressouce-equation`` (id ``FD<n>``) carrying
  the original LaTeX in a ``data-latex`` attribute (+ a GIF + MathML mirror);
* float "insets" ``div.inset`` (id ``F<n>``/``T<n>``): figures show a thumbnail
  (full image on ``F<n>.html``) + inline caption; tables show only a caption —
  the table body lives on ``T<n>.html``.

References are ``<li id="R<n>">`` items carrying the raw string plus ``[CrossRef]``
(DOI) and ``[NASA ADS]`` (bibcode) links. The "All Tables"/"All Figures"
galleries at the end duplicate the floats id-less and are skipped.
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
from .base import HtmlAdapter, ParsedDoc, register
from .fetch import Fetcher
from .inline import AnchorTarget, InlineContext, render_inline, plain_text
from .mathml import annotation_latex, mathml_to_latex, strip_math_delims

log = logging.getLogger("bibgraph.html.aanda")

_APPENDIX_RE = re.compile(r"^\s*Appendix\s+([A-Z]+)\b\s*[:.]?\s*(.*)$", re.I)
_HEADING_NUM_RE = re.compile(r"^\s*((?:\d+\.)*\d+)\.?\s+(.*\S)\s*$")
# venue/volume/pages tail of an A&A reference, after the publication year
_REF_TAIL_RE = re.compile(
    r"(?:19|20)\d{2}[a-z]?\s*,\s*(?P<venue>[^,]+?)\s*,\s*"
    r"(?P<vol>[A-Za-z]?\d+)\s*,\s*(?P<pages>[A-Za-z]?\d+(?:\s*[-–]\s*\d+)?)")


class _IdGen:
    def __init__(self) -> None:
        self._c: dict[str, int] = {}

    def next(self, prefix: str) -> str:
        self._c[prefix] = self._c.get(prefix, 0) + 1
        return f"{prefix}-{self._c[prefix]}"


@register
class AandaAdapter(HtmlAdapter):
    name = "aanda"
    publisher = "A&A"
    doi_prefixes = ("10.1051/0004-6361",)
    host_hints = ("aanda.org",)

    @classmethod
    def matches(cls, url: str, soup: BeautifulSoup) -> bool:
        if any(h in url.lower() for h in cls.host_hints):
            return True
        gen = soup.find("meta", attrs={"name": "citation_journal_title"})
        return bool(gen and "astronomy" in (gen.get("content") or "").lower()
                    and "astrophysics" in (gen.get("content") or "").lower())

    # -- entry point -------------------------------------------------------- #
    def parse(self, soup: BeautifulSoup, *, base_url: str, fetcher: Fetcher,
              asset_dir: Path, config: HtmlConfig) -> ParsedDoc:
        contenu = soup.find("div", id="contenu")
        if contenu is None:
            base_url, soup = self._locate_fulltext(soup, base_url, fetcher)
            contenu = soup.find("div", id="contenu")
        if contenu is None:
            raise ValueError("A&A: could not find the full-text body (div#contenu)")

        ids = _IdGen()
        anchor_map: dict[str, AnchorTarget] = {}
        holders: list[tuple[RichText | Paragraph, Tag]] = []   # (holder, node)

        title = self._title(soup)
        meta = self._meta(soup)

        sections = self._walk(contenu, ids, anchor_map, holders, base_url,
                              fetcher, asset_dir, config)

        # references (also fills anchor_map for #R<n>)
        references = self._references(soup, ids, anchor_map)

        # second pass: now the anchor map is complete (incl. forward refs),
        # render every text holder's inline content into body text + anchors.
        ctx = InlineContext(resolve=anchor_map.get, inline_math=config.inline_math)
        for holder, node in holders:
            text, matches = render_inline(node, ctx)
            holder.text = text
            holder._anchor_matches = matches            # picked up by the pipeline

        return ParsedDoc(sections=sections, references=references,
                         title=title, meta=meta,
                         source_extra={"publisher": "EDP Sciences / A&A",
                                       "doi": meta.get("doi"),
                                       "url": base_url})

    # -- title / meta ------------------------------------------------------- #
    def _title(self, soup: BeautifulSoup) -> str | None:
        m = soup.find("meta", attrs={"name": "citation_title"})
        if m and m.get("content"):
            return m["content"].strip()
        h = soup.select_one("div#contenu h2.title")
        return plain_text(h) if h else None

    def _meta(self, soup: BeautifulSoup) -> dict:
        def metac(name):
            e = soup.find("meta", attrs={"name": name})
            return e.get("content").strip() if e and e.get("content") else None
        authors = [e.get("content").strip()
                   for e in soup.find_all("meta", attrs={"name": "citation_author"})
                   if e.get("content")]
        return {"doi": metac("citation_doi"),
                "journal": metac("citation_journal_title"),
                "volume": metac("citation_volume"),
                "year": metac("citation_publication_date"),
                "authors": authors,
                "adapter": "aanda"}

    # -- structural walk ---------------------------------------------------- #
    def _walk(self, contenu: Tag, ids: _IdGen, amap: dict, holders: list,
              base_url: str, fetcher: Fetcher, asset_dir: Path,
              config: HtmlConfig) -> list[Section]:
        roots: list[Section] = []
        stack: list[Section] = []
        current: Section | None = None
        skip_blocks = False
        in_body = False              # True once the first real section heading is seen
        appendix_n = 0

        def add_section(sec: Section, level: int) -> None:
            nonlocal current
            while stack and stack[-1].level >= level:
                stack.pop()
            (stack[-1].children if stack else roots).append(sec)
            stack.append(sec)
            current = sec

        # Abstract (one or more <p> inside div#head) becomes a leading section.
        abs_nodes = self._abstract(contenu)
        if abs_nodes:
            sec = Section(id=ids.next("sec"), level=1, heading="Abstract",
                          heading_raw="Abstract", page_idx=0)
            for node in abs_nodes:
                para = Paragraph(id=ids.next("p"), page_idx=0, text="")
                holders.append((para, node))
                sec.blocks.append(para)
            roots.append(sec)
            stack.append(sec)
            current = sec

        for child in contenu.children:
            if not isinstance(child, Tag):
                continue
            name = child.name.lower()
            cls = child.get("class") or []
            hid = child.get("id") or ""

            if name in ("h2", "h3", "h4"):
                if "title" in cls or "subtitle" in cls:
                    continue                            # article title/subtitle
                if hid in ("tables", "figures"):
                    break                               # end-of-paper galleries
                in_body = True                          # we're past the front matter
                if hid == "references":
                    skip_blocks = True                  # skip the bibliography <ol>
                    current = None
                    continue
                skip_blocks = False
                level = {"h2": 1, "h3": 2, "h4": 3}[name]
                sec = self._make_section(child, ids, amap, level)
                if _APPENDIX_RE.match(plain_text(child)):
                    appendix_n += 1
                    amap[f"APP{appendix_n}"] = AnchorTarget(
                        "xref", target_id=sec.id, xref_kind="appendix")
                add_section(sec, level)
                continue

            # Drop front matter (copyright, dates, stray notes) that sits between
            # the header and the first section — the abstract is already its own
            # section, and authors/affiliations live inside div#head (skipped).
            if skip_blocks or not in_body:
                continue

            blocks = self._make_block(child, ids, amap, holders, base_url,
                                      fetcher, asset_dir, config)
            if not blocks:
                continue
            if current is None:
                current = Section(id=ids.next("sec"), level=1, heading="",
                                  page_idx=0)
                roots.append(current)
                stack.append(current)
            current.blocks.extend(blocks)

        return roots

    def _abstract(self, contenu: Tag) -> list[Tag]:
        """The abstract paragraph(s). A&A structured abstracts are split into one
        <p> per part (Context./Aims./Methods./Results./Conclusions.), so we must
        collect them all — not just the longest."""
        head = contenu.find("div", id="head")
        if head is None:
            return []

        # 1) explicit "Abstract" label -> the following <p> siblings, up to the
        #    keywords block. This also captures *unstructured* single-<p> abstracts.
        label = next((e for e in head.find_all(["p", "h2", "h3", "h4", "strong", "b"])
                      if e.get_text(strip=True).lower() == "abstract"), None)
        if label is not None:
            parts: list[Tag] = []
            for sib in label.next_siblings:
                if not isinstance(sib, Tag):
                    continue
                txt = sib.get_text(" ", strip=True)
                cls = " ".join(sib.get("class") or [])
                if "kw" in cls.lower() or re.match(r"key\s*words?\b", txt, re.I):
                    break
                if sib.name in ("h2", "h3", "h4"):
                    break
                if sib.name == "p" and txt:
                    parts.append(sib)
            if parts:
                return parts

        # 2) structured-abstract paragraphs identified by their leading marker.
        marker = re.compile(
            r"^(context|aims?|methods?|results?|conclusions?|summary|background|purpose)\b",
            re.I)
        parts = [p for p in head.find_all("p", recursive=True)
                 if marker.match(p.get_text(strip=True))]
        if parts:
            return parts

        # 3) fallback: the single longest prose paragraph in the header.
        ps = [p for p in head.find_all("p", recursive=True)
              if len(p.get_text(strip=True)) > 120
              and not p.get_text(strip=True).startswith("©")]
        best = max(ps, key=lambda p: len(p.get_text()), default=None)
        return [best] if best is not None else []

    def _make_section(self, h: Tag, ids: _IdGen, amap: dict, level: int) -> Section:
        raw = plain_text(h)
        number = None
        heading = raw
        ma = _APPENDIX_RE.match(raw)
        mn = _HEADING_NUM_RE.match(raw)
        if ma:
            number, heading = ma.group(1), (ma.group(2).strip() or raw)
        elif mn:
            number, heading = mn.group(1), mn.group(2).strip()
        sec = Section(id=ids.next("sec"), level=level, heading=heading,
                      heading_raw=raw, number=number, page_idx=0)
        hid = h.get("id") or ""
        if re.fullmatch(r"S\d+", hid):
            amap[hid] = AnchorTarget("xref", target_id=sec.id, xref_kind="section")
        return sec

    def _make_block(self, node: Tag, ids: _IdGen, amap: dict, holders: list,
                    base_url: str, fetcher: Fetcher, asset_dir: Path,
                    config: HtmlConfig) -> list:
        name = node.name.lower()
        cls = node.get("class") or []

        if name == "p":
            inset = node.find("div", class_="inset")
            if inset is not None:
                b = self._inset_block(inset, ids, amap, holders, base_url,
                                      fetcher, asset_dir, config)
                return [b] if b is not None else []
            # Display equations: a <p> may be equation-only (older A&A template)
            # or have the equation embedded mid-prose (2024+). Split either way.
            if node.find("span", class_="ressouce-equation-block") is not None:
                return self._split_para_eqs(node, ids, amap, holders)
            if not plain_text(node):
                return []
            para = Paragraph(id=ids.next("p"), page_idx=0, text="")
            holders.append((para, node))
            return [para]

        if name == "div" and "inset" in cls:
            b = self._inset_block(node, ids, amap, holders, base_url,
                                  fetcher, asset_dir, config)
            return [b] if b is not None else []

        if name in ("ol", "ul"):
            b = self._list(node, ids, holders, name == "ol")
            return [b] if b is not None else []

        # Other divs under #contenu are non-body (footnote defs, the reference
        # container #content, layout wrappers) — skip rather than risk pulling
        # the wrong text. Body prose is always flat <p>/<h*> in A&A.
        return []

    def _split_para_eqs(self, p: Tag, ids: _IdGen, amap: dict,
                        holders: list) -> list:
        """Split a paragraph around its display-equation spans, yielding an
        ordered mix of Paragraph (the prose between equations) and
        EquationBlock. Equation spans are direct children of the <p>."""
        out: list = []
        buf: list = []

        def flush() -> None:
            if not buf:
                return
            if any((c.get_text(strip=True) if isinstance(c, Tag)
                    else str(c).strip()) for c in buf):
                para = Paragraph(id=ids.next("p"), page_idx=0, text="")
                holders.append((para, list(buf)))
                out.append(para)
            buf.clear()

        for child in p.children:
            if isinstance(child, Tag) and \
                    "ressouce-equation-block" in (child.get("class") or []):
                flush()
                out.append(self._equation(child, ids, amap))
            else:
                buf.append(child)
        flush()
        return out

    def _inset_block(self, inset: Tag, ids: _IdGen, amap: dict, holders: list,
                     base_url: str, fetcher: Fetcher, asset_dir: Path,
                     config: HtmlConfig):
        hid = inset.get("id") or ""
        if re.fullmatch(r"F\d+", hid):
            return self._figure(inset, hid, ids, amap, holders, base_url,
                                fetcher, asset_dir, config)
        if re.fullmatch(r"T\d+", hid):
            return self._table(inset, hid, ids, amap, holders, base_url,
                               fetcher, config)
        return None                                     # id-less gallery inset

    def _equation(self, eq: Tag, ids: _IdGen, amap: dict) -> EquationBlock:
        # Source priority: original TeX annotation -> pandoc(MathML), which is
        # reliably KaTeX-clean -> the data-latex attribute (older templates ship
        # clean LaTeX here; 2024+ ship plain-TeX/MathType that KaTeX dislikes,
        # so the MathML route wins when available).
        latex = ""
        math_el = eq.find("math")
        if math_el is not None:
            latex = annotation_latex(math_el) or ""
            latex = strip_math_delims(latex) if latex else (mathml_to_latex(str(math_el)) or "")
        if not latex:
            dl = eq.get("data-latex")
            if dl:
                latex = strip_math_delims(_strip_aligned(dl))
        hid = eq.get("id") or ""
        m = re.fullmatch(r"FD(\d+)", hid)
        number = m.group(1) if m else None
        blk = EquationBlock(id=ids.next("eq"), page_idx=0, number=number,
                            label=(f"Equation {number}" if number else None),
                            latex=latex)
        if hid:
            amap[hid] = AnchorTarget("xref", target_id=blk.id, xref_kind="equation")
        return blk

    def _figure(self, node: Tag, hid: str, ids: _IdGen, amap: dict, holders: list,
                base_url: str, fetcher: Fetcher, asset_dir: Path,
                config: HtmlConfig) -> FigureBlock:
        n = hid[1:]
        label = self._float_label(node) or f"Fig. {n}"
        cap_node = self._caption_node(node)
        cap = RichText(text="")
        if cap_node is not None:
            holders.append((cap, cap_node))
        img_path = None
        img = node.find("img")
        if img is not None and img.get("src"):
            full = urljoin(base_url, re.sub(r"_small(\.[a-z]+)$", r"\1",
                                            img["src"], flags=re.I))
            img_path = self._asset(full, asset_dir, fetcher, config)
        blk = FigureBlock(id=ids.next("fig"), page_idx=0, number=n,
                          label=f"Figure {n}",
                          caption=cap if cap_node is not None else None,
                          img_path=img_path)
        amap[hid] = AnchorTarget("xref", target_id=blk.id, xref_kind="figure")
        return blk

    def _table(self, node: Tag, hid: str, ids: _IdGen, amap: dict, holders: list,
               base_url: str, fetcher: Fetcher, config: HtmlConfig) -> TableBlock:
        n = hid[1:]
        cap_node = self._caption_node(node)
        cap = RichText(text="")
        if cap_node is not None:
            holders.append((cap, cap_node))
        table_body = None
        if config.fetch_subpages:
            table_body = self._fetch_table_body(node, base_url, fetcher)
        blk = TableBlock(id=ids.next("tab"), page_idx=0, number=n,
                         label=f"Table {n}",
                         caption=cap if cap_node is not None else None,
                         table_body=table_body)
        amap[hid] = AnchorTarget("xref", target_id=blk.id, xref_kind="table")
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
        return ListBlock(id=ids.next("list"), page_idx=0, ordered=ordered,
                         items=items)

    # -- float helpers ------------------------------------------------------ #
    def _float_label(self, node: Tag) -> str | None:
        b = node.find("span", class_="bold")
        return plain_text(b) if b else None

    def _caption_node(self, node: Tag) -> Tag | None:
        """The <p> carrying the float caption (figures: in td.img-txt; tables:
        in div.ligne). Falls back to any <p> in the inset."""
        cell = node.find("td", class_="img-txt") or node.find("div", class_="ligne")
        scope = cell if cell is not None else node
        p = scope.find("p")
        return p

    def _fetch_table_body(self, node: Tag, base_url: str,
                          fetcher: Fetcher) -> str | None:
        link = node.find("a", href=True)
        if not link:
            return None
        url = urljoin(base_url, link["href"])
        try:
            _, sub = fetcher.get_soup(url)
        except Exception as e:
            log.warning("table sub-page fetch failed %s (%s)", url, e)
            return None
        tables = sub.find_all("table")
        if not tables:
            return None
        data = max(tables, key=lambda t: len(t.find_all("tr")))
        return _clean_table_html(data)

    def _asset(self, url: str, asset_dir: Path, fetcher: Fetcher,
               config: HtmlConfig) -> str | None:
        if not config.download_assets:
            return url                                  # remote-reference mode
        fn = re.sub(r"[^A-Za-z0-9._-]+", "_", url.split("/")[-1].split("?")[0])
        dest = asset_dir / fn
        if fetcher.download(url, dest):
            return f"assets/{fn}"
        return None                                     # failed: caption-only

    # -- references --------------------------------------------------------- #
    def _references(self, soup: BeautifulSoup, ids: _IdGen,
                    amap: dict) -> list[Reference]:
        refs: list[Reference] = []
        for li in soup.find_all("li", id=re.compile(r"^R\d+$")):
            rid = ids.next("ref")
            ref = _parse_aanda_ref(li, rid)
            refs.append(ref)
            amap[li["id"]] = AnchorTarget("cite", ref_id=rid)
        return refs

    # -- full-text location fallback --------------------------------------- #
    def _locate_fulltext(self, soup: BeautifulSoup, base_url: str,
                         fetcher: Fetcher):
        a = soup.find("a", href=re.compile(r"full_html/.*\.html"))
        if a and a.get("href"):
            url = urljoin(base_url, a["href"].split("#")[0])
            return fetcher.get_soup(url)
        return base_url, soup


# --------------------------------------------------------------------------- #
# Module helpers
# --------------------------------------------------------------------------- #

def _strip_aligned(latex: str) -> str:
    """Unwrap a single-row ``\\begin{aligned}..\\end{aligned}`` (A&A wraps every
    display equation in it); multi-row alignments are kept intact."""
    s = strip_math_delims(latex.strip())
    m = re.fullmatch(r"\\begin\{aligned\}(.*)\\end\{aligned\}", s.strip(), re.S)
    if m and "\\\\" not in m.group(1):
        return m.group(1).strip().rstrip("&").strip()
    return s


_TABLE_KEEP = {"table", "thead", "tbody", "tfoot", "tr", "td", "th",
               "sub", "sup", "i", "b", "em", "strong", "br", "span"}
_TABLE_ATTRS = {"colspan", "rowspan", "align", "valign"}


def _clean_table_html(table: Tag) -> str:
    """Serialize a data table, dropping links/attrs/classes the reader can't use
    (footnote anchors are unwrapped to their text; structure + sub/sup kept)."""
    soup = BeautifulSoup(str(table), "html.parser")
    for a in soup.find_all("a"):
        a.unwrap()
    for tag in soup.find_all(True):
        if tag.name not in _TABLE_KEEP:
            tag.unwrap()
            continue
        tag.attrs = {k: v for k, v in tag.attrs.items() if k in _TABLE_ATTRS}
    return str(soup).strip()


def _parse_aanda_ref(li: Tag, ref_id: str) -> Reference:
    """Parse one ``<li id="R..">`` bibliography entry into a Reference."""
    # raw text = the entry minus the trailing [NASA ADS]/[CrossRef]/... links.
    clone = BeautifulSoup(str(li), "html.parser")
    for a in clone.find_all("a"):
        a.decompose()
    for sp in clone.find_all("span", class_="Z3988"):
        sp.decompose()
    raw = re.sub(r"\s+", " ", clone.get_text(" ")).strip(" .;,")

    ref = _parse_one(ref_id, raw, None)

    # authoritative DOI / arXiv / ADS bibcode from the entry's links
    for a in li.find_all("a", href=True):
        href = a["href"]
        if "doi.org/" in href and not ref.doi:
            ref.doi = href.split("doi.org/")[-1].rstrip(".,);")
        if "arxiv.org" in href.lower() and not ref.arxiv_id:
            m = re.search(r"(\d{4}\.\d{4,5})", href)
            if m:
                ref.arxiv_id = m.group(1)

    # venue / volume / pages from the consistent A&A tail
    m = _REF_TAIL_RE.search(raw)
    if m:
        ref.venue = ref.venue or m.group("venue").strip()
        ref.volume = ref.volume or m.group("vol")
        ref.pages = ref.pages or re.sub(r"\s", "", m.group("pages"))
    return ref
