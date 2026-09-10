/**
 * Positional-source auto-detection for `ingest` (port of `bibgraph/cli.py`'s
 * routing, extended for local LaTeX sources). Main ingests LaTeX only:
 *
 *   arXiv id / arXiv: prefix / arxiv.org URL  → latex pipeline
 *   existing local .tex / dir / tarball        → latex pipeline
 *   an arXiv DataCite DOI (10.48550/arXiv.*)   → latex pipeline, resolved id
 *     (a malformed arXiv tail is a friendly error, never a stub)
 *   DOI / URL carrying a DOI in its path       → docless library stub entry
 *     (Stage 7 MS4): the full text is not ingestible, but the identifier
 *     anchors a work the user can later attach a LaTeX zip to in the web UI
 *   http(s) URL without a DOI in the path      → friendly error (publisher
 *     pages are bot-walled, so a DOI is only recoverable from the URL
 *     itself; publisher HTML/PDF ingestion is archived on `ocr-features`)
 *   anything else                              → friendly error
 */

import { existsSync, statSync } from "node:fs";
import { arxivFromDoi } from "@argelanderspace/core";
import { looksLikeArxiv } from "@argelanderspace/infra";

/** Bare DOI, e.g. `10.1051/0004-6361/202038192` (inlined from the archived html pipeline). */
export function looksLikeDoi(s: string): boolean {
  return /^10\.\d{4,9}\/\S+$/.test(s.trim().replace(/^doi:/i, ""));
}

/** Trailing path/format junk a publisher appends after the DOI proper. */
const DOI_TRAIL_RE =
  /(\/(?:pdf|epdf|meta|full|abstract|references|suppl|article-info)|\.(?:pdf|epdf|html?|md|rst|txt))$/i;

// Paste/punctuation junk stripped after DOI_TRAIL_RE. Known false positive
// (recorded, not fixed — Stage 7 MS4 review N4): SICI-form DOIs legitimately
// END in `)` (e.g. 10.1002/(SICI)1097-0126(1996)…), which this strips.
const DOI_PUNCT_RE = /[.,;:)\]/]+$/;

/** Strip publisher/paste junk from a candidate DOI (bare-DOI and URL paths share it). */
function stripDoiTrail(doi: string): string {
  let out = doi;
  let prev = "";
  while (prev !== out) {
    prev = out;
    out = out.replace(DOI_TRAIL_RE, "");
  }
  return out.replace(DOI_PUNCT_RE, "");
}

/**
 * The DOI a publisher URL carries in its path (doi.org, APS
 * `/abstract|pdf/10.1103/…`, IOPscience `/article/10.3847/…`, …). Publisher
 * pages are bot-walled, so nothing is fetched: a URL whose path has no DOI
 * (OUP `/article/<vol>/<issue>/<page>/<aid>`, A&A `full_html/…/aaNNNNN-YY`)
 * yields null and the caller keeps the friendly error.
 */
export function extractDoiFromUrl(url: string): string | null {
  let decoded = url;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    // malformed percent-escapes — match on the raw string
  }
  const m = /10\.\d{4,9}\/[^\s"'<>?#]+/.exec(decoded);
  if (!m) return null;
  const doi = stripDoiTrail(m[0]);
  return looksLikeDoi(doi) ? doi : null;
}

/** Tarball-ish extensions `extractArxivSource` can unpack (gzipped tar / plain tar / lone gzip). */
const TARBALL_RE = /\.(tar|tar\.gz|tgz|tar\.bz2|tbz2?|gz)$/i;

/** A positional that is an arXiv id / arxiv.org URL routes to the LaTeX path. */
export function isArxivSource(arg: string): boolean {
  return looksLikeArxiv(arg);
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

/**
 * The routed positional: `latex` runs the pipeline on `input` (the arg
 * itself, or the arXiv id resolved out of a DataCite arXiv DOI); `doi-stub`
 * creates a docless library work anchored on `doi` (`fromUrl` marks a DOI
 * extracted from a publisher URL — it may not be a real DOI).
 */
export type DetectedSource =
  | { kind: "latex"; input: string }
  | { kind: "doi-stub"; doi: string; fromUrl: boolean };

/**
 * Route a candidate DOI. An arXiv DataCite DOI whose tail parses as an arXiv
 * id goes to the latex pipeline; a malformed tail (junk glued after the id)
 * is a friendly error rather than a doi-stub — an arXiv DOI must never pose
 * as a journal DOI (core's `acceptDoi` semantics), so the stub would anchor
 * on a garbage identifier.
 */
function routeDoi(doi: string, fromUrl: boolean): DetectedSource {
  const aid = arxivFromDoi(doi);
  if (aid !== null) {
    if (looksLikeArxiv(aid)) return { kind: "latex", input: aid };
    throw new Error(
      `cannot parse the arXiv id in DataCite DOI ${doi}; use the arXiv id directly ` +
        "(e.g. `ingest 2501.17225`)"
    );
  }
  return { kind: "doi-stub", doi, fromUrl };
}

const URL_HINT =
  "the URL carries no DOI to anchor a library entry, and publisher HTML/PDF ingestion " +
  "is in development (archived on the ocr-features branch); " +
  "use an arXiv id, a bare DOI, or upload a LaTeX source zip in the web UI";

const HTML_HINT =
  "publisher HTML/PDF ingestion is in development (archived on the ocr-features branch); " +
  "use an arXiv id, or upload a LaTeX source zip in the web UI";

/**
 * Route the positional. Returns `latex` for arXiv / local LaTeX sources and
 * `doi-stub` for bare DOIs / URLs whose path carries a DOI; throws a friendly,
 * actionable error for DOI-less publisher URLs and unrecognized inputs.
 */
export function detectSource(arg: string): DetectedSource {
  if (isArxivSource(arg)) return { kind: "latex", input: arg };
  if (isLocalLatexSource(arg)) return { kind: "latex", input: arg };
  if (looksLikeDoi(arg)) {
    const doi = stripDoiTrail(arg.trim().replace(/^doi:/i, ""));
    return routeDoi(doi, false);
  }
  if (arg.startsWith("http://") || arg.startsWith("https://")) {
    const doi = extractDoiFromUrl(arg);
    if (doi) return routeDoi(doi, true);
    throw new Error(`cannot ingest publisher URL ${arg}: ${URL_HINT}`);
  }
  throw new Error(
    `unrecognized source '${arg}': expected an arXiv id/URL, a local .tex/dir/tarball, ` +
      `or a DOI (PDF ingestion is in development — ${HTML_HINT})`
  );
}
