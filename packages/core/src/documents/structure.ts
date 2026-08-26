/**
 * Build the ordered section tree from MinerU's `content_list.json`
 * (bibgraph/ingest/structure.py).
 *
 * MinerU returns a *flat* list of blocks in reading order; headings are marked by
 * `text_level` (1 = H1, 2 = H2, ...) or by `type == "title"`. We rebuild the section
 * hierarchy with a level stack, attach floats (figures/tables/equations/code/
 * algorithms/lists) as blocks, fold captions/footnotes in as subordinates, and
 * assign stable ids. `ref_text` blocks (bibliography entries) are *not* placed in
 * the tree — they are returned separately for the reference parser.
 */

import type { Block, RichText, Section } from "@argelanderspace/contracts";
import { type MineruContentItem, readBbox } from "./mineru.js";
import { pyOr, stripChars } from "./pyregex.js";

// Block types we deliberately drop from the reading-order tree.
const NOISE_TYPES = new Set([
  "header",
  "footer",
  "page_number",
  "page_footnote",
  "footnote",
  "discarded",
]);

export const FIG_NUM_RE = /^\s*(?:fig(?:ure)?|abb(?:ildung)?)\.?\s*([0-9]+[a-z]?)/iu;
export const TAB_NUM_RE = /^\s*(?:tab(?:le)?|tabelle)\.?\s*([0-9]+[a-z]?)/iu;
export const ALGO_NUM_RE = /^\s*(?:algorithm|algo)\.?\s*([0-9]+[a-z]?)/iu;
export const LISTING_NUM_RE = /^\s*(?:listing|code)\.?\s*([0-9]+[a-z]?)/iu;
// Heading number prefix, e.g. "3.2  Methods" / "A.1 Appendix" / "IV. Results"
const HEADING_NUM_RE = /^\s*((?:[A-Z]\.)?\d+(?:\.\d+)*|[IVXLC]+|[A-Z])[.)]?\s+(.*\S)?\s*$/u;
// A bare equation tag like "(3)" or a \tag{3}
const EQ_TAG_RE = /\\tag\{([^}]+)\}/u;
const EQ_TRAILING_NUM_RE = /\(([0-9]+[a-z]?)\)\s*$/u;
// label/caption separator (": " / ". " / " — "), stripped once after the label
const CAPTION_SEP_RE = /^\s*[:.—–]?\s*/u;

class IdGen {
  private readonly counters = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

export interface StructureResult {
  sections: Section[];
  refTextItems: MineruContentItem[];
  titleGuess?: string;
}

/** MinerU captions/footnotes are lists of strings; join to one string. */
function joinText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    return value
      .map((v) => (v === null || v === undefined ? "" : String(v).trim()))
      .filter((v) => v.length > 0)
      .join(" ")
      .trim();
  }
  return String(value).trim();
}

/** Return heading level (>= 1) if `item` is a heading, else undefined. */
function headingLevel(item: MineruContentItem): number | undefined {
  const t = item.type;
  const lvl = item.text_level;
  const valid = typeof lvl === "number" && Number.isInteger(lvl) && lvl >= 1;
  if (t === "title") return valid ? lvl : 1;
  if (t === "text" && valid) return lvl;
  return undefined;
}

/** Split "3.2 Methods" -> ("3.2", "Methods"). */
function splitHeading(text: string): { number?: string; heading: string } {
  const m = HEADING_NUM_RE.exec(text);
  if (m?.[1] && m[2]) {
    return { number: m[1], heading: m[2].trim() };
  }
  return { heading: text.trim() };
}

/**
 * Pull the leading "Figure 3" label off a caption.
 *
 * Returns `{number, label, body}` where `body` is the caption with its own label
 * prefix removed, so the float's own label is never mistaken for a cross-reference
 * to itself.
 */
