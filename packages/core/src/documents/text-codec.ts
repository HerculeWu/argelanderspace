/**
 * The `argelander-text` v1 codec (copilot ticket 25): complete readable Markdown in, shared IR out.
 *
 * This increment understands ATX headings (they build the section tree), plain paragraphs and single-level
 * ordered/unordered lists, with emphasis and code spans reduced to their text. Everything else the format will
 * eventually carry (math, figures, tables, code blocks, cite/xref, references, block metadata) is NOT silently
 * dropped or flattened: it is reported as an error with a construct-specific code (`math_unsupported`,
 * `cite_unsupported`, `table_unsupported`, ...) that names the line and column, so validation and
 * generation refuse until the text is rewritten. The parser is the one truth for the page, the HTTP routes and the
 * agent; there is no second parser in the browser.
 *
 * Lexing is `marked`'s (a declared dependency); only the mapping to the IR is ours. The functions here are pure:
 * they never read or write a file and they do not know about annotations.
 */

import { createHash } from "node:crypto";
import {
  type IrBlock,
  type IrSection,
  type IrSegment,
  type RefManifestRow,
  TEXT_INPUT_VERSION,
  TEXT_IR_VERSION,
  type TextDiagnostic,
  type TextDocIr,
  type TextStats,
} from "@argelanderspace/contracts";
import { Lexer, type Token, type Tokens } from "marked";

