"""Walk the pandoc LaTeX AST into a bibgraph :class:`~bibgraph.schema.Document`.

The walk is two-pass so cross-references resolve regardless of order:

1. **structure** — consume the AST into the Section tree + float/equation
   blocks, assigning ids and numbers and recording every ``\\label`` (pandoc puts
   it on the element ``id``; equation labels we pull from the math string) into a
   ``label -> (target_id, kind, number)`` map. Each text holder keeps its raw
   inline list for the second pass.
2. **render** — with the label map complete, render every holder's inlines to
   body text, emitting ``[[cite:ref-N]]`` / ``[[xref:fig-N]]`` *authoritatively*
   (``\\cite`` keys map straight to references; ``\\ref`` targets straight to the
   label map). The pipeline then runs only a regex *fallback* for any unlinked
   author-year / "Fig. N" mention, exactly as the HTML path does.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from ..ingest.annotate import Match
from ..schema import (CitationOccurrence, CrossRefOccurrence, CodeBlock,
                      EquationBlock, FigureBlock, ListBlock, Paragraph,
                      Reference, RichText, Section, TableBlock)
from .assets import AssetResolver
from .pandoc_ast import fragment_to_blocks

log = logging.getLogger("bibgraph.latex.walk")

# Numbered display-math environments (the ``*`` variants are unnumbered).
_NUMBERED_ENVS = {"equation", "align", "alignat", "eqnarray", "gather",
                  "multline", "flalign"}
# …of those, the ones that number EVERY row (equation/multline get one number).
_PERROW_ENVS = {"align", "alignat", "eqnarray", "gather", "flalign"}
# Multi-row environments we re-wrap as KaTeX-safe ``aligned``.
_MULTILINE_ENVS = {"align", "align*", "alignat", "alignat*", "eqnarray",
                   "eqnarray*", "gather", "gather*", "multline", "multline*",
                   "flalign", "flalign*"}
_ENV_RE = re.compile(r"\\begin\{([a-zA-Z*]+)\}(.*)\\end\{\1\}", re.S)
_LABEL_RE = re.compile(r"\\label\s*\{([^}]*)\}")
_MSPACE_RE = re.compile(r"\\mspace\s*\{[^}]*\}")
# text-mode sub/superscript commands authors sometimes use *inside* math
_TEXTSUB_RE = re.compile(r"\\textsubscript\s*\{([^{}]*)\}")
_TEXTSUP_RE = re.compile(r"\\textsuperscript\s*\{([^{}]*)\}")
# a control-space (\ ) — valid TeX spacing, but a trailing one becomes a
# dangling backslash after we strip whitespace, which KaTeX rejects.
_CTRLSPACE_RE = re.compile(r"(?<!\\)\\ ")
# Astronomy macros from aastex / aas_macros / mn2e classes (not in the preamble,
# so pandoc can't expand them) -> KaTeX-renderable equivalents.
_ASTRO_MACROS = {
    "sun": r"\odot", "Sun": r"\odot", "earth": r"\oplus", "Earth": r"\oplus",
    "degr": r"^{\circ}", "arcdeg": r"^{\circ}", "fdg": r"^{\circ}",
    "arcmin": r"'", "arcsec": r"''", "farcm": r"'", "farcs": r"''",
    "micron": r"\,\mu m", "sq": r"\Box", "ion": r"\,",
}
_ASTRO_RE = re.compile(r"\\(" + "|".join(sorted(_ASTRO_MACROS, key=len, reverse=True))
                       + r")(?![a-zA-Z])")


class _IdGen:
    def __init__(self) -> None:
        self._c: dict[str, int] = {}

    def next(self, prefix: str) -> str:
        self._c[prefix] = self._c.get(prefix, 0) + 1
        return f"{prefix}-{self._c[prefix]}"


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s.replace("\xa0", " "))


def _katexify(latex: str) -> str:
    """Map the handful of commands authors use that KaTeX doesn't implement."""
    latex = _MSPACE_RE.sub(r"\\;", latex)
    latex = latex.replace("\\medspace", "\\;").replace("\\thickspace", "\\;")
    latex = _TEXTSUB_RE.sub(r"_{\1}", latex)         # keep math mode: content may
    latex = _TEXTSUP_RE.sub(r"^{\1}", latex)         # be a symbol (\lambda), not text
    latex = _ASTRO_RE.sub(lambda m: _ASTRO_MACROS[m.group(1)], latex)
    if "$" in latex:                                 # text-embedded math ($k$): the
        latex = latex.replace("$", "")               # inner $ would split our $…$ span
    latex = _CTRLSPACE_RE.sub(" ", latex)            # \  -> plain space
    latex = re.sub(r"\\+\s*$", "", latex)            # drop any dangling trailing \
    return latex


