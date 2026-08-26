/**
 * Port of `bibgraph/ingest_html/aanda.py`: Astronomy & Astrophysics (EDP
 * Sciences) HTML adapter. See the Python module docstring for the page layout
 * (`div#contenu` flat reading order, `h2.sec`/`h3.sec2` headings,
 * `span.ressouce-equation` display equations with `data-latex`, `div.inset`
 * floats with table bodies on `T<n>.html` sub-pages, `<li id="R<n>">` refs).
 *
 * The DOM is parsed by the bs4-semantic tree builder (dom.ts `loadHtml`), so
 * the walk sees the same nesting Python's html.parser produced (e.g. float
 * wrappers stay `<p><div class="inset">…</div></p>`, handled by the p-branch's
 * inset search).
 */

import type {
  Block,
  EquationBlock,
  FigureBlock,
  ListBlock,
  ParagraphBlock,
  Reference,
  RichText,
  Section,
  TableBlock,
} from "@argelanderspace/contracts";
import type { CheerioAPI } from "cheerio";
import { type AnyNode, type Element, isTag } from "domhandler";
import type { Match } from "../../documents/annotate.js";
import { rstripChars, stripChars } from "../../documents/pyregex.js";
import { parseOne } from "../../documents/references.js";
import {
  type AdapterParseContext,
  type HtmlAdapter,
  matchesByHost,
  type ParsedDoc,
  registerAdapter,
} from "./base.js";
import {
  childElements,
  classList,
  findAllWhere,
  findWhere,
  getAttr,
  getText,
  getTextSep,
  loadHtml,
  nextSiblings,
  tagName,
} from "./dom.js";
import { type AnchorTarget, type InlineContext, plainText, renderInline } from "./inline.js";
import { annotationLatex, stripMathDelims } from "./mathml.js";
import { bs4ChildrenHtml, bs4OuterHtml } from "./serialize.js";

const APPENDIX_RE = /^\s*Appendix\s+([A-Z]+)\b\s*[:.]?\s*(.*)$/i;
const HEADING_NUM_RE = /^\s*((?:\d+\.)*\d+)\.?\s+(.*\S)\s*$/;
// venue/volume/pages tail of an A&A reference, after the publication year
const REF_TAIL_RE =
  /(?:19|20)\d{2}[a-z]?\s*,\s*(?<venue>[^,]+?)\s*,\s*(?<vol>[A-Za-z]?\d+)\s*,\s*(?<pages>[A-Za-z]?\d+(?:\s*[-–]\s*\d+)?)/;
const ABSTRACT_LABEL_RE = /^key\s*words?\b/i;
const ABSTRACT_MARKER_RE =
  /^(context|aims?|methods?|results?|conclusions?|summary|background|purpose)\b/i;

class IdGen {
  private readonly c = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.c.get(prefix) ?? 0) + 1;
    this.c.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

/** A rich-text holder plus the inline DOM it renders from (Python's
 *  `(holder, node)` pairs; `node` is a list when a paragraph was split around
 *  block equations). */
interface Holder {
  holder: RichText;
  node: Element | AnyNode[];
}

/** `str.strip()`-based emptiness for a buffered node (Tag or text). */
function bufNodeHasText(n: AnyNode): boolean {
  if (n.type === "text") return n.data.trim().length > 0;
  if (isTag(n)) return getTextSep(n, "", true).length > 0;
  return false;
}

/** RFC-join a possibly-relative URL (Python `urljoin`). */
export function urlJoin(base: string, rel: string): string {
  try {
    return new URL(rel, base).href;
  } catch {
    return rel;
  }
}

/** The A&A adapter (registered at module import). */
class AandaAdapter implements HtmlAdapter {
  readonly name = "aanda";
  readonly publisher = "A&A";
  readonly doiPrefixes = ["10.1051/0004-6361"] as const;
  readonly hostHints = ["aanda.org"] as const;

  matches(url: string, soup: CheerioAPI): boolean {
    if (matchesByHost(this, url)) return true;
    const gen = soup('meta[name="citation_journal_title"]').first().attr("content") ?? "";
    const g = gen.toLowerCase();
    return g.includes("astronomy") && g.includes("astrophysics");
  }

