/**
 * Walk the pandoc LaTeX AST into a bibgraph Document structure
 * (`bibgraph/ingest_latex/walk.py`).
 *
 * The walk is two-pass so cross-references resolve regardless of order:
 *
 * 1. **structure** — consume the AST into the Section tree + float/equation
 *    blocks, assigning ids and numbers and recording every `\label` (pandoc puts
 *    it on the element `id`; equation labels we pull from the math string) into a
 *    `label -> (target_id, kind, number)` map. Each text holder keeps its raw
 *    inline list for the second pass.
 * 2. **render** — with the label map complete, render every holder's inlines to
 *    body text, emitting `[[cite:ref-N]]` / `[[xref:fig-N]]` *authoritatively*
 *    (`\cite` keys map straight to references; `\ref` targets straight to the
 *    label map). The pipeline then runs only a regex *fallback* for any unlinked
 *    author-year / "Fig. N" mention, exactly as the HTML path does.
 *
 * Holder bookkeeping: the Python walker monkey-patches `_inl` / `_anchor_matches`
 * onto the schema objects (deleted before serialization). Here the inlines live
 * in a private holder list and the rendered anchor matches in the public
 * {@link Walker.anchorMatches} map keyed by the holder object — nothing internal
 * ever reaches the serialized JSON.
 */

import type {
  Block,
  CitationOccurrence,
  CrossRefKind,
  CrossRefOccurrence,
  ListBlock,
  ParagraphBlock,
  Reference,
  RichText,
  Section,
} from "@argelanderspace/contracts";
import type { Match } from "../../documents/annotate.js";
import { pyRe } from "../../documents/pyregex.js";
import type { LatexPandocPort } from "./ports.js";

// Display-math environments that number EVERY row (equation/multline get one).
const PERROW_ENVS = new Set(["align", "alignat", "eqnarray", "gather", "flalign"]);
// Multi-row environments we re-wrap as KaTeX-safe `aligned`.
const MULTILINE_ENVS = new Set([
  "align",
  "align*",
  "alignat",
  "alignat*",
  "eqnarray",
  "eqnarray*",
  "gather",
  "gather*",
  "multline",
  "multline*",
  "flalign",
  "flalign*",
]);
// Anchored to the START of the math string: pandoc (>= 3.9) keeps the display
// environment shell around the body, and only a leading \begin{…} is that
// shell — an unanchored match would bite an inner `\begin{cases}`/… and rewrap
// the body as if the inner env were the shell.
const ENV_RE = /^\s*\\begin\{([a-zA-Z*]+)\}([\s\S]*)\\end\{\1\}/;
const LABEL_RE = /\\label\s*\{([^}]*)\}/g;
// amsmath `\tag{…}` / `\tag*{…}` — the author-supplied equation number.
const TAG_RE = /\\tag\*?\s*\{([^}]*)\}/;
const TAG_RE_G = /\\tag\*?\s*\{[^}]*\}/g;
const MSPACE_RE = /\\mspace\s*\{[^}]*\}/g;
// text-mode sub/superscript commands authors sometimes use *inside* math
const TEXTSUB_RE = /\\textsubscript\s*\{([^{}]*)\}/g;
const TEXTSUP_RE = /\\textsuperscript\s*\{([^{}]*)\}/g;
// a control-space (\ ) — valid TeX spacing, but a trailing one becomes a
// dangling backslash after we strip whitespace, which KaTeX rejects.
const CTRLSPACE_RE = /(?<!\\)\\ /g;
const NONUMBER_RE = pyRe("\\\\(?:nonumber|notag)\\b", "");
const NONUMBER_RE_G = pyRe("\\\\(?:nonumber|notag)\\b", "g");
// Astronomy macros from aastex / aas_macros / mn2e classes (not in the preamble,
// so pandoc can't expand them) -> KaTeX-renderable equivalents.
const ASTRO_MACROS: ReadonlyArray<readonly [string, string]> = [
  ["sun", "\\odot"],
  ["Sun", "\\odot"],
  ["earth", "\\oplus"],
  ["Earth", "\\oplus"],
  ["degr", "^{\\circ}"],
  ["arcdeg", "^{\\circ}"],
  ["fdg", "^{\\circ}"],
  ["arcmin", "'"],
  ["arcsec", "''"],
  ["farcm", "'"],
  ["farcs", "''"],
  ["micron", "\\,\\mu m"],
  ["sq", "\\Box"],
  ["ion", "\\,"],
];
const ASTRO_BY_NAME = new Map(ASTRO_MACROS);
// sorted(_ASTRO_MACROS, key=len, reverse=True) — Python's sort is stable, so
// same-length names keep their definition order; JS Array.sort is stable too.
const ASTRO_RE = new RegExp(
  `\\\\(${[...ASTRO_MACROS]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([k]) => k)
    .join("|")})(?![a-zA-Z])`,
  "g"
);