def _balanced(s: str, i: int, lo: str, hi: str) -> tuple[str, int] | None:
    if i >= len(s) or s[i] != lo:
        return None
    depth = 0
    for j in range(i, len(s)):
        if s[j] == lo:
            depth += 1
        elif s[j] == hi:
            depth -= 1
            if depth == 0:
                return s[i + 1:j], j + 1
    return s[i + 1:], len(s)


@dataclass
class _Seg:
    kind: str                  # plain | math | anchor
    s: str = ""
    occ: object = None         # CitationOccurrence | CrossRefOccurrence


class Walker:
    def __init__(self, *, references: list[Reference], key_to_ref_id: dict[str, str],
                 assets: AssetResolver, src_dir, meta: dict):
        self.refs_by_id = {r.id: r for r in references}
        self.key2ref = key_to_ref_id
        self.assets = assets
        self.src_dir = src_dir
        self.meta = meta
        self.ids = _IdGen()
        self.label_map: dict[str, tuple[str, str, str | None]] = {}
        self.holders: list = []                  # objects with _inl (rendered in pass 2)
        self._fig = self._tab = self._eq = 0
        self._sec_counts: dict[int, int] = {}

    # ------------------------------------------------------------------ #
    # Entry point
    # ------------------------------------------------------------------ #
    def run(self, ast: dict, raw: str) -> list[Section]:
        blocks = ast.get("blocks", [])
        sections: list[Section] = []
        abs = self._abstract_section(raw)
        if abs:
            sections.append(abs)
        sections += self._build_body(blocks)
        self._render_all()
        _prune_empty(sections)
        return sections

    # ------------------------------------------------------------------ #
    # Abstract (meta.abstract, else A&A's \abstract{}{}{}{}{} command)
    # ------------------------------------------------------------------ #
    def _abstract_section(self, raw: str) -> Section | None:
        blocks = self._abstract_blocks(raw)
        if not blocks:
            return None
        sec = Section(id=self.ids.next("sec"), level=1, heading="Abstract",
                      heading_raw="Abstract", number=None)
        for b in blocks:
            if b.get("t") in ("Para", "Plain"):
                sec.blocks.append(self._para(b["c"]))
        return sec if sec.blocks else None

    def _abstract_blocks(self, raw: str) -> list[dict]:
        ab = self.meta.get("abstract")
        if isinstance(ab, dict):
            if ab.get("t") == "MetaBlocks":
                return ab.get("c", [])
            if ab.get("t") == "MetaInlines":
                return [{"t": "Para", "c": ab.get("c", [])}]
        groups = _extract_command_abstract(raw)
        if not groups:
            return []
        labels = ["Context", "Aims", "Methods", "Results", "Conclusions"]
        parts = []
        for i, g in enumerate(groups):
            g = _strip_tex_comments(g).strip()
            if not g:
                continue
            lbl = f"\\textbf{{{labels[i]}.}} " if len(groups) == 5 else ""
            parts.append(lbl + g)
        return fragment_to_blocks("\n\n".join(parts), self.src_dir)

    # ------------------------------------------------------------------ #
    # Structure (pass 1)
    # ------------------------------------------------------------------ #
    def _build_body(self, blocks: list[dict]) -> list[Section]:
        top: list[Section] = []
        stack: list[Section] = []
        front: list = []
        for blk in blocks:
            self._consume(blk, top, stack, front)
        if front:                                # content before the first heading
            sec = Section(id=self.ids.next("sec"), level=1, heading="", number=None)
            sec.blocks = front
            top.insert(0, sec)
        return top

    def _consume(self, blk: dict, top, stack, front) -> None:
        t = blk.get("t")
        c = blk.get("c")
        if t == "Header":
            self._open_section(c, top, stack)
            return
        if t == "Div":
            attr, sub = c[0], c[1]
            label = attr[0]
            # A labelled Div wrapping a single float carries that float's \label
            # (pandoc attaches table — and sometimes figure — labels this way).
            if label and len(sub) == 1 and sub[0].get("t") == "Table":
                self._emit(self._table_block(sub[0], label), stack, front)
                return
            if label and len(sub) == 1 and sub[0].get("t") == "Figure":
                self._emit(self._figure_block(sub[0], label_override=label),
                           stack, front)
                return
            for x in sub:
                self._consume(x, top, stack, front)
            return
        if t == "BlockQuote":
            for x in c:
                self._consume(x, top, stack, front)
            return
        for b in self._content_blocks(blk):
            self._emit(b, stack, front)

    def _emit(self, block, stack, front) -> None:
        if block is None:
            return
        (stack[-1].blocks if stack else front).append(block)

    def _open_section(self, c, top, stack) -> None:
        level, attr, inls = c[0], c[1], c[2]
        hid, classes = attr[0], attr[1]
        number = self._section_number(level, classes)
        heading = self._inlines_to_plain(inls).strip()
        sec = Section(id=self.ids.next("sec"), level=level, heading=heading,
                      heading_raw=(f"{number} {heading}".strip() if number else heading),
                      number=number)
        while stack and stack[-1].level >= level:
            stack.pop()
        (stack[-1].children if stack else top).append(sec)
        stack.append(sec)
        if hid:
            self.label_map[hid] = (sec.id, "section", number)

    def _section_number(self, level: int, classes: list[str]) -> str | None:
        if "unnumbered" in (classes or []):
            return None
        self._sec_counts[level] = self._sec_counts.get(level, 0) + 1
        for lv in [lv for lv in self._sec_counts if lv > level]:
            del self._sec_counts[lv]
        return ".".join(str(self._sec_counts[lv])
                        for lv in sorted(self._sec_counts) if lv <= level)

    # ------------------------------------------------------------------ #
    # Content blocks
    # ------------------------------------------------------------------ #
    def _content_blocks(self, blk: dict) -> list:
        t = blk.get("t")
        c = blk.get("c")
        if t in ("Para", "Plain"):
            return self._split_para(c)
        if t == "CodeBlock":
            classes = c[0][1] if c[0] else []
            lang = classes[0] if classes else None
            return [CodeBlock(id=self.ids.next("code"), lang=lang, body=c[1])]
        if t == "BulletList":
            return [self._list_block(c, ordered=False)]
        if t == "OrderedList":
            return [self._list_block(c[1], ordered=True)]
        if t == "Table":
            return [self._table_block(blk, blk["c"][0][0])]
        if t == "Figure":
            return [self._figure_block(blk)]
        return []                                # HorizontalRule, RawBlock, …

    def _split_para(self, inls: list) -> list:
        """Split a paragraph at display equations into [Para, Eq, Para, …]."""
        out: list = []
        buf: list = []
        for x in inls:
            if x.get("t") == "Math" and x["c"][0]["t"] == "DisplayMath":
                if _has_content(buf):
                    out.append(self._para(buf))
                buf = []
                out.append(self._equation_block(x["c"][1]))
            else:
                buf.append(x)
        if _has_content(buf):
            out.append(self._para(buf))
        return out

    def _para(self, inls: list) -> Paragraph:
        p = Paragraph(id=self.ids.next("p"))
        p._inl = list(inls)                       # type: ignore[attr-defined]
        self.holders.append(p)
        return p

    def _equation_block(self, latex: str) -> EquationBlock:
        body, env, raw_inner = _normalize_equation(latex)
        eid = self.ids.next("eq")
        numbered = bool(env) and not env.endswith("*") and \
            env.rstrip("*") in _NUMBERED_ENVS
        number = None
        if numbered and env.rstrip("*") in _PERROW_ENVS:
            # align/eqnarray/gather/… number every row (sans \nonumber/\notag),
            # so assign one number per row and map each row's \label to its number
            # (else \eqref shows the wrong number and later equations all drift).
            nums: list[str] = []
            for row in re.split(r"\\\\", raw_inner):
                if not row.strip() or re.search(r"\\(?:nonumber|notag)\b", row):
                    continue
                self._eq += 1
                n = str(self._eq)
                nums.append(n)
                for lab in _LABEL_RE.findall(row):
                    self.label_map[lab] = (eid, "equation", n)
            if not nums:                              # numbered env, no countable row
                self._eq += 1
                nums = [str(self._eq)]
            for lab in _LABEL_RE.findall(raw_inner):  # env-level label → first number
                self.label_map.setdefault(lab, (eid, "equation", nums[0]))
            number = nums[0] if len(nums) == 1 else f"{nums[0]}–{nums[-1]}"
        elif numbered:                                # equation / multline → ONE number
            self._eq += 1
            number = str(self._eq)
            for lab in _LABEL_RE.findall(raw_inner):
                self.label_map[lab] = (eid, "equation", number)
        else:                                         # unnumbered (equation*, \[ \])
            for lab in _LABEL_RE.findall(raw_inner):
                self.label_map[lab] = (eid, "equation", None)
        return EquationBlock(id=eid, latex=body, number=number)

    def _list_block(self, items: list, *, ordered: bool) -> ListBlock:
        lb = ListBlock(id=self.ids.next("list"), ordered=ordered)
        for item_blocks in items:
            rt = RichText()
            rt._inl = self._block_inlines(item_blocks)   # type: ignore[attr-defined]
            self.holders.append(rt)
            lb.items.append(rt)
        return lb

    def _figure_block(self, blk: dict, label_override: str | None = None) -> FigureBlock:
        attr, caption, content = blk["c"][0], blk["c"][1], blk["c"][2]
        self._fig += 1
        number = str(self._fig)
        imgs = _find_images(content)
        img_path = None
        for src in imgs:
            img_path = self.assets.image(src)
            if img_path:
                break
        if len(imgs) > 1:
            log.debug("figure %s has %d images; using the first", number, len(imgs))
        fig = FigureBlock(id=self.ids.next("fig"), number=number,
                          label=f"Figure {number}", img_path=img_path)
        fig.caption = self._caption(caption)
        label = label_override or attr[0]
        if label:
            self.label_map[label] = (fig.id, "figure", number)
        return fig

    def _table_block(self, node: dict, label: str | None) -> TableBlock:
        c = node["c"]
        caption = c[1]
        self._tab += 1
        number = str(self._tab)
        tb = TableBlock(id=self.ids.next("tab"), number=number,
                        label=f"Table {number}", table_body=self._table_html(c))
        tb.caption = self._caption(caption)
        if label:
            self.label_map[label] = (tb.id, "table", number)
        return tb

    def _caption(self, caption) -> RichText | None:
        # pandoc caption = [maybe-short-caption, [blocks]]
        blocks = caption[1] if isinstance(caption, list) and len(caption) > 1 else []
        inls = self._block_inlines(blocks)
        if not inls:
            return None
        rt = RichText()
        rt._inl = inls                            # type: ignore[attr-defined]
        self.holders.append(rt)
        return rt

    def _block_inlines(self, blocks: list) -> list:
        inls: list = []
        for b in blocks or []:
            if b.get("t") in ("Para", "Plain"):
                if inls:
                    inls.append({"t": "Space"})
                inls.extend(b["c"])
        return inls

    # ------------------------------------------------------------------ #
    # Tables -> HTML
    # ------------------------------------------------------------------ #
    def _table_html(self, c) -> str:
        # Table = [attr, caption, colspecs, head, bodies, foot]
        head, bodies, foot = c[3], c[4], c[5]
        rows_html: list[str] = []
        for row in head[1]:
            rows_html.append(self._row_html(row, "th"))
        for body in bodies:
            for row in body[2] + body[3]:         # intermediate head rows + body rows
                rows_html.append(self._row_html(row, "td"))
        for row in foot[1]:
            rows_html.append(self._row_html(row, "td"))
        if not rows_html:
            return ""
        return "<table>" + "".join(rows_html) + "</table>"

    def _row_html(self, row, tag: str) -> str:
        cells = []
        for cell in row[1]:
            # cell = [attr, alignment, rowspan, colspan, [blocks]]
            _, _align, rspan, cspan, blocks = cell
            txt = _escape_html(self._inlines_to_plain(self._block_inlines(blocks)))
            attrs = ""
            if isinstance(rspan, int) and rspan > 1:
                attrs += f' rowspan="{rspan}"'
            if isinstance(cspan, int) and cspan > 1:
                attrs += f' colspan="{cspan}"'
            cells.append(f"<{tag}{attrs}>{txt}</{tag}>")
        return "<tr>" + "".join(cells) + "</tr>"

    # ------------------------------------------------------------------ #
    # Inline rendering (pass 2)
    # ------------------------------------------------------------------ #
    def _render_all(self) -> None:
        for h in self.holders:
            text, matches = self._render_inlines(getattr(h, "_inl", []))
            h.text = text
            h._anchor_matches = matches           # type: ignore[attr-defined]
            if hasattr(h, "_inl"):
                del h._inl

    def _render_inlines(self, inls: list) -> tuple[str, list[Match]]:
        segs: list[_Seg] = []
        self._emit_inlines(inls, segs)
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
            else:  # anchor (cite / xref)
                vis = _norm_ws(seg.s).strip()
                if not vis:
                    continue
                start = emit(vis)
                matches.append(Match(start, pos, seg.occ))

        text = "".join(out)
        lstrip = len(text) - len(text.lstrip())
        if lstrip:
            text = text[lstrip:]
            matches = [Match(m.start - lstrip, m.end - lstrip, m.occ) for m in matches]
        text = text.rstrip()
        matches = [m for m in matches if 0 <= m.start < m.end <= len(text)]
        return text, matches

    def _emit_plain(self, segs: list[_Seg], s: str) -> None:
        if not s:
            return
        # A literal text-mode '$' (from \$, \verb, \texttt) would be mis-paired by
        # the reader's $…$ math scanner; render it as a KaTeX dollar glyph
        # (\char36 — no inner '$' to confuse the scanner).
        if "$" in s:
            parts = s.split("$")
            for i, part in enumerate(parts):
                self._emit_plain_raw(segs, part)
                if i < len(parts) - 1:
                    segs.append(_Seg("math", "\\char36"))
            return
        self._emit_plain_raw(segs, s)

    def _emit_plain_raw(self, segs: list[_Seg], s: str) -> None:
        if not s:
            return
        if segs and segs[-1].kind == "plain":
            segs[-1].s += s
        else:
            segs.append(_Seg("plain", s))

    def _emit_inlines(self, inls: list, segs: list[_Seg]) -> None:
        for x in inls or []:
            self._emit_inline(x, segs)

    def _emit_inline(self, x: dict, segs: list[_Seg]) -> None:
        t = x.get("t")
        c = x.get("c")
        if t == "Str":
            self._emit_plain(segs, c)
        elif t in ("Space", "SoftBreak", "LineBreak"):
            self._emit_plain(segs, " ")
        elif t in ("Emph", "Strong", "Underline", "SmallCaps", "Strikeout",
                   "Superscript", "Subscript"):
            self._emit_inlines(c, segs)
        elif t == "Span":
            self._emit_inlines(c[1], segs)
        elif t == "Quoted":
            q = "'" if c[0]["t"] == "SingleQuote" else '"'
            self._emit_plain(segs, q)
            self._emit_inlines(c[1], segs)
            self._emit_plain(segs, q)
        elif t == "Code":
            self._emit_plain(segs, c[1])
        elif t == "Math":
            body = _katexify(c[1]).strip()
            if body:
                segs.append(_Seg("math", body))
        elif t == "Cite":
            self._emit_cite(c[0], segs)
        elif t == "Link":
            self._emit_link(c, segs)
        # Note (footnote), Image (inline), RawInline, LineBreak handled above:
        # dropped on purpose (footnotes/raw-LaTeX carry no body text we render).

    def _emit_cite(self, citations: list, segs: list[_Seg]) -> None:
        ref_ids: list[str] = []
        author_year: list[tuple[str, int | None]] = []
        modes: list[str] = []
        prefix = suffix = ""
        for ci in citations:
            key = ci.get("citationId", "")
            mode = ci.get("citationMode", {}).get("t", "NormalCitation")
            modes.append(mode)
            rid = self.key2ref.get(key)
            if rid and rid not in ref_ids:
                ref_ids.append(rid)
            author_year.append(self._cite_pieces(rid, key))
            if ci.get("citationPrefix"):
                prefix = self._inlines_to_plain(ci["citationPrefix"]).strip()
            if ci.get("citationSuffix"):
                suffix = self._inlines_to_plain(ci["citationSuffix"]).strip()
        visible = _format_citation(modes, author_year, prefix, suffix)
        if not visible:                               # \citeyear w/o year, etc. —
            visible = "; ".join(au for au, _ in author_year) or "[ref]"  # never drop
        occ = CitationOccurrence(ref_ids=ref_ids, raw=visible, via="hyperlink",
                                 resolved=bool(ref_ids))
        segs.append(_Seg("anchor", visible, occ))

    def _cite_pieces(self, rid: str | None, key: str) -> tuple[str, int | None]:
        r = self.refs_by_id.get(rid) if rid else None
        if not r:
            return key, None
        a = r.authors or []
        if not a:
            au = key
        elif len(a) == 1:
            au = a[0]
        elif len(a) == 2:
            au = f"{a[0]} & {a[1]}"
        else:
            au = f"{a[0]} et al."
        return au, r.year

    def _emit_link(self, c, segs: list[_Seg]) -> None:
        attr, inls = c[0], c[1]
        kvs = dict(attr[2]) if attr and len(attr) > 2 else {}
        rtype = kvs.get("reference-type")
        ref = kvs.get("reference")
        if rtype in ("ref", "eqref", "autoref", "ref+label", "ref+page") and ref:
            tgt = self.label_map.get(ref)
            if tgt:
                tid, kind, num = tgt
                if kind == "equation":
                    vis = f"({num})" if num else "(?)"
                else:
                    vis = num or (self._inlines_to_plain(inls).strip() or ref)
                occ = CrossRefOccurrence(kind=kind, raw=vis, target_id=tid,
                                         number=num, via="hyperlink", resolved=True)
            else:
                vis = self._inlines_to_plain(inls).strip() or ref
                occ = CrossRefOccurrence(kind="unknown", raw=vis, via="hyperlink",
                                         resolved=False)
            segs.append(_Seg("anchor", vis, occ))
            return
        self._emit_inlines(inls, segs)            # external link: keep visible text

    # plain (token-free) rendering, for headings / captions-in-cells / cite notes
    def _inlines_to_plain(self, inls: list) -> str:
        buf: list[str] = []

        def walk(node):
            t = node.get("t")
            c = node.get("c")
            if t == "Str":
                buf.append(c)
            elif t in ("Space", "SoftBreak", "LineBreak"):
                buf.append(" ")
            elif t == "Math":
                buf.append("$" + _katexify(c[1]).strip() + "$")
            elif t in ("Emph", "Strong", "Underline", "SmallCaps", "Strikeout",
                       "Superscript", "Subscript"):
                for y in c:
                    walk(y)
            elif t == "Span":
                for y in c[1]:
                    walk(y)
            elif t == "Quoted":
                q = "'" if c[0]["t"] == "SingleQuote" else '"'
                buf.append(q)
                for y in c[1]:
                    walk(y)
                buf.append(q)
            elif t == "Code":
                buf.append(c[1])
            elif t == "Link":
                for y in c[1]:
                    walk(y)
            elif t == "Cite":
                for y in c[1]:                    # the rendered fallback inlines
                    walk(y)

        for n in inls or []:
            walk(n)
        return _norm_ws("".join(buf)).strip()


