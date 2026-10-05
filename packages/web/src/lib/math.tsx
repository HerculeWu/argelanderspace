import katex from "katex";
import { MATH_RENDER_MAX_CHARS, findMacroCommand, mathBaseOptions } from "@argelanderspace/contracts";
import i18n from "../i18n";

/** Strip $/$$ delimiters, \tag{}, \label{}, and surrounding whitespace. */
export function cleanLatex(src: string): string {
  let s = (src ?? "").trim();
  s = s.replace(/^\$\$?/, "").replace(/\$\$?$/, "").trim();
  // one level of brace nesting (e.g. \label{eq:a_{0}}) so we don't leave a stray }
  s = s.replace(/\\tag\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  s = s.replace(/\\label\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
  return s.trim();
}

/** Collapse multi-row LaTeX environments to a single visual row (for one-line
 *  previews); aligned/cases/array etc. are unwrapped and \\ / & become spaces. */
export function flattenLatex(src: string): string {
  let x = cleanLatex(src);
  x = x.replace(
    /\\(?:begin|end)\s*\{(?:aligned?|align\*?|cases|gather\*?|gathered|array|split|matrix|eqnarray\*?)\}(?:\{[^}]*\})?/g,
    ""
  );
  x = x.replace(/\\\\(\[[^\]]*\])?/g, " ");
  x = x.replace(/&/g, " ");
  return x.trim();
}

/**
 * KaTeX is synchronous and cannot be interrupted, and its cost is superlinear in the output: a 400 KB formula takes over
 * a minute, a few-thousand-character macro used forty times tens of seconds. A published text Doc must not be able to
 * freeze the tab, so the Reader bounds the work in four ways and shows the SOURCE with a notice instead of typesetting:
 * - a formula over {@link MATH_RENDER_MAX_CHARS} characters;
 * - a macro-defining command in a formula over {@link MACRO_GUARD_CHARS} characters (text Docs refuse them anyway);
 * - once the formulas over {@link LARGE_FORMULA_CHARS} characters typeset so far in this document have used
 *   {@link LARGE_TOTAL_CHARS} characters (the count restarts for each document, see `resetMathBudget`);
 * - the same KaTeX options as validation (`maxExpand` among them), from contracts.
 * The notice keeps the `.math-error` root class so the annotation text map treats it as the same atom.
 */
export { MATH_RENDER_MAX_CHARS };
const OVERSIZE_SHOWN_CHARS = 4_000;
const MACRO_GUARD_CHARS = 300;
const LARGE_FORMULA_CHARS = 2_000;
const LARGE_TOTAL_CHARS = 60_000;

let largeSpent = 0;
/** Large formulas already decided for this document (typeset or shown as source): a re-render costs nothing. */
const largeSeen = new Map<string, string>();

/** A new document starts with a fresh typesetting budget. */
export function resetMathBudget(): void {
  largeSpent = 0;
  largeSeen.clear();
}

function sourceInstead(latex: string, note: string): string {
  const shown = latex.length > OVERSIZE_SHOWN_CHARS ? `${latex.slice(0, OVERSIZE_SHOWN_CHARS)}…` : latex;
  return `<span class="math-error math-oversize" title="${escapeHtml(note)}"><span class="math-oversize-note">${escapeHtml(note)}</span> <code>${escapeHtml(shown)}</code></span>`;
}

export function renderMathToString(latex: string, displayMode = false): string {
  if (latex.length > MATH_RENDER_MAX_CHARS)
    return sourceInstead(latex, i18n.t("doc.mathTooLarge", { count: latex.length }));
  const large = latex.length > LARGE_FORMULA_CHARS;
  const key = large ? `${displayMode ? 1 : 0}:${latex}` : "";
  if (large) {
    const seen = largeSeen.get(key);
    if (seen !== undefined) return seen;
  }
  if (latex.length > MACRO_GUARD_CHARS && findMacroCommand(latex) !== null)
    return sourceInstead(latex, i18n.t("doc.mathMacroNotTypeset"));
  if (large && largeSpent + latex.length > LARGE_TOTAL_CHARS) {
    const html = sourceInstead(latex, i18n.t("doc.mathBudgetUsed"));
    largeSeen.set(key, html);
    return html;
  }
  let html: string;
  try {
    html = katex.renderToString(latex, {
      ...mathBaseOptions(displayMode),
      throwOnError: false,
      errorColor: "#b00020",
    });
  } catch {
    html = `<span class="math-error">${escapeHtml(latex)}</span>`;
  }
  if (large) {
    largeSpent += latex.length;
    largeSeen.set(key, html);
  }
  return html;
}

export function Math({
  latex,
  display = false,
  className,
}: {
  latex: string;
  display?: boolean;
  className?: string;
}) {
  const html = renderMathToString(cleanLatex(latex), display);
  return (
    <span
      className={className}
      // KaTeX output is generated from our own LaTeX strings, not user input.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Render inline $...$ / display $$...$$ inside a plain-text string to HTML,
 *  escaping the non-math remainder so it is safe to inject. */
function inlineMathInText(s: string): string {
  let out = "";
  let last = 0;
  // display math first, then inline; both confined to this text fragment
  const re = /\$\$([\s\S]+?)\$\$|\$(?!\$)([^$]+?)\$/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out += escapeHtml(s.slice(last, m.index));
    if (m[1] !== undefined) out += renderMathToString(cleanLatex(m[1]), true);
    else out += renderMathToString(cleanLatex(m[2]), false);
    last = re.lastIndex;
  }
  out += escapeHtml(s.slice(last));
  return out;
}

/** Replace $...$ spans with rendered KaTeX inside an HTML string, operating on
 *  TEXT NODES only. This preserves the markup structure (e.g. table colspans)
 *  and prevents a stray '$' from pairing across tags/cells, while still allowing
 *  '<'/'>' inequalities inside a single cell's math. */
export function htmlWithMath(html: string): string {
  try {
    const doc = new DOMParser().parseFromString(html ?? "", "text/html");
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) texts.push(node as Text);
    for (const t of texts) {
      const s = t.nodeValue ?? "";
      if (s.indexOf("$") === -1) continue;
      const span = doc.createElement("span");
      span.innerHTML = inlineMathInText(s);
      t.replaceWith(...Array.from(span.childNodes));
    }
    return doc.body.innerHTML;
  } catch {
    return html ?? "";
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}
