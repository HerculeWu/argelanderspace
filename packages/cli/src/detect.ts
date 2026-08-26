/**
 * Positional-source auto-detection for `ingest` (port of `bibgraph/cli.py`'s
 * routing, extended for local LaTeX sources):
 *
 *   arXiv id / arXiv: prefix / arxiv.org URL  → latex pipeline
 *   DOI / http(s) URL                          → html pipeline
 *   existing local .tex / dir / tarball        → latex pipeline  (see below)
 *   anything else                              → pdf pipeline (a local PDF path)
 *
 * Python's `cli.py` only routed arXiv ids/URLs to the LaTeX pipeline — a local
 * `.tex` fell through to `ingest_pdf` and died there despite the help text
 * advertising ".tex source". `acquireSource` (infra) accepts local .tex files,
 * source directories, and tarballs, so the CLI detects them explicitly.
 */

import { existsSync, statSync } from "node:fs";
import { looksLikeDoi } from "@argelanderspace/core";
import { looksLikeArxiv } from "@argelanderspace/infra";

export type SourceKind = "latex" | "html" | "pdf";

/** Tarball-ish extensions `extractArxivSource` can unpack (gzipped tar / plain tar / lone gzip). */
const TARBALL_RE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|gz)$/i;

/** A positional that is an arXiv id / arxiv.org URL routes to the LaTeX path. */
export function isArxivSource(arg: string): boolean {
  return looksLikeArxiv(arg);
}

/** A positional that is a DOI or http(s) URL routes to the HTML pipeline. */
export function isHtmlSource(arg: string): boolean {
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

/** Route the positional to a pipeline, mirroring `cli.py main()`'s if-chain. */
export function detectSource(arg: string): SourceKind {
  if (isArxivSource(arg)) return "latex";
  if (isHtmlSource(arg)) return "html";
  if (isLocalLatexSource(arg)) return "latex";
  return "pdf";
}
