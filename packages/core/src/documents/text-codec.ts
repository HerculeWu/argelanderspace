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
  type IrBlock,
  type IrSection,
  type IrSegment,
  type IrXrefTargetType,
  type Reference,
  TEXT_INPUT_VERSION,
  TEXT_IR_VERSION,
  type TextBlockMeta,
  TextBlockMetaSchema,
  type TextDiagnostic,
  type TextDocIr,
  TextDocumentMetaSchema,
  TextReferencesSchema,
  type TextStats,
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
import { katexError } from "./text-math.js";
import { type DisplayMath, type Item, PLACEHOLDER_RUN, scanSyntax } from "./text-scan.js";

export interface TextParseOptions {
  docId: string;
  sourceRev: number;
  /** Used when the text has no title (no `argelander-document` title, no level-1 heading). */
  fallbackTitle?: string;
}

export interface TextParseResult {
  /** Present only when no error diagnostic was found. */
  ir: TextDocIr | null;
  diagnostics: TextDiagnostic[];
  stats: TextStats;
}

/** sha256 of the generating source: the Markdown's UTF-8 bytes (asset hashes join it with the figure ticket). */
export function textSourceFingerprint(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
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
  table: {
    code: "table_unsupported",
    message: "tables are not supported yet; rewrite it as plain paragraphs",
  },
  hr: {
    code: "rule_unsupported",
    message: "horizontal rules are not supported; remove it or start a new heading",
  },
  html: { code: "html_unsupported", message: "raw HTML is not allowed in a text document" },
  def: { code: "definition_unsupported", message: "link reference definitions are not supported" },
  image: { code: "image_unsupported", message: "images are not supported yet" },
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

type Target = "section" | "paragraph" | "list" | "equation" | "code" | "algorithm";

/** Which `argelander-block` fields apply to which block. `footnote` belongs to figures/tables (ticket 27) only. */
const ALLOWED_FIELDS: Record<Target, readonly (keyof TextBlockMeta)[]> = {
  section: ["id", "kind", "number"],
  paragraph: ["id", "kind"],
  list: ["id", "kind"],
  equation: ["id", "kind", "number", "label"],
  code: ["id", "kind", "number", "label", "caption"],
  algorithm: ["id", "kind", "number", "label", "caption"],
};
const ID_PREFIX: Record<Target, string> = {
  section: "sec",
  paragraph: "p",
  list: "l",
  equation: "eq",
  code: "code",
  algorithm: "alg",
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
  misaligned: boolean;
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
      w.misaligned = true;
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
  const error = katexError(latex, display);
  if (error !== null)
    report(w, at, "math_katex", `the formula cannot be typeset: ${error}`, {
      severity: "warning",
      subject: error,
    });
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

function fenceOf(raw: string, at: number): FenceInfo | null {
  const open = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\n]*)/.exec(raw);
  if (open === null) return null;
  const fence = open[1] as string;
  const lines = raw.replace(/\n+$/, "").split("\n");
  let closed = false;
  if (lines.length >= 2) {
    const last = lines[lines.length - 1] as string;
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(last);
    closed =
      m !== null && (m[1] as string)[0] === fence[0] && (m[1] as string).length >= fence.length;
  }
  const innerLines = lines.slice(1, closed ? -1 : undefined);
  const inner = innerLines.join("\n");
  // the body as written: up to the fence's own indentation is removed from each line (CommonMark); nothing else changes,
  // a lone CR included (`raw` is the source slice, not the lexer's normalized copy)
  const indent = (/^ */.exec(raw) as RegExpExecArray)[0].length;
  const strip = new RegExp(`^ {0,${indent}}`);
  const body = innerLines.map((l) => l.replace(strip, "")).join("\n");
  const firstNl = raw.indexOf("\n");
  return {
    info: (open[2] as string).trim(),
    closed,
    inner,
    body,
    base: at + (firstNl === -1 ? raw.length : firstNl + 1),
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
    misaligned: false,
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
            ? "footnote belongs to figures and tables, which are not supported yet"
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
    owner: IrBlock
  ): IrSegment[] | undefined => {
    if (caption === undefined) return undefined;
    const where = located === null ? 0 : whereIn(located, ["caption"]);
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
      case "paragraph":
      case "text": {
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
  if (w.mathUnchecked > 0)
    report(
      w,
      undefined,
      "math_not_checked",
      `${w.mathUnchecked} more formulas were not checked for typesetting errors (a budget bounds the work)`,
      { severity: "warning", subject: String(w.mathUnchecked) }
    );
  if (w.errors === 0 && (w.misaligned || w.nextItem !== w.items.length))
    report(
      w,
      undefined,
      "internal_error",
      "an inline element could not be matched to its place; this is a parser fault"
    );

  const stats: TextStats = { sections: sectionCount, paragraphs: paragraphCount, lists: listCount };
  if (equationCount > 0) stats.equations = equationCount;
  if (codeCount > 0) stats.codeBlocks = codeCount;
  if (w.inlineMath > 0) stats.inlineMath = w.inlineMath;
  const citeCount = w.cites.filter((u) => !u.item.bad).length;
  const refCount = w.refs.filter((u) => !u.item.bad).length;
  if (citeCount > 0) stats.citations = citeCount;
  if (refCount > 0) stats.crossRefs = refCount;
  if ((references?.length ?? 0) > 0) stats.references = references?.length as number;
  if (unresolved > 0) stats.unresolved = unresolved;

  if (sectionCount + paragraphCount + listCount + equationCount + codeCount === 0 && w.total === 0)
    report(w, undefined, "empty_document", "the document has no content yet");
  if (w.errors > 0) return finish(w, null, stats);

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
      source_fingerprint: textSourceFingerprint(markdown),
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
