/**
 * Positional-source auto-detection for `ingest` (port of `bibgraph/cli.py`'s
 * routing, extended for local LaTeX sources). Main ingests LaTeX only:
 *
 *   arXiv id / arXiv: prefix / arxiv.org URL  → latex pipeline
 *   existing local .tex / dir / tarball        → latex pipeline
 *   DOI / http(s) URL                          → friendly error (publisher
 *     HTML/PDF ingestion is in development, archived on `ocr-features`)
 *   anything else                              → friendly error
 */

import { existsSync, statSync } from "node:fs";
import { looksLikeArxiv } from "@argelanderspace/infra";

/** Bare DOI, e.g. `10.1051/0004-6361/202038192` (inlined from the archived html pipeline). */
function looksLikeDoi(s: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(s.trim());
}

/** Tarball-ish extensions `extractArxivSource` can unpack (gzipped tar / plain tar / lone gzip). */
const TARBALL_RE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|gz)$/i;

/** A positional that is an arXiv id / arxiv.org URL routes to the LaTeX path. */
export function isArxivSource(arg: string): boolean {
  return looksLikeArxiv(arg);
}

/** A positional that is a DOI or http(s) publisher URL — recognized, but not ingestible on main. */
export function isDoiOrUrl(arg: string): boolean {
  return looksLikeDoi(arg) || arg.startsWith("http://") || arg.startsWith("https://");
}

/** An existing local LaTeX source (.tex file, source dir, tarball) routes to LaTeX. */
export function isLocalLatexSource(arg: string): boolean {
  if (!existsSync(arg)) return false;
  try {
    if (statSync(arg).isDirectory()) return true;
  } catch {
    return false;
  }
  return arg.toLowerCase().endsWith(".tex") || TARBALL_RE.test(arg);
}

const HTML_HINT =
  "publisher HTML/PDF ingestion is in development (archived on the ocr-features branch); " +
  "use an arXiv id, or upload a LaTeX source zip in the web UI";

/**
 * Route the positional to a pipeline. Returns "latex" for arXiv / local LaTeX
 * sources; throws a friendly, actionable error for DOIs / publisher URLs and
 * unrecognized inputs.
 */
export function detectSource(arg: string): "latex" {
  if (isArxivSource(arg)) return "latex";
  if (isLocalLatexSource(arg)) return "latex";
  if (isDoiOrUrl(arg)) {
    throw new Error(`cannot ingest DOI/publisher URL ${arg}: ${HTML_HINT}`);
  }
  throw new Error(
    `unrecognized source '${arg}': expected an arXiv id/URL or a local .tex/dir/tarball ` +
      `(PDF ingestion is in development — ${HTML_HINT})`
  );
}
