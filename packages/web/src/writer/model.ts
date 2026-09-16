/**
 * Stage 10 Writer — pure model helpers (React-free for testing).
 *
 * Shared-IR targets when available; source hints while editing are explicitly
 * unresolved. Cell conversion/label insertion remain separate from rendering.
 */

import {
  defaultCellData,
  currentWriterCellPreview,
  parseSimpleCsv,
  serializeCell,
  type CellType,
  type WriterCell,
  type WriterNumberingFacts,
  type WriterNumberingResponse,
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

// Rendering is provided exclusively by shared server IR; no client LaTeX parser.

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
  /** Source heading ordinal within this cell; insertion is after that heading. */
  sectionIndex?: number;
  /** No safe insertion point: require an explicit source label, never guess. */
  insertable?: boolean;
  targetId?: string;
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
      let sectionIndex = 0;
      for (const m of src.matchAll(/\\(?:chapter|section|subsection|subsubsection)\{([^}]+)\}/g)) {
        const near = src.slice((m.index ?? 0) + m[0].length);
        const lm = near.match(/^\s*\\label\{([^}]+)\}/);
        out.push({
          kind: "section",
          number: num("section"),
          title: m[1] ?? "",
          label: lm?.[1] || `sec:${slug(m[1] ?? "")}`,
          cell: c.id,
          generated: !lm,
          sectionIndex: sectionIndex++,
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

// ---- shared IR targets ---------------------------------------------------- //

export function writerCrossrefs(cells: WriterCell[], numbering?: WriterNumberingResponse | null): CrossrefTarget[] {
  const hints = deriveCrossrefs(cells);
  const preview = numbering?.preview;
  if (!preview) return applyNumbering(hints, numbering?.facts ?? null);
  const out: CrossrefTarget[] = [];
  for (const cell of cells) {
    const sourceHints = hints.filter((h) => h.cell === cell.id);
    const compiled = currentWriterCellPreview(preview, cell);
    if (!compiled) { out.push(...sourceHints.map((h) => ({ ...h, number: "?" }))); continue; }
    let equationIndex = 0;
    const equationFacts = numbering?.facts?.equations.filter((e) => e.cell === cell.id) ?? [];
    const numbered = equationFacts.filter((e) => !e.env.endsWith("*") && e.env !== "displaymath");
    const equationHints = sourceHints.filter((h) => h.kind === "equation");
    let numberedIndex = 0;
    for (const item of compiled.items) {
      const block = item.kind === "block" ? item.block : null;
      if (block && (block.type === "paragraph" || block.type === "list" || block.type === "algorithm")) continue;
      const kind = item.kind === "heading" ? "section" : block!.type as CrossrefTarget["kind"];
      const id = item.kind === "heading" ? item.id : block!.id;
      const label = preview.targetLabels[id] ?? "";
      const number = (kind === "equation" && label ? numbering?.facts?.labels[label] : undefined) ?? (item.kind === "heading" ? item.number : "number" in block! ? block!.number : undefined);
      let title = item.kind === "heading" ? item.heading : label || `${kind} ${number ?? ""}`;
      const matches = sourceHints.filter((h) => h.kind === kind && (label ? h.label === label : h.title === title));
      let hint = matches.length === 1 ? matches[0] : undefined;
      if (kind === "equation") {
        const fact = equationFacts[equationIndex++];
        if (fact && !fact.env.endsWith("*") && fact.env !== "displaymath") {
          if (!hint && numbered.length === equationHints.length) hint = equationHints[numberedIndex];
          numberedIndex++;
        }
        if (number === undefined && !label) continue;
      }
      if (block && "captionSegments" in block && block.captionSegments?.length) title = block.captionSegments.map((s) => s.type === "text" ? s.text : s.type === "math" ? s.latex : s.raw ?? "").join("");
      out.push({ kind, targetId: id, cell: cell.id, number: number ?? "", title, label: label || hint?.label || "", generated: !label,
        ...(hint?.envIndex !== undefined ? { envIndex: hint.envIndex } : {}),
        ...(hint?.sectionIndex !== undefined ? { sectionIndex: hint.sectionIndex } : {}),
        insertable: Boolean(label || hint || cell.type === "figure" || cell.type === "table" || cell.type === "code"),
      });
    }
  }
  return out;
}

// ---- legacy numbering adapter for source hints ---------------------------- //

/**
 * Merge compile-truth numbering facts into the regex-derived crossref targets.
 * Pure: no facts → unchanged (instant preview); with facts, sections and
 * equations get their true printed numbers and real labels.
 */
export function applyNumbering(
  targets: CrossrefTarget[],
  facts: WriterNumberingFacts | null,
): CrossrefTarget[] {
  const out = targets.map((t) => ({ ...t, number: "?" }));
  if (!facts) return out;

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
    const sec = cellSections.find((s) => (!t.generated && s.label === t.label) || s.title === t.title) ?? cellSections[idx];
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
    if (e.cell === null || e.env.endsWith("*") || e.env === "displaymath") continue;
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

  for (const t of out) {
    if (t.kind !== "figure" && t.kind !== "table" && t.kind !== "code") continue;
    const compiled = facts.floats?.find((f) => f.cell === t.cell && f.kind === t.kind);
    t.number = compiled?.number ?? facts.labels[t.label] ?? "?";
  }
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
export function withEnsuredLabel(cell: WriterCell, label: string, envIndex?: number, sectionIndex?: number): WriterCell {
  const d = cell.data as Record<string, unknown>;
  if (cell.type === "latex") {
    const src = (d.source as string) ?? "";
    if (sectionIndex !== undefined) {
      const headings = [...src.matchAll(/\\(?:chapter|section|subsection|subsubsection)\{([^}]+)\}/g)];
      const heading = headings[sectionIndex];
      if (!heading) return cell;
      const at = (heading.index ?? 0) + heading[0].length;
      if (/^\s*\\label\{/.test(src.slice(at))) return cell;
      return { ...cell, data: { ...cell.data, source: `${src.slice(0, at)}\\label{${label}}${src.slice(at)}` } } as WriterCell;
    } else if (envIndex !== undefined) {
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
