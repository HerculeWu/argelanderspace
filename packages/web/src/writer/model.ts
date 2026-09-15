/**
 * Stage 10 Writer — pure model helpers (React-free for testing).
 *
 * Ports the prototype's derivation logic: crossref targets + numbering,
 * the heuristic LaTeX preview segmentation (sections/cites/xrefs plus math
 * — KaTeX-rendered since the 2026-09-15 UI review; no full LaTeX rendering),
 * cell type conversion (lossy is intended, consensus D8), and label
 * auto-completion.
 */

import {
  defaultCellData,
  parseSimpleCsv,
  serializeCell,
  type CellType,
  type WriterCell,
  type WriterNumberingFacts,
} from "@argelanderspace/contracts";

// ---- ids (web-side mirror of the M2 core generators) ----------------------- //

function hex8(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newManuscriptId(): string {
  return `m_${hex8()}`;
}
export function newCellId(): string {
  return `c_${hex8()}`;
}
export function newCommentId(): string {
  return `cm_${hex8()}`;
}

// ---- misc ------------------------------------------------------------------ //

/** Prototype slug(): label-friendly slug of a section title. */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 42) || "section"
  );
}

/** Slug for the exported .tex filename. */
export function fileSlug(title: string): string {
  return slug(title) === "section" && !title.trim() ? "manuscript" : slug(title);
}

export { parseSimpleCsv };

// ---- heuristic LaTeX preview (prototype renderFor 'latex') ----------------- //

export type InlineSeg =
  | { kind: "text"; text: string }
  | { kind: "cite"; text: string }
  | { kind: "xref"; text: string }
  | { kind: "math"; tex: string };

export type LatexBlock =
  | { kind: "section" | "subsection" | "para"; segments: InlineSeg[] }
  | { kind: "math"; tex: string };

const SECTION_RE = /\\(section|subsection)\{([^}]*)\}/;
// cite / xref (incl. \eqref) / \(…\) inline math / $…$ inline math (not $$, not \$).
const INLINE_RE =
  /\\cite[a-zA-Z]*\{([^}]*)\}|\\(?:eq|auto)?ref\{([^}]*)\}|\\\(([\s\S]+?)\\\)|(?<![\\$])\$([^$\n]+?)(?<!\\)\$(?!\$)/g;
// Display math: numbered/unnumbered amsmath environments, $$…$$, \[…\].
const DISPLAY_ENV_RE =
  /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?|displaymath)\}([\s\S]*?)\\end\{\1\}|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;

/**
 * Convert a display-math environment body into something KaTeX renders:
 * KaTeX knows no equation/align/multline environments, so map to the
 * supported gathered/aligned forms (eqnarray's `&&` collapses to `&`).
 * `\label`/\tag are stripped by cleanLatex at render time.
 */
export function kaTeXifyDisplay(env: string | null, body: string): string {
  const b = body.trim();
  switch (env) {
    case "align":
    case "align*":
      return `\\begin{aligned}${b}\\end{aligned}`;
    case "gather":
    case "gather*":
    case "multline":
    case "multline*":
      return `\\begin{gathered}${b}\\end{gathered}`;
    case "eqnarray":
    case "eqnarray*":
      return `\\begin{aligned}${b.replace(/&&/g, "&")}\\end{aligned}`;
    default:
      return b;
  }
}

/** Split paragraph text into text/cite/xref/math segments; \label{…} is hidden. */
export function inlineSegs(text: string): InlineSeg[] {
  const clean = text.replace(/\\label\{[^}]*\}/g, "");
  const out: InlineSeg[] = [];
  let last = 0;
  for (const m of clean.matchAll(INLINE_RE)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ kind: "text", text: clean.slice(last, i) });
    if (m[1] !== undefined) out.push({ kind: "cite", text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "xref", text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: "math", tex: m[3] });
    else if (m[4] !== undefined) out.push({ kind: "math", tex: m[4] });
    last = i + m[0].length;
  }
  if (last < clean.length) out.push({ kind: "text", text: clean.slice(last) });
  return out.filter((s) => s.kind !== "text" || s.text !== "");
}

/**
 * Segment a latex cell's source into heading/paragraph/display-math blocks.
 * Mirrors the prototype: blank-line chunks, \section → h2, \subsection → h3,
 * single newlines inside a paragraph collapse to spaces. Display math
 * (amsmath envs / $$…$$ / \[…\]) becomes its own KaTeX block anywhere in a
 * chunk; surrounding text keeps the paragraph pipeline.
 */
