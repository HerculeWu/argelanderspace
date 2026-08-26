/**
 * Detect in-text citations and link them to the reference list
 * (bibgraph/ingest/citations.py).
 *
 * Two dominant styles are handled:
 *
 * - **author-year** — `Hunt & Reffert (2021)` (narrative) and
 *   `(Cantat-Gaudin et al. 2020; Smith 2019)` (parenthetical, possibly with extra
 *   years like `Smith 2019, 2021`).
 * - **numbered** — `[12]`, `[1, 2, 5]`, `[1-3]` (only when the parsed bibliography
 *   actually uses numeric labels).
 *
 * Resolution is layered: regex matches are mapped to references by `(surname, year)`
 * or numeric label; then, when `use_pdf_links` is on, PDF hyperlink annotations
 * overlapping the text block authoritatively resolve matches the regex could not
 * (and corroborate the rest).
 */

import type { CitationOccurrence, Reference } from "@argelanderspace/contracts";
import type { Match } from "./annotate.js";
import { bbox1000ToFrac, type FracRect, type LinkAnnot, pointInRect } from "./pdf-links.js";
import { pyRe, stripChars } from "./pyregex.js";
import type { ParsedReference } from "./references.js";

// first char allows non-ASCII uppercase (Å, Ø, Ü, Ł, …) common in author names
const NAME = "[A-ZÀ-ſ][A-Za-z'’À-ſ.\\-]+";
// "Hunt & Reffert", "Cantat-Gaudin et al.", "Smith and Jones"
const AUTHORS = `${NAME}(?:\\s+(?:&|and)\\s+${NAME})?(?:\\s+et\\s+al\\.?)?`;
const YEAR = "\\d{4}[a-z]?";
const EXTRA_YEARS = `(?:\\s*,\\s*${YEAR})*`;

const NARRATIVE_RE = pyRe(`\\b(${AUTHORS})\\s*\\((${YEAR})(${EXTRA_YEARS})\\)`, "g");
// any "(...)" that contains a 4-digit year
const PAREN_RE = /\(([^()]*?(?:19|20)\d{2}[a-z]?[^()]*?)\)/gu;
const INNER_AY_RE = new RegExp(`(${AUTHORS})\\s+(${YEAR})(${EXTRA_YEARS})`, "gu");
const NUM_RE = /\[(\d{1,3}(?:\s*[,–-]\s*\d{1,3})*)\]/gu;
const SIGNAL_RE = pyRe("&|\\band\\b|\\bet\\s+al\\b|;", "");
const YEAR_ONLY_RE = /\d{4}[a-z]?/gu;
const LEADING_YEAR_RE = /^\d{4}/u;

export class ReferenceResolver {
  readonly refs: ReadonlyArray<ParsedReference>;
  private readonly byLabel = new Map<string, Reference>();
  private readonly byDoi = new Map<string, Reference>();
  private readonly byArxiv = new Map<string, Reference>();
  private readonly ay = new Map<string, Reference[]>();
  readonly numbered: boolean;
  readonly authorYear: boolean;
  /** bibliography entry boxes (fractional) for GoTo-hyperlink resolution */
  private readonly boxes: Array<{ ref: Reference; page: number; bbox?: FracRect }>;

  constructor(references: ReadonlyArray<ParsedReference>) {
    this.refs = references;
    for (const r of references) {
      if (r.label) this.byLabel.set(r.label, r);
      if (r.doi) this.byDoi.set(r.doi.toLowerCase(), r);
      if (r.arxiv_id) this.byArxiv.set(r.arxiv_id.toLowerCase(), r);
    }
    for (const r of references) {
      const a0 = r.authors?.[0];
      if (r.year && a0) {
        const sur = a0.toLowerCase();
        // tuple key (surname, year): NUL separator cannot appear in a surname
        const key = `${sur}\u0000${r.year}`;
        const list = this.ay.get(key);
        if (list) list.push(r);
        else this.ay.set(key, [r]);
      }
    }
    this.numbered = this.byLabel.size > 0;
    this.authorYear = this.ay.size > 0;
    this.boxes = [];
    for (const r of references) {
      if (r.src_page !== undefined && r.src_bbox !== undefined) {
        // bbox1000ToFrac may still return undefined (short bbox); such boxes are
        // stored and skipped during point resolution, as in the Python version.
        this.boxes.push({ ref: r, page: r.src_page, bbox: bbox1000ToFrac(r.src_bbox) });
      }
    }
  }

  resolveLabel(label: string): Reference | undefined {
    return this.byLabel.get(label);
  }

  resolveAuthorYear(surname: string, year: number): Reference | undefined {
    const rs = this.ay.get(`${surname.toLowerCase()}\u0000${year}`);
    return rs?.[0];
  }