  // -- entry point -------------------------------------------------------- //
  async parse(soup: CheerioAPI, ctx: AdapterParseContext): Promise<ParsedDoc> {
    let baseUrl = ctx.baseUrl;
    let page = soup;
    let contenu = page("div#contenu").first();
    if (contenu.length === 0) {
      const relocated = await this.locateFulltext(page, baseUrl, ctx);
      baseUrl = relocated.baseUrl;
      page = relocated.soup;
      contenu = page("div#contenu").first();
    }
    if (contenu.length === 0) {
      throw new Error("A&A: could not find the full-text body (div#contenu)");
    }

    const ids = new IdGen();
    const amap = new Map<string, AnchorTarget>();
    const holders: Holder[] = [];

    const title = this.extractTitle(page);
    const meta = this.extractMeta(page);

    const sections = await this.walk(contenu.get(0) as Element, ids, amap, holders, {
      ...ctx,
      baseUrl,
    });

    // references (also fills amap for #R<n>)
    const references = this.extractReferences(page, ids, amap);

    // second pass: now the anchor map is complete (incl. forward refs),
    // render every text holder's inline content into body text + anchors.
    const ictx: InlineContext = {
      resolve: (frag) => amap.get(frag),
      inlineMath: ctx.config.inlineMath,
      mathml: ctx.mathml,
    };
    const anchorMatches = new Map<RichText, Match[]>();
    for (const { holder, node } of holders) {
      const { text, matches } = renderInline(node, ictx);
      holder.text = text;
      anchorMatches.set(holder, matches);
    }

    return {
      sections,
      references,
      title,
      meta,
      sourceExtra: { publisher: "EDP Sciences / A&A", doi: meta.doi, url: baseUrl },
      anchorMatches,
    };
  }

  // -- title / meta ------------------------------------------------------- //
  private extractTitle(soup: CheerioAPI): string | undefined {
    const m = soup('meta[name="citation_title"]').first();
    const content = m.attr("content");
    if (m.length > 0 && content) return content.trim();
    const h = soup("div#contenu h2.title").first();
    return h.length > 0 ? plainText(h.get(0) as Element) : undefined;
  }

  private extractMeta(soup: CheerioAPI): Record<string, unknown> {
    const metac = (name: string): string | undefined => {
      const e = soup(`meta[name="${name}"]`).first();
      const c = e.attr("content");
      return e.length > 0 && c ? c.trim() : undefined;
    };
    const authors = soup('meta[name="citation_author"]')
      .toArray()
      .filter((e) => isTag(e) && (e.attribs?.content ?? "") !== "")
      .map((e) => ((e as Element).attribs?.content ?? "").trim());
    return {
      doi: metac("citation_doi"),
      journal: metac("citation_journal_title"),
      volume: metac("citation_volume"),
      year: metac("citation_publication_date"),
      authors,
      adapter: "aanda",
    };
  }

