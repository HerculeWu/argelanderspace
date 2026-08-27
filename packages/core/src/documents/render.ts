/**
 * LLM-friendly markdown renderer + agent manifests (Stage 2 / MS1; design
 * decisions 4, 5 and 8 in `.kimi-code/memory/2026-08-27-stage2-design.md`).
 *
 * `renderDocMarkdown` / `renderSectionMarkdown` walk the section tree and
 * emit compact markdown in the token style of the read-paper skill's
 * `article_llm.md`:
 * - `[[cite:ref-1;ref-2]]` → one bracket per ref:
 *   `[cite: ref-1 | Bok 1934 | title: …]` (title segment only when the
 *   reference carries one); unresolved sites → `[cite: ? | unresolved]`.
 * - `[[xref:fig-3]]` → `[ref: fig-3 | figure | number: 3 | <caption excerpt>]`;
 *   the pipeline's unresolved marker (`[[xref:figure-9?]]` / `[[xref:?]]`) →
 *   `[ref: figure-9 | unresolved]` / `[ref: ? | unresolved]`.
 * - Figures/tables render as `[Figure omitted | id: … | number: … |
 *   caption: … | path: /images/<doc_id>/<img>]` placeholder lines; equations
 *   as display `$$…$$` plus a `[ref: …]` anchor line; code/algorithms as a
 *   `[ref: …]` anchor line plus a fenced body.
 *
 * `renderRefsManifest` / `renderBibManifest` produce the row objects behind
 * the skill's `article_refs.jsonl` / `article_bib.jsonl` (the CLI serializes
 * them as JSONL). Everything is a pure, deterministic function of the doc —
 * this module is the seed of the Stage 3 shared render pipeline.
 */

import type {
  AlgorithmBlock,
  Block,
  CodeBlock,
  Document,
  EquationBlock,
  FigureBlock,
  Reference,
  Section,
  TableBlock,
} from "@argelanderspace/contracts";
import { displayAuthors } from "../library/store.js";
import { stripTokens } from "./tokens.js";
import { iterSections } from "./traverse.js";

const CITE_TOKEN_G = /\[\[cite:([^\]]+)\]\]/gu;
const XREF_TOKEN_G = /\[\[xref:([^\]]+)\]\]/gu;

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