/** Map the handful of commands authors use that KaTeX doesn't implement. */
function katexify(latex: string): string {
  let out = latex.replace(MSPACE_RE, "\\;");
  out = out.replaceAll("\\medspace", "\\;").replaceAll("\\thickspace", "\\;");
  out = out.replace(TEXTSUB_RE, "_{$1}"); // keep math mode: content may
  out = out.replace(TEXTSUP_RE, "^{$1}"); // be a symbol (\lambda), not text
  out = out.replace(ASTRO_RE, (_m, name: string) => ASTRO_BY_NAME.get(name) ?? _m);
  if (out.includes("$")) {
    // text-embedded math ($k$): the inner $ would split our $…$ span
    out = out.replaceAll("$", "");
  }
  out = out.replace(CTRLSPACE_RE, " "); // \  -> plain space
  out = out.replace(/\\+\s*$/, ""); // drop any dangling trailing \
  return out;
}

/** `(inner, index-after-matching-hi)` when `s[i] === lo`, else undefined. */
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

// --------------------------------------------------------------------------- //
// untyped pandoc-AST access helpers
// --------------------------------------------------------------------------- //

type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function tagOf(v: unknown): string | undefined {
  return asStr(asObj(v)?.t);
}

class IdGen {
  private readonly c = new Map<string, number>();

