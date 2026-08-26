/**
 * Parse a BibTeX file into normalized bibliographic records
 * (bibgraph/acquire/bibtex.py).
 *
 * The acquisition layer consumes plain records, not LaTeX: author names are
 * de-accented to Unicode and reduced to family names (Zotero-style), titles lose
 * their brace-protection, and arXiv eprints / DOIs are normalized. The BibTeX
 * *grammar* is parsed by `@retorquere/bibtex-parser` (decision 12) in raw mode
 * with `author` verbatim — yielding the same raw field strings Python's
 * `bibtexparser.loads(common_strings=True, ignore_nonstandard_types=False)`
 * produces (verified: `@string` expansion, quoted/braced values, lowercased
 * field names, nonstandard entry types) — and the astronomy-aware field
 * handling stays hand-rolled on top (`eprint`/`archivePrefix` → arXiv id,
 * `journal = {arXiv e-prints}` → no real venue, brace-protected group authors
 * like `{Gaia Collaboration}` kept whole).
 *
 * Port notes (bug-for-bug):
 * - `_clean_text`'s accent conversion is the ported `latex_to_unicode`
 *   (`acquire/latexenc.ts`), applied per field exactly like Python — NOT the JS
 *   parser's translator (which sentence-cases titles and diverges on `\&`,
 *   math macros, and creator names).
 * - `month` values diverge (`feb` → "02" vs "February"): unreachable,
 *   `_record_from_entry` never reads `month`.
 * - Python logs a warning and skips an entry whose conversion raises; the port
 *   skips silently (logging is not ported).
 */

import { readFileSync } from "node:fs";
import { parse } from "@retorquere/bibtex-parser";
import { pyOr } from "../documents/pyregex.js";
import { normArxiv, normDoi } from "../library/store.js";
import { latexToUnicode } from "./latexenc.js";

/** Surname particles that stay attached to the family name ("van Leeuwen"). */
const PARTICLES = new Set([
  "van",
  "von",
  "der",
  "den",
  "de",
  "del",
  "della",
  "di",
  "du",
  "da",
  "das",
  "dos",
  "la",
  "le",
  "ten",
  "ter",
  "vande",
]);
const ARXIV_BARE = /^\d{4}\.\d{4,5}(v\d+)?$/;

/** One normalized `.bib` entry. */
export interface BibRecord {
  /** the cite key, e.g. "HR1" */
  key: string;
  /** article | inproceedings | ... */
  entryType: string;
  title: string;
  /** family names, in order */
  authors: string[];
  year: number | null;
  /** null for arXiv-only preprints */
  journal: string | null;
  volume: string | null;
  pages: string | null;
  doi: string | null;
  arxivId: string | null;
}

/** `BibRecord.is_conf`. */
export function isConf(rec: BibRecord): boolean {
  return ["inproceedings", "conference", "proceedings"].includes(rec.entryType);
}

// --------------------------------------------------------------------------- //
// Field cleaning
// --------------------------------------------------------------------------- //

/**
 * LaTeX→unicode, de-brace, de-tilde and collapse whitespace in a bib field.
 *
 * We convert accents *here* (per field) rather than via a parser-wide
 * `convert_to_unicode` customization, because that would strip the
 * brace-protection around group authors (`{Gaia Collaboration}`) before we
 * can detect them.
 */
export function cleanText(input: string): string {
  let s = input;
  try {
    s = latexToUnicode(s);
  } catch {
    // pass (Python: except Exception → keep the raw string)
  }
  s = s.replaceAll("~", " ");
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\\[a-zA-Z]+/g, ""); // leftover control words (e.g. \degr)
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Extract the family name from one author token.
 *
 * `"Hunt, E.~L."` → `"Hunt"`; `"van Leeuwen, F."` → `"van Leeuwen"`;
 * `"{Gaia Collaboration}"` → `"Gaia Collaboration"` (group author kept
 * whole); `"Pavel Kroupa"` (no comma) → `"Kroupa"` with particles.
 */