export interface RenderOptions {
  /** Max chars of an inline `[ref: …]` preview / manifest `short` (default 80). */
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

interface RenderCtx {
  doc: Document;
  floats: Map<string, FloatBlock>;
  sections: Map<string, Section>;
  refs: Map<string, Reference>;
  preview: number;
}

function buildCtx(doc: Document, opts: RenderOptions): RenderCtx {
  const floats = new Map<string, FloatBlock>();
  const sections = new Map<string, Section>();
  for (const s of iterSections(doc)) {
    sections.set(s.id, s);
    for (const b of s.blocks ?? []) {
      if (isFloat(b)) floats.set(b.id, b);
    }
  }
  const refs = new Map((doc.references ?? []).map((r) => [r.id, r]));
  return { doc, floats, sections, refs, preview: opts.previewLength ?? DEFAULT_PREVIEW };
}

// --------------------------------------------------------------------------- //
// Inline tokens
// --------------------------------------------------------------------------- //

function renderCite(inner: string, ctx: RenderCtx): string {
  return inner
    .split(";")
    .map((raw) => raw.trim())
    .map((id) => {
      if (id === "" || id === "?") return "[cite: ? | unresolved]";
      const ref = ctx.refs.get(id);
      if (ref === undefined) return `[cite: ${san(id)} | unresolved]`;
      const parts = [san(id), san(citeShort(ref))];
      if (ref.title !== undefined && ref.title !== "") parts.push(`title: ${san(ref.title)}`);
      return `[cite: ${parts.join(" | ")}]`;
    })
    .join("");
}

/** The preview segment of a resolved float xref (latex / caption excerpt). */
function floatPreview(b: FloatBlock, ctx: RenderCtx): string {
  // previews are plain text: nested brackets would corrupt the token
  return b.type === "equation"
    ? truncate(san(b.latex), ctx.preview)
    : truncate(san(stripTokens(b.caption?.text ?? "")), ctx.preview);
}

function renderXref(inner: string, ctx: RenderCtx): string {
  // unresolved targets carry a trailing "?" ([[xref:figure-9?]] / [[xref:?]]);
  // strip it — the `unresolved` segment already says so
  const id = inner.endsWith("?") ? inner.slice(0, -1) : inner;
  if (id === "") return "[ref: ? | unresolved]";
  const float = ctx.floats.get(id);
  if (float !== undefined) {
    const parts = [san(id), float.type];
    if (float.number !== undefined) parts.push(`number: ${san(float.number)}`);
    const preview = floatPreview(float, ctx);
    if (preview !== "") parts.push(preview);
    return `[ref: ${parts.join(" | ")}]`;
  }
  const sec = ctx.sections.get(id);
  if (sec !== undefined) {
    const parts = [san(id), "section"];
    if (sec.number !== undefined) parts.push(`number: ${san(sec.number)}`);
    if (sec.heading !== undefined) parts.push(san(sec.heading));
    return `[ref: ${parts.join(" | ")}]`;
  }
  return `[ref: ${san(id)} | unresolved]`;
}

function inline(text: string, ctx: RenderCtx): string {
  return text
    .replace(CITE_TOKEN_G, (_m, inner: string) => renderCite(inner, ctx))
    .replace(XREF_TOKEN_G, (_m, inner: string) => renderXref(inner, ctx));
}

/** Convert every inline token in *text* (standalone helper; doc-wide lookup). */
export function renderInlineText(text: string, doc: Document): string {
  return inline(text, buildCtx(doc, {}));
}

// --------------------------------------------------------------------------- //
// Blocks / sections → markdown
// --------------------------------------------------------------------------- //

function floatPlaceholder(
  name: "Figure" | "Table",
  b: FigureBlock | TableBlock,
  ctx: RenderCtx
): string {
  const parts = [`${name} omitted`, `id: ${san(b.id)}`];
  if (b.number !== undefined) parts.push(`number: ${san(b.number)}`);
  // full caption (agents need it); plain text, tokens stripped (previews only —
  // the token-expanded caption is in the refs manifest `content`)
  const caption = san(stripTokens(b.caption?.text ?? ""));
  if (caption !== "") parts.push(`caption: ${caption}`);
  if (b.img_path !== undefined) parts.push(`path: /images/${ctx.doc.doc_id}/${b.img_path}`);
  return `[${parts.join(" | ")}]`;
}

/** The `[ref: …]` anchor line that marks where a float lives in the text. */
function anchorLine(b: FloatBlock, preview: string): string {
  const parts = [`[ref: ${san(b.id)}`, b.type];
  if (b.number !== undefined) parts.push(`number: ${san(b.number)}`);
  if (preview !== "") parts.push(preview);
  return `${parts.join(" | ")}]`;
}

function blockMarkdown(b: Block, ctx: RenderCtx): string {
  switch (b.type) {
    case "paragraph":
      return inline(b.text, ctx);
    case "list":
      return b.items
        .map((it, i) => `${b.ordered ? `${i + 1}.` : "-"} ${inline(it.text, ctx)}`)
        .join("\n");
    case "figure":
      return floatPlaceholder("Figure", b, ctx);
    case "table":
      return floatPlaceholder("Table", b, ctx);
    case "equation":
      return `$$\n${b.latex}\n$$\n${anchorLine(b, truncate(san(b.latex), ctx.preview))}`;
    case "code":
    case "algorithm": {
      const lines = [anchorLine(b, floatPreview(b, ctx))];
      if (b.body !== undefined && b.body !== "") {
        const lang = b.type === "code" ? (b.lang ?? "") : "";
        lines.push(`\`\`\`${lang}\n${b.body}\n\`\`\``);
      }
      return lines.join("\n");
    }
  }
}

function sectionMarkdown(s: Section, ctx: RenderCtx): string {
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
  for (const b of s.blocks ?? []) parts.push(blockMarkdown(b, ctx));
  for (const c of s.children ?? []) parts.push(sectionMarkdown(c, ctx));
  return parts.join("\n\n");
}

/** The whole document body as LLM-friendly markdown (no doc-level header). */
export function renderDocMarkdown(doc: Document, opts: RenderOptions = {}): string {
  const ctx = buildCtx(doc, opts);
  return `${(doc.structure ?? []).map((s) => sectionMarkdown(s, ctx)).join("\n\n")}\n`;
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
  const ctx = buildCtx(doc, opts);
  const sec = ctx.sections.get(sectionId);
  if (sec === undefined) {
    const avail = [...ctx.sections.keys()].join(", ");
    throw new Error(`unknown section "${sectionId}" in doc ${doc.doc_id}; available: ${avail}`);
  }
  return `${sectionMarkdown(sec, ctx)}\n`;
}

// --------------------------------------------------------------------------- //
// Manifests (article_refs.jsonl / article_bib.jsonl row shapes)
// --------------------------------------------------------------------------- //

export interface RefManifestRow {
  id: string;
  kind: "figure" | "table" | "equation" | "code" | "algorithm" | "section";
  number?: string;
  /** Full latex (equations) / token-expanded caption (floats) / heading (sections). */
  content: string;
  /** Truncated preview of content. */
  short: string;
  /** Containing section as `"2:Introduction"` (or just the heading). */
  section: string;
  /** Nearest paragraph/list text before the float (reading order). */
  context_before?: string;
  /** Nearest paragraph/list text after the float (reading order). */
  context_after?: string;
}

export interface BibManifestRow {
  id: string;
  /** `"Belokurov et al. 2006"`. */
  short: string;
  title?: string;
  /** Family names, `", "`-joined. */
  author?: string;
  year?: number;
  venue?: string;
  doi?: string;
  arxiv_id?: string;
  /** The raw bibliography entry text. */
  raw: string;
}

function floatContent(b: FloatBlock, ctx: RenderCtx): string {
  return b.type === "equation"
    ? b.latex
    : b.caption !== undefined
      ? inline(b.caption.text, ctx)
      : "";
}

function sectionLabel(s: Section): string {
  return s.number !== undefined ? `${s.number}:${s.heading ?? ""}` : (s.heading ?? "");
}

/**
 * The refs-manifest rows: section rows first (reading order), then one row
 * per float (reading order). Mirrors the skill's `article_refs.jsonl` schema.
 */
export function renderRefsManifest(doc: Document, opts: RenderOptions = {}): RefManifestRow[] {
  const ctx = buildCtx(doc, opts);
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
      if (b.type === "paragraph") return truncate(inline(b.text, ctx), CONTEXT_LEN);
      if (b.type === "list") {
        return truncate(inline(b.items.map((it) => it.text).join(" "), ctx), CONTEXT_LEN);
      }
    }
    return undefined;
  };
  flat.forEach(({ block: b, section }, i) => {
    if (!isFloat(b)) return;
    const content = floatContent(b, ctx);
    const row: RefManifestRow = {
      id: b.id,
      kind: b.type,
      content,
      short: truncate(content, ctx.preview),
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
export function renderBibManifest(doc: Document): BibManifestRow[] {
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
