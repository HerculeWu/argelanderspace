/**
 * LLM-friendly markdown renderer + segment helpers (agent surface).
 *
 * The stored render IR (`TexDocIr`) IS the single source of truth; this
 * module only assembles markdown from it (`renderIrMarkdown` /
 * `renderIrSectionMarkdown`) and hosts the segment-level helpers the tex
 * pipeline and the CLI consume (`citeShort`, `segmentsMarkdown`,
 * `segmentsPlainText` — adopted from the retired `ir.ts` in MS4b).
 *
 * Output formats (token style of the read-paper skill's `article_llm.md`):
 * - cite segments → `[cite: ref-1 | Bok 1934 | title: …]` (title segment only
 *   when the reference carries one); unresolved → `[cite: ? | unresolved]`.
 * - xref segments → `[ref: fig-3 | figure | number: 3 | <caption excerpt>]`;
 *   unresolved → `[ref: figure-9 | unresolved]` / `[ref: ? | unresolved]`.
 * - Figures/tables render as `[Figure omitted | id: … | number: … |
 *   caption: … | path: /images/<doc_id>/<img>]` placeholder lines; equations
 *   as display `$$…$$` plus a `[ref: …]` anchor line; code/algorithms as a
 *   `[ref: …]` anchor line plus a fenced body.
 */

import type {
  DocIr,
  IrAlgorithmBlock,
  IrBlock,
  IrCiteRef,
  IrCodeBlock,
  IrFigureBlock,
  IrSection,
  IrSegment,
  IrTableBlock,
  IrXrefTarget,
  Reference,
} from "@argelanderspace/contracts";

export type { BibManifestRow, RefManifestRow } from "@argelanderspace/contracts";

import { displayAuthors } from "../library/store.js";

export interface RenderOptions {
  /** Max chars of an inline `[ref: …]` preview / manifest `short` (default 80). */
  previewLength?: number;
}

const DEFAULT_PREVIEW = 80;

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

// --------------------------------------------------------------------------- //
// IR blocks / sections → markdown
// --------------------------------------------------------------------------- //

interface MdCtx {
  docId: string;
  preview: number;
}

function floatPlaceholder(
  name: "Figure" | "Table",
  b: IrFigureBlock | IrTableBlock,
  ctx: MdCtx
): string {
  const parts = [`${name} omitted`, `id: ${san(b.id)}`];
  if (b.number !== undefined) parts.push(`number: ${san(b.number)}`);
  // full caption (agents need it); plain text, tokens stripped (previews only —
  // the token-expanded caption is in the refs manifest `content`)
  const caption = san(segmentsPlainText(b.captionSegments ?? []));
  if (caption !== "") parts.push(`caption: ${caption}`);
  if (b.imgPath !== undefined) parts.push(`path: /images/${ctx.docId}/${b.imgPath}`);
  return `[${parts.join(" | ")}]`;
}

/** The `[ref: …]` anchor line that marks where a float lives in the text. */
function anchorLine(id: string, kind: string, number: string | undefined, preview: string): string {
  const parts = [`[ref: ${san(id)}`, kind];
  if (number !== undefined) parts.push(`number: ${san(number)}`);
  if (preview !== "") parts.push(preview);
  return `${parts.join(" | ")}]`;
}

/** The sanitized + truncated caption preview of a code/algorithm float. */
function captionPreview(b: IrCodeBlock | IrAlgorithmBlock, preview: number): string {
  return truncate(san(segmentsPlainText(b.captionSegments ?? [])), preview);
}

function blockMarkdown(b: IrBlock, ctx: MdCtx): string {
  switch (b.type) {
    case "paragraph":
      return segmentsMarkdown(b.segments);
    case "list":
      return b.items
        .map((it, i) => `${b.ordered ? `${i + 1}.` : "-"} ${segmentsMarkdown(it.segments)}`)
        .join("\n");
    case "figure":
      return floatPlaceholder("Figure", b, ctx);
    case "table":
      return floatPlaceholder("Table", b, ctx);
    case "equation":
      return `$$\n${b.latex}\n$$\n${anchorLine(b.id, b.type, b.number, truncate(san(b.latex), ctx.preview))}`;
    case "code":
    case "algorithm": {
      const lines = [anchorLine(b.id, b.type, b.number, captionPreview(b, ctx.preview))];
      if (b.body !== undefined && b.body !== "") {
        const lang = b.type === "code" ? (b.lang ?? "") : "";
        lines.push(`\`\`\`${lang}\n${b.body}\n\`\`\``);
      }
      return lines.join("\n");
    }
  }
}

function sectionMarkdown(s: IrSection, ctx: MdCtx): string {
  const parts: string[] = [];
  const heading =
    s.heading !== undefined
      ? s.number !== undefined
        ? `${s.number} ${s.heading}`
        : s.heading
      : (s.number ?? "");
  if (heading !== "") {
    const level = Math.min(Math.max(s.level, 1), 6);
    parts.push(`${"#".repeat(level)} ${heading}`);
  }
  for (const b of s.blocks) parts.push(blockMarkdown(b, ctx));
  for (const c of s.children) parts.push(sectionMarkdown(c, ctx));
  return parts.join("\n\n");
}

function* iterIrSections(sections: IrSection[]): Generator<IrSection> {
  for (const s of sections) {
    yield s;
    yield* iterIrSections(s.children);
  }
}

/** The whole document body as LLM-friendly markdown straight from a DocIr. */
export function renderIrMarkdown(ir: DocIr, opts: RenderOptions = {}): string {
  const ctx: MdCtx = { docId: ir.docId, preview: opts.previewLength ?? DEFAULT_PREVIEW };
  return `${ir.sections.map((s) => sectionMarkdown(s, ctx)).join("\n\n")}\n`;
}

/** One IR section subtree as markdown (DocIr twin of {@link renderSectionMarkdown}). */
export function renderIrSectionMarkdown(
  ir: DocIr,
  sectionId: string,
  opts: RenderOptions = {}
): string {
  const all = [...iterIrSections(ir.sections)];
  const sec = all.find((s) => s.id === sectionId);
  if (sec === undefined) {
    const avail = all.map((s) => s.id).join(", ");
    throw new Error(`unknown section "${sectionId}" in doc ${ir.docId}; available: ${avail}`);
  }
  const ctx: MdCtx = { docId: ir.docId, preview: opts.previewLength ?? DEFAULT_PREVIEW };
  return `${sectionMarkdown(sec, ctx)}\n`;
}

// --------------------------------------------------------------------------- //
// Segment helpers (adopted from the retired `ir.ts`, MS4b)
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
 * The token-expanded inline text of a segment run (the markdown renderer's
 * inline notation).
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

/** The plain text of a segment run with cite/xref tokens dropped. */
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

/** `"Bok 1934"` / `"Belokurov et al. 2006"`; falls back to label, then raw. */
export function citeShort(ref: Reference): string {
  const who = displayAuthors(ref.authors ?? []);
  const year = ref.year !== undefined ? String(ref.year) : "";
  const s = [who, year].filter((x) => x !== "").join(" ");
  if (s !== "") return s;
  if (ref.label !== undefined && ref.label !== "") return san(ref.label);
  return truncate(san(ref.raw), 40);
}
