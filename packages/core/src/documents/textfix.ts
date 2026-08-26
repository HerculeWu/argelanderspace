/**
 * OCR text-layer correction: repair MinerU's `?` gaps from the PDF text layer
 * (bibgraph/ingest/textfix.py).
 *
 * MinerU's VLM backend transcribes the *rendered page image*, so a glyph it cannot
 * read visually comes out as a run of `?` (e.g. `"external field of order ??"`).
 * For born-digital PDFs the embedded text layer usually *does* contain that
 * character, and that text layer is an independent source — MinerU did not use it.
 *
 * This stage repairs **only** those `?`-runs. For each body-text holder it clips the
 * PDF text layer to the block's bounding box, aligns it to the OCR text with a
 * character-level diff, and splices the recovered characters into the `?`-gaps.
 * OCR stays the baseline: nothing but `?`-runs is ever touched, and a gap is left
 * as-is whenever the text layer cannot supply a clean replacement. Equation LaTeX,
 * table HTML and code bodies are deliberately *not* corrected.
 *
 * The PDF itself is reached through the {@link PdfTextProvider} port — the mupdf
 * implementation lands in packages/infra (M2).
 */

import type { Block, Document } from "@argelanderspace/contracts";
import { getOpcodes } from "./sequence-matcher.js";
import { iterBlocks } from "./traverse.js";

// A run of two or more '?' — MinerU's marker for glyphs it could not read.
// Single '?' is left alone (it is almost always a real question mark or part of
// an unresolved-xref token like "equation-3?").
const GAP_RE = /\?{2,}/u;
const GAP_COUNT_RE = /\?{2,}/gu;

// Replacement sanity: the recovered span must be clean (no '?' of its own) and
// not runaway-long relative to the number of '?'s it stands in for.
const MIN_CAP = 16;
const PER_Q = 4;
// Expand the clip box slightly (fraction of page) so glyphs on the bbox edge are
// still captured by the clip intersection test.
const PAD_FRAC = 0.004;
// Minimum fraction of the OCR text's alphanumeric chars that must align to the
// clipped text layer for us to trust it. Below this the layer does not correspond
// to this block (e.g. a caption/footnote bbox overlapping the float body) and we
// touch nothing. Real paragraphs score >= 0.85; a mismatched footnote scores ~0.16,
// so 0.5 separates them with wide margin.
const MIN_CORRESPONDENCE = 0.5;
// SequenceMatcher(autojunk=False) gives the best gap alignment (autojunk=True drops
// real fixes) but is super-linear on highly repetitive input. Real body holders are
// tiny (combined OCR+layer length well under this); above the threshold — only
// reachable by anomalously large/degenerate clips, which never carry a genuine fix —
// enable the popular-char heuristic to stay fast.
const AUTOJUNK_OVER = 6000;
// Hard ceiling: skip a holder whose OCR or clipped layer is absurdly large
// (mis-sized bbox / degenerate page); diffing it would be pointless and slow.
const MAX_LEN = 12000;

// --------------------------------------------------------------------------- //
// Port: the PDF text layer
// --------------------------------------------------------------------------- //

