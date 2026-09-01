/**
 * Bibliography-entry parsing (bibgraph/ingest/references.py).
 *
 * What lives here is the per-entry parser the LaTeX pipeline's .bbl/.bib
 * reference builder reuses (`parseOne`, `matchKeys`). Reference strings are
 * wildly inconsistent across publishers, so extraction is deliberately
 * best-effort and layered: the fields we can get *reliably* (raw text, DOI,
 * arXiv id, URL, year, author surnames, numbered label) are always populated;
 * title / venue / volume / pages are heuristic and frequently left undefined.
 * The reliable fields are exactly what the in-text citation matcher needs
 * (numbered label, or first-author surname + year).
 *
 * The MinerU `ref_text` block splitter (`parseReferences` over OCR blocks)
 * left with the PDF pipeline (archived on the `ocr-features` branch).
 */

import type { Reference } from "@argelanderspace/contracts";
import { pyRe, rstripChars, stripChars } from "./pyregex.js";

/** A parsed bibliography entry; `src_*` locates the entry for GoTo-hyperlink resolution
 *  and is never serialized into the output JSON. */
export type ParsedReference = Reference & {
  src_page?: number;
  /** 0..1000 page-grid bbox of the source block. */
  src_bbox?: [number, number, number, number];
};

/** DOI / arXiv-id patterns shared with the (archived) link harvester. */
export const DOI_RE = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/iu;
export const ARXIV_RE = /arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/iu;

const ARXIV_ID_RE = /arxiv\s*:?\s*(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/iu;
const URL_RE = /https?:\/\/[^\s,);]+/iu;
const YEAR_RE = pyRe("\\b(1[89]\\d{2}|20\\d{2})\\b", "g");
const YEAR_PAREN_RE = /\((1[89]\d{2}|20\d{2})[a-z]?\)/u;
const QUOTED_RE = /["“]([^"”]{6,})["”]/u;
const VOLUME_RE = /,\s*(?:vol\.?\s*)?(\d{1,4})\s*[,:]/u;

/** Python `_clean_doi`. */
function cleanDoi(s: string): string {
  let out = rstripChars(s, ".,;");
  if (out.endsWith(")") && !out.includes("(")) {
    // trailing sentence paren, not DOI syntax
    out = out.slice(0, -1);
  }
  return out;
}

/** `_parse_one` — also used by the LaTeX pipeline's .bbl reference builder. */
export function parseOne(refId: string, raw: string, label: string | undefined): ParsedReference {
  let doi: string | undefined;
  const dm = DOI_RE.exec(raw);
  if (dm && dm[0] !== undefined) doi = cleanDoi(dm[0]);

  let arxivId: string | undefined;
  const am = ARXIV_ID_RE.exec(raw) ?? ARXIV_RE.exec(raw);
  if (am) arxivId = am[1];

  let url: string | undefined;
  const um = URL_RE.exec(raw);
  if (um && um[0] !== undefined) url = rstripChars(um[0], ").,;");

  // year: prefer a parenthesized year; else the first year for author-year styles
  // ("Authors YEAR, ...") and the last for numbered styles (year trails).
  let year: number | undefined;
  const yp = YEAR_PAREN_RE.exec(raw);
  if (yp?.[1]) {
    year = Number.parseInt(yp[1], 10);
  } else {
    const ys = [...raw.matchAll(YEAR_RE)].map((m) => m[1]);
    if (ys.length > 0) {
      const pick = label ? ys[ys.length - 1] : ys[0];
      if (pick !== undefined) year = Number.parseInt(pick, 10);
    }
  }

  const authors = parseAuthors(raw, year);

  let title: string | undefined;
  const qm = QUOTED_RE.exec(raw);
  if (qm?.[1]) title = stripChars(qm[1].trim(), ",.;: ");

  let volume: string | undefined;
  const vm = VOLUME_RE.exec(raw);
  if (vm) volume = vm[1];

  const keys = matchKeys(authors, year, label);

  return {
    id: refId,
    raw,
    label,
    authors,
    year,
    title,
    volume,
    doi,
    arxiv_id: arxivId,
    url,
    keys,
  };
}

const ET_AL_RE = pyRe("\\bet\\s+al\\.?", "gi");
const CHUNK_SPLIT_RE = pyRe("\\s*(?:,|;|&|\\band\\b)\\s*", "");
const INITIALS_ONLY_RE = /^(?:[A-Z]\.?\s*){1,4}$/u;
const SINGLE_CAP_RE = /^[A-Z]\.?$/u;
const SINGLE_LETTER_RE = /^[A-Za-z]\.?$/u;

/** Best-effort list of author *surnames* (used for citation matching). */
function parseAuthors(raw: string, year: number | undefined): string[] {
  let region = raw;
  if (year !== undefined) {
    const idx = raw.indexOf(String(year));
    if (idx > 5) {
      // year near start isn't the boundary
      region = raw.slice(0, idx);
    }
  }
  region = region.split(/["“]/u)[0] ?? ""; // stop at a title quote
  region = region.replace(/\([^)]*\)/gu, " "); // remove parenthetical affiliations
  region = region.replace(/\([^)]*$/u, ""); // and any dangling unclosed '('
  region = stripChars(region, " ,.;");
  if (!region) return [];
  region = region.replace(ET_AL_RE, "");
  // Split on commas AND and/&/; so both styles are handled uniformly:
  //   A&A   : "Hunt, E. L. & Reffert, S."   -> Hunt | E. L. | Reffert | S.
  //   MNRAS : "Banik I., Zhao H., Famaey B."-> Banik I. | Zhao H. | Famaey B.
  const chunks = region.split(CHUNK_SPLIT_RE);
  const surnames: string[] = [];
  for (const chunk of chunks) {
    const ch = stripChars(chunk, " .");
    if (!ch) continue;
    // a chunk that is only initials belongs to the previous author (A&A style)
    if (INITIALS_ONLY_RE.test(`${ch} `)) continue;
    const words = ch.split(/\s+/u).filter((w) => w.length > 0);
    // strip trailing / leading single-capital initials ("Banik I." / "I. Banik")
    while (words.length > 1 && SINGLE_CAP_RE.test(words[words.length - 1] ?? "")) words.pop();
    while (words.length > 1 && SINGLE_CAP_RE.test(words[0] ?? "")) words.shift();
    const surname = stripChars(words.join(" "), " .");
    if (surname && !SINGLE_LETTER_RE.test(surname)) surnames.push(surname);
  }
  // de-dup while preserving order
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const s of surnames) {
    const k = s.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(s);
    }
  }
  return uniq.slice(0, 12);
}

/** `_match_keys` — also used by the LaTeX pipeline's CSL-JSON reference builder. */
export function matchKeys(
  authors: string[],
  year: number | undefined,
  label: string | undefined
): string[] {
  const keys: string[] = [];
  if (label) keys.push(`[${label}]`);
  const a0 = authors[0];
  if (a0 && year) {
    keys.push(`${a0} ${year}`, `${a0} et al. ${year}`);
    const a1 = authors[1];
    if (a1 !== undefined) keys.push(`${a0} & ${a1} ${year}`);
  }
  return keys;
}
