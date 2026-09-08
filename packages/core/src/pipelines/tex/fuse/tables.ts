/**
 * tabular / deluxetable → `tableBody` HTML for the fuse layer.
 *
 * Output shape matches what the web reader's `tableparse.ts` consumes:
 * `<table><tr><th…>header</th></tr><tr><td>…</td></tr>…</table>` with
 * `rowspan`/`colspan` attrs when > 1 and HTML-escaped cell text.
 *
 * Header heuristic for plain tabular: rows before the first inter-row rule
 * (\hline/\toprule/\midrule…) are `<th>` rows; no rules at all → all `<td>`.
 * deluxetable: `\tablehead{…}` rows are the header; rows between
 * `\startdata`/`\enddata` are data; `\colhead` unwraps; `\tableline` is a
 * rule; `\tablecomments`/`\tablerefs`/`\tablenotetext` become trailing
 * paragraphs (returned for the fuser to place after the block), and the
 * formatting-only commands are dropped — the same rules the retired
 * aastex.ts pre-rewrite applied, but recognized natively here.
 */
import type * as Ast from "@unified-latex/unified-latex-types";
import { lastArgText, printRawNodes } from "../source/tree.js";
import { escapeHtml } from "./text.js";

interface Cell {
  text: string;
  colspan: number;
  rowspan: number;
}

interface Row {
  cells: Cell[];
  /** a rule (\hline, \toprule, …) appeared before this row */
  ruleBefore: boolean;
}

const RULE_MACROS = new Set([
  "hline",
  "toprule",
  "midrule",
  "bottomrule",
  "cline",
  "cmidrule",
  "tableline",
]);

/** The plain-text renderer the fuser provides for cell content. */
export type PlainRenderer = (nodes: readonly Ast.Node[]) => string;

function isMacro(node: Ast.Node, names: Set<string>): node is Ast.Macro {
  return node.type === "macro" && names.has(node.content);
}

/** Split tabular-body nodes into rows (\\ top-level) and cells (& top-level). */
function splitRows(nodes: readonly Ast.Node[], plain: PlainRenderer): Row[] {
  const rows: Row[] = [];
  let cells: Cell[] = [];
  let cellNodes: Ast.Node[] = [];
  let rulePending = false;
  let rowHasContent = false;

  const flushCell = (): void => {
    const text = cellPlain(cellNodes, plain);
    if (text !== null) cells.push(text);
    cellNodes = [];
  };
  const flushRow = (): void => {
    flushCell();
    const allEmpty = cells.every((c) => c.text === "" && c.colspan === 1 && c.rowspan === 1);
    if (cells.length > 0 && !allEmpty) {
      rows.push({ cells, ruleBefore: rulePending });
      rulePending = false;
    }
    cells = [];
    rowHasContent = false;
  };

  for (const node of nodes) {
    if (node.type === "macro" && node.content === "\\") {
      flushRow();
      continue;
    }
    if (node.type === "string" && node.content === "&") {
      flushCell();
      rowHasContent = true;
      continue;
    }
    if (isMacro(node, RULE_MACROS)) {
      // a rule applies to the NEXT row if a row just ended, else pending
      rulePending = true;
      continue;
    }
    cellNodes.push(node);
    if (node.type !== "whitespace" && node.type !== "comment") rowHasContent = true;
  }
  flushRow();
  void rowHasContent;
  return rows;
}

/** Cell text with \multicolumn/\multirow span extraction. */
function cellPlain(nodes: readonly Ast.Node[], plain: PlainRenderer): Cell | null {
  let colspan = 1;
  let rowspan = 1;
  let rest = nodes as readonly Ast.Node[];
  // \multicolumn{n}{spec}{content} / \multirow{n}{*}{content} lead the cell
  const first = rest.find((n) => n.type !== "whitespace" && n.type !== "comment");
  if (first?.type === "macro" && first.content === "multicolumn") {
    const n = Number.parseInt(lastArg0(first) ?? "", 10);
    if (Number.isInteger(n) && n > 1) colspan = n;
    rest = argNodes(first, 2) ?? [];
  } else if (first?.type === "macro" && first.content === "multirow") {
    const n = Number.parseInt(lastArg0(first) ?? "", 10);
    if (Number.isInteger(n) && n > 1) rowspan = n;
    rest = argNodes(first, 2) ?? [];
  }
  const text = plain(rest);
  return { text, colspan, rowspan };
}

/** Raw text of a macro's FIRST argument. */
function lastArg0(node: Ast.Macro): string | undefined {
  const a = node.args?.[0];
  return a === undefined ? undefined : printRawNodes(a.content).trim();
}

/** Content nodes of a macro's Nth argument. */
function argNodes(node: Ast.Macro, idx: number): Ast.Node[] | undefined {
  const a = node.args?.[idx];
  return a === undefined ? undefined : ([...a.content] as Ast.Node[]);
}

function rowHtml(row: Row, tag: "th" | "td"): string {
  const cells = row.cells
    .map((c) => {
      let attrs = "";
      if (c.rowspan > 1) attrs += ` rowspan="${c.rowspan}"`;
      if (c.colspan > 1) attrs += ` colspan="${c.colspan}"`;
      return `<${tag}${attrs}>${escapeHtml(c.text)}</${tag}>`;
    })
    .join("");
  return `<tr>${cells}</tr>`;
}

