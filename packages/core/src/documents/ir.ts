/**
 * The document render IR builder (Stage 3 / MS2a; design in
 * `.kimi-code/memory/2026-09-01-stage3-design.md`).
 *
 * `buildDocIr` projects a Document JSON into the `DocIr` contract every
 * renderer consumes: the section tree with typed blocks, body text
 * pre-segmented into `text | math | cite | xref` inline runs with occurrences
 * explicitly paired in, plus the refs/bib manifests and the per-block citation
 * index. Pure and deterministic.
 *
 * Conventions mirrored from the Stage-2 markdown renderer (`render.ts`), whose
 * output is now assembled from this IR byte-for-byte:
 * - Segmentation uses one combined scanner (web's `richtext.tsx` semantics:
 *   inline math `$…$` — `$$` never matches — cite tokens, xref tokens) and
 *   partitions the source text losslessly.
 * - Cite ids split on `;` + trim; `""`/`"?"` → `{id: "?", resolved: false}`.
 *   Xref ids strip the unresolved trailing `?` marker.
 * - Occurrence pairing zips the RichText-local `citations`/`crossrefs` arrays
 *   with the tokens in order. Mismatches never throw: tokens without a
 *   counterpart get no `raw`; surplus occurrences are ignored.
 * - `short`/`title`/`heading` stay raw (the markdown exporter sanitizes);
 *   float `preview` is already sanitized + truncated (plain text).
 */

import {
  type AlgorithmBlock,
  type BibManifestRow,
  type Block,
  CITE_TOKEN_RE,
  type CitationOccurrence,
  type CodeBlock,
  type CrossRefOccurrence,
  type DocIr,
  type Document,
  type EquationBlock,
  type FigureBlock,
  type IrAlgorithmBlock,
  type IrBlock,
  type IrCiteRef,
  type IrCiteSegment,
  type IrCodeBlock,
  type IrEquationBlock,
  type IrFigureBlock,
  type IrSection,
  type IrSegment,
  type IrTableBlock,
  type IrXrefSegment,
  type IrXrefTarget,
  type Reference,
  type RefManifestRow,
  type RichText,
  type Section,
  type TableBlock,
  XREF_TOKEN_RE,
} from "@argelanderspace/contracts";
import { displayAuthors } from "../library/store.js";
import { stripTokens } from "./tokens.js";
import { iterSections } from "./traverse.js";

/** Float block kinds: they get refs-manifest rows / anchors / `show` lookups. */
export type FloatBlock = FigureBlock | TableBlock | EquationBlock | CodeBlock | AlgorithmBlock;

function isFloat(b: Block): b is FloatBlock {
  return (
    b.type === "figure" ||
    b.type === "table" ||
    b.type === "equation" ||
    b.type === "code" ||
    b.type === "algorithm"
  );
}

export interface BuildIrOptions {
  /** Max chars of an xref/manifest preview (default 80). */
  previewLength?: number;
}

const DEFAULT_PREVIEW = 80;
/** Max chars of manifest `context_before` / `context_after`. */
const CONTEXT_LEN = 200;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** One-line text safe to embed inside a `[... | ...]` segment (no `|[]`). */
function san(s: string): string {
  return s
    .replace(/\s+/gu, " ")
    .replaceAll("|", "/")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .trim();
}

/** `"Bok 1934"` / `"Belokurov et al. 2006"`; falls back to label, then raw. */
export function citeShort(ref: Reference): string {
  const who = displayAuthors(ref.authors ?? []);
  const year = ref.year !== undefined ? String(ref.year) : "";
  const s = [who, year].filter((x) => x !== "").join(" ");
  if (s !== "") return s;
  if (ref.label !== undefined && ref.label !== "") return san(ref.label);
  return truncate(san(ref.raw), 40);
}

// --------------------------------------------------------------------------- //
// Lookups
// --------------------------------------------------------------------------- //

/** Doc-wide resolution tables for tokens (floats / sections / references). */
export interface IrLookups {
  floats: Map<string, FloatBlock>;
  sections: Map<string, Section>;
  refs: Map<string, Reference>;
}