  resolveDoi(doi: string): Reference | undefined {
    return this.byDoi.get(doi.toLowerCase());
  }

  resolveArxiv(arxiv: string): Reference | undefined {
    return this.byArxiv.get(arxiv.toLowerCase());
  }

  resolvePoint(
    page: number | undefined,
    pt: readonly [number, number] | undefined
  ): Reference | undefined {
    if (page === undefined || pt === undefined) return undefined;
    let best: Reference | undefined;
    let bestD = 1e9;
    for (const b of this.boxes) {
      if (b.page !== page || b.bbox === undefined) continue;
      if (pointInRect(pt, b.bbox, 0.02)) return b.ref;
      const cx = (b.bbox[0] + b.bbox[2]) / 2;
      const cy = (b.bbox[1] + b.bbox[3]) / 2;
      const d = Math.hypot(cx - pt[0], cy - pt[1]);
      if (d < bestD) {
        bestD = d;
        best = b.ref;
      }
    }
    return bestD < 0.05 ? best : undefined;
  }
}

// --------------------------------------------------------------------------- //
// Detection
// --------------------------------------------------------------------------- //

const RANGE_RE = /^(\d{1,3})\s*[–-]\s*(\d{1,3})$/u;
const DIGITS_RE = /^\d+$/u;

function expandNumbers(inner: string): string[] {
  const out: string[] = [];
  for (const part0 of inner.split(",")) {
    const part = part0.trim();
    const m = RANGE_RE.exec(part);
    if (m?.[1] && m[2]) {
      const a = Number.parseInt(m[1], 10);
      const b = Number.parseInt(m[2], 10);
      if (b - a > 0 && b - a < 100) {
        for (let n = a; n <= b; n++) out.push(String(n));
        continue;
      }
    }
    if (DIGITS_RE.test(part)) out.push(part);
  }
  return out;
}

const ET_AL_STRIP_RE = /\s+et\s+al\.?/giu;
const AND_SPLIT_RE = /\s+(?:&|and)\s+/u;

function firstSurname(authors: string): string {
  const cleaned = authors.replace(ET_AL_STRIP_RE, "");
  const first = cleaned.split(AND_SPLIT_RE)[0] ?? "";
  const beforeComma = first.split(",")[0] ?? ""; // drop comma-separated initials
  return stripChars(beforeComma, " .,");
}

export function detectCitations(text: string, resolver: ReferenceResolver): Match[] {
  const matches: Match[] = [];
  const claimed: Array<[number, number]> = [];
  const claim = (s: number, e: number): boolean => {
    for (const [cs, ce] of claimed) {
      if (s < ce && cs < e) return false;
    }
    claimed.push([s, e]);
    return true;
  };

  // 1) narrative author-year: "Hunt & Reffert (2021)"
  for (const m of text.matchAll(NARRATIVE_RE)) {
    const raw = m[0];
    if (raw === undefined) continue;
    const authors = m[1] ?? "";
    const year = m[2] ?? "";
    const extra = m[3] ?? "";
    const surname = firstSurname(authors);
    const years = [year, ...findYears(extra)];
    const { refIds, resolvedAny } = resolveYears(resolver, surname, years);
    const signal = SIGNAL_RE.test(authors);
    if (!resolvedAny && !signal) continue;
    if (!claim(m.index, m.index + raw.length)) continue;
    const occ: CitationOccurrence = {
      ref_ids: refIds,
      raw,
      via: "regex",
      resolved: refIds.length > 0,
    };
    matches.push({ start: m.index, end: m.index + raw.length, occ });
  }

  // 2) parenthetical author-year: "(... 2020; ... 2019)"
  for (const pm of text.matchAll(PAREN_RE)) {
    const raw = pm[0];
    if (raw === undefined) continue;
    const inner = pm[1] ?? "";
    let refIds: string[] = [];
    let resolvedAny = false;
    const signal = SIGNAL_RE.test(inner);
    let nInner = 0;
    for (const im of inner.matchAll(INNER_AY_RE)) {
      nInner += 1;
      const surname = firstSurname(im[1] ?? "");
      const years = [im[2] ?? "", ...findYears(im[3] ?? "")];
      const { refIds: ids, resolvedAny: ok } = resolveYears(resolver, surname, years);
      refIds = refIds.concat(ids);
      resolvedAny = resolvedAny || ok;
    }
    if (nInner === 0) continue;
    if (!resolvedAny && !signal && nInner < 2) continue;
    if (!claim(pm.index, pm.index + raw.length)) continue;
    refIds = dedup(refIds);
    const occ: CitationOccurrence = {
      ref_ids: refIds,
      raw,
      via: "regex",
      resolved: refIds.length > 0,
    };
    matches.push({ start: pm.index, end: pm.index + raw.length, occ });
  }

  // 3) numbered: "[1, 2, 5]" (only when the bibliography is numbered)
  if (resolver.numbered) {
    for (const nm of text.matchAll(NUM_RE)) {
      const raw = nm[0];
      if (raw === undefined) continue;
      const nums = expandNumbers(nm[1] ?? "");
      if (nums.length === 0) continue;
      const refs = nums.map((n) => resolver.resolveLabel(n));
      if (!refs.every((r) => r !== undefined)) continue; // avoid math intervals like [0,1]
      if (!claim(nm.index, nm.index + raw.length)) continue;
      const refIds = dedup(refs.flatMap((r) => (r ? [r.id] : [])));
      const occ: CitationOccurrence = { ref_ids: refIds, raw, via: "regex", resolved: true };
      matches.push({ start: nm.index, end: nm.index + raw.length, occ });
    }
  }

  return matches;
}

