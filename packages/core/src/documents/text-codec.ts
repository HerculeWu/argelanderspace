/**
 * The `argelander-text` v1 codec: complete readable Markdown in, shared IR out.
 *
 * Understood: ATX headings (the section tree, with a fixed preface section before the first heading), paragraphs and
 * single-level lists with emphasis/code spans reduced to their text; inline `$..$` and display `$$..$$` math;
 * fenced code and algorithms; `[cite: ..]` and `[ref: ..]`; and the three marker blocks `argelander-document`
 * (identity), `argelander-block` (id, printed number, label, caption of the NEXT block) and `argelander-references`
 * (the complete bibliography, last in the text). Not yet understood (figures, tables: ticket 27): reported with a
 * located, construct-specific diagnostic, never dropped. The parser is the one truth for the page, the HTTP routes and
 * the agent; there is no second parser in the browser.
 *
 * Lexing is `marked`'s (a declared dependency); the pre-pass that protects math and cite/ref tokens from it is
 * `text-scan.ts`. Everything here is pure: no file access, no knowledge of annotations.
 */

import { createHash } from "node:crypto";
import {
  findMacroCommand,
  type IrBlock,
  type IrSection,
  type IrSegment,
  type IrXrefTargetType,
  type Reference,
  TEXT_ASSET_NAME_PATTERN,
  TEXT_INPUT_VERSION,
  TEXT_IR_VERSION,
  TEXT_TABLE_MAX_CELLS,
  TEXT_TABLE_MAX_COLS,
  TEXT_TABLE_MAX_ROWS,
  type TextBlockMeta,
  TextBlockMetaSchema,
  type TextDiagnostic,
  type TextDocIr,
  TextDocumentMetaSchema,
  TextReferencesSchema,
  type TextSourceAsset,
  type TextStats,
  TextTableSchema,
} from "@argelanderspace/contracts";
import { Lexer, type Token, type Tokens } from "marked";
import {
  bibManifest,
  buildTargetLookup,
  fillXrefPreviews,
  refsManifest,
} from "../pipelines/tex/ir.js";
import { citeShort } from "./render.js";
import { formatJsonPath, parseLocatedJson } from "./text-json.js";
import { checkFormula } from "./text-math.js";
import { type DisplayMath, type Item, PLACEHOLDER_RUN, scanSyntax } from "./text-scan.js";

export interface TextParseOptions {
  docId: string;
  sourceRev: number;
  /** Used when the text has no title (no `argelander-document` title, no level-1 heading). */
  fallbackTitle?: string;
  /** The registered image assets of the source (ticket 27): a figure may only name one of these. */
  assets?: readonly TextSourceAsset[];
}

export interface TextParseResult {
  /** Present only when no error diagnostic was found. */
  ir: TextDocIr | null;
  diagnostics: TextDiagnostic[];
  stats: TextStats;
}

/**
 * sha256 of the generating source: the Markdown's UTF-8 bytes and, for the images the text actually references, their
 * names and content hashes (so a changed image is a changed source). Without referenced assets this is the plain
 * Markdown hash, as it was before figures existed.
 */
export function textSourceFingerprint(
  markdown: string,
  referenced: readonly Pick<TextSourceAsset, "name" | "sha256">[] = []
): string {
  const hash = createHash("sha256").update(markdown, "utf8");
  if (referenced.length > 0) {
    const sorted = [...referenced].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    hash.update("\0argelander-assets\0");
    for (const a of sorted) hash.update(`${a.name}\0${a.sha256}\n`);
  }
  return hash.digest("hex");
}

/**
 * Offsets (in the newline-normalized text the lexer sees) at which a line starts, counted the way the source editor
 * counts: only `\n` (and the `\n` of a CRLF) breaks a line. A lone `\r` is an ordinary character of its line, even
 * though the lexer treats it as a break. Built once per parse.
 */
function lineStartsOf(markdown: string): number[] {
  const starts = [0];
  let crlf = 0; // each CRLF is one character shorter in the normalized text
  for (const m of markdown.matchAll(/\r\n|\r|\n/g)) {
    if (m[0] === "\r") continue;
    if (m[0] === "\r\n") crlf += 1;
    starts.push((m.index ?? 0) - (m[0] === "\r\n" ? crlf - 1 : crlf) + 1);
  }
  return starts;
}

/** Position of an offset, 1-based: a binary search over the line starts. */
function locate(starts: number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((starts[mid] as number) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (starts[low] as number) + 1 };
}

/** The most diagnostics a result carries in full; the rest are only counted (bounds the work for huge sources). */
const MAX_DIAGNOSTICS = 200;
/** Formulas KaTeX-checked per document (bounds the time); the rest are reported as not checked. */
const MAX_MATH_CHECKS = 3000;
/** One formula over this many characters is not checked (KaTeX time grows faster than its size). */
const MAX_MATH_CHARS = 10_000;
/** Characters of formulas checked per document, and the wall-clock budget of the whole checking pass. */
const MAX_MATH_TOTAL_CHARS = 400_000;
const MAX_MATH_MS = 1500;

/** Diagnostic code and English message per unsupported construct; the page shows its own localized text per code. */
const UNSUPPORTED: Record<string, { code: string; message: string }> = {
  blockquote: {
    code: "quote_unsupported",
    message: "block quotes are not supported; rewrite it as a plain paragraph",
  },
  hr: {
    code: "rule_unsupported",
    message: "horizontal rules are not supported; remove it or start a new heading",
  },
  html: { code: "html_unsupported", message: "raw HTML is not allowed in a text document" },
  def: { code: "definition_unsupported", message: "link reference definitions are not supported" },
  image: {
    code: "image_inline",
    message:
      "an image must stand alone in its own paragraph (![alt](assets/name.png)); it cannot be inside a heading, a list item or a sentence",
  },
  link: {
    code: "link_unsupported",
    message: "links are not supported yet; write the address as plain text",
  },
  del: {
    code: "strike_unsupported",
    message: "strikethrough is not supported; remove the markers",
  },
};
const UNKNOWN = (type: string) => ({
  code: "syntax_unsupported",
  message: `the syntax "${type}" is not supported`,
});

/** Setext-style headings (`Title` over `====`) are not ATX; marked reports them as headings too, so check the raw. */
function isAtxHeading(raw: string): boolean {
  return /^ {0,3}#{1,6}(?:\s|$)/.test(raw);
}

type Target =
  | "section"
  | "paragraph"
  | "list"
  | "equation"
  | "code"
  | "algorithm"
  | "figure"
  | "table";

/** Which `argelander-block` fields apply to which block. `footnote` belongs to figures/tables only. */
const ALLOWED_FIELDS: Record<Target, readonly (keyof TextBlockMeta)[]> = {
  section: ["id", "kind", "number"],
  paragraph: ["id", "kind"],
  list: ["id", "kind"],
  equation: ["id", "kind", "number", "label"],
  code: ["id", "kind", "number", "label", "caption"],
  algorithm: ["id", "kind", "number", "label", "caption"],
  figure: ["id", "kind", "number", "label", "caption", "footnote"],
  table: ["id", "kind", "number", "label", "caption", "footnote"],
};
const ID_PREFIX: Record<Target, string> = {
  section: "sec",
  paragraph: "p",
  list: "l",
  equation: "eq",
  code: "code",
  algorithm: "alg",
  figure: "fig",
  table: "tab",
};
/** Structure ids the codec itself owns. */
const RESERVED_IDS = new Set(["sec-preface"]);
/** The Reader anchors annotations as `ann-<id>` in the same DOM id space, so an explicit structure id cannot start so. */
const ANNOTATION_ID_PREFIX = "ann-";
/** Names every plain object already has (`constructor`, `__proto__`, `toString`...): never a block id. */
const PROTO_NAMES = new Set(Object.getOwnPropertyNames(Object.prototype));

interface Located {
  base: number;
  offsetOf: (path: readonly (string | number)[]) => number | undefined;
}

interface Ctx {
  text: string;
  lineStarts: number[];
  diagnostics: TextDiagnostic[];
  /** How many diagnostics were found, including those beyond {@link MAX_DIAGNOSTICS} that are not stored. */
  total: number;
  errors: number;
  hiddenErrors: number;
  mathChecks: number;
  mathChars: number;
  mathStartedAt: number;
  mathUnchecked: number;
}

interface ReportOptions {
  severity?: "error" | "warning";
  field?: string;
  subject?: string;
}

