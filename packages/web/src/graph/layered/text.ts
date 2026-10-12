/** Short-label measuring and wrapping shared by the layered layout and the renderer (pure). */

/** Largest font size a label is ever drawn at, in layout units (it is drawn smaller when the view is zoomed in). */
export const LABEL_FONT_MAX = 14;
/** Smallest zoom at which the label font still grows to compensate; below it labels shrink with the picture. */
export const LABEL_ZOOM_FLOOR = 0.75;

const WIDE = /[\u2E80-\uFFFF]/;

/** Width of a text in em: full-width characters 1, others 0.55. */
export const textUnits = (s: string): number => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 1 : 0.55), 0);

/** A short label on at most two lines; the second ends with an ellipsis when the text did not fit. */
export function wrapLabel(s: string, max = 9): string[] {
  const lines: string[] = [];
  const chars = [...s];
  let cur = "";
  let w = 0;
  let i = 0;
  for (; i < chars.length; i++) {
    const cw = WIDE.test(chars[i]!) ? 1 : 0.55;
    if (w + cw > max && cur) {
      lines.push(cur);
      cur = "";
      w = 0;
      if (lines.length === 2) break;
    }
    cur += chars[i];
    w += cw;
  }
  if (lines.length < 2 && cur) lines.push(cur);
  else if (i < chars.length) lines[1] = [...lines[1]!].slice(0, -1).join("") + "…";
  return lines.map((l) => l.trim());
}

/** Width in layout units reserved for a label: its widest line at the largest size it is drawn. */
export const labelWidth = (label: string): number =>
  Math.max(...wrapLabel(label || "—").map(textUnits), 0) * LABEL_FONT_MAX;