export function buildIrLookups(doc: Document): IrLookups {
  const floats = new Map<string, FloatBlock>();
  const sections = new Map<string, Section>();
  for (const s of iterSections(doc)) {
    sections.set(s.id, s);
    for (const b of s.blocks ?? []) {
      if (isFloat(b)) floats.set(b.id, b);
    }
  }
  const refs = new Map((doc.references ?? []).map((r) => [r.id, r]));
  return { floats, sections, refs };
}

// --------------------------------------------------------------------------- //
// Inline segmentation
// --------------------------------------------------------------------------- //

// One combined scanner for: inline math $...$, cite tokens, xref tokens —
// derived from the contracts token regexes, web's richtext.tsx semantics.
// Only used via `matchAll` (which clones the regex), so the module-level
// instance never carries lastIndex state.
const SCAN_G = new RegExp(
  `\\$(?!\\$)([^$]+?)\\$|${CITE_TOKEN_RE.source}|${XREF_TOKEN_RE.source}`,
  "gu"
);

export interface SegmentInlineOptions {
  /** RichText-local occurrence arrays, zipped with the tokens in order. */
  citations?: CitationOccurrence[];
  crossrefs?: CrossRefOccurrence[];
  /** Max chars of an xref float preview (default 80). */
  previewLength?: number;
}

function citeRefs(inner: string, lookups: IrLookups): IrCiteRef[] {
  return inner
    .split(";")
    .map((raw) => raw.trim())
    .map((id) => {
      if (id === "" || id === "?") return { id: "?", resolved: false };
      const ref = lookups.refs.get(id);
      if (ref === undefined) return { id, resolved: false };
      const out: IrCiteRef = { id, resolved: true, short: citeShort(ref) };
      if (ref.title !== undefined && ref.title !== "") out.title = ref.title;
      return out;
    });
}

/** The preview of a resolved float xref (latex / caption excerpt), plain text. */
function floatPreview(b: FloatBlock, preview: number): string {
  // previews are plain text: nested brackets would corrupt the token
  return b.type === "equation"
    ? truncate(san(b.latex), preview)
    : truncate(san(stripTokens(b.caption?.text ?? "")), preview);
}

function xrefTarget(inner: string, lookups: IrLookups, preview: number): IrXrefTarget {
  // unresolved targets carry a trailing "?" ([[xref:figure-9?]] / [[xref:?]]);
  // strip it — `resolved: false` already says so
  const id = inner.endsWith("?") ? inner.slice(0, -1) : inner;
  if (id === "") return { id: "?", resolved: false };
  const float = lookups.floats.get(id);
  if (float !== undefined) {
    const out: IrXrefTarget = {
      id,
      resolved: true,
      targetType: float.type,
      preview: floatPreview(float, preview),
    };
    if (float.number !== undefined) out.number = float.number;
    return out;
  }
  const sec = lookups.sections.get(id);
  if (sec !== undefined) {
    const out: IrXrefTarget = { id, resolved: true, targetType: "section" };
    if (sec.number !== undefined) out.number = sec.number;
    if (sec.heading !== undefined) out.heading = sec.heading;
    return out;
  }
  return { id, resolved: false };
}

/**
 * Split *text* into inline segments. The segments partition the source
 * losslessly (text/math reassemble verbatim; cite/xref spans are exactly the
 * token texts). Occurrences are consumed in token order; a token without a
 * counterpart simply gets no `raw`, surplus occurrences are ignored.
 */
