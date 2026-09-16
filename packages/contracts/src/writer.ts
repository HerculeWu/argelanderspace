/**
 * Zod schemas and serialization pure functions for the Writer (Stage 10) —
 * the cell-based LaTeX manuscript editor. Consensus: session inbox
 * `.pi/inbox/2026-09-15-stage10-writer-grilling.md` D1–D10; plan
 * `.pi/memory-reference/2026-09-15-stage10-writer-plan.md`.
 *
 * Data model (locked 2026-09-15):
 * - a manuscript is a flat cell list (8 cell types) plus document info
 *   (title/authors/affiliations), a template binding, a user preamble and
 *   per-cell plain-text comments; on disk it is
 *   `<dataDir>/manuscripts/m_<8hex>/manuscript.json` (pretty 2-space,
 *   tmp+rename, `rev` optimistic lock bumped by the server on accepted PUT);
 * - templates are declarative JSON (`<dataDir>/templates/<id>.json` extends /
 *   overrides the package built-ins); they carry NO logic — the cell→LaTeX
 *   mapping is fixed globally here ({@link serializeCell});
 * - agent collaboration interface = the stable pretty-JSON file contract;
 *   every schema here is a `looseObject` so unknown keys written by future
 *   agents round-trip untouched (the I010 plans.json strip regret is NOT
 *   repeated in this domain);
 * - no LaTeX escaping anywhere: cell content IS LaTeX-level manuscript text.
 */

import { z } from "zod";

// ---- ids ------------------------------------------------------------------- //

export const ManuscriptIdSchema = z.string().regex(/^m_[0-9a-f]{8}$/);
export const CellIdSchema = z.string().regex(/^c_[0-9a-f]{8}$/);
export const CommentIdSchema = z.string().regex(/^cm_[0-9a-f]{8}$/);
/** Template ids are human-written slugs (agents add templates as files). */
export const WriterTemplateIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);

// ---- cells ----------------------------------------------------------------- //

export const CellTypeSchema = z.enum([
  "latex",
  "abstract-aa",
  "figure",
  "table",
  "code",
  "ack",
  "appendix",
  "recipient",
]);

export const CellPlacementSchema = z.enum(["left", "center", "right"]);

export const LatexCellDataSchema = z.looseObject({
  source: z.string().default(""),
});

export const AbstractAaCellDataSchema = z.looseObject({
  Context: z.string().default(""),
  Aims: z.string().default(""),
  Methods: z.string().default(""),
  Results: z.string().default(""),
  Conclusions: z.string().default(""),
});

export const FigureCellDataSchema = z.looseObject({
  caption: z.string().default(""),
  label: z.string().default(""),
  placement: CellPlacementSchema.default("center"),
  /** Column-width percentage (UI slider range 35–100; schema stays lenient). */
  width: z.number().default(80),
  /** Filename inside the manuscript's `assets/` dir; null = no image yet. */
  image: z.string().nullable().default(null),
});

export const TableCellDataSchema = z.looseObject({
  head: z.string().default(""),
  csv: z.string().default(""),
  caption: z.string().default(""),
  label: z.string().default(""),
  placement: CellPlacementSchema.default("center"),
  width: z.number().default(92),
});

export const CodeCellDataSchema = z.looseObject({
  language: z.string().default("Python"),
  caption: z.string().default(""),
  label: z.string().default(""),
  lineNumbers: z.boolean().default(true),
  code: z.string().default(""),
});

export const AckCellDataSchema = z.looseObject({
  source: z.string().default(""),
});

export const AppendixCellDataSchema = z.looseObject({});

export const RecipientCellDataSchema = z.looseObject({
  name: z.string().default(""),
  organization: z.string().default(""),
  address: z.string().default(""),
});

/**
 * One manuscript cell. `data` is per-type (defaults fill missing fields, so
 * agent-authored files may omit `data` entirely); unknown keys survive both
 * at the cell level and inside `data`.
 */
