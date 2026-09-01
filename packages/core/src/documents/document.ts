/**
 * Document JSON serialization (the serialization half of bibgraph/schema.py)
 * plus the `annotatable` rich-text-holder walk shared by the pipelines.
 *
 * `documentToJson` mirrors `Document.to_dict(compact_json=...)`: explicit per-type
 * field assembly (non-schema fields like `Reference.src_page` are never serialized)
 * followed by `compact`, which recursively drops null/empty values but preserves
 * `0` and `false`.
 *
 * `buildDocument` (the MinerU/PDF orchestration half) left with the PDF
 * pipeline — archived on the `ocr-features` branch.
 */

import type {
  Block,
  CitationOccurrence,
  CrossRefOccurrence,
  Document,
  DocumentStats,
  Reference,
  RichText,
  Section,
} from "@argelanderspace/contracts";
import { iterBlocks, iterSections } from "./traverse.js";

// --------------------------------------------------------------------------- //
// compact (schema.py)
// --------------------------------------------------------------------------- //

/**
 * Recursively drop `null`/`undefined` and empty containers/strings.
 *
 * Numeric `0` and `false` are preserved (they are meaningful, e.g. `page_idx == 0`
 * or `resolved == false`). Note: like the Python version, only *dict values* are
 * dropped — list elements are compacted but never removed.
 */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => compact(v));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v0] of Object.entries(value)) {
      const v = compact(v0);
      if (v === null || v === undefined) continue;
      if (typeof v === "string" && v.length === 0) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      if (typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 0) {
        continue;
      }
      out[k] = v;
    }
    return out;
  }
  return value;
}

/**
 * Return the rich-text holders of a block (each has text/citations/crossrefs).
 * Shared with the LaTeX pipeline (`bibgraph/pipeline.py::_annotatable`).
 */
export function annotatable(block: Block): RichText[] {
  if (block.type === "paragraph") return [block];
  if (block.type === "list") return block.items;
  if (block.type === "equation") return [];
  return "caption" in block && block.caption !== undefined ? [block.caption] : [];
}

// --------------------------------------------------------------------------- //
// Document.to_dict (schema.py)
// --------------------------------------------------------------------------- //

type JsonObject = Record<string, unknown>;

/** Mirror `Document.to_dict(compact_json=...)`: the JSON-ready document object. */
export function documentToJson(doc: Document, compactJson = true): JsonObject {
  const { citations, crossrefs } = flattenOccurrences(doc);
  const index = buildIndex(doc);
  const d: JsonObject = {
    doc_id: doc.doc_id,
    source: doc.source,
    meta: doc.meta,
    structure: (doc.structure ?? []).map(sectionToJson),
    index,
    references: (doc.references ?? []).map(referenceToJson),
    citations,
    crossrefs,
    stats: computeStats(doc, index, citations, crossrefs),
  };
  return (compactJson ? compact(d) : d) as JsonObject;
}

function citationToJson(c: CitationOccurrence): JsonObject {
  return {
    ref_ids: c.ref_ids,
    raw: c.raw,
    via: c.via,
    resolved: c.resolved,
    doi: c.doi,
    url: c.url,
  };
}

function crossrefToJson(x: CrossRefOccurrence): JsonObject {
  return {
    kind: x.kind,
    raw: x.raw,
    target_id: x.target_id,
    number: x.number,
    via: x.via,
    resolved: x.resolved,
    target_page: x.target_page,
    url: x.url,
  };
}

function richTextToJson(rt: RichText): JsonObject {
  return {
    text: rt.text,
    citations: (rt.citations ?? []).map(citationToJson),
    crossrefs: (rt.crossrefs ?? []).map(crossrefToJson),
  };
}

function blockToJson(b: Block): JsonObject {
  const base: JsonObject = { id: b.id, type: b.type, page_idx: b.page_idx, bbox: b.bbox };
  switch (b.type) {
    case "paragraph":
      return {
        ...base,
        text: b.text,
        citations: (b.citations ?? []).map(citationToJson),
        crossrefs: (b.crossrefs ?? []).map(crossrefToJson),
      };
    case "list":
      return { ...base, ordered: b.ordered, items: b.items.map(richTextToJson) };
    case "figure":
      return {
        ...base,
        number: b.number,
        label: b.label,
        caption: b.caption ? richTextToJson(b.caption) : undefined,
        footnote: b.footnote,
        img_path: b.img_path,
        chart_type: b.chart_type,
        content: b.content,
      };
    case "table":
      return {
        ...base,
        number: b.number,
        label: b.label,
        caption: b.caption ? richTextToJson(b.caption) : undefined,
        footnote: b.footnote,
        table_body: b.table_body,
        img_path: b.img_path,
      };
    case "equation":
      return { ...base, number: b.number, label: b.label, latex: b.latex };
    case "code":
      return {
        ...base,
        number: b.number,
        label: b.label,
        caption: b.caption ? richTextToJson(b.caption) : undefined,
        lang: b.lang,
        body: b.body,
      };
    case "algorithm":
      return {
        ...base,
        number: b.number,
        label: b.label,
        caption: b.caption ? richTextToJson(b.caption) : undefined,
        body: b.body,
      };
    default:
      return base;
  }
}

