/**
 * The fuser (Stage 5 MS2): merged source tree + compiler facts → IR section
 * tree with native segments. Mirrors the retired pandoc walker's semantics
 * (block inventory, id scheme, two-pass label resolution) but reads the
 * unified-latex tree directly and takes numbers from the compile (roadmap
 * Q2 print-faithful numbering; see `fuse/numbering.ts` for the join).
 *
 * Two passes, like the old walker:
 *  1. structure — sections/floats/equations/lists with ids + numbers,
 *     `\label` → (targetId, kind, number) map; text holders (paragraphs,
 *     captions, list items) keep their raw nodes;
 *  2. render — holders become `IrSegment[]` runs with cite/xref segments
 *     resolved against the completed label map; cite events from the
 *     instrumentation stream cross-check the source occurrences and
 *     backstop macro-hidden citations into `citationsByBlock`.
 *
 * Everything degrades, never throws: unknown commands/envs are dropped or
 * recursed through with counted warnings.
 */

import type {
  IrAlgorithmBlock,
  IrBlock,
  IrCodeBlock,
  IrEquationBlock,
  IrFigureBlock,
  IrListBlock,
  IrParagraphBlock,
  IrSection,
  IrSegment,
  IrTableBlock,
  IrXrefTarget,
  IrXrefTargetType,
  Reference,
} from "@argelanderspace/contracts";
import type * as Ast from "@unified-latex/unified-latex-types";
import { citeShort } from "../../../documents/render.js";
import type { TexFacts } from "../facts/index.js";
import type { TexSourceTree } from "../source/tree.js";
import { envName, lastArgText, printRawNodes } from "../source/tree.js";
import { citeModeOf, citePieces, formatCitation } from "./cite-format.js";
import { displayNumber, FallbackCounter, MathnumAssigner, stripOuterBraces } from "./numbering.js";
import { deluxetableHtml, parseDeluxetable, tabularHtml } from "./tables.js";
import { dollarSafe, katexify, textify } from "./text.js";

// --------------------------------------------------------------------------- //
// Types
// --------------------------------------------------------------------------- //

type LabelKind = IrXrefTargetType;
interface LabelTarget {
  id: string;
  kind: LabelKind;
  number?: string;
}

interface Holder {
  blockId: string;
  nodes: Ast.Node[];
  /** where inline \label registers (current section or nothing for floats) */
  attach: (key: string) => void;
  setSegments: (segments: IrSegment[]) => void;
}

/** A source cite occurrence recorded in pass 2 (for the event cross-check). */
interface CiteOcc {
  file: string | undefined;
  line: number;
  keys: string[];
  refIds: string[];
}

interface BlockSpan {
  id: string;
  file: string | undefined;
  startLine: number;
}

interface FigureJob {
  blockId: string;
  src: string;
  fromFile: string | undefined;
}

export interface FuseInput {
  tree: TexSourceTree;
  facts: TexFacts;
  references: Reference[];
  keyToRefId: ReadonlyMap<string, string>;
  /** Whether an instrumentation event stream exists at all (else fallback numbering). */
  eventsAvailable: boolean;
  /** Macro names the expansion layer left raw (cite-hiding backstop candidates). */
  unexpandableMacros?: ReadonlySet<string>;
}

export interface FuseResult {
  sections: IrSection[];
  citationsByBlock: Record<string, string[]>;
  warnings: string[];
  /** Deferred figure jobs: resolve via the TexFigurePort, then set imgPath. */
  figureJobs: readonly FigureJob[];
  /** blockId → figure block (for materialization results). */
  figureBlocks: ReadonlyMap<string, IrFigureBlock>;
}

// --------------------------------------------------------------------------- //
// Constants
// --------------------------------------------------------------------------- //

const CITE_COMMANDS = new Set([
  "cite",
  "citep",
  "citet",
  "citealp",
  "citealt",
  "citeauthor",
  "citeyear",
  "citeyearpar",
  "citepalias",
  "citetalias",
  "citenum",
  "citeonline",
]);
const XREF_COMMANDS = new Set(["ref", "eqref", "pageref", "autoref", "cref", "Cref"]);
const FORMAT_COMMANDS = new Set([
  "textbf",
  "emph",
  "textit",
  "textsc",
  "textsl",
  "textrm",
  "textsf",
  "texttt",
  "underline",
  "mbox",
  "makebox",
  "fbox",
  "textsuperscript",
  "textsubscript",
  "reflectbox",
  "rotatebox",
  "scalebox",
  "adjustbox",
  "textcolor",
  "colorbox",
  "facility", // aastex: \facility{...} prints its content
  "dataset",
  "software",
  "objectname",
  "object",
]);
const DROP_MACROS = new Set([
  "maketitle",
  "tableofcontents",
  "listoffigures",
  "listoftables",
  "noindent",
  "centering",
  "raggedright",
  "newpage",
  "clearpage",
  "pagebreak",
  "linebreak",
  "bigskip",
  "medskip",
  "smallskip",
  "vspace",
  "hspace",
  "hfill",
  "vfill",
  "footnote",
  "footnotemark",
  "footnotetext",
  "thanks",
  "bibliographystyle",
  "bibliography",
  "newcommand",
  "renewcommand",
  "providecommand",
  "input",
  "include",
  "keywords",
  "subject",
  "date",
  "correspondingauthor",
  "inst",
  "affiliation",
  "affil",
  "orcidlink",
  "email",
  // meta commands consumed by extractTexMeta (they also appear in the body
  // stream for aa.cls-style preambles-inside-document)
  "author",
  "and",
  "institute",
  "authorrunning",
  "titlerunning",
  "offprint",
  // font/size switches and declarations: no text content of their own
  "it",
  "bf",
  "rm",
  "sf",
  "tt",
  "sc",
  "sl",
  "em",
  "cal",
  "normalfont",
  "normalsize",
  "small",
  "footnotesize",
  "scriptsize",
  "tiny",
  "large",
  "Large",
  "LARGE",
  "huge",
  "Huge",
  "fontfamily",
  "fontseries",
  "fontshape",
  "fontsize",
  "usefont",
  "selectfont",
  "newgeometry",
  "restoregeometry",
  "oldgeometry",
  "pagenumbering",
  "thispagestyle",
  "pagestyle",
  "setlength",
  "addtocounter",
  "defcitealias", // consumed at Fuser construction (alias map)
  "title",
  "subtitle", // meta (consumed by extractTexMeta)
  "acknowledgments", // aastex macro (the acknowledgements env is transparent)
  "rule", // a drawn box (often the figure body placeholder)
]);
const PERROW_ENVS = new Set(["align", "alignat", "eqnarray", "gather", "flalign"]);
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
const KNOWN_MATH_ENVS = new Set([
  "equation",
  "align",
  "gather",
  "multline",
  "flalign",
  "alignat",
  "eqnarray",
  "math",
  "displaymath",
]);
const SPECIAL_CHARS: Record<string, string> = {
  "&": "&",
  "%": "%",
  "#": "#",
  _: "_",
  "{": "{",
  "}": "}",
  dots: "…",
  ldots: "…",
  TeX: "TeX",
  LaTeX: "LaTeX",
  " ": " ",
  ",": " ",
  ";": " ",
  ":": " ",
  "!": "",
  quad: " ",
  qquad: " ",
  "/": "",
  "\\": " ", // linebreak in text mode
  xspace: "",
  textasteriskcentered: "*",
  textbardbl: "‖",
  textbar: "|",
};
/** Transparent environments: content recursed, no block of their own. */
const TRANSPARENT_ENVS = new Set([
  "center",
  "flushleft",
  "flushright",
  "minipage",
  "quote",
  "quotation",
  "titlepage",
  "abstract*",
  "subequations", // inner envs keep their own numbering (events carry 3a/3b)
  "acknowledgements",
  "appendix", // aastex appendix ENV (sections inside keep event numbering)
  "landscape", // pdflscape: content rotated, readable
  "turnpage",
]);