export function splitCaption(
  caption: string,
  regex: RegExp,
  prefix: string
): { number?: string; label?: string; body: string } {
  const m = regex.exec(caption);
  if (m?.[1] && m[0] !== undefined) {
    const num = m[1];
    // strip the label/caption separator once (e.g. ": " or ". " or " — "),
    // without eating a leading minus sign that belongs to the caption text.
    const body = caption.slice(m.index + m[0].length).replace(CAPTION_SEP_RE, "");
    return { number: num, label: `${prefix} ${num}`, body };
  }
  return { body: caption };
}

function eqNumber(latex: string): string | undefined {
  const m = EQ_TAG_RE.exec(latex);
  if (m?.[1]) return m[1].trim();
  const t = EQ_TRAILING_NUM_RE.exec(latex.trim());
  if (t?.[1]) return t[1];
  return undefined;
}

/** In-memory section under construction: blocks/children always materialized. */
type SectionBuilder = Section & { blocks: Block[]; children: Section[] };

export function buildStructure(contentList: MineruContentItem[]): StructureResult {
  const ids = new IdGen();
  const roots: SectionBuilder[] = [];
  const stack: SectionBuilder[] = []; // open sections by increasing level
  let front: SectionBuilder | undefined;
  let current: SectionBuilder | undefined;
  const refItems: MineruContentItem[] = [];
  let titleGuess: string | undefined;

  const ensureFront = (): SectionBuilder => {
    if (front === undefined) {
      front = {
        id: "sec-0",
        type: "section",
        level: 0,
        heading: "",
        page_idx: 0,
        blocks: [],
        children: [],
      };
      roots.unshift(front);
    }
    return front;
  };

  for (const item of contentList) {
    const itype = item.type;

    // --- bibliography entries: collect, don't place in tree ---------- //
    if (itype === "ref_text") {
      refItems.push(item);
      continue;
    }
    if (itype !== undefined && NOISE_TYPES.has(itype)) continue;

    // --- headings define sections ------------------------------------ //
    const level = headingLevel(item);
    if (level !== undefined) {
      const raw = joinText(item.text);
      if (!raw) continue;
      if (titleGuess === undefined && level === 1) titleGuess = raw;
      const { number, heading } = splitHeading(raw);
      const sec: SectionBuilder = {
        id: ids.next("sec"),
        type: "section",
        level,
        heading,
        heading_raw: raw,
        number,
        page_idx: typeof item.page_idx === "number" ? item.page_idx : undefined,
        bbox: readBbox(item),
        blocks: [],
        children: [],
      };
      while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(sec);
      else roots.push(sec);
      stack.push(sec);
      current = sec;
      continue;
    }

    // --- content blocks ---------------------------------------------- //
    const block = makeBlock(item, ids);
    if (block === undefined) continue;
    const target = current ?? ensureFront();
    target.blocks.push(block);
  }

  return { sections: roots, refTextItems: refItems, titleGuess };
}

function readPageIdx(item: MineruContentItem): number | undefined {
  return typeof item.page_idx === "number" ? item.page_idx : undefined;
}