export function latexBlocks(source: string): LatexBlock[] {
  const out: LatexBlock[] = [];
  for (const raw of source.split(/\n\s*\n/)) {
    if (!raw.trim()) continue;
    // split the chunk into text runs and display-math matches, in order
    let last = 0;
    const flushText = (text: string) => {
      let rest = text;
      const pushPara = (t: string) => {
        const segments = inlineSegs(t.replace(/\n/g, " ").trim());
        if (segments.length > 0) out.push({ kind: "para", segments });
      };
      while (rest.trim()) {
        const m = rest.match(SECTION_RE);
        if (!m || m.index === undefined) {
          pushPara(rest);
          break;
        }
        const before = rest.slice(0, m.index);
        if (before.trim()) pushPara(before);
        out.push({
          kind: m[1] === "subsection" ? "subsection" : "section",
          segments: inlineSegs(m[2] ?? ""),
        });
        rest = rest.slice(m.index + m[0].length);
      }
    };
    for (const m of raw.matchAll(DISPLAY_ENV_RE)) {
      const i = m.index ?? 0;
      flushText(raw.slice(last, i));
      const tex =
        m[1] !== undefined
          ? kaTeXifyDisplay(m[1], m[2] ?? "")
          : (m[3] ?? m[4] ?? "").trim();
      if (tex) out.push({ kind: "math", tex });
      last = i + m[0].length;
    }
    flushText(raw.slice(last));
  }
  return out;
}

// ---- crossref targets (prototype crossrefs()) ------------------------------ //

export interface CrossrefTarget {
  kind: "section" | "equation" | "figure" | "table" | "code";
  number: string;
  title: string;
  label: string;
  cell: string;
  /** Label was synthesized (sec:<slug> / eq:<n>) because the source has none. */
  generated: boolean;
  /** For equations: which numbered env inside the cell (0-based), for label insertion. */
  envIndex?: number;
}

const KIND_ORDER: CrossrefTarget["kind"][] = ["section", "equation", "figure", "table", "code"];

/** Numbered display-math environments (starred variants are unnumbered in LaTeX). */
const NUMBERED_ENV_RE = /\\begin\{(equation|align|gather|multline|eqnarray)\}([\s\S]*?)\\end\{\1\}/g;

export function deriveCrossrefs(cells: WriterCell[]): CrossrefTarget[] {
  const out: CrossrefTarget[] = [];
  const num = (kind: CrossrefTarget["kind"]) =>
    String(out.filter((x) => x.kind === kind).length + 1);
  for (const c of cells) {
    const d = c.data as Record<string, unknown>;
    if (c.type === "latex") {
      const src = (d.source as string) ?? "";
      const m = src.match(/\\section\{([^}]+)\}/);
      if (m) {
        // bind a \label on the \section line or the next line only — never a
        // far-away one (a chapter/equation label elsewhere in the cell is not
        // this section's; regex is the fallback path, compile is the truth).
        const at = m.index ?? 0;
        const lineEnd = src.indexOf("\n", at);
        const nextEnd = lineEnd < 0 ? -1 : src.indexOf("\n", lineEnd + 1);
        const near = src.slice(at, nextEnd < 0 ? undefined : nextEnd + 1);
        const lm = near.match(/\\label\{([^}]+)\}/);
        out.push({
          kind: "section",
          number: num("section"),
          title: m[1] ?? "",
          label: lm?.[1] || `sec:${slug(m[1] ?? "")}`,
          cell: c.id,
          generated: !lm,
        });
      }
      // equations: each numbered env block is one target (align multi-row
      // numbering is approximated per block — documented simplification).
      let envIndex = 0;
      for (const em of src.matchAll(NUMBERED_ENV_RE)) {
        const lm = [...(em[2] ?? "").matchAll(/\\label\{([^}]+)\}/g)];
        const number = num("equation");
        out.push({
          kind: "equation",
          number,
          title: lm[0]?.[1] || `(${number})`,
          label: lm[0]?.[1] || `eq:${number}`,
          cell: c.id,
          generated: !lm[0],
          envIndex: envIndex++,
        });
      }
    } else if (c.type === "figure") {
      out.push({
        kind: "figure",
        number: num("figure"),
        title: (d.caption as string) || "Figure",
        label: (d.label as string) || "",
        cell: c.id,
        generated: false,
      });
    } else if (c.type === "table") {
      out.push({
        kind: "table",
        number: num("table"),
        title: (d.caption as string) || "Table",
        label: (d.label as string) || "",
        cell: c.id,
        generated: false,
      });
    } else if (c.type === "code") {
      out.push({
        kind: "code",
        number: num("code"),
        title: (d.caption as string) || "Listing",
        label: (d.label as string) || "",
        cell: c.id,
        generated: false,
      });
    }
  }
  return out;
}

/** Position of `cellId` among same-kind float cells (1-based), for captions. */
export function floatNumber(cells: WriterCell[], cellId: string): number {
  const cell = cells.find((c) => c.id === cellId);
  if (!cell) return 0;
  return cells.filter((c) => c.type === cell.type).findIndex((c) => c.id === cellId) + 1;
}