# --------------------------------------------------------------------------- #
# Module helpers
# --------------------------------------------------------------------------- #

def _has_content(inls: list) -> bool:
    return any(x.get("t") not in ("Space", "SoftBreak", "LineBreak") for x in inls)


def _find_images(blocks: list) -> list[str]:
    """All ``\\includegraphics`` source args inside a Figure's content blocks."""
    out: list[str] = []

    def walk(node):
        if isinstance(node, dict):
            if node.get("t") == "Image":
                out.append(node["c"][2][0])
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for x in node:
                walk(x)

    walk(blocks)
    return out


def _normalize_equation(latex: str) -> tuple[str, str | None, str]:
    """``(katex_body, env, raw_inner)`` for a display-math string.

    *raw_inner* keeps the ``\\label``/``\\nonumber`` markers so the caller can do
    per-row numbering; *katex_body* has them stripped and multi-row align-family
    bodies rewrapped as KaTeX-safe ``aligned``."""
    s = latex.strip()
    m = _ENV_RE.search(s)
    if m:
        env, inner = m.group(1), m.group(2)
    else:
        env, inner = None, s
    raw_inner = inner
    body = _LABEL_RE.sub("", inner)
    body = re.sub(r"\\(?:nonumber|notag)\b", "", body).strip()
    if env in _MULTILINE_ENVS and not body.lstrip().startswith("\\begin{"):
        body = "\\begin{aligned}\n" + body + "\n\\end{aligned}"
    return _katexify(body).strip(), env, raw_inner


