/**
 * BeautifulSoup-equivalent DOM helpers over cheerio/domhandler nodes
 * (the `html.parser` semantics the Python `ingest_html` adapters rely on).
 *
 * Parsing goes through the custom tree builder in `bs4-parser.ts` (htmlparser2
 * events, Python `html.parser` tree construction) — neither the full cheerio
 * `load` (parse5) nor `cheerio/slim` on a raw string is equivalent, because
 * both auto-close `<p>` before block-level children where html.parser nests
 * them. The builder's output is wrapped in a cheerio/slim CheerioAPI for CSS
 * selection, so adapters get cheerio's query API (decision 11) over a
 * bs4-shaped tree.
 *
 * The helpers here cover the bs4 APIs the adapters use, with bs4's exact
 * semantics where they diverge from cheerio's built-ins:
 * - `getText` mirrors `Tag.get_text(separator, strip)` — bs4 excludes comments
 *   and script/style raw text (probed against bs4 4.13);
 * - `nextSiblings` exposes the mixed tag/text sibling stream
 *   `Tag.next_siblings` provides.
 */

import type { CheerioAPI } from "cheerio";
import { load as slimLoad } from "cheerio/slim";
import { type AnyNode, type Element, hasChildren, isTag } from "domhandler";
import { parseBs4 } from "./bs4-parser.js";

/** Parse HTML the way `BeautifulSoup(html, "html.parser")` does: the custom
 *  tree builder in bs4-parser.ts reproduces html.parser's nesting (no `<p>`
 *  auto-close, no implied elements), wrapped in a cheerio/slim CheerioAPI for
 *  CSS selection. (The plain `cheerio`/`cheerio-slim` `load` on a string would
 *  apply HTML5 tree construction and is NOT equivalent — see the M3c memory
 *  note for the measured deltas.) */
export function loadHtml(html: string): CheerioAPI {
  return slimLoad(parseBs4(html));
}

/** `tag.name` (htmlparser2 lowercases, like bs4's html.parser builder). */
export function tagName(el: Element): string {
  return el.name.toLowerCase();
}

/** `tag.get("class") or []` — bs4 stores class as a list of tokens. */
export function classList(el: Element): string[] {
  const cls = el.attribs?.class;
  if (!cls) return [];
  return cls.split(/\s+/u).filter((t) => t.length > 0);
}

/** `tag.get(attr)` (single-valued attributes only; class goes through classList). */
export function getAttr(el: Element, name: string): string | undefined {
  return el.attribs?.[name];
}

/** Direct child elements only. */
export function childElements(el: Element): Element[] {
  return (el.children ?? []).filter(isTag);
}

/** Following siblings, tags + text (bs4 `Tag.next_siblings`). */
export function nextSiblings(el: Element): AnyNode[] {
  const out: AnyNode[] = [];
  let sib = el.nextSibling;
  while (sib) {
    out.push(sib);
    sib = sib.nextSibling;
  }
  return out;
}

/** Text content of a node, bs4 `get_text()` — comments and script/style
 *  raw text excluded (bs4 string-class filtering). */
export function getText(node: AnyNode): string {
  return collectText(node, "");
}

/** bs4 `get_text(separator, strip=...)`. */
export function getTextSep(node: AnyNode, separator: string, strip = false): string {
  return collectText(node, separator, strip);
}

function collectText(node: AnyNode, sep: string, strip = false): string {
  const parts: string[] = [];
  const walk = (n: AnyNode): void => {
    if (n.type === "text") {
      // domhandler Text inside <script>/<style> corresponds to bs4's
      // Script/Stylesheet string classes, which get_text excludes — those
      // subtrees are never recursed into (below).
      const s = strip ? n.data.trim() : n.data;
      if (strip && s.length === 0) return;
      parts.push(s);
      return;
    }
    if (n.type === "comment") return; // bs4 excludes comments from get_text
    if (isTag(n) && (n.name === "script" || n.name === "style")) return;
    if (hasChildren(n)) {
      for (const c of n.children) walk(c);
    }
  };
  walk(node);
  return parts.join(sep);
}

/** First descendant element matching `pred`, in document order (bs4 `find`). */
export function findWhere(node: AnyNode, pred: (e: Element) => boolean): Element | null {
  for (const d of descendants(node)) {
    if (pred(d)) return d;
  }
  return null;
}

/** All descendant elements matching `pred` (bs4 `find_all`). */
export function findAllWhere(node: AnyNode, pred: (e: Element) => boolean): Element[] {
  return descendants(node).filter(pred);
}

/** Descendant elements in document order (bs4 `find_all(True)` / `descendants`). */
export function descendants(node: AnyNode): Element[] {
  const out: Element[] = [];
  const walk = (n: AnyNode): void => {
    if (!hasChildren(n)) return;
    for (const c of n.children) {
      if (isTag(c)) {
        out.push(c);
      }
      walk(c);
    }
  };
  walk(node);
  return out;
}

/** bs4 `find(class_=re.compile(...))`: any class token matches the regex. */
export function classMatches(el: Element, re: RegExp): boolean {
  return classList(el).some((c) => re.test(c));
}

/** Serialize an element like bs4 `str(tag)` (see serialize.ts). */
export { bs4OuterHtml } from "./serialize.js";

/** Re-export the CheerioAPI type for adapter signatures. */
export type { CheerioAPI };