function sectionToJson(s: Section): JsonObject {
  return {
    id: s.id,
    type: s.type,
    level: s.level,
    heading: s.heading,
    heading_raw: s.heading_raw,
    number: s.number,
    page_idx: s.page_idx,
    bbox: s.bbox,
    blocks: (s.blocks ?? []).map(blockToJson),
    children: (s.children ?? []).map(sectionToJson),
  };
}

function referenceToJson(r: Reference): JsonObject {
  // src_page / src_bbox are intentionally not serialized
  return {
    id: r.id,
    raw: r.raw,
    label: r.label,
    authors: r.authors,
    year: r.year,
    title: r.title,
    venue: r.venue,
    volume: r.volume,
    pages: r.pages,
    doi: r.doi,
    arxiv_id: r.arxiv_id,
    url: r.url,
    keys: r.keys,
  };
}

/** Lightweight index for the web UI / xref resolution (Document._build_index). */
function buildIndex(doc: Document): Record<string, JsonObject[]> {
  const idx: Record<string, JsonObject[]> = {
    figures: [],
    tables: [],
    equations: [],
    code: [],
    algorithms: [],
    sections: [],
  };
  const bucket: Record<string, string> = {
    figure: "figures",
    table: "tables",
    equation: "equations",
    code: "code",
    algorithm: "algorithms",
  };
  for (const b of iterBlocks(doc)) {
    const key = bucket[b.type];
    if (!key) continue;
    const entry: JsonObject = { id: b.id, page_idx: b.page_idx };
    if ("number" in b) entry.number = b.number;
    if ("label" in b) entry.label = b.label;
    if ("caption" in b && b.caption) entry.caption = b.caption.text;
    idx[key]?.push(entry);
  }
  for (const s of iterSections(doc)) {
    idx.sections?.push({
      id: s.id,
      level: s.level,
      number: s.number,
      heading: s.heading,
      page_idx: s.page_idx,
    });
  }
  return idx;
}

/** Document._flatten_occurrences: occurrences with block_id (+ "in" context). */
function flattenOccurrences(doc: Document): { citations: JsonObject[]; crossrefs: JsonObject[] } {
  const cites: JsonObject[] = [];
  const xrefs: JsonObject[] = [];
  for (const b of iterBlocks(doc)) {
    if (b.type === "paragraph") {
      for (const c of b.citations ?? []) cites.push({ ...citationToJson(c), block_id: b.id });
      for (const x of b.crossrefs ?? []) xrefs.push({ ...crossrefToJson(x), block_id: b.id });
    }
    // captions / list items carry occurrences too
    const cap = "caption" in b ? b.caption : undefined;
    if (cap) {
      for (const c of cap.citations ?? []) {
        cites.push({ ...citationToJson(c), block_id: b.id, in: "caption" });
      }
      for (const x of cap.crossrefs ?? []) {
        xrefs.push({ ...crossrefToJson(x), block_id: b.id, in: "caption" });
      }
    }
    const items = b.type === "list" ? b.items : [];
    for (const it of items) {
      for (const c of it.citations ?? []) {
        cites.push({ ...citationToJson(c), block_id: b.id, in: "list_item" });
      }
      for (const x of it.crossrefs ?? []) {
        xrefs.push({ ...crossrefToJson(x), block_id: b.id, in: "list_item" });
      }
    }
  }
  return { citations: cites, crossrefs: xrefs };
}

function computeStats(
  doc: Document,
  index: Record<string, JsonObject[]>,
  cites: JsonObject[],
  xrefs: JsonObject[]
): DocumentStats {
  let nParagraphs = 0;
  for (const b of iterBlocks(doc)) {
    if (b.type === "paragraph") nParagraphs += 1;
  }
  return {
    n_sections: index.sections?.length ?? 0,
    n_paragraphs: nParagraphs,
    n_figures: index.figures?.length ?? 0,
    n_tables: index.tables?.length ?? 0,
    n_equations: index.equations?.length ?? 0,
    n_code: index.code?.length ?? 0,
    n_algorithms: index.algorithms?.length ?? 0,
    n_references: doc.references?.length ?? 0,
    n_citations: cites.length,
    n_citations_resolved: cites.filter((c) => c.resolved).length,
    n_crossrefs: xrefs.length,
    n_crossrefs_resolved: xrefs.filter((x) => x.resolved).length,
  };
}
