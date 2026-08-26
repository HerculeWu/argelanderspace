/**
 * Port of `bibgraph/ingest_html/oup.py`: Oxford University Press (Silverchair)
 * HTML adapter — MNRAS et al. See the Python module docstring for the layout
 * (`div.article-body` / flat `div.widget-items` reading order, `h2.section-title`
 * headings, `data-reveal-id` citation anchors rewritten to fragment hrefs,
 * `div.disp-formula` equations — MathML on modern papers, rendered images on
 * legacy ones, `div.fig.fig-section` figures, `div.ref-list > div.ref` refs).
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
import { pyRe, rstripChars, stripChars } from "../../documents/pyregex.js";
import { parseOne } from "../../documents/references.js";
import { cleanTableHtml, urlJoin } from "./aanda.js";
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
  classMatches,
  findAllWhere,
  findWhere,
  getAttr,
  getTextSep,
  loadHtml,
  tagName,
} from "./dom.js";
import { type AnchorTarget, type InlineContext, plainText, renderInline } from "./inline.js";
import { stripMathDelims } from "./mathml.js";
import { bs4OuterHtml } from "./serialize.js";

const HEADING_NUM_RE = /^\s*((?:\d+\.)*\d+)\.?\s+(.*\S)\s*$/;
const APPENDIX_RE = /^\s*APPENDIX\s+([A-Z0-9]+)\b\s*[:.]?\s*(.*)$/i;
const REF_SERVICE_RE = pyRe(
  "\\b(Crossref|Search ADS|PubMed|Google Scholar|OpenURL|WorldCat)\\b",
  "g"
);
const DOI_IN_HREF_RE = /(10\.\d{4,9}\/[^\s"'&]+)/u;
const ARXIV_IN_HREF_RE = /(\d{4}\.\d{4,5})/;

class IdGen {
  private readonly c = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.c.get(prefix) ?? 0) + 1;
    this.c.set(prefix, n);
    return `${prefix}-${n}`;
  }

  /** OUP's bare counter (`_next_num`): returns the count itself, as a string. */
  count(kind: string): string {
    const n = (this.c.get(kind) ?? 0) + 1;
    this.c.set(kind, n);
    return String(n);
  }
}

interface Holder {
  holder: RichText;
  node: Element | AnyNode[];
}

/** The OUP / MNRAS adapter (registered at module import). */
class OupAdapter implements HtmlAdapter {
  readonly name = "oup";
  readonly publisher = "MNRAS";
  // OUP hosts MNRAS (modern) — legacy Wiley/Blackwell DOIs redirect here too.
  readonly doiPrefixes = [
    "10.1093/mnras",
    "10.1093/mnrasl",
    "10.1111/j.1365-2966",
    "10.1046/j.1365-8711",
  ] as const;
  readonly hostHints = ["academic.oup.com"] as const;

  matches(url: string, soup: CheerioAPI): boolean {
    if (matchesByHost(this, url)) return true;
    const m = soup('meta[name="citation_publisher"]').first().attr("content") ?? "";
    return m.toLowerCase().includes("oxford university press");
  }

