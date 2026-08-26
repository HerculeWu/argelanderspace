// Parse a MinerU <table> HTML string into a grid of cell HTML so the right
// panel can render size-limited previews (e.g. 8 rows x 4 cols).

export interface ParsedTable {
  rows: string[][]; // each cell is raw inner HTML
  totalRows: number;
  totalCols: number;
}

export function parseTable(html: string): ParsedTable {
  const rows: string[][] = [];
  let totalCols = 0;
  try {
    const doc = new DOMParser().parseFromString(html || "", "text/html");
    const trs = Array.from(doc.querySelectorAll("tr"));
    for (const tr of trs) {
      const cells = Array.from(tr.querySelectorAll("th,td")).map(
        (c) => (c as HTMLElement).innerHTML
      );
      if (cells.length) {
        rows.push(cells);
        totalCols = Math.max(totalCols, cells.length);
      }
    }
  } catch {
    /* leave rows empty */
  }
  return { rows, totalRows: rows.length, totalCols };
}

export function limitTable(t: ParsedTable, maxRows: number, maxCols: number): ParsedTable {
  return {
    rows: t.rows.slice(0, maxRows).map((r) => r.slice(0, maxCols)),
    totalRows: t.totalRows,
    totalCols: t.totalCols,
  };
}
