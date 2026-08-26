/**
 * LaTeX→Unicode field conversion (bibtexparser 1.4.4 `latexenc.py::latex_to_unicode`).
 *
 * Python's `.bib` pipeline converts accents per field with `latex_to_unicode`
 * before de-bracing. The obvious JS replacement — letting
 * `@retorquere/bibtex-parser` translate fields — is NOT behaviorally equivalent
 * (it sentence-cases titles, keeps math macros like `\star` unconverted, and
 * renders `\&` with different spacing), so the Python algorithm + its generated
 * tables (`latexenc-data.ts`) are ported verbatim here instead; the JS parser is
 * used strictly as the BibTeX *grammar* (raw mode) in `acquire/bibtex.ts`.
 *
 * Quirks preserved bug-for-bug:
 * - Combining-accent replacement swaps the accent with the FOLLOWING character
 *   using match spans computed against the pre-mutation string, so multiple
 *   accents in one field scramble exactly like Python
 *   (e.g. `\'a\'e` → `á\` — verified against CPython).
 * - A latex key whose replacement target is a multi-char (mojibake) string —
 *   e.g. `\;`, `\NotEqualTilde` — makes Python's `unicodedata.combining` raise
 *   `TypeError`; {@link latexToUnicode} rethrows a TypeError in the same case
 *   (callers catch it, exactly like `_clean_text`'s `except Exception: pass`).
 * - NFC normalization at the end (JS `String.prototype.normalize("NFC")` ≡
 *   Python `unicodedata.normalize("NFC")` for the accent cases in scope).
 */

import { COMBINING, CRAPPY2, LATEX_PAIRS } from "./latexenc-data.js";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `_replace_latex(string, latex, unicod)`. */
function replaceLatex(string: string, latex: string, unicod: string): string {
  if (!string.includes(latex)) return string;
  // Python calls unicodedata.combining(unicod) here, which raises TypeError for
  // a multi-char argument (the mojibake table entries) — replicate the raise.
  if (unicod.length !== 1) {
    throw new TypeError("combining(): argument must be a unicode character");
  }
  if (COMBINING.has(unicod)) {
    // Matches are computed against the ORIGINAL string (Python's re.finditer
    // iterates the immutable pre-mutation object); the string is then mutated
    // using those original spans, exactly like the Python loop.
    const matches = [...string.matchAll(new RegExp(escapeRegExp(latex), "g"))];
    for (const m of matches) {
      const i = m.index;
      const j = i + latex.length;
      if (j < string.length) {
        // insert after the following character
        string = string.slice(0, i) + string[j] + unicod + string.slice(j + 1);
      } else {
        // except if in last position (nothing to modify)
        string = string.slice(0, i);
      }
    }
    return string;
  }
  // plain replace (all occurrences)
  return string.split(latex).join(unicod);
}

/** `_replace_all_latex(string, replacements)`. */
function replaceAllLatex(
  string: string,
  replacements: readonly (readonly [string, string])[]
): string {
  for (const [u, l] of replacements) {
    string = replaceLatex(string, l, u);
  }
  return string;
}

/** `latex_to_unicode(string)`. */
export function latexToUnicode(input: string): string {
  let string = input;
  if (string.includes("\\") || string.includes("{")) {
    string = replaceAllLatex(string, LATEX_PAIRS);
  }
  // remove any left braces
  string = string.replaceAll("{", "").replaceAll("}", "");
  // if there is still very crappy items
  if (string.includes("\\") || string.includes("{")) {
    string = replaceAllLatex(string, CRAPPY2);
  }
  // normalize unicode characters (NFC)
  return string.normalize("NFC");
}
