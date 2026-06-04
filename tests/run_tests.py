#!/usr/bin/env python
"""Offline test suite for the bibgraph parsers (no MinerU API, no pytest).

Run:  /home/wwu/miniforge3/envs/astro/bin/python tests/run_tests.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bibgraph.config import MineruConfig, PipelineConfig          # noqa: E402
from bibgraph.mineru_client import MineruResult                   # noqa: E402
from bibgraph.pdf_links import LinkAnnot, PdfLinks                 # noqa: E402
from bibgraph.pipeline import build_document                      # noqa: E402
from bibgraph.schema import (CitationOccurrence, CrossRefOccurrence,  # noqa: E402
                             Reference)
from bibgraph.ingest.annotate import Match, apply_matches         # noqa: E402
from bibgraph.ingest.citations import (ReferenceResolver,         # noqa: E402
                                       detect_citations,
                                       enrich_citations_with_links)
from bibgraph.ingest.crossrefs import (XrefIndex, detect_crossrefs,  # noqa: E402
                                       enrich_crossrefs_with_links)
from bibgraph.ingest.references import parse_references            # noqa: E402
from bibgraph.ingest.structure import build_structure             # noqa: E402
from bibgraph.acquire.bibtex import parse_bibtex_text             # noqa: E402
from bibgraph.acquire.planner import classify, plan_sources       # noqa: E402
from bibgraph.acquire.resolve import resolve_work                 # noqa: E402
from bibgraph.library.sources.crossref import Crossref            # noqa: E402
from bibgraph.library.store import Work                           # noqa: E402

FIX = ROOT / "tests" / "fixtures"

_failures: list[str] = []
_passes = 0


def check(cond: bool, msg: str) -> None:
    global _passes
    if cond:
        _passes += 1
    else:
        _failures.append(msg)
        print(f"  FAIL: {msg}")


def _load_fixture() -> list[dict]:
    return json.loads((FIX / "sample_content_list.json").read_text("utf-8"))


def _synthetic_links() -> PdfLinks:
    # DOI link sitting over the intro paragraph (page 0), pointing at ref-1.
    return PdfLinks(
        n_pages=3,
        page_sizes=[(612.0, 792.0)] * 3,
        links=[LinkAnnot(page_idx=0, rect=(0.20, 0.25, 0.30, 0.27), kind="uri",
                         uri="https://doi.org/10.1051/0004-6361/202039341",
                         doi="10.1051/0004-6361/202039341")],
        has_text=True)


def _build(with_links: bool):
    content = _load_fixture()
    mineru = MineruResult(out_dir=Path("."), content_list=content, middle={},
                          batch_id="test-batch")
    cfg = PipelineConfig(mineru=MineruConfig(is_ocr=False),
                         use_pdf_links=with_links)
    links = _synthetic_links() if with_links else None
    return build_document(mineru, FIX / "sample.pdf", links, cfg)


# --------------------------------------------------------------------------- #
def test_structure() -> None:
    sr = build_structure(_load_fixture())
    top = sr.sections
    headings = [s.heading for s in top]
    check(sr.title_guess == "On the dynamics of low-mass open clusters",
          f"title_guess wrong: {sr.title_guess}")
    check("Introduction" in headings, f"missing Introduction: {headings}")
    check("Methods" in headings, f"missing Methods: {headings}")
    methods = next(s for s in top if s.heading == "Methods")
    check(methods.number == "2", f"methods number {methods.number}")
    check(any(c.heading == "Data" and c.number == "2.1" for c in methods.children),
          "Data subsection not nested under Methods")
    check(len(sr.ref_text_items) == 2, f"ref_text count {len(sr.ref_text_items)}")
    # floats present
    types = [b.type for s in top for b in s.iter_blocks()]
    for t in ("figure", "table", "equation", "algorithm", "code", "list"):
        check(t in types, f"missing block type {t}")


def test_references() -> None:
    content = _load_fixture()
    refs = parse_references([c for c in content if c.get("type") == "ref_text"])
    check(len(refs) == 2, f"ref count {len(refs)}")
    r1 = refs[0]
    check(r1.authors[:2] == ["Hunt", "Reffert"], f"r1 authors {r1.authors}")
    check(r1.year == 2021, f"r1 year {r1.year}")
    check(r1.doi == "10.1051/0004-6361/202039341", f"r1 doi {r1.doi}")
    r2 = refs[1]
    check(r2.authors[0] == "Cantat-Gaudin", f"r2 first author {r2.authors}")
    check(r2.year == 2020, f"r2 year {r2.year}")


def test_references_author_styles() -> None:
    # MNRAS/ADS style: "Surname I., Surname I., year"
    r = parse_references([{"type": "ref_text",
        "text": "Banik I., Zhao H., Famaey B., 2018, A&A, 614, A53."}])[0]
    check(r.authors[:3] == ["Banik", "Zhao", "Famaey"],
          f"MNRAS authors wrong: {r.authors}")
    check(r.year == 2018, f"MNRAS year {r.year}")
    # A&A style: "Surname, I. J. & Surname, I."
    r2 = parse_references([{"type": "ref_text",
        "text": "Hunt, E. L. & Reffert, S. 2021, A&A, 646, A104."}])[0]
    check(r2.authors == ["Hunt", "Reffert"], f"A&A authors wrong: {r2.authors}")
    # hyphenated + initials-first
    r3 = parse_references([{"type": "ref_text",
        "text": "Cantat-Gaudin T., Anders F., 2020, A&A, 640, A1."}])[0]
    check(r3.authors[:2] == ["Cantat-Gaudin", "Anders"], f"hyphen authors {r3.authors}")


def test_references_numbered() -> None:
    items = [
        {"type": "ref_text", "text": "[1] A. Smith, \"A title,\" Journal, 2019."},
        {"type": "ref_text", "text": "[2] B. Jones and C. Lee, Another, 2020. doi:10.1/x"},
    ]
    refs = parse_references(items)
    check(len(refs) == 2, f"numbered ref count {len(refs)}")
    check(refs[0].label == "1" and refs[1].label == "2",
          f"labels {[r.label for r in refs]}")
    check(refs[0].title == "A title", f"title {refs[0].title}")
    # split a single merged block with two numbered entries
    merged = [{"type": "ref_text", "text": "[1] First ref 2001. [2] Second ref 2002."}]
    refs2 = parse_references(merged)
    check(len(refs2) == 2, f"merged numbered split -> {len(refs2)}")


def test_citations_regex() -> None:
    doc = _build(with_links=False)
    resolver = ReferenceResolver(doc.references)
    check(resolver.author_year and not resolver.numbered,
          "style detection (should be author-year)")
    # find the intro paragraph (resolved by token presence)
    intro = _find_paragraph(doc, "radial acceleration relation")
    check(intro is not None, "intro paragraph not found")
    check("[[cite:ref-1;ref-2]]" in intro.text,
          f"grouped citation token missing: {intro.text}")
    check(len(intro.citations) == 1, f"intro citations {len(intro.citations)}")
    check(set(intro.citations[0].ref_ids) == {"ref-1", "ref-2"},
          f"intro ref_ids {intro.citations[0].ref_ids}")
    # [0, 1] must NOT be a citation (author-year style)
    check("[[cite:" not in intro.text.split("Numbers like")[1],
          "[0,1] wrongly tokenized as citation")
    # abstract narrative + parenthetical
    abs = _find_paragraph(doc, "Abstract")
    check(abs is not None and abs.text.count("[[cite:") == 2,
          f"abstract citations: {abs.text if abs else None}")


def test_crossrefs_regex() -> None:
    doc = _build(with_links=False)
    intro = _find_paragraph(doc, "radial acceleration relation")
    fig = _first_block(doc, "figure")
    tab = _first_block(doc, "table")
    eq = _first_block(doc, "equation")
    check(f"[[xref:{fig.id}]]" in intro.text, "figure xref token missing")
    check(f"[[xref:{tab.id}]]" in intro.text, "table xref token missing")
    check(f"[[xref:{eq.id}]]" in intro.text, "equation xref token missing")
    check("[[xref:sec" in intro.text, "section xref token missing")
    kinds = {x.kind for x in intro.crossrefs}
    check({"figure", "table", "equation", "section"} <= kinds,
          f"intro crossref kinds {kinds}")
    # methods paragraph: algorithm + listing
    meth = _find_paragraph(doc, "We use the algorithm")
    algo = _first_block(doc, "algorithm")
    code = _first_block(doc, "code")
    check(f"[[xref:{algo.id}]]" in meth.text, "algorithm xref missing")
    check(f"[[xref:{code.id}]]" in meth.text, "listing xref missing")
    # appendix reference resolves
    sub = _find_paragraph(doc, "Subsection content")
    check("appendix" in {x.kind for x in sub.crossrefs}, "appendix xref kind missing")
    check(all(x.resolved for x in sub.crossrefs),
          f"unresolved appendix/section xref: {[ (x.kind,x.resolved) for x in sub.crossrefs]}")


def test_list_and_caption_annotation() -> None:
    doc = _build(with_links=False)
    lst = _first_block(doc, "list")
    joined = " ".join(it.text for it in lst.items)
    check("[[xref:" in joined, f"list item xref missing: {joined}")
    check("[[cite:ref-1]]" in joined, f"list item citation missing: {joined}")
    fig = _first_block(doc, "figure")
    check(fig.caption is not None and "[[cite:ref-1]]" in fig.caption.text,
          f"caption citation missing: {fig.caption.text if fig.caption else None}")
    # the float's own label must NOT be tokenized as a self cross-reference
    check(fig.label == "Figure 1" and "[[xref:fig-1]]" not in fig.caption.text,
          f"caption self-xref leaked: {fig.caption.text}")
    check(fig.caption.text.startswith("The radial"),
          f"caption label not stripped: {fig.caption.text}")


def test_hybrid_links_citation() -> None:
    doc = _build(with_links=True)
    intro = _find_paragraph(doc, "radial acceleration relation")
    via = intro.citations[0].via
    check(via == "hyperlink+regex",
          f"DOI link should corroborate citation, via={via}")


def test_hybrid_links_crossref_goto() -> None:
    # tiny doc: a paragraph referencing an unnumbered equation, resolved by GoTo
    content = [
        {"type": "text", "text": "See Eq. (1) for details.", "page_idx": 0,
         "bbox": [100, 100, 900, 140]},
        {"type": "equation", "text": "E = m c^2", "page_idx": 0,
         "bbox": [300, 400, 700, 450]},
    ]
    mineru = MineruResult(out_dir=Path("."), content_list=content, middle={})
    links = PdfLinks(n_pages=1, page_sizes=[(612.0, 792.0)],
                     links=[LinkAnnot(page_idx=0, rect=(0.15, 0.12, 0.25, 0.14),
                                      kind="goto", target_page=0,
                                      target_point=(0.5, 0.425))])
    cfg = PipelineConfig(mineru=MineruConfig(is_ocr=False), use_pdf_links=True)
    doc = build_document(mineru, FIX / "tiny.pdf", links, cfg)
    para = _find_paragraph(doc, "for details")
    eq = _first_block(doc, "equation")
    check(len(para.crossrefs) == 1, f"crossref count {len(para.crossrefs)}")
    xr = para.crossrefs[0]
    check(xr.target_id == eq.id and xr.resolved and xr.via == "hyperlink",
          f"GoTo crossref not resolved: target={xr.target_id} via={xr.via}")
    check(f"[[xref:{eq.id}]]" in para.text, f"goto xref token missing: {para.text}")


def test_classify_dest() -> None:
    from bibgraph.pdf_links import _classify_dest
    cases = {
        "cite.2000ApJ...533L..99M": "cite", "cite.Poggio21": "cite",
        "section.7": "section", "subsection.2.1": "section",
        "figure.3": "figure", "table.1": "table", "equation.2": "equation",
        "Doc-Start": None, "Hfootnote.1": None, "page.5": None,
    }
    for name, expected in cases.items():
        got = _classify_dest(name)
        check(got == expected, f"_classify_dest({name!r}) -> {got} != {expected}")


def test_named_dest_citation_resolution() -> None:
    # A citation regex *detects* but cannot resolve (no matching ref); a
    # hyperref cite.* named link resolves it by pointing at the bib entry.
    content = [
        {"type": "text", "text": "We follow (Smith & Jones 2019) here.",
         "page_idx": 0, "bbox": [100, 100, 900, 140]},
        {"type": "text", "text": "References", "text_level": 1,
         "page_idx": 0, "bbox": [100, 200, 900, 220]},
        {"type": "ref_text", "text": "Different, A. 2019, Some Journal, 1, 1.",
         "page_idx": 0, "bbox": [100, 230, 900, 260]},
    ]
    mineru = MineruResult(out_dir=Path("."), content_list=content, middle={})
    links = PdfLinks(n_pages=1, page_sizes=[(612.0, 792.0)],
                     links=[LinkAnnot(page_idx=0, rect=(0.20, 0.11, 0.30, 0.13),
                                      kind="goto", target_page=0,
                                      target_point=(0.5, 0.245),
                                      dest_name="cite.Smith2019",
                                      dest_kind="cite")])
    cfg = PipelineConfig(mineru=MineruConfig(is_ocr=False), use_pdf_links=True)
    doc = build_document(mineru, FIX / "named.pdf", links, cfg)
    para = _find_paragraph(doc, "We follow")
    check(len(para.citations) == 1, f"citation count {len(para.citations)}")
    c = para.citations[0]
    check(c.ref_ids == ["ref-1"] and c.resolved and c.via == "hyperlink",
          f"named cite not resolved: ref_ids={c.ref_ids} via={c.via}")
    check("[[cite:ref-1]]" in para.text, f"token missing: {para.text}")


def test_chart_as_figure() -> None:
    # MinerU VLM tags plots as type "chart" with chart_caption/content
    content = [
        {"type": "chart", "img_path": "images/c.jpg", "sub_type": "line",
         "content": "| col | col |", "chart_caption": ["Figure 2. A nice plot."],
         "chart_footnote": [], "page_idx": 0, "bbox": [60, 60, 480, 270]},
        {"type": "text", "text": "We refer to Fig. 2 here.", "page_idx": 0,
         "bbox": [60, 300, 480, 340]},
    ]
    mineru = MineruResult(out_dir=Path("."), content_list=content, middle={})
    cfg = PipelineConfig(mineru=MineruConfig(is_ocr=False), use_pdf_links=False)
    doc = build_document(mineru, FIX / "chart.pdf", None, cfg)
    fig = _first_block(doc, "figure")
    check(fig is not None, "chart not converted to figure")
    check(fig.number == "2" and fig.label == "Figure 2", f"chart label {fig.label}")
    check(fig.chart_type == "line" and fig.content == "| col | col |",
          f"chart fields: type={fig.chart_type} content={fig.content}")
    check(fig.caption.text == "A nice plot.", f"chart caption {fig.caption.text}")
    para = _find_paragraph(doc, "We refer")
    check(f"[[xref:{fig.id}]]" in para.text, "chart not resolvable by xref")


def test_unicode_author_citation() -> None:
    content = [
        {"type": "text", "text": "As found by Åström (2019).", "page_idx": 0,
         "bbox": [100, 100, 900, 140]},
        {"type": "ref_text", "text": "Åström, K. 2019, A&A, 1, 1.", "page_idx": 1,
         "bbox": [100, 100, 900, 130]},
    ]
    mineru = MineruResult(out_dir=Path("."), content_list=content, middle={})
    cfg = PipelineConfig(mineru=MineruConfig(is_ocr=False), use_pdf_links=False)
    doc = build_document(mineru, FIX / "uni.pdf", None, cfg)
    para = _find_paragraph(doc, "As found by")
    check(len(para.citations) == 1 and para.citations[0].resolved,
          f"unicode author citation not resolved: {para.text}")


def test_lowercase_crossref() -> None:
    content = [
        {"type": "text", "text": "1 Intro", "text_level": 1, "page_idx": 0,
         "bbox": [100, 80, 900, 100]},
        {"type": "text", "text": "see figure 1 and table 1 and section 2.",
         "page_idx": 0, "bbox": [100, 120, 900, 160]},
        {"type": "image", "img_caption": ["Figure 1: x"], "page_idx": 0,
         "bbox": [100, 200, 900, 400]},
        {"type": "table", "table_caption": ["Table 1: y"], "table_body": "<table></table>",
         "page_idx": 0, "bbox": [100, 420, 900, 500]},
        {"type": "text", "text": "2 Methods", "text_level": 1, "page_idx": 0,
         "bbox": [100, 520, 900, 540]},
    ]
    mineru = MineruResult(out_dir=Path("."), content_list=content, middle={})
    cfg = PipelineConfig(mineru=MineruConfig(is_ocr=False), use_pdf_links=False)
    doc = build_document(mineru, FIX / "lc.pdf", None, cfg)
    para = next(b for b in doc.iter_blocks()
                if b.type == "paragraph" and b.crossrefs)
    kinds = {x.kind for x in para.crossrefs}
    check({"figure", "table", "section"} <= kinds,
          f"lowercase crossrefs not detected: {kinds} :: {para.text}")
    check(all(x.resolved for x in para.crossrefs),
          f"lowercase crossrefs unresolved: {[(x.kind,x.resolved) for x in para.crossrefs]}")


def test_citation_link_no_reuse() -> None:
    # [review-1] corroborating a resolved citation must CONSUME its link target
    refs = [Reference(id="ref-1", raw="r1", doi="10.1/a"),
            Reference(id="ref-2", raw="r2", doi="10.2/b")]
    resolver = ReferenceResolver(refs)
    links = [LinkAnnot(0, (0.1, 0.1, 0.2, 0.12), "uri", uri="x", doi="10.1/a"),
             LinkAnnot(0, (0.3, 0.1, 0.4, 0.12), "uri", uri="y", doi="10.2/b")]
    m1 = Match(0, 5, CitationOccurrence(ref_ids=["ref-1"], raw="a", resolved=True))
    m2 = Match(6, 11, CitationOccurrence(ref_ids=[], raw="b", resolved=False))
    enrich_citations_with_links([m1, m2], links, resolver)
    check(m1.occ.via == "hyperlink+regex", f"m1 not corroborated: {m1.occ.via}")
    check(m2.occ.ref_ids == ["ref-2"],
          f"link target reused (should be ref-2): {m2.occ.ref_ids}")


def test_textfix_repair() -> None:
    from bibgraph.ingest.textfix import repair_text
    # a ?-gap is filled from the aligned text layer
    new, n = repair_text("field of order ?? then", "field of order a0 then")
    check(new == "field of order a0 then" and n == 1, f"gap not repaired: {new!r} ({n})")
    # multiple gaps in one string
    new, n = repair_text("with ?? and ????", "with N and Sgr")
    check("?" not in new and n == 2, f"multi-gap repair wrong: {new!r} ({n})")
    # single '?' (real question mark / unresolved token) is left untouched
    new, n = repair_text("is it true? yes", "is it true? yes")
    check(new == "is it true? yes" and n == 0, f"single ? touched: {new!r}")
    # if the text layer also failed (still '?'), leave the OCR gap as-is
    new, n = repair_text("order ?? then", "order ?? then")
    check(new == "order ?? then" and n == 0, f"dirty layer spliced: {new!r}")
    # OCR baseline preserved where OCR/layer legitimately differ (British vs US)
    new, n = repair_text("the colour ?? value", "the color a0 value")
    check(new == "the colour a0 value" and n == 1, f"baseline not preserved: {new!r}")
    # REGRESSION: when the layer does NOT correspond to the OCR, real words next
    # to a gap must never be deleted/overwritten — leave the gap untouched.
    new, n = repair_text("keep?? drop", "GONE")
    check(new == "keep?? drop" and n == 0, f"real text destroyed: {new!r} ({n})")
    # REGRESSION (the shipped footnote bug): a mismatched layer (e.g. a footnote
    # bbox returning table cells) must not splice garbage over real prose — the
    # correspondence gate leaves the whole holder untouched.
    ocr = "Gas-rich galaxies only. ?? Corrected for X. ?? Based on density."
    new, n = repair_text(ocr, "Reference Na a0 Begeman (1991) Stark (2009) Lelli")
    check(new == ocr and n == 0, f"mismatched-layer holder altered: {new!r} ({n})")
    # REGRESSION: a pure-symbol holder (no alphanumerics) cannot have its
    # correspondence verified -> fail closed, never splice.
    new, n = repair_text("(??)", "(see Eq. 4 below)")
    check(new == "(??)" and n == 0, f"zero-alnum holder spliced: {new!r} ({n})")
    # PERF: oversized / mid-large repetitive holders must return promptly
    # (no super-linear hang) — exercises the hard cap and the autojunk path.
    big = "word ?? " * 2000           # ~16k chars, over the hard length cap
    new, n = repair_text(big, "word X0 " * 2000)
    check(new == big and n == 0, "oversized holder not skipped")
    mid = "alpha ?? beta " * 500      # ~7k chars, over the autojunk threshold
    check(isinstance(repair_text(mid, "alpha qq beta " * 500)[0], str),
          "mid-large input did not return")


def test_caption_minus_preserved() -> None:
    from bibgraph.ingest.structure import _split_caption, FIG_NUM_RE
    num, label, body = _split_caption("Figure 1: -5 to 5 km/s", FIG_NUM_RE, "Figure")
    check(body == "-5 to 5 km/s", f"minus sign eaten: {body!r}")


def test_xref_index_excludes_paragraphs() -> None:
    doc = _build(with_links=False)
    idx = XrefIndex(doc)
    float_ids = {b.id for b in doc.iter_blocks()
                 if b.type in ("figure", "table", "equation", "code", "algorithm")}
    sec_ids = {s.id for s in doc.iter_sections()}
    for bid, _, _ in idx.boxes:
        check(bid in float_ids or bid in sec_ids,
              f"xref point-resolution box points at non-target block {bid}")


def test_apply_matches_overlap() -> None:
    text = "see (Smith 2019) here"
    occ_a = CitationOccurrence(ref_ids=["ref-1"], raw="(Smith 2019)")
    occ_b = CrossRefOccurrence(kind="section", raw="Smith 2019", number="1")
    m_long = Match(4, 16, occ_a)        # the whole parenthetical
    m_short = Match(5, 15, occ_b)       # nested, should be dropped
    new, cites, xrefs = apply_matches(text, [m_short, m_long])
    check(new == "see [[cite:ref-1]] here", f"overlap rewrite wrong: {new!r}")
    check(len(cites) == 1 and len(xrefs) == 0, "overlap should keep longer match")


def test_unresolved_xref_token() -> None:
    # an equation reference with no matching element -> typed placeholder token
    content = [{"type": "text", "text": "As in Fig. 9 we see.", "page_idx": 0,
                "bbox": [100, 100, 900, 140]}]
    mineru = MineruResult(out_dir=Path("."), content_list=content, middle={})
    cfg = PipelineConfig(mineru=MineruConfig(is_ocr=False), use_pdf_links=False)
    doc = build_document(mineru, FIX / "x.pdf", None, cfg)
    para = _find_paragraph(doc, "we see")
    check("[[xref:figure-9?]]" in para.text, f"unresolved token wrong: {para.text}")
    check(para.crossrefs[0].resolved is False, "should be unresolved")


def test_full_json_serialization() -> None:
    doc = _build(with_links=True)
    d = doc.to_dict(compact_json=True)
    # round-trips through JSON
    s = json.dumps(d, ensure_ascii=False)
    d2 = json.loads(s)
    check(d2["stats"]["n_references"] == 2, "stats n_references")
    check(d2["stats"]["n_citations"] >= 4, f"stats n_citations {d2['stats']['n_citations']}")
    check(d2["stats"]["n_crossrefs"] >= 6, f"stats n_crossrefs {d2['stats']['n_crossrefs']}")
    check(len(d2["index"]["figures"]) == 1, "index figures")
    check(all(b.get("page_idx") is not None for s in d2["structure"]
              for b in s.get("blocks", []) if b.get("type") == "paragraph"),
          "page_idx dropped from paragraphs (compaction bug)")
    # save for manual inspection
    (FIX / "sample_output.json").write_text(
        json.dumps(d, ensure_ascii=False, indent=2), "utf-8")


# --------------------------------------------------------------------------- #
# HTML pipeline (A&A adapter) — offline, parses a saved fixture page.
# --------------------------------------------------------------------------- #

def _build_html():
    from bs4 import BeautifulSoup
    from bibgraph.config import HtmlConfig
    from bibgraph.ingest_html import adapter_for
    from bibgraph.ingest_html.fetch import Fetcher
    from bibgraph.pipeline_html import _annotate_document
    from bibgraph.schema import Document

    import tempfile
    base = "https://www.aanda.org/articles/aa/full_html/x/x.html"
    soup = BeautifulSoup((FIX / "sample_aanda.html").read_text("utf-8"), "html.parser")
    adapter = adapter_for(base, soup)
    cfg = HtmlConfig(download_assets=False, fetch_subpages=False,
                     use_cache=False, request_delay=0)
    tmp = Path(tempfile.mkdtemp(prefix="bibgraph-test-"))
    fetcher = Fetcher(tmp / "cache", user_agent="test", use_cache=False, delay=0)
    parsed = adapter.parse(soup, base_url=base, fetcher=fetcher,
                           asset_dir=(tmp / "assets"), config=cfg)
    doc = Document(doc_id="x", source={"type": "html", "n_pages": 1},
                   meta={"title": parsed.title, "html": parsed.meta},
                   structure=parsed.sections, references=parsed.references)
    _annotate_document(doc)
    return doc


def test_html_adapter_selected() -> None:
    from bs4 import BeautifulSoup
    from bibgraph.ingest_html import adapter_for
    soup = BeautifulSoup("<html></html>", "html.parser")
    a = adapter_for("https://www.aanda.org/articles/aa/full_html/x/x.html", soup)
    check(a is not None and a.name == "aanda", f"A&A adapter not selected: {a}")


def test_html_structure_and_title() -> None:
    doc = _build_html()
    check(doc.meta["title"] == "A Sample A&A Paper - I. Testing the HTML pipeline",
          f"title wrong: {doc.meta['title']}")
    headings = [s.heading for s in doc.iter_sections()]
    check("Introduction" in headings, f"missing Introduction: {headings}")
    check("Results" in headings, f"missing Results: {headings}")
    check("Acknowledgments" in headings, "missing Acknowledgments")
    # title/subtitle are NOT sections; References/All Figures galleries excluded
    check("A Sample A&A Paper" not in headings, "article title leaked as section")
    check(not any("All Figures" in h for h in headings), "All Figures gallery not skipped")
    check(any(s.heading == "Abstract" for s in doc.iter_sections()), "abstract section missing")


def test_html_abstract_multipart() -> None:
    doc = _build_html()
    sec = next((s for s in doc.iter_sections() if s.heading == "Abstract"), None)
    check(sec is not None, "no Abstract section")
    text = " ".join(b.text for b in sec.blocks if b.type == "paragraph")
    for part in ("Context.", "Aims.", "Methods.", "Results.", "Conclusions."):
        check(part in text, f"abstract missing {part!r} part: {text[:80]!r}")
    # affiliation / received / keywords must NOT bleed into the abstract
    check("Received" not in text and "Key words" not in text
          and "Some Institute" not in text, f"non-abstract text leaked: {text!r}")
    check(len(sec.blocks) >= 5, f"abstract parts collapsed: {len(sec.blocks)} blocks")
    # front-matter copyright line between header and first section is dropped
    alltext = " ".join(b.text for b in doc.iter_blocks() if b.type == "paragraph")
    check("ESO 2020" not in alltext, "copyright/front-matter leaked into body")


def test_html_authoritative_citation() -> None:
    doc = _build_html()
    p = _find_paragraph(doc, "magnitude")          # 'Smith' becomes a cite token
    check(p is not None, "intro paragraph not found")
    check("[[cite:ref-1]]" in p.text, f"cite token missing: {p.text!r}")
    occ = p.citations[0]
    check(occ.via == "hyperlink" and occ.resolved, f"cite not authoritative: {occ.via}")
    check(occ.ref_ids == ["ref-1"], f"cite ref_ids {occ.ref_ids}")


def test_html_crossref_resolution() -> None:
    doc = _build_html()
    text = " ".join(b.text for b in doc.iter_blocks() if b.type == "paragraph")
    check("[[xref:fig-1]]" in text, "figure xref not resolved")
    check("[[xref:eq-1]]" in text, "equation xref not resolved")
    check("[[xref:tab-1]]" in text, "table xref not resolved")
    # an unlinked "Sect. 1" still resolves via the regex fallback + XrefIndex
    kinds = {(x.kind, x.resolved) for b in doc.iter_blocks()
             for x in getattr(b, "crossrefs", [])}
    check(("section", True) in kinds, f"unlinked Sect. 1 not resolved: {kinds}")


def test_html_inline_math_conservative() -> None:
    doc = _build_html()
    p = _find_paragraph(doc, "magnitude")
    # single-letter var + sub -> $G_{\mathrm{BP}}$ ; prose italic 'Gaia' stays plain
    check("$G_{\\mathrm{BP}}$" in p.text, f"inline math not wrapped: {p.text!r}")
    check("Gaia" in p.text and "$Gaia$" not in p.text, "prose italic wrongly mathified")
    # footnote marker dropped (no stray superscript '1' glued to the word)
    check("matters for" in p.text, f"footnote not dropped: {p.text!r}")
    # unit superscript yr^{-1} (in the post-equation paragraph)
    alltext = " ".join(b.text for b in doc.iter_blocks() if b.type == "paragraph")
    check("\\mathrm{yr}^{-1}" in alltext, f"unit exponent missing: {alltext!r}")


def test_html_equation_split_from_prose() -> None:
    doc = _build_html()
    eq = _first_block(doc, "equation")
    check(eq is not None, "embedded equation not extracted as a block")
    check("mc^" in eq.latex, f"equation latex wrong: {eq.latex!r}")
    check(eq.number == "1", f"equation number {eq.number}")
    # the prose around the embedded equation is preserved as paragraphs
    check(_find_paragraph(doc, "The energy is") is not None
          or _find_paragraph(doc, "as in") is not None,
          "prose around embedded equation lost")


def test_html_reference_parse() -> None:
    doc = _build_html()
    check(len(doc.references) == 1, f"ref count {len(doc.references)}")
    r = doc.references[0]
    check(r.id == "ref-1", f"ref id {r.id}")
    check(r.year == 2020, f"ref year {r.year}")
    check(r.doi == "10.1051/0004-6361/200000002", f"ref doi {r.doi}")
    check(r.venue == "A&A", f"ref venue {r.venue}")
    check(r.volume == "600", f"ref volume {r.volume}")
    check(r.pages == "A1", f"ref pages {r.pages}")
    check("Smith" in r.authors, f"ref authors {r.authors}")


def test_html_figure_and_table_floats() -> None:
    doc = _build_html()
    fig = _first_block(doc, "figure")
    check(fig is not None and fig.number == "1", "figure not captured")
    check(fig.caption and "test figure caption" in fig.caption.text,
          "figure caption missing")
    tab = _first_block(doc, "table")
    check(tab is not None and tab.number == "1", "table not captured")


def _render_inline(html_snippet: str) -> str:
    from bs4 import BeautifulSoup
    from bibgraph.ingest_html.inline import render_inline, InlineContext
    from bibgraph.ingest.annotate import apply_matches
    soup = BeautifulSoup(html_snippet, "html.parser")
    node = soup.find(["p", "span", "div"]) or soup
    text, matches = render_inline(node, InlineContext(resolve=lambda f: None))
    out, _, _ = apply_matches(text, matches)
    return out


def test_html_inline_subsup_word_boundary() -> None:
    # mid-word sub/sup must NOT be mathified (would mangle prose)
    check(_render_inline("<p>value<sub>2</sub>here</p>") == "value2here",
          f"mid-word sub mathified: {_render_inline('<p>value<sub>2</sub>here</p>')!r}")
    check(_render_inline("<p>equation<sub>10</sub>e done</p>") == "equation10e done",
          "mid-word multi-letter base mathified")
    # at a word boundary, a unit exponent IS valid math
    check("$\\mathrm{yr}^{-1}$" in _render_inline("<p>0.3 mas yr<sup>&#8722;1</sup> total</p>"),
          "unit exponent at boundary not mathified")
    check("$10^{4}$" in _render_inline("<p>about 10<sup>4</sup> stars</p>"),
          "numeric exponent at boundary not mathified")


def test_html_inline_variable_base() -> None:
    # an explicit single-letter italic variable is a math base even before text
    check("$G_{\\mathrm{BP}}$" in _render_inline("<p><i>G</i><sub>BP</sub> band</p>"),
          "italic variable + sub not mathified")
    # variant Greek glyph (lunate epsilon U+03F5) is recognised as a variable
    out = _render_inline("<p><i>ϵ</i><sub>ACG</sub> value</p>")
    check("$\\epsilon_{\\mathrm{ACG}}$" in out, f"variant greek not handled: {out!r}")
    check("\\mathrm{ACG}" not in out.replace("$\\epsilon_{\\mathrm{ACG}}$", ""),
          "stray latex leaked outside math delimiters")


def test_html_no_internal_attrs_in_json() -> None:
    doc = _build_html()
    d = doc.to_dict(compact_json=True)
    blob = json.dumps(d)
    check("_anchor_matches" not in blob, "internal _anchor_matches leaked into JSON")
    check(d["stats"]["n_citations_resolved"] == d["stats"]["n_citations"],
          "some citations unresolved in HTML doc")


# --------------------------------------------------------------------------- #
def _find_paragraph(doc, needle: str):
    for b in doc.iter_blocks():
        if b.type == "paragraph" and needle in b.text:
            return b
    return None


def _first_block(doc, btype: str):
    for b in doc.iter_blocks():
        if b.type == btype:
            return b
    return None


# --------------------------------------------------------------------------- #
# LaTeX pipeline (Phase 5)
# --------------------------------------------------------------------------- #

import shutil as _shutil                                            # noqa: E402
HAVE_PANDOC = _shutil.which("pandoc") is not None
_LATEX_DOC = None


def _build_latex():
    """Ingest the self-contained LaTeX fixture (no network, no assets)."""
    global _LATEX_DOC
    if _LATEX_DOC is not None:
        return _LATEX_DOC
    import tempfile
    from bibgraph.config import LatexConfig, PipelineConfig
    from bibgraph.pipeline_latex import ingest_latex
    cfg = PipelineConfig()
    cfg.latex = LatexConfig(download_assets=False, use_cache=False, request_delay=0)
    tmp = Path(tempfile.mkdtemp(prefix="bibgraph-latex-test-"))
    _LATEX_DOC = ingest_latex(str(FIX / "sample_latex.tex"), out_root=tmp,
                              config=cfg, write_json=False)
    return _LATEX_DOC


def test_latex_arxiv_detection() -> None:
    from bibgraph.ingest_latex import arxiv_id, looks_like_arxiv
    check(looks_like_arxiv("2501.17225"), "bare id not detected")
    check(looks_like_arxiv("arXiv:2603.03522v2"), "arXiv: prefix not detected")
    check(looks_like_arxiv("https://arxiv.org/abs/1234.5678"), "abs URL not detected")
    check(looks_like_arxiv("astro-ph/0701001"), "old-style id not detected")
    check(not looks_like_arxiv("paper.pdf"), "a .pdf path wrongly detected as arXiv")
    check(not looks_like_arxiv("10.1051/0004-6361/123"), "a DOI wrongly detected")
    check(arxiv_id("https://arxiv.org/pdf/2501.17225v2.pdf") == "2501.17225v2",
          "version-suffixed pdf URL id extraction")


def test_latex_structure_and_title() -> None:
    if not HAVE_PANDOC:
        return
    doc = _build_latex()
    check(doc.source["type"] == "latex", f"source type {doc.source.get('type')}")
    check("Sample LaTeX Paper" in (doc.meta["title"] or ""), f"title: {doc.meta['title']}")
    heads = [s.heading for s in doc.iter_sections()]
    check("Abstract" in heads, f"no Abstract section: {heads}")
    check("Introduction" in heads and "Methods" in heads, f"sections: {heads}")
    nums = {s.heading: s.number for s in doc.iter_sections()}
    check(nums.get("Introduction") == "1" and nums.get("Methods") == "2",
          f"section numbering wrong: {nums}")
    check(nums.get("Abstract") is None, "abstract should be unnumbered")


def test_latex_authoritative_citation() -> None:
    if not HAVE_PANDOC:
        return
    doc = _build_latex()
    p = _find_paragraph(doc, "magnitude")
    check(p is not None, "intro paragraph not found")
    check("[[cite:ref-1]]" in p.text, f"\\citet token missing: {p.text!r}")
    occ = p.citations[0]
    check(occ.via == "hyperlink" and occ.resolved, f"cite not authoritative: {occ.via}")
    check("Smith" in occ.raw and "(2020)" in occ.raw,
          f"narrative cite raw not reconstructed: {occ.raw!r}")


def test_latex_citation_multi_key() -> None:
    if not HAVE_PANDOC:
        return
    doc = _build_latex()
    both = [c for b in doc.iter_blocks() for c in getattr(b, "citations", [])
            if set(c.ref_ids) == {"ref-1", "ref-2"}]
    check(bool(both), "\\citep{KeyA, KeyB} not merged into one token with both refs")


def test_latex_crossref_resolution() -> None:
    if not HAVE_PANDOC:
        return
    doc = _build_latex()
    alltext = " ".join(b.text for b in doc.iter_blocks() if b.type == "paragraph")
    for tok in ("[[xref:eq-1]]", "[[xref:fig-1]]", "[[xref:tab-1]]"):
        check(tok in alltext, f"{tok} not resolved in body: {alltext[:120]!r}")
    kinds = {(x.kind, x.resolved) for b in doc.iter_blocks()
             for x in getattr(b, "crossrefs", [])}
    check(("section", True) in kinds, f"section xref not resolved: {kinds}")
    check(("equation", True) in kinds, f"equation xref not resolved: {kinds}")


def test_latex_equation_numbering_and_cleanup() -> None:
    if not HAVE_PANDOC:
        return
    doc = _build_latex()
    eqs = {b.id: b for b in doc.iter_blocks() if b.type == "equation"}
    check(len(eqs) == 4, f"expected 4 equations, got {len(eqs)}")
    check(eqs["eq-1"].number == "1", f"first numbered eq has no number: {eqs['eq-1'].number}")
    check(eqs["eq-2"].number is None, "equation* must be unnumbered")
    check(eqs["eq-4"].number is None, "\\[ \\] must be unnumbered")
    check("\\begin{equation}" not in eqs["eq-1"].latex
          and "\\label" not in eqs["eq-1"].latex,
          f"equation wrapper/label not stripped: {eqs['eq-1'].latex!r}")
    check("\\begin{aligned}" in eqs["eq-3"].latex,
          f"multi-row align not rewrapped as aligned: {eqs['eq-3'].latex!r}")


def test_latex_katex_cleanup() -> None:
    if not HAVE_PANDOC:
        return
    doc = _build_latex()
    p = _find_paragraph(doc, "magnitude")
    txt = p.text
    check("\\textsubscript" not in txt, f"\\textsubscript leaked: {txt!r}")
    check("_{c}" in txt, f"text subscript not converted to _{{c}}: {txt!r}")
    check("M_\\odot" in txt, f"user macro \\msun not expanded: {txt!r}")
    check("\\arcsec" not in txt, f"\\arcsec astro-macro not mapped: {txt!r}")
    check("\\ $" not in txt and "\\$" not in txt and "\\ pc" not in txt,
          f"control-space left a dangling backslash: {txt!r}")


def test_latex_references_bbl() -> None:
    if not HAVE_PANDOC:
        return
    doc = _build_latex()
    check(len(doc.references) == 2, f"expected 2 refs, got {len(doc.references)}")
    r1 = doc.references[0]
    check(r1.year == 2020, f"ref-1 year {r1.year}")
    check(r1.doi == "10.1051/0004-6361/200000001", f"ref-1 doi {r1.doi}")
    check(r1.authors and "Smith" in r1.authors[0], f"ref-1 authors {r1.authors}")
    check("MNRAS" in r1.raw, f"\\mnras journal macro not expanded: {r1.raw!r}")


def test_latex_footnote_dropped_link_kept() -> None:
    if not HAVE_PANDOC:
        return
    doc = _build_latex()
    alltext = " ".join(b.text for b in doc.iter_blocks() if b.type == "paragraph")
    check("must be dropped" not in alltext, "footnote text not dropped")
    check("example.org" in alltext, "external \\url visible text was dropped")


def test_latex_abstract_command() -> None:
    from bibgraph.ingest_latex.walk import _extract_command_abstract
    raw = "\\abstract  % header comment\n  {Ctx text}\n  {Aims text}{Meth}{Res}{Concl}\n"
    groups = _extract_command_abstract(raw)
    check(len(groups) == 5, f"expected 5 A&A abstract groups, got {len(groups)}: {groups}")
    check("Ctx text" in groups[0] and "Aims text" in groups[1],
          f"abstract groups misparsed: {groups[:2]}")


def _ingest_latex_str(tex: str):
    import tempfile
    from bibgraph.config import LatexConfig, PipelineConfig
    from bibgraph.pipeline_latex import ingest_latex
    tmp = Path(tempfile.mkdtemp(prefix="bibgraph-latex-syn-"))
    (tmp / "main.tex").write_text(tex, "utf-8")
    cfg = PipelineConfig()
    cfg.latex = LatexConfig(download_assets=False, use_cache=False, request_delay=0)
    return ingest_latex(str(tmp / "main.tex"), out_root=tmp / "out",
                        config=cfg, write_json=False)


def test_latex_title_math_and_literal_dollar() -> None:
    if not HAVE_PANDOC:
        return
    doc = _ingest_latex_str(
        "\\documentclass{article}\\usepackage{amsmath}\n"
        "\\title{The $z>6$ Universe}\n\\begin{document}\\maketitle\n"
        "\\section{S}\\label{sec:s}\nA gadget costs \\$5 today.\n\\end{document}\n")
    check("$z>6$" in (doc.meta["title"] or ""),
          f"title inline-math was dropped: {doc.meta['title']!r}")
    txt = " ".join(b.text for b in doc.iter_blocks() if b.type == "paragraph")
    check("\\char36" in txt, f"literal '$' not neutralised for the scanner: {txt!r}")


def test_latex_perrow_equation_numbering() -> None:
    if not HAVE_PANDOC:
        return
    doc = _ingest_latex_str(
        "\\documentclass{article}\\usepackage{amsmath}\n\\begin{document}\n"
        "\\section{S}\\label{sec:s}\nSee \\eqref{eq:second} and \\eqref{eq:after}.\n"
        "\\begin{align} a&=b\\label{eq:first}\\\\ c&=d\\label{eq:second}\\\\ "
        "e&=f\\label{eq:third}\\end{align}\n"
        "\\begin{equation}\\label{eq:after} g=h\\end{equation}\n\\end{document}\n")
    xr = {x["raw"] for x in doc.to_dict()["crossrefs"] if x["kind"] == "equation"}
    check("(2)" in xr, f"\\eqref to align row 2 should render (2): {xr}")
    check("(4)" in xr, f"equation after a 3-row align should be (4), no drift: {xr}")


def test_latex_no_internal_attrs_in_json() -> None:
    if not HAVE_PANDOC:
        return
    import json as _json
    doc = _build_latex()
    s = _json.dumps(doc.to_dict(True), ensure_ascii=False)
    check("_inl" not in s and "_anchor_matches" not in s,
          "internal walker attributes leaked into JSON")
    check(bool(doc.references) and bool(doc.structure), "document is empty")


# --------------------------------------------------------------------------- #
# Acquisition layer: bibtex parser, source planner, resolution chain
# --------------------------------------------------------------------------- #

_SAMPLE_BIB = r"""
@article{HR1,
  author  = {Hunt, E.~L. and Reffert, S.},
  title   = {Improving the open cluster census. I.},
  journal = {Astronomy \& Astrophysics},
  year    = {2021},
  doi     = {10.1051/0004-6361/202039341}
}
@article{Kroupa2001,
  author  = {Kroupa, P.},
  title   = {On the variation of the initial mass function},
  journal = {Monthly Notices of the Royal Astronomical Society},
  year    = {2001},
  doi     = {10.1046/j.1365-8711.2001.04022.x}
}
@article{Huisjes2025,
  author  = {Huisjes, M. and Hern{\'a}ndez, X.},
  title   = {On the dynamics of low-mass open clusters},
  journal = {arXiv e-prints},
  year    = {2025},
  eprint  = {2603.03522},
  archivePrefix = {arXiv}
}
@article{GaiaDR3,
  author  = {{Gaia Collaboration} and Vallenari, A. and others},
  title   = {Gaia Data Release 3},
  journal = {Astronomy \& Astrophysics},
  year    = {2023},
  doi     = {10.1051/0004-6361/202243940},
  eprint  = {2208.00211},
  archivePrefix = {arXiv}
}
@article{Milgrom1983,
  author  = {Milgrom, M.},
  title   = {A modification of the Newtonian dynamics},
  journal = {Astrophysical Journal},
  year    = {1983},
  doi     = {10.1086/161130}
}
@article{Perryman1998,
  author  = {Perryman, M.~A.~C. and Brown, A.~G.~A. and others},
  title   = {The Hyades: distance, structure, dynamics, and age},
  journal = {Astronomy \& Astrophysics},
  year    = {1998}
}
"""


def test_acq_bibtex_parse() -> None:
    recs = {r.key: r for r in parse_bibtex_text(_SAMPLE_BIB)}
    check(len(recs) == 6, f"parsed 6 entries, got {len(recs)}")
    hr1 = recs["HR1"]
    check(hr1.authors == ["Hunt", "Reffert"], f"HR1 authors {hr1.authors}")
    check(hr1.doi == "10.1051/0004-6361/202039341", f"HR1 doi {hr1.doi}")
    check(bool(hr1.journal) and "Astronomy" in hr1.journal, "HR1 journal kept")
    hu = recs["Huisjes2025"]
    check(hu.arxiv_id == "2603.03522", f"Huisjes arxiv {hu.arxiv_id}")
    check(hu.journal is None, "arXiv e-prints journal flattened to None")
    check("á" in hu.authors[1], f"latex accent decoded: {hu.authors}")
    g = recs["GaiaDR3"]
    check(g.authors[0] == "Gaia Collaboration", f"group author kept whole: {g.authors[0]}")
    check(g.arxiv_id == "2208.00211" and g.doi.endswith("202243940"), "GaiaDR3 ids")
    check("others" not in recs["Perryman1998"].authors, "'others' dropped from authors")


def test_acq_planner_aanda_ready() -> None:
    p = plan_sources(doi="10.1051/0004-6361/202039341", title="x", year=2021, journal="A&A")
    check(p.chosen.tier == "journal_html", f"A&A chosen {p.chosen.tier}")
    check(p.chosen.status == "ready", f"A&A html ready, got {p.chosen.status}")
    check(p.publisher == "EDP Sciences", f"publisher {p.publisher}")


def test_acq_planner_mnras_ready_via_oup() -> None:
    # MNRAS (incl. legacy Wiley DOIs) is served by the OUP adapter now.
    p = plan_sources(doi="10.1046/j.1365-8711.2001.04022.x", title="imf", year=2001, journal="MNRAS")
    check(p.chosen.tier == "journal_html", f"MNRAS chosen {p.chosen.tier}")
    check(p.chosen.status == "ready", f"MNRAS ready via oup, got {p.chosen.status}")
    check("adapter=oup" in (p.chosen.note or ""), f"oup adapter noted: {p.chosen.note}")
    tiers = [c.tier for c in p.candidates]
    check("journal_pdf" in tiers, f"tiers {tiers}")
    check("ads_scan" not in tiers, f"modern MNRAS has no ADS-scan tier: {tiers}")


def test_acq_planner_iop_blocked_routes_to_arxiv() -> None:
    p = plan_sources(doi="10.3847/1538-4357/836/2/152", arxiv_id="1610.08981",
                     title="rar", year=2017)
    check(p.chosen.tier == "arxiv_latex", f"IOP blocked → arXiv chosen, got {p.chosen.tier}")
    html = next(c for c in p.candidates if c.tier == "journal_html")
    check(html.status == "blocked", f"IOP html blocked, got {html.status}")


def test_acq_planner_aps_blocked_no_arxiv_needs_upload() -> None:
    p = plan_sources(doi="10.1103/PhysRevLett.117.201101", title="rar", year=2016)
    d = p.to_dict()
    check(d["status"] == "blocked", f"APS no-arxiv → blocked head, got {d['status']}")
    check(d["needs_upload"] is True, f"needs_upload set, got {d}")
    check(d["chosen"] == "journal_html", f"blocked tier surfaced as chosen, got {d['chosen']}")


def test_acq_planner_arxiv_only() -> None:
    p = plan_sources(arxiv_id="2603.03522", title="x", year=2025)
    check(p.chosen.tier == "arxiv_latex" and p.chosen.status == "ready",
          f"arxiv-only chosen {p.chosen.tier}/{p.chosen.status}")


def test_acq_planner_old_chicago_scan() -> None:
    p = plan_sources(doi="10.1086/161130", title="mond", year=1983)
    check(p.chosen.tier == "ads_scan", f"1086 chosen {p.chosen.tier}")
    tiers = [c.tier for c in p.candidates]
    check("journal_html" not in tiers and "journal_pdf" not in tiers,
          f"legacy UChicago has no digital tiers: {tiers}")


def test_acq_planner_html_beats_arxiv() -> None:
    p = plan_sources(doi="10.1051/0004-6361/202243940", arxiv_id="2208.00211",
                     title="gaia dr3", year=2023, journal="A&A")
    check(p.chosen.tier == "journal_html", f"html beats arxiv: {p.chosen.tier}")
    check(p.ready.tier == "journal_html", f"ready {p.ready.tier}")


def test_acq_classify_aas_subjournal() -> None:
    pub, label = classify("10.3847/1538-4365/abc", None)
    check(label == "ApJS", f"AAS sub-journal label {label}")
    pub, label = classify("10.3847/1538-3881/abd806", None)
    check(label == "AJ", f"AAS AJ label {label}")


def test_crossref_normalize() -> None:
    msg = {
        "DOI": "10.1051/0004-6361/202039341",
        "title": ["Improving the open cluster census. I."],
        "author": [{"family": "Hunt", "given": "E. L."}, {"family": "Reffert", "given": "S."}],
        "container-title": ["Astronomy & Astrophysics"],
        "issued": {"date-parts": [[2021, 2]]},
        "type": "journal-article",
        "is-referenced-by-count": 142,
        "references-count": 60,
        "reference": [{"DOI": "10.1051/0004-6361/201833476"}, {"key": "ref2-no-doi"}],
        "link": [{"URL": "https://www.aanda.org/aa39341-20.html",
                  "content-type": "text/html", "intended-application": "text-mining"}],
        "resource": {"primary": {"URL": "https://doi.org/10.1051/0004-6361/202039341"}},
    }
    n = Crossref.normalize(msg)
    check(n["cited_by_count"] == 142, f"count {n['cited_by_count']}")
    check(n["year"] == 2021, f"year {n['year']}")
    check(n["authors"] == ["Hunt", "Reffert"], f"authors {n['authors']}")
    check(n["reference_dois"] == ["10.1051/0004-6361/201833476"], f"refs {n['reference_dois']}")
    check(len(n["links"]) == 1 and n["links"][0]["content_type"] == "text/html", "links captured")


class _StubSrc:
    def __init__(self, payload, status="ok"):
        self.payload = payload
        self.status = status

    def resolve(self, **kw):
        return self.payload


def test_resolve_chain_ads_count_wins() -> None:
    w = Work(id="doi:10.1051/0004-6361/202039341",
             doi="10.1051/0004-6361/202039341", title="x")
    ads = _StubSrc({"bibcode": "2021A&A...646A.104H", "doi": None, "title": "x",
                    "authors": ["Hunt", "Reffert"], "year": 2021, "venue": "A&A",
                    "citation_count": 200, "abstract": None, "references": ["a", "b", "c"]})
    cr = _StubSrc({"doi": "10.1051/0004-6361/202039341", "title": "x", "authors": [],
                   "year": 2021, "venue": "A&A", "type": "article", "cited_by_count": 150,
                   "reference_dois": ["x", "y"], "n_references": 2, "abstract": None,
                   "links": [{"url": "u"}], "resource_url": None})
    oa = _StubSrc({"openalex_id": "W1", "doi": "10.1051/0004-6361/202039341", "title": "x",
                   "authors": [], "year": 2021, "venue": "A&A", "type": "article",
                   "cited_by_count": 100, "referenced_works": ["W2", "W3"], "abstract": None})
    prov = resolve_work(w, ads=ads, crossref=cr, oa=oa)
    check(w.cited_by_count == 200, f"ADS count wins: {w.cited_by_count}")
    check(prov["count"] == "ads", f"count source {prov['count']}")
    check(w.bibcode == "2021A&A...646A.104H", "bibcode set from ADS")
    check(w.openalex_id == "W1" and w.referenced_works == ["W2", "W3"], "OpenAlex ids kept for graph")
    check(prov["providers"] == ["ads", "crossref", "openalex"], f"providers {prov['providers']}")


def test_resolve_chain_crossref_when_ads_empty() -> None:
    w = Work(id="doi:x", doi="10.1093/mnras/xxx", title="y")
    ads = _StubSrc(None, status="no-token")
    cr = _StubSrc({"doi": "10.1093/mnras/xxx", "title": "y", "authors": ["Kroupa"],
                   "year": 2001, "venue": "MNRAS", "type": "article", "cited_by_count": 5000,
                   "reference_dois": [], "n_references": 0, "abstract": None, "links": []})
    oa = _StubSrc({"openalex_id": "W9", "doi": None, "title": "y", "authors": [],
                   "year": 2001, "venue": "MNRAS", "type": "article", "cited_by_count": 4800,
                   "referenced_works": [], "abstract": None})
    prov = resolve_work(w, ads=ads, crossref=cr, oa=oa)
    check(w.cited_by_count == 5000 and prov["count"] == "crossref",
          f"crossref count wins when ADS empty: {w.cited_by_count}/{prov['count']}")
    check(w.authors == ["Kroupa"], "authors filled from crossref")
    check(prov["providers"] == ["crossref", "openalex"], f"providers {prov['providers']}")


def main() -> int:
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        print(f"running {t.__name__} ...")
        try:
            t()
        except Exception as e:
            import traceback
            _failures.append(f"{t.__name__} raised {e!r}")
            traceback.print_exc()
    print(f"\n{_passes} checks passed, {len(_failures)} failed")
    if _failures:
        print("\nFAILURES:")
        for f in _failures:
            print(" -", f)
        return 1
    print("ALL TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