function findYears(extra: string): string[] {
  return [...extra.matchAll(YEAR_ONLY_RE)].map((m) => m[0] ?? "");
}

function resolveYears(
  resolver: ReferenceResolver,
  surname: string,
  years: string[]
): { refIds: string[]; resolvedAny: boolean } {
  const refIds: string[] = [];
  let resolvedAny = false;
  for (const y of years) {
    const ym = LEADING_YEAR_RE.exec(y);
    if (!ym) continue; // unreachable: years come from \d{4} patterns
    const ref = resolver.resolveAuthorYear(surname, Number.parseInt(ym[0], 10));
    if (ref) {
      refIds.push(ref.id);
      resolvedAny = true;
    }
  }
  return { refIds: dedup(refIds), resolvedAny };
}

function dedup(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (!seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Hyperlink enrichment (block granularity)
// --------------------------------------------------------------------------- //

const XREF_DEST_KINDS = new Set(["figure", "table", "equation", "section", "algorithm", "code"]);

/** References authoritatively pointed to by the given block's hyperlinks. */
export function linkTargets(links: LinkAnnot[], resolver: ReferenceResolver): Reference[] {
  const found: Reference[] = [];
  for (const ln of links) {
    let ref: Reference | undefined;
    if (ln.kind === "uri") {
      if (ln.doi) ref = resolver.resolveDoi(ln.doi);
      if (ref === undefined && ln.arxivId) ref = resolver.resolveArxiv(ln.arxivId);
    } else if (
      ln.kind === "goto" &&
      (ln.destKind === undefined || !XREF_DEST_KINDS.has(ln.destKind))
    ) {
      // cite.* / generic goto: spatial guard maps it to a bib entry (or undefined)
      ref = resolver.resolvePoint(ln.targetPage, ln.targetPoint);
    }
    if (ref !== undefined) found.push(ref);
  }
  return dedupRefs(found);
}

/**
 * Use a block's hyperlinks to resolve/corroborate its citation matches.
 *
 * Block granularity: links overlapping the *block* (not the exact citation glyphs)
 * are paired with the block's citation sites in reading order. Used to fill in
 * matches the regex left unresolved and to mark corroborated ones.
 */
export function enrichCitationsWithLinks(
  citeMatches: Match[],
  blockLinks: LinkAnnot[],
  resolver: ReferenceResolver
): void {
  const targets = linkTargets(blockLinks, resolver);
  if (targets.length === 0) return;
  const pool = [...targets]; // remaining unconsumed link targets
  for (const m of citeMatches) {
    const occ = m.occ;
    if (!isCitationOcc(occ)) continue;
    if (occ.resolved && occ.ref_ids?.length) {
      // corroborate, and CONSUME the matching target so it isn't reused
      const i = pool.findIndex((t) => occ.ref_ids?.includes(t.id));
      if (i >= 0) {
        occ.via = "hyperlink+regex";
        pool.splice(i, 1);
      }
      continue;
    }
    const t = pool.shift(); // assign next unused link target
    if (t) {
      occ.ref_ids = [t.id];
      occ.resolved = true;
      occ.via = "hyperlink";
      occ.doi = t.doi;
      occ.url = t.url;
    }
  }
}

function isCitationOcc(occ: Match["occ"]): occ is CitationOccurrence {
  return !("kind" in occ);
}

function dedupRefs(refs: Reference[]): Reference[] {
  const seen = new Set<string>();
  const out: Reference[] = [];
  for (const r of refs) {
    if (!seen.has(r.id)) {
      seen.add(r.id);
      out.push(r);
    }
  }
  return out;
}
