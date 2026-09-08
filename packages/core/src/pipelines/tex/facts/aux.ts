/**
 * .aux parser: cross-reference labels plus citation bookkeeping.
 *
 *   \newlabel{key}{{number}{page}{title}{anchor}{...}}
 *   \citation{key}            (one per \cite, comma lists split)
 *   \bibcite{key}{number}
 *
 * The \newlabel field pack has 2 fields in the classic format and 5 with
 * hyperref/nameref; field 3 (title) is kept only when non-empty. Displayed
 * numbers are the compiler's true printed values (Stage 5 Q2: print-faithful
 * numbering); duplicate keys: last wins.
 */
import { readTexGroup, readTexGroups, skipTexWhitespace, texCommandPositions } from "./scan.js";
import type { TexTocEntry } from "./toc.js";
import { parseToc } from "./toc.js";

export interface TexLabelFact {
  number: string;
  page: string;
  title?: string;
}

export interface TexAuxFacts {
  /** \newlabel key → {number, page, title?}. */
  labels: Record<string, TexLabelFact>;
  /** \citation keys in first-appearance order. */
  citations: string[];
  /** \bibcite key → bibliography number. */
  bibcites: Record<string, string>;
  /**
   * `\@writefile{lof}{\contentsline…}` records: figures in print order with
   * their true numbers — present in the .aux whether or not \listoffigures ran.
   */
  lof: TexTocEntry[];
  /** Same for tables (.lot). */
  lot: TexTocEntry[];
}

export function parseAux(content: string): TexAuxFacts {
  const labels: Record<string, TexLabelFact> = {};
  const citations: string[] = [];
  const bibcites: Record<string, string> = {};

  for (const at of texCommandPositions(content, "newlabel")) {
    const keyGroups = readTexGroups(content, at, 1);
    const keyGroup = keyGroups?.[0];
    if (!keyGroup) continue;
    const outer = readTexGroup(content, skipTexWhitespace(content, keyGroup.end));
    if (!outer) continue;
    // Unpack the consecutive sub-groups: {number}{page}{title}{anchor}{...}
    const fields: string[] = [];
    let i = skipTexWhitespace(outer.content, 0);
    while (i < outer.content.length) {
      const g = readTexGroup(outer.content, i);
      if (!g) break;
      fields.push(g.content);
      i = skipTexWhitespace(outer.content, g.end);
    }
    const [number, page, title] = fields;
    if (number === undefined || page === undefined) continue;
    const fact: TexLabelFact = { number, page };
    if (title !== undefined && title.trim() !== "") fact.title = title;
    labels[keyGroup.content] = fact;
  }

  for (const at of texCommandPositions(content, "citation")) {
    const groups = readTexGroups(content, at, 1);
    const group = groups?.[0];
    if (!group) continue;
    for (const raw of group.content.split(",")) {
      const key = raw.trim();
      if (key !== "" && !citations.includes(key)) citations.push(key);
    }
  }

  for (const at of texCommandPositions(content, "bibcite")) {
    const groups = readTexGroups(content, at, 2);
    const key = groups?.[0];
    const num = groups?.[1];
    if (!key || !num) continue;
    bibcites[key.content] = num.content;
  }

  const lof: TexTocEntry[] = [];
  const lot: TexTocEntry[] = [];
  for (const at of texCommandPositions(content, "@writefile")) {
    const groups = readTexGroups(content, at, 2);
    const which = groups?.[0];
    const payload = groups?.[1];
    if (!which || !payload) continue;
    const target = which.content === "lof" ? lof : which.content === "lot" ? lot : null;
    if (target === null) continue;
    for (const entry of parseToc(payload.content)) target.push(entry);
  }

  return { labels, citations, bibcites, lof, lot };
}