  next(prefix: string): string {
    const n = (this.c.get(prefix) ?? 0) + 1;
    this.c.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

function normWs(s: string): string {
  return s.replaceAll("\u00a0", " ").replace(/\s+/gu, " ");
}

interface Seg {
  kind: "plain" | "math" | "anchor";
  s: string;
  occ?: CitationOccurrence | CrossRefOccurrence;
}

type LabelKind = "section" | "figure" | "table" | "equation";
type LabelTarget = [targetId: string, kind: LabelKind, number: string | null];

/** A text holder under construction (raw inlines kept until pass 2). */
interface Holder {
  target: ParagraphBlock | RichText;
  inl: unknown[];
}

export interface WalkerOptions {
  references: Reference[];
  keyToRefId: ReadonlyMap<string, string>;
  assets: { image(arg: string): string | undefined };
  srcDir: string;
  meta: Obj;
  pandoc: LatexPandocPort;
}

export class Walker {
  private readonly refsById = new Map<string, Reference>();
  private readonly key2ref: ReadonlyMap<string, string>;
  private readonly assets: { image(arg: string): string | undefined };
  private readonly srcDir: string;
  private readonly meta: Obj;
  private readonly pandoc: LatexPandocPort;
  private readonly ids = new IdGen();
  private readonly labelMap = new Map<string, LabelTarget>();
  private readonly holders: Holder[] = [];
  /** Pass-2 anchor matches per holder object (the Python `_anchor_matches` attr). */
  readonly anchorMatches = new Map<object, Match[]>();
  private fig = 0;
  private tab = 0;
  private eq = 0;
  private readonly secCounts = new Map<number, number>();

  constructor(opts: WalkerOptions) {
    for (const r of opts.references) this.refsById.set(r.id, r);
    this.key2ref = opts.keyToRefId;
    this.assets = opts.assets;
    this.srcDir = opts.srcDir;
    this.meta = opts.meta;
    this.pandoc = opts.pandoc;
  }

  // ------------------------------------------------------------------ //
  // Entry point
  // ------------------------------------------------------------------ //
  run(ast: Obj, raw: string): Section[] {
    const blocks = asArr(ast.blocks);
    const sections: Section[] = [];
    const abs = this.abstractSection(raw);
    if (abs) sections.push(abs);
    sections.push(...this.buildBody(blocks));
    this.renderAll();
    pruneEmpty(sections);
    return sections;
  }

  // ------------------------------------------------------------------ //
  // Abstract (meta.abstract, else A&A's \abstract{}{}{}{}{} command)
  // ------------------------------------------------------------------ //
  private abstractSection(raw: string): Section | undefined {
    const blocks = this.abstractBlocks(raw);
    if (blocks.length === 0) return undefined;
    const sec: Section = {
      id: this.ids.next("sec"),
      type: "section",
      level: 1,
      heading: "Abstract",
      heading_raw: "Abstract",
      number: undefined,
      blocks: [],
      children: [],
    };
    for (const b of blocks) {
      const t = tagOf(b);
      if (t === "Para" || t === "Plain") {
        sec.blocks?.push(this.para(asArr(asObj(b)?.c)));
      }
    }
    return (sec.blocks?.length ?? 0) > 0 ? sec : undefined;
  }

  private abstractBlocks(raw: string): unknown[] {
    const ab = asObj(this.meta.abstract);
    if (ab !== undefined) {
      if (ab.t === "MetaBlocks") return asArr(ab.c);
      if (ab.t === "MetaInlines") return [{ t: "Para", c: asArr(ab.c) }];
    }
    const groups = extractCommandAbstract(raw);
    if (groups.length === 0) return [];
    const labels = ["Context", "Aims", "Methods", "Results", "Conclusions"];
    const parts: string[] = [];
    for (const [i, g0] of groups.entries()) {
      const g = stripTexComments(g0).trim();
      if (!g) continue;
      const lbl = groups.length === 5 ? `\\textbf{${labels[i]}.} ` : "";
      parts.push(lbl + g);
    }
    return this.pandoc.fragmentToBlocks(parts.join("\n\n"), this.srcDir);
  }

  // ------------------------------------------------------------------ //
  // Structure (pass 1)
  // ------------------------------------------------------------------ //
  private buildBody(blocks: unknown[]): Section[] {
    const top: Section[] = [];
    const stack: Section[] = [];
    const front: Block[] = [];
    for (const blk of blocks) {
      this.consume(blk, top, stack, front);
    }
    if (front.length > 0) {
      // content before the first heading
      const sec: Section = {
        id: this.ids.next("sec"),
        type: "section",
        level: 1,
        heading: "",
        number: undefined,
        blocks: front,
        children: [],
      };
      top.unshift(sec);
    }
    return top;
  }

  private consume(blk: unknown, top: Section[], stack: Section[], front: Block[]): void {
    const t = tagOf(blk);
    const c = asObj(blk)?.c;
    if (t === "Header") {
      this.openSection(asArr(c), top, stack);
      return;
    }
    if (t === "Div") {
      const attr = asArr(asArr(c)[0]);
      const sub = asArr(asArr(c)[1]);
      const label = asStr(attr[0]);
      // A labelled Div wrapping a single float carries that float's \label
      // (pandoc attaches table — and sometimes figure — labels this way).
      if (label && sub.length === 1 && tagOf(sub[0]) === "Table") {
        this.emit(this.tableBlock(asObj(sub[0]) ?? {}, label), stack, front);
        return;
      }
      if (label && sub.length === 1 && tagOf(sub[0]) === "Figure") {
        this.emit(this.figureBlock(asObj(sub[0]) ?? {}, label), stack, front);
        return;
      }
      for (const x of sub) this.consume(x, top, stack, front);
      return;
    }
    if (t === "BlockQuote") {
      for (const x of asArr(c)) this.consume(x, top, stack, front);
      return;
    }
    for (const b of this.contentBlocks(blk)) {
      this.emit(b, stack, front);
    }
  }

  private emit(block: Block | undefined, stack: Section[], front: Block[]): void {
    if (block === undefined) return;
    const top = stack[stack.length - 1];
    if (top === undefined) {
      front.push(block);
    } else {
      top.blocks ??= [];
      top.blocks.push(block);
    }
  }

  private openSection(c: unknown[], top: Section[], stack: Section[]): void {
    const level = typeof c[0] === "number" ? c[0] : 1;
    const attr = asArr(c[1]);
    const inls = asArr(c[2]);
    const hid = asStr(attr[0]);
    const classes = asArr(attr[1]).map(String);
    const number = this.sectionNumber(level, classes);
    const heading = this.inlinesToPlain(inls).trim();
    const sec: Section = {
      id: this.ids.next("sec"),
      type: "section",
      level,
      heading,
      heading_raw: number ? `${number} ${heading}`.trim() : heading,
      number,
      blocks: [],
      children: [],
    };
    while (stack.length > 0 && (stack[stack.length - 1]?.level ?? 0) >= level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      top.push(sec);
    } else {
      parent.children ??= [];
      parent.children.push(sec);
    }
    stack.push(sec);
    if (hid) this.labelMap.set(hid, [sec.id, "section", number ?? null]);
  }

  private sectionNumber(level: number, classes: string[]): string | undefined {
    if (classes.includes("unnumbered")) return undefined;
    this.secCounts.set(level, (this.secCounts.get(level) ?? 0) + 1);
    for (const lv of [...this.secCounts.keys()]) {
      if (lv > level) this.secCounts.delete(lv);
    }
    return [...this.secCounts.keys()]
      .filter((lv) => lv <= level)
      .sort((a, b) => a - b)
      .map((lv) => String(this.secCounts.get(lv)))
      .join(".");
  }

  // ------------------------------------------------------------------ //
  // Content blocks
  // ------------------------------------------------------------------ //
  private contentBlocks(blk: unknown): Block[] {
    const t = tagOf(blk);
    const c = asObj(blk)?.c;
    if (t === "Para" || t === "Plain") {
      return this.splitPara(asArr(c));
    }
    if (t === "CodeBlock") {
      const attr = asArr(asArr(c)[0]);
      const classes = asArr(attr[1]).map(String);
      const lang = classes.length > 0 ? classes[0] : undefined;
      return [{ id: this.ids.next("code"), type: "code", lang, body: asStr(asArr(c)[1]) ?? "" }];
    }
    if (t === "BulletList") {
      return [this.listBlock(asArr(c), false)];
    }
    if (t === "OrderedList") {
      return [this.listBlock(asArr(asArr(c)[1]), true)];
    }
    if (t === "Table") {
      return [this.tableBlock(asObj(blk) ?? {}, asStr(asArr(asArr(c)[0])[0]))];
    }
    if (t === "Figure") {
      return [this.figureBlock(asObj(blk) ?? {})];
    }
    // HorizontalRule is benign; anything else reaching this fallthrough is
    // silently dropped content — log the node type so a degraded pandoc parse
    // (e.g. an environment it can't read) is diagnosable.
    if (t !== "HorizontalRule") {
      console.warn(`latex walk: dropped unsupported pandoc AST block "${t ?? "?"}"`);
    }
    return [];
  }

  /** Split a paragraph at display equations into [Para, Eq, Para, …]. */
  private splitPara(inls: unknown[]): Block[] {
    const out: Block[] = [];
    let buf: unknown[] = [];
    for (const x of inls) {
      const c = asObj(x)?.c;
      if (tagOf(x) === "Math" && tagOf(asArr(c)[0]) === "DisplayMath") {
        if (hasContent(buf)) out.push(this.para(buf));
        buf = [];
        out.push(this.equationBlock(asStr(asArr(c)[1]) ?? ""));
      } else {
        buf.push(x);
      }
    }
    if (hasContent(buf)) out.push(this.para(buf));
    return out;
  }

  private para(inls: unknown[]): ParagraphBlock {
    const p: ParagraphBlock = { id: this.ids.next("p"), type: "paragraph", text: "" };
    this.holders.push({ target: p, inl: [...inls] });
    return p;
  }

  private equationBlock(latex: string): Block {
    const [body, env, rawInner] = normalizeEquation(latex);
    const eid = this.ids.next("eq");
    const envBase = env?.replace(/\*+$/, "");
    let number: string | undefined;
    if (envBase !== undefined && PERROW_ENVS.has(envBase)) {
      // align/eqnarray/gather/… number EVERY row (sans \nonumber/\notag), so
      // assign one number per row and map each row's \label to its number
      // (else \eqref shows the wrong number and later equations all drift).
      // A \tag{…} row displays the tag text and does NOT advance the counter.
      const nums: string[] = [];
      for (const row of rawInner.split("\\\\")) {
        if (!row.trim() || NONUMBER_RE.test(row)) continue;
        const tag = eqTag(row);
        let n: string;
        if (tag !== undefined) {
          n = tag; // tagged row: display the tag, don't advance the counter
        } else {
          this.eq += 1;
          n = String(this.eq);
        }
        nums.push(n);
        for (const m of row.matchAll(LABEL_RE)) {
          if (m[1] !== undefined) this.labelMap.set(m[1], [eid, "equation", n]);
        }
      }
      if (nums.length === 0) {
        // no countable row (every row \nonumber)
        this.eq += 1;
        nums.push(String(this.eq));
      }
      // env-level label → first number
      for (const m of rawInner.matchAll(LABEL_RE)) {
        const first = nums[0];
        if (m[1] !== undefined && first !== undefined && !this.labelMap.has(m[1])) {
          this.labelMap.set(m[1], [eid, "equation", first]);
        }
      }
      number = nums.length === 1 ? nums[0] : `${nums[0]}–${nums[nums.length - 1]}`;
    } else {
      // Everything else — equation, multline, equation*, \[…\], $$…$$, unknown
      // envs (dmath, …) — gets ONE number in order of appearance. A \tag{…}
      // overrides the display number and, per amsmath, does not advance the
      // counter (the next auto-numbered equation continues the sequence).
      const tag = eqTag(rawInner);
      if (tag !== undefined) {
        number = tag;
      } else {
        this.eq += 1;
        number = String(this.eq);
      }
      for (const m of rawInner.matchAll(LABEL_RE)) {
        if (m[1] !== undefined) this.labelMap.set(m[1], [eid, "equation", number]);
      }
    }
    return { id: eid, type: "equation", number, latex: body };
  }

  private listBlock(items: unknown[], ordered: boolean): ListBlock {
    const lb: ListBlock = { id: this.ids.next("list"), type: "list", ordered, items: [] };
    for (const itemBlocks of items) {
      const rt: RichText = { text: "" };
      this.holders.push({ target: rt, inl: this.blockInlines(asArr(itemBlocks)) });
      lb.items.push(rt);
    }
    return lb;
  }

  private figureBlock(blk: Obj, labelOverride?: string): Block {
    const c = asArr(blk.c);
    const attr = asArr(c[0]);
    const caption = c[1];
    const content = asArr(c[2]);
    this.fig += 1;
    const number = String(this.fig);
    const imgs = findImages(content);
    let imgPath: string | undefined;
    for (const src of imgs) {
      imgPath = this.assets.image(src);
      if (imgPath) break;
    }
    const fig: Block = {
      id: this.ids.next("fig"),
      type: "figure",
      number,
      label: `Figure ${number}`,
      img_path: imgPath,
    };
    const cap = this.captionOf(caption);
    if (cap) fig.caption = cap;
    const label = labelOverride || asStr(attr[0]);
    if (label) this.labelMap.set(label, [fig.id, "figure", number]);
    return fig;
  }

  private tableBlock(node: Obj, label: string | undefined): Block {
    const c = asArr(node.c);
    const caption = c[1];
    this.tab += 1;
    const number = String(this.tab);
    const tb: Block = {
      id: this.ids.next("tab"),
      type: "table",
      number,
      label: `Table ${number}`,
      table_body: this.tableHtml(c),
    };
    const cap = this.captionOf(caption);
    if (cap) tb.caption = cap;
    if (label) this.labelMap.set(label, [tb.id, "table", number]);
    return tb;
  }

  private captionOf(caption: unknown): RichText | undefined {
    // pandoc caption = [maybe-short-caption, [blocks]]
    const blocks = Array.isArray(caption) && caption.length > 1 ? asArr(caption[1]) : [];
    const inls = this.blockInlines(blocks);
    if (inls.length === 0) return undefined;
    const rt: RichText = { text: "" };
    this.holders.push({ target: rt, inl: inls });
    return rt;
  }

  private blockInlines(blocks: unknown[]): unknown[] {
    const inls: unknown[] = [];
    for (const b of blocks) {
      const t = tagOf(b);
      if (t === "Para" || t === "Plain") {
        if (inls.length > 0) inls.push({ t: "Space" });
        inls.push(...asArr(asObj(b)?.c));
      }
    }
    return inls;
  }

  // ------------------------------------------------------------------ //
  // Tables -> HTML
  // ------------------------------------------------------------------ //
  private tableHtml(c: unknown[]): string {
    // Table = [attr, caption, colspecs, head, bodies, foot]
    const head = asArr(c[3]);
    const bodies = asArr(c[4]);
    const foot = asArr(c[5]);
    const rowsHtml: string[] = [];
    for (const row of asArr(head[1])) {
      rowsHtml.push(this.rowHtml(row, "th"));
    }
    for (const body of bodies) {
      const b = asArr(body);
      for (const row of [...asArr(b[2]), ...asArr(b[3])]) {
        // intermediate head rows + body rows
        rowsHtml.push(this.rowHtml(row, "td"));
      }
    }
    for (const row of asArr(foot[1])) {
      rowsHtml.push(this.rowHtml(row, "td"));
    }
    if (rowsHtml.length === 0) return "";
    return `<table>${rowsHtml.join("")}</table>`;
  }

  private rowHtml(row: unknown, tag: string): string {
    const cells: string[] = [];
    for (const cell of asArr(asArr(row)[1])) {
      // cell = [attr, alignment, rowspan, colspan, [blocks]]
      const cc = asArr(cell);
      const rspan = cc[2];
      const cspan = cc[3];
      const blocks = asArr(cc[4]);
      const txt = escapeHtml(this.inlinesToPlain(this.blockInlines(blocks)));
      let attrs = "";
      if (typeof rspan === "number" && Number.isInteger(rspan) && rspan > 1) {
        attrs += ` rowspan="${rspan}"`;
      }
      if (typeof cspan === "number" && Number.isInteger(cspan) && cspan > 1) {
        attrs += ` colspan="${cspan}"`;
      }
      cells.push(`<${tag}${attrs}>${txt}</${tag}>`);
    }
    return `<tr>${cells.join("")}</tr>`;
  }

  // ------------------------------------------------------------------ //
  // Inline rendering (pass 2)
  // ------------------------------------------------------------------ //
  private renderAll(): void {
    for (const h of this.holders) {
      const [text, matches] = this.renderInlines(h.inl);
      h.target.text = text;
      this.anchorMatches.set(h.target, matches);
    }
  }

  private renderInlines(inls: unknown[]): [string, Match[]] {
    const segs: Seg[] = [];
    this.emitInlines(inls, segs);
    const out: string[] = [];
    const matches: Match[] = [];
    let pos = 0;
    const emit = (s: string): number => {
      out.push(s);
      const start = pos;
      pos += s.length;
      return start;
    };

    for (const seg of segs) {
      if (seg.kind === "plain") {
        emit(normWs(seg.s));
      } else if (seg.kind === "math") {
        const latex = seg.s.trim();
        if (latex) emit(`$${latex}$`);
      } else {
        // anchor (cite / xref)
        const vis = normWs(seg.s).trim();
        if (!vis) continue;
        const start = emit(vis);
        if (seg.occ !== undefined) matches.push({ start, end: pos, occ: seg.occ });
      }
    }

    let text = out.join("");
    const stripped = text.trimStart();
    const lstrip = text.length - stripped.length;
    if (lstrip > 0) {
      text = stripped;
      for (const m of matches) {
        m.start -= lstrip;
        m.end -= lstrip;
      }
    }
    text = text.trimEnd();
    return [text, matches.filter((m) => 0 <= m.start && m.start < m.end && m.end <= text.length)];
  }

  private emitPlain(segs: Seg[], s: string): void {
    if (!s) return;
    // A literal text-mode '$' (from \$, \verb, \texttt) would be mis-paired by
    // the reader's $…$ math scanner; render it as a KaTeX dollar glyph
    // (\char36 — no inner '$' to confuse the scanner).
    if (s.includes("$")) {
      const parts = s.split("$");
      for (const [i, part] of parts.entries()) {
        this.emitPlainRaw(segs, part);
        if (i < parts.length - 1) segs.push({ kind: "math", s: "\\char36" });
      }
      return;
    }
    this.emitPlainRaw(segs, s);
  }

  private emitPlainRaw(segs: Seg[], s: string): void {
    if (!s) return;
    const last = segs[segs.length - 1];
    if (last && last.kind === "plain") {
      last.s += s;
    } else {
      segs.push({ kind: "plain", s });
    }
  }

  private emitInlines(inls: unknown[], segs: Seg[]): void {
    for (const x of inls) {
      this.emitInline(x, segs);
    }
  }

  private emitInline(x: unknown, segs: Seg[]): void {
    const t = tagOf(x);
    const c = asObj(x)?.c;
    if (t === "Str") {
      this.emitPlain(segs, asStr(c) ?? "");
    } else if (t === "Space" || t === "SoftBreak" || t === "LineBreak") {
      this.emitPlain(segs, " ");
    } else if (
      t === "Emph" ||
      t === "Strong" ||
      t === "Underline" ||
      t === "SmallCaps" ||
      t === "Strikeout" ||
      t === "Superscript" ||
      t === "Subscript"
    ) {
      this.emitInlines(asArr(c), segs);
    } else if (t === "Span") {
      this.emitInlines(asArr(asArr(c)[1]), segs);
    } else if (t === "Quoted") {
      const q = tagOf(asArr(c)[0]) === "SingleQuote" ? "'" : '"';
      this.emitPlain(segs, q);
      this.emitInlines(asArr(asArr(c)[1]), segs);
      this.emitPlain(segs, q);
    } else if (t === "Code") {
      this.emitPlain(segs, asStr(asArr(c)[1]) ?? "");
    } else if (t === "Math") {
      const body = katexify(asStr(asArr(c)[1]) ?? "").trim();
      if (body) segs.push({ kind: "math", s: body });
    } else if (t === "Cite") {
      this.emitCite(asArr(asArr(c)[0]), segs);
    } else if (t === "Link") {
      this.emitLink(asArr(c), segs);
    }
    // Note (footnote), Image (inline), RawInline, LineBreak handled above:
    // dropped on purpose (footnotes/raw-LaTeX carry no body text we render).
  }

  private emitCite(citations: unknown[], segs: Seg[]): void {
    const refIds: string[] = [];
    const authorYear: Array<[string, number | null]> = [];
    const modes: string[] = [];
    let prefix = "";
    let suffix = "";
    for (const ci0 of citations) {
      const ci = asObj(ci0) ?? {};
      const key = asStr(ci.citationId) ?? "";
      const mode = asStr(asObj(ci.citationMode)?.t) ?? "NormalCitation";
      modes.push(mode);
      const rid = this.key2ref.get(key);
      if (rid && !refIds.includes(rid)) refIds.push(rid);
      authorYear.push(this.citePieces(rid, key));
      // Python truthiness: an empty prefix/suffix list does NOT overwrite.
      const pre = ci.citationPrefix;
      if (Array.isArray(pre) && pre.length > 0) {
        prefix = this.inlinesToPlain(pre).trim();
      }
      const suf = ci.citationSuffix;
      if (Array.isArray(suf) && suf.length > 0) {
        suffix = this.inlinesToPlain(suf).trim();
      }
    }
    let visible = formatCitation(modes, authorYear, prefix, suffix);
    if (!visible) {
      // \citeyear w/o year, etc. — never drop
      visible = authorYear.map(([au]) => au).join("; ") || "[ref]";
    }
    const occ: CitationOccurrence = {
      ref_ids: refIds,
      raw: visible,
      via: "hyperlink",
      resolved: refIds.length > 0,
    };
    segs.push({ kind: "anchor", s: visible, occ });
  }

  private citePieces(rid: string | undefined, key: string): [string, number | null] {
    const r = rid ? this.refsById.get(rid) : undefined;
    if (!r) return [key, null];
    const a = r.authors ?? [];
    let au: string;
    if (a.length === 0) {
      au = key;
    } else if (a.length === 1) {
      au = a[0] ?? key;
    } else if (a.length === 2) {
      au = `${a[0]} & ${a[1]}`;
    } else {
      au = `${a[0]} et al.`;
    }
    return [au, r.year ?? null];
  }

  private emitLink(c: unknown[], segs: Seg[]): void {
    const attr = asArr(c[0]);
    const inls = asArr(c[1]);
    const kvs = new Map<string, unknown>();
    if (attr.length > 2) {
      for (const pair of asArr(attr[2])) {
        const kv = asArr(pair);
        const k = asStr(kv[0]);
        if (k !== undefined) kvs.set(k, kv[1]);
      }
    }
    const rtype = asStr(kvs.get("reference-type"));
    const ref = asStr(kvs.get("reference"));
    if (
      rtype !== undefined &&
      ["ref", "eqref", "autoref", "ref+label", "ref+page"].includes(rtype) &&
      ref
    ) {
      const tgt = this.labelMap.get(ref);
      if (tgt) {
        const [tid, kind, num] = tgt;
        let vis: string;
        if (kind === "equation") {
          vis = num ? `(${num})` : "(?)";
        } else {
          vis = num || this.inlinesToPlain(inls).trim() || ref;
        }
        const occ: CrossRefOccurrence = {
          kind: kind as CrossRefKind,
          raw: vis,
          target_id: tid,
          number: num ?? undefined,
          via: "hyperlink",
          resolved: true,
        };
        segs.push({ kind: "anchor", s: vis, occ });
      } else {
        const vis = this.inlinesToPlain(inls).trim() || ref;
        const occ: CrossRefOccurrence = {
          kind: "unknown",
          raw: vis,
          via: "hyperlink",
          resolved: false,
        };
        segs.push({ kind: "anchor", s: vis, occ });
      }
      return;
    }
    this.emitInlines(inls, segs); // external link: keep visible text
  }

  /** plain (token-free) rendering, for headings / captions-in-cells / cite notes */
  private inlinesToPlain(inls: unknown[]): string {
    const buf: string[] = [];
    const walk = (node: unknown): void => {
      const t = tagOf(node);
      const c = asObj(node)?.c;
      if (t === "Str") {
        buf.push(asStr(c) ?? "");
      } else if (t === "Space" || t === "SoftBreak" || t === "LineBreak") {
        buf.push(" ");
      } else if (t === "Math") {
        buf.push(`$${katexify(asStr(asArr(c)[1]) ?? "").trim()}$`);
      } else if (
        t === "Emph" ||
        t === "Strong" ||
        t === "Underline" ||
        t === "SmallCaps" ||
        t === "Strikeout" ||
        t === "Superscript" ||
        t === "Subscript"
      ) {
        for (const y of asArr(c)) walk(y);
      } else if (t === "Span") {
        for (const y of asArr(asArr(c)[1])) walk(y);
      } else if (t === "Quoted") {
        const q = tagOf(asArr(c)[0]) === "SingleQuote" ? "'" : '"';
        buf.push(q);
        for (const y of asArr(asArr(c)[1])) walk(y);
        buf.push(q);
      } else if (t === "Code") {
        buf.push(asStr(asArr(c)[1]) ?? "");
      } else if (t === "Link") {
        for (const y of asArr(asArr(c)[1])) walk(y);
      } else if (t === "Cite") {
        for (const y of asArr(asArr(c)[1])) walk(y); // the rendered fallback inlines
      }
    };
    for (const n of inls) {
      walk(n);
    }
    return normWs(buf.join("")).trim();
  }
}

// --------------------------------------------------------------------------- //
// Module helpers
// --------------------------------------------------------------------------- //

function hasContent(inls: unknown[]): boolean {
  return inls.some((x) => {
    const t = tagOf(x);
    return t !== "Space" && t !== "SoftBreak" && t !== "LineBreak";
  });
}

/** All `\includegraphics` source args inside a Figure's content blocks. */
function findImages(blocks: unknown[]): string[] {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const x of node) walk(x);
      return;
    }
    const d = asObj(node);
    if (d !== undefined) {
      if (d.t === "Image") {
        const src = asStr(asArr(asArr(d.c)[2])[0]);
        if (src !== undefined) out.push(src);
      }
      for (const v of Object.values(d)) walk(v);
    }
  };
  walk(blocks);
  return out;
}