export { KIND_ORDER };

// ---- numbering merge (D14: compile truth overrides the regex preview) ----- //

/**
 * Merge compile-truth numbering facts into the regex-derived crossref targets.
 * Pure: no facts → unchanged (instant preview); with facts, sections and
 * equations get their true printed numbers and real labels.
 */
export function applyNumbering(
  targets: CrossrefTarget[],
  facts: WriterNumberingFacts | null,
): CrossrefTarget[] {
  if (!facts) return targets;
  const out = targets.map((t) => ({ ...t }));

  // sections: match by cell + order within that cell
  const sectionsByCell = new Map<string, WriterNumberingFacts["sections"]>();
  for (const s of facts.sections) {
    if (s.cell === null) continue;
    const arr = sectionsByCell.get(s.cell) ?? [];
    arr.push(s);
    sectionsByCell.set(s.cell, arr);
  }
  const secCursor = new Map<string, number>();
  for (const t of out) {
    if (t.kind !== "section") continue;
    const cellSections = sectionsByCell.get(t.cell);
    if (!cellSections) continue;
    const idx = secCursor.get(t.cell) ?? 0;
    const sec = cellSections[idx];
    if (!sec) continue;
    secCursor.set(t.cell, idx + 1);
    t.number = sec.number;
    if (t.generated && sec.label) {
      t.label = sec.label;
      t.generated = false;
    }
  }

  // equations: match by cell + envIndex
  const eqByCell = new Map<string, WriterNumberingFacts["equations"]>();
  for (const e of facts.equations) {
    if (e.cell === null) continue;
    const arr = eqByCell.get(e.cell) ?? [];
    arr.push(e);
    eqByCell.set(e.cell, arr);
  }
  for (const t of out) {
    if (t.kind !== "equation") continue;
    const cellEqs = eqByCell.get(t.cell);
    if (!cellEqs) continue;
    const eq = t.envIndex !== undefined ? cellEqs[t.envIndex] : undefined;
    if (!eq) continue;
    t.number = eq.number;
    // real label: prefer the compiled env label; a target that already had a
    // real label keeps aux truth (labels[key] wins over the event label).
    const auxNumber = t.generated ? undefined : facts.labels[t.label];
    if (auxNumber !== undefined) t.number = auxNumber;
    if (t.generated && eq.label) {
      t.label = eq.label;
      t.generated = false;
    }
  }

  // figure/table/code: cell order is already truth (no compile needed).
  return out;
}


// ---- cell conversion (prototype convertCell; lossy is intended) ------------ //

/**
 * New `data` when a cell changes type: → latex keeps the serialized source;
 * → anything else resets to that type's defaults (converting back does NOT
 * restore the old content — prototype behavior, consensus D8).
 */
export function convertCellData(cell: WriterCell, type: CellType): Record<string, unknown> {
  if (type === cell.type) return { ...cell.data };
  if (type === "latex") return { source: serializeCell(cell) };
  return defaultCellData(type);
}

// ---- label auto-completion (prototype ensureTargetLabel) ------------------- //

/**
 * Return the cell with a label guaranteed: equation targets gain a
 * `\label{…}` right after their env's `\begin{…}` line (a trailing append
 * would label the section, not the equation); label-less section cells gain
 * a trailing `\label`; figure/table/code fill `data.label`. Other types are
 * returned unchanged.
 */
export function withEnsuredLabel(cell: WriterCell, label: string, envIndex?: number): WriterCell {
  const d = cell.data as Record<string, unknown>;
  if (cell.type === "latex") {
    const src = (d.source as string) ?? "";
    if (envIndex !== undefined) {
      let i = 0;
      for (const m of src.matchAll(NUMBERED_ENV_RE)) {
        if (i === envIndex) {
          if (/\\label\{[^}]+\}/.test(m[2] ?? "")) return cell;
          const at = (m.index ?? 0) + m[0].indexOf("}", 7) + 1; // end of \begin{env}
          const next = `${src.slice(0, at)}\n  \\label{${label}}${src.slice(at)}`;
          return { ...cell, data: { ...cell.data, source: next } } as WriterCell;
        }
        i++;
      }
      return cell;
    }
    if (/\\label\{[^}]+\}/.test(src)) return cell;
    return { ...cell, data: { ...cell.data, source: `${src}\n\\label{${label}}` } } as WriterCell;
  }
  if (cell.type === "figure" || cell.type === "table" || cell.type === "code") {
    if ((d.label as string) || "") return cell;
    return { ...cell, data: { ...cell.data, label } } as WriterCell;
  }
  return cell;
}

/** Random fallback label (prototype `ref:` + 6 base36 chars). */
export function randomLabel(): string {
  return `ref:${Math.random().toString(36).slice(2, 8)}`;
}