function report(
  ctx: Ctx,
  at: number | undefined,
  code: string,
  message: string,
  options: ReportOptions = {}
): void {
  const severity = options.severity ?? "error";
  ctx.total += 1;
  if (severity === "error") ctx.errors += 1;
  if (ctx.diagnostics.length >= MAX_DIAGNOSTICS) {
    if (severity === "error") ctx.hiddenErrors += 1;
    return;
  }
  const diagnostic: TextDiagnostic = { code, severity, message };
  if (at !== undefined) {
    const { line, column } = locate(ctx.lineStarts, at);
    diagnostic.line = line;
    diagnostic.column = column;
  }
  if (options.field !== undefined) diagnostic.field = options.field;
  if (options.subject !== undefined) diagnostic.subject = options.subject;
  ctx.diagnostics.push(diagnostic);
}

function reportSyntax(ctx: Ctx, at: number, type: string): void {
  const entry = UNSUPPORTED[type] ?? UNKNOWN(type);
  report(ctx, at, entry.code, entry.message);
}

// --------------------------------------------------------------------------- //
// Inline pieces → segments
// --------------------------------------------------------------------------- //

type Piece = { t: "text"; s: string } | { t: "item"; item: Item };

interface CiteUse {
  item: Item;
  seg: Extract<IrSegment, { type: "cite" }>;
  owner: IrBlock | null;
}
interface RefUse {
  item: Item;
  seg: Extract<IrSegment, { type: "xref" }>;
}

interface Walk extends Ctx {
  items: Item[];
  nextItem: number;
  /** Offset of the first token where a placeholder run found no matching find (a scanner/lexer disagreement). */
  misalignedAt: number | undefined;
  currentAt: number;
  cites: CiteUse[];
  refs: RefUse[];
  inlineMath: number;
}

/** Replace the placeholder runs inside a lexed text with the finds they stand for. */
function splitRuns(w: Walk, s: string, out: Piece[]): void {
  let last = 0;
  for (const m of s.matchAll(PLACEHOLDER_RUN)) {
    const index = m.index ?? 0;
    if (index > last) out.push({ t: "text", s: s.slice(last, index) });
    last = index + m[0].length;
    const item = w.items[w.nextItem];
    w.nextItem += 1;
    if (item === undefined || item.end - item.start !== m[0].length) {
      w.misalignedAt ??= w.currentAt;
      continue;
    }
    out.push({ t: "item", item });
  }
  if (last < s.length) out.push({ t: "text", s: s.slice(last) });
}

/** Inline tokens → pieces; unsupported inline syntax is reported at the enclosing block's start. */
function inlinePieces(w: Walk, at: number, tokens: Token[] | undefined, out: Piece[]): void {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text": {
        const inner = (token as Tokens.Text).tokens;
        if (inner !== undefined && inner.length > 0) inlinePieces(w, at, inner, out);
        else splitRuns(w, (token as Tokens.Text).text, out);
        break;
      }
      case "escape":
      case "codespan":
        out.push({ t: "text", s: (token as Tokens.Text).text });
        break;
      case "br":
        out.push({ t: "text", s: " " });
        break;
      case "link": {
        // A bare URL / e-mail / <angle> autolink is what the user typed as plain text: keep the exact characters.
        // An explicit [text](url) link stays unsupported.
        const link = token as Tokens.Link;
        if (link.raw.startsWith("[")) reportSyntax(w, at, "link");
        else out.push({ t: "text", s: link.raw });
        break;
      }
      case "em":
      case "strong":
        inlinePieces(w, at, (token as Tokens.Em).tokens, out);
        break;
      default:
        reportSyntax(w, at, token.type);
        break;
    }
  }
}

const squeeze = (s: string): string => s.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ");

/** Merge neighbouring text, collapse soft breaks to a space, trim the block's two ends. */
function mergedPieces(pieces: Piece[]): Piece[] {
  const merged: Piece[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if (p.t === "text" && prev?.t === "text") prev.s += p.s;
    else merged.push(p.t === "text" ? { t: "text", s: p.s } : p);
  }
  for (const p of merged) if (p.t === "text") p.s = squeeze(p.s);
  const first = merged[0];
  if (first?.t === "text") first.s = first.s.trimStart();
  const last = merged[merged.length - 1];
  if (last?.t === "text") last.s = last.s.trimEnd();
  return merged.filter((p) => p.t !== "text" || p.s !== "");
}

function toSegments(w: Walk, pieces: Piece[], owner: IrBlock | null): IrSegment[] {
  const segments: IrSegment[] = [];
  for (const p of mergedPieces(pieces)) {
    if (p.t === "text") {
      segments.push({ type: "text", text: p.s });
      continue;
    }
    const item = p.item;
    if (item.bad || item.kind === "display") continue;
    if (item.kind === "math") {
      w.inlineMath += 1;
      segments.push({ type: "math", latex: item.latex as string });
    } else if (item.kind === "cite") {
      const seg: CiteUse["seg"] = {
        type: "cite",
        refs: (item.ids as string[]).map((id) => ({ id, resolved: false })),
        ...(item.display !== undefined ? { raw: item.display } : {}),
      };
      w.cites.push({ item, seg, owner });
      segments.push(seg);
    } else {
      const seg: RefUse["seg"] = {
        type: "xref",
        target: { id: (item.ids as string[])[0] as string, resolved: false },
        ...(item.display !== undefined ? { raw: item.display } : {}),
      };
      w.refs.push({ item, seg });
      segments.push(seg);
    }
  }
  return segments;
}

/** A heading is a clean string: math stays `$..$` (the Reader's heading display renders it); cite/ref cannot live there. */
function headingText(w: Walk, at: number, pieces: Piece[]): string {
  let out = "";
  for (const p of mergedPieces(pieces)) {
    if (p.t === "text") {
      if (p.s.includes("$"))
        report(
          w,
          at,
          "heading_dollar",
          "a literal $ in a heading can be shown as part of a formula",
          { severity: "warning" }
        );
      out += p.s;
    } else if (p.item.kind === "math") {
      out += `$${p.item.latex}$`;
    } else if (p.item.kind === "display") {
      if (!p.item.bad)
        report(
          w,
          p.item.start,
          "math_display_in_heading",
          "a display equation cannot be inside a heading; use $...$ or put it in its own block"
        );
    } else {
      report(
        w,
        p.item.start,
        "heading_token_unsupported",
        "[cite: ...] and [ref: ...] cannot be used inside a heading; put them in a paragraph"
      );
    }
  }
  return out.trim();
}

function checkMath(w: Walk, latex: string, display: boolean, at: number): void {
  // Macro definitions are not typeset by the Reader either (see contracts math.ts): refused here, before any budget
  const macro = findMacroCommand(latex);
  if (macro !== null) {
    report(
      w,
      at,
      "math_macro_unsupported",
      `${macro} defines or builds a macro, which formulas of a text document cannot do; write the expanded formula`,
      { subject: macro }
    );
    return;
  }
  // KaTeX is synchronous and superlinear in a formula's size, and this runs on the server's event loop: bound the work
  // per formula, in total characters, in count and in time. What is not checked is said so, at its place.
  const skip = (reason: string, message: string): void => {
    if (reason === "size" || w.mathUnchecked === 0)
      report(w, at, "math_not_checked", message, { severity: "warning", subject: reason });
    if (reason !== "size") w.mathUnchecked += 1;
  };
  if (latex.length > MAX_MATH_CHARS) {
    skip(
      "size",
      `this formula is ${latex.length} characters; formulas over ${MAX_MATH_CHARS} are not checked for typesetting errors`
    );
    return;
  }
  if (w.mathStartedAt === 0) w.mathStartedAt = performance.now();
  if (
    w.mathChecks >= MAX_MATH_CHECKS ||
    w.mathChars + latex.length > MAX_MATH_TOTAL_CHARS ||
    performance.now() - w.mathStartedAt > MAX_MATH_MS
  ) {
    skip(
      "budget",
      "the budget for checking formulas is used up; this and the remaining formulas are not checked"
    );
    return;
  }
  w.mathChecks += 1;
  w.mathChars += latex.length;
  const verdict = checkFormula(latex, display);
  if (verdict.kind === "error")
    report(w, at, "math_katex", `the formula cannot be typeset: ${verdict.message}`, {
      severity: "warning",
      subject: verdict.message,
    });
  else if (verdict.kind === "trust")
    report(
      w,
      at,
      "math_untrusted_command",
      `${verdict.command} needs trust, which is off: the Reader shows this formula as red source and drops its content`,
      { severity: "warning", subject: verdict.command }
    );
}