/**
 * `(katexBody, env, rawInner)` for a display-math string.
 *
 * *rawInner* keeps the `\label`/`\nonumber`/`\tag` markers so the caller can
 * do per-row numbering; *katexBody* has them stripped (KaTeX implements none
 * of them — a leftover `\tag` is a hard render error) and multi-row
 * align-family bodies rewrapped as KaTeX-safe `aligned`.
 */
function normalizeEquation(latex: string): [string, string | undefined, string] {
  const s = latex.trim();
  const m = ENV_RE.exec(s);
  const env = m?.[1];
  const inner = m?.[2] ?? s;
  const rawInner = inner;
  let body = inner.replace(LABEL_RE, "");
  body = body.replace(TAG_RE_G, "");
  body = body.replace(NONUMBER_RE_G, "").trim();
  if (env !== undefined && MULTILINE_ENVS.has(env) && !body.trimStart().startsWith("\\begin{")) {
    body = `\\begin{aligned}\n${body}\n\\end{aligned}`;
  }
  return [katexify(body).trim(), env, rawInner];
}

/** The `\tag{…}`/`\tag*{…}` text of a math string (trimmed), else undefined. */
function eqTag(s: string): string | undefined {
  const t = TAG_RE.exec(s)?.[1]?.trim();
  return t ? t : undefined;
}

