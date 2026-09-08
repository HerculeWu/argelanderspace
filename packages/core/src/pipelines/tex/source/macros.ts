/**
 * Bounded macro-expansion layer (roadmap Q1): extract `\newcommand` /
 * `\renewcommand` / `\providecommand` definitions from the merged source
 * tree and expand them at usage sites.
 *
 * Bounds and degradations (never throws):
 *  - pathological bodies (nested definitions, TeX conditionals, \csname,
 *    \expandafter, \catcode, \global, self-reference) are left raw +
 *    warning;
 *  - names colliding with the pipeline's own structure macros are never
 *    redefined (the .sty instruments the real ones; user redefinitions
 *    would silently change semantics we measure);
 *  - expansion is string-level: `#N` substitution on the raw body text,
 *    then a re-parse — produced nodes inherit the CALL site's position and
 *    file (which is exactly what TeX's \inputlineno reports for a
 *    macro-hidden \cite, so event alignment stays correct);
 *  - at most {@link MAX_EXPANSIONS} expansions and {@link MAX_PASSES}
 *    fixpoint passes; anything left raw afterwards is reported.
 */
import type * as Ast from "@unified-latex/unified-latex-types";
import { printRawNodes, texParser } from "./tree.js";

export const MAX_EXPANSIONS = 2000;
export const MAX_PASSES = 10;

export interface TexMacroDef {
  name: string;
  nargs: number;
  /** Raw text of the optional-argument default (when the def has one). */
  defaultRaw?: string;
  /** Raw body text with `#N` parameter references. */
  bodyRaw: string;
}

/** Commands that make a macro body unsafe for our expansion. */
const UNSAFE_BODY_RE =
  /\\(?:def|gdef|edef|xdef|let|newcommand|renewcommand|providecommand|if[a-zA-Z]*|else|fi|csname|expandafter|catcode|global|loop|repeat)\b/;

/**
 * Names the fuser assigns structure to — a user \renewcommand of one of
 * these would change semantics we also observe through the compile events,
 * so we never expand them.
 */
const PROTECTED_NAMES = new Set([
  "cite",
  "citep",
  "citet",
  "citealp",
  "citealt",
  "citeauthor",
  "citeyear",
  "citeyearpar",
  "ref",
  "eqref",
  "pageref",
  "autoref",
  "cref",
  "Cref",
  "label",
  "section",
  "subsection",
  "subsubsection",
  "caption",
  "includegraphics",
  "documentclass",
  "usepackage",
  "begin",
  "end",
  "item",
  "tag",
  "nonumber",
  "notag",
]);

/** `\newcommand`/friends node → a def, or null when malformed/unsafe. */
function defFromMacro(node: Ast.Macro): { def: TexMacroDef } | { skip: string; name?: string } {
  const args = node.args ?? [];
  const nameNode = args[1]?.content?.[0];
  if (nameNode === undefined || nameNode.type !== "macro" || args[1]?.content.length !== 1) {
    return { skip: `\\${node.content}: name is not a single control sequence` };
  }
  const name = nameNode.content;
  if (PROTECTED_NAMES.has(name)) {
    return { skip: `\\${name}: collides with a structure macro, not expanded`, name };
  }
  const nargsRaw = args[2] !== undefined ? printRawNodes(args[2].content).trim() : "";
  const optRaw = args[3] !== undefined ? printRawNodes(args[3].content).trim() : "";
  const bodyGroup = args[4];
  if (bodyGroup === undefined) return { skip: `\\${name}: missing body` };
  const bodyRaw = printRawNodes(bodyGroup.content);
  let nargs = 0;
  if (nargsRaw !== "") {
    const n = Number.parseInt(nargsRaw.replace(/[[\]\s]/g, ""), 10);
    if (!Number.isInteger(n) || n < 0 || n > 9) {
      return { skip: `\\${name}: bad argument count ${JSON.stringify(nargsRaw)}`, name };
    }
    nargs = n;
  }
  if (UNSAFE_BODY_RE.test(bodyRaw)) {
    return { skip: `\\${name}: body uses TeX constructs we do not expand`, name };
  }
  if (new RegExp(`\\\\${name}(?![a-zA-Z@])`).test(bodyRaw)) {
    return { skip: `\\${name}: self-recursive body`, name };
  }
  const def: TexMacroDef = { name, nargs, bodyRaw };
  if (optRaw !== "") def.defaultRaw = optRaw;
  return { def };
}

/**
 * Extract macro definitions from the whole merged tree (preamble and body;
 * a `\renewcommand` overrides an earlier def of the same name, matching TeX).
 */
