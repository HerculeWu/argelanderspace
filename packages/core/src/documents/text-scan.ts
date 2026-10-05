/**
 * Inline-syntax scan of an `argelander-text` source: the pass that runs BEFORE the Markdown lexer.
 *
 * The lexer would reduce `$a *b* c$` to `a b c` and `[cite: a | *x*]` to `x`, so math, `[cite: ...]` and `[ref: ...]`
 * are found first, in the order of the Reader's own Markdown-with-math display path (`web/src/lib/mdWithMath.ts`):
 *
 * 1. literal zones are blanked: fenced code, code spans (never across a blank line), bare URLs;
 * 2. math: `$$...$$` and `$...$` with texmath's boundary rules (an opening `$` needs a non-space after it and no
 *    backslash before it; a closing `$` needs a non-space before it and no digit or `$` after it, so currency such as
 *    `$100 to $200` stays text);
 * 3. in what is left, `[cite: id;id | display]` and `[ref: id | display]`.
 *
 * Each inline find becomes an {@link Item} and is replaced in the text handed to the lexer by a placeholder run of the
 * SAME length (so every offset the lexer reports is still an offset of the source). A display equation that fills its
 * lines is a block: its lines are blanked (newlines kept), and it is returned separately, in position order.
 *
 * Placeholder runs are `OPEN FILL* CLOSE` over three reserved private-use characters; a source that already contains
 * one is rejected by the caller before this runs.
 */

import { TEXT_ID_PATTERN } from "@argelanderspace/contracts";

export const PH_OPEN = "";
export const PH_FILL = "";
export const PH_CLOSE = "";
export const PLACEHOLDER_RUN = /*/g;

export interface Item {
  kind: "math" | "cite" | "ref";
  /** Offset of the first character of the find in the source. */
  start: number;
  end: number;
  /** Where a diagnostic about this find is reported (the find itself; a caption field for caption text). */
  where: number;
  /** math: the formula between the delimiters. */
  latex?: string;
  /** cite: the ids in written order. ref: the single target id. */
  ids?: string[];
  /** The text shown for a cite/ref (escapes resolved); absent when the source gave none. */
  display?: string;
  /** The syntax was wrong and already reported: the find yields nothing. */
  bad: boolean;
}

export interface DisplayMath {
  /** Start of the first line / end (exclusive, before the newline) of the last line it occupies. */
  lineStart: number;
  lineEnd: number;
  /** Offset of the opening `$$`. */
  start: number;
  latex: string;
}

export interface Problem {
  code: string;
  offset: number;
  message: string;
  subject?: string;
}

export interface Scan {
  items: Item[];
  displays: DisplayMath[];
  problems: Problem[];
  /** The text for the lexer: same length as the source. */
  lexText: string;
}

