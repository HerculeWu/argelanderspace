/**
 * What the text-Doc codec (core) and the Reader (web) agree on for formulas: the same KaTeX options and the same
 * refusal of macro-defining commands, so "valid" in validation means what the Reader will actually paint.
 *
 * KaTeX is synchronous and cannot be interrupted, and its cost is superlinear in the OUTPUT size: one defined macro of a
 * few thousand characters used forty times takes tens of seconds. Macro definitions (and the commands that can build
 * one, such as `\csname`) are therefore not typeset; `maxExpand` bounds what remains.
 */

/** KaTeX `maxExpand`: the most macro expansions per formula (the built-in macros need a handful). */
export const MATH_MAX_EXPAND = 1000;

/** A formula this long is not sent to KaTeX by the Reader, which shows its source instead. */
export const MATH_RENDER_MAX_CHARS = 40_000;

/** Fresh KaTeX options (KaTeX writes into the `macros` object, so it is never shared between calls). */
export function mathBaseOptions(displayMode: boolean): {
  displayMode: boolean;
  strict: "ignore";
  output: "html";
  maxExpand: number;
  macros: Record<string, string>;
} {
  return {
    displayMode,
    strict: "ignore",
    output: "html",
    maxExpand: MATH_MAX_EXPAND,
    // \ensuremath{…} survives macro expansion (unit/quantity shorthands); KaTeX has no such function
    macros: { "\\ensuremath": "#1" },
  };
}

/** Commands that define or build macros, or reach one indirectly. */
const MACRO_COMMANDS = new Set([
  "def",
  "gdef",
  "edef",
  "xdef",
  "let",
  "futurelet",
  "global",
  "long",
  "outer",
  "newcommand",
  "renewcommand",
  "providecommand",
  "newenvironment",
  "renewenvironment",
  "DeclareMathOperator",
  "csname",
  "expandafter",
  "noexpand",
  "afterassignment",
  "aftergroup",
  "uppercase",
  "lowercase",
]);

/**
 * The first macro-defining command in a formula, or `null`. Control sequences are read left to right (`\\` is a line
 * break, not a backslash followed by a name), so `\\def` is not a definition and `\def` is.
 */
export function findMacroCommand(latex: string): string | null {
  for (const m of latex.matchAll(/\\(\\|[a-zA-Z@]+|[\s\S])/g)) {
    const name = m[1] as string;
    if (MACRO_COMMANDS.has(name)) return `\\${name}`;
  }
  return null;
}
