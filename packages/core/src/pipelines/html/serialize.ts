/**
 * bs4-compatible HTML serializer (`str(tag)` / `str(soup)`).
 *
 * The HTML adapters serialize DOM subtrees in two places whose output lands in
 * the Document JSON *byte-for-byte* (`_clean_table_html`'s `table_body`) or is
 * fed to pandoc (`mathml_to_latex(str(math_el))`). cheerio's serializer
 * (dom-serializer / parse5) encodes non-ASCII as `&#x…;` entities and renders
 * empty non-void elements as `<tag/>`; BeautifulSoup's `html` formatter keeps
 * UTF-8 raw and renders `<tag></tag>`. The golden `table_body` strings contain
 * raw UTF-8, so we replicate bs4 here (probed against bs4 4.13):
 *
 * - text: escape `&`, `<`, `>` only; non-ASCII (incl. NBSP) stays raw;
 * - attributes: `&` → `&amp;`; values containing `"` are single-quoted, others
 *   double-quoted; `<`/`>`/non-ASCII stay raw; valueless attrs render `=""`;
 *   multi-valued attrs (class etc.) are re-joined with single spaces;
 * - void elements render `<tag/>`; empty non-void elements render `<tag></tag>`;
 * - comments/CDATA render as `<!--…-->` / `<![CDATA[…]]>`.
 */

import { type AnyNode, type Element, isTag } from "domhandler";

/** bs4 html.parser tree builder's empty-element (void) tag set. */
const VOID_TAGS = new Set([
  "area",
  "base",
  "basefont",
  "bgsound",
  "br",
  "col",
  "command",
  "embed",
  "frame",
  "hr",
  "image",
  "img",
  "input",
  "isindex",
  "keygen",
  "link",
  "menuitem",
  "meta",
  "nextid",
  "param",
  "source",
  "spacer",
  "track",
  "wbr",
]);

/** bs4 cdata-list attributes: parsed as token lists, re-joined with " ". */
const CDATA_LIST_ANY = new Set(["class", "accesskey", "dropzone"]);
const CDATA_LIST_BY_TAG: Record<string, Set<string>> = {
  a: new Set(["rel", "rev"]),
  link: new Set(["rel", "rev"]),
  td: new Set(["headers"]),
  th: new Set(["headers"]),
  form: new Set(["accept-charset"]),
};

function escapeText(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttrValue(tag: string, name: string, value: string): string {
  let v = value;
  if (CDATA_LIST_ANY.has(name) || CDATA_LIST_BY_TAG[tag]?.has(name)) {
    v = v
      .split(/\s+/u)
      .filter((t) => t.length > 0)
      .join(" ");
  }
  v = v.replaceAll("&", "&amp;");
  // bs4: values containing a double quote are wrapped in single quotes.
  return v.includes('"') ? `'${v}'` : `"${v}"`;
}

function serializeNode(node: AnyNode, out: string[]): void {
  if (node.type === "text") {
    out.push(escapeText(node.data));
    return;
  }
  if (node.type === "comment") {
    out.push(`<!--${node.data}-->`);
    return;
  }
  if (node.type === "cdata") {
    for (const c of node.children ?? []) {
      out.push(`<![CDATA[${c.type === "text" ? c.data : ""}]]>`);
    }
    return;
  }
  if (node.type === "directive") {
    out.push(`<${node.data}>`);
    return;
  }
  if (!isTag(node)) return;
  const attrs = Object.entries(node.attribs ?? {})
    .map(([k, v]) => ` ${k}=${escapeAttrValue(node.name, k, v)}`)
    .join("");
  const kids = node.children ?? [];
  if (VOID_TAGS.has(node.name)) {
    out.push(`<${node.name}${attrs}/>`);
    return;
  }
  out.push(`<${node.name}${attrs}>`);
  serializeNodes(kids, out);
  out.push(`</${node.name}>`);
}

function serializeNodes(nodes: readonly AnyNode[], out: string[]): void {
  for (const n of nodes) serializeNode(n, out);
}

/** bs4 `str(tag)`: the element including its own open/close tag. */
export function bs4OuterHtml(el: Element): string {
  const out: string[] = [];
  serializeNode(el, out);
  return out.join("");
}

/** bs4 `str(soup)`: serialize a node list (e.g. a document root's children). */
export function bs4ChildrenHtml(nodes: readonly AnyNode[]): string {
  const out: string[] = [];
  serializeNodes(nodes, out);
  return out.join("");
}