// --------------------------------------------------------------------------- //
// Marker blocks
// --------------------------------------------------------------------------- //

interface FenceInfo {
  info: string;
  closed: boolean;
  /** The text between the fences, offsets relative to `base`. */
  inner: string;
  /** The code body: the lines between the fences without the fence's indentation. */
  body: string;
  /** Offset in the source of the first character after the opening fence line. */
  base: number;
}

/**
 * The fence of a code token, read the way the lexer reads it: a line ends at `\n` or a lone CR, the block closes on a
 * line that starts (at most 3 spaces in) with the opening run, may continue with fence characters, and ends with spaces
 * only. `raw` is the SOURCE slice, so the body keeps every byte (a lone CR included) of the lines between the fences.
 */
function fenceOf(raw: string, at: number): FenceInfo | null {
  const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n\r]*)/.exec(raw);
  if (open === null) return null;
  const run = open[1] as string;
  const spans: { start: number; end: number }[] = [];
  let from = 0;
  for (const m of raw.matchAll(/\n|\r/g)) {
    spans.push({ start: from, end: m.index ?? 0 });
    from = (m.index ?? 0) + 1;
  }
  spans.push({ start: from, end: raw.length });
  while (
    spans.length > 1 &&
    (spans[spans.length - 1] as { start: number; end: number }).start === raw.length
  )
    spans.pop();
  let closed = false;
  if (spans.length >= 2) {
    const last = spans[spans.length - 1] as { start: number; end: number };
    closed = new RegExp(`^ {0,3}${run}[~\`]* *$`).test(raw.slice(last.start, last.end));
  }
  const inner = spans.slice(1, closed ? -1 : undefined);
  const indent = (/^ */.exec(raw) as RegExpExecArray)[0].length;
  const strip = new RegExp(`^ {0,${indent}}`);
  let body = "";
  let innerText = "";
  inner.forEach((span, i) => {
    const line = raw.slice(span.start, span.end);
    const sep = i < inner.length - 1 ? raw.charAt(span.end) : "";
    body += line.replace(strip, "") + sep;
    innerText += line + sep;
  });
  const first = spans[0] as { start: number; end: number };
  return {
    info: (open[2] as string).trim(),
    closed,
    inner: innerText,
    body,
    base: at + (first.end >= raw.length ? raw.length : first.end + 1),
  };
}

/** The offset to report for a JSON path: the field itself, else its nearest existing parent. */
function whereIn(located: Located, path: readonly (string | number)[]): number {
  for (let n = path.length; n >= 0; n -= 1) {
    const offset = located.offsetOf(path.slice(0, n));
    if (offset !== undefined) return located.base + offset;
  }
  return located.base;
}

interface Issue {
  code: string;
  path: PropertyKey[];
  message: string;
  keys?: string[];
}

function reportIssues(
  w: Walk,
  issues: readonly Issue[],
  located: Located,
  codes: { unknown: string; invalid: string }
): void {
  for (const issue of issues) {
    const path = issue.path.filter((p): p is string | number => typeof p !== "symbol");
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys ?? []) {
        const full = [...path, key];
        report(
          w,
          whereIn(located, full),
          codes.unknown,
          `the field "${key}" is not part of this block`,
          {
            field: formatJsonPath(full),
            subject: key,
          }
        );
      }
    } else {
      report(
        w,
        whereIn(located, path),
        codes.invalid,
        `${formatJsonPath(path) || "the value"}: ${issue.message}`,
        {
          field: formatJsonPath(path),
        }
      );
    }
  }
}

/** JSON of a marker block: syntax errors are reported at the character they stop on. */
function parseMarker(
  w: Walk,
  fence: FenceInfo,
  at: number,
  syntaxCode: string
): { value: unknown; located: Located } | null {
  if (!fence.closed) {
    report(w, at, "fence_unclosed", "this code fence is never closed");
    return null;
  }
  const parsed = parseLocatedJson(fence.inner);
  if (!parsed.ok) {
    report(w, fence.base + parsed.offset, syntaxCode, `invalid JSON: ${parsed.message}`);
    return null;
  }
  return { value: parsed.value, located: { base: fence.base, offsetOf: parsed.offsetOf } };
}

// --------------------------------------------------------------------------- //
// Figures and tables (ticket 27)
// --------------------------------------------------------------------------- //

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );

interface ImageCheck {
  name?: string;
  code?: string;
  message?: string;
}

/** Only `assets/<controlled name>` is an image address: no URL, data URI, absolute path, traversal or odd name. */
function checkImageHref(href: string): ImageCheck {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//"))
    return {
      code: "image_remote",
      message:
        "an image cannot be a web address or a data URI; add it as an asset and write assets/<name>",
    };
  const unsafe = {
    code: "image_path_unsafe",
    message:
      "an image path must be assets/<name>; absolute paths, backslashes, '..' and escapes are not allowed",
  };
  if (href.startsWith("/") || href.includes("\\") || href.includes("%") || href.includes("\0"))
    return unsafe;
  if (href.split("/").some((seg) => seg === ".." || seg === ".")) return unsafe;
  const m = /^assets\/([^/]+)$/.exec(href);
  if (m === null || !TEXT_ASSET_NAME_PATTERN.test(m[1] as string))
    return {
      code: "image_path_invalid",
      message: "an image path must be assets/<name>, the name an asset of this document was given",
    };
  return { name: m[1] as string };
}

interface GridCell {
  html: string;
  header: boolean;
  rowspan: number;
  colspan: number;
  /** Source offset to report a problem of this cell at, and of its span fields. */
  at: number;
  spanAt: (field: "rowspan" | "colspan") => number;
}

/**
 * The cells must tile a rectangle exactly: the first row decides the width; every cell lies inside it and below the
 * last row, no two cells cover the same square, and no square stays empty. Located errors, at most 20 of them.
 */
function checkGrid(w: Walk, rows: GridCell[][]): boolean {
  const width = (rows[0] as GridCell[]).reduce((n, c) => n + c.colspan, 0);
  let bad = 0;
  const fail = (at: number, code: string, message: string, field?: string): void => {
    bad += 1;
    if (bad <= 20) report(w, at, code, message, field !== undefined ? { field } : {});
  };
  if (width > TEXT_TABLE_MAX_COLS) {
    fail(
      (rows[0] as GridCell[])[0]?.at ?? 0,
      "table_too_large",
      `the table is ${width} columns wide; at most ${TEXT_TABLE_MAX_COLS} are allowed`
    );
    return false;
  }
  const taken: Uint8Array[] = rows.map(() => new Uint8Array(width));
  rows.forEach((row, r) => {
    const badBefore = bad;
    let c = 0;
    row.forEach((cell, j) => {
      while (c < width && (taken[r] as Uint8Array)[c] === 1) c += 1;
      if (c + cell.colspan > width) {
        fail(
          cell.spanAt("colspan"),
          "table_span_bounds",
          `colspan ${cell.colspan} runs past the ${width} columns of the table`,
          `rows[${r}][${j}].colspan`
        );
        c += cell.colspan;
        return;
      }
      if (r + cell.rowspan > rows.length) {
        fail(
          cell.spanAt("rowspan"),
          "table_span_bounds",
          `rowspan ${cell.rowspan} runs past the last of the ${rows.length} rows`,
          `rows[${r}][${j}].rowspan`
        );
        c += cell.colspan;
        return;
      }
      let clash = false;
      for (let dr = 0; dr < cell.rowspan && !clash; dr += 1)
        for (let dc = 0; dc < cell.colspan; dc += 1)
          if ((taken[r + dr] as Uint8Array)[c + dc] === 1) {
            clash = true;
            break;
          }
      if (clash) {
        fail(
          cell.at,
          "table_span_overlap",
          "this cell overlaps another cell of the table",
          `rows[${r}][${j}]`
        );
      } else {
        for (let dr = 0; dr < cell.rowspan; dr += 1)
          for (let dc = 0; dc < cell.colspan; dc += 1) (taken[r + dr] as Uint8Array)[c + dc] = 1;
      }
      c += cell.colspan;
    });
    for (let k = 0; k < width; k += 1) {
      if (bad === badBefore && (taken[r] as Uint8Array)[k] !== 1) {
        fail(
          row[0]?.at ?? 0,
          "table_row_incomplete",
          `row ${r + 1} does not fill the ${width} columns of the table (column ${k + 1} is empty)`,
          `rows[${r}]`
        );
        break;
      }
    }
  });
  if (bad > 20)
    report(
      w,
      undefined,
      "table_more_problems",
      `${bad - 20} more problems in the table grid are not shown`,
      {
        severity: "warning",
      }
    );
  return bad === 0;
}

