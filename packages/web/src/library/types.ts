// Types for the ArgelanderSpace literature manager. These mirror the eventual
// /api/library/* contract; until the backend lands the same shapes are served
// from the ported fixture (see fixture.ts).

// A node in the citation graph — a saved work (Stage 14: the Library graph is
// saved-only; ref-less "suggested" nodes are retired). `c` = citation count
// (node radius), `y` = year (hue).
export interface GraphNode {
  id: string; // canonical work id
  ref?: string; // library ref id (always set for saved-only graphs)
  y: number; // year
  c: number; // approx. citation count
  a: string; // short author string, e.g. "Dieleman et al."
  v: string; // venue, e.g. "MNRAS"
  t: string; // title
  doi?: string;
  arxiv_id?: string;
  doc_id?: string; // reader doc id, when ingested
}

export type GraphLink = [string, string];

export interface GraphData {
  version?: number; // CURRENT_GRAPH_VERSION on fresh payloads (Stage 14)
  nodes: GraphNode[];
  links: GraphLink[];
}

// A saved reference (Zotero-like record).
export interface LibraryRef {
  id: string;
  title: string;
  authors: string; // display string, e.g. "Dieleman, Willett & Dambre"
  year: number;
  venue: string;
  type: "article" | "conf";
  cite: string; // bibtex key
  tags: string[];
  pdf: boolean;
  read: boolean;
  note?: string; // full note text (absent when unset)
  star: boolean;
  abstract?: string;
  doi?: string;
  arxiv_id?: string;
  doc_id?: string; // reader doc id, when this work is ingested (→ open in the doc view); the main doc
  doc_ids?: string[]; // all reader docs (versions); doc_ids[0] = main (Stage 7 MS3)
  citedBy?: number;
  bibcode?: string; // ADS bibcode; enables "explore related papers" (Stage 14)
  label?: string; // color-label key (red|amber|green|blue|violet)
  // acquisition: where the full text is / would come from (planner output)
  journal?: string; // short label, e.g. "A&A"
  source?: string; // chosen tier: journal_html | journal_pdf | arxiv_latex | ads_scan
  sourceLabel?: string; // human label, e.g. "A&A HTML"
  sourceStatus?: string; // ready | blocked | needs_adapter | needs_access
  sourceReady?: string; // top tier fetchable now, if any
  needs_upload?: boolean; // bot-walled & no auto source → user must upload a source package (MS2: LaTeX zip)
  resolvedBy?: string; // citation-count provenance: ads | crossref | openalex
}

export interface LibraryProject {
  name: string;
  short?: string;
  field?: string;
}

export interface LibraryData {
  project: LibraryProject;
  refs: LibraryRef[];
  tags: string[];
  graph: GraphData;
}

// ---- Stage 13: manual work creation (POST /api/library/works) ---- //

export type ManualWorkRequest =
  | { mode: "identifier"; value: string }
  | { mode: "bibcode"; bibcode: string }
  | { mode: "bib"; bib: string };

export interface ManualWorkResult {
  status: "created" | "exists" | "error";
  ref?: LibraryRef;
  key?: string;
  error?: string;
}

export interface ManualWorkResponse {
  results: ManualWorkResult[];
}
