/**
 * Text-level helpers for the fuse layer: KaTeX cleanup (ported from the
 * retired walker's `katexify`), typography fixes pandoc used to give us for
 * free (dashes, quotes), and the literal-dollar shielding the reader's
 * `$…$` scanner needs (old `emitPlain` semantics).
 */

const MSPACE_RE = /\\mspace\s*\{[^}]*\}/g;
const TEXTSUB_RE = /\\textsubscript\s*\{([^{}]*)\}/g;
const TEXTSUP_RE = /\\textsuperscript\s*\{([^{}]*)\}/g;
const CTRLSPACE_RE = /(?<!\\)\\ /g;

// Astronomy macros from aastex / aas_macros / mn2e classes -> KaTeX-renderable
// equivalents (math mode only).
const ASTRO_MACROS: ReadonlyArray<readonly [string, string]> = [
  ["sun", "\\odot"],
  ["Sun", "\\odot"],
  ["earth", "\\oplus"],
  ["Earth", "\\oplus"],
  ["degr", "^{\\circ}"],
  ["arcdeg", "^{\\circ}"],
  ["fdg", "^{\\circ}"],
  ["arcmin", "'"],
  ["arcsec", "''"],
  ["farcm", "'"],
  ["farcs", "''"],
  ["micron", "\\,\\mu m"],
  ["sq", "\\Box"],
  ["ion", "\\,"],
];
const ASTRO_BY_NAME = new Map(ASTRO_MACROS);
const ASTRO_RE = new RegExp(
  `\\\\(${[...ASTRO_MACROS]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k]) => k)
    .join("|")})(?![a-zA-Z])`,
  "g"
);

/** Map the handful of commands authors use that KaTeX doesn't implement. */
export function katexify(latex: string): string {
  let out = latex.replace(MSPACE_RE, "\\;");
  out = out.replaceAll("\\medspace", "\\;").replaceAll("\\thickspace", "\\;");
  out = out.replace(TEXTSUB_RE, "_{$1}"); // keep math mode: content may
  out = out.replace(TEXTSUP_RE, "^{$1}"); // be a symbol (\lambda), not text
  out = out.replace(ASTRO_RE, (_m, name: string) => ASTRO_BY_NAME.get(name) ?? _m);
  if (out.includes("$")) {
    // text-embedded math ($k$): the inner $ would split our $…$ span
    out = out.replaceAll("$", "");
  }
  out = out.replace(CTRLSPACE_RE, " "); // \  -> plain space
  out = out.replace(/\\+\s*$/, ""); // drop any dangling trailing \
  return out;
}

/**
 * Typography normalization pandoc applied (smart quotes / dashes / ties)
 * plus whitespace collapse. Applied per emitted text chunk.
 */
export function textify(s: string): string {
  let out = s.replaceAll(" ", " ");
  out = out.replaceAll("~", " ");
  out = out.replace(/---/g, "—").replace(/--/g, "–");
  out = out.replace(/``/g, "“").replace(/''/g, "”");
  out = out.replace(/`(?!`)/g, "‘").replace(/'(?!')/g, "’");
  out = out.replace(/\s+/gu, " ");
  return out;
}

/**
 * Split a plain-text chunk on literal "$": each dollar becomes a KaTeX
 * `\char36` math glyph so the reader's `$…$` scanner can't mis-pair
 * (the old walker's emitPlain). Returns text/math fragment pairs.
 */
export function dollarSafe(s: string): Array<{ kind: "text" | "math"; text: string }> {
  if (!s.includes("$")) return s === "" ? [] : [{ kind: "text", text: s }];
  const parts = s.split("$");
  const out: Array<{ kind: "text" | "math"; text: string }> = [];
  for (const [i, part] of parts.entries()) {
    if (part !== "") out.push({ kind: "text", text: part });
    if (i < parts.length - 1) out.push({ kind: "math", text: "\\char36" });
  }
  return out;
}

/** HTML-escape (table cells). */
export function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
