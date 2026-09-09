/**
 * LaTeX source-tree loading for the Stage 5 tex pipeline (roadmap Q1):
 * unified-latex parse with a curated macro/environment signature table,
 * recursive `\input`/`\include` merge, and a cross-check against the
 * compile's `-recorder` .fls INPUT list.
 *
 * Parse notes (unified-latex 1.8.4, probed):
 * - every node carries `position` (line:column) within ITS OWN file; the
 *   merge tags each subtree with its source file so event alignment by
 *   (file, line) works across `\input` children;
 * - macros with a known signature own their `args` (argument nodes);
 *   unknown macros leave following `{…}` groups as siblings — everything
 *   the fuser handles has a signature below;
 * - math environments the parser knows parse as `mathenv` (content in math
 *   mode), unknown ones as `environment` (text mode); verbatim/lstlisting
 *   become `verbatim` nodes whose content is never interpreted.
 *
 * Merge semantics: `\input` splices the child's content in place (TeX
 * semantics); `\include` does the same (the separate .aux / \clearpage
 * behavior is invisible in our artifacts' namespace). Cycles are cut with
 * a visited set; missing files keep the macro node + a warning. The .fls
 * INPUT list is filtered (wrapper/sty/absolute system paths/generated
 * artifacts dropped) and cross-checked against the merged set both ways.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import type * as Ast from "@unified-latex/unified-latex-types";
import type { PluginOptions } from "@unified-latex/unified-latex-util-parse";
import { getParser } from "@unified-latex/unified-latex-util-parse";
import { printRaw } from "@unified-latex/unified-latex-util-print-raw";
import { expandTexMacros, extractMacroDefs } from "./macros.js";

// --------------------------------------------------------------------------- //
// Signature table
// --------------------------------------------------------------------------- //

/** `s o o m` natbib cite family + kernel cite. */
const CITE_SIG = "s o o m";
const XREF_SIG = "m";

const MACRO_SIGNATURES: Record<string, string> = {
  // structure
  section: "s o m",
  subsection: "s o m",
  subsubsection: "s o m",
  paragraph: "s o m",
  subparagraph: "s o m",
  appendix: "",
  // labels / cross-refs
  label: "m",
  ref: XREF_SIG,
  eqref: XREF_SIG,
  pageref: XREF_SIG,
  autoref: XREF_SIG,
  cref: "s o m",
  Cref: "s o m",
  // citations
  cite: "o o m",
  citep: CITE_SIG,
  citet: CITE_SIG,
  citealp: CITE_SIG,
  citealt: CITE_SIG,
  citeauthor: CITE_SIG,
  citeyear: CITE_SIG,
  citeyearpar: CITE_SIG,
  citepalias: CITE_SIG,
  citetalias: CITE_SIG,
  defcitealias: "m m",
  citenum: "m",
  citeonline: "m",
  nocite: "m",
  // floats
  caption: "o m",
  includegraphics: "o m",
  // deluxetable (AASTeX)
  tablecaption: "o m",
  tablehead: "m",
  tablecomments: "m",
  tablerefs: "m",
  tablenotetext: "m m",
  colhead: "m",
  tabletypesize: "m",
  tablewidth: "m",
  tablecolumns: "m",
  tablenum: "m",
  // meta
  title: "o m",
  subtitle: "o m",
  author: "o m",
  date: "m",
  thanks: "m",
  email: "m",
  institute: "m",
  inst: "m",
  affiliation: "m",
  affil: "m",
  altaffiliation: "m",
  and: "",
  orcidlink: "m",
  correspondingauthor: "m m",
  // text formatting (unwrapped at fuse time)
  textbf: "m",
  emph: "m",
  textit: "m",
  textsc: "m",
  textsl: "m",
  textrm: "m",
  textsf: "m",
  texttt: "m",
  underline: "m",
  mbox: "m",
  makebox: "o m",
  fbox: "m",
  textsuperscript: "m",
  textsubscript: "m",
  href: "m m",
  url: "m",
  // aastex text helpers
  objectname: "m",
  object: "m",
  ion: "m m",
  etal: "",
  // document flow / formatting-only (dropped)
  documentclass: "o m",
  usepackage: "o m",
  RequirePackage: "o m",
  bibliographystyle: "m",
  bibliography: "m",
  maketitle: "",
  tableofcontents: "",
  listoffigures: "",
  listoftables: "",
  noindent: "",
  centering: "",
  raggedright: "",
  newpage: "",
  clearpage: "",
  pagebreak: "o",
  linebreak: "o",
  bigskip: "",
  medskip: "",
  smallskip: "",
  vspace: "s m",
  hspace: "s m",
  hfill: "",
  vfill: "",
  footnote: "o m",
  footnotemark: "o",
  footnotetext: "o m",
  item: "o",
  // counter/length/font declarations (dropped or handled at fuse time)
  setcounter: "m m",
  addtocounter: "m m",
  setlength: "m m",
  fontfamily: "m",
  fontseries: "m",
  fontshape: "m",
  fontsize: "m m",
  usefont: "m m m m",
  selectfont: "",
  newgeometry: "m",
  restoregeometry: "",
  oldgeometry: "m",
  reflectbox: "m",
  rotatebox: "o m m",
  scalebox: "m o m",
  adjustbox: "o m",
  offprint: "m",
  authorrunning: "m",
  titlerunning: "m",
  // macro definitions (the bounded macro layer consumes these)
  newcommand: "s m o o m",
  renewcommand: "s m o o m",
  providecommand: "s m o o m",
  // math row machinery (stripped from KaTeX bodies; drive numbering)
  tag: "s m",
  nonumber: "",
  notag: "",
  intertext: "m",
  // table rules / spans
  hline: "",
  toprule: "",
  midrule: "",
  bottomrule: "",
  tableline: "",
  cline: "m",
  cmidrule: "m",
  multicolumn: "m m m",
  multirow: "m m m",
  // deluxetable data delimiters
  startdata: "",
  enddata: "",
  // aa.cls structured abstract (consumed by group-following, no signature)
  keywords: "m",
  subject: "m",
};

