/**
 * The DOM half of `bibgraph/ingest_html/mathml.py`: reading the publisher's
 * original LaTeX out of a MathML `<annotation>` element (pure), plus
 * `strip_math_delims` (now consumed by core's adapters — M2 had parked it in
 * infra because nothing in core used it yet). The pandoc-backed
 * `mathml_to_latex` itself stays an injected port (`HtmlMathmlPort`); infra's
 * `latex/pandoc.ts` implements it (with `katexify` applied to pandoc's output,
 * exactly like the Python).
 */

import type { Element } from "domhandler";
import { findAllWhere, getAttr, getText } from "./dom.js";

// pandoc wraps display math in \[..\] and inline in \(..\); strip either.
const DELIMS: ReadonlyArray<readonly [string, string]> = [
  ["\\[", "\\]"],
  ["\\(", "\\)"],
  ["$$", "$$"],
  ["$", "$"],
];

/** `annotation_latex`: original TeX from `<annotation encoding="application/x-tex">`. */
export function annotationLatex(mathEl: Element): string | undefined {
  let ann = findAllWhere(
    mathEl,
    (e) =>
      e.name === "annotation" &&
      ["application/x-tex", "application/x-latex"].includes(getAttr(e, "encoding") ?? "")
  )[0];
  if (!ann) {
    // some emitters omit/spell the encoding differently
    ann = findAllWhere(
      mathEl,
      (e) => e.name === "annotation" && (getAttr(e, "encoding") ?? "").toLowerCase().includes("tex")
    )[0];
  }
  if (ann) {
    const tex = getText(ann).trim();
    return tex || undefined;
  }
  return undefined;
}

/** `strip_math_delims`: drop one layer of surrounding $/$$/\[..\]/\(..\). */
export function stripMathDelims(latex: string): string {
  const s = (latex || "").trim();
  for (const [lo, hi] of DELIMS) {
    if (s.startsWith(lo) && s.endsWith(hi) && s.length > lo.length + hi.length) {
      return s.slice(lo.length, s.length - hi.length).trim();
    }
  }
  return s;
}