export const CellSchema = z.discriminatedUnion("type", [
  z.looseObject({
    id: CellIdSchema,
    type: z.literal("latex"),
    data: LatexCellDataSchema.prefault({}),
  }),
  z.looseObject({
    id: CellIdSchema,
    type: z.literal("abstract-aa"),
    data: AbstractAaCellDataSchema.prefault({}),
  }),
  z.looseObject({
    id: CellIdSchema,
    type: z.literal("figure"),
    data: FigureCellDataSchema.prefault({}),
  }),
  z.looseObject({
    id: CellIdSchema,
    type: z.literal("table"),
    data: TableCellDataSchema.prefault({}),
  }),
  z.looseObject({
    id: CellIdSchema,
    type: z.literal("code"),
    data: CodeCellDataSchema.prefault({}),
  }),
  z.looseObject({ id: CellIdSchema, type: z.literal("ack"), data: AckCellDataSchema.prefault({}) }),
  z.looseObject({
    id: CellIdSchema,
    type: z.literal("appendix"),
    data: AppendixCellDataSchema.prefault({}),
  }),
  z.looseObject({
    id: CellIdSchema,
    type: z.literal("recipient"),
    data: RecipientCellDataSchema.prefault({}),
  }),
]);

/** The `defaultData` factory of the prototype, kept next to the schemas. */
export function defaultCellData(type: z.infer<typeof CellTypeSchema>): Record<string, unknown> {
  const cell = CellSchema.parse({ id: "c_00000000", type, data: {} });
  return { ...cell.data };
}

// ---- comments (per-cell plain-text notes, embedded in the manuscript) ------ //

export const CommentSchema = z.looseObject({
  id: CommentIdSchema,
  /** The cell this note belongs to. */
  cell: CellIdSchema,
  /** No authorship concept this stage; the prototype's fixed value. */
  who: z.string().default("You"),
  body: z.string().min(1),
  /** ISO-8601 timestamp. */
  created_at: z.iso.datetime(),
});

// ---- manuscript ------------------------------------------------------------ //

export const AuthorSchema = z.looseObject({
  name: z.string().default(""),
  /** Affiliation number(s) as shown superscript in the header, e.g. "1". */
  aff: z.string().default(""),
  email: z.string().optional(),
});

export const ManuscriptSchema = z.looseObject({
  version: z.literal(1),
  id: ManuscriptIdSchema,
  /** Optimistic-lock version; the server bumps it on every accepted PUT. */
  rev: z.number().int().nonnegative(),
  /** Bound template id; the topbar select can re-bind it at any time. */
  template: WriterTemplateIdSchema,
  title: z.string().default("Untitled manuscript"),
  authors: z.array(AuthorSchema).default([]),
  affiliations: z.array(z.string()).default([]),
  /** Inserted between the template preamble and the front matter. */
  userPreamble: z.string().default(""),
  /** Values for the template's `infoFields`, keyed by field key. */
  infoValues: z.record(z.string(), z.string()).default({}),
  cells: z.array(CellSchema).default([]),
  comments: z.array(CommentSchema).default([]),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

/** List-page row: derived from a stored manuscript without serving it whole. */
export const ManuscriptSummarySchema = z.looseObject({
  id: ManuscriptIdSchema,
  title: z.string(),
  template: WriterTemplateIdSchema,
  rev: z.number().int().nonnegative(),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});

// ---- template -------------------------------------------------------------- //

export const TemplateInfoFieldSchema = z.looseObject({
  key: z.string().min(1),
  label: z.string().min(1),
  input: z.enum(["text", "textarea"]).default("text"),
});

export const WriterTemplateSchema = z.looseObject({
  id: WriterTemplateIdSchema,
  version: z.literal(1),
  label: z.string().min(1),
  /** Small chip shown above the paper title in the editor. */
  chip: z.string().default(""),
  /** Template-managed preamble; read-only in the UI. */
  preamble: z.string().default(""),
  /** Cell types this template natively supports (add-menu allowlist). */
  types: z.array(CellTypeSchema).min(1),
  /** Extra document-info fields (replaces the prototype's HTML string). */
  infoFields: z.array(TemplateInfoFieldSchema).default([]),
  /**
   * LaTeX class/style dependencies (D14): file names the template ships in
   * its companion deps dir (`<dataDir>/templates/<id>.deps/`, mirrored for
   * package built-ins); the numbering compile adds that dir to TEXINPUTS and
   * reports a clear failure when a declared dep is missing.
   */
  deps: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).default([]),
  /** Explicit BibTeX style; never silently substitute another template's style. */
  bibliographyStyle: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/)
    .optional(),
  /**
   * LaTeX front matter with `{{title}}` / `{{authors}}` / `{{affiliations}}` /
   * `{{info.<key>}}` placeholders; substituted at export time.
   */
  frontMatter: z.string().default(""),
});