export function extractMacroDefs(
  root: Ast.Root,
  warnings: string[],
  skipped?: Set<string>
): Map<string, TexMacroDef> {
  const defs = new Map<string, TexMacroDef>();
  const walk = (nodes: readonly Ast.Node[]): void => {
    for (const node of nodes) {
      if (
        node.type === "macro" &&
        (node.content === "newcommand" ||
          node.content === "renewcommand" ||
          node.content === "providecommand")
      ) {
        const r = defFromMacro(node);
        if ("skip" in r) {
          warnings.push(`macro skipped: ${r.skip}`);
          if (r.name !== undefined) skipped?.add(r.name);
        } else if (node.content === "providecommand" && defs.has(r.def.name)) {
          // \providecommand is a no-op when the macro exists
        } else {
          defs.set(r.def.name, r.def);
        }
      }
      const content = (node as { content?: unknown }).content;
      if (Array.isArray(content) && node.type !== "verbatim") {
        walk(content as Ast.Node[]);
      }
    }
  };
  walk(root.content);
  return defs;
}

// --------------------------------------------------------------------------- //
// Expansion
// --------------------------------------------------------------------------- //

interface ExpansionCtx {
  defs: Map<string, TexMacroDef>;
  warnings: string[];
  expanded: number;
  tag: (produced: Ast.Node[], call: Ast.Node) => void;
  skipped?: Set<string>;
}

function isBraceGroup(node: Ast.Node | undefined): node is Ast.Group {
  return node?.type === "group"; // bare {...} groups only ever carry braces
}

function isSkippableWs(node: Ast.Node): boolean {
  return node.type === "whitespace" || node.type === "comment" || node.type === "parbreak";
}

