// Types for the ArgelanderSpace literature manager. These mirror the eventual
// /api/library/* contract; until the backend lands the same shapes are served
// from the ported fixture (see fixture.ts).

// A node in the citation graph. Saved works carry `ref` (their library id);
// suggested works don't. `c` = citation count (node radius), `y` = year (hue).
export interface GraphNode {
  id: string; // canonical work id (cite key for suggested papers)
  ref?: string; // library ref id, when this node is a saved work
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
  doc_id?: string; // reader doc id, when this work is ingested (→ open in 文档)
  citedBy?: number;
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

// Response of POST /api/library/refs (add-to-library).
export interface AddRefResponse {
  ref: LibraryRef;
}