// ---- WebSocket message (server → client) ----------------------------------- //

/**
 * Fired after a successful writer REST mutation or when the poller spotted an
 * external write (agent editing the JSON directly); `id` is the manuscript
 * id, omitted for template-dir changes. Web must dispatch this type in its
 * own explicit branch (a bare `else` once broke compile events, Stage 4/8).
 */
export const WsWriterChangedSchema = z.object({
  type: z.literal("writer.changed"),
  cause: z.enum(["put", "external", "create", "delete", "template", "numbering"]).optional(),
  id: z.string().optional(),
  /** ISO-8601 timestamp. */
  at: z.string(),
});

// --------------------------------------------------------------------------- //
// Cell → LaTeX serialization (GLOBAL fixed mapping; templates cannot override)
// --------------------------------------------------------------------------- //

export type WriterCell = z.infer<typeof CellSchema>;
type CellData = WriterCell["data"];

/** Prototype `parseCsv`: plain comma split, no quote escaping (stage boundary). */
export function parseSimpleCsv(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.split(",").map((v) => v.trim()));
}

function figureWidthFraction(width: number): string {
  const frac = Math.round(width) / 100;
  return String(Number(frac.toFixed(2)));
}

/** Serialize one cell to its LaTeX fragment (prototype `serializeLatex`). */
export function serializeCell(cell: WriterCell): string {
  const d = cell.data as CellData & Record<string, string>;
  switch (cell.type) {
    case "latex":
      return (d.source as string) ?? "";
    case "abstract-aa": {
      const parts = ["Context", "Aims", "Methods", "Results", "Conclusions"] as const;
      return `\\abstract\n${parts.map((k) => `{${d[k] ?? ""}}`).join("\n")}`;
    }
    case "figure": {
      const asset = d.image
        ? `  \\includegraphics[width=${figureWidthFraction(d.width as number)}\\columnwidth]{assets/${d.image}}`
        : "  % no asset";
      return [
        "\\begin{figure}",
        "  \\centering",
        asset,
        `  \\caption{${d.caption ?? ""}}`,
        ...(d.label ? [`  \\label{${d.label}}`] : []),
        "\\end{figure}",
      ].join("\n");
    }
    case "table": {
      const head = parseSimpleCsv((d.head as string) ?? "")[0] ?? [];
      const rows = parseSimpleCsv((d.csv as string) ?? "");
      const cols = Math.max(head.length, 1);
      const spec = "l".repeat(cols);
      const lines = [
        "\\begin{table}",
        "  \\centering",
        `  \\caption{${d.caption ?? ""}}`,
        ...(d.label ? [`  \\label{${d.label}}`] : []),
        `  \\begin{tabular}{${spec}}`,
        "    \\hline",
      ];
      if (head.length) lines.push(`    ${head.join(" & ")} \\\\`, "    \\hline");
      for (const row of rows) lines.push(`    ${row.join(" & ")} \\\\`);
      lines.push("    \\hline", "  \\end{tabular}", "\\end{table}");
      return lines.join("\n");
    }
    case "code": {
      const opts = [`caption={${d.caption ?? ""}}`, ...(d.label ? [`label={${d.label}}`] : [])];
      if (d.lineNumbers) opts.push("numbers=left");
      return `\\begin{lstlisting}[${opts.join(",")}]\n${d.code ?? ""}\n\\end{lstlisting}`;
    }
    case "ack":
      return `\\begin{acknowledgements}\n${d.source ?? ""}\n\\end{acknowledgements}`;
    case "appendix":
      return "\\appendix";
    case "recipient":
      return ["% recipient", d.name ?? "", d.organization ?? "", d.address ?? ""].join("\n");
  }
}

