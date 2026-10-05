/**
 * Formula validation for the text codec: the same KaTeX, with the same options as the Reader's shared math display
 * (`web/src/lib/math.tsx`), but throwing, so a formula the Reader would paint as an error is reported at the line that
 * wrote it. `trust` stays off (KaTeX's default): `\href`, `\url`, `\includegraphics` and friends are not allowed.
 */
import katex from "katex";

/** The same cleaning the Reader applies before rendering: delimiters, `\tag{}` and `\label{}` are not typeset. */
export function cleanLatex(src: string): string {
  let s = (src ?? "").trim();
  s = s
    .replace(/^\$\$?/, "")
    .replace(/\$\$?$/, "")
    .trim();
  s = s.replace(/\\tag\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  s = s.replace(/\\label\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  return s.trim();
}

/** `null` when KaTeX typesets the formula, else its (single-line, bounded) parse error. */
export function katexError(latex: string, displayMode: boolean): string | null {
  try {
    katex.renderToString(cleanLatex(latex), {
      displayMode,
      throwOnError: true,
      strict: "ignore",
      output: "html",
      macros: { "\\ensuremath": "#1" },
    });
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = message.replace(/\s+/g, " ").trim();
    return line.length > 200 ? `${line.slice(0, 197)}...` : line;
  }
}
