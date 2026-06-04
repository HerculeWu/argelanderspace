"""End-to-end arXiv-LaTeX -> structured JSON ingestion pipeline (Phase 5).

    arXiv id / URL / local .tex
     ├─ fetch          -> e-print tarball, unpacked (cached on disk)
     ├─ pandoc         -> LaTeX document AST (macros expanded, \\input followed)
     ├─ references     -> .bbl / thebibliography / .bib(CSL)  + key->ref-id map
     ├─ walk           -> section tree + floats + equations; citations/cross-refs
     │                    tokenised AUTHORITATIVELY from \\cite keys / \\ref labels
     ├─ annotate       -> regex fallback for any *unlinked* mention
     └─ index/stats    -> same Document shape the PDF/HTML pipelines emit
    -> Document -> <out_root>/<doc_id>/<doc_id>.json

Figures (vector PDF/EPS) are rasterised to PNG and served via /images, exactly
like the other pipelines, so the reader UI works unchanged.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from .config import PipelineConfig
from .ingest.annotate import Match, apply_matches
from .ingest.citations import ReferenceResolver, detect_citations
from .ingest.crossrefs import XrefIndex, detect_crossrefs
from .ingest_latex.assets import AssetResolver
from .ingest_latex.fetch import ArxivFetcher, acquire_source
from .ingest_latex.pandoc_ast import PandocError, have_pandoc, latex_to_ast
from .ingest_latex.references import build_references
from .ingest_latex.walk import Walker
from .pipeline import _annotatable
from .schema import Document

log = logging.getLogger("bibgraph.pipeline_latex")

# \cite/\citep/\citet[..][..]{key1,key2} — used to harvest keys from raw source.
_RAW_CITE_RE = re.compile(r"\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{([^}]*)\}")


def ingest_latex(source: str, out_root: str | Path = "data/output",
                 config: PipelineConfig | None = None,
                 write_json: bool = True) -> Document:
    config = config or PipelineConfig()
    if not have_pandoc():
        raise RuntimeError("pandoc is required for the LaTeX pipeline but was "
                           "not found on PATH.")
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)

    fetcher = ArxivFetcher(out_root / ".latexcache",
                           user_agent=config.latex.user_agent,
                           timeout=config.latex.request_timeout,
                           use_cache=config.latex.use_cache,
                           delay=config.latex.request_delay)
    src = acquire_source(source, out_root, fetcher=fetcher)
    log.info("doc_id=%s main=%s", src.doc_id, src.main_tex.name)

    raw = src.main_tex.read_text("utf-8", errors="replace")
    try:
        ast = latex_to_ast(src.main_tex)
    except PandocError as e:
        raise ValueError(
            f"pandoc could not parse {src.main_tex.name}: {e}. The source may "
            "use a class/macro pandoc's LaTeX reader does not support.") from e

    meta = ast.get("meta", {})
    # Cite keys from the AST, plus any only in the raw source (e.g. inside an A&A
    # command-style \abstract{} that pandoc drops) so the .bib path keeps them.
    cited_order = _collect_cite_keys(ast)
    seen = set(cited_order)
    for k in _RAW_CITE_RE.findall(raw):
        for key in (x.strip() for x in k.split(",")):
            if key and key not in seen:
                seen.add(key)
                cited_order.append(key)
    refs, key2ref = build_references(src.main_tex, src.src_dir, raw, cited_order)

    out_dir = out_root / src.doc_id
    asset_dir = out_dir / "assets"
    out_dir.mkdir(parents=True, exist_ok=True)
    assets = AssetResolver(src.src_dir, asset_dir, dpi=config.latex.figure_dpi,
                           max_px=config.latex.figure_max_px,
                           enabled=config.latex.download_assets)

    walker = Walker(references=refs, key_to_ref_id=key2ref, assets=assets,
                    src_dir=src.src_dir, meta=meta)
    sections = walker.run(ast, raw)

    title = _meta_text(meta, "title")
    subtitle = _meta_text(meta, "subtitle")
    if title and subtitle:
        title = f"{title} — {subtitle}"

    doc = Document(
        doc_id=src.doc_id,
        source={"type": "latex", "path": src.origin,
                "filename": src.main_tex.name, "arxiv_id": src.arxiv_id,
                "url": src.origin if src.arxiv_id else None},
        meta={"title": title,
              "latex": {"engine": "pandoc", "main_tex": src.main_tex.name,
                        "authors": _meta_list(meta, "author")}},
        structure=sections,
        references=refs,
    )

    _annotate_document(doc)

    n_blocks = sum(1 for _ in doc.iter_blocks())
    if n_blocks == 0:
        raise ValueError(
            f"{src.doc_id}: parsed 0 content blocks from {src.main_tex.name} — "
            "empty/unsupported source; fall back to the PDF.")

    if write_json:
        out_json = out_dir / f"{src.doc_id}.json"
        out_json.write_text(
            json.dumps(doc.to_dict(config.compact_json), ensure_ascii=False,
                       indent=2), "utf-8")
        log.info("Wrote %s", out_json)
        doc.meta["output_path"] = str(out_json)
    return doc


# --------------------------------------------------------------------------- #
# Annotation: anchor matches are authoritative; regex only fills unlinked gaps.
# (Mirrors bibgraph.pipeline_html._annotate_document for the shared contract.)
# --------------------------------------------------------------------------- #

def _annotate_document(doc: Document) -> None:
    resolver = ReferenceResolver(doc.references)
    xindex = XrefIndex(doc)
    for block in doc.iter_blocks():
        for holder in _annotatable(block):
            text = holder.text or ""
            if not text:
                continue
            anchors: list[Match] = list(getattr(holder, "_anchor_matches", []) or [])
            fallback = detect_citations(text, resolver) + detect_crossrefs(text, xindex)
            fallback = [m for m in fallback if not _overlaps(m, anchors)]
            new_text, cites, xrefs = apply_matches(text, anchors + fallback)
            holder.text = new_text
            holder.citations = cites
            holder.crossrefs = xrefs
            if hasattr(holder, "_anchor_matches"):
                del holder._anchor_matches


def _overlaps(m: Match, spans: list[Match]) -> bool:
    return any(m.start < s.end and s.start < m.end for s in spans)


# --------------------------------------------------------------------------- #
# pandoc-meta helpers
# --------------------------------------------------------------------------- #

def _collect_cite_keys(ast: dict) -> list[str]:
    """Cite keys in first-appearance order (for ordering/pruning the .bib path)."""
    keys: list[str] = []
    seen: set[str] = set()

    def walk(n):
        if isinstance(n, dict):
            if n.get("t") == "Cite":
                for ci in n["c"][0]:
                    k = ci.get("citationId")
                    if k and k not in seen:
                        seen.add(k)
                        keys.append(k)
            for v in n.values():
                walk(v)
        elif isinstance(n, list):
            for x in n:
                walk(x)

    walk(ast.get("blocks", []))
    return keys


def _meta_text(meta: dict, key: str) -> str | None:
    v = meta.get(key)
    if not isinstance(v, dict):
        return None
    out: list[str] = []

    def walk(n):
        if isinstance(n, dict):
            t = n.get("t")
            c = n.get("c")
            if t == "Str" or t == "MetaString":
                out.append(c if isinstance(c, str) else "")
            elif t == "Math":                         # keep math (titles often have
                latex = c[1] if isinstance(c, list) and len(c) > 1 else ""  # $z>6$, $\alpha$)
                if latex:
                    out.append(f"${latex}$")
            elif t in ("Space", "SoftBreak", "LineBreak"):
                out.append(" ")
            elif isinstance(c, (list, dict)):
                walk(c)
        elif isinstance(n, list):
            for x in n:
                walk(x)

    walk(v)
    s = re.sub(r"\s+", " ", "".join(out)).strip()
    return s or None


# \author{} often inlines \thanks{email}/affiliations that pandoc flattens into
# the name; cut the name off at the first such tail.
_AFFIL_RE = re.compile(
    r"\s*(?:,?\s*E-?mail.*|\bDepartment\b.*|\bDept\b.*|\bInstitut.*|\bUniversit.*"
    r"|\bObservator.*|\bCentre?\b.*|\b\d{4,}.*)$", re.I | re.S)


def _clean_author(s: str) -> str:
    return _AFFIL_RE.sub("", s).strip(" ,;")


def _meta_list(meta: dict, key: str) -> list[str]:
    v = meta.get(key)
    if not isinstance(v, dict) or v.get("t") != "MetaList":
        # a single author shows up as MetaInlines
        single = _meta_text(meta, key)
        return [_clean_author(single)] if single else []
    out: list[str] = []
    for item in v.get("c", []):
        s = _meta_text({"x": item}, "x")
        if s:
            out.append(_clean_author(s))
    return out