// ---- export assembly (pure; M1 client-side single .tex, M3 server zip) ----- //

const CITE_NAMES = new Set([
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
  "citefullauthor",
  "nocite",
]);

/** Bibliography key inventory only, NOT a renderer. Balanced notes, comments and
 * literal code must not turn valid citations into missing bibliography entries. */
function texInventory(sources: readonly string[]): { keys: string[]; commands: Set<string> } {
  const seen = new Set<string>();
  const commands = new Set<string>();
  const scan = (text: string) => {
    let i = 0;
    const skip = () => {
      while (i < text.length) {
        if (/\s/.test(text[i] ?? "")) i++;
        else if (text[i] === "%") {
          const end = text.indexOf("\n", i);
          i = end < 0 ? text.length : end + 1;
        } else break;
      }
    };
    const group = (open: "[" | "{"): string | null => {
      skip();
      if (text[i] !== open) return null;
      const close = open === "[" ? "]" : "}";
      let depth = 1,
        braces = 0,
        value = "";
      i++;
      while (i < text.length) {
        const c = text[i++] ?? "";
        if (c === "\\") {
          value += c + (text[i++] ?? "");
          continue;
        }
        if (c === "%") {
          const end = text.indexOf("\n", i);
          i = end < 0 ? text.length : end + 1;
          continue;
        }
        if (open === "[") {
          if (c === "{") braces++;
          if (c === "}") braces--;
        }
        if (braces === 0 && c === open) depth++;
        if (braces === 0 && c === close && --depth === 0) return value;
        value += c;
      }
      return null;
    };
    while (i < text.length) {
      skip();
      if (text[i++] !== "\\") continue;
      const word = /^[A-Za-z]+/.exec(text.slice(i))?.[0];
      if (!word) {
        i++;
        continue;
      } // escaped backslash/percent is not a command/comment
      i += word.length;
      if (text[i] === "*") i++;
      if (word === "verb" || word === "lstinline") {
        skip();
        if (text[i] === "[") group("[");
        const delimiter = text[i++];
        const end = delimiter ? text.indexOf(delimiter, i) : -1;
        i = end < 0 ? text.length : end + 1;
        continue;
      }
      if (word === "begin") {
        const env = group("{");
        if (
          env &&
          ["verbatim", "verbatim*", "lstlisting", "minted", "comment", "comment*"].includes(env)
        ) {
          const opts = group("[");
          if (opts && env === "lstlisting") scan(opts);
          const end = text.indexOf(`\\end{${env}}`, i);
          i = end < 0 ? text.length : end + env.length + 6;
        }
        continue;
      }
      commands.add(word);
      if (!CITE_NAMES.has(word.toLowerCase())) continue;
      group("[");
      group("[");
      const keys = group("{");
      for (const key of keys?.split(",") ?? []) {
        const k = key.trim();
        if (k && !k.includes("#")) seen.add(k);
      }
    }
  };
  for (const source of sources) scan(source);
  return { keys: [...seen], commands };
}

export function extractCitedKeys(
  cells: WriterCell[],
  extraSources: readonly string[] = []
): string[] {
  return texInventory([
    ...extraSources,
    ...cells.map((cell) => (cell.type === "code" ? cell.data.caption : serializeCell(cell))),
  ]).keys;
}

export function extractManuscriptCitedKeys(
  manuscript: WriterManuscript,
  template: WriterTemplate
): string[] {
  return extractCitedKeys(manuscript.cells, [
    template.preamble,
    manuscript.userPreamble,
    renderFrontMatter(template, manuscript),
  ]);
}

/**
 * Substitute the front-matter placeholders: `{{title}}`, `{{authors}}`
 * (comma-joined names), `{{affiliations}}` (newline-joined) and
 * `{{info.<key>}}`. Unknown placeholders become the empty string.
 */
