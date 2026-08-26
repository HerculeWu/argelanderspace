/**
 * Build the reference list for an arXiv LaTeX source
 * (`bibgraph/ingest_latex/references.py`).
 *
 * A paper resolves its citations one of two ways, and we mirror both:
 *
 * * a **compiled** bibliography — a `.bbl` file or an inline
 *   `\begin{thebibliography}` — whose `\bibitem[…]{key}` entries are exactly
 *   the cited works (BibTeX already pruned the rest);
 * * a **raw** `.bib` + `\bibliography{…}`, which we read with pandoc into
 *   CSL-JSON and then prune down to the keys actually cited.
 *
 * Either way the crucial output is the `key -> ref-id` map: the AST walker turns
 * each `\cite` key into the matching `[[cite:ref-N]]` token *authoritatively*,
 * with no author-year guessing.
 */

import { dirname, extname, isAbsolute, join } from "node:path";
import type { Reference } from "@argelanderspace/contracts";
import { pyOr, pyRe, stripChars } from "../../documents/pyregex.js";
import { matchKeys, parseOne } from "../../documents/references.js";
import { globExt, isFile, readTextLossy, rglobExt, withinTree, withSuffix } from "./fs-util.js";
import type { LatexPandocPort } from "./ports.js";

// AAS / common astronomy journal-abbreviation macros (aastex, mn2e, aa.bst).
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
  ["sovast", "Soviet Astron."],
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
// sorted(_JOURNAL_MACROS, key=len, reverse=True) — stable sort, like Python.
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
const BIBLIOGRAPHY_ENV_RE = /\\begin\{thebibliography\}([\s\S]*?)\\end\{thebibliography\}/;
const BIBLIOGRAPHY_CMD_RE = /\\bibliography\{([^}]*)\}/g;
const BIBITEM_RE = /\\bibitem/g;
const ARXIV_ABS_RE = /arxiv\.org\/abs\/([^\s/]+)/i;

// --------------------------------------------------------------------------- //
// Locating the bibliography
// --------------------------------------------------------------------------- //

/** The compiled bibliography text, from a `.bbl` file or inline env. */
function findBbl(mainTex: string, srcDir: string, raw: string): string | undefined {
  const cand = withSuffix(mainTex, ".bbl");
  if (isFile(cand)) return readTextLossy(cand);
  // prefer a .bbl next to the main file before falling back to a deep glob
  const bbls = globExt(dirname(mainTex), ".bbl");
  const found = bbls.length > 0 ? bbls : rglobExt(srcDir, ".bbl");
  const first = found[0];
  if (first !== undefined) return readTextLossy(first);
  const m = BIBLIOGRAPHY_ENV_RE.exec(raw);
  return m?.[1];
}

/** `.bib` files named by `\bibliography{a,b}` (or every .bib as fallback). */
function bibFiles(srcDir: string, raw: string): string[] {
  const names: string[] = [];
  for (const m of raw.matchAll(BIBLIOGRAPHY_CMD_RE)) {
    for (const n of (m[1] ?? "").split(",")) {
      const trimmed = n.trim();
      if (trimmed) names.push(trimmed);
    }
  }
  const files: string[] = [];
  for (const n of names) {
    let p = isAbsolute(n) ? n : join(srcDir, n);
    p = extname(p) === ".bib" ? p : withSuffix(p, ".bib");
    // \bibliography{../../secrets} must not read outside the source tree.
    if (isFile(p) && withinTree(srcDir, p)) {
      files.push(p);
    }
  }
  return files.length > 0 ? files : rglobExt(srcDir, ".bib");
}

// --------------------------------------------------------------------------- //
// Cleaning a \bibitem body
// --------------------------------------------------------------------------- //

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
    if (s[j] === lo) {
      depth += 1;
    } else if (s[j] === hi) {
      depth -= 1;
      if (depth === 0) return [s.slice(i + 1, j), j + 1];
    }
  }
  return [s.slice(i + 1), s.length];
}

