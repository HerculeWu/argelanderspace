/**
 * Writer cell semantics shared by the Writer page and the Copilot `writer` tool (copilot ticket 23): the lossy type
 * conversion, the label completion, the label inventory and the safety review of text an agent writes into a
 * manuscript. The page and the service call the same functions, so an edit means the same thing from either side.
 */
import { z } from "zod";
import {
  CellPlacementSchema,
  type CellType,
  defaultCellData,
  serializeCell,
  type WriterCell,
} from "./writer.js";

// ---- conversion and label completion (moved from the web model; the page re-exports them) ------------------ //

/** Numbered display-math environments (starred variants are unnumbered in LaTeX). */
export const NUMBERED_ENV_RE =
  /\\begin\{(equation|align|gather|multline|eqnarray)\}([\s\S]*?)\\end\{\1\}/g;

/**
 * New `data` when a cell changes type: to latex keeps the serialized source; to anything else resets to that type's
 * defaults (converting back does NOT restore the old content, consensus D8).
 */
export function convertCellData(cell: WriterCell, type: CellType): Record<string, unknown> {
  if (type === cell.type) return { ...cell.data };
  if (type === "latex") return { source: serializeCell(cell) };
  return defaultCellData(type);
}

/**
 * The cell with a label guaranteed: equation targets gain a `\label{...}` right after their env's `\begin{...}` line
 * (a trailing append would label the section, not the equation); label-less section cells gain a trailing `\label`;
 * figure/table/code fill `data.label`. Other types are returned unchanged.
 */
export function withEnsuredLabel(
  cell: WriterCell,
  label: string,
  envIndex?: number,
  sectionIndex?: number
): WriterCell {
  const d = cell.data as Record<string, unknown>;
  if (cell.type === "latex") {
    const src = (d.source as string) ?? "";
    if (sectionIndex !== undefined) {
      const headings = [
        ...src.matchAll(/\\(?:chapter|section|subsection|subsubsection)\{([^}]+)\}/g),
      ];
      const heading = headings[sectionIndex];
      if (!heading) return cell;
      const at = (heading.index ?? 0) + heading[0].length;
      if (/^\s*\\label\{/.test(src.slice(at))) return cell;
      return {
        ...cell,
        data: { ...cell.data, source: `${src.slice(0, at)}\\label{${label}}${src.slice(at)}` },
      } as WriterCell;
    }
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

/** The labels a manuscript's cells define in their source (what the Crossrefs panel can offer), with their cell. */
export function collectLabels(cells: readonly WriterCell[]): { label: string; cell: string }[] {
  const out: { label: string; cell: string }[] = [];
  for (const cell of cells) {
    const d = cell.data as Record<string, unknown>;
    if (cell.type === "figure" || cell.type === "table" || cell.type === "code") {
      const label = typeof d.label === "string" ? d.label : "";
      if (label) out.push({ label, cell: cell.id });
    }
    for (const field of [
      "source",
      "Context",
      "Aims",
      "Methods",
      "Results",
      "Conclusions",
      "caption",
    ]) {
      const text = d[field];
      if (typeof text !== "string") continue;
      for (const match of text.matchAll(/\\label\{([^}]+)\}/g))
        if (match[1]) out.push({ label: match[1], cell: cell.id });
    }
  }
  return out;
}

// ---- the text fields of each cell type an edit may set ------------------------------------------------------ //

const Text = z.string().max(1_000_000);
/** What may stand between the braces of `\label{...}`/`label={...}`: no TeX syntax characters. */
export const SafeLabelSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.\-/]{0,199}$/);
const LabelOrEmpty = z.union([z.literal(""), SafeLabelSchema]);

/** The data fields `update_cell` may set per type; the figure's image is set through `set_figure_image` only. */
const CELL_FIELD_SCHEMAS = {
  latex: z.object({ source: Text }).partial().strict(),
  "abstract-aa": z
    .object({ Context: Text, Aims: Text, Methods: Text, Results: Text, Conclusions: Text })
    .partial()
    .strict(),
  figure: z
    .object({
      caption: Text,
      label: LabelOrEmpty,
      placement: CellPlacementSchema,
      width: z.number().min(35).max(100),
    })
    .partial()
    .strict(),
  table: z
    .object({
      head: Text,
      csv: Text,
      caption: Text,
      label: LabelOrEmpty,
      placement: CellPlacementSchema,
      width: z.number().min(40).max(100),
    })
    .partial()
    .strict(),
  code: z
    .object({
      language: z.string().max(100),
      caption: Text,
      label: LabelOrEmpty,
      lineNumbers: z.boolean(),
      code: Text,
    })
    .partial()
    .strict(),
  ack: z.object({ source: Text }).partial().strict(),
  appendix: z.object({}).strict(),
  recipient: z.object({ name: Text, organization: Text, address: Text }).partial().strict(),
} as const satisfies Record<CellType, z.ZodType>;

