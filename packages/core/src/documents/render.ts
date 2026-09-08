/**
 * LLM-friendly markdown renderer + agent manifests (Stage 2 / MS1; design
 * decisions 4, 5 and 8 in `.kimi-code/memory/2026-08-27-stage2-design.md`).
 *
 * Since Stage 3 / MS2a this module is a thin export layer over the shared
 * render IR (`./ir.ts` → `buildDocIr`): the token expansion and block/section
 * walk assemble markdown from IR segments, byte-for-byte identical to the
 * original `replace`-based implementation (the golden suite in
 * `core/tests/render.test.ts` pins this). The web reader consumes the same IR
 * directly — the IR is the single source of truth of the render pipeline.
 *
 * Output formats (token style of the read-paper skill's `article_llm.md`):
 * - `[[cite:ref-1]]` → `[cite: ref-1 | Bok 1934 | title: …]` (title segment
 *   only when the reference carries one); unresolved → `[cite: ? | unresolved]`;
 *   a `;`-group expands to one bracket per ref, adjacent.
 * - `[[xref:fig-3]]` → `[ref: fig-3 | figure | number: 3 | <caption excerpt>]`;
 *   the pipeline's unresolved marker (`[[xref:figure-9?]]` / `[[xref:?]]`) →
 *   `[ref: figure-9 | unresolved]` / `[ref: ? | unresolved]`.
 * - Figures/tables render as `[Figure omitted | id: … | number: … |
 *   caption: … | path: /images/<doc_id>/<img>]` placeholder lines; equations
 *   as display `$$…$$` plus a `[ref: …]` anchor line; code/algorithms as a
 *   `[ref: …]` anchor line plus a fenced body.
 *
 * `renderRefsManifest` / `renderBibManifest` return the IR's manifest rows
 * (the CLI serializes them as JSONL). `RefManifestRow` / `BibManifestRow` live
 * in `@argelanderspace/contracts` since MS2a and are re-exported here; the
 * IR machinery (`buildDocIr`, `citeShort`, `FloatBlock`, segment helpers)
 * lives in `./ir.ts` and is re-exported via the package index.
 */

import type {
  BibManifestRow,
  DocIr,
  Document,
  IrAlgorithmBlock,
  IrBlock,
  IrCodeBlock,
  IrFigureBlock,
  IrSection,
  IrTableBlock,
  RefManifestRow,
} from "@argelanderspace/contracts";

export type { BibManifestRow, RefManifestRow } from "@argelanderspace/contracts";

import {
  buildDocIr,
  buildIrLookups,
  segmentInline,
  segmentsMarkdown,
  segmentsPlainText,
} from "./ir.js";

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
// Inline tokens
// --------------------------------------------------------------------------- //

/** Convert every inline token in *text* (standalone helper; doc-wide lookup). */
export function renderInlineText(text: string, doc: Document): string {
  return segmentsMarkdown(segmentInline(text, buildIrLookups(doc)));
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

/** The whole document body as LLM-friendly markdown (no doc-level header). */
export function renderDocMarkdown(doc: Document, opts: RenderOptions = {}): string {
  const ir = buildDocIr(doc, opts);
  const ctx: MdCtx = { docId: ir.docId, preview: opts.previewLength ?? DEFAULT_PREVIEW };
  return `${ir.sections.map((s) => sectionMarkdown(s, ctx)).join("\n\n")}\n`;
}

/**
 * The same markdown assembled straight from a DocIr — the Stage 5 stored-IR
 * path (the stored object IS the IR, no Document projection needed).
 * Byte-conventions identical to {@link renderDocMarkdown}.
 */
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

/**
 * One section subtree (heading + own blocks + children) as markdown.
 * Throws with the available section ids when *sectionId* is unknown.
 */
export function renderSectionMarkdown(
  doc: Document,
  sectionId: string,
  opts: RenderOptions = {}
): string {
  const ir = buildDocIr(doc, opts);
  const all = [...iterIrSections(ir.sections)];
  const sec = all.find((s) => s.id === sectionId);
  if (sec === undefined) {
    const avail = all.map((s) => s.id).join(", ");
    throw new Error(`unknown section "${sectionId}" in doc ${doc.doc_id}; available: ${avail}`);
  }
  const ctx: MdCtx = { docId: ir.docId, preview: opts.previewLength ?? DEFAULT_PREVIEW };
  return `${sectionMarkdown(sec, ctx)}\n`;
}

// --------------------------------------------------------------------------- //
// Manifests (article_refs.jsonl / article_bib.jsonl row shapes)
// --------------------------------------------------------------------------- //

/**
 * The refs-manifest rows: section rows first (reading order), then one row
 * per float (reading order). Mirrors the skill's `article_refs.jsonl` schema.
 */
export function renderRefsManifest(doc: Document, opts: RenderOptions = {}): RefManifestRow[] {
  return buildDocIr(doc, opts).refsManifest;
}

/** The bib-manifest rows, one per reference (the skill's `article_bib.jsonl`). */
export function renderBibManifest(doc: Document): BibManifestRow[] {
  return buildDocIr(doc).bib;
}