class IdGen {
  private readonly c = new Map<string, number>();
  next(prefix: string): string {
    const n = (this.c.get(prefix) ?? 0) + 1;
    this.c.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

// --------------------------------------------------------------------------- //
// The fuser
// --------------------------------------------------------------------------- //

export class Fuser {
  private readonly ids = new IdGen();
  private readonly labelMap = new Map<string, LabelTarget>();
  private readonly holders: Holder[] = [];
  private readonly citeOccs: CiteOcc[] = [];
  private readonly citesByBlock: Record<string, string[]> = {};
  private readonly blockSpans: BlockSpan[] = [];
  private readonly figureJobs: FigureJob[] = [];
  private readonly figureBlocks = new Map<string, IrFigureBlock>();
  private readonly unknownCmds = new Map<string, number>();
  private readonly mathnum: MathnumAssigner | null;
  private readonly sectionEvents: Extract<TexFacts["events"][number], { type: "section" }>[];
  private sectionCursor = 0;
  private readonly eqCounter = new FallbackCounter();
  private readonly figCounter = new FallbackCounter();
  private readonly tabCounter = new FallbackCounter();
  private readonly algCounter = new FallbackCounter();
  private lofCursor = 0;
  private lotCursor = 0;
  private readonly secCounters = new Map<number, FallbackCounter>();
  private appendix = false;

  private readonly topSections: IrSection[] = [];
  private readonly frontBlocks: IrBlock[] = [];
  private readonly sectionStack: IrSection[] = [];
  private abstractSection: IrSection | undefined;
  private readonly nociteKeys: string[] = [];
  private readonly citeAliases = new Map<string, string>();
  private refsByIdCache: Map<string, Reference> | null = null;
  private readonly warnings: string[] = [];

  constructor(private readonly input: FuseInput) {
    const events = input.facts.events;
    // natbib \defcitealias{key}{alias} — collected for citetalias/citepalias text
    for (const n of [...input.tree.preamble, ...input.tree.body]) {
      if (n.type === "macro" && n.content === "defcitealias") {
        const key = printRawNodes(n.args?.[0]?.content ?? []).trim();
        const alias = printRawNodes(n.args?.[1]?.content ?? []).trim();
        if (key !== "" && alias !== "") this.citeAliases.set(key, alias);
      }
    }
    this.mathnum = input.eventsAvailable
      ? new MathnumAssigner(events.filter((e) => e.type === "mathnum"))
      : null;
    this.sectionEvents = events.filter(
      (e): e is Extract<TexFacts["events"][number], { type: "section" }> => e.type === "section"
    );
  }

  private get tree(): TexSourceTree {
    return this.input.tree;
  }
  private get facts(): TexFacts {
    return this.input.facts;
  }

  // ------------------------------------------------------------------ //
  // Entry point
  // ------------------------------------------------------------------ //
  run(): FuseResult {
    if (!this.input.eventsAvailable) {
      this.warnings.push(
        "no instrumentation event stream: numbering falls back to .aux + source counting (degraded mode)"
      );
    }
    this.consumeNodes(this.tree.body);
    const out: IrSection[] = [];
    if (this.abstractSection !== undefined) out.push(this.abstractSection);
    if (this.frontBlocks.length > 0) {
      out.push({ id: this.ids.next("sec"), level: 1, blocks: this.frontBlocks, children: [] });
    }
    out.push(...this.topSections);
    this.renderHolders();
    this.crossCheckCiteEvents();
    this.finishWarnings();
    return {
      sections: out,
      citationsByBlock: this.citesByBlock,
      warnings: this.warnings,
      figureJobs: this.figureJobs,
      figureBlocks: this.figureBlocks,
    };
  }

  // ------------------------------------------------------------------ //
  // Structure walk (pass 1)
  // ------------------------------------------------------------------ //
  private consumeNodes(nodes0: Ast.Node[]): void {
    const nodes = unwrapFontSwitches(nodes0);
    let paragraph: Ast.Node[] = [];
    const flush = (): void => {
      if (
        paragraph.some(
          (n) => n.type !== "whitespace" && n.type !== "comment" && n.type !== "parbreak"
        )
      ) {
        this.openParagraph(paragraph);
      }
      paragraph = [];
    };

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i] as Ast.Node;
      switch (node.type) {
        case "whitespace":
        case "comment":
        case "string":
        case "inlinemath":
        case "group":
          paragraph.push(node);
          break;
        case "parbreak":
          paragraph.push(node);
          flush();
          break;
        case "displaymath":
          flush();
          this.emitBlock(this.equationBlock(node, undefined));
          break;
        case "mathenv":
          flush();
          this.emitBlock(this.equationBlock(node, envName(node)));
          break;
        case "verbatim": {
          flush();
          const venv = verbatimEnvName(node);
          if (venv === "comment" || venv === "comment*") break; // the comment package: discarded content
          this.emitBlock(this.codeBlock(node, venv));
          break;
        }
        case "environment": {
          const name = envName(node);
          if (KNOWN_MATH_ENVS.has(name.replace(/\*+$/, ""))) {
            flush();
            this.emitBlock(this.equationBlock(node, name));
          } else if (name === "figure" || name === "figure*") {
            flush();
            this.emitBlock(this.figureBlock(node));
          } else if (name === "table" || name === "table*") {
            flush();
            this.emitBlock(this.tableBlock(node));
          } else if (name === "deluxetable" || name === "deluxetable*") {
            flush();
            this.deluxeTable(node);
          } else if (name === "tabular" || name === "tabular*" || name === "tabularx") {
            flush();
            this.emitBlock(this.bareTableBlock(node));
          } else if (name === "itemize" || name === "enumerate" || name === "description") {
            flush();
            this.emitBlock(this.listBlock(node, name === "enumerate"));
          } else if (name === "verbatim" || name === "lstlisting") {
            flush();
            this.emitBlock(this.codeBlock(node, name));
          } else if (name === "algorithm" || name === "algorithm*") {
            flush();
            this.emitBlock(this.algorithmBlock(node));
          } else if (name === "thebibliography") {
            flush();
            // references come from the .bbl facts (or the inline-fallback
            // extraction in ir.ts) — the env's content is never body text.
          } else if (name === "abstract") {
            flush();
            this.abstractSection = this.makeAbstractEnv(node);
          } else if (name === "comment" || name === "comment*") {
            flush();
            // discarded entirely (defense in depth; usually parses as verbatim)
          } else if (TRANSPARENT_ENVS.has(name)) {
            flush();
            this.consumeNodes(nodeContent(node));
          } else {
            flush();
            this.noteUnknown(`environment ${name}`);
            this.consumeNodes(nodeContent(node));
          }
          break;
        }
        case "macro": {
          const name = node.content;
          if (name === "section" || name === "subsection" || name === "subsubsection") {
            flush();
            const level = name === "section" ? 1 : name === "subsection" ? 2 : 3;
            // a \label sibling immediately after belongs to this section
            let label: string | undefined;
            let j = i + 1;
            while (
              j < nodes.length &&
              ((nodes[j] as Ast.Node).type === "whitespace" ||
                (nodes[j] as Ast.Node).type === "comment")
            ) {
              j++;
            }
            const next = nodes[j];
            if (next !== undefined && next.type === "macro" && next.content === "label") {
              label = lastArgText(next);
              i = j; // consume the label
            }
            this.openSection(node, level, label);
          } else if (name === "paragraph" || name === "subparagraph") {
            flush();
            this.openRuninSection(node, name === "paragraph" ? 4 : 5);
          } else if (name === "appendix") {
            this.appendix = true;
            this.secCounters.clear();
          } else if (name === "thebibliography") {
            flush();
            // references come from the .bbl facts (or the inline-fallback
            // extraction in ir.ts) — the env's content is never body text.
          } else if (name === "abstract") {
            flush();
            // aa.cls command form: the first group may be parser-attached
            // (the default macro spec knows \abstract with one arg); consume
            // up to 5 groups total.
            const groups: Ast.Node[][] = [];
            const attached = node.args?.[node.args.length - 1];
            if (attached !== undefined && attached.content.length > 0) {
              groups.push([...attached.content] as Ast.Node[]);
            }
            let j = i + 1;
            while (groups.length < 5) {
              while (
                j < nodes.length &&
                ((nodes[j] as Ast.Node).type === "whitespace" ||
                  (nodes[j] as Ast.Node).type === "comment" ||
                  (nodes[j] as Ast.Node).type === "parbreak")
              ) {
                j++;
              }
              const g = nodes[j];
              if (g === undefined || g.type !== "group") break;
              groups.push([...(g as Ast.Group).content]);
              j++;
            }
            if (groups.length > 0) {
              i = j - 1;
              this.abstractSection = this.makeAbstractGroups(groups);
            }
          } else if (name === "label") {
            // paragraph-level label: attaches to the current section
            const key = lastArgText(node);
            const sec = this.sectionStack[this.sectionStack.length - 1];
            if (key !== undefined && sec !== undefined) {
              const t: LabelTarget = { id: sec.id, kind: "section" };
              if (sec.number !== undefined) t.number = sec.number;
              this.labelMap.set(key, t);
            }
          } else if (DROP_MACROS.has(name)) {
            // dropped (document flow / meta handled elsewhere)
          } else {
            paragraph.push(node); // inline/unknown macros render in pass 2
          }
          break;
        }
        default:
          paragraph.push(node);
          break;
      }
    }
    flush();
  }

