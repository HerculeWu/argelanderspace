/**
 * Port of `bibgraph/ingest_html/inline.py`: turn a run of inline publisher HTML
 * into body text + occurrence records.
 *
 * Citation / cross-reference anchors (`<a href="#R26">`, `<a href="#F1">`) are
 * tokenised *authoritatively* — the fragment says exactly which reference/float
 * they point at — recording their character span so the pipeline can splice
 * `[[cite:..]]` / `[[xref:..]]` tokens and run the regex detector only as a
 * fallback for *unlinked* mentions. Clear inline math (sub/sup + single-letter
 * variables) is rendered into `$…$` KaTeX fragments, conservatively.
 *
 * The DOM walk runs on cheerio/domhandler nodes (see dom.ts). The pandoc-backed
 * MathML → LaTeX conversion arrives via the injected {@link HtmlMathmlPort} on
 * the context (Python imports it lazily inside `_inline_math_latex`).
 */

import type { CitationOccurrence, CrossRefOccurrence } from "@argelanderspace/contracts";
import { type AnyNode, type Element, hasChildren, isTag } from "domhandler";
import type { Match } from "../../documents/annotate.js";
import { classList, getAttr, getText } from "./dom.js";
import { stripMathDelims } from "./mathml.js";
import type { HtmlMathmlPort } from "./ports.js";
import { bs4OuterHtml } from "./serialize.js";

// --------------------------------------------------------------------------- //
// Tables and regexes (verbatim from inline.py)
// --------------------------------------------------------------------------- //