/** The limited table markup of the pipeline: `<table><tr><th|td [rowspan] [colspan]>text</..></tr></table>`. */
function tableHtmlOf(rows: GridCell[][]): string {
  let html = "<table>";
  for (const row of rows) {
    html += "<tr>";
    for (const c of row) {
      const tag = c.header ? "th" : "td";
      html += `<${tag}${c.rowspan > 1 ? ` rowspan="${c.rowspan}"` : ""}${c.colspan > 1 ? ` colspan="${c.colspan}"` : ""}>${c.html}</${tag}>`;
    }
    html += "</tr>";
  }
  return `${html}</table>`;
}

/**
 * The cells of one GFM table row exactly as `marked` splits them (its `splitCells`): a pipe is a separator unless an ODD
 * run of backslashes precedes it, a first and a last cell that are only blank are dropped. The count must be this one, not
 * a look-alike: a row with more cells than the header silently loses the extras inside the lexer. `starts` are the
 * offsets (within the line) where each cell's text starts, for locating a problem at its cell.
 */
function gfmRowCells(line: string): { count: number; starts: number[] } {
  const cuts: number[] = [];
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== "|") continue;
    let escaped = false;
    for (let a = i - 1; a >= 0 && line[a] === "\\"; a -= 1) escaped = !escaped;
    if (!escaped) cuts.push(i);
  }
  const segs: { start: number; end: number }[] = [];
  let from = 0;
  for (const cut of cuts) {
    segs.push({ start: from, end: cut });
    from = cut + 1;
  }
  segs.push({ start: from, end: line.length });
  if (segs.length > 0 && line.slice(segs[0]?.start, segs[0]?.end).trim() === "") segs.shift();
  const last = segs[segs.length - 1];
  if (last !== undefined && line.slice(last.start, last.end).trim() === "") segs.pop();
  const starts = segs.map((seg) => {
    let at = seg.start;
    while (at < seg.end && /\s/.test(line.charAt(at))) at += 1;
    return at;
  });
  return { count: segs.length, starts };
}

// --------------------------------------------------------------------------- //
// The parser
// --------------------------------------------------------------------------- //

interface PendingMeta {
  fields: TextBlockMeta;
  at: number;
  located: Located;
}

interface Entry {
  prefix: string;
  target: Target;
  explicit?: { id: string; at: number };
  node: { id: string };
  /** Section / block data the cross-reference resolver needs. */
  number?: string;
}

const SCAN_MISMATCH =
  "a formula or reference token here could not be placed: the scanner and the Markdown reader disagree about the structure around it (for example a code fence); rewrite that part";
const EMPTY_STATS: TextStats = { sections: 0, paragraphs: 0, lists: 0 };