/** Environment signatures (args before the body). */
const ENV_SIGNATURES: Record<string, string> = {
  figure: "o",
  "figure*": "o",
  table: "o",
  "table*": "o",
  tabular: "o m",
  "tabular*": "m o m",
  tabularx: "m o m",
  deluxetable: "o m",
  "deluxetable*": "o m",
  longtable: "m",
  itemize: "o",
  enumerate: "o",
  description: "o",
  abstract: "",
  document: "",
  center: "",
  flushleft: "",
  flushright: "",
  minipage: "o o o m",
  quote: "",
  quotation: "",
  algorithm: "o",
  "algorithm*": "o",
  algorithmic: "o",
  lstlisting: "o",
  alignat: "o m",
  "alignat*": "o m",
};

let cachedParser: ReturnType<typeof getParser> | null = null;
/** The shared unified-latex parser with the tex-pipeline signature table. */
export function texParser(): ReturnType<typeof getParser> {
  if (cachedParser === null) {
    const macros: Record<string, { signature: string }> = {};
    for (const [name, signature] of Object.entries(MACRO_SIGNATURES)) {
      macros[name] = { signature };
    }
    const environments: Record<string, { signature: string }> = {};
    for (const [name, signature] of Object.entries(ENV_SIGNATURES)) {
      environments[name] = { signature };
    }
    const options: PluginOptions = { macros, environments } as PluginOptions;
    cachedParser = getParser(options);
  }
  return cachedParser;
}

// --------------------------------------------------------------------------- //
// Tree types
// --------------------------------------------------------------------------- //

/** A parsed, `\input`-merged LaTeX source tree. */
export interface TexSourceTree {
  /** The merged root AST of the main file (children spliced in place). */
  root: Ast.Root;
  /** Content nodes of the document environment (the body). */
  body: Ast.Node[];
  /** Nodes between \documentclass and \begin{document} (title/author/macros). */
  preamble: Ast.Node[];
  /**
   * Source file of a node, normalized relative to the source root with
   * forward slashes — the same shape the .sty's \CurrentFile writes
   * ("child.tex", "sub/child.tex"). Main file = its path relative to srcDir.
   */
  fileOf(node: Ast.Node): string | undefined;
  /** Every merged source file (normalized, main first). */
  files: string[];
  /** Raw line arrays per merged file (for event cross-checks). */
  linesOf(file: string): string[] | undefined;
  /** Absolute path of a merged file (normalized rel name), if merged. */
  resolveFile(file: string): string | undefined;
  /** Macro names the bounded layer declined to expand (pathological defs). */
  unexpandableMacros: ReadonlySet<string>;
  /** Non-fatal problems (missing inputs, fls mismatches). */
  warnings: string[];
}

/** node → source file (normalized, relative). */
type FileMap = WeakMap<Ast.Node, string>;

function tagTree(node: Ast.Node, file: string, map: FileMap): void {
  map.set(node, file);
  const content = (node as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const child of content as Ast.Node[]) tagTree(child, file, map);
  }
  const args = (node as { args?: unknown }).args;
  if (Array.isArray(args)) {
    for (const arg of args as Ast.Node[]) tagTree(arg, file, map);
  }
}

