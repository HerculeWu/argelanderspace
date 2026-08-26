/**
 * Helpers that keep ported Python `re`/`str` semantics intact under JS.
 *
 * - Python's `\b` is Unicode-aware (`\w` = Unicode letters/numbers + `_`); the JS
 *   `\b` is ASCII-only even under /u. `pyRe` rewrites every `\b` in a pattern to an
 *   equivalent pair of lookarounds so the ported regexes behave like CPython's `re`
 *   (this matters for e.g. "Åström (2019)", where a Python word boundary exists
 *   before "Å" but an ASCII `\b` would find none).
 * - `stripChars` / `rstripChars` mirror Python's `str.strip(chars)` / `str.rstrip(chars)`.
 * - `pyOr` mirrors Python's `or` chain, where empty strings/lists/dicts are falsy
 *   (in JS, `[]` and `{}` are truthy, so `??` / `||` alone would diverge).
 */

const PY_WORD_CHAR = "[\\p{L}\\p{N}_]";
const PY_WORD_BOUNDARY = `(?:(?<!${PY_WORD_CHAR})(?=${PY_WORD_CHAR})|(?<=${PY_WORD_CHAR})(?!${PY_WORD_CHAR}))`;

/**
 * Compile a Python `re` pattern string, rewriting `\b` to Unicode-aware lookarounds.
 * The `u` flag is always added (required for `\p{...}` in the rewritten boundaries).
 */
export function pyRe(pattern: string, flags: string): RegExp {
  const uFlags = flags.includes("u") ? flags : `${flags}u`;
  return new RegExp(pattern.replace(/\\b/g, PY_WORD_BOUNDARY), uFlags);
}

/** Mirror Python `text.strip(chars)`: strip any char in `chars` from both ends. */
export function stripChars(text: string, chars: string): string {
  const cls = escapeClass(chars);
  return text.replace(new RegExp(`^[${cls}]+|[${cls}]+$`, "gu"), "");
}

/** Mirror Python `text.rstrip(chars)`. */
export function rstripChars(text: string, chars: string): string {
  return text.replace(new RegExp(`[${escapeClass(chars)}]+$`, "u"), "");
}

/**
 * Mirror a Python `a or b or c` chain on arbitrary JSON values: skip `None`, `False`,
 * `0`, `""`, `[]` and `{}` (all falsy in Python). Returns undefined when all are falsy.
 */
export function pyOr(...values: unknown[]): unknown {
  for (const v of values) {
    if (v === null || v === undefined || v === false || v === "") continue;
    if (typeof v === "number" && v === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    return v;
  }
  return undefined;
}

/** Mirror Python truthiness on arbitrary JSON values (`None`/`False`/`0`/`""`/`[]`/`{}` are falsy). */
export function pyTruthy(v: unknown): boolean {
  return pyOr(v) !== undefined;
}

function escapeClass(chars: string): string {
  return chars.replace(/[\\\]^-]/g, "\\$&");
}
