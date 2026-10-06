/**
 * Inline-syntax scan of an `argelander-text` source: the pass that runs BEFORE the Markdown lexer.
 *
 * The lexer would reduce `$a *b* c$` to `a b c` and `[cite: a | *x*]` to `x`, so math, `[cite: ...]` and `[ref: ...]`
 * are found first, in the order of the Reader's own Markdown-with-math display path (`web/src/lib/mdWithMath.ts`):
 *
 * 1. literal zones are blanked: fenced code (CommonMark: a fence opens at a line start and closes on a line of the same
 *    character with at least the same length), code spans (never across a blank line; a backslash-escaped backtick is
 *    literal), bare URLs;
 * 2. math: `$$...$$` and `$...$` with texmath's boundary rules (an opening `$` needs a non-space after it and no
 *    backslash before it; a closing `$` needs a non-space before it and no digit or `$` after it, so currency such as
 *    `$100 to $200` stays text). The DELIMITERS are found outside code and URLs; the formula is read from the source,
 *    so a code span or URL inside a formula stays part of it (and is reported);
 * 3. in what is left, `[cite: id;id | display]` and `[ref: id | display]`. A token starts outside code, math and URLs
 *    and ends at the first unescaped `]` outside code and math (a `]` inside a bare URL ends it, so an unclosed-looking
 *    URL cannot swallow the next token).
 *
 * Each inline find becomes an {@link Item} and is replaced in the text handed to the lexer by a placeholder run of the
 * SAME length (so every offset the lexer reports is still an offset of the source). A display equation that fills its
 * lines is a block: its lines are blanked (newlines kept), and it is returned separately, in position order. A display
 * equation in the middle of text is an item of kind `display` that the caller turns into its own block.
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
  kind: "math" | "display" | "cite" | "ref";
  /** Offset of the first character of the find in the source. */
  start: number;
  end: number;
  /** Where a diagnostic about this find is reported (the find itself; a caption field for caption text). */
  where: number;
  /** math / display: the formula between the delimiters, read from the source text. */
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
  severity?: "warning";
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

