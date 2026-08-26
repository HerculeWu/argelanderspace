/**
 * Shared machinery for replacing in-text spans with `[[...]]` tokens
 * (bibgraph/ingest/annotate.py).
 *
 * Both the citation and cross-reference detectors return `Match` objects
 * (character span + the occurrence record). They are merged, de-overlapped, and
 * applied to the body text in a *single* rewrite so that inserting one token can
 * never corrupt the offsets of another.
 */

import type { CitationOccurrence, CrossRefOccurrence } from "@argelanderspace/contracts";
import { citeToken, xrefToken } from "./tokens.js";

/** A detected occurrence: character span in the source text + the occurrence record. */
export interface Match {
  start: number;
  end: number;
  occ: CitationOccurrence | CrossRefOccurrence;
}

/** Type guard: citation occurrences carry `ref_ids`, cross-refs carry `kind`. */
export function isCitation(occ: Match["occ"]): occ is CitationOccurrence {
  return !("kind" in occ);
}

/** The `[[...]]` token a match is replaced with (schema.py `Occurrence.token`). */
export function matchToken(m: Match): string {
  const occ = m.occ;
  if (isCitation(occ)) {
    return occ.ref_ids?.length ? citeToken(occ.ref_ids) : "[[cite:?]]";
  }
  if (occ.target_id) return xrefToken(occ.target_id);
  if (occ.number) return `[[xref:${occ.kind}-${occ.number}?]]`; // typed but unresolved
  return "[[xref:?]]";
}

export interface ApplyResult {
  text: string;
  citations: CitationOccurrence[];
  crossrefs: CrossRefOccurrence[];
}

/**
 * Rewrite `text`, replacing each accepted match span with its token.
 *
 * Overlapping matches are resolved by preferring the earlier start, then the longer
 * span. Returns the new text plus the citation/cross-ref occurrences in reading order.
 */
export function applyMatches(text: string, matches: Match[]): ApplyResult {
  const ordered = [...matches].sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start)
  );
  const accepted: Match[] = [];
  let lastEnd = -1;
  for (const m of ordered) {
    if (m.start < 0 || m.end > text.length || m.end <= m.start) continue;
    if (m.start < lastEnd) continue; // overlaps a previously accepted match
    accepted.push(m);
    lastEnd = m.end;
  }

  const parts: string[] = [];
  let cursor = 0;
  const citations: CitationOccurrence[] = [];
  const crossrefs: CrossRefOccurrence[] = [];
  for (const m of accepted) {
    // already sorted by start, non-overlapping
    parts.push(text.slice(cursor, m.start), matchToken(m));
    cursor = m.end;
    if (isCitation(m.occ)) citations.push(m.occ);
    else crossrefs.push(m.occ);
  }
  parts.push(text.slice(cursor));
  return { text: parts.join(""), citations, crossrefs };
}