  private emitBlock(block: IrBlock | undefined): void {
    if (block === undefined) return;
    const sec = this.sectionStack[this.sectionStack.length - 1];
    if (sec === undefined) this.frontBlocks.push(block);
    else sec.blocks.push(block);
  }

  private openParagraph(nodes: Ast.Node[]): void {
    const block: IrParagraphBlock = { id: this.ids.next("p"), type: "paragraph", segments: [] };
    const sec = this.sectionStack[this.sectionStack.length - 1];
    this.holders.push({
      blockId: block.id,
      nodes,
      attach: (key) => {
        if (sec !== undefined) {
          const t: LabelTarget = { id: sec.id, kind: "section" };
          if (sec.number !== undefined) t.number = sec.number;
          this.labelMap.set(key, t);
        }
      },
      setSegments: (segments) => {
        block.segments = segments;
      },
    });
    this.span(block.id, nodes);
    this.emitBlock(block);
  }

  private openSection(node: Ast.Macro, level: number, label: string | undefined): void {
    const starred = printRawNodes(node.args?.[0]?.content ?? []).includes("*");
    const titleArg = node.args?.[node.args.length - 1];
    const heading = this.plainText((titleArg?.content ?? []) as Ast.Node[]);
    let number: string | undefined;
    if (!starred) {
      number = this.sectionNumber(node.content, level, label);
    }
    const sec: IrSection = { id: this.ids.next("sec"), level, blocks: [], children: [] };
    if (number !== undefined) sec.number = number;
    if (heading !== "") sec.heading = heading;
    while (
      this.sectionStack.length > 0 &&
      (this.sectionStack[this.sectionStack.length - 1]?.level ?? 0) >= level
    ) {
      this.sectionStack.pop();
    }
    const parent = this.sectionStack[this.sectionStack.length - 1];
    if (parent === undefined) this.topSections.push(sec);
    else parent.children.push(sec);
    this.sectionStack.push(sec);
    if (label !== undefined) {
      const t: LabelTarget = { id: sec.id, kind: "section" };
      if (number !== undefined) t.number = number;
      this.labelMap.set(label, t);
    }
    this.span(sec.id, [node]);
  }

  /** \paragraph/\subparagraph: run-in heading, unnumbered when secnumdepth ≤ 3. */
  private openRuninSection(node: Ast.Macro, level: number): void {
    const titleArg = node.args?.[node.args.length - 1];
    const heading = this.plainText((titleArg?.content ?? []) as Ast.Node[]);
    const sec: IrSection = { id: this.ids.next("sec"), level, blocks: [], children: [] };
    if (heading !== "") sec.heading = heading;
    while (
      this.sectionStack.length > 0 &&
      (this.sectionStack[this.sectionStack.length - 1]?.level ?? 0) >= level
    ) {
      this.sectionStack.pop();
    }
    const parent = this.sectionStack[this.sectionStack.length - 1];
    if (parent === undefined) this.topSections.push(sec);
    else parent.children.push(sec);
    this.sectionStack.push(sec);
    this.span(sec.id, [node]);
  }

  private sectionNumber(name: string, level: number, label: string | undefined): string {
    // 1. section events (print truth), in source order
    const ev = this.sectionEvents[this.sectionCursor];
    if (ev !== undefined && ev.name === name) {
      this.sectionCursor++;
      this.secCounter(level).resync(ev.number);
      if (label !== undefined) {
        const auxN = this.auxNumber(label);
        if (auxN !== undefined && auxN !== ev.number) {
          this.warnings.push(
            `section number mismatch for label ${label}: event "${ev.number}" vs aux "${auxN}" (event wins)`
          );
        }
      }
      return ev.number;
    }
    if (ev !== undefined) {
      this.warnings.push(
        `section event desync: expected ${name}, next event is ${ev.name} ("${ev.number}"); falling back to aux/counting here`
      );
    }
    // 2. aux label
    if (label !== undefined) {
      const auxN = this.auxNumber(label);
      if (auxN !== undefined) return this.secCounter(level).resync(auxN);
    }
    // 3. counting
    return this.secCounter(level).next();
  }

  private secCounter(level: number): FallbackCounter {
    for (const lv of [...this.secCounters.keys()]) {
      if (lv > level) this.secCounters.delete(lv); // deeper levels reset
    }
    let c = this.secCounters.get(level);
    if (c === undefined) {
      c = new FallbackCounter();
      c.appendixMode = this.appendix && level === 1;
      this.secCounters.set(level, c);
    }
    return c;
  }

  /** \setcounter{name}{n} resyncs a print counter (next value = n+1). */
  private applySetcounter(name: string, value: number): void {
    const v = String(value);
    if (name === "equation") this.eqCounter.resync(v);
    else if (name === "figure") this.figCounter.resync(v);
    else if (name === "table") this.tabCounter.resync(v);
    else if (name === "section") this.secCounter(1).resync(v);
    else if (name === "subsection") this.secCounter(2).resync(v);
    else if (name === "subsubsection") this.secCounter(3).resync(v);
  }

  private auxNumber(key: string): string | undefined {
    const n = this.facts.labels[key]?.number;
    return n === undefined ? undefined : stripOuterBraces(n);
  }

  // ------------------------------------------------------------------ //
  // Blocks
  // ------------------------------------------------------------------ //
  private span(id: string, nodes: Ast.Node[]): void {
    const first = nodes.find(
      (n) =>
        n.type !== "whitespace" &&
        n.type !== "comment" &&
        n.position !== undefined &&
        n.position !== null
    );
    if (first?.position !== undefined && first.position !== null) {
      this.blockSpans.push({
        id,
        file: this.tree.fileOf(first),
        startLine: first.position.start.line,
      });
    }
  }