  // -- entry point -------------------------------------------------------- //
  async parse(soup: CheerioAPI, ctx: AdapterParseContext): Promise<ParsedDoc> {
    const bodyEl =
      soup("div.article-body").first().get(0) ?? soup("div.widget-ArticleFulltext").first().get(0);
    if (!bodyEl || !isTag(bodyEl)) {
      throw new Error("OUP: could not find the full-text body (div.article-body)");
    }

    const ids = new IdGen();
    const amap = new Map<string, AnchorTarget>();
    const holders: Holder[] = [];

    // rewrite reveal-id anchors to fragment hrefs the inline renderer reads
    this.rewriteAnchors(bodyEl);

    const title = this.meta1(soup, "citation_title") || this.extractTitle(bodyEl);
    const meta = this.extractMeta(soup);

    // references first (so forward citations resolve), filling amap[bibN]
    const references = this.extractReferences(soup, ids, amap);

    const sections = await this.walk(bodyEl, ids, amap, holders, ctx);

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
      sourceExtra: { publisher: "Oxford University Press", doi: meta.doi, url: ctx.baseUrl },
      anchorMatches,
    };
  }

  // -- anchors ------------------------------------------------------------ //
  private rewriteAnchors(body: Element): void {
    for (const a of findAllWhere(body, (e) => e.name === "a")) {
      const rid = getAttr(a, "data-reveal-id") || getAttr(a, "reveal-id");
      if (rid && !(getAttr(a, "href") ?? "").startsWith("#")) {
        a.attribs.href = `#${rid}`;
      }
    }
  }

  // -- title / meta ------------------------------------------------------- //
  private meta1(soup: CheerioAPI, name: string): string | undefined {
    const e = soup(`meta[name="${name}"]`).first();
    const c = e.attr("content");
    return e.length > 0 && c ? c.trim() : undefined;
  }

  private extractTitle(body: Element): string | undefined {
    const h = findWhere(
      body,
      (e) =>
        (e.name === "h1" || e.name === "h2") && classMatches(e, /article-title|wi-article-title/)
    );
    return h ? plainText(h) : undefined;
  }

  private extractMeta(soup: CheerioAPI): Record<string, unknown> {
    const authors = soup('meta[name="citation_author"]')
      .toArray()
      .filter((e) => isTag(e) && (e.attribs?.content ?? "") !== "")
      .map((e) => ((e as Element).attribs?.content ?? "").trim());
    return {
      doi: this.meta1(soup, "citation_doi"),
      journal: this.meta1(soup, "citation_journal_title"),
      volume: this.meta1(soup, "citation_volume"),
      year: this.meta1(soup, "citation_publication_date"),
      authors,
      adapter: "oup",
    };
  }

  // -- structural walk ---------------------------------------------------- //
  private async walk(
    body: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Promise<Section[]> {
    const roots: Section[] = [];
    const stack: Section[] = [];
    let current: Section | null = null;

    // Abstract (Silverchair: section.abstract). Keep its prose only.
    const abss =
      findWhere(body, (e) => e.name === "section" && classList(e).includes("abstract")) ??
      soupAbstract(body);
    if (abss) {
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
      for (const p of findAllWhere(abss, (e) => e.name === "p")) {
        if (plainText(p)) {
          const para: ParagraphBlock = {
            id: ids.next("p"),
            type: "paragraph",
            page_idx: 0,
            text: "",
          };
          holders.push({ holder: para, node: p });
          sec.blocks?.push(para);
        }
      }
      if (sec.blocks && sec.blocks.length > 0) {
        roots.push(sec);
        stack.push(sec);
        current = sec;
      }
    }

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

    // The body is a FLAT reading-order sequence (headings + <p> + floats) of
    // children under div.widget-items — not nested <section> elements.
    const h0 = findWhere(
      body,
      (e) =>
        (e.name === "h2" || e.name === "h3" || e.name === "h4") &&
        classList(e).includes("section-title")
    );
    const containerNode: Element = h0?.parent && isTag(h0.parent) ? h0.parent : body;
    for (const child of containerNode.children ?? []) {
      if (!isTag(child)) continue;
      const name = tagName(child);
      const cls = classList(child);
      if (
        (name === "h2" || name === "h3" || name === "h4" || name === "h5") &&
        cls.includes("section-title")
      ) {
        const level = { h2: 1, h3: 2, h4: 3, h5: 4 }[name] ?? 1;
        addSection(this.makeSection(child, level, ids), level);
        continue;
      }
      const blocks = await this.blocks(child, ids, amap, holders, ctx);
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
      const cur: Section = current;
      if (!cur.blocks) cur.blocks = [];
      cur.blocks.push(...blocks);
    }
    return roots;
  }

  private makeSection(h: Element, level: number, ids: IdGen): Section {
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
    return {
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
  }

  // -- blocks ------------------------------------------------------------- //
  private async blocks(
    node: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Promise<Block[]> {
    const name = tagName(node);
    const cls = classList(node);

    if (name === "p") {
      if (!plainText(node)) return [];
      const para: ParagraphBlock = { id: ids.next("p"), type: "paragraph", page_idx: 0, text: "" };
      holders.push({ holder: para, node });
      return [para];
    }
    if (name === "div" && (cls.includes("fig") || cls.includes("fig-section"))) {
      const b = await this.figure(node, ids, amap, holders, ctx);
      return b ? [b] : [];
    }
    if (name === "div" && (cls.includes("disp-formula") || cls.includes("disp-formula-group"))) {
      return this.equation(node, ids, amap, ctx);
    }
    if (name === "div" && cls.some((c) => c.includes("table"))) {
      const b = this.table(node, ids, amap, holders);
      return b ? [b] : [];
    }
    if (name === "ul" || name === "ol") {
      const b = this.list(node, ids, holders, name === "ol");
      return b ? [b] : [];
    }
    if (name === "section") {
      return []; // flat layout: sections are not nested containers here
    }
    // wrapper div: recurse into its children so we never drop content
    if (name === "div") {
      const out: Block[] = [];
      for (const c of node.children ?? []) {
        if (isTag(c)) {
          out.push(...(await this.blocks(c, ids, amap, holders, ctx)));
        }
      }
      return out;
    }
    return [];
  }

  private async figure(
    node: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[],
    ctx: AdapterParseContext
  ): Promise<FigureBlock | null> {
    const n = ids.count("fignum");
    const capNode =
      findWhere(node, (e) => classMatches(e, /fig-caption|caption/)) ??
      findWhere(node, (e) => e.name === "figcaption");
    const cap: RichText = { text: "" };
    if (capNode) holders.push({ holder: cap, node: capNode });
    let imgPath: string | undefined;
    const img = findWhere(node, (e) => e.name === "img");
    const src = img ? getAttr(img, "src") || getAttr(img, "data-src") : undefined;
    if (src) {
      imgPath = await this.asset(urlJoin(ctx.baseUrl, src), ctx);
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
    amap.set(`fig${n}`, { role: "xref", targetId: blk.id, xrefKind: "figure" });
    const fid = getAttr(node, "id");
    if (fid) amap.set(fid, { role: "xref", targetId: blk.id, xrefKind: "figure" });
    return blk;
  }

  private async equation(
    node: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    ctx: AdapterParseContext
  ): Promise<Block[]> {
    const n = ids.count("eqnum");
    const math = findWhere(node, (e) => e.name === "math");
    if (math) {
      const latex = ctx.mathml.mathmlToLatex(bs4OuterHtml(math)) ?? "";
      const blk: EquationBlock = {
        id: ids.next("eq"),
        type: "equation",
        page_idx: 0,
        number: n,
        label: `Equation ${n}`,
        latex: stripMathDelims(latex),
      };
      amap.set(`disp-formula${n}`, { role: "xref", targetId: blk.id, xrefKind: "equation" });
      const eid = getAttr(node, "id");
      if (eid) amap.set(eid, { role: "xref", targetId: blk.id, xrefKind: "equation" });
      return [blk];
    }
    // legacy: the equation is a rendered image — keep it visible as a figure.
    const img = findWhere(node, (e) => e.name === "img");
    const imgSrc = img ? getAttr(img, "src") || getAttr(img, "data-src") : undefined;
    if (img && imgSrc) {
      const src = urlJoin(ctx.baseUrl, imgSrc);
      const path = await this.asset(src, ctx);
      const blk: FigureBlock = {
        id: ids.next("fig"),
        type: "figure",
        page_idx: 0,
        number: n,
        label: `Equation ${n}`,
        img_path: path,
      };
      const eid = getAttr(node, "id");
      if (eid) amap.set(eid, { role: "xref", targetId: blk.id, xrefKind: "equation" });
      return [blk];
    }
    return [];
  }

  private table(
    node: Element,
    ids: IdGen,
    amap: Map<string, AnchorTarget>,
    holders: Holder[]
  ): TableBlock | null {
    const n = ids.count("tabnum");
    const capNode =
      findWhere(node, (e) => classMatches(e, /caption|table-caption/)) ??
      findWhere(node, (e) => e.name === "caption");
    const cap: RichText = { text: "" };
    if (capNode) holders.push({ holder: cap, node: capNode });
    const tbl = findWhere(node, (e) => e.name === "table");
    const bodyHtml = tbl ? cleanTableHtml(tbl) : undefined;
    const blk: TableBlock = {
      id: ids.next("tab"),
      type: "table",
      page_idx: 0,
      number: n,
      label: `Table ${n}`,
      caption: capNode ? cap : undefined,
      table_body: bodyHtml,
    };
    amap.set(`table${n}`, { role: "xref", targetId: blk.id, xrefKind: "table" });
    const tid = getAttr(node, "id");
    if (tid) amap.set(tid, { role: "xref", targetId: blk.id, xrefKind: "table" });
    return blk;
  }

  private list(node: Element, ids: IdGen, holders: Holder[], ordered: boolean): ListBlock | null {
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

  private async asset(url: string, ctx: AdapterParseContext): Promise<string | undefined> {
    if (!ctx.config.downloadAssets) return url;
    let fn = (url.split("/").pop() ?? "").split("?")[0]?.replace(/[^A-Za-z0-9._-]+/g, "_") ?? "";
    if (!/\.[a-z0-9]+$/i.test(fn)) fn += ".jpeg";
    const dest = `${ctx.assetDir}/${fn}`;
    return (await ctx.fetcher.download(url, dest)) ? `assets/${fn}` : undefined;
  }

  // -- references --------------------------------------------------------- //
  private extractReferences(
    soup: CheerioAPI,
    ids: IdGen,
    amap: Map<string, AnchorTarget>
  ): Reference[] {
    const reflistEl =
      soup("div.ref-list").first().get(0) ?? soup("section.ref-list").first().get(0);
    if (!reflistEl || !isTag(reflistEl)) return [];
    const divRefs = findAllWhere(
      reflistEl,
      (e) => e.name === "div" && classList(e).includes("ref")
    );
    // Python: `reflist.select("div.ref") or reflist.find_all("li")` — the li
    // fallback fires only when no div.ref matched at all.
    const items = divRefs.length > 0 ? divRefs : findAllWhere(reflistEl, (e) => e.name === "li");
    const refs: Reference[] = [];
    let i = 0;
    for (const li of items) {
      i += 1;
      const rid = ids.next("ref");
      refs.push(parseOupRef(li, rid));
      amap.set(`bib${i}`, { role: "cite", refId: rid }); // data-reveal-id
      const own = getAttr(li, "id") ?? "";
      if (own) amap.set(own, { role: "cite", refId: rid });
    }
    return refs;
  }
}

function soupAbstract(body: Element): Element | null {
  const h = findWhere(body, (e) => classMatches(e, /abstract-title/));
  if (!h) return null;
  const p = h.parent;
  return p && isTag(p) ? p : null;
}

function parseOupRef(li: Element, refId: string): Reference {
  const clone = loadHtml(bs4OuterHtml(li));
  for (const a of clone("a").toArray()) clone(a).remove();
  const root = clone.root().get(0);
  let raw = stripChars(getTextSep(root ?? li, " ").replace(/\s+/gu, " "), " .;,");
  raw = stripChars(raw.replace(REF_SERVICE_RE, ""), " .;,");
  const ref = parseOne(refId, raw, undefined);
  for (const a of findAllWhere(li, (e) => e.name === "a" && getAttr(e, "href") !== undefined)) {
    const href = getAttr(a, "href") ?? "";
    if ((href.includes("doi.org/") || href.includes("/doi/")) && !ref.doi) {
      const m = DOI_IN_HREF_RE.exec(href);
      if (m) ref.doi = rstripChars(m[1] ?? "", ".,);");
    }
    if (href.toLowerCase().includes("arxiv") && !ref.arxiv_id) {
      const m = ARXIV_IN_HREF_RE.exec(href);
      if (m) ref.arxiv_id = m[1];
    }
  }
  return ref;
}

export const oupAdapter = registerAdapter(new OupAdapter());
