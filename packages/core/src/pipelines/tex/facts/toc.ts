/**
 * .toc parser: section hierarchy as a flat, document-ordered list.
 *
 *   \contentsline{section}{\numberline{1}Title}{page}
 *
 * Newer kernels append a fourth (anchor) argument; it is ignored. Entries
 * without \numberline (unnumbered headings) get number: "". Fed a .lof/.lot
 * the same shape yields figure/table entries.
 */
import { readTexGroup, readTexGroups, texCommandPositions } from "./scan.js";

export interface TexTocEntry {
  /** section / subsection / ... (figure / table when fed .lof/.lot). */
  level: string;
  number: string;
  title: string;
  page: string;
}

export function parseToc(content: string): TexTocEntry[] {
  const toc: TexTocEntry[] = [];
  for (const at of texCommandPositions(content, "contentsline")) {
    const groups = readTexGroups(content, at, 3);
    const level = groups?.[0];
    const heading = groups?.[1];
    const page = groups?.[2];
    if (!level || !heading || !page) continue;
    let number = "";
    let title = heading.content.trim();
    if (/^\\numberline\s*\{/.test(title)) {
      const g = readTexGroup(title, title.indexOf("{"));
      if (g) {
        number = g.content;
        title = title.slice(g.end).trim();
      }
    }
    toc.push({ level: level.content.trim(), number, title, page: page.content.trim() });
  }
  return toc;
}