function makeBlock(item: MineruContentItem, ids: IdGen): Block | undefined {
  const itype = item.type;
  const page = readPageIdx(item);
  const bbox = readBbox(item);

  if (itype === "text" || itype === undefined) {
    const text = joinText(item.text);
    if (!text) return undefined;
    return { id: ids.next("p"), type: "paragraph", page_idx: page, bbox, text };
  }

  if (itype === "image" || itype === "chart" || itype === "figure") {
    // MinerU's VLM backend tags plots/graphs as type "chart" (with
    // chart_caption/chart_footnote/content), and photos as "image".
    const caption = joinText(pyOr(item.img_caption, item.chart_caption, item.figure_caption));
    const { number: num, label, body } = splitCaption(caption, FIG_NUM_RE, "Figure");
    const content = pyOr(item.content);
    return {
      id: ids.next("fig"),
      type: "figure",
      page_idx: page,
      bbox,
      number: num,
      label,
      caption: body ? { text: body } : undefined,
      footnote: joinText(pyOr(item.img_footnote, item.chart_footnote)) || undefined,
      img_path: typeof item.img_path === "string" ? item.img_path : undefined,
      chart_type:
        itype === "chart" && typeof item.sub_type === "string" ? item.sub_type : undefined,
      content: itype === "chart" && typeof content === "string" ? content : undefined,
    };
  }

  if (itype === "table") {
    const caption = joinText(item.table_caption);
    const { number: num, label, body } = splitCaption(caption, TAB_NUM_RE, "Table");
    return {
      id: ids.next("tab"),
      type: "table",
      page_idx: page,
      bbox,
      number: num,
      label,
      caption: body ? { text: body } : undefined,
      footnote: joinText(item.table_footnote) || undefined,
      table_body: typeof item.table_body === "string" ? item.table_body : undefined,
      img_path: typeof item.img_path === "string" ? item.img_path : undefined,
    };
  }

  if (itype === "equation" || itype === "interline_equation") {
    const latex = joinText(pyOr(item.text, item.latex));
    if (!latex) return undefined;
    const num = eqNumber(latex);
    return {
      id: ids.next("eq"),
      type: "equation",
      page_idx: page,
      bbox,
      number: num,
      label: num ? `Equation ${num}` : undefined,
      latex,
    };
  }

  if (itype === "algorithm" || (itype === "code" && item.sub_type === "algorithm")) {
    const caption = joinText(pyOr(item.code_caption, item.algorithm_caption));
    const body = joinText(pyOr(item.code_body, item.text, item.algorithm_body));
    const { number: num, label, body: capBody } = splitCaption(caption, ALGO_NUM_RE, "Algorithm");
    return {
      id: ids.next("algo"),
      type: "algorithm",
      page_idx: page,
      bbox,
      number: num,
      label,
      caption: capBody ? { text: capBody } : undefined,
      body,
    };
  }

  if (itype === "code") {
    const caption = joinText(item.code_caption);
    const body = joinText(pyOr(item.code_body, item.text));
    const { number: num, label, body: capBody } = splitCaption(caption, LISTING_NUM_RE, "Listing");
    const lang = pyOr(item.guess_lang, item.language);
    return {
      id: ids.next("code"),
      type: "code",
      page_idx: page,
      bbox,
      number: num,
      label,
      caption: capBody ? { text: capBody } : undefined,
      lang: typeof lang === "string" ? lang : undefined,
      body,
    };
  }

  if (itype === "list") {
    const items = listItems(item);
    if (items.length === 0) {
      const text = joinText(item.text);
      if (!text) return undefined;
      return { id: ids.next("p"), type: "paragraph", page_idx: page, bbox, text };
    }
    const ordered = Boolean(item.ordered) || item.sub_type === "ordered";
    return { id: ids.next("list"), type: "list", page_idx: page, bbox, ordered, items };
  }

  if (itype === "phonetic" || itype === "aside_text" || itype === "index") {
    const text = joinText(item.text);
    if (!text) return undefined;
    return { id: ids.next("p"), type: "paragraph", page_idx: page, bbox, text };
  }

  // Unknown type: keep its text if any, so we never silently drop content.
  const text = joinText(item.text);
  if (text) {
    return { id: ids.next("p"), type: "paragraph", page_idx: page, bbox, text };
  }
  return undefined;
}

function listItems(item: MineruContentItem): RichText[] {
  const raw = pyOr(item.list_items, item.items);
  const out: RichText[] = [];
  if (Array.isArray(raw)) {
    for (const it of raw) {
      let t: string;
      if (typeof it === "string") {
        t = it.trim();
      } else if (it !== null && typeof it === "object" && !Array.isArray(it)) {
        t = joinText((it as Record<string, unknown>).text);
      } else {
        t = String(it).trim();
      }
      if (t) out.push({ text: t });
    }
    return out;
  }
  // Fallback: split a blob on newlines / bullet markers.
  const blob = joinText(item.text);
  if (blob) {
    for (const line0 of blob.split(/\n+|(?<=\S)\s*[•▪◦]\s+/u)) {
      const line = stripChars(line0, " •-\t");
      if (line) out.push({ text: line });
    }
  }
  return out;
}