const FENCE_RE = /(```|~~~)[\s\S]*?(?:\1|$)/g;
// a code span cannot cross a blank line (CommonMark: it lives inside one paragraph/block)
const CODE_SPAN_RE = /(`+)((?:(?!\n[ \t]*\n)[\s\S])*?)\1(?!`)/g;
const URL_RE = /(?:https?|ftp):\/\/[^\s<>]*/g;
const MATH_RE = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g;
const UNCLOSED_DISPLAY_RE = /(?<!\\)\$\$/g;
const TOKEN_RE = /(?<!\\)\[(cite|ref):/g;
const BLANK_LINE_AT = /^\n[ \t]*\n/;

const blank = (m: string): string => m.replace(/[^\n]/g, " ");

/** Same length, same newlines, every literal-zone character blanked. */
export function maskLiteralZones(text: string): string {
  return text.replace(FENCE_RE, blank).replace(CODE_SPAN_RE, blank).replace(URL_RE, blank);
}

/** One pass, so many ranges do not copy the whole text once each. Ranges are in position order. */
function blankRanges(text: string, ranges: { start: number; end: number }[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const r of ranges) {
    parts.push(text.slice(at, r.start), blank(text.slice(r.start, r.end)));
    at = r.end;
  }
  parts.push(text.slice(at));
  return parts.join("");
}

/** First unescaped `|` at or after `from` in `masked`, before `to`; -1 when there is none. */
function unescapedPipe(masked: string, from: number, to: number): number {
  for (let i = from; i < to; i += 1) {
    const c = masked[i];
    if (c === "\\") i += 1;
    else if (c === "|") return i;
  }
  return -1;
}

/** `\\`, `\|`, `\[`, `\]` are the literal characters; any other backslash stays; whitespace runs collapse. */
export function unescapeTokenText(raw: string): string {
  return raw
    .replace(/\\([\\|[\]])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function scanSyntax(text: string, options: { blockDisplay: boolean }): Scan {
  const items: Item[] = [];
  const displays: DisplayMath[] = [];
  const problems: Problem[] = [];
  const problem = (code: string, offset: number, message: string, subject?: string): void => {
    problems.push({ code, offset, message, ...(subject !== undefined ? { subject } : {}) });
  };

  let masked = maskLiteralZones(text);

  // ---- math ---------------------------------------------------------------------------------------------------
  const mathRanges: { start: number; end: number }[] = [];
  for (const m of masked.matchAll(MATH_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    mathRanges.push({ start, end });
    if (m[1] !== undefined) {
      const latex = m[1].trim();
      if (latex === "") {
        problem("math_empty", start, "an empty formula");
        continue;
      }
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const nl = text.indexOf("\n", end);
      const lineEnd = nl === -1 ? text.length : nl;
      const before = text.slice(lineStart, start);
      const after = text.slice(end, lineEnd);
      const alone = /^[ \t]*$/.test(before) && /^[ \t]*$/.test(after);
      if (options.blockDisplay && alone && before === "") {
        displays.push({ lineStart, lineEnd, start, latex });
      } else if (options.blockDisplay && alone) {
        problem(
          "math_display_indented",
          start,
          "a display equation must start at the beginning of its line (no indentation, so it cannot be mistaken for part of a list item)"
        );
      } else {
        problem(
          "math_display_inline",
          start,
          "a $$...$$ display equation must be alone on its lines; use $...$ for a formula inside a sentence"
        );
      }
    } else {
      items.push({ kind: "math", start, end, where: start, latex: m[2] as string, bad: false });
    }
  }
  masked = blankRanges(masked, mathRanges);
  for (const m of masked.matchAll(UNCLOSED_DISPLAY_RE))
    problem("math_unclosed", m.index ?? 0, "a $$ display equation is opened here and never closed");

  // ---- [cite: ...] / [ref: ...] ---------------------------------------------------------------------------------
  const tokenItems: Item[] = [];
  const re = new RegExp(TOKEN_RE.source, "g");
  let unclosedUntil = -1;
  for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
    const kind = m[1] as "cite" | "ref";
    const start = m.index;
    const bodyStart = start + m[0].length;
    let j = bodyStart;
    let closed = false;
    // a start inside a region already known to hold no closing ']' is unclosed too, without scanning it again
    if (start < unclosedUntil) {
      problem(`${kind}_unclosed`, start, `[${kind}: ... is not closed with ']'`);
      re.lastIndex = bodyStart;
      continue;
    }
    while (j < masked.length) {
      const c = masked[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "]") {
        closed = true;
        break;
      }
      if (c === "\n" && BLANK_LINE_AT.test(masked.slice(j, j + 400))) break;
      j += 1;
    }
    if (!closed) {
      unclosedUntil = j;
      problem(`${kind}_unclosed`, start, `[${kind}: ... is not closed with ']'`);
      re.lastIndex = bodyStart;
      continue;
    }
    re.lastIndex = j + 1;
    const pipe = unescapedPipe(masked, bodyStart, j);
    const idsPart = text.slice(bodyStart, pipe === -1 ? j : pipe);
    const displayRaw = pipe === -1 ? undefined : text.slice(pipe + 1, j);
    const item: Item = { kind, start, end: j + 1, where: start, bad: false };
    if (displayRaw !== undefined) {
      const display = unescapeTokenText(displayRaw);
      if (display === "") {
        item.bad = true;
        problem(`${kind}_syntax`, start, `the display text after '|' is empty`);
      } else item.display = display;
    }
    if (kind === "cite") {
      const ids = idsPart.split(";").map((s) => s.trim());
      const wrong = ids.find((id) => !TEXT_ID_PATTERN.test(id));
      if (wrong !== undefined) {
        item.bad = true;
        problem(
          "cite_syntax",
          start,
          "a [cite: ...] needs reference ids made of letters, digits and _ . : - separated by ';'",
          wrong
        );
      } else item.ids = ids;
    } else {
      const id = idsPart.trim();
      if (!TEXT_ID_PATTERN.test(id)) {
        item.bad = true;
        problem(
          "ref_syntax",
          start,
          "a [ref: ...] needs one target id made of letters, digits and _ . : -",
          id
        );
      } else item.ids = [id];
    }
    tokenItems.push(item);
  }

  // a math span inside a token's display text is just that text; a display equation cannot sit in a token
  // tokenItems are in position order and do not overlap: binary search for the last one starting at or before pos
  const inToken = (pos: number): Item | undefined => {
    let low = 0;
    let high = tokenItems.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const t = tokenItems[mid] as Item;
      if (pos < t.start) high = mid - 1;
      else if (pos >= t.end) low = mid + 1;
      else return t;
    }
    return undefined;
  };
  const keptItems = items.filter((it) => inToken(it.start) === undefined);
  for (const d of displays.slice()) {
    const t = inToken(d.start);
    if (t !== undefined) {
      t.bad = true;
      problem(
        `${t.kind}_syntax`,
        t.start,
        "a display equation cannot be inside a [cite: ...] or [ref: ...]"
      );
      displays.splice(displays.indexOf(d), 1);
    }
  }
  const all = [...keptItems, ...tokenItems].sort((a, b) => a.start - b.start);

  // ---- the lexer's text -----------------------------------------------------------------------------------------
  const cuts: { start: number; end: number; text: string }[] = [];
  for (const it of all)
    cuts.push({
      start: it.start,
      end: it.end,
      text: PH_OPEN + PH_FILL.repeat(it.end - it.start - 2) + PH_CLOSE,
    });
  for (const d of displays)
    cuts.push({
      start: d.lineStart,
      end: d.lineEnd,
      text: blank(text.slice(d.lineStart, d.lineEnd)),
    });
  cuts.sort((a, b) => a.start - b.start);
  let lexText = "";
  let at = 0;
  for (const c of cuts) {
    lexText += text.slice(at, c.start) + c.text;
    at = c.end;
  }
  lexText += text.slice(at);

  displays.sort((a, b) => a.start - b.start);
  problems.sort((a, b) => a.offset - b.offset);
  return { items: all, displays, problems, lexText };
}
