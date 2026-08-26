/**
 * Detect cross-references (Fig./Table/Eq./Section/Appendix/Algorithm/Listing) and
 * resolve them to element ids (bibgraph/ingest/crossrefs.py).
 *
 * Resolution uses a label index built from the structure tree (by kind + printed
 * number) and, when `use_pdf_links` is on, GoTo hyperlink targets that land on a
 * specific float. Detected-but-unresolved cross-references are still tokenized with
 * a typed placeholder, e.g. `[[xref:figure-3?]]`.
 */

import type { CrossRefKind, CrossRefOccurrence, Document } from "@argelanderspace/contracts";
import type { Match } from "./annotate.js";
import { bbox1000ToFrac, type FracRect, type LinkAnnot, pointInRect } from "./pdf-links.js";
import { pyRe } from "./pyregex.js";
import { iterBlocks, iterSections } from "./traverse.js";

// kind -> compiled regex. Each regex exposes group(1) = number/letter.
// Case-insensitive: running text uses both "Figure 3" and "figure 3".
const IC = "gi";
const PATTERNS: Array<[CrossRefKind, RegExp]> = [
  ["figure", pyRe("\\b(?:Figs?\\.?|Figures?)\\s*(\\d+[a-z]?)", IC)],
  ["table", pyRe("\\b(?:Tabs?\\.?|Tables?)\\s*(\\d+[a-z]?)", IC)],
  ["equation", pyRe("\\b(?:Eqs?\\.?|Eqns?\\.?|Equations?)\\s*\\(?(\\d+[a-z]?)\\)?", IC)],
  ["algorithm", pyRe("\\b(?:Algs?\\.?|Algorithms?)\\s*(\\d+[a-z]?)", IC)],
  ["code", pyRe("\\b(?:Listings?|Codes?)\\s*(\\d+[a-z]?)", IC)],
  ["appendix", pyRe("\\bAppendix\\s*([A-Z]{1,2}\\b|\\d+)", IC)],
  ["section", pyRe("(?:\\bSect(?:s|ion|ions)?\\.?|§)\\s*(\\d+(?:\\.\\d+)*)", IC)],
];

const APPENDIX_HEADING_RE = /^\s*Appendix\s+([A-Za-z0-9]+)/u;
const SUBFIGURE_RE = /^(\d+)[a-z]$/u;

// Map key for a (kind, number) pair. Numbers come from the regexes above
// (digits/dots/letters only), so ":" can never appear inside them.
function kindKey(kind: string, num: string): string {
  return `${kind}:${num}`;
}

/** Map (kind, number) -> element id, plus point-based GoTo resolution. */
export class XrefIndex {
  private readonly byKind = new Map<string, string>();
  /** (id, page, fractional bbox) of every valid xref target (floats + sections). */
  readonly boxes: Array<{ id: string; page: number; bbox: FracRect }> = [];

  constructor(doc: Pick<Document, "structure">) {
    const bucket: Record<string, string> = {
      figure: "figure",
      table: "table",
      equation: "equation",
      algorithm: "algorithm",
      code: "code",
    };
    for (const b of iterBlocks(doc)) {
      const kind = bucket[b.type];
      if (!kind) continue; // only floats are valid xref targets
      const num = "number" in b ? b.number : undefined;
      if (num) this.setDefault(kindKey(kind, num.toLowerCase()), b.id);
      const fb = bbox1000ToFrac(b.bbox);
      if (fb !== undefined && b.page_idx !== undefined) {
        this.boxes.push({ id: b.id, page: b.page_idx, bbox: fb });
      }
    }
    for (const s of iterSections(doc)) {
      if (s.number) this.setDefault(kindKey("section", s.number.toLowerCase()), s.id);
      // appendix headings like "Appendix A"
      const m = APPENDIX_HEADING_RE.exec(s.heading_raw ?? "");
      if (m?.[1]) {
        const key = m[1].toLowerCase();
        this.setDefault(kindKey("appendix", key), s.id);
        this.setDefault(kindKey("section", key), s.id);
      }
      const sb = bbox1000ToFrac(s.bbox);
      if (sb !== undefined && s.page_idx !== undefined) {
        this.boxes.push({ id: s.id, page: s.page_idx, bbox: sb });
      }
    }
  }

  private setDefault(key: string, id: string): void {
    if (!this.byKind.has(key)) this.byKind.set(key, id);
  }

  resolve(kind: string, number: string): string | undefined {
    const num = number.toLowerCase();
    const hit = this.byKind.get(kindKey(kind, num));
    if (hit !== undefined) return hit;
    // subfigure "3a" -> figure "3"
    const m = SUBFIGURE_RE.exec(num);
    if (m?.[1]) return this.byKind.get(kindKey(kind, m[1]));
    return undefined;
  }

  resolvePoint(
    page: number | undefined,
    pt: readonly [number, number] | undefined
  ): string | undefined {
    if (page === undefined || pt === undefined) return undefined;
    let best: string | undefined;
    let bestD = 1e9;
    for (const b of this.boxes) {
      if (b.page !== page) continue;
      if (pointInRect(pt, b.bbox, 0.01)) return b.id;
      const cx = (b.bbox[0] + b.bbox[2]) / 2;
      const cy = (b.bbox[1] + b.bbox[3]) / 2;
      const d = Math.hypot(cx - pt[0], cy - pt[1]);
      if (d < bestD) {
        bestD = d;
        best = b.id;
      }
    }
    return bestD < 0.05 ? best : undefined;
  }
}

export function detectCrossrefs(text: string, index: XrefIndex): Match[] {
  const matches: Match[] = [];
  const claimed: Array<[number, number]> = [];
  const claim = (s: number, e: number): boolean => {
    for (const [cs, ce] of claimed) {
      if (s < ce && cs < e) return false;
    }
    claimed.push([s, e]);
    return true;
  };

  for (const [kind, rx] of PATTERNS) {
    for (const m of text.matchAll(rx)) {
      const raw = m[0];
      if (raw === undefined) continue;
      const number = m[1];
      if (!number) continue;
      if (!claim(m.index, m.index + raw.length)) continue;
      const target = index.resolve(kind, number);
      const occ: CrossRefOccurrence = {
        kind,
        raw,
        target_id: target,
        number,
        via: "regex",
        resolved: target !== undefined,
      };
      matches.push({ start: m.index, end: m.index + raw.length, occ });
    }
  }
  return matches;
}

/** Resolve unresolved cross-refs in a block via overlapping GoTo links. */
export function enrichCrossrefsWithLinks(
  xrefMatches: Match[],
  blockLinks: LinkAnnot[],
  index: XrefIndex
): void {
  const gotoTargets: string[] = [];
  for (const ln of blockLinks) {
    if (ln.kind === "goto" && ln.destKind !== "cite") {
      const tid = index.resolvePoint(ln.targetPage, ln.targetPoint);
      if (tid) gotoTargets.push(tid);
    }
  }
  if (gotoTargets.length === 0) return;
  let used = 0;
  for (const m of xrefMatches) {
    const occ = m.occ;
    if (!isCrossRefOcc(occ)) continue;
    if (occ.resolved && occ.target_id) {
      if (gotoTargets.includes(occ.target_id)) occ.via = "hyperlink+regex";
      continue;
    }
    if (used < gotoTargets.length) {
      const tid = gotoTargets[used];
      if (tid !== undefined) {
        occ.target_id = tid;
        used += 1;
        occ.resolved = true;
        occ.via = "hyperlink";
      }
    }
  }
}

function isCrossRefOcc(occ: Match["occ"]): occ is CrossRefOccurrence {
  return "kind" in occ;
}
