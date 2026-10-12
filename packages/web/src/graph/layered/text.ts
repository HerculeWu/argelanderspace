/** Short-label measuring and wrapping shared by the layered layout and the renderer (pure). */

/** Largest font size a label is ever drawn at, in layout units (it is drawn smaller when the view is zoomed in). */
export const LABEL_FONT_MAX = 14;
/** Smallest zoom at which the label font still grows to compensate; below it labels shrink with the picture. */
export const LABEL_ZOOM_FLOOR = 0.75;

/** Full-width characters (CJK and the like): one em each, a break may fall between any two. */
const WIDE = /[\u2E80-\uFFFF]/;

/**
 * Advance width in em of one character. The label font is a proportional sans, and the estimate is made without
 * measuring: it is deliberately a little above the common fonts so a column reserved from it is never narrower than
 * the text drawn in it. Classes: narrow punctuation and letters (i j l . , : ; ! ' |, space), thin (f t r I J,
 * brackets, hyphen), lower case, wide lower case (m w), digits, upper case, wide upper case (C D G H N O Q U),
 * the widest (M W), wide symbols (& @ % # ~ + =), other.
 */
const NARROW = new Set([..."ijl.,:;!'|`´’ "]);
const THIN = new Set([..."frtIJ()[]{}/\\-–\"*“”‘"]);
const WIDE_UPPER = new Set([..."CDGHNOQU"]);
const WIDE_SYMBOL = new Set([..."&@%#~+=<>—…"]);
const charUnits = (ch: string): number => {
  if (WIDE.test(ch)) return 1;
  if (NARROW.has(ch)) return 0.34;
  if (THIN.has(ch)) return 0.45;
  if (ch === "W") return 1.05;
  if (ch === "M") return 0.95;
  if (WIDE_UPPER.has(ch)) return 0.84;
  if (ch === "m" || ch === "w") return 0.95;
  if (ch >= "A" && ch <= "Z") return 0.72;
  if (ch >= "a" && ch <= "z") return 0.6;
  if (ch >= "0" && ch <= "9") return 0.64;
  if (WIDE_SYMBOL.has(ch)) return 1;
  return 0.7;
};

/** Width of a text in em, summed per character. */
export const textUnits = (s: string): number => [...s].reduce((n, ch) => n + charUnits(ch), 0);

/**
 * Break opportunities: a run of full-width characters breaks between any two; other text breaks at white space
 * and after a hyphen. A white-space run is its own token.
 */
const TOKEN = /\s+|[^\s\u2E80-\u{10FFFF}-]*-+|[^\s\u2E80-\u{10FFFF}-]+|[\u2E80-\u{10FFFF}]/gu;

/** Shorten a line that is cut off by the limit and end it with an ellipsis that still fits the width. */
function ellipsize(line: string, max: number): string {
  const chars = [...line.trimEnd()];
  // a full-width last character gives way to the ellipsis whole; text ends at a word, so the ellipsis follows it when it fits
  if (chars.length && WIDE.test(chars[chars.length - 1]!)) chars.pop();
  while (chars.length && textUnits(chars.join("")) + textUnits("…") > max) chars.pop();
  return chars.join("").trimEnd() + "…";
}

/**
 * A short label on at most two lines of `max` em. Latin text breaks at spaces and hyphens; a single word longer
 * than a line breaks inside the word; full-width text breaks anywhere. The second line ends with an ellipsis when
 * the text did not fit.
 */
export function wrapLabel(s: string, max = 9): string[] {
  const tokens: string[] = [];
  for (const t of s.match(TOKEN) ?? []) {
    // a word longer than a line is broken character by character
    if (!/^\s/.test(t) && textUnits(t) > max) tokens.push(...[...t]);
    else tokens.push(t);
  }
  const lines: string[] = [];
  let cur = "";
  let w = 0;
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    const tw = textUnits(t);
    if (/^\s/.test(t)) {
      // white space never starts a line and never needs a line of its own
      if (cur) {
        cur += " ";
        w += charUnits(" ");
      }
      continue;
    }
    if (w + tw > max && cur) {
      lines.push(cur.trimEnd());
      cur = "";
      w = 0;
      if (lines.length === 2) break;
    }
    cur += t;
    w += tw;
  }
  if (lines.length < 2 && cur.trim()) lines.push(cur.trim());
  else if (i < tokens.length) lines[1] = ellipsize(lines[1]!, max);
  return lines.map((l) => l.trim());
}

/** Width in layout units reserved for a label: its widest line at the largest size it is drawn. */
export const labelWidth = (label: string): number =>
  Math.max(...wrapLabel(label || "—").map(textUnits), 0) * LABEL_FONT_MAX;
