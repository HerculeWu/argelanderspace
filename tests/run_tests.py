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