  private equationBlock(node: Ast.Node, env: string | undefined): IrEquationBlock {
    const eid = this.ids.next("eq");
    const content = nodeContent(node);
    const starred = env === undefined || env.endsWith("*");
    const envBase = env?.replace(/\*+$/, "");
    const rows = splitMathRows(content);
    const rowNumbers: (string | undefined)[] = [];

    if (!starred && envBase !== undefined) {
      const perRow = PERROW_ENVS.has(envBase);
      const logicalRows = perRow ? rows.map((r) => r.nodes) : [rows.flatMap((r) => r.nodes)];
      const labelRows = perRow ? rows.map((r) => r.labels) : [rows.flatMap((r) => r.labels)];
      for (const [idx, rnodes] of logicalRows.entries()) {
        const nonumber = hasMacro(rnodes, "nonumber") || hasMacro(rnodes, "notag");
        const tag = findMacro(rnodes, "tag");
        const labels = labelRows[idx] ?? [];
        let num: string | undefined;
        if (nonumber) {
          num = undefined;
        } else if (tag !== undefined) {
          const star = printRawNodes(tag.args?.[0]?.content ?? []).includes("*");
          const tagText = stripOuterBraces(
            printRawNodes((tag.args?.[tag.args.length - 1]?.content ?? []) as Ast.Node[]).trim()
          );
          num = tagText;
          if (!star && this.mathnum !== null) {
            const evNum = this.mathnum.take(envBase, this.warnings);
            if (evNum !== undefined) {
              if (evNum !== tagText) {
                this.warnings.push(
                  `mathnum tag mismatch: event "${evNum}" vs source tag "${tagText}" (event wins)`
                );
              }
              num = evNum;
            }
          }
        } else if (this.mathnum !== null) {
          num = this.mathnum.take(envBase, this.warnings);
          if (num === undefined) num = this.fallbackEqNumber(labels);
        } else {
          num = this.fallbackEqNumber(labels);
        }
        rowNumbers.push(num);
        for (const key of labels) {
          if (!this.labelMap.has(key)) {
            const t: LabelTarget = { id: eid, kind: "equation" };
            if (num !== undefined) t.number = num;
            this.labelMap.set(key, t);
          }
        }
      }
    } else {
      // unnumbered display: labels (if any) map to no number
      for (const r of rows) {
        for (const key of r.labels) {
          if (!this.labelMap.has(key)) this.labelMap.set(key, { id: eid, kind: "equation" });
        }
      }
    }

    // KaTeX body: strip label/tag/nonumber macros, rewrap multi-row envs
    const bodyNodes = content.filter(
      (n) => !(n.type === "macro" && MATH_STRIP_MACROS.has(n.content))
    );
    let body = printRawNodes(bodyNodes);
    if (env !== undefined && MULTILINE_ENVS.has(env) && !body.trimStart().startsWith("\\begin{")) {
      body = `\\begin{aligned}\n${body}\n\\end{aligned}`;
    }
    const block: IrEquationBlock = { id: eid, type: "equation", latex: katexify(body).trim() };
    const number = displayNumber(rowNumbers.filter((n): n is string => n !== undefined));
    if (number !== undefined) block.number = number;
    const envLabels = rows.flatMap((r) => r.labels);
    if (envLabels.length > 0) {
      const firstLabel = envLabels[0];
      if (firstLabel !== undefined) block.label = firstLabel;
    }
    this.span(eid, [node]);
    return block;
  }

  /** Degraded equation numbering: aux for labeled, counting otherwise. */
  private fallbackEqNumber(labels: readonly string[]): string {
    for (const key of labels) {
      const auxN = this.auxNumber(key);
      if (auxN !== undefined) return this.eqCounter.resync(auxN);
    }
    return this.eqCounter.next();
  }

  /**
   * Printed float number: the .lof/.lot entry in source order (compiler
   * truth, correct even for the label-before-caption quirk), then the aux
   * label, then counting. `\caption*` (starred) prints no number.
   */
  private floatNumber(
    kind: "figure" | "table",
    labelKey: string | undefined,
    caption: Ast.Macro | undefined
  ): string | undefined {
    if (caption === undefined) return undefined;
    const starred = printRawNodes(caption.args?.[0]?.content ?? []).includes("*");
    if (starred) return undefined;
    const list = kind === "figure" ? this.facts.lof : this.facts.lot;
    const counter = kind === "figure" ? this.figCounter : this.tabCounter;
    const cursor = kind === "figure" ? "lofCursor" : "lotCursor";
    const entry = list[this[cursor]];
    if (entry !== undefined && entry.number !== "") {
      this[cursor]++;
      counter.resync(entry.number);
      const auxN = labelKey !== undefined ? this.auxNumber(labelKey) : undefined;
      if (auxN !== undefined && auxN !== entry.number) {
        this.warnings.push(
          `${kind} number mismatch for label ${labelKey}: lot/lof "${entry.number}" vs aux "${auxN}" (lot/lof wins)`
        );
      }
      return entry.number;
    }
    if (labelKey !== undefined) {
      const auxN = this.auxNumber(labelKey);
      if (auxN !== undefined) return counter.resync(auxN);
    }
    return counter.next();
  }

  private figureBlock(node: Ast.Node): IrFigureBlock {
    const fid = this.ids.next("fig");
    const content = nodeContent(node);
    const caption = findMacroDeep(content, "caption");
    const labelKey = findLabelIn(node);
    const hasCaption = caption !== undefined;
    const number = this.floatNumber("figure", labelKey, caption);
    void hasCaption;
    const block: IrFigureBlock = { id: fid, type: "figure" };
    if (number !== undefined) {
      block.number = number;
      block.label = `Figure ${number}`;
    }
    if (labelKey !== undefined && number !== undefined) {
      this.labelMap.set(labelKey, { id: fid, kind: "figure", number });
    } else if (labelKey !== undefined) {
      // \label without \caption labels the enclosing section (TeX semantics)
      this.warnings.push(`figure label ${labelKey} without \\caption: no float number assigned`);
    }
    if (caption !== undefined) {
      const capNodes = [...(caption.args?.[caption.args.length - 1]?.content ?? [])] as Ast.Node[];
      this.holders.push({
        blockId: fid,
        nodes: capNodes,
        attach: () => {},
        setSegments: (segments) => {
          if (segments.length > 0) block.captionSegments = segments;
        },
      });
    }
    const img = findMacroDeep(content, "includegraphics");
    if (img !== undefined) {
      const src = lastArgText(img);
      if (src !== undefined) {
        this.figureJobs.push({ blockId: fid, src, fromFile: this.tree.fileOf(node) });
      }
    }
    this.figureBlocks.set(fid, block);
    this.span(fid, [node]);
    return block;
  }

  private tableBlock(node: Ast.Node): IrTableBlock {
    const tid = this.ids.next("tab");
    const content = nodeContent(node);
    const caption = findMacroDeep(content, "caption");
    const tabular = findTabularDeep(content);
    return this.finishTable(node, tid, {
      captionMacro: caption,
      labelKey: findLabelIn(node),
      tableNodes: tabular !== undefined ? nodeContent(tabular) : [],
      deluxe: undefined,
    });
  }

  private bareTableBlock(node: Ast.Node): IrTableBlock {
    const tid = this.ids.next("tab");
    return this.finishTable(node, tid, {
      captionMacro: undefined,
      labelKey: findLabelIn(node),
      tableNodes: nodeContent(node),
      deluxe: undefined,
    });
  }

  private deluxeTable(node: Ast.Node): void {
    const tid = this.ids.next("tab");
    const parts = parseDeluxetable(node);
    const block = this.finishTable(node, tid, {
      captionMacro: findMacroDeep(nodeContent(node), "tablecaption"),
      captionNodes: parts.captionNodes,
      labelKey: parts.labelKey,
      tableNodes: [],
      deluxe: parts,
    });
    this.emitBlock(block);
    for (const trailing of parts.trailing) {
      this.openParagraph(trailing);
    }
  }

