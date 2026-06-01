"""OCR text-layer correction (repair MinerU's ``?`` gaps from the PDF text layer).

MinerU's VLM backend transcribes the *rendered page image*, so a glyph it cannot
read visually comes out as a run of ``?`` (e.g. ``"external field of order ??"``,
``"acceleration ????"``).  For born-digital PDFs the embedded text layer usually
*does* contain that character (``"external field of order 𝑎0"``), and that text
layer is an independent source — MinerU did not use it (otherwise the glyph would
already be correct).

This stage repairs **only** those ``?``-runs.  For each body-text holder it clips
the PDF text layer to the block's bounding box, aligns it to the OCR text with a
character-level diff, and splices the recovered characters into the ``?``-gaps.
OCR stays the baseline: nothing but ``?``-runs is ever touched, and a gap is left
as-is whenever the text layer cannot supply a clean replacement.  Equation LaTeX,
table HTML and code bodies are deliberately *not* corrected (the text layer would
corrupt their structure, and the VLM is more reliable there).
"""

from __future__ import annotations

import logging
import re
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable

import fitz  # PyMuPDF

from ..schema import Document, Paragraph, RichText

log = logging.getLogger("bibgraph.textfix")

# A run of two or more '?' — MinerU's marker for glyphs it could not read.
# Single '?' is left alone (it is almost always a real question mark or part of
# an unresolved-xref token like "equation-3?").
GAP_RE = re.compile(r"\?{2,}")

# Replacement sanity: the recovered span must be clean (no '?' of its own) and
# not runaway-long relative to the number of '?'s it stands in for.
_MIN_CAP = 16
_PER_Q = 4
# Expand the clip box slightly (fraction of page) so glyphs on the bbox edge are
# still captured by PyMuPDF's clip intersection test.
_PAD_FRAC = 0.004
# Minimum fraction of the OCR text's alphanumeric chars that must align to the
# clipped text layer for us to trust it. Below this the layer does not
# correspond to this block (e.g. a caption/footnote bbox overlapping the float
# body) and we touch nothing. Real paragraphs score >=0.85; a mismatched
# footnote scores ~0.16, so 0.5 separates them with wide margin.
_MIN_CORRESPONDENCE = 0.5
# SequenceMatcher(autojunk=False) gives the best gap alignment (autojunk=True
# drops real fixes) but is super-linear on highly repetitive input. Real body
# holders are tiny (combined OCR+layer length well under this); above the
# threshold — only reachable by anomalously large/degenerate clips, which never
# carry a genuine fix — enable difflib's popular-char heuristic to stay fast.
_AUTOJUNK_OVER = 6000
# Hard ceiling: skip a holder whose OCR or clipped layer is absurdly large
# (mis-sized bbox / degenerate page); diffing it would be pointless and slow.
_MAX_LEN = 12000


def repair_text(ocr: str, layer: str) -> tuple[str, int]:
    """Splice text-layer characters into the ``?``-gaps of *ocr*.

    Returns ``(new_text, n_gaps_fixed)``.  Only opcodes whose OCR side contains a
    ``?`` are ever replaced; ``equal`` regions and plain OCR/text-layer
    disagreements (no ``?``) are kept verbatim, so OCR remains the baseline.
    """
    if not layer or "?" not in ocr:
        return ocr, 0
    before = len(GAP_RE.findall(ocr))
    if before == 0:
        return ocr, 0
    if len(ocr) > _MAX_LEN or len(layer) > _MAX_LEN:
        return ocr, 0       # anomalously large holder — don't diff it

    autojunk = (len(ocr) + len(layer)) > _AUTOJUNK_OVER
    sm = SequenceMatcher(None, ocr, layer, autojunk=autojunk)
    opcodes = sm.get_opcodes()

    # Correspondence gate: if the clipped text layer does not actually correspond
    # to this block's OCR text (a caption/footnote bbox overlapping the float
    # body returns plot axes or table cells), refuse to touch anything — every
    # splice would be wrong. Measured as the fraction of the OCR's alphanumeric
    # characters that align ('equal') to the layer.
    total_alnum = sum(1 for c in ocr if c.isalnum())
    matched_alnum = sum(
        sum(1 for c in ocr[i1:i2] if c.isalnum())
        for tag, i1, i2, _, _ in opcodes if tag == "equal")
    # Fail closed: with no alphanumeric text we cannot verify correspondence
    # (a pure-symbol holder like "(??)"), so refuse rather than risk a wrong splice.
    if not total_alnum or matched_alnum / total_alnum < _MIN_CORRESPONDENCE:
        return ocr, 0

    out: list[str] = []
    for tag, i1, i2, j1, j2 in opcodes:
        seg = ocr[i1:i2]
        if tag == "equal" or "?" not in seg:
            out.append(seg)
            continue
        # Replace ONLY a segment that is a *pure gap* (just '?'-runs and
        # whitespace). SequenceMatcher sometimes bundles real OCR words into the
        # same non-equal opcode as a gap — this happens precisely when the text
        # layer at this bbox does NOT correspond to the OCR (e.g. a caption /
        # footnote bbox overlapping the float body, so the clip returns plot
        # axes or table cells). Overwriting such a segment would delete real
        # text and splice in garbage, so we keep it verbatim — OCR is baseline.
        if set(re.sub(r"\s+", "", seg)) - {"?"}:
            out.append(seg)
            continue
        repl = layer[j1:j2].strip()
        qn = seg.count("?")
        if repl and "?" not in repl and len(repl) <= max(_MIN_CAP, qn * _PER_Q):
            # keep the original gap's surrounding whitespace
            lead = seg[: len(seg) - len(seg.lstrip())]
            trail = seg[len(seg.rstrip()):]
            out.append(lead + repl + trail)
        else:
            out.append(seg)  # no clean recovery: leave the OCR '?'s untouched
    new = "".join(out)
    if not _letters_preserved(ocr, new):
        return ocr, 0       # alignment overwrote real text — refuse the change
    fixed = before - len(GAP_RE.findall(new))
    return new, max(0, fixed)