export function segmentInline(
  text: string,
  lookups: IrLookups,
  opts: SegmentInlineOptions = {}
): IrSegment[] {
  const preview = opts.previewLength ?? DEFAULT_PREVIEW;
  const segments: IrSegment[] = [];
  let citeIdx = 0;
  let xrefIdx = 0;
  let last = 0;
  const pushText = (t: string): void => {
    if (t !== "") segments.push({ type: "text", text: t });
  };
  for (const m of text.matchAll(SCAN_G)) {
    const token = m[0];
    if (token === undefined) continue; // impossible; noUncheckedIndexedAccess
    pushText(text.slice(last, m.index));
    last = m.index + token.length;
    if (m[1] !== undefined) {
      segments.push({ type: "math", latex: m[1] });
    } else if (m[2] !== undefined) {
      const seg: IrCiteSegment = { type: "cite", refs: citeRefs(m[2], lookups) };
      const occ = opts.citations?.[citeIdx++];
      if (occ !== undefined) seg.raw = occ.raw;
      segments.push(seg);
    } else if (m[3] !== undefined) {
      const seg: IrXrefSegment = { type: "xref", target: xrefTarget(m[3], lookups, preview) };
      const occ = opts.crossrefs?.[xrefIdx++];
      if (occ !== undefined) seg.raw = occ.raw;
      segments.push(seg);
    }
  }
  pushText(text.slice(last));
  return segments;
}

// --------------------------------------------------------------------------- //
// Segments → LLM-markdown inline text (also used for manifest `content`)
// --------------------------------------------------------------------------- //

function citeRefMarkdown(r: IrCiteRef): string {
  if (!r.resolved) {
    return r.id === "?" ? "[cite: ? | unresolved]" : `[cite: ${san(r.id)} | unresolved]`;
  }
  const parts = [san(r.id), san(r.short ?? "")];
  if (r.title !== undefined) parts.push(`title: ${san(r.title)}`);
  return `[cite: ${parts.join(" | ")}]`;
}

function xrefTargetMarkdown(t: IrXrefTarget): string {
  if (!t.resolved || t.targetType === undefined) return `[ref: ${san(t.id)} | unresolved]`;
  const parts = [san(t.id), t.targetType];
  if (t.number !== undefined) parts.push(`number: ${san(t.number)}`);
  if (t.targetType === "section") {
    if (t.heading !== undefined) parts.push(san(t.heading));
  } else if (t.preview !== undefined && t.preview !== "") {
    parts.push(t.preview); // already sanitized + truncated plain text
  }
  return `[ref: ${parts.join(" | ")}]`;
}

/**
 * The token-expanded inline text (the markdown renderer's inline notation).
 * Reassembly is byte-identical to the Stage-2 `replace`-based expansion.
 */
export function segmentsMarkdown(segments: IrSegment[]): string {
  return segments.map(segmentMarkdown).join("");
}

function segmentMarkdown(seg: IrSegment): string {
  switch (seg.type) {
    case "text":
      return seg.text;
    case "math":
      return `$${seg.latex}$`;
    case "cite":
      return seg.refs.map(citeRefMarkdown).join("");
    case "xref":
      return xrefTargetMarkdown(seg.target);
  }
}

/**
 * The plain text of a segment run with cite/xref tokens dropped (equivalent
 * to `stripTokens` before its whitespace collapse — `san()` converges).
 */
export function segmentsPlainText(segments: IrSegment[]): string {
  return segments.map(segmentPlainText).join("");
}

function segmentPlainText(seg: IrSegment): string {
  switch (seg.type) {
    case "text":
      return seg.text;
    case "math":
      return `$${seg.latex}$`;
    case "cite":
    case "xref":
      return "";
  }
}

/** Token-expanded inline text straight from a source string (no IR roundtrip). */
function inlineText(text: string, lookups: IrLookups, opts: SegmentInlineOptions = {}): string {
  return segmentsMarkdown(segmentInline(text, lookups, opts));
}

// --------------------------------------------------------------------------- //
// Blocks / sections → IR
// --------------------------------------------------------------------------- //