  private finishTable(
    node: Ast.Node,
    tid: string,
    opts: {
      captionMacro: Ast.Macro | undefined;
      captionNodes?: Ast.Node[] | undefined;
      labelKey: string | undefined;
      tableNodes: Ast.Node[];
      deluxe: ReturnType<typeof parseDeluxetable> | undefined;
    }
  ): IrTableBlock {
    const captionNodes =
      opts.captionNodes ??
      (opts.captionMacro !== undefined
        ? ([
            ...(opts.captionMacro.args?.[opts.captionMacro.args.length - 1]?.content ?? []),
          ] as Ast.Node[])
        : undefined);
    const hasCaption = captionNodes !== undefined && captionNodes.length > 0;
    const number = hasCaption
      ? this.floatNumber("table", opts.labelKey, opts.captionMacro)
      : undefined;
    const block: IrTableBlock = { id: tid, type: "table" };
    if (number !== undefined) {
      block.number = number;
      block.label = `Table ${number}`;
    }
    if (opts.labelKey !== undefined && number !== undefined) {
      this.labelMap.set(opts.labelKey, { id: tid, kind: "table", number });
    }
    const html =
      opts.deluxe !== undefined
        ? deluxetableHtml(opts.deluxe, (ns) => this.plainText(ns, tid))
        : tabularHtml(opts.tableNodes, (ns) => this.plainText(ns, tid));
    if (html !== "") block.tableBody = html;
    if (captionNodes !== undefined) {
      this.holders.push({
        blockId: tid,
        nodes: captionNodes,
        attach: () => {},
        setSegments: (segments) => {
          if (segments.length > 0) block.captionSegments = segments;
        },
      });
    }
    this.span(tid, [node]);
    return block;
  }

  private listBlock(node: Ast.Node, ordered: boolean): IrListBlock {
    const lid = this.ids.next("list");
    const block: IrListBlock = { id: lid, type: "list", ordered, items: [] };
    const sec = this.sectionStack[this.sectionStack.length - 1];
    let itemNodes: Ast.Node[] = [];
    const flush = (): void => {
      if (
        itemNodes.some(
          (n) => n.type !== "whitespace" && n.type !== "comment" && n.type !== "parbreak"
        )
      ) {
        const idx = block.items.length;
        block.items.push({ segments: [] });
        this.holders.push({
          blockId: lid,
          nodes: itemNodes,
          attach: (key) => {
            if (sec !== undefined) {
              const t: LabelTarget = { id: sec.id, kind: "section" };
              if (sec.number !== undefined) t.number = sec.number;
              this.labelMap.set(key, t);
            }
          },
          setSegments: (segments) => {
            block.items[idx] = { segments };
          },
        });
      }
      itemNodes = [];
    };
    for (const n of nodeContent(node)) {
      if (n.type === "macro" && n.content === "item") {
        flush();
        continue;
      }
      itemNodes.push(n);
    }
    flush();
    this.span(lid, [node]);
    return block;
  }