export function parseTextSource(markdown: string, options: TextParseOptions): TextParseResult {
  // CRLF is one line break (and one character shorter for the lexer); a lone CR stays in the text byte for byte (it is an
  // ordinary character of its line for the editor and for code bodies; the lexer reads it as a break of the same length).
  const text = markdown.replace(/\r\n/g, "\n");
  const w: Walk = {
    text,
    lineStarts: lineStartsOf(markdown),
    diagnostics: [],
    total: 0,
    errors: 0,
    hiddenErrors: 0,
    mathChecks: 0,
    mathChars: 0,
    mathStartedAt: 0,
    mathUnchecked: 0,
    items: [],
    nextItem: 0,
    misalignedAt: undefined,
    currentAt: 0,
    cites: [],
    refs: [],
    inlineMath: 0,
  };

  // the three placeholder characters are ours; a source that already uses them cannot be scanned safely
  for (const m of text.matchAll(/[-]/g))
    report(
      w,
      m.index ?? 0,
      "reserved_character",
      "the private-use characters U+E000 to U+E002 are reserved by the text format",
      { subject: `U+${(m[0].codePointAt(0) as number).toString(16).toUpperCase()}` }
    );
  if (w.errors > 0) return finish(w, null, EMPTY_STATS);

  const scan = scanSyntax(text, { blockDisplay: true });
  w.items = scan.items;
  for (const p of scan.problems)
    report(w, p.offset, p.code, p.message, {
      ...(p.subject ? { subject: p.subject } : {}),
      ...(p.severity ? { severity: p.severity } : {}),
    });
  for (const item of scan.items) {
    if (item.bad) continue;
    if (item.kind === "math") checkMath(w, item.latex as string, false, item.start);
    else if (item.kind === "display") checkMath(w, item.latex as string, true, item.start);
  }
  for (const d of scan.displays) checkMath(w, d.latex, true, d.start);

  const tokens = Lexer.lex(scan.lexText);

  const root: IrSection[] = [];
  const stack: IrSection[] = [];
  const entries: Entry[] = [];
  let sectionCount = 0;
  let paragraphCount = 0;
  let listCount = 0;
  let equationCount = 0;
  let codeCount = 0;
  let figureCount = 0;
  let tableCount = 0;
  const assetByName = new Map<string, TextSourceAsset>();
  for (const a of options.assets ?? []) assetByName.set(a.name, a);
  const referencedAssets = new Map<string, TextSourceAsset>();
  let preface: IrSection | null = null;
  let firstH1: string | undefined;
  let docMeta: ReturnType<typeof TextDocumentMetaSchema.parse> | undefined;
  let sawDocMeta = false;
  let sawContent = false;
  let references: Reference[] | undefined;
  let referencesAt = -1;
  let referenceAts: number[] = [];
  let pending: PendingMeta | null = null;
  let displayIndex = 0;
  let offset = 0;

  const currentBlocks = (): IrBlock[] => {
    const top = stack[stack.length - 1];
    if (top) return top.blocks;
    if (!preface) {
      // text before the first heading lives in a fixed, heading-less preface section
      preface = { id: "sec-preface", level: 1, blocks: [], children: [] };
      root.push(preface);
    }
    return preface.blocks;
  };

  /** Consume the pending `argelander-block` for a block of kind `target`; validates which fields may apply. */
  const takeMeta = (target: Target): TextBlockMeta => {
    const meta = pending;
    pending = null;
    if (meta === null) return {};
    const fields = meta.fields;
    const allowed = ALLOWED_FIELDS[target];
    for (const key of Object.keys(fields) as (keyof TextBlockMeta)[]) {
      if (key === "kind") continue;
      if (!allowed.includes(key)) {
        report(
          w,
          whereIn(meta.located, [key]),
          "block_meta_field",
          key === "footnote"
            ? "footnote belongs to figures and tables only"
            : `the field "${key}" does not apply to this block`,
          { field: key, subject: key }
        );
      }
    }
    if (fields.kind !== undefined) {
      const fine =
        target === "code" || target === "algorithm"
          ? fields.kind === "code" || fields.kind === "algorithm"
          : fields.kind === target;
      if (!fine)
        report(
          w,
          whereIn(meta.located, ["kind"]),
          "block_meta_kind",
          `kind "${fields.kind}" does not match the block that follows`,
          {
            field: "kind",
            subject: fields.kind,
          }
        );
    }
    return fields;
  };

  const captionOf = (
    caption: string | undefined,
    located: Located | null,
    owner: IrBlock,
    field: "caption" | "footnote" = "caption"
  ): IrSegment[] | undefined => {
    if (caption === undefined) return undefined;
    const where = located === null ? 0 : whereIn(located, [field]);
    const sub = scanSyntax(caption, { blockDisplay: false });
    for (const p of sub.problems)
      report(w, where, p.code, p.message, {
        ...(p.subject ? { subject: p.subject } : {}),
        ...(p.severity ? { severity: p.severity } : {}),
      });
    const pieces: Piece[] = [];
    let at = 0;
    for (const item of sub.items) {
      if (item.start > at) pieces.push({ t: "text", s: caption.slice(at, item.start) });
      item.where = where;
      if (item.kind === "math" && !item.bad) checkMath(w, item.latex as string, false, where);
      pieces.push({ t: "item", item });
      at = item.end;
    }
    if (at < caption.length) pieces.push({ t: "text", s: caption.slice(at) });
    return toSegments(w, pieces, owner);
  };

  const register = (
    target: Target,
    node: { id: string },
    meta: TextBlockMeta,
    at: number,
    number?: string
  ): void => {
    const entry: Entry = { prefix: ID_PREFIX[target], target, node };
    if (meta.id !== undefined) entry.explicit = { id: meta.id, at };
    if (number !== undefined) entry.number = number;
    entries.push(entry);
  };

  /** Last diagnostic position of the pending block's id field, kept with the registration. */
  const idAt = (meta: PendingMeta | null): number =>
    meta === null ? 0 : whereIn(meta.located, ["id"]);

  const emitEquation = (d: DisplayMath): void => {
    const metaState = pending;
    const fields = takeMeta("equation");
    sawContent = true;
    equationCount += 1;
    const block: IrBlock = {
      id: "",
      type: "equation",
      latex: d.latex,
      ...(fields.number !== undefined ? { number: fields.number } : {}),
      ...(fields.label !== undefined ? { label: fields.label } : {}),
    };
    currentBlocks().push(block);
    register("equation", block, fields, idAt(metaState), fields.number);
  };

  /** Cell text → pieces, reading `$..$` math like a caption; anything else a cell cannot hold is a located error. */
  const cellHtmlOf = (pieces: Piece[]): string => {
    let out = "";
    for (const p of mergedPieces(pieces)) {
      if (p.t === "text") {
        // The Reader typesets `$..$` inside a cell's text node; a literal dollar sits in a node of its own so that
        // it can never pair with another one into a formula.
        out += escapeHtml(p.s).replace(/\$/g, "<span>$</span>");
      } else if (p.item.bad) continue;
      else if (p.item.kind === "math") {
        if ((p.item.latex as string).includes("$"))
          report(
            w,
            p.item.where,
            "table_math_dollar",
            "a formula in a table cell cannot contain a $ (the cell text is read for $...$ again); move it out of the table"
          );
        else out += `$${escapeHtml(p.item.latex as string)}$`;
      } else if (p.item.kind === "display")
        report(
          w,
          p.item.where,
          "math_display_in_table",
          "a display equation cannot be inside a table cell; use $...$"
        );
      else
        report(
          w,
          p.item.where,
          "table_token_unsupported",
          "[cite: ...] and [ref: ...] cannot be used inside a table cell; put them in the caption or a paragraph"
        );
    }
    return out;
  };

  const cellFromText = (text: string, where: number): string => {
    const sub = scanSyntax(text, { blockDisplay: false });
    for (const prob of sub.problems)
      report(w, where, prob.code, prob.message, {
        ...(prob.subject ? { subject: prob.subject } : {}),
        ...(prob.severity ? { severity: prob.severity } : {}),
      });
    const pieces: Piece[] = [];
    let last = 0;
    for (const item of sub.items) {
      if (item.start > last) pieces.push({ t: "text", s: text.slice(last, item.start) });
      item.where = where;
      if (item.kind === "math" && !item.bad) checkMath(w, item.latex as string, false, where);
      pieces.push({ t: "item", item });
      last = item.end;
    }
    if (last < text.length) pieces.push({ t: "text", s: text.slice(last) });
    // `\$` is a literal dollar: the backslash is the escape, not part of the text
    for (const piece of pieces) if (piece.t === "text") piece.s = piece.s.replace(/\\\$/g, "$");
    return cellHtmlOf(pieces);
  };

  const emitTable = (html: string, metaState: PendingMeta | null): void => {
    const fields = takeMeta("table");
    sawContent = true;
    tableCount += 1;
    const block: IrBlock = {
      id: "",
      type: "table",
      tableBody: html,
      ...(fields.number !== undefined ? { number: fields.number } : {}),
      ...(fields.label !== undefined ? { label: fields.label } : {}),
      ...(fields.footnote !== undefined ? { footnote: fields.footnote } : {}),
    };
    if (fields.caption !== undefined) {
      const segs = captionOf(fields.caption, metaState?.located ?? null, block);
      if (segs !== undefined && segs.length > 0) block.captionSegments = segs;
    }
    if (fields.footnote !== undefined) {
      const segs = captionOf(fields.footnote, metaState?.located ?? null, block, "footnote");
      if (segs !== undefined && segs.length > 0 && block.type === "table")
        block.footnoteSegments = segs;
    }
    currentBlocks().push(block);
    register("table", block, fields, idAt(metaState), fields.number);
  };

  const emitFigure = (image: Tokens.Image, at: number): void => {
    const metaState = pending;
    const fields = takeMeta("figure");
    sawContent = true;
    figureCount += 1;
    const block: IrBlock = {
      id: "",
      type: "figure",
      ...(fields.number !== undefined ? { number: fields.number } : {}),
      ...(fields.label !== undefined ? { label: fields.label } : {}),
      ...(fields.footnote !== undefined ? { footnote: fields.footnote } : {}),
    };
    const checked = checkImageHref(image.href);
    if (checked.name === undefined) {
      report(w, at, checked.code as string, checked.message as string, { subject: image.href });
    } else {
      const asset = assetByName.get(checked.name);
      if (asset === undefined)
        report(
          w,
          at,
          "image_asset_missing",
          `no asset named "${checked.name}" is registered for this document; add the image first`,
          { subject: checked.name }
        );
      else {
        referencedAssets.set(asset.name, asset);
        block.imgPath = asset.name;
        if (asset.width !== undefined) block.imgWidth = asset.width;
        if (asset.height !== undefined) block.imgHeight = asset.height;
      }
    }
    if (image.text.trim() !== "") {
      if (PLACEHOLDER_RUN.test(image.text))
        report(
          w,
          at,
          "image_alt_token",
          "the alt text cannot contain a formula or a [cite: ...] / [ref: ...] token"
        );
      else block.content = image.text.trim();
    }
    PLACEHOLDER_RUN.lastIndex = 0;
    if (image.title)
      report(
        w,
        at,
        "image_title_ignored",
        "the image title is ignored; give a caption with an argelander-block",
        {
          severity: "warning",
        }
      );
    if (fields.caption !== undefined) {
      const segs = captionOf(fields.caption, metaState?.located ?? null, block);
      if (segs !== undefined && segs.length > 0) block.captionSegments = segs;
    }
    if (fields.footnote !== undefined) {
      const segs = captionOf(fields.footnote, metaState?.located ?? null, block, "footnote");
      if (segs !== undefined && segs.length > 0 && block.type === "figure")
        block.footnoteSegments = segs;
    }
    currentBlocks().push(block);
    register("figure", block, fields, idAt(metaState), fields.number);
  };

  const flushDisplays = (upTo: number): void => {
    while (
      displayIndex < scan.displays.length &&
      (scan.displays[displayIndex] as DisplayMath).lineStart <= upTo
    ) {
      emitEquation(scan.displays[displayIndex] as DisplayMath);
      displayIndex += 1;
    }
  };

  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t] as Token;
    const at = offset;
    offset += token.raw.length;
    const errorsBefore = w.errors;
    w.currentAt = at;
    flushDisplays(at);
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        if (!isAtxHeading(heading.raw)) {
          pending = null;
          report(
            w,
            at,
            "setext_unsupported",
            "only '#' headings are supported; underlined headings are not"
          );
          break;
        }
        sawContent = true;
        const pieces: Piece[] = [];
        inlinePieces(w, at, heading.tokens, pieces);
        const label = headingText(w, at, pieces);
        const metaState = pending;
        const fields = takeMeta("section");
        sectionCount += 1;
        const section: IrSection = {
          id: "",
          level: heading.depth,
          ...(fields.number !== undefined ? { number: fields.number } : {}),
          ...(label ? { heading: label } : {}),
          blocks: [],
          children: [],
        };
        register("section", section, fields, idAt(metaState), fields.number);
        if (heading.depth === 1 && firstH1 === undefined && label) firstH1 = label;
        while (stack.length > 0 && (stack[stack.length - 1] as IrSection).level >= heading.depth)
          stack.pop();
        const parent = stack[stack.length - 1];
        (parent ? parent.children : root).push(section);
        stack.push(section);
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        const lexRaw = scan.lexText.slice(at, at + token.raw.length);
        const rawLines = lexRaw.split(/\r|\n/);
        const columns = table.header.length;
        let lineAt = at;
        const cellAt: (number[] | undefined)[] = [];
        const lineStartAt: number[] = [];
        rawLines.forEach((line, i) => {
          const cells = gfmRowCells(line);
          cellAt[i] = cells.starts.map((o) => lineAt + o);
          lineStartAt[i] = lineAt;
          if (i >= 2 && line.trim() !== "" && cells.count > columns)
            report(
              w,
              lineAt,
              "table_extra_cells",
              `this row has more cells than the ${columns} columns of the header; the extra cells would be lost`
            );
          lineAt += line.length + 1;
        });
        if (table.align.some((a) => a !== null))
          report(w, at, "table_align_ignored", "column alignment is not kept", {
            severity: "warning",
          });
        const cellCount = table.header.length + table.rows.reduce((n, r) => n + r.length, 0);
        if (
          table.rows.length + 1 > TEXT_TABLE_MAX_ROWS ||
          columns > TEXT_TABLE_MAX_COLS ||
          cellCount > TEXT_TABLE_MAX_CELLS
        ) {
          report(
            w,
            at,
            "table_too_large",
            `a table may have at most ${TEXT_TABLE_MAX_ROWS} rows, ${TEXT_TABLE_MAX_COLS} columns and ${TEXT_TABLE_MAX_CELLS} cells`
          );
          pending = null;
          break;
        }
        const toCell = (
          c: Tokens.TableCell,
          header: boolean,
          line: number,
          col: number
        ): GridCell => {
          const here = cellAt[line]?.[col] ?? lineStartAt[line] ?? at;
          const pieces: Piece[] = [];
          inlinePieces(w, here, c.tokens, pieces);
          return {
            html: cellHtmlOf(pieces),
            header,
            rowspan: 1,
            colspan: 1,
            at: here,
            spanAt: () => here,
          };
        };
        const grid: GridCell[][] = [
          table.header.map((c, col) => toCell(c, true, 0, col)),
          ...table.rows.map((r, row) => r.map((c, col) => toCell(c, false, row + 2, col))),
        ];
        const metaState = pending;
        emitTable(tableHtmlOf(grid), metaState);
        break;
      }
      case "paragraph":
      case "text": {
        if (token.type === "paragraph") {
          const only = (token as Tokens.Paragraph).tokens;
          if (only.length === 1 && only[0]?.type === "image") {
            emitFigure(only[0] as Tokens.Image, at);
            break;
          }
        }
        const inner =
          token.type === "paragraph"
            ? (token as Tokens.Paragraph).tokens
            : ((token as Tokens.Text).tokens ?? [token]);
        const pieces: Piece[] = [];
        inlinePieces(w, at, inner, pieces);
        if (mergedPieces(pieces).length === 0) break;
        sawContent = true;
        // a display equation in the middle of the text ends the paragraph before it and starts a new one after it,
        // in source order (the first block that comes out takes a pending argelander-block)
        let run: Piece[] = [];
        const emitRun = (): void => {
          if (mergedPieces(run).length === 0) {
            run = [];
            return;
          }
          const metaState = pending;
          const fields = takeMeta("paragraph");
          paragraphCount += 1;
          const block: IrBlock = { id: "", type: "paragraph", segments: [] };
          block.segments = toSegments(w, run, block);
          currentBlocks().push(block);
          register("paragraph", block, fields, idAt(metaState));
          run = [];
        };
        for (const p of pieces) {
          if (p.t === "item" && p.item.kind === "display") {
            emitRun();
            if (!p.item.bad)
              emitEquation({
                lineStart: p.item.start,
                lineEnd: p.item.end,
                start: p.item.start,
                latex: p.item.latex as string,
              });
          } else run.push(p);
        }
        emitRun();
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        sawContent = true;
        let items: { segments: IrSegment[] }[] = [];
        let block: IrBlock = { id: "", type: "list", ordered: list.ordered, items };
        const closeList = (): void => {
          if (items.length === 0) return;
          const metaState = pending;
          const fields = takeMeta("list");
          listCount += 1;
          currentBlocks().push(block);
          register("list", block, fields, idAt(metaState));
        };
        const startList = (): void => {
          items = [];
          block = { id: "", type: "list", ordered: list.ordered, items };
        };
        let itemAt = at;
        for (const item of list.items) {
          const itemStart = itemAt;
          itemAt += item.raw.length;
          // a display equation written between two items: an unordered list is split around it (source order kept);
          // an ordered list cannot be (the second part would restart at 1), so that is a located error
          while (
            displayIndex < scan.displays.length &&
            (scan.displays[displayIndex] as DisplayMath).lineStart <= itemStart &&
            itemStart > at
          ) {
            const d = scan.displays[displayIndex] as DisplayMath;
            displayIndex += 1;
            if (list.ordered) {
              report(
                w,
                d.start,
                "math_display_in_list",
                "a display equation between ordered list items would restart the numbering; put it after the list"
              );
            } else {
              closeList();
              emitEquation(d);
              startList();
            }
          }
          // a display equation inside an item with text after it cannot keep its place
          const contentEnd = itemStart + item.raw.trimEnd().length;
          while (
            displayIndex < scan.displays.length &&
            (scan.displays[displayIndex] as DisplayMath).lineStart < itemAt &&
            (scan.displays[displayIndex] as DisplayMath).lineEnd < contentEnd
          ) {
            report(
              w,
              (scan.displays[displayIndex] as DisplayMath).start,
              "math_display_in_list",
              "a display equation inside a list item, followed by more of that item, cannot keep its place; put it between items or after the list"
            );
            displayIndex += 1;
          }
          if (item.task) report(w, at, "task_unsupported", "task list markers are not supported");
          const real = item.tokens.filter((x) => x.type !== "space");
          if (real.some((x) => x.type === "list")) {
            report(
              w,
              at,
              "nested_list_unsupported",
              "nested lists are not supported; keep the list to one level"
            );
            continue;
          }
          if (real.length !== 1 || (real[0]?.type !== "text" && real[0]?.type !== "paragraph")) {
            report(
              w,
              at,
              "list_item_unsupported",
              "a list item must be a single paragraph of text; split the content into separate paragraphs"
            );
            continue;
          }
          const only = real[0] as Tokens.Text | Tokens.Paragraph;
          const pieces: Piece[] = [];
          inlinePieces(w, at, only.tokens ?? [only], pieces);
          const shown = pieces.filter((p) => {
            if (p.t !== "item" || p.item.kind !== "display") return true;
            if (!p.item.bad)
              report(
                w,
                p.item.start,
                "math_display_in_list",
                "a display equation inside a list item has no place in the IR; put it between items or after the list"
              );
            return false;
          });
          items.push({ segments: toSegments(w, shown, block) });
        }
        closeList();
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        if (code.codeBlockStyle === "indented") {
          pending = null;
          report(
            w,
            at,
            "code_indented",
            "an indented code block is not supported; use a fenced block (```)"
          );
          break;
        }
        const fence = fenceOf(text.slice(at, at + code.raw.length), at);
        if (fence === null) {
          pending = null;
          reportSyntax(w, at, "code");
          break;
        }
        const marker = fence.info.split(/\s+/)[0] ?? "";
        if (marker === "argelander-document") {
          if (sawDocMeta) {
            report(w, at, "document_meta_duplicate", "there is only one argelander-document block");
            break;
          }
          if (sawContent) {
            report(
              w,
              at,
              "document_meta_position",
              "the argelander-document block must be the first thing in the text"
            );
            sawDocMeta = true;
            break;
          }
          sawDocMeta = true;
          const parsed = parseMarker(w, fence, at, "document_meta_json");
          if (parsed === null) break;
          const result = TextDocumentMetaSchema.safeParse(parsed.value);
          if (!result.success) {
            reportIssues(w, result.error.issues as Issue[], parsed.located, {
              unknown: "document_meta_unknown_field",
              invalid: "document_meta_invalid",
            });
            break;
          }
          const details = result.data.authorDetails ?? [];
          const count = result.data.affiliations?.length ?? 0;
          for (const [i, author] of details.entries()) {
            for (const [j, n] of (author.affiliations ?? []).entries()) {
              if (n >= 1 && n <= count) continue;
              report(
                w,
                whereIn(parsed.located, ["authorDetails", i, "affiliations", j]),
                "document_meta_invalid",
                `affiliation ${n} is not in the affiliations list (1..${count})`,
                { field: `authorDetails[${i}].affiliations[${j}]` }
              );
            }
          }
          if (result.data.title?.includes("$"))
            report(
              w,
              whereIn(parsed.located, ["title"]),
              "title_dollar",
              "a literal $ in the title can be shown as part of a formula",
              { severity: "warning", field: "title" }
            );
          docMeta = result.data;
          break;
        }
        if (marker === "argelander-block") {
          sawContent = true;
          if (pending !== null) {
            report(
              w,
              at,
              "block_meta_adjacent",
              "two argelander-block blocks in a row; each binds to the one block after it"
            );
            break;
          }
          const parsed = parseMarker(w, fence, at, "block_meta_json");
          if (parsed === null) break;
          const result = TextBlockMetaSchema.safeParse(parsed.value);
          if (!result.success) {
            reportIssues(w, result.error.issues as Issue[], parsed.located, {
              unknown: "block_meta_unknown_field",
              invalid: "block_meta_invalid",
            });
            break;
          }
          pending = { fields: result.data, at, located: parsed.located };
          break;
        }
        if (marker === "argelander-references") {
          sawContent = true;
          if (pending !== null) {
            report(
              w,
              pending.at,
              "block_meta_target",
              "an argelander-block cannot bind to the references block"
            );
            pending = null;
          }
          if (references !== undefined || referencesAt >= 0) {
            report(w, at, "references_duplicate", "there is only one argelander-references block");
            break;
          }
          referencesAt = at;
          // a display equation after the block is blanked out of the lexer text (it looks like blank lines), so check it too
          if (
            tokens.slice(t + 1).some((x) => x.type !== "space") ||
            scan.displays.some((d) => d.lineStart >= at + token.raw.length)
          ) {
            report(
              w,
              at,
              "references_not_last",
              "the argelander-references block must be the last thing in the text"
            );
            break;
          }
          const parsed = parseMarker(w, fence, at, "references_json");
          if (parsed === null) break;
          const result = TextReferencesSchema.safeParse(parsed.value);
          if (!result.success) {
            reportIssues(w, result.error.issues as Issue[], parsed.located, {
              unknown: "references_unknown_field",
              invalid: "references_invalid",
            });
            break;
          }
          const seen = new Map<string, number>();
          result.data.forEach((ref, i) => {
            if (ref.id.startsWith(ANNOTATION_ID_PREFIX) || PROTO_NAMES.has(ref.id))
              report(
                w,
                whereIn(parsed.located, [i, "id"]),
                "id_reserved",
                `the reference id "${ref.id}" is reserved`,
                { field: `[${i}].id`, subject: ref.id }
              );
            // only web addresses: a reference url never becomes a script or file link
            if (ref.url !== undefined && !/^https?:\/\//i.test(ref.url))
              report(
                w,
                whereIn(parsed.located, [i, "url"]),
                "references_invalid",
                "url: only http:// and https:// addresses are allowed",
                { field: `[${i}].url` }
              );
            if (seen.has(ref.id))
              report(
                w,
                whereIn(parsed.located, [i, "id"]),
                "reference_id_duplicate",
                `the reference id "${ref.id}" is already used by entry ${(seen.get(ref.id) as number) + 1}`,
                { field: `[${i}].id`, subject: ref.id }
              );
            else seen.set(ref.id, i);
          });
          references = result.data;
          referenceAts = result.data.map((_, i) => whereIn(parsed.located, [i, "id"]));
          break;
        }
        if (marker === "argelander-table") {
          const metaState = pending;
          const parsed = parseMarker(w, fence, at, "table_json");
          if (parsed === null) {
            pending = null;
            break;
          }
          const result = TextTableSchema.safeParse(parsed.value);
          if (!result.success) {
            reportIssues(w, result.error.issues as Issue[], parsed.located, {
              unknown: "table_unknown_field",
              invalid: "table_invalid",
            });
            pending = null;
            break;
          }
          const tableRows = result.data.rows;
          const cells = tableRows.reduce((n, r) => n + r.length, 0);
          if (tableRows.length > TEXT_TABLE_MAX_ROWS || cells > TEXT_TABLE_MAX_CELLS) {
            report(
              w,
              at,
              "table_too_large",
              `a table may have at most ${TEXT_TABLE_MAX_ROWS} rows, ${TEXT_TABLE_MAX_COLS} columns and ${TEXT_TABLE_MAX_CELLS} cells`
            );
            pending = null;
            break;
          }
          const grid: GridCell[][] = tableRows.map((row, i) =>
            row.map((cell, j) => ({
              html: cellFromText(cell.text, whereIn(parsed.located, ["rows", i, j, "text"])),
              header: cell.header === true,
              rowspan: cell.rowspan ?? 1,
              colspan: cell.colspan ?? 1,
              at: whereIn(parsed.located, ["rows", i, j]),
              spanAt: (field) => whereIn(parsed.located, ["rows", i, j, field]),
            }))
          );
          const gridErrors = w.errors;
          if (checkGrid(w, grid) && w.errors === gridErrors)
            emitTable(tableHtmlOf(grid), metaState);
          else pending = null;
          break;
        }
        if (marker.startsWith("argelander-")) {
          pending = null;
          report(w, at, "fence_unknown_marker", `"${marker}" is not a block of this format`, {
            subject: marker,
          });
          break;
        }
        // an ordinary fenced code block (or, with kind=algorithm metadata, an algorithm)
        if (!fence.closed) {
          pending = null;
          report(w, at, "fence_unclosed", "this code fence is never closed");
          break;
        }
        sawContent = true;
        const metaState = pending;
        const metaFields = pending?.fields;
        const target: Target = metaFields?.kind === "algorithm" ? "algorithm" : "code";
        const fields = takeMeta(target);
        codeCount += 1;
        const info = fence.info.split(/\s+/).filter(Boolean);
        const lang = info[0];
        if (info.length > 1)
          report(
            w,
            at,
            "code_info_ignored",
            `only the language "${lang}" is kept; the rest of the info string is ignored`,
            {
              severity: "warning",
              subject: info.slice(1).join(" "),
            }
          );
        const block: IrBlock =
          target === "algorithm"
            ? { id: "", type: "algorithm", body: fence.body }
            : { id: "", type: "code", body: fence.body, ...(lang ? { lang } : {}) };
        if (target === "algorithm" && lang)
          report(
            w,
            at,
            "algorithm_lang_ignored",
            `an algorithm keeps no language; "${lang}" is ignored`,
            {
              severity: "warning",
              subject: lang,
            }
          );
        if (fields.number !== undefined) block.number = fields.number;
        if (fields.label !== undefined) block.label = fields.label;
        if (fields.caption !== undefined) {
          const segs = captionOf(fields.caption, metaState?.located ?? null, block);
          if (segs !== undefined && segs.length > 0) block.captionSegments = segs;
        }
        currentBlocks().push(block);
        register(target, block, fields, idAt(metaState), fields.number);
        break;
      }
      default:
        pending = null;
        reportSyntax(w, at, token.type);
        break;
    }
    // Every find the scan extracted must be consumed exactly once. One that lies inside a token that did not consume it
    // (a code block, say) was extracted by the scan and also left in the block's own text: reported, never dropped
    // silently or shown twice. A token that already reported an error explains the skip.
    const end = at + token.raw.length;
    for (
      let item = w.items[w.nextItem];
      item !== undefined && item.start < end;
      item = w.items[w.nextItem]
    ) {
      if (w.errors === errorsBefore) report(w, item.start, "scan_mismatch", SCAN_MISMATCH);
      w.nextItem += 1;
    }
    if (
      token.type !== "space" &&
      token.type !== "list" &&
      token.type !== "heading" &&
      token.type !== "paragraph" &&
      token.type !== "text"
    ) {
      for (
        let d = scan.displays[displayIndex];
        d !== undefined && d.lineStart < end;
        d = scan.displays[displayIndex]
      ) {
        if (w.errors === errorsBefore) report(w, d.start, "scan_mismatch", SCAN_MISMATCH);
        displayIndex += 1;
      }
    }
  }
  for (let item = w.items[w.nextItem]; item !== undefined; item = w.items[w.nextItem]) {
    if (w.errors === 0) report(w, item.start, "scan_mismatch", SCAN_MISMATCH);
    w.nextItem += 1;
  }
  flushDisplays(Number.POSITIVE_INFINITY);
  if (pending !== null)
    report(
      w,
      (pending as PendingMeta).at,
      "block_meta_dangling",
      "this argelander-block has no block after it to bind to"
    );

  // ---- ids: explicit ones are unique, implicit ones are deterministic -------------------------------------------
  const taken = new Map<string, number>();
  for (const e of entries) {
    if (e.explicit === undefined) continue;
    const { id, at } = e.explicit;
    if (RESERVED_IDS.has(id) || id.startsWith(ANNOTATION_ID_PREFIX) || PROTO_NAMES.has(id)) {
      report(w, at, "id_reserved", `the id "${id}" is reserved`, { field: "id", subject: id });
    } else if (taken.has(id)) {
      const first = locate(w.lineStarts, taken.get(id) as number);
      report(w, at, "id_duplicate", `the id "${id}" is already used (line ${first.line})`, {
        field: "id",
        subject: id,
      });
    } else {
      taken.set(id, at);
      e.node.id = id;
    }
  }
  const used = new Set<string>([...taken.keys(), ...RESERVED_IDS]);
  const counters: Record<string, number> = {};
  for (const e of entries) {
    // every block of a kind counts, explicit id or not, so adding an id to one block does not renumber the later ones
    counters[e.prefix] = (counters[e.prefix] ?? 0) + 1;
    if (e.node.id !== "") continue;
    let candidate = `${e.prefix}-${counters[e.prefix]}`;
    for (let n = 1; used.has(candidate); n += 1)
      candidate = `${e.prefix}-${counters[e.prefix]}-${n}`;
    used.add(candidate);
    e.node.id = candidate;
  }

  // ---- cross-references and citations: the table is complete, now resolve ---------------------------------------
  const byId = new Map<string, Entry>();
  for (const e of entries) byId.set(e.node.id, e);
  let unresolved = 0;
  for (const use of w.refs) {
    if (use.item.bad) continue;
    const id = use.seg.target.id;
    const entry = byId.get(id);
    if (entry === undefined) {
      unresolved += 1;
      report(
        w,
        use.item.where,
        "ref_unresolved",
        `no block has the id "${id}"; the text is kept as it was written`,
        {
          severity: "warning",
          subject: id,
        }
      );
    } else if (entry.target === "paragraph" || entry.target === "list") {
      report(
        w,
        use.item.where,
        "ref_target_unsupported",
        `"${id}" is a ${entry.target}; only sections, equations, code and algorithms can be referenced`,
        {
          subject: id,
        }
      );
    } else {
      use.seg.target = {
        id,
        resolved: true,
        targetType: (entry.target === "section" ? "section" : entry.target) as IrXrefTargetType,
        ...(entry.number !== undefined ? { number: entry.number } : {}),
      };
    }
  }
  const refTable = new Map<string, Reference>();
  for (const r of references ?? []) if (!refTable.has(r.id)) refTable.set(r.id, r);
  // reference ids and structure ids are different namespaces, but both become DOM ids in the Reader
  (references ?? []).forEach((r, i) => {
    if (byId.has(r.id))
      report(
        w,
        referenceAts[i],
        "reference_id_collision",
        `the reference id "${r.id}" is also the id of a block; the two share one id space in the Reader`,
        { field: `[${i}].id`, subject: r.id }
      );
  });
  const cited = new Map<string, { list: string[]; seen: Set<string> }>();
  for (const use of w.cites) {
    if (use.item.bad) continue;
    for (const ref of use.seg.refs) {
      const found = refTable.get(ref.id);
      if (found === undefined) {
        unresolved += 1;
        report(
          w,
          use.item.where,
          "cite_unresolved",
          `no reference has the id "${ref.id}"; the text is kept as it was written`,
          {
            severity: "warning",
            subject: ref.id,
          }
        );
        continue;
      }
      ref.resolved = true;
      ref.short = citeShort(found);
      if (found.title !== undefined && found.title !== "") ref.title = found.title;
      if (use.owner !== null) {
        let entry = cited.get(use.owner.id);
        if (entry === undefined) {
          entry = { list: [], seen: new Set() };
          cited.set(use.owner.id, entry);
        }
        if (!entry.seen.has(ref.id)) {
          entry.seen.add(ref.id);
          entry.list.push(ref.id);
        }
      }
    }
  }

  // own properties by definition (Object.fromEntries defines them), whatever the ids are
  const citationsByBlock: Record<string, string[]> = Object.fromEntries(
    [...cited].map(([id, e]) => [id, e.list])
  );
  // the first formula past the budget was reported where it is; the summary counts the others
  if (w.mathUnchecked > 1)
    report(
      w,
      undefined,
      "math_not_checked",
      `${w.mathUnchecked - 1} more formulas were not checked for typesetting errors (a budget bounds the work)`,
      { severity: "warning", subject: String(w.mathUnchecked - 1) }
    );
  if (w.errors === 0 && w.misalignedAt !== undefined)
    report(w, w.misalignedAt, "scan_mismatch", SCAN_MISMATCH);

  const stats: TextStats = { sections: sectionCount, paragraphs: paragraphCount, lists: listCount };
  if (equationCount > 0) stats.equations = equationCount;
  if (codeCount > 0) stats.codeBlocks = codeCount;
  if (figureCount > 0) stats.figures = figureCount;
  if (tableCount > 0) stats.tables = tableCount;
  if (w.inlineMath > 0) stats.inlineMath = w.inlineMath;
  const citeCount = w.cites.filter((u) => !u.item.bad).length;
  const refCount = w.refs.filter((u) => !u.item.bad).length;
  if (citeCount > 0) stats.citations = citeCount;
  if (refCount > 0) stats.crossRefs = refCount;
  if ((references?.length ?? 0) > 0) stats.references = references?.length as number;
  if (unresolved > 0) stats.unresolved = unresolved;

  if (
    sectionCount +
      paragraphCount +
      listCount +
      equationCount +
      codeCount +
      figureCount +
      tableCount ===
      0 &&
    w.total === 0
  )
    report(w, undefined, "empty_document", "the document has no content yet");
  if (w.errors > 0) return finish(w, null, stats);

  // A paper with a reference list whose in-text citations are still plain "[12]": the transcription instruction asks
  // for [cite: ...] links, so say how many places were left (a count, not a position: nothing is guessed or rewritten).
  if ((references?.length ?? 0) > 0) {
    const plain = countPlainNumericCitations(root);
    if (plain > 0)
      report(
        w,
        undefined,
        "cite_plain",
        `${plain} place(s) look like numbered citations written as plain text (such as [12]) although the text has a reference list; link each as [cite: ...] to its reference`,
        { severity: "warning", subject: String(plain) }
      );
  }

  fillXrefPreviews(root, buildTargetLookup(root));
  const rows = refsManifest(root).filter((r) => r.kind !== "section" || r.content !== "");
  const title = docMeta?.title ?? firstH1 ?? options.fallbackTitle;
  const { version: _version, ...docFields } = docMeta ?? { version: 1 };
  const refList = references ?? [];
  const ir: TextDocIr = {
    version: TEXT_IR_VERSION,
    docId: options.docId,
    ...(title ? { title } : {}),
    source: {
      type: "text",
      input_version: TEXT_INPUT_VERSION,
      source_rev: options.sourceRev,
      source_fingerprint: textSourceFingerprint(markdown, [...referencedAssets.values()]),
    },
    meta: { ...docFields, ...(title ? { title } : {}) },
    sections: root,
    refsManifest: rows,
    bib: bibManifest(refList),
    ...(refList.length > 0 ? { references: refList } : {}),
    citationsByBlock,
  };
  return finish(w, ir, stats);
}