/** Page-coordinates rect (points, top-left origin), the analogue of PyMuPDF's `fitz.Rect`. */
export interface PageRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Port interface: the PDF text layer as consumed by textfix.
 *
 * Implementations must be byte-identical to PyMuPDF (the mupdf spike verified both):
 * - `pageText` = `page.get_text("text")` — the page's raw extracted text layer.
 * - `clippedText` = `page.get_text("text", clip=rect)` — characters whose glyph
 *   center lies inside `rect` (mupdf: `toStructuredText().walk({onChar})` with a
 *   quad-center-in-rect filter; byte-identical to PyMuPDF's `clip=`). Return the RAW
 *   text — whitespace normalization happens in core ({@link clipLayer}).
 */
export interface PdfTextProvider {
  readonly pageCount: number;
  /** Page size in points; width/height <= 0 marks a degenerate page. */
  pageSize(pageIdx: number): { width: number; height: number };
  /** Raw text layer of the whole page ("" when the page has none). */
  pageText(pageIdx: number): string;
  /** Raw text layer inside `rect` (page points, top-left origin). */
  clippedText(pageIdx: number, rect: PageRect): string;
  /** Release the underlying document (called in a `finally` by {@link applyTextfix}). */
  close(): void;
}

export type TextfixStats = {
  gaps_before: number;
  gaps_fixed: number;
  holders_changed: number;
};

// --------------------------------------------------------------------------- //
// repair_text: splice text-layer characters into the ?-gaps of ocr
// --------------------------------------------------------------------------- //

export interface RepairResult {
  text: string;
  fixed: number;
}

/**
 * Splice text-layer characters into the `?`-gaps of `ocr`.
 *
 * Only opcodes whose OCR side contains a `?` are ever replaced; `equal` regions and
 * plain OCR/text-layer disagreements (no `?`) are kept verbatim, so OCR remains the
 * baseline.
 */
export function repairText(ocr: string, layer: string): RepairResult {
  if (!layer || !ocr.includes("?")) return { text: ocr, fixed: 0 };
  const before = (ocr.match(GAP_COUNT_RE) ?? []).length;
  if (before === 0) return { text: ocr, fixed: 0 };
  // diff over code points, matching Python's str indexing
  const ocrChars = Array.from(ocr);
  const layerChars = Array.from(layer);
  if (ocrChars.length > MAX_LEN || layerChars.length > MAX_LEN) {
    return { text: ocr, fixed: 0 }; // anomalously large holder — don't diff it
  }

  const autojunk = ocrChars.length + layerChars.length > AUTOJUNK_OVER;
  const opcodes = getOpcodes(ocrChars, layerChars, autojunk);

  // Correspondence gate: if the clipped text layer does not actually correspond to
  // this block's OCR text (a caption/footnote bbox overlapping the float body
  // returns plot axes or table cells), refuse to touch anything — every splice
  // would be wrong. Measured as the fraction of the OCR's alphanumeric characters
  // that align ('equal') to the layer.
  let totalAlnum = 0;
  for (const c of ocrChars) {
    if (isAlnum(c)) totalAlnum += 1;
  }
  let matchedAlnum = 0;
  for (const op of opcodes) {
    if (op.tag !== "equal") continue;
    for (let i = op.i1; i < op.i2; i++) {
      const c = ocrChars[i];
      if (c !== undefined && isAlnum(c)) matchedAlnum += 1;
    }
  }
  // Fail closed: with no alphanumeric text we cannot verify correspondence (a
  // pure-symbol holder like "(??)"), so refuse rather than risk a wrong splice.
  if (totalAlnum === 0 || matchedAlnum / totalAlnum < MIN_CORRESPONDENCE) {
    return { text: ocr, fixed: 0 };
  }

  const out: string[] = [];
  for (const op of opcodes) {
    const seg = ocrChars.slice(op.i1, op.i2).join("");
    if (op.tag === "equal" || !seg.includes("?")) {
      out.push(seg);
      continue;
    }
    // Replace ONLY a segment that is a *pure gap* (just '?'-runs and whitespace).
    // The diff sometimes bundles real OCR words into the same non-equal opcode as
    // a gap — this happens precisely when the text layer at this bbox does NOT
    // correspond to the OCR. Overwriting such a segment would delete real text and
    // splice in garbage, so we keep it verbatim — OCR is baseline.
    if ([...seg.replace(/\s+/gu, "")].some((c) => c !== "?")) {
      out.push(seg);
      continue;
    }
    const repl = layerChars.slice(op.j1, op.j2).join("").trim();
    const qn = (seg.match(/\?/gu) ?? []).length;
    if (repl && !repl.includes("?") && Array.from(repl).length <= Math.max(MIN_CAP, qn * PER_Q)) {
      // keep the original gap's surrounding whitespace
      const lead = /^\s*/u.exec(seg)?.[0] ?? "";
      const trail = /\s*$/u.exec(seg)?.[0] ?? "";
      out.push(lead + repl + trail);
    } else {
      out.push(seg); // no clean recovery: leave the OCR '?'s untouched
    }
  }
  const newText = out.join("");
  if (!lettersPreserved(ocr, newText)) {
    return { text: ocr, fixed: 0 }; // alignment overwrote real text — refuse the change
  }
  const fixed = before - (newText.match(GAP_COUNT_RE) ?? []).length;
  return { text: newText, fixed: Math.max(0, fixed) };
}

/**
 * True iff `newText` keeps every alphabetic character `oldText` had (by count).
 *
 * A `?`-gap contains no letters, so a correct repair only ever *adds* letters in
 * place of the gap; it can never reduce any letter's count. A drop means the diff
 * alignment overwrote real text — reject such a result.
 */
function lettersPreserved(oldText: string, newText: string): boolean {
  const counts = new Map<string, number>();
  for (const c of oldText) {
    if (isAlpha(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const newCounts = new Map<string, number>();
  for (const c of newText) {
    if (isAlpha(c)) newCounts.set(c, (newCounts.get(c) ?? 0) + 1);
  }
  for (const [ch, n] of counts) {
    if ((newCounts.get(ch) ?? 0) < n) return false;
  }
  return true;
}

// Python's str.isalnum() / str.isalpha() are Unicode category checks.
const ALNUM_RE = /[\p{L}\p{N}]/u;
const ALPHA_RE = /\p{L}/u;

function isAlnum(c: string): boolean {
  return ALNUM_RE.test(c);
}

function isAlpha(c: string): boolean {
  return ALPHA_RE.test(c);
}

// --------------------------------------------------------------------------- //
// Block traversal
// --------------------------------------------------------------------------- //

interface TextHolder {
  get(): string;
  set(v: string): void;
}

/**
 * Return accessors for every *body-text* field of `block`.
 *
 * Body text = paragraph text, list-item text, figure/table/code captions, and
 * figure/table footnotes. Equation LaTeX, table HTML and code bodies are
 * intentionally excluded.
 */
function holdersOf(block: Block): TextHolder[] {
  const out: TextHolder[] = [];
  if (block.type === "paragraph") {
    out.push({
      get: () => block.text,
      set: (v) => {
        block.text = v;
      },
    });
  }
  if (block.type === "list") {
    for (const it of block.items) {
      out.push({
        get: () => it.text,
        set: (v) => {
          it.text = v;
        },
      });
    }
  }
  if ("caption" in block && block.caption !== undefined) {
    const cap = block.caption;
    out.push({
      get: () => cap.text,
      set: (v) => {
        cap.text = v;
      },
    });
  }
  if ("footnote" in block && typeof block.footnote === "string" && block.footnote !== "") {
    out.push({
      get: () => block.footnote ?? "",
      set: (v) => {
        block.footnote = v;
      },
    });
  }
  return out;
}

/** Extract the PDF text layer within `bbox1000` (MinerU 0..1000 coords). */
function clipLayer(
  provider: PdfTextProvider,
  pageIdx: number,
  bbox1000: readonly [number, number, number, number]
): string {
  const { width: w, height: h } = provider.pageSize(pageIdx);
  if (w <= 0 || h <= 0) return "";
  const x0 = Math.max(0, bbox1000[0] / 1000 - PAD_FRAC) * w;
  const y0 = Math.max(0, bbox1000[1] / 1000 - PAD_FRAC) * h;
  const x1 = Math.min(1, bbox1000[2] / 1000 + PAD_FRAC) * w;
  const y1 = Math.min(1, bbox1000[3] / 1000 + PAD_FRAC) * h;
  const raw = provider.clippedText(pageIdx, { x0, y0, x1, y1 });
  return raw
    .replace(/[ \t]+/gu, " ")
    .replaceAll("\n", " ")
    .trim();
}

/** Cheap check: does the PDF carry an extractable text layer? */
export function hasTextLayer(provider: PdfTextProvider): boolean {
  let chars = 0;
  const n = Math.min(provider.pageCount, 6);
  for (let i = 0; i < n; i++) {
    chars += Array.from(provider.pageText(i).trim()).length;
  }
  return chars / Math.max(1, n) > 80;
}

/**
 * Repair `?`-gaps in `doc`'s body text from the provider's text layer.
 *
 * Mutates the document in place and returns small stats. Safe to call on a scanned
 * PDF (no text layer) — it simply finds nothing to fix.
 */
export function applyTextfix(
  doc: Document,
  provider: PdfTextProvider,
  log?: (msg: string) => void
): TextfixStats {
  const stats: TextfixStats = { gaps_before: 0, gaps_fixed: 0, holders_changed: 0 };
  try {
    if (!hasTextLayer(provider)) {
      return stats;
    }
    for (const block of iterBlocks(doc)) {
      try {
        const pageIdx = block.page_idx;
        const bbox = block.bbox;
        if (pageIdx === undefined || !bbox || pageIdx < 0 || pageIdx >= provider.pageCount) {
          continue;
        }
        const holders = holdersOf(block);
        if (holders.length === 0) continue;
        let layer: string | undefined; // clip lazily, only if a gap is present
        for (const h of holders) {
          const text = h.get();
          if (!text || !GAP_RE.test(text)) continue;
          stats.gaps_before += (text.match(GAP_COUNT_RE) ?? []).length;
          if (layer === undefined) layer = clipLayer(provider, pageIdx, bbox);
          const { text: newText, fixed } = repairText(text, layer);
          if (fixed > 0 && newText !== text) {
            h.set(newText);
            stats.gaps_fixed += fixed;
            stats.holders_changed += 1;
          }
        }
      } catch (e) {
        // one bad page never aborts
        log?.(`textfix: skipped block ${block.id} (${String(e)})`);
      }
    }
  } finally {
    provider.close();
  }
  return stats;
}