  private codeBlock(node: Ast.Node, env: string | undefined): IrCodeBlock {
    const cid = this.ids.next("code");
    const block: IrCodeBlock = { id: cid, type: "code" };
    block.body =
      typeof (node as { content?: unknown }).content === "string"
        ? ((node as { content: string }).content as string)
        : printRawNodes(nodeContent(node));
    if (env === "lstlisting") {
      const opt = (node as { args?: Ast.Argument[] }).args?.[0];
      if (opt !== undefined) {
        const m = /language=([a-zA-Z0-9#+]+)/.exec(printRawNodes(opt.content));
        if (m?.[1] !== undefined) block.lang = m[1];
      }
    }
    this.span(cid, [node]);
    return block;
  }

  private algorithmBlock(node: Ast.Node): IrAlgorithmBlock {
    const aid = this.ids.next("alg");
    const content = nodeContent(node);
    const caption = findMacroDeep(content, "caption");
    const labelKey = findLabelIn(node);
    let number: string | undefined;
    if (caption !== undefined) {
      const auxN = labelKey !== undefined ? this.auxNumber(labelKey) : undefined;
      number = auxN !== undefined ? this.algCounter.resync(auxN) : this.algCounter.next();
    }
    const block: IrAlgorithmBlock = { id: aid, type: "algorithm" };
    if (number !== undefined) block.number = number;
    if (labelKey !== undefined && number !== undefined) {
      this.labelMap.set(labelKey, { id: aid, kind: "algorithm", number });
    }
    if (caption !== undefined) {
      const capNodes = [...(caption.args?.[caption.args.length - 1]?.content ?? [])] as Ast.Node[];
      this.holders.push({
        blockId: aid,
        nodes: capNodes,
        attach: () => {},
        setSegments: (segments) => {
          if (segments.length > 0) block.captionSegments = segments;
        },
      });
    }
    const body = printRawNodes(
      content.filter(
        (n) => !(n.type === "macro" && (n.content === "caption" || n.content === "label"))
      )
    ).trim();
    if (body !== "") block.body = body;
    this.span(aid, [node]);
    return block;
  }

  // ------------------------------------------------------------------ //
  // Abstract
  // ------------------------------------------------------------------ //
  private makeAbstractEnv(node: Ast.Node): IrSection | undefined {
    return this.makeAbstractFrom(nodeContent(node));
  }

  /** aa.cls 5-group \abstract: Context./Aims./Methods./Results./Conclusions. */
  private makeAbstractGroups(groups: Ast.Node[][]): IrSection | undefined {
    const labels = ["Context", "Aims", "Methods", "Results", "Conclusions"];
    const paras = groups.map((g, i) => {
      const prefix =
        groups.length === 5
          ? ([{ type: "string", content: `${labels[i] ?? ""}. ` }] as Ast.Node[])
          : [];
      return [...prefix, ...g];
    });
    return this.makeAbstractFrom(interleaveParbreaks(paras));
  }

  private makeAbstractFrom(content: Ast.Node[]): IrSection | undefined {
    const sec: IrSection = {
      id: this.ids.next("sec"),
      level: 1,
      heading: "Abstract",
      blocks: [],
      children: [],
    };
    const saved = this.sectionStack.splice(0, this.sectionStack.length, sec);
    this.consumeNodes(content);
    this.sectionStack.splice(0, this.sectionStack.length, ...saved);
    return sec.blocks.length > 0 ? sec : undefined;
  }

  // ------------------------------------------------------------------ //
  // Inline rendering (pass 2)
  // ------------------------------------------------------------------ //
  private renderHolders(): void {
    for (const h of this.holders) {
      h.setSegments(this.segments(h.nodes, h.attach, h.blockId));
    }
  }

  /** nodes → IrSegment[] (native cite/xref/math segments). */
  segments(nodes: Ast.Node[], attach: (key: string) => void, blockId: string): IrSegment[] {
    const segs: IrSegment[] = [];
    let text = "";
    const flushText = (): void => {
      const t = textify(text);
      text = "";
      for (const part of dollarSafe(t)) {
        if (part.kind === "math") {
          segs.push({ type: "math", latex: part.text });
        } else {
          const last = segs[segs.length - 1];
          if (last !== undefined && last.type === "text") last.text += part.text;
          else segs.push({ type: "text", text: part.text });
        }
      }
    };
    const pushMath = (latex: string): void => {
      const body = katexify(latex).trim();
      if (body === "") return;
      segs.push({ type: "math", latex: body });
    };

    const walk = (ns: readonly Ast.Node[]): void => {
      for (let ni = 0; ni < ns.length; ni++) {
        const n = ns[ni] as Ast.Node;
        switch (n.type) {
          case "string":
            text += n.content;
            break;
          case "whitespace":
          case "parbreak":
            text += " ";
            break;
          case "comment":
            // TeX: the char before % is preserved — the comment node's start
            // position points at it (the space, or the % when adjacent).
            if (this.commentHasPrecedingSpace(n)) text += " ";
            break;
          case "group":
            walk(n.content);
            break;
          case "inlinemath":
          case "displaymath":
            flushText();
            pushMath(printRawNodes(n.content));
            break;
          case "macro": {
            const name = n.content;
            if (name === "label") {
              const key = lastArgText(n);
              if (key !== undefined) attach(key);
            } else if (CITE_COMMANDS.has(name)) {
              flushText();
              this.citeSegment(n, segs, blockId);
            } else if (name === "nocite") {
              const keys = (lastArgText(n) ?? "")
                .split(",")
                .map((k) => k.trim())
                .filter((k) => k !== "");
              this.nociteKeys.push(...keys);
            } else if (XREF_COMMANDS.has(name)) {
              flushText();
              this.xrefSegment(n, segs);
            } else if (name === "ensuremath") {
              const arg = n.args?.[n.args.length - 1];
              if (arg !== undefined) {
                flushText();
                pushMath(printRawNodes(arg.content));
              }
            } else if (MATH_IN_TEXT.has(name)) {
              flushText();
              pushMath(`\\${name}`);
            } else if (name in ACCENT_COMBINING) {
              const taken = takeAccentTarget(ns, ni + 1);
              text += taken.text + (ACCENT_COMBINING[name] ?? "");
              ni = taken.nextIndex - 1;
            } else if (FORMAT_COMMANDS.has(name)) {
              const arg = n.args?.[n.args.length - 1];
              if (arg !== undefined) walk(arg.content);
            } else if (name === "href") {
              const arg = n.args?.[1];
              if (arg !== undefined) walk(arg.content);
            } else if (name === "url" || name === "email") {
              const arg = n.args?.[n.args.length - 1];
              if (arg !== undefined) text += printRawNodes(arg.content);
            } else if (name === "ion") {
              const a0 = n.args?.[0];
              const a1 = n.args?.[1];
              if (a0 !== undefined) walk(a0.content);
              text += " ";
              if (a1 !== undefined) walk(a1.content);
            } else if (name === "etal") {
              text += "et al.";
            } else if (name in SPECIAL_CHARS) {
              text += SPECIAL_CHARS[name];
            } else if (DROP_MACROS.has(name)) {
              // dropped
            } else {
              this.noteUnknown(`\\${name}`);
              const arg = n.args?.[n.args.length - 1];
              if (arg !== undefined && (n.args?.length ?? 0) > 0) walk(arg.content);
            }
            break;
          }
          case "verbatim":
            text +=
              typeof (n as { content?: unknown }).content === "string"
                ? (n as { content: string }).content
                : printRawNodes(nodeContent(n));
            break;
          default:
            walk(nodeContent(n));
            break;
        }
      }
    };
    walk(nodes);
    flushText();
    // trim leading/trailing whitespace-only text segments
    const first = segs[0];
    if (first !== undefined && first.type === "text") {
      first.text = first.text.trimStart();
      if (first.text === "") segs.shift();
    }
    const last = segs[segs.length - 1];
    if (last !== undefined && last.type === "text") {
      last.text = last.text.trimEnd();
      if (last.text === "") segs.pop();
    }
    return segs;
  }

  private citeSegment(node: Ast.Macro, segs: IrSegment[], blockId: string): void {
    const args = node.args ?? [];
    const keyArg = args[args.length - 1];
    const keys = (keyArg !== undefined ? printRawNodes(keyArg.content) : "")
      .split(",")
      .map((k) => k.trim())
      .filter((k) => k !== "");
    // optional note args: the ones before the key arg with "[" marks
    const noteArgs = args.slice(0, -1).filter((a) => (a as { openMark?: string }).openMark === "[");
    const prefix = noteArgs.length > 0 ? this.plainText(noteArgs[0]?.content ?? []) : "";
    const suffix = noteArgs.length > 1 ? this.plainText(noteArgs[1]?.content ?? []) : "";

    const mode = citeModeOf(node.content);
    const isAlias = node.content === "citepalias" || node.content === "citetalias";
    const modes = keys.map(() => mode);
    const pieces = keys.map((key) => {
      const rid = this.input.keyToRefId.get(key);
      return citePieces(rid !== undefined ? this.refsById.get(rid) : undefined, key);
    });
    let visible: string;
    if (isAlias) {
      const body = keys.map((k) => this.citeAliases.get(k) ?? k).join("; ");
      visible = node.content === "citepalias" ? `(${body})` : body;
    } else {
      visible = formatCitation(modes, pieces, prefix, suffix);
      if (visible === "") visible = pieces.map(([au]) => au).join("; ") || "[ref]";
    }

    const refIds: string[] = [];
    const refs = keys.map((key) => {
      const rid = this.input.keyToRefId.get(key);
      if (rid === undefined) return { id: key, resolved: false };
      if (!refIds.includes(rid)) refIds.push(rid);
      const ref = this.refsById.get(rid);
      const out: { id: string; resolved: boolean; short?: string; title?: string } = {
        id: rid,
        resolved: true,
      };
      if (ref !== undefined) {
        out.short = citeShort(ref);
        if (ref.title !== undefined && ref.title !== "") out.title = ref.title;
      }
      return out;
    });
    segs.push({ type: "cite", refs, raw: visible });
    this.citeOccs.push({
      file: this.tree.fileOf(node),
      line: node.position?.start.line ?? 0,
      keys,
      refIds,
    });
    if (refIds.length > 0) {
      const arr = this.citesByBlock[blockId] ?? [];
      this.citesByBlock[blockId] = arr;
      for (const id of refIds) if (!arr.includes(id)) arr.push(id);
    }
  }

  private xrefSegment(node: Ast.Macro, segs: IrSegment[]): void {
    const key = lastArgText(node) ?? "";
    const tgt = this.labelMap.get(key);
    const isEq = node.content === "eqref";
    let raw: string;
    if (tgt?.number !== undefined) {
      raw = isEq ? `(${tgt.number})` : tgt.number;
    } else {
      raw = isEq ? "(?)" : key;
    }
    let target: IrXrefTarget;
    if (tgt !== undefined) {
      const t: IrXrefTarget = {
        id: tgt.id,
        resolved: true,
        targetType: tgt.kind,
      };
      if (tgt.number !== undefined) t.number = tgt.number;
      target = t;
    } else {
      target = { id: key === "" ? "?" : key, resolved: false };
    }
    segs.push({ type: "xref", target, raw });
  }

  private get refsById(): Map<string, Reference> {
    if (this.refsByIdCache === null) {
      this.refsByIdCache = new Map(this.input.references.map((r) => [r.id, r]));
    }
    return this.refsByIdCache;
  }

  /** Plain text of inline nodes (headings, cells); cites keep visible text. */
  plainText(nodes: readonly Ast.Node[], blockId?: string): string {
    const parts: string[] = [];
    const walk = (ns: readonly Ast.Node[]): void => {
      for (let ni = 0; ni < ns.length; ni++) {
        const n = ns[ni] as Ast.Node;
        switch (n.type) {
          case "string":
            parts.push(n.content);
            break;
          case "whitespace":
          case "parbreak":
            parts.push(" ");
            break;
          case "group":
            walk(n.content);
            break;
          case "inlinemath":
          case "displaymath":
            parts.push(`$${katexify(printRawNodes(n.content)).trim()}$`);
            break;
          case "macro": {
            const name = n.content;
            if (name === "ensuremath") {
              const arg = n.args?.[n.args.length - 1];
              if (arg !== undefined) {
                parts.push(`$${katexify(printRawNodes(arg.content)).trim()}$`);
              }
            } else if (MATH_IN_TEXT.has(name)) {
              parts.push(`$\\${name}$`);
            } else if (name in ACCENT_COMBINING) {
              const taken = takeAccentTarget(ns, ni + 1);
              parts.push(taken.text + (ACCENT_COMBINING[name] ?? ""));
              ni = taken.nextIndex - 1;
            } else if (CITE_COMMANDS.has(name)) {
              const keyArg = n.args?.[n.args.length - 1];
              const keys = (keyArg !== undefined ? printRawNodes(keyArg.content) : "")
                .split(",")
                .map((k) => k.trim())
                .filter((k) => k !== "");
              const mode = citeModeOf(name);
              const pieces = keys.map((key) => {
                const rid = this.input.keyToRefId.get(key);
                return citePieces(rid !== undefined ? this.refsById.get(rid) : undefined, key);
              });
              const vis = formatCitation(
                keys.map(() => mode),
                pieces,
                "",
                ""
              );
              parts.push(vis !== "" ? vis : pieces.map(([au]) => au).join("; ") || "[ref]");
              if (blockId !== undefined) {
                const refIds = keys
                  .map((k) => this.input.keyToRefId.get(k))
                  .filter((r): r is string => r !== undefined);
                this.citeOccs.push({
                  file: this.tree.fileOf(n),
                  line: n.position?.start.line ?? 0,
                  keys,
                  refIds,
                });
                const arr = this.citesByBlock[blockId] ?? [];
                this.citesByBlock[blockId] = arr;
                for (const id of refIds) if (!arr.includes(id)) arr.push(id);
              }
            } else if (XREF_COMMANDS.has(name)) {
              const key = lastArgText(n) ?? "";
              const tgt = this.labelMap.get(key);
              parts.push(tgt?.number ?? key);
            } else if (name === "label") {
              // nothing
            } else if (FORMAT_COMMANDS.has(name) || name === "objectname" || name === "object") {
              const arg = n.args?.[n.args.length - 1];
              if (arg !== undefined) walk(arg.content);
            } else if (name === "href") {
              const arg = n.args?.[1];
              if (arg !== undefined) walk(arg.content);
            } else if (name === "ion") {
              const a0 = n.args?.[0];
              const a1 = n.args?.[1];
              if (a0 !== undefined) walk(a0.content);
              parts.push(" ");
              if (a1 !== undefined) walk(a1.content);
            } else if (name === "etal") {
              parts.push("et al.");
            } else if (name in SPECIAL_CHARS) {
              parts.push(SPECIAL_CHARS[name] ?? "");
            } else if (DROP_MACROS.has(name)) {
              // dropped
            } else {
              const arg = n.args?.[n.args.length - 1];
              if (arg !== undefined && (n.args?.length ?? 0) > 0) walk(arg.content);
            }
            break;
          }
          case "comment":
            if (this.commentHasPrecedingSpace(n)) parts.push(" ");
            break;
          default:
            walk(nodeContent(n));
            break;
        }
      }
    };
    walk(nodes);
    return textify(parts.join("")).trim();
  }

  /**
   * True when a space/tab precedes the comment's `%` (TeX preserves it as a
   * word separator; `a%x\nb` joins). The comment node's start position
   * points at that character (the space, or the % when adjacent).
   */
  private commentHasPrecedingSpace(node: Ast.Node): boolean {
    const pos = node.position;
    if (pos === undefined || pos === null) return false;
    const file = this.tree.fileOf(node);
    if (file === undefined) return false;
    const line = this.tree.linesOf(file)?.[pos.start.line - 1];
    if (line === undefined) return false;
    const ch = line[pos.start.column - 1]; // 0-based index of the start char
    return ch === " " || ch === "\t";
  }

  // ------------------------------------------------------------------ //
  // Cite-event cross-check + macro-hidden backstop
  // ------------------------------------------------------------------ //
  private crossCheckCiteEvents(): void {
    const events = this.input.facts.events.filter((e) => e.type === "citation");
    if (events.length === 0) return;
    const mainFile = this.tree.files[0];
    let dropped = 0;
    let matched = 0;
    let backstopped = 0;
    const backstopLocs: string[] = [];
    const usedOcc = new Set<number>();
    for (const ev of events) {
      if (ev.type !== "citation") continue;
      const file = ev.file ?? mainFile;
      const lines = file !== undefined ? this.tree.linesOf(file) : undefined;
      const lineText = lines?.[ev.line - 1] ?? "";
      // 1. exact source-occurrence match (file + line + keys)
      let hit = -1;
      for (const [i, occ] of this.citeOccs.entries()) {
        if (usedOcc.has(i)) continue;
        const sameKeys =
          occ.keys.length === ev.keys.length && occ.keys.every((k, j) => k === ev.keys[j]);
        if (sameKeys && occ.file === ev.file && occ.line === ev.line) {
          hit = i;
          break;
        }
      }
      if (hit !== -1) {
        usedOcc.add(hit);
        matched++;
        continue;
      }
      // 2. no occurrence: a moving-arg double-fire points into a generated
      // file read (no \cite on that source line) → dropped; an event on a
      // line with an unexpandable cite-hiding macro is the backstop case.
      const looksLikeCite = /\\cite[a-zA-Z]*\b/.test(lineText);
      const hiddenVia = [...(this.input.unexpandableMacros ?? [])].find((name) =>
        new RegExp(`\\\\${name}\\b`).test(lineText)
      );
      if (!looksLikeCite && hiddenVia === undefined) {
        dropped++;
        continue;
      }
      const blockId = this.nearestBlock(file, ev.line);
      if (blockId !== undefined) {
        const arr = this.citesByBlock[blockId] ?? [];
        this.citesByBlock[blockId] = arr;
        for (const key of ev.keys) {
          const rid = this.input.keyToRefId.get(key);
          if (rid !== undefined && !arr.includes(rid)) arr.push(rid);
        }
        backstopped++;
        if (backstopLocs.length < 5) backstopLocs.push(`${file ?? "?"}:${ev.line}`);
      }
    }
    if (dropped > 0) {
      this.warnings.push(
        `cite events: dropped ${dropped} generated-file duplicate(s) (moving-argument double-fire)`
      );
    }
    if (backstopped > 0) {
      this.warnings.push(
        `cite events: ${backstopped} citation(s) hidden in unexpanded macros backstopped into citationsByBlock (e.g. ${backstopLocs.join(", ")})`
      );
    }
    const unexplained = events.length - dropped - matched - backstopped;
    if (unexplained > 0) {
      this.warnings.push(`cite events: ${unexplained} event(s) matched no source occurrence`);
    }
  }

  private nearestBlock(file: string | undefined, line: number): string | undefined {
    let best: BlockSpan | undefined;
    for (const span of this.blockSpans) {
      if (span.file !== file) continue;
      if (span.startLine <= line && (best === undefined || span.startLine >= best.startLine)) {
        best = span;
      }
    }
    return best?.id ?? this.blockSpans[this.blockSpans.length - 1]?.id;
  }

  // ------------------------------------------------------------------ //
  // Warnings
  // ------------------------------------------------------------------ //
  private noteUnknown(what: string): void {
    this.unknownCmds.set(what, (this.unknownCmds.get(what) ?? 0) + 1);
  }

  private finishWarnings(): void {
    for (const [what, count] of [...this.unknownCmds.entries()].sort()) {
      this.warnings.push(`dropped/approximated unknown construct ${what} ×${count}`);
    }
    if (this.nociteKeys.length > 0) {
      this.warnings.push(
        `\\nocite keys registered without visible text: ${this.nociteKeys.join(", ")}`
      );
    }
    if (this.mathnum !== null && !this.mathnum.exhausted) {
      const left = this.mathnum.peek();
      this.warnings.push(
        `mathnum events not fully consumed (next: ${left?.id ?? "?"} env ${left?.env ?? "?"}) — some printed numbers may be unassigned`
      );
    }
  }
}

// --------------------------------------------------------------------------- //
// Module helpers
// --------------------------------------------------------------------------- //

/** Accent macros → combining char (author names, Universit\"at). */
const ACCENT_COMBINING: Record<string, string> = {
  '"': "̈",
  "'": "́",
  "`": "̀",
  "^": "̂",
  "~": "̃",
  "=": "̄",
  ".": "̇",
  u: "̆",
  v: "̌",
  H: "̋",
  c: "̧",
  k: "̨",
  b: "̱",
  d: "̣",
  r: "̊",
};

/** Math-only commands authors drop into text (via/without \ensuremath). */
const MATH_IN_TEXT = new Set([
  "alpha",
  "beta",
  "gamma",
  "delta",
  "epsilon",
  "zeta",
  "eta",
  "theta",
  "iota",
  "kappa",
  "lambda",
  "mu",
  "nu",
  "xi",
  "pi",
  "rho",
  "sigma",
  "tau",
  "upsilon",
  "phi",
  "chi",
  "psi",
  "omega",
  "Gamma",
  "Delta",
  "Theta",
  "Lambda",
  "Xi",
  "Pi",
  "Sigma",
  "Phi",
  "Psi",
  "Omega",
  "odot",
  "oplus",
  "circ",
  "pm",
  "times",
  "cdot",
  "leq",
  "geq",
  "lesssim",
  "gtrsim",
  "approx",
  "sim",
  "propto",
  "infty",
  "mid",
  "parallel",
  "perp",
  "degree",
  "arcmin",
  "arcsec",
  "sun",
  "earth",
  "dagger",
  "ddagger",
  "astrosun",
  "rightarrow",
  "leftarrow",
]);

/**
 * The accent's target: a following group sibling, or the next string's
 * first char (remainder survives). Returns text + the index AFTER it.
 */
function takeAccentTarget(
  ns: readonly Ast.Node[],
  from: number
): { text: string; nextIndex: number } {
  const next = ns[from];
  if (next === undefined) return { text: "", nextIndex: from };
  if (next.type === "group") {
    return { text: printRawNodes(next.content), nextIndex: from + 1 };
  }
  if (next.type === "string") {
    const ch = next.content[0] ?? "";
    const rest = next.content.slice(1);
    if (rest !== "") {
      // keep the remainder as a node for the caller's loop
      (next as { content: string }).content = rest;
      return { text: ch, nextIndex: from };
    }
    return { text: ch, nextIndex: from + 1 };
  }
  if (next.type === "whitespace") {
    // accent on space: drop the accent
    return { text: "", nextIndex: from + 1 };
  }
  return { text: "", nextIndex: from };
}

/** Content nodes of an env/group-ish node. */
function nodeContent(node: Ast.Node): Ast.Node[] {
  const content = (node as { content?: unknown }).content;
  return Array.isArray(content) ? (content as Ast.Node[]) : [];
}

const MATH_STRIP_MACROS = new Set(["label", "tag", "nonumber", "notag"]);

interface MathRow {
  nodes: Ast.Node[];
  labels: string[];
}

/** Split math-env content into rows at top-level `\\`. */
function splitMathRows(content: Ast.Node[]): MathRow[] {
  const rows: MathRow[] = [];
  let current: Ast.Node[] = [];
  const flush = (): void => {
    rows.push({ nodes: current, labels: collectLabels(current) });
    current = [];
  };
  for (const n of content) {
    if (n.type === "macro" && n.content === "\\") {
      flush();
      continue;
    }
    current.push(n);
  }
  flush();
  return rows;
}

function collectLabels(nodes: readonly Ast.Node[]): string[] {
  const out: string[] = [];
  const walk = (ns: readonly Ast.Node[]): void => {
    for (const n of ns) {
      if (n.type === "macro" && n.content === "label") {
        const key = lastArgText(n);
        if (key !== undefined) out.push(key);
      }
      const c = (n as { content?: unknown }).content;
      if (Array.isArray(c) && n.type !== "verbatim") walk(c as Ast.Node[]);
      for (const a of (n as { args?: Ast.Argument[] }).args ?? []) {
        if (Array.isArray(a.content)) walk(a.content as Ast.Node[]);
      }
    }
  };
  walk(nodes);
  return out;
}

function hasMacro(nodes: readonly Ast.Node[], name: string): boolean {
  return findMacro(nodes, name) !== undefined;
}

function findMacro(nodes: readonly Ast.Node[], name: string): Ast.Macro | undefined {
  for (const n of nodes) {
    if (n.type === "macro" && n.content === name) return n;
  }
  return undefined;
}

/** Recursive macro search (float bodies nest content in center/minipage). */
function findMacroDeep(nodes: readonly Ast.Node[], name: string): Ast.Macro | undefined {
  for (const n of nodes) {
    if (n.type === "macro" && n.content === name) return n;
    const c = (n as { content?: unknown }).content;
    if (Array.isArray(c) && n.type !== "verbatim") {
      const found = findMacroDeep(c as Ast.Node[], name);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Font-switch containers are layout noise: `\small{…}` (macro + group
 * sibling) and `{\small …}` (group led by a switch) both unwrap, so a
 * \begin{verbatim} inside surfaces at body level as a real code block.
 */
const FONT_SWITCH_MACROS = new Set([
  "small",
  "footnotesize",
  "scriptsize",
  "tiny",
  "normalsize",
  "large",
  "Large",
  "LARGE",
  "huge",
  "Huge",
  "it",
  "bf",
  "rm",
  "sf",
  "tt",
  "sc",
  "sl",
  "em",
  "cal",
  "normalfont",
  "centering",
  "raggedright",
]);

function unwrapFontSwitches(nodes: Ast.Node[]): Ast.Node[] {
  const out: Ast.Node[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i] as Ast.Node;
    if (n.type === "macro" && FONT_SWITCH_MACROS.has(n.content)) {
      // \small{…}: the group sibling unwraps; bare \small drops
      let j = i + 1;
      while (
        j < nodes.length &&
        ((nodes[j] as Ast.Node).type === "whitespace" || (nodes[j] as Ast.Node).type === "comment")
      ) {
        j++;
      }
      const g = nodes[j];
      if (g !== undefined && g.type === "group") {
        out.push(...(g as Ast.Group).content);
        i = j;
      }
      continue;
    }
    if (n.type === "group") {
      const inner = [...(n as Ast.Group).content];
      const first = inner.find((x) => x.type !== "whitespace" && x.type !== "comment");
      if (first !== undefined && first.type === "macro" && FONT_SWITCH_MACROS.has(first.content)) {
        out.push(...inner.filter((x) => x !== first));
        continue;
      }
    }
    out.push(n);
  }
  return out;
}

/** The env name of a verbatim node ("verbatim"/"lstlisting"/"comment"/…). */
function verbatimEnvName(node: Ast.Node): string | undefined {
  const env = (node as { env?: unknown }).env;
  return typeof env === "string" ? env : undefined;
}

/**
 * The tabular inside a table env, recursing through layout-transparent
 * wrappers (\begin{center}\begin{tabular}… and brace groups with a bare
 * \centering). Never descends into a tabular's cells.
 */
function findTabularDeep(nodes: readonly Ast.Node[]): Ast.Node | undefined {
  for (const n of nodes) {
    if (
      (n.type === "environment" || n.type === "mathenv") &&
      ["tabular", "tabular*", "tabularx"].includes(envName(n))
    ) {
      return n;
    }
    if (
      (n.type === "environment" &&
        ["center", "flushleft", "flushright", "minipage"].includes(envName(n))) ||
      n.type === "group"
    ) {
      const found = findTabularDeep(nodeContent(n));
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** The first \label key anywhere inside a node (float envs incl. captions). */
function findLabelIn(node: Ast.Node): string | undefined {
  const keys = collectLabels(nodeContent(node));
  for (const n of (node as { args?: Ast.Argument[] }).args ?? []) {
    if (Array.isArray(n.content)) keys.push(...collectLabels(n.content as Ast.Node[]));
  }
  return keys[0];
}

/** Join paragraphs with parbreak nodes between them. */
function interleaveParbreaks(paras: Ast.Node[][]): Ast.Node[] {
  const out: Ast.Node[] = [];
  for (const [i, para] of paras.entries()) {
    if (i > 0) out.push({ type: "parbreak" } as Ast.Parbreak);
    out.push(...para);
  }
  return out;
}