/** Order the diagnostics by position, append the cap summary, and withhold the IR when there is any error. */
function finish(w: Walk, ir: TextDocIr | null, stats: TextStats): TextParseResult {
  w.diagnostics.sort((a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0));
  if (w.total > w.diagnostics.length)
    w.diagnostics.push({
      code: "too_many_diagnostics",
      severity: w.hiddenErrors > 0 ? "error" : "warning",
      message: `${w.total - w.diagnostics.length} more diagnostics are not shown`,
      count: w.total - w.diagnostics.length,
    });
  return { ir: w.errors > 0 ? null : ir, diagnostics: w.diagnostics, stats };
}

/** Plain-text numeric bracket citations ([1], [2, 3], [4-6]) in paragraphs, lists and captions; links, math and code are not text segments. */
// Not preceded by a word character or a closing bracket (a[3], f(a)[5], x[1][2] are indexes), and not starting with 0
// (the interval [0,1]). Other intervals such as [1, 2] cannot be told from a citation by their text and still count.
const PLAIN_NUMERIC_CITATION = /(?<![\w\])])\[\s*(?!0\b)\d{1,3}\s*(?:[,;–-]\s*\d{1,3}\s*)*\]/g;
function countPlainNumericCitations(sections: readonly IrSection[]): number {
  let count = 0;
  const scan = (segments: readonly IrSegment[] | undefined) => {
    for (const segment of segments ?? [])
      if (segment.type === "text") count += segment.text.match(PLAIN_NUMERIC_CITATION)?.length ?? 0;
  };
  const walk = (list: readonly IrSection[]) => {
    for (const section of list) {
      for (const block of section.blocks) {
        if (block.type === "paragraph") scan(block.segments);
        else if (block.type === "list") for (const item of block.items) scan(item.segments);
        else if ("captionSegments" in block) scan(block.captionSegments);
      }
      walk(section.children);
    }
  };
  walk(sections);
  return count;
}