// A single math variable: one latin/greek letter (optionally primed). The range
// covers Greek + Greek-extended incl. variant glyphs (ϵ U+03F5, ϕ U+03D5, …).
const VAR_RE = /^[A-Za-zͰ-Ͽἀ-῿](?:['′])?$/u;
// A trailing token usable as a sub/sup base in surrounding plain text.
const BASE_RE = /([A-Za-z]+|\d+(?:\.\d+)?)$/;
const MULTI_ALPHA_RE = /^[A-Za-z]{2,}$/;
const GREEK: Record<string, string> = {
  α: "\\alpha",
  β: "\\beta",
  γ: "\\gamma",
  δ: "\\delta",
  ε: "\\epsilon",
  ζ: "\\zeta",
  η: "\\eta",
  θ: "\\theta",
  ι: "\\iota",
  κ: "\\kappa",
  λ: "\\lambda",
  μ: "\\mu",
  ν: "\\nu",
  ξ: "\\xi",
  π: "\\pi",
  ρ: "\\rho",
  σ: "\\sigma",
  ς: "\\varsigma",
  τ: "\\tau",
  υ: "\\upsilon",
  φ: "\\phi",
  χ: "\\chi",
  ψ: "\\psi",
  ω: "\\omega",
  Γ: "\\Gamma",
  Δ: "\\Delta",
  Θ: "\\Theta",
  Λ: "\\Lambda",
  Π: "\\Pi",
  Σ: "\\Sigma",
  Φ: "\\Phi",
  Ψ: "\\Psi",
  Ω: "\\Omega",
  // variant glyphs (Greek-extended block, used in scientific typography)
  ϵ: "\\epsilon",
  ϕ: "\\phi",
  ϑ: "\\vartheta",
  ϖ: "\\varpi",
  ϱ: "\\varrho",
  ϐ: "\\beta",
  ϰ: "\\varkappa",
};

/** Collapse runs of any whitespace (incl. NBSP) to a single ASCII space. */
function normWs(s: string): string {
  return s.replaceAll("\u00a0", " ").replaceAll("\u2009", " ").replace(/\s+/gu, " ");
}

// Unicode math symbols KaTeX can't render in text mode -> LaTeX commands.
const MATH_UNICODE: ReadonlyArray<readonly [string, string]> = [
  ["‖", "\\Vert "],
  ["×", "\\times "],
  ["·", "\\cdot "],
  ["−", "-"],
  ["∼", "\\sim "],
  ["≈", "\\approx "],
  ["≃", "\\simeq "],
  ["≤", "\\le "],
  ["≥", "\\ge "],
  ["≪", "\\ll "],
  ["≫", "\\gg "],
  ["≠", "\\ne "],
  ["⊙", "\\odot "],
  ["⊕", "\\oplus "],
  ["∘", "\\circ "],
  ["°", "^{\\circ}"],
  ["±", "\\pm "],
  ["∓", "\\mp "],
  ["→", "\\to "],
  ["∞", "\\infty "],
  ["∝", "\\propto "],
  ["⟨", "\\langle "],
  ["⟩", "\\rangle "],
  ["′", "'"],
  ["″", "''"],
  ["…", "\\dots "],
  ["⋆", "\\star "],
  ["∥", "\\parallel "],
  ["⊥", "\\perp "],
];

/** Make a math snippet safe for KaTeX: escape comment/special chars and map
 *  unicode operators that have no text-mode glyph. */
function sanitizeMath(s0: string): string {
  let s = s0;
  for (const [u, tex] of MATH_UNICODE) {
    s = s.replaceAll(u, tex);
  }
  s = s.replace(/(?<!\\)%/g, "\\%"); // % starts a LaTeX comment otherwise
  s = s.replace(/(?<!\\)#/g, "\\#");
  return s.replace(/\s{2,}/gu, " ").trim();
}

// --------------------------------------------------------------------------- //
// Public types
// --------------------------------------------------------------------------- //

/** How an in-text `<a href="#..">` should be treated. */
export interface AnchorTarget {
  /** cite | xref | footnote | external | ignore */
  role: string;
  /** for cite */
  refId?: string;
  /** for xref */
  targetId?: string;
  /** figure|table|equation|section|appendix */
  xrefKind?: string;
}

export interface InlineContext {
  /** fragment ("R26"/"F1"/"FD1"/"S7"/"APP1"/"FN4") → AnchorTarget | undefined. */
  resolve: (frag: string) => AnchorTarget | undefined;
  inlineMath?: string;
  /** pandoc-backed MathML → LaTeX (preferred over data-latex when available). */
  mathml?: HtmlMathmlPort;
}

// --------------------------------------------------------------------------- //
// Flatten the inline DOM into a list of atoms
// --------------------------------------------------------------------------- //

interface Atom {
  /** text | var | sub | sup | math | anchor */
  t: string;
  /** text / latex / visible text */
  s: string;
  /** sub/sup: plain inner text (used when not mathified) */
  raw: string;
  role?: string;
  refId?: string;
  targetId?: string;
  xrefKind?: string;
}

function atom(t: string, s = "", raw = ""): Atom {
  return { t, s, raw };
}

function fragOf(href: string): string | undefined {
  if (!href) return undefined;
  const i = href.indexOf("#");
  return i >= 0 ? href.slice(i + 1) : undefined;
}

/** A <sup>/<sub> whose only real content is a footnote anchor. */
function isFootnoteSup(el: Element): boolean {
  const links = descendantsOf(el).filter((d) => d.name === "a");
  if (links.length === 0) return false;
  return links.every((a) => {
    const f = fragOf(getAttr(a, "href") ?? "") ?? "";
    const up = f.toUpperCase();
    return up.startsWith("FN") || up.startsWith("EN");
  });
}

function descendantsOf(el: Element): Element[] {
  const out: Element[] = [];
  const walk = (n: AnyNode): void => {
    if (!hasChildren(n)) return;
    for (const c of n.children) {
      if (isTag(c)) {
        out.push(c);
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}

/** Render the inside of a sub/sup to a latex-ish snippet (no $). */
function innerLatex(el: Element): string {
  let txt = getText(el).trim();
  txt = GREEK[txt] ?? txt;
  txt = txt.replaceAll("\u00a0", "").replaceAll(" ", "");
  txt = sanitizeMath(txt);
  if (MULTI_ALPHA_RE.test(txt)) return `\\mathrm{${txt}}`;
  return txt;
}

function varLatex(s: string): string {
  return sanitizeMath(GREEK[s] ?? s);
}

/** LaTeX for an inline formula span: prefer pandoc(MathML) (KaTeX-clean),
 *  else the (sanitised) `data-latex` attribute. */
function inlineMathLatex(el: Element, ctx: InlineContext): string {
  const math = descendantsOf(el).find((d) => d.name === "math");
  if (math && ctx.mathml) {
    const tex = ctx.mathml.mathmlToLatex(bs4OuterHtml(math));
    if (tex) return tex;
  }
  const dl = getAttr(el, "data-latex");
  return dl ? sanitizeMath(stripMathDelims(dl)) : "";
}

function flatten(node: Element, ctx: InlineContext, atoms: Atom[]): void {
  for (const child of node.children ?? []) {
    flattenChild(child, ctx, atoms);
  }
}

function flattenChild(child: AnyNode, ctx: InlineContext, atoms: Atom[]): void {
  if (child.type === "text") {
    atoms.push(atom("text", child.data));
    return;
  }
  if (!isTag(child)) return;
  const name = child.name.toLowerCase();
  const classes = classList(child);

  if (name === "a") {
    flattenAnchor(child, ctx, atoms);
    return;
  }
  if (name === "sub" || name === "sup") {
    if (isFootnoteSup(child)) return; // drop footnote markers
    const raw = getText(child).replace(/\s+/gu, ""); // plain fallback form
    atoms.push({ t: name, s: innerLatex(child), raw });
    return;
  }
  if (name === "i" || name === "var") {
    const inner = getText(child);
    const stripped = inner.trim();
    if ((ctx.inlineMath ?? "conservative") !== "plain" && VAR_RE.test(stripped)) {
      atoms.push(atom("var", varLatex(stripped)));
    } else {
      atoms.push(atom("text", inner)); // prose italics -> plain
    }
    return;
  }
  if (name === "br") {
    atoms.push(atom("text", " "));
    return;
  }
  if (name === "script" || name === "style") {
    return;
  }
  // Inline formula span (data-latex). Block equations (ressouce-equation-block)
  // are handled as standalone EquationBlocks by the adapter and never reach here.
  if (getAttr(child, "data-latex") && !classes.includes("ressouce-equation-block")) {
    if ((ctx.inlineMath ?? "conservative") !== "plain") {
      const latex = inlineMathLatex(child, ctx);
      if (latex) atoms.push(atom("math", latex));
    }
    return;
  }
  // everything else: recurse so we never drop its text
  flatten(child, ctx, atoms);
}

function flattenAnchor(a: Element, ctx: InlineContext, atoms: Atom[]): void {
  const visible = getText(a);
  const frag = fragOf(getAttr(a, "href") ?? "");
  if (!visible.trim()) return; // empty back-ref anchor
  const tgt = frag ? ctx.resolve(frag) : undefined;
  if (!tgt) {
    atoms.push(atom("text", visible)); // external/unknown: text only
    return;
  }
  if (tgt.role === "cite") {
    atoms.push({ t: "anchor", s: visible, raw: "", role: "cite", refId: tgt.refId });
  } else if (tgt.role === "xref") {
    atoms.push({
      t: "anchor",
      s: visible,
      raw: "",
      role: "xref",
      targetId: tgt.targetId,
      xrefKind: tgt.xrefKind,
    });
  } else if (tgt.role === "footnote" || tgt.role === "ignore") {
    return;
  } else {
    atoms.push(atom("text", visible));
  }
}

// --------------------------------------------------------------------------- //
// Assemble atoms -> (text, anchor matches)
// --------------------------------------------------------------------------- //

interface Seg {
  /** plain | math | anchor */
  kind: string;
  s: string;
  atom?: Atom;
}

function emitPlain(segs: Seg[], s: string): void {
  if (!s) return;
  const last = segs[segs.length - 1];
  if (last && last.kind === "plain") {
    last.s += s;
  } else {
    segs.push({ kind: "plain", s });
  }
}

const PY_ALNUM_RE = /[\p{L}\p{N}]/u;

/** Attach a sub/sup atom to a base, mutating `segs` (see inline.py docstring:
 *  a sub/sup on an explicit math base is always attached; pulling a base out of
 *  surrounding plain prose only at a word boundary, else keep the plain text). */
function attachSubsup(segs: Seg[], a: Atom, plainBaseOk: boolean): void {
  if (!a.s) return;
  const op = a.t === "sub" ? "_" : "^";
  const frag = `${op}{${a.s}}`;
  const last = segs[segs.length - 1];
  if (last && last.kind === "math") {
    last.s += frag;
    return;
  }
  if (plainBaseOk && last?.kind === "plain") {
    const m = BASE_RE.exec(last.s);
    if (m?.[0] && last.s.endsWith(m[0])) {
      const base = m[0];
      last.s = last.s.slice(0, last.s.length - base.length);
      if (!last.s) segs.pop();
      const blatex = MULTI_ALPHA_RE.test(base) ? `\\mathrm{${base}}` : base;
      segs.push({ kind: "math", s: blatex + frag });
      return;
    }
  }
  // no usable base / mid-word: keep the sub/sup's *plain* text, no math.
  emitPlain(segs, a.raw || a.s);
}

/**
 * Render an inline-bearing element to `{text, matches}`.
 * `node` is an element (its children are walked) or a list of sibling nodes
 * (used when a paragraph is split around block equations).
 */
export function renderInline(
  node: Element | AnyNode[],
  ctx: InlineContext
): { text: string; matches: Match[] } {
  const atoms: Atom[] = [];
  if (Array.isArray(node)) {
    for (const n of node) flattenChild(n, ctx, atoms);
  } else {
    flatten(node, ctx, atoms);
  }

  const segs: Seg[] = [];
  for (const [i, a] of atoms.entries()) {
    if (a.t === "text") {
      emitPlain(segs, a.s);
    } else if (a.t === "var") {
      const last = segs[segs.length - 1];
      if (last && last.kind === "math") {
        last.s += a.s; // adjacent vars coalesce
      } else {
        segs.push({ kind: "math", s: a.s });
      }
    } else if (a.t === "math") {
      segs.push({ kind: "math", s: a.s });
    } else if (a.t === "sub" || a.t === "sup") {
      // Only pull a base out of plain prose at a word boundary: if the very
      // next atom is text that begins with an alnum char it would join the
      // base mid-word, so leave the sub/sup as plain text instead.
      const nxt = i + 1 < atoms.length ? atoms[i + 1] : undefined;
      const plainBaseOk = !(
        nxt &&
        nxt.t === "text" &&
        nxt.s.length > 0 &&
        PY_ALNUM_RE.test(nxt.s[0] ?? "")
      );
      attachSubsup(segs, a, plainBaseOk);
    } else if (a.t === "anchor") {
      segs.push({ kind: "anchor", s: a.s, atom: a });
    }
  }

  // Assemble. Whitespace is squeezed *per piece* as we go so the recorded
  // anchor spans stay exact (no second pass / position re-derivation needed).
  const out: string[] = [];
  let matches: Match[] = [];
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
      // anchor
      const visible = normWs(seg.s).trim();
      if (!visible) continue;
      const start = emit(visible);
      matches.push({ start, end: pos, occ: anchorOcc(seg.atom as Atom, visible) });
    }
  }

  let text = out.join("");
  const lstripped = text.trimStart();
  const lstrip = text.length - lstripped.length;
  if (lstrip > 0) {
    text = lstripped;
    matches = matches.map((m) => ({ ...m, start: m.start - lstrip, end: m.end - lstrip }));
  }
  text = text.trimEnd();
  matches = matches.filter((m) => m.start >= 0 && m.start < m.end && m.end <= text.length);
  return { text, matches };
}

function anchorOcc(a: Atom, visible: string): CitationOccurrence | CrossRefOccurrence {
  if (a.role === "cite") {
    return {
      ref_ids: a.refId ? [a.refId] : [],
      raw: visible,
      via: "hyperlink",
      resolved: Boolean(a.refId),
    };
  }
  return {
    kind: (a.xrefKind || "unknown") as CrossRefOccurrence["kind"],
    raw: visible,
    target_id: a.targetId,
    via: "hyperlink",
    resolved: Boolean(a.targetId),
  };
}

/** Plain-text rendering of a node (inline.py `plain_text`). */
export function plainText(node: Element): string {
  return normWs(getText(node)).trim();
}