function blockIr(b: Block, lookups: IrLookups, preview: number): IrBlock {
  const richTextSegments = (rt: RichText): IrSegment[] =>
    segmentInline(rt.text, lookups, {
      citations: rt.citations,
      crossrefs: rt.crossrefs,
      previewLength: preview,
    });
  switch (b.type) {
    case "paragraph":
      return {
        id: b.id,
        type: "paragraph",
        segments: segmentInline(b.text, lookups, {
          citations: b.citations,
          crossrefs: b.crossrefs,
          previewLength: preview,
        }),
      };
    case "list":
      return {
        id: b.id,
        type: "list",
        ordered: b.ordered,
        items: b.items.map((it) => ({ segments: richTextSegments(it) })),
      };
    case "figure": {
      const out: IrFigureBlock = { id: b.id, type: "figure" };
      if (b.number !== undefined) out.number = b.number;
      if (b.label !== undefined) out.label = b.label;
      if (b.caption !== undefined) out.captionSegments = richTextSegments(b.caption);
      if (b.footnote !== undefined) out.footnote = b.footnote;
      if (b.img_path !== undefined) out.imgPath = b.img_path;
      if (b.chart_type !== undefined) out.chartType = b.chart_type;
      if (b.content !== undefined) out.content = b.content;
      return out;
    }
    case "table": {
      const out: IrTableBlock = { id: b.id, type: "table" };
      if (b.number !== undefined) out.number = b.number;
      if (b.label !== undefined) out.label = b.label;
      if (b.caption !== undefined) out.captionSegments = richTextSegments(b.caption);
      if (b.footnote !== undefined) out.footnote = b.footnote;
      if (b.img_path !== undefined) out.imgPath = b.img_path;
      if (b.table_body !== undefined) out.tableBody = b.table_body;
      return out;
    }
    case "equation": {
      const out: IrEquationBlock = { id: b.id, type: "equation", latex: b.latex };
      if (b.number !== undefined) out.number = b.number;
      if (b.label !== undefined) out.label = b.label;
      return out;
    }
    case "code": {
      const out: IrCodeBlock = { id: b.id, type: "code" };
      if (b.number !== undefined) out.number = b.number;
      if (b.label !== undefined) out.label = b.label;
      if (b.caption !== undefined) out.captionSegments = richTextSegments(b.caption);
      if (b.lang !== undefined) out.lang = b.lang;
      if (b.body !== undefined) out.body = b.body;
      return out;
    }
    case "algorithm": {
      const out: IrAlgorithmBlock = { id: b.id, type: "algorithm" };
      if (b.number !== undefined) out.number = b.number;
      if (b.label !== undefined) out.label = b.label;
      if (b.caption !== undefined) out.captionSegments = richTextSegments(b.caption);
      if (b.body !== undefined) out.body = b.body;
      return out;
    }
  }
}

function sectionIr(s: Section, lookups: IrLookups, preview: number): IrSection {
  const out: IrSection = {
    id: s.id,
    level: s.level,
    blocks: (s.blocks ?? []).map((b) => blockIr(b, lookups, preview)),
    children: (s.children ?? []).map((c) => sectionIr(c, lookups, preview)),
  };
  if (s.number !== undefined) out.number = s.number;
  if (s.heading !== undefined) out.heading = s.heading;
  return out;
}

// --------------------------------------------------------------------------- //
// Manifests (article_refs.jsonl / article_bib.jsonl row shapes)
// --------------------------------------------------------------------------- //

function floatContent(b: FloatBlock, lookups: IrLookups, preview: number): string {
  return b.type === "equation"
    ? b.latex
    : b.caption !== undefined
      ? inlineText(b.caption.text, lookups, {
          citations: b.caption.citations,
          crossrefs: b.caption.crossrefs,
          previewLength: preview,
        })
      : "";
}

function sectionLabel(s: Section): string {
  return s.number !== undefined ? `${s.number}:${s.heading ?? ""}` : (s.heading ?? "");
}

