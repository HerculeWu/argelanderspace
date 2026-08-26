/**
 * MinerU v4 extraction artifacts — TS shapes for the parts of `content_list.json` /
 * `middle.json` that the pure documents logic actually consumes.
 *
 * MinerU's output is a loose bag of optional fields (see the real shape in
 * `tests/fixtures/sample_content_list.json`), so — like the Python code, which reads
 * everything through `dict.get(...)` — all values are `unknown` and validated at the
 * point of use. Known fields (with the keys the pipeline reads):
 *
 * - common: `type`, `text` (string or list of strings), `text_level`, `page_idx`,
 *   `bbox` ([x0,y0,x1,y1] on a 0..1000 page grid), `img_path`, `sub_type`
 * - floats: `img_caption`/`chart_caption`/`figure_caption`, `img_footnote`/
 *   `chart_footnote`/`table_footnote`, `table_caption`, `table_body`, `content`
 * - code/algorithm: `code_caption`, `algorithm_caption`, `code_body`,
 *   `algorithm_body`, `guess_lang`, `language`
 * - lists: `list_items`/`items`, `ordered`
 */

export interface MineruContentItem {
  /** MinerU block type: "text" | "title" | "image" | "chart" | "table" | ... */
  type?: string;
  text_level?: number;
  page_idx?: number;
  bbox?: unknown;
  text?: unknown;
  [key: string]: unknown;
}

export type MineruContentList = MineruContentItem[];

/** Parsed artifacts from one MinerU extraction (bibgraph.mineru_client.MineruResult). */
export interface MineruArtifacts {
  contentList: MineruContentList;
  middle?: Record<string, unknown>;
  fullMd?: string;
  batchId?: string;
}

/**
 * Parse a MinerU bbox (0..1000 page grid) into `[x0, y0, x1, y1]`, else undefined.
 * Mirrors the duplicated `_bbox()` helpers in structure.py / references.py (which
 * also accept anything `float()` can convert; we require finite numbers — MinerU
 * always emits numbers).
 */
export function readBbox(item: MineruContentItem): [number, number, number, number] | undefined {
  const b = item.bbox;
  if (!Array.isArray(b) || b.length < 4) return undefined;
  const [x0, y0, x1, y1] = b;
  if (
    typeof x0 !== "number" ||
    typeof y0 !== "number" ||
    typeof x1 !== "number" ||
    typeof y1 !== "number" ||
    ![x0, y0, x1, y1].every(Number.isFinite)
  ) {
    return undefined;
  }
  return [x0, y0, x1, y1];
}