export function familyName(rawInput: string): string {
  const raw = rawInput.trim();
  // A fully brace-wrapped name is a protected group/corporate author.
  if (raw.startsWith("{") && raw.endsWith("}") && !raw.slice(1, -1).includes("{")) {
    return cleanText(raw);
  }
  const s = cleanText(raw);
  if (!s) return "";
  if (s.includes(",")) {
    // "Family, Given"
    return (s.split(",", 1)[0] as string).trim();
  }
  const toks = s.split(" "); // "Given M. Family"
  if (toks.length === 1) return toks[0] as string;
  const fam = [toks[toks.length - 1] as string];
  let i = toks.length - 2;
  while (i >= 0 && PARTICLES.has((toks[i] as string).toLowerCase())) {
    fam.unshift(toks[i] as string);
    i -= 1;
  }
  return fam.join(" ");
}

export function parseAuthors(fieldValue: string): string[] {
  if (!fieldValue) return [];
  const parts = fieldValue.trim().split(/\s+and\s+/);
  const out = parts.filter((p) => p.trim() && p.trim().toLowerCase() !== "others").map(familyName);
  return out.filter((a) => a);
}

function parseYear(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /(\d{4})/.exec(s);
  return m?.[1] !== undefined ? Number.parseInt(m[1], 10) : null;
}

/** arXiv id from `eprint` (+ `archivePrefix`/`primaryClass`). */
function arxivFromEntry(entry: Record<string, unknown>): string | null {
  const ep = ((pyOr(entry.eprint) as string | undefined) ?? "").trim();
  if (!ep) return null;
  const prefix = ((pyOr(entry.archiveprefix) as string | undefined) ?? "").trim().toLowerCase();
  // accept when explicitly arXiv, or the eprint simply looks like an arXiv id
  if ((prefix === "arxiv" || prefix === "") && (ARXIV_BARE.test(ep) || ep.includes("/"))) {
    return normArxiv(ep);
  }
  if (prefix === "arxiv") return normArxiv(ep);
  return null;
}

const PREPRINT_VENUE = /arxiv|e-?print|preprint|submitted/i;

// --------------------------------------------------------------------------- //
// Entry/file parsing
// --------------------------------------------------------------------------- //

function recordFromEntry(entry: Record<string, unknown>): BibRecord {
  let journal: string | null = cleanText(
    (pyOr(entry.journal, entry.booktitle) as string | undefined) ?? ""
  );
  if (!journal || PREPRINT_VENUE.test(journal)) {
    journal = null;
  }
  return {
    key: (pyOr(entry.ID, entry.id) as string | undefined) ?? "",
    entryType: ((pyOr(entry.ENTRYTYPE) as string | undefined) ?? "article").toLowerCase(),
    title: cleanText((pyOr(entry.title) as string | undefined) ?? ""),
    authors: parseAuthors((pyOr(entry.author) as string | undefined) ?? ""),
    year: parseYear(entry.year as string | undefined),
    journal,
    volume:
      (pyOr(cleanText((pyOr(entry.volume) as string | undefined) ?? "")) as string | undefined) ??
      null,
    pages:
      (pyOr(cleanText((pyOr(entry.pages) as string | undefined) ?? "")) as string | undefined) ??
      null,
    doi: normDoi(entry.doi as string | undefined),
    arxivId: arxivFromEntry(entry),
  };
}

export function parseBibtexText(text: string): BibRecord[] {
  // NB: raw mode + no sentence-casing + author verbatim — we convert per field
  // in cleanText so brace-protected group authors survive long enough to detect.
  const db = parse(text, { raw: true, sentenceCase: false, verbatimFields: ["author"] });
  const records: BibRecord[] = [];
  for (const e of db.entries) {
    const entry: Record<string, unknown> = { ...e.fields, ENTRYTYPE: e.type, ID: e.key };
    let rec: BibRecord;
    try {
      rec = recordFromEntry(entry);
    } catch {
      continue; // never let one bad entry abort
    }
    if (rec.key) records.push(rec);
  }
  return records;
}

/** Parse a `.bib` file into normalized {@link BibRecord} objects. */
export function parseBibtex(path: string): BibRecord[] {
  return parseBibtexText(readFileSync(path, "utf8"));
}