def _letters_preserved(old: str, new: str) -> bool:
    """True iff *new* keeps every alphabetic character *old* had (by count).

    A ``?``-gap contains no letters, so a correct repair only ever *adds* letters
    in place of the gap; it can never reduce any letter's count.  A drop means
    the diff alignment overwrote real text — reject such a result.
    """
    co = Counter(c for c in old if c.isalpha())
    cn = Counter(c for c in new if c.isalpha())
    return all(cn[ch] >= n for ch, n in co.items())


# --------------------------------------------------------------------------- #
# Block traversal
# --------------------------------------------------------------------------- #

def _holders(block: Any) -> list[tuple[Callable[[], str], Callable[[str], None]]]:
    """Return (get, set) accessors for every *body-text* field of *block*.

    Body text = paragraph text, list-item text, figure/table/code captions, and
    figure/table footnotes.  Equation LaTeX, table HTML and code bodies are
    intentionally excluded.
    """
    out: list[tuple[Callable[[], str], Callable[[str], None]]] = []
    if isinstance(block, Paragraph):
        out.append((lambda: block.text, lambda v: setattr(block, "text", v)))
    for it in getattr(block, "items", None) or []:
        out.append((lambda it=it: it.text, lambda v, it=it: setattr(it, "text", v)))
    cap = getattr(block, "caption", None)
    if isinstance(cap, RichText):
        out.append((lambda cap=cap: cap.text, lambda v, cap=cap: setattr(cap, "text", v)))
    fn = getattr(block, "footnote", None)
    if isinstance(fn, str) and fn:
        out.append((lambda: block.footnote, lambda v: setattr(block, "footnote", v)))
    return out


def _clip_layer(page: "fitz.Page", bbox_1000: list[float]) -> str:
    """Extract the PDF text layer within *bbox_1000* (MinerU 0..1000 coords)."""
    w, h = page.rect.width, page.rect.height
    if w <= 0 or h <= 0:
        return ""
    pad = _PAD_FRAC
    x0 = max(0.0, bbox_1000[0] / 1000.0 - pad) * w
    y0 = max(0.0, bbox_1000[1] / 1000.0 - pad) * h
    x1 = min(1.0, bbox_1000[2] / 1000.0 + pad) * w
    y1 = min(1.0, bbox_1000[3] / 1000.0 + pad) * h
    raw = page.get_text("text", clip=fitz.Rect(x0, y0, x1, y1))
    return re.sub(r"[ \t]+", " ", raw).replace("\n", " ").strip()


def _has_text_layer(pdf: "fitz.Document") -> bool:
    chars = 0
    n = min(pdf.page_count, 6)
    for i in range(n):
        chars += len(pdf[i].get_text("text").strip())
    return (chars / max(1, n)) > 80


def apply_textfix(doc: Document, pdf_path: str | Path) -> dict[str, int]:
    """Repair ``?``-gaps in *doc*'s body text from *pdf_path*'s text layer.

    Mutates the document in place and returns a small stats dict.  Safe to call
    on a scanned PDF (no text layer) — it simply finds nothing to fix.
    """
    stats = {"gaps_before": 0, "gaps_fixed": 0, "holders_changed": 0}
    try:
        pdf = fitz.open(pdf_path)
    except Exception as e:                              # never fail the pipeline
        log.warning("textfix: cannot open %s (%s); skipping", pdf_path, e)
        return stats
    try:
        if not _has_text_layer(pdf):
            log.info("textfix: no text layer in %s; skipping", Path(pdf_path).name)
            return stats
        for block in doc.iter_blocks():
            try:
                page_idx = getattr(block, "page_idx", None)
                bbox = getattr(block, "bbox", None)
                if page_idx is None or not bbox or not (0 <= page_idx < pdf.page_count):
                    continue
                holders = _holders(block)
                if not holders:
                    continue
                layer: str | None = None  # clip lazily, only if a gap is present
                for get, set_ in holders:
                    text = get()
                    if not text or not GAP_RE.search(text):
                        continue
                    stats["gaps_before"] += len(GAP_RE.findall(text))
                    if layer is None:
                        layer = _clip_layer(pdf[page_idx], bbox)
                    new, fixed = repair_text(text, layer)
                    if fixed > 0 and new != text:
                        set_(new)
                        stats["gaps_fixed"] += fixed
                        stats["holders_changed"] += 1
            except Exception as e:                   # one bad page never aborts
                log.warning("textfix: skipped block %s (%s)",
                            getattr(block, "id", "?"), e)
    finally:
        pdf.close()
    log.info("textfix: fixed %d/%d ?-gaps in %d holders",
             stats["gaps_fixed"], stats["gaps_before"], stats["holders_changed"])
    return stats
