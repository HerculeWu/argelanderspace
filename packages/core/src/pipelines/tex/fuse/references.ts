/**
 * IR references from the .bbl facts (Stage 5 MS2).
 *
 * The facts layer (`facts/bbl.ts`) stays non-guessing; here, at the IR
 * boundary, we run the same *explicitly heuristic* field extraction the old
 * pipeline did: the bbl body is cleaned to readable text (journal macros
 * expanded, formatting unwrapped) and `parseOne` (`documents/references.ts`,
 * survives MS3) extracts authors/year/title/venue for the reader's cite
 * chips and the library graph. The fact-level doi/arxiv/url (regex-verified,
 * conservative) override the heuristic ones.
 *
 * ids are `ref-N` in .bbl order (BibTeX already pruned to the cited set —
 * same as today's compiled-bibliography path).
 */
import type { Reference } from "@argelanderspace/contracts";
import { pyRe, stripChars } from "../../../documents/pyregex.js";
import { parseOne } from "../../../documents/references.js";
import type { TexFacts } from "../facts/index.js";

// AAS / common astronomy journal-abbreviation macros (aastex, mn2e, aa.bst) —
// ported from the retired pipelines/latex/references.ts.
const JOURNAL_MACROS: ReadonlyArray<readonly [string, string]> = [
  ["aj", "AJ"],
  ["araa", "ARA&A"],
  ["apj", "ApJ"],
  ["apjl", "ApJL"],
  ["apjs", "ApJS"],
  ["ao", "Appl. Opt."],
  ["apss", "Ap&SS"],
  ["aap", "A&A"],
  ["aapr", "A&A Rev."],
  ["aaps", "A&AS"],
  ["azh", "AZh"],
  ["baas", "BAAS"],
  ["jrasc", "JRASC"],
  ["memras", "MmRAS"],
  ["mnras", "MNRAS"],
  ["pra", "Phys. Rev. A"],
  ["prb", "Phys. Rev. B"],
  ["prc", "Phys. Rev. C"],
  ["prd", "Phys. Rev. D"],
  ["pre", "Phys. Rev. E"],
  ["prl", "Phys. Rev. Lett."],
  ["pasp", "PASP"],
  ["pasj", "PASJ"],
  ["qjras", "QJRAS"],
  ["skytel", "S&T"],
  ["solphys", "Sol. Phys."],
  ["sovast", "Soviet Astron. Italiana"],
  ["ssr", "Space Sci. Rev."],
  ["zap", "ZAp"],
  ["nat", "Nature"],
  ["iaucirc", "IAU Circ."],
  ["aplett", "Astrophys. Lett."],
  ["bain", "BAN"],
  ["grl", "Geophys. Res. Lett."],
  ["jgr", "J. Geophys. Res."],
  ["memsai", "Mem. Soc. Astron. Italiana"],
  ["physrep", "Phys. Rep."],
  ["planss", "Planet. Space Sci."],
  ["procspie", "Proc. SPIE"],
  ["nphysa", "Nucl. Phys. A"],
];
const JOURNAL_BY_NAME = new Map(JOURNAL_MACROS);
// sorted by length desc — stable sort, like the Python original.
const JOURNAL_RE = pyRe(
  `\\\\(${[...JOURNAL_MACROS]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k]) => k)
    .join("|")})\\b`,
  "g"
);
const FORMAT_CMD_RE = pyRe(
  "\\\\(?:textit|textbf|textsc|textrm|emph|mbox|text|hbox|it|bf|natexlab)\\s*\\{",
  "y"
);
const DOI_CMD_RE = /\\doi\s*\{([^}]*)\}/g;
const HREF_RE = /\\href\s*\{[^}]*\}\s*\{([^}]*)\}/g;
const URL_CMD_RE = /\\url\s*\{([^}]*)\}/g;
const EPRINT_RE = /\\eprint\s*\{([^}]*)\}/g;
const LEFTOVER_CMD_RE = pyRe("\\\\[a-zA-Z]+\\b", "g");

/** If `s[i]===lo`, return (inner, index-after-matching-hi); else undefined. */
function balanced(
  s: string,
  i: number,
  lo: string,
  hi: string
): [inner: string, next: number] | undefined {
  if (i >= s.length || s[i] !== lo) return undefined;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === lo) depth++;
    else if (s[j] === hi) {
      depth--;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
    }
  }
  return [s.slice(i + 1), s.length];
}

/** Turn a raw `\bibitem` body into readable text (preserving DOI/arXiv). */
export function cleanBblText(s0: string): string {
  let s = s0.replaceAll("\\newblock", " ").replaceAll("\\nobreak", " ");
  s = s.replace(JOURNAL_RE, (m, name: string) => JOURNAL_BY_NAME.get(name) ?? m);
  s = s.replace(DOI_CMD_RE, " doi:$1 ");
  s = s.replace(HREF_RE, "$1");
  s = s.replace(URL_CMD_RE, "$1");
  s = s.replace(EPRINT_RE, "arXiv:$1");
  // unwrap formatting commands \textit{...} -> ... (a few passes for nesting)
  for (let i = 0; i < 4; i++) {
    const next = stripOneFormat(s);
    if (next === s) break;
    s = next;
  }
  s = s.replaceAll("\\&", "&").replaceAll("~", " ").replaceAll("\\ ", " ");
  s = s.replace(LEFTOVER_CMD_RE, " "); // drop remaining commands
  s = s.replaceAll("{", "").replaceAll("}", "");
  return stripChars(s.replace(/\s+/gu, " "), " ,.;");
}

function stripOneFormat(s: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    FORMAT_CMD_RE.lastIndex = i;
    const m = FORMAT_CMD_RE.exec(s);
    if (m !== null && m.index === i) {
      const inner = balanced(s, i + m[0].length - 1, "{", "}");
      if (inner !== undefined) {
        out.push(inner[0]);
        i = inner[1];
        continue;
      }
    }
    out.push(s[i] ?? "");
    i += 1;
  }
  return out.join("");
}

export interface TexReferences {
  references: Reference[];
  /** cite key -> ref id (the authoritative link the fuser consumes). */
  keyToRefId: Map<string, string>;
}

/** Build IR references from the .bbl facts (bibtex order, `ref-N` ids). */
export function buildTexReferences(facts: TexFacts): TexReferences {
  const references: Reference[] = [];
  const keyToRefId = new Map<string, string>();
  for (const [i, fact] of facts.references.entries()) {
    const rid = `ref-${i + 1}`;
    const cleaned = cleanBblText(fact.raw);
    const ref = parseOne(rid, cleaned, fact.label);
    // the fact's conservative identifiers override the heuristics
    if (fact.doi !== undefined) ref.doi = fact.doi;
    if (fact.arxiv !== undefined) ref.arxiv_id = fact.arxiv;
    if (fact.url !== undefined) ref.url = fact.url;
    ref.keys = [...new Set(ref.keys ?? [])];
    references.push(ref);
    keyToRefId.set(fact.key, rid);
  }
  return { references, keyToRefId };
}