export function renderFrontMatter(template: WriterTemplate, manuscript: WriterManuscript): string {
  return template.frontMatter.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_all, raw: string) => {
    const key = raw.trim();
    if (key === "title") return manuscript.title;
    if (key === "authors")
      return manuscript.authors
        .map((a) => a.name)
        .filter(Boolean)
        .join(", ");
    if (key === "affiliations") return manuscript.affiliations.filter(Boolean).join("\n");
    if (key.startsWith("info.")) return manuscript.infoValues[key.slice("info.".length)] ?? "";
    return "";
  });
}

/**
 * Assemble the single exported `.tex`: template preamble + user preamble +
 * `\begin{document}` + front matter + body (serialized cells) +
 * `\bibliography{references}` when anything is cited. The front matter is
 * expanded right after `\begin{document}` so templates can carry their own
 * `\maketitle` (legal LaTeX: \title/\author anywhere before \maketitle).
 * No LaTeX escaping — cell content is LaTeX already.
 *
 * Implementation note: this is a thin wrapper over {@link buildTexDocumentMapped}
 * (which additionally reports per-cell line ranges for the D14 numbering
 * compile); both produce the identical byte stream.
 */
export function buildTexDocument(manuscript: WriterManuscript, template: WriterTemplate): string {
  return buildTexDocumentMapped(manuscript, template).tex;
}

/** A cell's line range (1-based, inclusive) inside the assembled document. */
export interface TexCellRange {
  cell: string;
  startLine: number;
  endLine: number;
}

// --------------------------------------------------------------------------- //
// ADS journal shorthands (Stage 12)
// --------------------------------------------------------------------------- //

/**
 * aas_macros-style journal shorthand → expansion, injected as
 * `\providecommand` whenever the manuscript cites anything: ADS BibTeX writes
 * `journal = {\aap}`, but neither TeX Live nor aa.cls/aa.bst defines these
 * (I004 evidence). `\providecommand` never overrides a template/user
 * definition. Values carry escaped `&`. Extend the list as new shorthands
 * appear in ADS exports (mapping follows the long-standing aas_macros.sty
 * table circulated with ADS/AAS tooling).
 */
export const WRITER_JOURNAL_MACROS: ReadonlyArray<readonly [string, string]> = [
  ["aap", "Astronomy \\& Astrophysics"],
  ["aaps", "Astronomy \\& Astrophysics Supplement Series"],
  ["aapr", "Astronomy and Astrophysics Reviews"],
  ["actaa", "Acta Astronomica"],
  ["aj", "Astronomical Journal"],
  ["apj", "Astrophysical Journal"],
  ["apjl", "Astrophysical Journal Letters"],
  ["apjs", "Astrophysical Journal Supplement Series"],
  ["apss", "Astrophysics and Space Science"],
  ["araa", "Annual Review of Astronomy and Astrophysics"],
  ["icarus", "Icarus"],
  ["jcap", "Journal of Cosmology and Astroparticle Physics"],
  ["mnras", "Monthly Notices of the Royal Astronomical Society"],
  ["nat", "Nature"],
  ["newa", "New Astronomy"],
  ["pasa", "Publications of the Astronomical Society of Australia"],
  ["pasj", "Publications of the Astronomical Society of Japan"],
  ["pasp", "Publications of the Astronomical Society of the Pacific"],
  ["physrep", "Physics Reports"],
  ["pra", "Physical Review A"],
  ["prb", "Physical Review B"],
  ["prc", "Physical Review C"],
  ["prd", "Physical Review D"],
  ["pre", "Physical Review E"],
  ["prl", "Physical Review Letters"],
  ["rmp", "Reviews of Modern Physics"],
  ["solphys", "Solar Physics"],
  ["ssr", "Space Science Reviews"],
];

/** The injected preamble fragment (one \providecommand per line). */
export function journalMacrosTex(): string {
  return WRITER_JOURNAL_MACROS.map(
    ([name, expansion]) => `\\providecommand{\\${name}}{${expansion}}`
  ).join("\n");
}