export interface TextParseOptions {
  docId: string;
  sourceRev: number;
  /** Used when the text has no level-1 heading to name the document. */
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

/** Position of an offset in the (newline-normalized) text, 1-based. */
function locate(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/** Diagnostic code and English message per unsupported construct; the page shows its own localized text per code. */
const UNSUPPORTED: Record<string, { code: string; message: string }> = {
  code: {
    code: "code_unsupported",
    message: "code blocks are not supported yet; rewrite it as a plain paragraph",
  },
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

interface Ctx {
  text: string;
  offset: number;
  diagnostics: TextDiagnostic[];
}

function report(ctx: Ctx, at: number, code: string, message: string): void {
  const { line, column } = locate(ctx.text, at);
  ctx.diagnostics.push({ code, severity: "error", message, line, column });
}

function reportSyntax(ctx: Ctx, at: number, type: string): void {
  const entry = UNSUPPORTED[type] ?? UNKNOWN(type);
  report(ctx, at, entry.code, entry.message);
}

/**
 * The inline constructs the format will give meaning to later (math, cite, ref) but this increment cannot carry.
 * They are found BEFORE lexing, because the lexer would otherwise reduce them to text (`$a *b* c$` loses its `*`,
 * `$\\{x\\}$` its backslashes). Protection order follows the Markdown-with-math display path (lib/mdWithMath.ts):
 * code (fences, then code spans) and URLs are literal zones; then `$$..$$` / `$..$` with texmath's boundary rules
 * (an opening `$` needs a non-space after it and no backslash before it; a closing `$` needs a non-space before it
 * and no digit or `$` after it, so currency like `$100 to $200` stays text); then `[cite:` and `[ref:` tokens.
 */
const FENCE_RE = /(```|~~~)[\s\S]*?(?:\1|$)/g;
const CODE_SPAN_RE = /(`+)([\s\S]*?)\1(?!`)/g;
const URL_RE = /(?:https?|ftp):\/\/[^\s<>]*/g;
const MATH_RE = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g;
const CITE_RE = /(?<!\\)\[cite:/g;
const REF_RE = /(?<!\\)\[ref:/g;

/** Same length, same newlines, every literal-zone character blanked. */
function maskLiteralZones(text: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return text.replace(FENCE_RE, blank).replace(CODE_SPAN_RE, blank).replace(URL_RE, blank);
}

function scanInlineSyntax(ctx: Ctx): void {
  const masked = maskLiteralZones(ctx.text);
  for (const m of masked.matchAll(MATH_RE))
    report(
      ctx,
      m.index ?? 0,
      "math_unsupported",
      "math ($...$ and $$...$$) is not supported yet; write the formula as plain text"
    );
  for (const m of masked.matchAll(CITE_RE))
    report(ctx, m.index ?? 0, "cite_unsupported", "[cite: ...] references are not supported yet");
  for (const m of masked.matchAll(REF_RE))
    report(
      ctx,
      m.index ?? 0,
      "ref_unsupported",
      "[ref: ...] cross-references are not supported yet"
    );
}

/** Inline tokens → the text they show; unsupported inline syntax is reported at the enclosing block's line. */
function inlineText(ctx: Ctx, at: number, tokens: Token[] | undefined, out: string[]): void {
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
      case "escape":
      case "codespan":
        out.push((token as Tokens.Text).text);
        break;
      case "br":
        out.push(" ");
        break;
      case "link": {
        // A bare URL / e-mail / <angle> autolink is what the user typed as plain text: keep the exact characters.
        // An explicit [text](url) link stays unsupported.
        const link = token as Tokens.Link;
        if (link.raw.startsWith("[")) reportSyntax(ctx, at, "link");
        else out.push(link.raw);
        break;
      }
      case "em":
      case "strong":
        inlineText(ctx, at, (token as Tokens.Em).tokens, out);
        break;
      default:
        reportSyntax(ctx, at, token.type);
        break;
    }
  }
}

function normalizeSpaces(parts: string[]): string {
  return parts
    .join("")
    .replace(/\s*\n\s*/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function textOf(ctx: Ctx, at: number, tokens: Token[] | undefined): string {
  const parts: string[] = [];
  inlineText(ctx, at, tokens, parts);
  return normalizeSpaces(parts);
}

function segmentsOf(text: string): IrSegment[] {
  return text ? [{ type: "text", text }] : [];
}

export function parseTextSource(markdown: string, options: TextParseOptions): TextParseResult {
  // marked normalizes line endings itself; do the same first so reported lines match the lexer's view.
  const text = markdown.replace(/\r\n|\r/g, "\n");
  const ctx: Ctx = { text, offset: 0, diagnostics: [] };
  scanInlineSyntax(ctx);
  const tokens = Lexer.lex(text);

  const root: IrSection[] = [];
  const stack: IrSection[] = [];
  let sectionCount = 0;
  let paragraphCount = 0;
  let listCount = 0;
  let preface: IrSection | null = null;
  let firstH1: string | undefined;

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

  for (const token of tokens) {
    const at = ctx.offset;
    ctx.offset += token.raw.length;
    switch (token.type) {
      case "space":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        if (!isAtxHeading(heading.raw)) {
          report(
            ctx,
            at,
            "setext_unsupported",
            "only '#' headings are supported; underlined headings are not"
          );
          break;
        }
        const label = textOf(ctx, at, heading.tokens);
        sectionCount += 1;
        const section: IrSection = {
          id: `sec-${sectionCount}`,
          level: heading.depth,
          ...(label ? { heading: label } : {}),
          blocks: [],
          children: [],
        };
        if (heading.depth === 1 && firstH1 === undefined && label) firstH1 = label;
        while (stack.length > 0 && (stack[stack.length - 1] as IrSection).level >= heading.depth)
          stack.pop();
        const parent = stack[stack.length - 1];
        (parent ? parent.children : root).push(section);
        stack.push(section);
        break;
      }
      case "paragraph": {
        const label = textOf(ctx, at, (token as Tokens.Paragraph).tokens);
        if (!label) break;
        paragraphCount += 1;
        currentBlocks().push({
          id: `p-${paragraphCount}`,
          type: "paragraph",
          segments: segmentsOf(label),
        });
        break;
      }
      case "text": {
        // a bare top-level text token (marked emits one for a lone line)
        const label = textOf(ctx, at, (token as Tokens.Text).tokens ?? [token]);
        if (!label) break;
        paragraphCount += 1;
        currentBlocks().push({
          id: `p-${paragraphCount}`,
          type: "paragraph",
          segments: segmentsOf(label),
        });
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        const items: { segments: IrSegment[] }[] = [];
        for (const item of list.items) {
          if (item.task) {
            report(ctx, at, "task_unsupported", "task list markers are not supported");
          }
          const real = item.tokens.filter((t) => t.type !== "space");
          if (real.some((t) => t.type === "list")) {
            report(
              ctx,
              at,
              "nested_list_unsupported",
              "nested lists are not supported; keep the list to one level"
            );
            continue;
          }
          if (real.length !== 1 || (real[0]?.type !== "text" && real[0]?.type !== "paragraph")) {
            report(
              ctx,
              at,
              "list_item_unsupported",
              "a list item must be a single paragraph of text; split the content into separate paragraphs"
            );
            continue;
          }
          const only = real[0] as Tokens.Text | Tokens.Paragraph;
          items.push({ segments: segmentsOf(textOf(ctx, at, only.tokens ?? [only])) });
        }
        listCount += 1;
        currentBlocks().push({ id: `l-${listCount}`, type: "list", ordered: list.ordered, items });
        break;
      }
      default:
        reportSyntax(ctx, at, token.type);
        break;
    }
  }

  const stats: TextStats = { sections: sectionCount, paragraphs: paragraphCount, lists: listCount };
  if (
    sectionCount === 0 &&
    paragraphCount === 0 &&
    listCount === 0 &&
    ctx.diagnostics.length === 0
  ) {
    ctx.diagnostics.push({
      code: "empty_document",
      severity: "error",
      message: "the document has no content yet",
    });
  }
  ctx.diagnostics.sort(
    (a, b) => (a.line ?? 0) - (b.line ?? 0) || (a.column ?? 0) - (b.column ?? 0)
  );
  if (ctx.diagnostics.some((d) => d.severity === "error")) {
    return { ir: null, diagnostics: ctx.diagnostics, stats };
  }

  const refsManifest: RefManifestRow[] = [];
  const walk = (sections: IrSection[], path: string[]): void => {
    for (const s of sections) {
      if (s.heading) {
        refsManifest.push({
          id: s.id,
          kind: "section",
          content: s.heading,
          short: s.heading.length > 80 ? `${s.heading.slice(0, 77)}...` : s.heading,
          section: `${s.level}:${s.heading}`,
        });
      }
      walk(s.children, [...path, s.heading ?? ""]);
    }
  };
  walk(root, []);

  const title = firstH1 ?? options.fallbackTitle;
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
    meta: title ? { title } : {},
    sections: root,
    refsManifest,
    bib: [],
    citationsByBlock: {},
  };
  return { ir, diagnostics: ctx.diagnostics, stats };
}