/** The 1–5 brace groups of an A&A-style `\abstract{…}…` command. */
export function extractCommandAbstract(raw: string): string[] {
  const clean = stripTexComments(raw);
  const m = pyRe("\\\\abstract\\b", "").exec(clean);
  if (!m) return [];
  let i = m.index + m[0].length;
  const groups: string[] = [];
  while (groups.length < 5) {
    while (i < clean.length && [" ", "\t", "\r", "\n"].includes(clean[i] ?? "")) {
      i += 1;
    }
    if (i >= clean.length || clean[i] !== "{") break;
    const bal = balanced(clean, i, "{", "}");
    if (bal === undefined) break;
    groups.push(bal[0]);
    i = bal[1];
  }
  return [...groups];
}

function stripTexComments(s: string): string {
  return s.replace(/(?<!\\)%[^\n]*/g, "");
}

function escapeHtml(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Reconstruct a readable in-text citation string from resolved refs. */
function formatCitation(
  modes: string[],
  authorYear: Array<[string, number | null]>,
  prefix: string,
  suffix: string
): string {
  const ay = (au: string, yr: number | null): string => (yr ? `${au} ${yr}` : au);

  const allIntext = modes.length > 0 && modes.every((m) => m === "AuthorInText");
  const allSuppress = modes.length > 0 && modes.every((m) => m === "SuppressAuthor");
  if (allSuppress) {
    const body = authorYear
      .filter(([, yr]) => yr)
      .map(([, yr]) => String(yr))
      .join("; ");
    return body ? `(${body})` : "";
  }
  if (allIntext) {
    return authorYear.map(([au, yr]) => (yr ? `${au} (${yr})` : au)).join("; ");
  }
  const body = authorYear.map(([au, yr]) => ay(au, yr)).join("; ");
  const inner = (prefix ? `${prefix} ` : "") + body + (suffix ? `, ${suffix}` : "");
  return `(${inner})`;
}

/** Drop paragraphs that rendered to nothing (e.g. a stray `\noindent`). */
function pruneEmpty(sections: Section[]): void {
  for (const sec of sections) {
    sec.blocks = (sec.blocks ?? []).filter(
      (b) => !(b.type === "paragraph" && !(b.text ?? "").trim())
    );
    pruneEmpty(sec.children ?? []);
  }
}
