/**
 * Document assembly + JSON serialization (bibgraph/pipeline.py `build_document` and
 * the serialization half of bibgraph/schema.py).
 *
 * `buildDocument` composes the pure stages — structure, references, textfix,
 * annotate — exactly as the Python PDF pipeline does, minus the MinerU API call and
 * PDF opening (M2/M3; the PDF text layer arrives through a {@link PdfTextProvider}).
 *
 * `documentToJson` mirrors `Document.to_dict(compact_json=...)`: explicit per-type
 * field assembly (non-schema fields like `Reference.src_page` are never serialized)
 * followed by `compact`, which recursively drops null/empty values but preserves
 * `0` and `false`.
 */

import type {
  Block,
  CitationOccurrence,
  CrossRefOccurrence,
  Document,
  DocumentMeta,
  DocumentStats,
  Reference,
  RichText,
  Section,
} from "@argelanderspace/contracts";
import { applyMatches } from "./annotate.js";
import { detectCitations, enrichCitationsWithLinks, ReferenceResolver } from "./citations.js";
import { detectCrossrefs, enrichCrossrefsWithLinks, XrefIndex } from "./crossrefs.js";
import type { MineruArtifacts, MineruContentItem } from "./mineru.js";
import {
  bbox1000ToFrac,
  type LinkAnnot,
  linksOnPage,
  overlapFraction,
  type PdfLinks,
} from "./pdf-links.js";
import { parseReferences } from "./references.js";
import { buildStructure } from "./structure.js";
import { applyTextfix, type PdfTextProvider } from "./textfix.js";
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

// --------------------------------------------------------------------------- //
// build_document (pipeline.py, pure stages only)
// --------------------------------------------------------------------------- //

/** Filesystem identity of the source PDF (what the Python pipeline derives from pdf_path). */
export interface PdfSourceInfo {
  /** `Path(pdf_path).stem` — becomes the doc id. */
  stem: string;
  path: string;
  filename: string;
}

export interface BuildDocumentConfig {
  /** Harvested PDF link annotations resolve citations/xrefs authoritatively (default true). */
  usePdfLinks?: boolean;
  /** Repair MinerU '?'-gaps from the PDF text layer before tokenizing (default true).
   *  Without a `pdfText` provider this records zeroed stats, mirroring the Python
   *  "cannot open the PDF -> skip" path. */
  useTextfix?: boolean;
  mineru?: {
    modelVersion?: string;
    language?: string;
    isOcr?: boolean | null;
  };
  /** Port for the PDF text layer; when absent, textfix is a recorded no-op. */
  pdfText?: PdfTextProvider;
}

/**
 * Assemble a Document from already-extracted artifacts.
 *
 * Separated from the MinerU/PDF-fetching pipeline so the offline parsing stages can
 * be exercised without any external service.
 */
export function buildDocument(
  mineru: MineruArtifacts,
  pdf: PdfSourceInfo,
  pdfLinks: PdfLinks | null,
  config: BuildDocumentConfig = {}
): Document {
  const usePdfLinks = config.usePdfLinks ?? true;
  const useTextfix = config.useTextfix ?? true;

  const structure = buildStructure(mineru.contentList);
  const references = parseReferences(structure.refTextItems);

  const nPages = pdfLinks ? pdfLinks.nPages : maxPage(mineru.contentList);
  // meta.title: Python stores None when no level-1 heading was seen; "" compacts
  // away identically and satisfies the contract type.
  const meta: DocumentMeta = {
    title: structure.titleGuess ?? "",
    mineru: {
      model_version: config.mineru?.modelVersion ?? "vlm",
      language: config.mineru?.language ?? "en",
      is_ocr: config.mineru?.isOcr ?? undefined,
      batch_id: mineru.batchId ?? undefined,
    },
  };
  const doc: Document = {
    doc_id: pdf.stem,
    source: { type: "pdf", path: pdf.path, filename: pdf.filename, n_pages: nPages },
    meta,
    structure: structure.sections,
    references,
  };

  // Repair MinerU '?'-gaps from the PDF text layer *before* tokenizing, so the
  // corrector operates on raw body text (no inline cite/xref tokens yet).
  if (useTextfix) {
    meta.textfix = config.pdfText
      ? applyTextfix(doc, config.pdfText)
      : { gaps_before: 0, gaps_fixed: 0, holders_changed: 0 };
  }

  const resolver = new ReferenceResolver(references);
  const xindex = new XrefIndex(doc);
  annotateDocument(doc, resolver, xindex, pdfLinks, usePdfLinks);
  return doc;
}

function annotateDocument(
  doc: Document,
  resolver: ReferenceResolver,
  xindex: XrefIndex,
  pdfLinks: PdfLinks | null,
  useLinks: boolean
): void {
  for (const block of iterBlocks(doc)) {
    const holders = annotatable(block);
    if (holders.length === 0) continue;
    const blockLinks = useLinks ? linksForBlock(block, pdfLinks) : [];
    for (const holder of holders) {
      if (!holder.text) continue;
      const cmatches = detectCitations(holder.text, resolver);
      const xmatches = detectCrossrefs(holder.text, xindex);
      if (blockLinks.length > 0) {
        enrichCitationsWithLinks(cmatches, blockLinks, resolver);
        enrichCrossrefsWithLinks(xmatches, blockLinks, xindex);
      }
      const result = applyMatches(holder.text, [...cmatches, ...xmatches]);
      holder.text = result.text;
      holder.citations = result.citations;
      holder.crossrefs = result.crossrefs;
    }
  }
}

/** Return the rich-text holders of a block (each has text/citations/crossrefs). */
function annotatable(block: Block): RichText[] {
  if (block.type === "paragraph") return [block];
  if (block.type === "list") return block.items;
  if (block.type === "equation") return [];
  return "caption" in block && block.caption !== undefined ? [block.caption] : [];
}

function linksForBlock(block: Block, pdfLinks: PdfLinks | null): LinkAnnot[] {
  if (pdfLinks === null || block.page_idx === undefined) return [];
  const bbox = bbox1000ToFrac(block.bbox);
  if (bbox === undefined) return [];
  return linksOnPage(pdfLinks, block.page_idx).filter((ln) => overlapFraction(ln.rect, bbox) > 0.5);
}

function maxPage(contentList: MineruContentItem[]): number {
  const pages = contentList
    .map((it) => it.page_idx)
    .filter((p): p is number => typeof p === "number");
  return pages.length > 0 ? Math.max(...pages) + 1 : 0;
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
