/**
 * pandoc CLI adapter — ports `bibgraph/ingest_latex/pandoc_ast.py` (LaTeX →
 * JSON AST, fragment → blocks, .bib → CSL-JSON) and the pandoc half of
 * `bibgraph/ingest_html/mathml.py` (MathML → LaTeX).
 *
 * The pure KaTeX-cleanup transforms (`katexify`, `stripMathDelims`) also live
 * here: they exist solely to map *pandoc's* LaTeX output onto KaTeX's command
 * set, core has no consumer for them, and M1a/M1b deliberately left them with
 * the adapter.
 *
 * pandoc discovery: `pandoc` is looked up on PATH lazily at each call (the
 * Python module resolves it once at import time — lazy lookup lets a test or
 * CLI process amend PATH after startup; a benign, documented improvement).
 * The absence error names PATH and the astro conda env explicitly.
 */

import { statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { findOnPath, runCapture } from "../lib/proc.js";

/** pandoc could not parse the input (hard syntax error, missing binary…). */
export class PandocError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PandocError";
  }
}

/** The astro env's bin dir, named in the missing-pandoc error for actionability. */
export const ASTRO_BIN_HINT = "/home/wwu/miniforge3/envs/astro/bin";

/** `shutil.which("pandoc")`, resolved lazily. */
export function pandocPath(): string | null {
  return findOnPath("pandoc");
}

export function havePandoc(): boolean {
  return pandocPath() !== null;
}

function runPandoc(
  args: readonly string[],
  opts: { cwd?: string; stdin?: string; timeout?: number } = {}
): string {
  const bin = pandocPath();
  if (!bin) {
    throw new PandocError(
      "pandoc is not installed (required for LaTeX ingest): no `pandoc` on PATH. " +
        `It ships with the astro conda env — add ${ASTRO_BIN_HINT} to PATH.`
    );
  }
  const timeout = opts.timeout ?? 180;
  const proc = runCapture([bin, ...args], { cwd: opts.cwd, stdin: opts.stdin, timeout });
  if (proc.error) {
    const kind = (proc.error as NodeJS.ErrnoException & { signal?: string }).signal;
    if (kind === "SIGTERM" || /timed out/i.test(proc.error.message)) {
      throw new PandocError(`pandoc timed out after ${timeout}s`);
    }
    throw new PandocError(`pandoc invocation failed: ${proc.error.message}`);
  }
  if (proc.status !== 0) {
    const tail = proc.stderr.trim().split("\n").slice(-3);
    throw new PandocError(tail.join("; ") || `pandoc rc=${proc.status}`);
  }
  return proc.stdout;
}

/** `latex_to_ast`: parse `mainTex` into the pandoc JSON AST (run from its dir). */
export function latexToAst(mainTex: string): Record<string, unknown> {
  const name = basename(mainTex);
  // './'-prefix so a filename starting with '-' can't be read as a pandoc flag.
  const arg = name.startsWith("-") ? `./${name}` : name;
  const out = runPandoc(["-f", "latex", "-t", "json", arg], { cwd: dirname(mainTex) });
  return JSON.parse(out) as Record<string, unknown>;
}

/**
 * `fragment_to_blocks`: a free-standing LaTeX fragment → AST blocks, wrapped
 * in a minimal article so `$…$` maths and `\cite` keys still parse. Parse
 * failure warns (returns []) rather than throwing, like the Python.
 */
export function fragmentToBlocks(latex: string, srcDir?: string): unknown[] {
  const doc = `\\documentclass{article}\\usepackage{amsmath}\\begin{document}\n${latex}\n\\end{document}\n`;
  try {
    const out = runPandoc(["-f", "latex", "-t", "json"], { cwd: srcDir, stdin: doc });
    const ast = JSON.parse(out) as { blocks?: unknown[] };
    return ast.blocks ?? [];
  } catch {
    return [];
  }
}

/** `bibtex_to_csl`: read one or more .bib files into CSL-JSON entries. */
export function bibtexToCsl(
  bibFiles: readonly string[],
  srcDir?: string
): Record<string, unknown>[] {
  const files = bibFiles.filter((f) => fileExists(f)).map((f) => resolve(f));
  if (files.length === 0) return [];
  try {
    const out = runPandoc(["-f", "bibtex", "-t", "csljson", ...files], { cwd: srcDir });
    const parsed: unknown = JSON.parse(out);
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

// --------------------------------------------------------------------------- //
// MathML → LaTeX (ingest_html/mathml.py)
// --------------------------------------------------------------------------- //

// pandoc wraps display math in \[..\] and inline in \(..\); strip either.
const DELIMS: ReadonlyArray<readonly [string, string]> = [
  ["\\[", "\\]"],
  ["\\(", "\\)"],
  ["$$", "$$"],
  ["$", "$"],
];

/**
 * `mathml_to_latex`: one `<math>...</math>` HTML string → LaTeX, or undefined.
 * Fallback for when the publisher exposes no source LaTeX (a `data-latex`
 * attribute or `<annotation encoding="application/x-tex">` is always
 * preferred — that DOM read is cheerio-side, ported with the M3 adapters).
 */
export function mathmlToLatex(mathHtml: string): string | undefined {
  if (!havePandoc() || !mathHtml?.includes("<math")) return undefined;
  const doc = `<!DOCTYPE html><html><body><p>${mathHtml}</p></body></html>`;
  let out: string;
  try {
    out = runPandoc(["-f", "html", "-t", "latex"], { stdin: doc, timeout: 20 });
  } catch {
    return undefined; // pandoc failure degrades to "no math", like the Python
  }
  return katexify(stripMathDelims(out.trim()));
}

// pandoc emits a few LaTeX commands KaTeX doesn't implement; map them to
// KaTeX-supported equivalents (spacing differences are cosmetic).
const MSPACE_RE = /\\mspace\s*\{[^}]*\}/g;

/** `_katexify`: `\mspace{6mu}` → `\;` etc. */
export function katexify(latex: string): string {
  return latex
    .replace(MSPACE_RE, "\\;")
    .replaceAll("\\medspace", "\\;")
    .replaceAll("\\thickspace", "\\;");
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

function fileExists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
