// Mirrors the structured JSON produced by the bibgraph ingestion pipeline
// (see bibgraph/schema.py).

export interface RichText {
  text: string; // carries inline tokens [[cite:ref-N]] / [[xref:fig-N]] and $math$
  citations?: Citation[];
  crossrefs?: CrossRef[];
}
export type Caption = RichText | string | null;

export interface BlockBase {
  id: string;
  page_idx: number;
  bbox?: number[];
}
export interface Paragraph extends BlockBase {
  type: "paragraph";
  text: string;
}
export interface Equation extends BlockBase {
  type: "equation";
  latex: string;
  number?: string;
}
export interface Figure extends BlockBase {
  type: "figure";
  number?: string;
  label?: string;
  caption?: Caption;
  img_path?: string;
  chart_type?: string;
  content?: string;
}
export interface TableBlock extends BlockBase {
  type: "table";
  number?: string;
  label?: string;
  caption?: Caption;
  footnote?: string;
  table_body: string; // HTML
  img_path?: string;
}
export interface ListBlock extends BlockBase {
  type: "list";
  ordered: boolean;
  items: { text: string; citations?: Citation[]; crossrefs?: CrossRef[] }[];
}
export interface CodeBlock extends BlockBase {
  type: "code" | "algorithm";
  code?: string;
  text?: string;
  caption?: Caption;
  number?: string;
  label?: string;
}

export type Block =
  | Paragraph
  | Equation
  | Figure
  | TableBlock
  | ListBlock
  | CodeBlock;

export interface Section {
  id: string;
  type: "section";
  level: number;
  heading: string;
  heading_raw?: string;
  number?: string;
  page_idx: number;
  bbox?: number[];
  blocks?: Block[]; // absent when a section has only sub-sections (compacted out)
  children?: Section[];
}

export interface Reference {
  id: string;
  raw: string;
  authors?: string[];
  year?: number;
  title?: string;
  venue?: string;
  volume?: string;
  pages?: string;
  doi?: string;
  arxiv_id?: string;
  url?: string;
  keys?: string[];
}

export interface Citation {
  ref_ids?: string[];
  raw: string;
  via: string;
  resolved: boolean;
  block_id?: string;
  in?: string;
  doi?: string;
  url?: string;
}

export interface CrossRef {
  kind: "figure" | "table" | "equation" | "section" | "algorithm" | "code";
  raw: string;
  target_id?: string;
  number?: string;
  via: string;
  resolved: boolean;
  block_id?: string;
  in?: string;
  target_page?: number;
  url?: string;
}

export interface IndexFloat {
  id: string;
  page_idx: number;
  number?: string;
  label?: string;
  caption?: string;
}
export interface IndexSection {
  id: string;
  level: number;
  number?: string;
  heading: string;
  page_idx: number;
}

export interface Doc {
  doc_id: string;
  source: { type: string; path: string; filename: string; n_pages: number };
  meta: { title: string; mineru?: Record<string, unknown> };
  structure: Section[];
  index: {
    figures: IndexFloat[];
    tables: IndexFloat[];
    equations: IndexFloat[];
    sections: IndexSection[];
  };
  references: Reference[];
  citations: Citation[];
  crossrefs: CrossRef[];
  stats: Record<string, number>;
}