/** Turn a raw `\bibitem` body into readable text (preserving DOI/arXiv). */
function cleanBblText(s0: string): string {
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

/** Return `[(key, clean_text, opt_label), …]` from a bibliography body. */
function parseBibitems(bbl: string): Array<[key: string, text: string, label: string | undefined]> {
  const out: Array<[string, string, string | undefined]> = [];
  const marks = [...bbl.matchAll(BIBITEM_RE)].map((m) => m.index);
  for (const [idx, pos] of marks.entries()) {
    let i = pos + "\\bibitem".length;
    while (i < bbl.length && [" ", "\t", "\r", "\n"].includes(bbl[i] ?? "")) {
      i += 1;
    }
    const opt = balanced(bbl, i, "[", "]");
    let label: string | undefined;
    if (opt !== undefined) {
      label = cleanBblText(opt[0]) || undefined;
      i = opt[1];
      while (i < bbl.length && [" ", "\t", "\r", "\n"].includes(bbl[i] ?? "")) {
        i += 1;
      }
    }
    const keyGrp = balanced(bbl, i, "{", "}");
    if (keyGrp === undefined) continue;
    const key = keyGrp[0].trim();
    const bodyStart = keyGrp[1];
    const next = marks[idx + 1];
    const bodyEnd = next !== undefined ? next : bbl.length;
    const body = cleanBblText(bbl.slice(bodyStart, bodyEnd));
    if (key && body) {
      out.push([key, body, label]);
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// CSL-JSON -> Reference
// --------------------------------------------------------------------------- //

/** Python `int(v)` for CSL date parts (truncating floats, parsing clean ints). */
function pyInt(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : undefined;
  if (typeof v === "string" && /^\s*[+-]?\d+\s*$/.test(v)) {
    return Number.parseInt(v.trim(), 10);
  }
  return undefined;
}

function cslYear(entry: Record<string, unknown>): number | undefined {
  const parts = pyOr(entry.issued) as Record<string, unknown> | undefined;
  const dateParts = pyOr(parts?.["date-parts"]) as unknown[] | undefined;
  const first = pyOr(dateParts?.[0]) as unknown[] | undefined;
  if (first === undefined) return undefined;
  return pyInt(first[0]);
}

function cslAuthors(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  const authors = pyOr(entry.author) as unknown[] | undefined;
  for (const a of authors ?? []) {
    const ao = a !== null && typeof a === "object" ? (a as Record<string, unknown>) : {};
    const name = (pyOr(ao.family) ?? pyOr(ao.literal) ?? "") as string;
    if (name) {
      out.push(name.trim());
    }
  }
  return out;
}

function refFromCsl(refId: string, entry: Record<string, unknown>): Reference {
  const authors = cslAuthors(entry);
  const year = cslYear(entry);
  const title = entry.title as string | undefined;
  const venue = (pyOr(entry["container-title"]) as string | undefined) ?? undefined;
  const url = entry.URL as string | undefined;
  let arxiv: string | undefined;
  if (url) {
    const m = ARXIV_ABS_RE.exec(url);
    if (m) arxiv = m[1];
  }
  const rawBits = [
    authors.join(", "),
    year ? String(year) : "",
    title || "",
    venue || "",
    (entry.volume as string | undefined) || "",
    (entry.page as string | undefined) || "",
  ];
  const raw = rawBits.filter((b) => b).join(", ");
  return {
    id: refId,
    raw,
    authors,
    year,
    title,
    venue,
    volume: entry.volume as string | undefined,
    pages: entry.page as string | undefined,
    doi: entry.DOI as string | undefined,
    arxiv_id: arxiv,
    url,
    keys: matchKeys(authors, year, undefined),
  };
}

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //

export interface LatexReferences {
  references: Reference[];
  /** cite key -> ref id (the authoritative link the walker consumes). */
  keyToRefId: Map<string, string>;
}

/**
 * Return the references + the cite-key -> ref-id map.
 *
 * *citedOrder* is the cite keys in first-appearance order (used to order and
 * prune the raw-.bib path; the compiled-.bbl path is kept verbatim).
 */
export function buildReferences(
  mainTex: string,
  srcDir: string,
  raw: string,
  citedOrder: readonly string[],
  pandoc: LatexPandocPort
): LatexReferences {
  const bbl = findBbl(mainTex, srcDir, raw);
  const references: Reference[] = [];
  const keyToRefId = new Map<string, string>();

  if (bbl?.includes("\\bibitem")) {
    for (const [i, [key, text, label]] of parseBibitems(bbl).entries()) {
      const rid = `ref-${i + 1}`;
      const ref = parseOne(rid, text, label);
      ref.keys = [...new Set(ref.keys)]; // author-year forms only
      references.push(ref);
      keyToRefId.set(key, rid);
    }
    return { references, keyToRefId };
  }

  const csl = pandoc.bibtexToCsl(bibFiles(srcDir, raw), srcDir);
  if (csl.length > 0) {
    const byKey = new Map<string, Record<string, unknown>>();
    for (const e of csl) {
      const id = e.id;
      if (typeof id === "string" && id) byKey.set(id, e);
    }
    // keep only cited entries (same set the .bbl path would have), in cite order
    const cited = citedOrder.filter((k) => byKey.has(k));
    for (const [i, key] of cited.entries()) {
      const rid = `ref-${i + 1}`;
      const entry = byKey.get(key);
      if (entry === undefined) continue;
      references.push(refFromCsl(rid, entry));
      keyToRefId.set(key, rid);
    }
    return { references, keyToRefId };
  }

  // no bibliography found (.bbl / thebibliography / .bib)
  return { references, keyToRefId };
}