// a code span cannot cross a blank line (CommonMark: it lives inside one paragraph/block); a backslash-escaped backtick
// is literal text (the escape pair is consumed first, left to right, like the lexer does)
const CODE_SPAN_RE = /\\[\s\S]|(`+)((?:(?!\n[ \t]*\n)[\s\S])*?)\1(?!`)/g;
const URL_RE = /(?:https?|ftp):\/\/[^\s<>]*/g;
const MATH_RE = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<!\\)\$(?!\$)(?!\s)([^$\n]+?)(?<!\s)\$(?![\d$])/g;
const UNCLOSED_DISPLAY_RE = /(?<!\\)\$\$/g;
const TOKEN_RE = /(?<!\\)\[(cite|ref):/g;
const BLANK_LINE_AT = /^\n[ \t]*\n/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;

const blank = (m: string): string => m.replace(/[^\n]/g, " ");

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

/**
 * Fenced code, exactly as the lexer (`marked`) sees it: an opening fence is 3+ backticks or tildes at the start of a
 * line (at most 3 spaces of indentation; a backtick fence's info string has no backtick). It closes at the first line
 * that starts (at most 3 spaces in) with the SAME opening run, may continue with more fence characters of either kind,
 * and ends with spaces only (a tab does not close it, like marked). A fence that never closes runs to the end of the
 * text. A ``` in the middle of a line is an inline code span, not a fence. `text` has no lone CR (see scanSyntax).
 */
function maskFences(text: string): string {
  const ranges: { start: number; end: number }[] = [];
  let open: { close: RegExp; from: number } | null = null;
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    if (open === null) {
      const m = FENCE_OPEN.exec(line);
      if (m !== null) {
        const run = m[1] as string;
        if (!(run[0] === "`" && (m[2] as string).includes("`")))
          open = { close: new RegExp(`^ {0,3}${run}[~\`]* *$`), from: pos };
      }
    } else if (open.close.test(line)) {
      ranges.push({ start: open.from, end });
      open = null;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (open !== null) ranges.push({ start: open.from, end: text.length });
  return blankRanges(text, ranges);
}

/** Fences and code spans blanked (same length, same newlines). */
function maskCode(text: string): string {
  return maskFences(text).replace(CODE_SPAN_RE, (m, ticks) => (ticks === undefined ? m : blank(m)));
}

/** Same length, same newlines, every literal-zone character blanked: code, then bare URLs. */
export function maskLiteralZones(text: string): string {
  return maskCode(text).replace(URL_RE, blank);
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

export function scanSyntax(source: string, options: { blockDisplay: boolean }): Scan {
  // The scan sees the lexer's line structure: `marked` reads a lone CR as a line break, so the scan does too (same
  // length, so every offset is still an offset of the source). Formulas are read from `source`, byte for byte.
  const text = source.replace(/\r/g, "\n");
  const items: Item[] = [];
  const displays: DisplayMath[] = [];
  const problems: Problem[] = [];
  const problem = (
    code: string,
    offset: number,
    message: string,
    subject?: string,
    severity?: "warning"
  ): void => {
    problems.push({
      code,
      offset,
      message,
      ...(subject !== undefined ? { subject } : {}),
      ...(severity !== undefined ? { severity } : {}),
    });
  };

  // Two masks: `masked` (code and URLs blanked) finds math and token starts; `codeMasked` (code only) closes a token.
  const codeMasked0 = maskCode(text);
  let masked = codeMasked0.replace(URL_RE, blank);

  // ---- math ---------------------------------------------------------------------------------------------------
  const mathRanges: { start: number; end: number }[] = [];
  for (const m of masked.matchAll(MATH_RE)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    mathRanges.push({ start, end });
    if (masked.slice(start, end) !== text.slice(start, end))
      problem(
        "math_contains_code",
        start,
        "a code span or URL inside a formula is kept as part of the formula",
        undefined,
        "warning"
      );
    if (m[1] !== undefined) {
      const latex = source.slice(start + 2, end - 2).trim();
      if (latex === "") {
        problem("math_empty", start, "an empty formula");
        continue;
      }
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      const nl = text.indexOf("\n", end);
      const lineEnd = nl === -1 ? text.length : nl;
      const alone =
        /^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t]*$/.test(text.slice(end, lineEnd));
      if (!options.blockDisplay) {
        problem(
          "math_display_inline",
          start,
          "a $$...$$ display equation is not allowed here; use $...$"
        );
      } else if (alone) {
        displays.push({ lineStart, lineEnd, start, latex });
      } else {
        // in the middle of text: a display formula that ends the paragraph before it and starts a new one after it
        items.push({ kind: "display", start, end, where: start, latex, bad: false });
      }
    } else {
      items.push({
        kind: "math",
        start,
        end,
        where: start,
        latex: source.slice(start + 1, end - 1),
        bad: false,
      });
    }
  }
  masked = blankRanges(masked, mathRanges);
  const codeMasked = blankRanges(codeMasked0, mathRanges);
  // A bare URL is a literal zone: it can swallow the closing `$` of a formula (`$\\href{http://x}{y}$`), which then
  // stays text. Say so where an unmatched `$` precedes such a URL on its line.
  for (const m of codeMasked0.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    if (!m[0].endsWith("$")) continue; // the closing $ of a formula is the URL's last character
    const lineStart = text.lastIndexOf("\n", at - 1) + 1;
    if (/(?<!\\)\$/.test(masked.slice(lineStart, at)))
      problem(
        "math_url_swallowed",
        at,
        "a bare URL swallows a $ here, so the formula before it is not closed; put a space after the URL or leave the URL out of the formula",
        undefined,
        "warning"
      );
  }
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
    while (j < codeMasked.length) {
      const c = codeMasked[j];
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "]") {
        closed = true;
        break;
      }
      if (c === "\n" && BLANK_LINE_AT.test(codeMasked.slice(j, j + 400))) break;
      j += 1;
    }
    if (!closed) {
      unclosedUntil = j;
      problem(`${kind}_unclosed`, start, `[${kind}: ... is not closed with ']'`);
      re.lastIndex = bodyStart;
      continue;
    }
    re.lastIndex = j + 1;
    const pipe = unescapedPipe(codeMasked, bodyStart, j);
    const idsPart = text.slice(bodyStart, pipe === -1 ? j : pipe);
    const displayRaw = pipe === -1 ? undefined : text.slice(pipe + 1, j);
    // `[cite: a | [12]]` ends at the first `]`: the display text keeps an unclosed `[` and the last `]` is stray text.
    // Escape the brackets (`\\[12\\]`) or leave them out.
    if (displayRaw !== undefined && codeMasked[j + 1] === "]") {
      const plain = displayRaw.replace(/\\[\s\S]/g, "");
      if (plain.split("[").length > plain.split("]").length)
        problem(
          `${kind}_stray_bracket`,
          start,
          `the display text of this [${kind}: ...] has an unescaped '[' so the token ends at the first ']' and the next ']' is stray text; write \\[ and \\] for literal brackets`,
          undefined,
          "warning"
        );
    }
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
  const keptItems: Item[] = [];
  for (const it of items) {
    const t = inToken(it.start);
    if (t === undefined) keptItems.push(it);
    else if (it.kind === "display") {
      t.bad = true;
      problem(
        `${t.kind}_syntax`,
        t.start,
        "a display equation cannot be inside a [cite: ...] or [ref: ...]"
      );
    }
  }
  const keptDisplays: DisplayMath[] = [];
  for (const d of displays) {
    const t = inToken(d.start);
    if (t === undefined) keptDisplays.push(d);
    else {
      t.bad = true;
      problem(
        `${t.kind}_syntax`,
        t.start,
        "a display equation cannot be inside a [cite: ...] or [ref: ...]"
      );
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
  for (const d of keptDisplays)
    cuts.push({
      start: d.lineStart,
      end: d.lineEnd,
      text: blank(text.slice(d.lineStart, d.lineEnd)),
    });
  cuts.sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let at = 0;
  for (const c of cuts) {
    parts.push(text.slice(at, c.start), c.text);
    at = c.end;
  }
  parts.push(text.slice(at));

  keptDisplays.sort((a, b) => a.start - b.start);
  problems.sort((a, b) => a.offset - b.offset);
  return { items: all, displays: keptDisplays, problems, lexText: parts.join("") };
}