/** Stamp a produced (macro-expanded) subtree with the call site's position. */
function stampPosition(node: Ast.Node, position: NonNullable<Ast.Node["position"]>): void {
  (node as { position?: unknown }).position = position;
  const content = (node as { content?: unknown }).content;
  if (Array.isArray(content)) {
    for (const child of content as Ast.Node[]) stampPosition(child, position);
  }
  const args = (node as { args?: unknown }).args;
  if (Array.isArray(args)) {
    for (const arg of args as Ast.Node[]) stampPosition(arg, position);
  }
}

function normRel(srcRoot: string, abs: string): string {
  return normalize(abs)
    .slice(srcRoot.length + 1)
    .split(sep)
    .join("/");
}

/** The document env node of a parsed root, if any. */
function documentEnv(root: Ast.Root): Ast.Environment | undefined {
  for (const node of root.content) {
    if ((node.type === "environment" || node.type === "mathenv") && envName(node) === "document") {
      return node;
    }
  }
  return undefined;
}

/** The environment name of an environment/mathenv node. */
export function envName(node: Ast.Node): string {
  const env = (node as { env?: unknown }).env;
  if (typeof env === "string") return env;
  if (Array.isArray(env)) {
    return (env as Ast.Node[]).map((n) => (n.type === "string" ? n.content : "")).join("");
  }
  // mathenv nodes carry env as a single string node
  if (env !== null && typeof env === "object") {
    const content = (env as { content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return "";
}

// --------------------------------------------------------------------------- //
// \input / \include merge
// --------------------------------------------------------------------------- //

const INPUT_MACROS = new Set(["input", "include"]);

interface Merger {
  srcRoot: string;
  byNorm: Map<string, string>; // normalized rel → abs
  fileMap: FileMap;
  files: string[];
  fileLines: Map<string, string[]>;
  warnings: string[];
  visiting: string[]; // cycle guard stack of normalized names
}

function resolveInput(m: Merger, arg: string, fromFile: string): string | null {
  let rel = arg.trim().replaceAll("\\", "/");
  if (!/\.[a-zA-Z]+$/.test(rel)) rel = `${rel}.tex`;
  const baseDir = dirname(m.byNorm.get(fromFile) ?? m.srcRoot);
  for (const candidate of [resolve(baseDir, rel), resolve(m.srcRoot, rel)]) {
    if (candidate !== m.srcRoot && !candidate.startsWith(m.srcRoot + sep)) continue;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function parseFile(m: Merger, abs: string): Ast.Root {
  const rel = normRel(m.srcRoot, abs);
  const content = readFileSync(abs, "utf8");
  m.byNorm.set(rel, abs);
  m.files.push(rel);
  m.fileLines.set(rel, content.split("\n"));
  const root = texParser().parse(content) as Ast.Root;
  tagTree(root, rel, m.fileMap);
  return root;
}

function mergeInputs(m: Merger, nodes: Ast.Node[], fromFile: string): Ast.Node[] {
  const out: Ast.Node[] = [];
  for (const node of nodes) {
    if (node.type === "macro" && INPUT_MACROS.has(node.content)) {
      const arg = lastArgText(node);
      const target = arg !== undefined ? resolveInput(m, arg, fromFile) : null;
      if (target === null) {
        m.warnings.push(`unresolved \\${node.content}{${arg ?? "?"}} in ${fromFile}`);
        out.push(node);
        continue;
      }
      const rel = normRel(m.srcRoot, target);
      if (m.visiting.includes(rel)) {
        m.warnings.push(
          `cyclic \\${node.content}{${arg}} ignored: ${[...m.visiting, rel].join(" → ")}`
        );
        continue;
      }
      m.visiting.push(rel);
      const child = parseFile(m, target);
      const merged = mergeInputs(m, child.content, rel);
      m.visiting.pop();
      out.push(...merged);
      continue;
    }
    // recurse into environment bodies (inputs hide inside envs too)
    const content = (node as { content?: unknown }).content;
    if (Array.isArray(content) && node.type !== "verbatim") {
      (node as { content: unknown }).content = mergeInputs(m, content as Ast.Node[], fromFile);
    }
    out.push(node);
  }
  return out;
}

/** Raw text of the LAST argument (the mandatory one for our signatures). */
export function lastArgText(node: Ast.Node): string | undefined {
  const args = (node as { args?: Ast.Argument[] }).args;
  const last = args?.[args.length - 1];
  if (last === undefined) return undefined;
  return printRawNodes(last.content).trim();
}

// --------------------------------------------------------------------------- //
// .fls cross-check
// --------------------------------------------------------------------------- //

/**
 * Filter the .fls INPUT list to user source files: drop the instrumentation
 * wrapper/sty, absolute system paths (TeX Live), and generated artifacts
 * (.aux/.bbl/.toc/.lof/.lot/.fls/.out/.blg/.log/.pdf/.jsonl...).
 */
export function flsSourceFiles(flsInputs: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of flsInputs) {
    const p = raw.replace(/^\.\//, "");
    if (p === "__argelander_wrap.tex" || p === "argelander.sty") continue;
    if (isAbsolute(p)) continue;
    if (/\.(aux|bbl|toc|lof|lot|fls|out|blg|log|pdf|jsonl|fdb_latexmk|synctex(\.gz)?)$/.test(p)) {
      continue;
    }
    if (!/\.(tex|ltx|sty|cls|bst|def|cfg|bib)$/i.test(p)) continue;
    out.push(p);
  }
  return [...new Set(out)];
}

function crossCheckFls(tree: TexSourceTree, flsInputs: readonly string[] | undefined): void {
  if (flsInputs === undefined) return;
  const srcs = flsSourceFiles(flsInputs).filter((p) => /\.(tex|ltx)$/i.test(p));
  const merged = new Set(tree.files);
  const mainBase = tree.files[0];
  for (const p of srcs) {
    if (!merged.has(p) && p !== mainBase) {
      tree.warnings.push(`fls lists a .tex we did not merge (loaded by TeX but not fused): ${p}`);
    }
  }
  for (const f of tree.files) {
    if (!srcs.includes(f)) {
      tree.warnings.push(`merged file absent from the .fls INPUT list (stale fls?): ${f}`);
    }
  }
}

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //

export interface LoadTexSourceOptions {
  /** Absolute source root. */
  srcDir: string;
  /** Absolute path of the driver .tex (must be inside srcDir). */
  mainTex: string;
  /** .fls INPUT lines (facts.inputs) for the cross-check; absent = skip. */
  flsInputs?: readonly string[];
}

export function loadTexSourceTree(opts: LoadTexSourceOptions): TexSourceTree {
  const srcRoot = resolve(opts.srcDir);
  const mainAbs = resolve(opts.mainTex);
  if (!existsSync(mainAbs)) {
    throw new Error(`main .tex file does not exist: ${opts.mainTex}`);
  }
  if (mainAbs !== srcRoot && !mainAbs.startsWith(srcRoot + sep)) {
    throw new Error(`main .tex is not inside the source directory: ${opts.mainTex}`);
  }
  const merger: Merger = {
    srcRoot,
    byNorm: new Map(),
    fileMap: new WeakMap(),
    files: [],
    fileLines: new Map(),
    warnings: [],
    visiting: [],
  };
  const mainRel = normRel(srcRoot, mainAbs);
  merger.visiting.push(mainRel);
  const root = parseFile(merger, mainAbs);
  root.content = mergeInputs(merger, root.content, mainRel);
  merger.visiting.pop();

  // Bounded macro layer: extract \newcommand/friends, then expand usage
  // sites. Produced nodes inherit the call site's file + position.
  const skippedMacros = new Set<string>();
  const defs = extractMacroDefs(root, merger.warnings, skippedMacros);
  if (defs.size > 0) {
    expandTexMacros(root.content as Ast.Node[], defs, merger.warnings, {
      skipped: skippedMacros,
      tag: (produced, call) => {
        const file = merger.fileMap.get(call);
        const position = (call as { position?: Ast.Node["position"] }).position;
        for (const n of produced) {
          if (file !== undefined) tagTree(n, file, merger.fileMap);
          if (position !== undefined && position !== null) stampPosition(n, position);
        }
      },
    });
  }

  const docEnv = documentEnv(root);
  const body: Ast.Node[] =
    docEnv !== undefined && Array.isArray(docEnv.content) ? [...docEnv.content] : [];
  if (docEnv === undefined) {
    merger.warnings.push("no \\begin{document} environment found");
  }
  const docIdx = docEnv !== undefined ? root.content.indexOf(docEnv) : root.content.length;
  const preamble = root.content.slice(0, Math.max(docIdx, 0));

  const tree: TexSourceTree = {
    root,
    body,
    preamble,
    fileOf: (node) => merger.fileMap.get(node),
    files: [...merger.files],
    linesOf: (file) => merger.fileLines.get(file),
    resolveFile: (file) => merger.byNorm.get(file),
    unexpandableMacros: skippedMacros,
    warnings: merger.warnings,
  };
  crossCheckFls(tree, opts.flsInputs);
  return tree;
}

/** Print the raw LaTeX of a node list. */
export function printRawNodes(nodes: readonly Ast.Node[]): string {
  return printRaw(nodes as never);
}

/** Raw LaTeX of one node. */
export function printRawNode(node: Ast.Node): string {
  return printRaw(node as never);
}

/** basename without directory, for messages. */
export function baseName(p: string): string {
  return basename(p);
}