/** The refs-manifest rows: section rows first, then one row per float (both reading order). */
function refsManifest(doc: Document, lookups: IrLookups, preview: number): RefManifestRow[] {
  const rows: RefManifestRow[] = [];
  const flat: { block: Block; section: string }[] = [];
  for (const s of iterSections(doc)) {
    const label = sectionLabel(s);
    rows.push({
      id: s.id,
      kind: "section",
      ...(s.number !== undefined ? { number: s.number } : {}),
      content: s.heading ?? "",
      short: s.heading ?? "",
      section: label,
    });
    for (const b of s.blocks ?? []) flat.push({ block: b, section: label });
  }
  const nearestText = (i: number, dir: -1 | 1): string | undefined => {
    for (let j = i + dir; j >= 0 && j < flat.length; j += dir) {
      const b = flat[j]?.block;
      if (b === undefined) continue;
      if (b.type === "paragraph") {
        return truncate(
          inlineText(b.text, lookups, {
            citations: b.citations,
            crossrefs: b.crossrefs,
            previewLength: preview,
          }),
          CONTEXT_LEN
        );
      }
      if (b.type === "list") {
        // the Stage-2 renderer inlined the joined item texts; per-item
        // segmentation is equivalent (tokens never span items)
        const joined = b.items
          .map((it) =>
            inlineText(it.text, lookups, {
              citations: it.citations,
              crossrefs: it.crossrefs,
              previewLength: preview,
            })
          )
          .join(" ");
        return truncate(joined, CONTEXT_LEN);
      }
    }
    return undefined;
  };
  flat.forEach(({ block: b, section }, i) => {
    if (!isFloat(b)) return;
    const content = floatContent(b, lookups, preview);
    const row: RefManifestRow = {
      id: b.id,
      kind: b.type,
      content,
      short: truncate(content, preview),
      section,
    };
    if (b.number !== undefined) row.number = b.number;
    const before = nearestText(i, -1);
    if (before !== undefined) row.context_before = before;
    const after = nearestText(i, 1);
    if (after !== undefined) row.context_after = after;
    rows.push(row);
  });
  return rows;
}

/** The bib-manifest rows, one per reference (the skill's `article_bib.jsonl`). */
function bibManifest(doc: Document): BibManifestRow[] {
  return (doc.references ?? []).map((r) => {
    const row: BibManifestRow = { id: r.id, short: citeShort(r), raw: r.raw };
    if (r.title !== undefined && r.title !== "") row.title = r.title;
    if (r.authors !== undefined && r.authors.length > 0) row.author = r.authors.join(", ");
    if (r.year !== undefined) row.year = r.year;
    if (r.venue !== undefined) row.venue = r.venue;
    if (r.doi !== undefined) row.doi = r.doi;
    if (r.arxiv_id !== undefined) row.arxiv_id = r.arxiv_id;
    return row;
  });
}

// --------------------------------------------------------------------------- //
// buildDocIr
// --------------------------------------------------------------------------- //

/**
 * Project a Document JSON into its render IR — the single source of truth the
 * markdown exporter and the web reader both consume. Pure and deterministic.
 */
export function buildDocIr(doc: Document, opts: BuildIrOptions = {}): DocIr {
  const lookups = buildIrLookups(doc);
  const preview = opts.previewLength ?? DEFAULT_PREVIEW;
  // The flattened doc-level citations grouped per block (order preserved,
  // ref_ids deduped) — includes hyperlink-found occurrences that have no
  // inline token; the reader's right-panel cards rely on it.
  const citationsByBlock: Record<string, string[]> = {};
  for (const c of doc.citations ?? []) {
    if (c.block_id === undefined || c.ref_ids === undefined) continue;
    const arr = citationsByBlock[c.block_id] ?? [];
    citationsByBlock[c.block_id] = arr;
    for (const id of c.ref_ids) {
      if (!arr.includes(id)) arr.push(id);
    }
  }
  const ir: DocIr = {
    docId: doc.doc_id,
    sections: (doc.structure ?? []).map((s) => sectionIr(s, lookups, preview)),
    refsManifest: refsManifest(doc, lookups, preview),
    bib: bibManifest(doc),
    citationsByBlock,
  };
  if (doc.meta?.title !== undefined) ir.title = doc.meta.title;
  // the reader topbar's "N pp" (Stage 3 / MS3 regression fix: the IR dropped it)
  if (doc.source?.n_pages !== undefined) ir.nPages = doc.source.n_pages;
  // verbatim passthrough for the reader's reference cards (bib rows flatten
  // `authors` away); compact convention: absent when the doc carries none
  if (doc.references !== undefined && doc.references.length > 0) {
    ir.references = doc.references;
  }
  return ir;
}