/**
 * buildTexDocument plus the cell→line map (D14): the numbering compile's
 * events carry `file: main.tex + line`, and these ranges attribute them back
 * to cells without any re-parsing. Byte-identical tex to buildTexDocument
 * (locked by a contracts test).
 */
export function buildTexDocumentMapped(
  manuscript: WriterManuscript,
  template: WriterTemplate
): { tex: string; cellRanges: TexCellRange[] } {
  // Identical part sequence to the original parts.join("\n") assembly;
  // cells are pushed individually (c0, "", c1, ""… == cells.join("\n\n")),
  // so the tex is byte-identical by construction. A part's start line is
  // 1 + Σ over earlier parts of (newlines in part + 1 join separator).
  const cited = extractManuscriptCitedKeys(manuscript, template).length > 0;
  const parts: string[] = [template.preamble.trimEnd(), ""];
  // ADS journal shorthands (journal = {\aap}) need definitions; injected only
  // when something is cited, before any user preamble (\providecommand never
  // overrides an existing definition).
  if (cited) parts.push(journalMacrosTex(), "");
  if (manuscript.userPreamble.trim()) parts.push(manuscript.userPreamble.trimEnd(), "");
  parts.push("\\begin{document}", "");
  const front = renderFrontMatter(template, manuscript).trimEnd();
  // A&A consumes its five-part abstract at maketitle. Emit the SAME abstract
  // cells (with their source map) before that command, not after an empty title.
  const titleAt = front.search(/\\maketitle\b/);
  const abstracts = titleAt >= 0 ? manuscript.cells.filter((c) => c.type === "abstract-aa") : [];
  const prefix = abstracts.length ? front.slice(0, titleAt).trimEnd() : front;
  if (prefix) parts.push(prefix, "");

  const countNl = (s: string): number => s.split("\n").length - 1;
  const cellRanges: TexCellRange[] = [];
  let lineCursor = 1 + parts.reduce((acc, p) => acc + countNl(p) + 1, 0);
  const appendCell = (cell: WriterCell) => {
    const ser = serializeCell(cell);
    parts.push(ser, "");
    const startLine = lineCursor;
    cellRanges.push({ cell: cell.id, startLine, endLine: startLine + countNl(ser) });
    lineCursor += countNl(ser) + 2;
  };
  for (const cell of abstracts) appendCell(cell);
  if (abstracts.length) {
    const title = front.slice(titleAt);
    parts.push(title, "");
    lineCursor += countNl(title) + 2;
  }
  for (const cell of manuscript.cells)
    if (!abstracts.length || cell.type !== "abstract-aa") appendCell(cell);
  // zero cells: keep the original assembly's empty CELLS part, so the tex
  // stays byte-identical in that edge case too.
  if (manuscript.cells.length === 0) parts.push("");
  if (cited) {
    // An explicit source declaration wins; otherwise use the template's declared
    // style. Missing styles remain a visible compile error, never a silent fallback.
    if (template.bibliographyStyle && !texInventory(parts).commands.has("bibliographystyle")) {
      parts.push(`\\bibliographystyle{${template.bibliographyStyle}}`);
    }
    parts.push("\\bibliography{references}", "");
  }
  parts.push("\\end{document}", "");
  return { tex: parts.join("\n"), cellRanges };
}

// --------------------------------------------------------------------------- //
// Inferred types
// --------------------------------------------------------------------------- //

export type CellType = z.infer<typeof CellTypeSchema>;
export type CellPlacement = z.infer<typeof CellPlacementSchema>;
export type WriterComment = z.infer<typeof CommentSchema>;
export type WriterAuthor = z.infer<typeof AuthorSchema>;
export type WriterManuscript = z.infer<typeof ManuscriptSchema>;
export type ManuscriptSummary = z.infer<typeof ManuscriptSummarySchema>;
export type TemplateInfoField = z.infer<typeof TemplateInfoFieldSchema>;
export type WriterTemplate = z.infer<typeof WriterTemplateSchema>;
export type WsWriterChanged = z.infer<typeof WsWriterChangedSchema>;