  // -- structural walk ---------------------------------------------------- //
  private async walk(
    contenu: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Promise<Section[]> {
    const roots: Section[] = [];
    const stack: Section[] = [];
    let current: Section | null = null;
    let skipBlocks = false;
    let inBody = false; // True once the first real section heading is seen
    let appendixN = 0;

    const addSection = (sec: Section, level: number): void => {
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (parent) {
        if (!parent.children) parent.children = [];
        parent.children.push(sec);
      } else {
        roots.push(sec);
      }
      stack.push(sec);
      current = sec;
    };

    // Abstract (one or more <p> inside div#head) becomes a leading section.
    const absNodes = this.abstractNodes(contenu);
    if (absNodes.length > 0) {
      const sec: Section = {
        id: ids.next("sec"),
        type: "section",
        level: 1,
        heading: "Abstract",
        heading_raw: "Abstract",
        page_idx: 0,
        blocks: [],
        children: [],
      };
      for (const node of absNodes) {
        const para: ParagraphBlock = {
          id: ids.next("p"),
          type: "paragraph",
          page_idx: 0,
          text: "",
        };
        holders.push({ holder: para, node });
        sec.blocks?.push(para);
      }
      roots.push(sec);
      stack.push(sec);
      current = sec;
    }

    for (const child of contenu.children ?? []) {
      if (!isTag(child)) continue;
      const name = tagName(child);
      const cls = classList(child);
      const hid = getAttr(child, "id") ?? "";

      if (name === "h2" || name === "h3" || name === "h4") {
        if (cls.includes("title") || cls.includes("subtitle")) {
          continue; // article title/subtitle
        }
        if (hid === "tables" || hid === "figures") {
          break; // end-of-paper galleries
        }
        inBody = true; // we're past the front matter
        if (hid === "references") {
          skipBlocks = true; // skip the bibliography <ol>
          current = null;
          continue;
        }
        skipBlocks = false;
        const level = { h2: 1, h3: 2, h4: 3 }[name] ?? 1;
        const sec = this.makeSection(child, ids, amap, level);
        if (APPENDIX_RE.test(plainText(child))) {
          appendixN += 1;
          amap.set(`APP${appendixN}`, { role: "xref", targetId: sec.id, xrefKind: "appendix" });
        }
        addSection(sec, level);
        continue;
      }

      // Drop front matter (copyright, dates, stray notes) that sits between
      // the header and the first section.
      if (skipBlocks || !inBody) continue;

      const blocks = await this.makeBlock(child, ids, amap, holders, ctx);
      if (blocks.length === 0) continue;
      if (current === null) {
        current = {
          id: ids.next("sec"),
          type: "section",
          level: 1,
          heading: "",
          page_idx: 0,
          blocks: [],
          children: [],
        };
        roots.push(current);
        stack.push(current);
      }
      if (!current.blocks) current.blocks = [];
      current.blocks.push(...blocks);
    }

    return roots;
  }

  /** The abstract paragraph(s) (see the Python docstring: structured abstracts
   *  are one <p> per part, so collect them all — not just the longest). */
  private abstractNodes(contenu: Element): Element[] {
    const head = findWhere(contenu, (e) => e.name === "div" && getAttr(e, "id") === "head");
    if (!head) return [];

    // 1) explicit "Abstract" label -> the following <p> siblings, up to the
    //    keywords block.
    const LABEL_TAGS = new Set(["p", "h2", "h3", "h4", "strong", "b"]);
    const label = findAllWhere(
      head,
      (e) => LABEL_TAGS.has(e.name) && getTextSep(e, "", true).toLowerCase() === "abstract"
    )[0];
    if (label) {
      const parts: Element[] = [];
      for (const sib of nextSiblings(label)) {
        if (!isTag(sib)) continue;
        const txt = getTextSep(sib, " ", true);
        const cls = classList(sib).join(" ");
        if (cls.toLowerCase().includes("kw") || ABSTRACT_LABEL_RE.test(txt)) break;
        if (sib.name === "h2" || sib.name === "h3" || sib.name === "h4") break;
        if (sib.name === "p" && txt) parts.push(sib);
      }
      if (parts.length > 0) return parts;
    }

    // 2) structured-abstract paragraphs identified by their leading marker.
    const marked = findAllWhere(
      head,
      (e) => e.name === "p" && ABSTRACT_MARKER_RE.test(getTextSep(e, "", true))
    );
    if (marked.length > 0) return marked;

    // 3) fallback: the single longest prose paragraph in the header.
    let best: Element | null = null;
    let bestLen = -1;
    for (const p of findAllWhere(head, (e) => e.name === "p")) {
      const stripped = getTextSep(p, "", true);
      // Python `len(...)` counts code points.
      const strippedLen = [...stripped].length;
      if (strippedLen <= 120 || stripped.startsWith("©")) continue;
      const totalLen = [...getText(p)].length;
      if (totalLen > bestLen) {
        best = p;
        bestLen = totalLen;
      }
    }
    return best ? [best] : [];
  }

  private makeSection(
    h: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    level: number
  ): Section {
    const raw = plainText(h);
    let number: string | undefined;
    let heading = raw;
    const ma = APPENDIX_RE.exec(raw);
    const mn = HEADING_NUM_RE.exec(raw);
    if (ma) {
      number = ma[1] ?? "";
      heading = (ma[2] ?? "").trim() || raw;
    } else if (mn) {
      number = mn[1] ?? "";
      heading = (mn[2] ?? "").trim();
    }
    const sec: Section = {
      id: ids.next("sec"),
      type: "section",
      level,
      heading,
      heading_raw: raw,
      number,
      page_idx: 0,
      blocks: [],
      children: [],
    };
    const hid = getAttr(h, "id") ?? "";
    if (/^S\d+$/.test(hid)) {
      amap.set(hid, { role: "xref", targetId: sec.id, xrefKind: "section" });
    }
    return sec;
  }

  private async makeBlock(
    node: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Promise<Block[]> {
    const name = tagName(node);
    const cls = classList(node);

    if (name === "p") {
      const inset = findWhere(node, (e) => e.name === "div" && classList(e).includes("inset"));
      if (inset) {
        const b = await this.insetBlock(inset, ids, amap, holders, ctx);
        return b ? [b] : [];
      }
      // Display equations: a <p> may be equation-only (older A&A template)
      // or have the equation embedded mid-prose (2024+). Split either way.
      if (
        findWhere(
          node,
          (e) => e.name === "span" && classList(e).includes("ressouce-equation-block")
        )
      ) {
        return this.splitParaEqs(node, ids, amap, holders, ctx);
      }
      if (!plainText(node)) return [];
      const para: ParagraphBlock = { id: ids.next("p"), type: "paragraph", page_idx: 0, text: "" };
      holders.push({ holder: para, node });
      return [para];
    }

    if (name === "div" && cls.includes("inset")) {
      const b = await this.insetBlock(node, ids, amap, holders, ctx);
      return b ? [b] : [];
    }

    if (name === "ol" || name === "ul") {
      const b = this.makeList(node, ids, holders, name === "ol");
      return b ? [b] : [];
    }

    // Other divs under #contenu are non-body — skip rather than risk pulling
    // the wrong text. Body prose is always flat <p>/<h*> in A&A.
    return [];
  }

  /** Split a paragraph around its display-equation spans, yielding an ordered
   *  mix of Paragraph (the prose between equations) and EquationBlock. */
  private splitParaEqs(
    p: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Block[] {
    const out: Block[] = [];
    let buf: AnyNode[] = [];

    const flush = (): void => {
      if (buf.length === 0) return;
      if (buf.some(bufNodeHasText)) {
        const para: ParagraphBlock = {
          id: ids.next("p"),
          type: "paragraph",
          page_idx: 0,
          text: "",
        };
        holders.push({ holder: para, node: [...buf] });
        out.push(para);
      }
      buf = [];
    };

    for (const child of p.children ?? []) {
      if (isTag(child) && classList(child).includes("ressouce-equation-block")) {
        flush();
        out.push(this.makeEquation(child, ids, amap, ctx));
      } else {
        buf.push(child);
      }
    }
    flush();
    return out;
  }

  private async insetBlock(
    inset: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Promise<Block | null> {
    const hid = getAttr(inset, "id") ?? "";
    if (/^F\d+$/.test(hid)) {
      return this.makeFigure(inset, hid, ids, amap, holders, ctx);
    }
    if (/^T\d+$/.test(hid)) {
      return this.makeTable(inset, hid, ids, amap, holders, ctx);
    }
    return null; // id-less gallery inset
  }

  private makeEquation(
    eq: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    ctx: AdapterParseContext
  ): EquationBlock {
    // Source priority: original TeX annotation -> pandoc(MathML), which is
    // reliably KaTeX-clean -> the data-latex attribute.
    let latex = "";
    const mathEl = findWhere(eq, (e) => e.name === "math");
    if (mathEl) {
      const ann = annotationLatex(mathEl) ?? "";
      latex = ann ? stripMathDelims(ann) : (ctx.mathml.mathmlToLatex(bs4OuterHtml(mathEl)) ?? "");
    }
    if (!latex) {
      const dl = getAttr(eq, "data-latex");
      if (dl) latex = stripMathDelims(stripAligned(dl));
    }
    const hid = getAttr(eq, "id") ?? "";
    const m = /^FD(\d+)$/.exec(hid);
    const number = m?.[1];
    const blk: EquationBlock = {
      id: ids.next("eq"),
      type: "equation",
      page_idx: 0,
      number,
      label: number ? `Equation ${number}` : undefined,
      latex,
    };
    if (hid) amap.set(hid, { role: "xref", targetId: blk.id, xrefKind: "equation" });
    return blk;
  }

  private async makeFigure(
    node: Element,
    hid: string,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Promise<FigureBlock> {
    const n = hid.slice(1);
    const capNode = this.captionNode(node);
    const cap: RichText = { text: "" };
    if (capNode) holders.push({ holder: cap, node: capNode });
    let imgPath: string | undefined;
    const img = findWhere(node, (e) => e.name === "img");
    const src = img ? getAttr(img, "src") : undefined;
    if (img && src) {
      const full = urlJoin(ctx.baseUrl, src.replace(/_small(\.[a-z]+)$/i, "$1"));
      imgPath = await this.asset(full, ctx);
    }
    const blk: FigureBlock = {
      id: ids.next("fig"),
      type: "figure",
      page_idx: 0,
      number: n,
      label: `Figure ${n}`,
      caption: capNode ? cap : undefined,
      img_path: imgPath,
    };
    amap.set(hid, { role: "xref", targetId: blk.id, xrefKind: "figure" });
    return blk;
  }

  private async makeTable(
    node: Element,
    hid: string,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Promise<TableBlock> {
    const n = hid.slice(1);
    const capNode = this.captionNode(node);
    const cap: RichText = { text: "" };
    if (capNode) holders.push({ holder: cap, node: capNode });
    let tableBody: string | undefined;
    if (ctx.config.fetchSubpages) {
      tableBody = await this.fetchTableBody(node, ctx);
    }
    const blk: TableBlock = {
      id: ids.next("tab"),
      type: "table",
      page_idx: 0,
      number: n,
      label: `Table ${n}`,
      caption: capNode ? cap : undefined,
      table_body: tableBody,
    };
    amap.set(hid, { role: "xref", targetId: blk.id, xrefKind: "table" });
    return blk;
  }

  private makeList(
    node: Element,
    ids: IdGen,
    holders: Holder[],
    ordered: boolean
  ): ListBlock | null {
    const items: RichText[] = [];
    for (const li of childElements(node)) {
      if (li.name !== "li") continue;
      if (!plainText(li)) continue;
      const rt: RichText = { text: "" };
      holders.push({ holder: rt, node: li });
      items.push(rt);
    }
    if (items.length === 0) return null;
    return { id: ids.next("list"), type: "list", page_idx: 0, ordered, items };
  }

  // -- float helpers ------------------------------------------------------ //
  /** The <p> carrying the float caption (figures: in td.img-txt; tables: in
   *  div.ligne). Falls back to any <p> in the inset. */
  private captionNode(node: Element): Element | null {
    const cell =
      findWhere(node, (e) => e.name === "td" && classList(e).includes("img-txt")) ??
      findWhere(node, (e) => e.name === "div" && classList(e).includes("ligne"));
    const scope = cell ?? node;
    return findWhere(scope, (e) => e.name === "p");
  }

  private async fetchTableBody(
    node: Element,
    ctx: AdapterParseContext
  ): Promise<string | undefined> {
    const link = findWhere(node, (e) => e.name === "a" && getAttr(e, "href") !== undefined);
    if (!link) return undefined;
    const url = urlJoin(ctx.baseUrl, getAttr(link, "href") ?? "");
    let sub: CheerioAPI;
    try {
      const { text } = await ctx.fetcher.get(url);
      sub = loadHtml(text);
    } catch {
      return undefined; // table sub-page fetch failed -> caption-only
    }
    const tables = sub("table").toArray().filter(isTag);
    if (tables.length === 0) return undefined;
    let best: Element | null = null;
    let bestRows = -1;
    for (const t of tables) {
      const rows = findAllWhere(t, (e) => e.name === "tr").length;
      if (rows > bestRows) {
        best = t;
        bestRows = rows;
      }
    }
    return best ? cleanTableHtml(best) : undefined;
  }

  private async asset(url: string, ctx: AdapterParseContext): Promise<string | undefined> {
    if (!ctx.config.downloadAssets) return url; // remote-reference mode
    const fn = (url.split("/").pop() ?? "").split("?")[0]?.replace(/[^A-Za-z0-9._-]+/g, "_") ?? "";
    const dest = `${ctx.assetDir}/${fn}`;
    if (await ctx.fetcher.download(url, dest)) return `assets/${fn}`;
    return undefined; // failed: caption-only
  }

  // -- references --------------------------------------------------------- //
  private extractReferences(
    soup: CheerioAPI,
    ids: IdGen,
    amap: Map<string, AnchorTarget>
  ): Reference[] {
    const refs: Reference[] = [];
    for (const li of soup("li[id]").toArray().filter(isTag)) {
      const lid = getAttr(li, "id") ?? "";
      if (!/^R\d+$/.test(lid)) continue;
      const rid = ids.next("ref");
      refs.push(parseAandaRef(li, rid));
      amap.set(lid, { role: "cite", refId: rid });
    }
    return refs;
  }

  // -- full-text location fallback --------------------------------------- //
  private async locateFulltext(
    soup: CheerioAPI,
    baseUrl: string,
    ctx: AdapterParseContext
  ): Promise<{ baseUrl: string; soup: CheerioAPI }> {
    const root = soup.root().get(0);
    const a = root
      ? findWhere(
          root,
          (e) => e.name === "a" && /full_html\/.*\.html/.test(getAttr(e, "href") ?? "")
        )
      : null;
    if (a && getAttr(a, "href")) {
      const url = urlJoin(baseUrl, (getAttr(a, "href") ?? "").split("#")[0] ?? "");
      const { finalUrl, text } = await ctx.fetcher.get(url);
      return { baseUrl: finalUrl, soup: loadHtml(text) };
    }
    return { baseUrl, soup };
  }
}

// --------------------------------------------------------------------------- //
// Module helpers
// --------------------------------------------------------------------------- //

/** Unwrap a single-row `\begin{aligned}..\end{aligned}` (A&A wraps every
 *  display equation in it); multi-row alignments are kept intact. */
function stripAligned(latex: string): string {
  const s = stripMathDelims(latex.trim());
  const m = /^\\begin\{aligned\}([\s\S]*)\\end\{aligned\}$/.exec(s.trim());
  if (m && !(m[1] ?? "").includes("\\\\")) {
    return rstripChars((m[1] ?? "").trim(), "&").trim();
  }
  return s;
}

const TABLE_KEEP = new Set([
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "sub",
  "sup",
  "i",
  "b",
  "em",
  "strong",
  "br",
  "span",
]);
const TABLE_ATTRS = new Set(["colspan", "rowspan", "align", "valign"]);

/** Serialize a data table, dropping links/attrs/classes the reader can't use
 *  (footnote anchors are unwrapped to their text; structure + sub/sup kept).
 *  The serialization is bs4-compatible byte-for-byte (see serialize.ts). */
export function cleanTableHtml(table: Element): string {
  const soup = loadHtml(bs4OuterHtml(table));
  // unwrap <a> (keep children)
  for (const a of soup("a").toArray()) {
    soup(a).replaceWith(soup(a).contents());
  }
  for (const tag of soup("*").toArray()) {
    if (!isTag(tag)) continue;
    if (!TABLE_KEEP.has(tag.name)) {
      soup(tag).replaceWith(soup(tag).contents());
      continue;
    }
    for (const k of Object.keys(tag.attribs ?? {})) {
      if (!TABLE_ATTRS.has(k)) {
        soup(tag).removeAttr(k);
      }
    }
  }
  const root = soup.root().get(0);
  return bs4ChildrenHtml(root?.children ?? []).trim();
}

/** Parse one `<li id="R..">` bibliography entry into a Reference. */
function parseAandaRef(li: Element, refId: string): Reference {
  // raw text = the entry minus the trailing [NASA ADS]/[CrossRef]/... links.
  const clone = loadHtml(bs4OuterHtml(li));
  for (const a of clone("a").toArray()) clone(a).remove();
  for (const sp of clone("span.Z3988").toArray()) clone(sp).remove();
  const root = clone.root().get(0);
  const raw = stripChars(getTextSep(root ?? li, " ").replace(/\s+/gu, " "), " .;,");

  const ref = parseOne(refId, raw, undefined);

  // authoritative DOI / arXiv / ADS bibcode from the entry's links
  for (const a of findAllWhere(li, (e) => e.name === "a" && getAttr(e, "href") !== undefined)) {
    const href = getAttr(a, "href") ?? "";
    if (href.includes("doi.org/") && !ref.doi) {
      ref.doi = rstripChars(href.split("doi.org/").pop() ?? "", ".,);");
    }
    if (href.toLowerCase().includes("arxiv.org") && !ref.arxiv_id) {
      const m = /(\d{4}\.\d{4,5})/.exec(href);
      if (m) ref.arxiv_id = m[1];
    }
  }

  // venue / volume / pages from the consistent A&A tail
  const m = REF_TAIL_RE.exec(raw);
  if (m?.groups) {
    ref.venue = ref.venue || (m.groups.venue ?? "").trim();
    ref.volume = ref.volume || m.groups.vol;
    ref.pages = ref.pages || (m.groups.pages ?? "").replace(/\s/gu, "");
  }
  return ref;
}

export const aandaAdapter = registerAdapter(new AandaAdapter());