/** The fields of a cell's data an agent may name, with the type each takes, for the tool description. */
export const CELL_FIELD_NAMES: Record<CellType, readonly string[]> = {
  latex: ["source"],
  "abstract-aa": ["Context", "Aims", "Methods", "Results", "Conclusions"],
  figure: ["caption", "label", "placement", "width"],
  table: ["head", "csv", "caption", "label", "placement", "width"],
  code: ["language", "caption", "label", "lineNumbers", "code"],
  ack: ["source"],
  appendix: [],
  recipient: ["name", "organization", "address"],
};

export type CellFieldsResult =
  | { ok: true; fields: Record<string, unknown> }
  | { ok: false; detail: string };

/** Validate the fields an agent wants to set on a cell of `type`; only that type's own fields are accepted. */
export function validateCellFields(type: CellType, fields: unknown): CellFieldsResult {
  const parsed = CELL_FIELD_SCHEMAS[type].safeParse(fields);
  if (parsed.success) return { ok: true, fields: parsed.data as Record<string, unknown> };
  const allowed = CELL_FIELD_NAMES[type];
  return {
    ok: false,
    detail: `invalid fields for a ${type} cell (${allowed.length ? `it has: ${allowed.join(", ")}` : "it has no editable fields"}): ${parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "fields"}: ${issue.message}`)
      .join("; ")}`,
  };
}

// ---- safety review of agent-written TeX (spec 14.1) -------------------------------------------------------- //

/**
 * Control words that read a file, write one, run a program or build another control sequence out of text. A
 * manuscript is compiled by the real TeX engine, so text an agent writes into any field that reaches the compiler is
 * screened for them before it is saved. This is a second line: the compile itself runs with paranoid file access (it
 * cannot read an absolute or parent path). The user's own typing in the page is not screened (it is the user's file).
 */
const FORBIDDEN_WORDS = new Set([
  "input",
  "include",
  "includeonly",
  "InputIfFileExists",
  "IfFileExists",
  "openin",
  "openout",
  "read",
  "readline",
  "newread",
  "newwrite",
  "write",
  "immediate",
  "write18",
  "ShellEscape",
  "shellescape",
  "pdfshellescape",
  "csname",
  "scantokens",
  "catcode",
  "directlua",
  "luaexec",
  "VerbatimInput",
  "verbatiminput",
  "lstinputlisting",
  "inputminted",
  "CatchFileDef",
  "CatchFileEdef",
  "CatchFileNoDef",
  "includepdf",
  "openpipe",
]);
/** Packages and environments that read files or run programs for the author. */
const FORBIDDEN_PACKAGES = new Set([
  "catchfile",
  "filecontents",
  "readarray",
  "datatool",
  "csvsimple",
  "pgfplotstable",
  "currfile",
  "import",
  "subfiles",
  "standalone",
  "luacode",
  "shellesc",
  "pythontex",
  "minted",
  "svg",
  "gnuplottex",
  "sagetex",
  "bashful",
  "verbatim",
  "moreverb",
  "fancyvrb",
  "pdfpages",
]);

/** The reasons text may not be written by an agent into the manuscript; empty when it passes. */
export function agentTexViolations(text: string): string[] {
  const found = new Set<string>();
  if (text.includes("^^")) found.add("a ^^ character code (it can spell any control word)");
  for (const match of text.matchAll(/\\([A-Za-z@]+)/g)) {
    const name = (match[1] ?? "").replace(/^@+/, "");
    if (FORBIDDEN_WORDS.has(name))
      found.add(`\\${name} (reads or writes files, runs a program or builds control words)`);
  }
  for (const match of text.matchAll(
    /\\(?:usepackage|RequirePackage|usetikzlibrary)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
  ))
    for (const name of (match[1] ?? "").split(",")) {
      const bare = name.trim().toLowerCase();
      if (FORBIDDEN_PACKAGES.has(bare)) found.add(`package ${bare} (reads files or runs programs)`);
    }
  for (const match of text.matchAll(/\\begin\s*\{(filecontents\*?)\}/g))
    found.add(`environment ${match[1]} (writes files)`);
  return [...found];
}

/** The first problem across named fields, as one sentence for the tool result; null when every field passes. */
export function agentTexProblem(fields: Record<string, string | undefined>): string | null {
  for (const [name, value] of Object.entries(fields)) {
    if (!value) continue;
    const found = agentTexViolations(value);
    if (found.length)
      return `${name} contains ${found.join("; ")}: text written through the Copilot may not read or write files, run programs or hide control words, because the manuscript is compiled by the real TeX engine`;
  }
  return null;
}