def _extract_command_abstract(raw: str) -> list[str]:
    """The 1–5 brace groups of an A&A-style ``\\abstract{…}…`` command."""
    clean = _strip_tex_comments(raw)
    m = re.search(r"\\abstract\b", clean)
    if not m:
        return []
    i = m.end()
    groups: list[str] = []
    while len(groups) < 5:
        while i < len(clean) and clean[i] in " \t\r\n":
            i += 1
        if i >= len(clean) or clean[i] != "{":
            break
        bal = _balanced(clean, i, "{", "}")
        if bal is None:
            break
        groups.append(bal[0])
        i = bal[1]
    return [g for g in groups]


def _strip_tex_comments(s: str) -> str:
    return re.sub(r"(?<!\\)%[^\n]*", "", s)


def _escape_html(s: str) -> str:
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _format_citation(modes: list[str], author_year: list[tuple[str, int | None]],
                     prefix: str, suffix: str) -> str:
    """Reconstruct a readable in-text citation string from resolved refs."""
    def ay(au: str, yr: int | None) -> str:
        return f"{au} {yr}" if yr else au

    all_intext = modes and all(m == "AuthorInText" for m in modes)
    all_suppress = modes and all(m == "SuppressAuthor" for m in modes)
    if all_suppress:
        body = "; ".join(str(yr) for _, yr in author_year if yr)
        return f"({body})" if body else ""
    if all_intext:
        return "; ".join(f"{au} ({yr})" if yr else au for au, yr in author_year)
    body = "; ".join(ay(au, yr) for au, yr in author_year)
    inner = ((prefix + " ") if prefix else "") + body + ((", " + suffix) if suffix else "")
    return f"({inner})"


def _prune_empty(sections: list[Section]) -> None:
    """Drop paragraphs that rendered to nothing (e.g. a stray ``\\noindent``)."""
    for sec in sections:
        sec.blocks = [b for b in sec.blocks
                      if not (isinstance(b, Paragraph) and not (b.text or "").strip())]
        _prune_empty(sec.children)