/** tabular env/content → `<table>` HTML ("" when no rows). */
export function tabularHtml(nodes: readonly Ast.Node[], plain: PlainRenderer): string {
  const rows = splitRows(nodes, plain);
  if (rows.length === 0) return "";
  // header = the rows before the first inter-row rule (rules pending on a
  // later row mark the boundary)
  const firstRuleIdx = rows.findIndex((r, i) => i > 0 && r.ruleBefore);
  const headCount = firstRuleIdx > 0 ? firstRuleIdx : 0;
  const html = rows.map((r, i) => rowHtml(r, i < headCount ? "th" : "td")).join("");
  return `<table>${html}</table>`;
}

// --------------------------------------------------------------------------- //
// deluxetable (AASTeX) — native recognition
// --------------------------------------------------------------------------- //

export interface DeluxeParts {
  /** Header rows (th): rows → cells → content nodes. */
  headerRows: Ast.Node[][][];
  /** Data-row nodes between \startdata and \enddata. */
  dataNodes: Ast.Node[];
  /** \tablecaption argument nodes, if any. */
  captionNodes: Ast.Node[] | undefined;
  /** \label key found in or outside the caption. */
  labelKey: string | undefined;
  /** Trailing paragraph nodes (\tablecomments/\tablerefs/\tablenotetext). */
  trailing: Ast.Node[][];
}

/** `\colhead{…}` cells → bare contents. */
function unwrapColheads(nodes: readonly Ast.Node[]): Ast.Node[] {
  const out: Ast.Node[] = [];
  for (const n of nodes) {
    if (n.type === "macro" && n.content === "colhead" && (n.args?.length ?? 0) > 0) {
      out.push(...(n.args?.[0]?.content ?? []));
    } else {
      out.push(n);
    }
  }
  return out;
}

/** Header rows of a \tablehead argument (split on \\, colheads unwrapped). */
function deluxeHeaderRows(headNodes: readonly Ast.Node[]): Ast.Node[][][] {
  const rows: Ast.Node[][][] = [];
  let row: Ast.Node[][] = [];
  let cell: Ast.Node[] = [];
  const flushCell = (): void => {
    row.push(cell);
    cell = [];
  };
  const flushRow = (): void => {
    flushCell();
    if (row.some((c) => c.length > 0)) rows.push(row);
    row = [];
  };
  for (const n of unwrapColheads(headNodes)) {
    if (n.type === "macro" && n.content === "\\") flushRow();
    else if (n.type === "string" && n.content === "&") flushCell();
    else if (isMacro(n, RULE_MACROS)) {
      // drop rules
    } else cell.push(n);
  }
  flushRow();
  return rows;
}

const DELUXE_DROP_MACROS = new Set([
  "tabletypesize",
  "tablewidth",
  "tablecolumns",
  "tablenum",
  "rotate",
  "centering",
  "vspace",
  "startdata",
  "enddata",
]);

/** Parse a deluxetable(*) environment node into structured parts. */
export function parseDeluxetable(env: Ast.Node): DeluxeParts {
  const content = (
    Array.isArray((env as { content?: unknown }).content)
      ? (env as { content: Ast.Node[] }).content
      : []
  ) as Ast.Node[];

  let captionNodes: Ast.Node[] | undefined;
  let labelKey: string | undefined;
  let headerRows: Ast.Node[][][] = [];
  const dataNodes: Ast.Node[] = [];
  const trailing: Ast.Node[][] = [];
  let inData = false;

  for (const node of content) {
    if (node.type !== "macro") {
      if (inData) dataNodes.push(node);
      continue;
    }
    switch (node.content) {
      case "tablecaption": {
        const arg = node.args?.[node.args.length - 1];
        if (arg !== undefined) captionNodes = [...arg.content];
        continue;
      }
      case "tablehead": {
        const arg = node.args?.[node.args.length - 1];
        if (arg !== undefined) headerRows = deluxeHeaderRows(arg.content);
        continue;
      }
      case "startdata":
        inData = true;
        continue;
      case "enddata":
        inData = false;
        continue;
      case "label": {
        labelKey ??= lastArgText(node);
        continue;
      }
      case "tablecomments":
      case "tablerefs": {
        const arg = node.args?.[node.args.length - 1];
        if (arg !== undefined) trailing.push([...arg.content]);
        continue;
      }
      case "tablenotetext": {
        const mark = argNodes(node, 0);
        const text = argNodes(node, 1);
        if (text !== undefined) {
          trailing.push([
            {
              type: "string",
              content: `(${mark !== undefined ? printRawNodes(mark).trim() : ""}) `,
            } as Ast.String,
            ...text,
          ]);
        }
        continue;
      }
      default:
        if (DELUXE_DROP_MACROS.has(node.content)) continue;
        if (inData) dataNodes.push(node);
        continue;
    }
  }
  // a caption-carried \label wins over a standalone one
  if (captionNodes !== undefined) {
    const capLabel = captionNodes.find(
      (n): n is Ast.Macro => n.type === "macro" && n.content === "label"
    );
    if (capLabel !== undefined) labelKey = lastArgText(capLabel) ?? labelKey;
  }
  return { headerRows, dataNodes, captionNodes, labelKey, trailing };
}

/** deluxetable parts → `<table>` HTML (header th + data td). */
export function deluxetableHtml(parts: DeluxeParts, plain: PlainRenderer): string {
  const rows: string[] = [];
  for (const hr of parts.headerRows) {
    rows.push(`<tr>${hr.map((c) => `<th>${escapeHtml(plain(c))}</th>`).join("")}</tr>`);
  }
  const data = splitRows(parts.dataNodes, plain);
  for (const r of data) rows.push(rowHtml(r, "td"));
  if (rows.length === 0) return "";
  return `<table>${rows.join("")}</table>`;
}