/** Substitute `#N` args into the raw body and re-parse. */
function substitute(def: TexMacroDef, callArgs: string[]): Ast.Node[] {
  // ## is the doubled-hash escape (nested defs are banned, but stay safe)
  let text = def.bodyRaw.replaceAll("##", "\x00");
  text = text.replace(/#([1-9])/g, (_m, d: string) => callArgs[Number(d) - 1] ?? "");
  text = text.replaceAll("\x00", "#");
  return texParser().parse(text).content as Ast.Node[];
}

/**
 * Scan an optional `[…]` argument starting at `nodes[j]` (a string node
 * whose content starts with "["). Pure — no mutation. Brackets don't nest
 * except inside brace groups. Returns the inner raw text, the index just
 * past the closing "]" node, and any text remainder after "]" inside that
 * node (which must re-enter the stream after the expansion).
 */
function scanBracketArg(
  nodes: Ast.Node[],
  j: number
): { inner: string; nextIndex: number; remainder: Ast.String | null } | null {
  const first = nodes[j];
  if (first?.type !== "string" || !first.content.startsWith("[")) return null;
  let inner = first.content.slice(1);
  const inFirst = inner.indexOf("]");
  if (inFirst !== -1) {
    const rest = inner.slice(inFirst + 1);
    inner = inner.slice(0, inFirst);
    return {
      inner,
      nextIndex: j + 1,
      remainder:
        rest === ""
          ? null
          : ({ type: "string", content: rest, position: first.position } as Ast.String),
    };
  }
  let k = j + 1;
  while (k < nodes.length) {
    const n = nodes[k] as Ast.Node;
    if (n.type === "string" && n.content.includes("]")) {
      const idx = n.content.indexOf("]");
      inner += n.content.slice(0, idx);
      const rest = n.content.slice(idx + 1);
      return {
        inner,
        nextIndex: k + 1,
        remainder:
          rest === ""
            ? null
            : ({ type: "string", content: rest, position: n.position } as Ast.String),
      };
    }
    inner += printRawNodes([n]);
    k++;
  }
  return null; // never closed
}

/** Macro-definition commands: extraction reads them, expansion skips them. */
const DEF_MACROS = new Set(["newcommand", "renewcommand", "providecommand"]);

/** Try to expand one macro call at `nodes[i]` (pure scan — no mutation). */
function expandOne(
  nodes: Ast.Node[],
  i: number,
  ctx: ExpansionCtx
): { consumed: number; produced: Ast.Node[]; trailing: Ast.String | null } | null {
  const node = nodes[i];
  if (node?.type !== "macro") return null;
  const def = ctx.defs.get(node.content);
  if (def === undefined) return null;
  if (ctx.expanded >= MAX_EXPANSIONS) return null;

  const callArgs: string[] = [];
  let trailing: Ast.String | null = null;
  let j = i + 1;
  for (let a = 0; a < def.nargs; a++) {
    while (j < nodes.length && isSkippableWs(nodes[j] as Ast.Node)) j++;
    const next = nodes[j];
    if (a === 0 && def.defaultRaw !== undefined) {
      if (next?.type === "string" && next.content.startsWith("[")) {
        const r = scanBracketArg(nodes, j);
        if (r === null) {
          ctx.warnings.push(`\\${def.name}: unclosed […] optional argument; left raw`);
          ctx.skipped?.add(def.name);
          return null;
        }
        callArgs.push(r.inner);
        trailing = r.remainder;
        j = r.nextIndex;
      } else {
        callArgs.push(def.defaultRaw); // optional arg absent: default, consume nothing
      }
      continue;
    }
    if (!isBraceGroup(next)) {
      // TeX undelimited argument: the next single TOKEN — the first char of
      // a string node (rest re-enters the stream), or one whole macro node.
      if (next === undefined) {
        ctx.warnings.push(
          `\\${def.name}: expected argument ${a + 1} but found end of content; left raw`
        );
        ctx.skipped?.add(def.name);
        return null;
      }
      if (next.type === "string") {
        if (next.content === "") {
          j++;
          continue;
        }
        callArgs.push(next.content[0] ?? "");
        const rest = next.content.slice(1);
        if (rest !== "") {
          trailing = { type: "string", content: rest, position: next.position } as Ast.String;
        }
        j++;
        continue;
      }
      if (next.type === "macro" || next.type === "inlinemath" || next.type === "displaymath") {
        callArgs.push(printRawNodes([next]));
        j++;
        continue;
      }
      ctx.warnings.push(
        `\\${def.name}: expected argument ${a + 1} but found ${next.type}; left raw`
      );
      ctx.skipped?.add(def.name);
      return null;
    }
    callArgs.push(printRawNodes(next.content));
    j++;
  }
  const produced = substitute(def, callArgs);
  ctx.tag(produced, node);
  ctx.expanded++;
  return { consumed: j - i, produced, trailing };
}

function expandPass(nodes: Ast.Node[], ctx: ExpansionCtx): { nodes: Ast.Node[]; changed: boolean } {
  const out: Ast.Node[] = [];
  let changed = false;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as Ast.Node;
    // never expand inside macro DEFINITIONS (the name group holds the defined
    // macro itself, which would self-expand)
    if (node.type === "macro" && DEF_MACROS.has(node.content)) {
      out.push(node);
      continue;
    }
    const content = (node as { content?: unknown }).content;
    if (Array.isArray(content) && node.type !== "verbatim") {
      const sub = expandPass(content as Ast.Node[], ctx);
      if (sub.changed) {
        (node as { content: unknown }).content = sub.nodes;
        changed = true;
      }
    }
    const args = (node as { args?: unknown }).args;
    if (Array.isArray(args)) {
      for (const arg of args as Ast.Argument[]) {
        if (Array.isArray(arg.content)) {
          const sub = expandPass(arg.content as Ast.Node[], ctx);
          if (sub.changed) {
            arg.content = sub.nodes;
            changed = true;
          }
        }
      }
    }
    const r = expandOne(nodes, i, ctx);
    if (r !== null) {
      out.push(...r.produced);
      if (r.trailing !== null) out.push(r.trailing);
      i += r.consumed - 1;
      changed = true;
    } else {
      out.push(node);
    }
  }
  return { nodes: out, changed };
}

export interface ExpandMacrosOptions {
  /** Tag produced nodes with file/position of the call site (see tree.ts). */
  tag?: (produced: Ast.Node[], call: Ast.Node) => void;
  /** Out-set of macro names whose usage sites failed to expand. */
  skipped?: Set<string>;
}

/**
 * Expand registered macros across a content list in place (fixpoint, pass-
 * and expansion-capped). Returns the number of expansions performed.
 */
export function expandTexMacros(
  rootContent: Ast.Node[],
  defs: Map<string, TexMacroDef>,
  warnings: string[],
  opts: ExpandMacrosOptions = {}
): number {
  const ctx: ExpansionCtx = {
    defs,
    warnings,
    expanded: 0,
    tag: opts.tag ?? (() => {}),
    skipped: opts.skipped,
  };
  let content = rootContent;
  let pass = 0;
  let changedLast = false;
  for (; pass < MAX_PASSES; pass++) {
    const r = expandPass(content, ctx);
    content = r.nodes;
    changedLast = r.changed;
    if (!r.changed) break;
  }
  if (ctx.expanded >= MAX_EXPANSIONS) {
    warnings.push(`macro expansion capped at ${MAX_EXPANSIONS} expansions; some calls left raw`);
  }
  if (changedLast && pass >= MAX_PASSES) {
    warnings.push(
      `macro expansion did not reach a fixpoint within ${MAX_PASSES} passes; some calls left raw`
    );
  }
  rootContent.length = 0;
  rootContent.push(...content);
  return ctx.expanded;
}
