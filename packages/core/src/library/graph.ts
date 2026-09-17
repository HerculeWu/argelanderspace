/**
 * Build the citation graph + API projections from enriched library works
 * (bibgraph/library/graph.py).
 *
 * **Stage 14: the Library graph is saved-only** (the global suggested-node
 * recommendation architecture is retired — ADS Discovery replaces it). Nodes
 * are exactly the saved works; edges are real citation links between them,
 * unioned from two local sources:
 * - **OpenAlex** `referenced_works` already stored on the works (no network);
 * - **offline** — each ingested paper's own parsed bibliography matched
 *   against the saved set.
 *
 * After enrichment the build is therefore pure/local: no candidate pool, no
 * metadata fetch for suggestions, no cited_by_count ranking, no cap.
 *
 * Port notes (bug-for-bug):
 * - Python's `_saved_node` emits explicit `null`s (the graph JSON is dumped
 *   un-compacted) — kept.
 * - Python's `sorted(links)` orders (a, b) tuples lexicographically; the TS
 *   port compares element-wise to the same effect.
 */

import {
  CURRENT_GRAPH_VERSION,
  type GraphData,
  type GraphNode,
  type LibraryRef,
} from "@argelanderspace/contracts";
import { pyOr } from "../documents/pyregex.js";
import { docReferenceIds } from "./seed.js";
import {
  displayAuthors,
  identityKeys,
  type LibraryStore,
  normArxiv,
  normDoi,
  normTitle,
  slug,
  type Work,
} from "./store.js";

// --------------------------------------------------------------------------- //
// Enrichment helpers
// --------------------------------------------------------------------------- //

/** 1→'a', 26→'z', 27→'aa', … (always [a-z], no overflow past 'z'). */
function suffix(n: number): string {
  let s = "";
  let k = n;
  while (k > 0) {
    const r = (k - 1) % 26;
    k = Math.floor((k - 1) / 26);
    s = String.fromCharCode(97 + r) + s;
  }
  return s;
}

/** `_cite_key`: family-name + year base, disambiguated with {@link suffix}. */
export function citeKey(w: Work, used: Set<string>): string {
  let fam = (w.authors.length > 0 ? (w.authors[0] as string) : slug(w.title, 12)).toLowerCase();
  // Python str.isalnum() is Unicode-aware
  fam = [...fam].filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("") || "ref";
  const base = `${fam}${w.year || ""}`;
  let key = base;
  let n = 0;
  while (used.has(key)) {
    n += 1;
    key = base + suffix(n);
  }
  used.add(key);
  return key;
}

/**
 * Stage 12 cite-key assignment: a work WITH an ADS bibcode takes the bibcode
 * itself as its key — the bibcode is the permanent ADS identifier, so the key
 * needs no family/year disambiguation and is stable by design. Works without a
 * bibcode keep the family+year scheme. An assigned key NEVER changes (Stage 7
 * contract), including works that only gain a bibcode on a later rebuild.
 */
export function assignCiteKey(w: Work, used: Set<string>): string {
  if (w.bibcode && !used.has(w.bibcode)) {
    used.add(w.bibcode);
    return w.bibcode;
  }
  return citeKey(w, used);
}

// --------------------------------------------------------------------------- //
// Offline edges (saved ↔ saved from the ingested bibliographies)
// --------------------------------------------------------------------------- //

/** Directed edge between two node ids. */
export type Edge = readonly [string, string];

function edgeKey([a, b]: Edge): string {
  return `${a}\u0001${b}`;
}

/** Compare edges as Python compares tuples: by first, then second element. */
export function compareEdges(x: Edge, y: Edge): number {
  if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  return 0;
}

export function offlineEdges(store: LibraryStore, outputDir: string): Edge[] {
  const key2wid = new Map<string, string>();
  for (const w of store.works) {
    for (const k of identityKeys(w)) key2wid.set(k, w.id);
  }
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const w of store.works) {
    for (const docId of w.doc_ids) {
      for (const r of docReferenceIds(docId, outputDir)) {
        const cks = new Set<string>();
        const rDoi = typeof r.doi === "string" ? r.doi : null;
        if (rDoi) cks.add(`doi:${normDoi(rDoi) || ""}`);
        const rArxiv = typeof r.arxiv_id === "string" ? r.arxiv_id : null;
        if (rArxiv) cks.add(`arxiv:${normArxiv(rArxiv) || ""}`);
        const rTitle = typeof r.title === "string" ? r.title : null;
        if (rTitle) {
          const nt = normTitle(rTitle);
          if (nt.length > 12) cks.add(`title:${nt}`); // avoid spurious short-title collisions
        }
        for (const ck of cks) {
          const tgt = key2wid.get(ck);
          if (tgt && tgt !== w.id) {
            const e: Edge = [w.id, tgt];
            if (!seen.has(edgeKey(e))) {
              seen.add(edgeKey(e));
              edges.push(e);
            }
          }
        }
      }
    }
  }
  return edges;
}

// --------------------------------------------------------------------------- //
// Graph assembly
// --------------------------------------------------------------------------- //

function savedNode(w: Work): GraphNode {
  return {
    id: w.id,
    ref: w.id,
    y: w.year || 2024,
    c: w.cited_by_count || 0,
    a: displayAuthors(w.authors) || (w.title ? w.title.slice(0, 24) : w.id),
    v: w.venue || "",
    t: w.title || w.id,
    doi: w.doi,
    arxiv_id: w.arxiv_id,
    doc_id: w.doc_ids.length > 0 ? (w.doc_ids[0] as string) : null,
  };
}

export function buildGraph(store: LibraryStore, outputDir: string): GraphData {
  const oaid2node = new Map<string, string>();
  const nodes: GraphNode[] = [];
  for (const w of store.works) {
    nodes.push(savedNode(w));
    if (w.openalex_id) oaid2node.set(w.openalex_id, w.id);
  }

  const linkSeen = new Set<string>();
  const links: Edge[] = [];
  const addLink = (e: Edge): void => {
    if (!linkSeen.has(edgeKey(e))) {
      linkSeen.add(edgeKey(e));
      links.push(e);
    }
  };

  // saved → saved, from the OpenAlex references already stored on the works
  for (const w of store.works) {
    for (const r of w.referenced_works) {
      const tgt = oaid2node.get(r);
      if (tgt && tgt !== w.id) addLink([w.id, tgt]);
    }
  }
  // saved → saved, from the ingested bibliographies (guaranteed regardless of OpenAlex)
  for (const e of offlineEdges(store, outputDir)) addLink(e);

  links.sort(compareEdges);
  return { version: CURRENT_GRAPH_VERSION, nodes, links: links.map(([a, b]) => [a, b]) };
}

// --------------------------------------------------------------------------- //
// API projections
// --------------------------------------------------------------------------- //

export function workToRef(w: Work): LibraryRef {
  // required fields (the TS LibraryRef declares these non-optional) are always
  // present — never stripped — so the frontend can rely on e.g. r.authors.
  const ref: LibraryRef = {
    id: w.id,
    title: w.title || w.id,
    authors: displayAuthors(w.authors),
    year: w.year || 0,
    venue: w.venue || "",
    type: w.type as "article" | "conf", // verbatim (contract enum; only these two occur)
    cite: (pyOr(w.cite_key) as string | undefined) ?? slug(w.id),
    tags: w.tags,
    pdf: w.doc_ids.length > 0,
    read: w.read,
    star: w.star,
  };
  const acq = w.acquisition ?? {};
  const optional: Record<string, unknown> = {
    abstract: w.abstract,
    note: w.note,
    doi: w.doi,
    arxiv_id: w.arxiv_id,
    // Stage 14: presence enables the web "explore related papers" action
    bibcode: w.bibcode,
    doc_id: w.doc_ids.length > 0 ? w.doc_ids[0] : null,
    // all versions (Stage 7 MS3): doc_ids[0] IS the main doc (same as doc_id)
    doc_ids: w.doc_ids.length > 0 ? w.doc_ids : null,
    citedBy: w.cited_by_count,
    label: w.label,
    journal: w.journal,
    // acquisition: which full-text source is planned + whether it's ready now
    source: acq.chosen,
    sourceLabel: acq.chosen_label,
    sourceStatus: acq.status,
    sourceReady: acq.ready,
    // bot-walled & no auto source → the UI offers a PDF upload
    needs_upload: pyOr(acq.needs_upload) ?? null,
    // resolution: which provider supplied the citation count (ads/crossref/openalex)
    resolvedBy: w.resolution?.count,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v !== null && v !== undefined && v !== "") {
      (ref as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return ref;
}

// --------------------------------------------------------------------------- //
// Incremental update (Stage 13)
// --------------------------------------------------------------------------- //

/**
 * Merge one manually added work into an existing graph (Stage 13; Stage 14:
 * saved-only): its saved node plus every locally computable saved↔saved edge
 * (inbound from saved works whose `referenced_works` contain it, outbound to
 * saved works it cites). No OpenAlex candidate fetch for suggested
 * neighbours — those no longer exist.
 *
 * This is a best-effort immediate view, not a rebuild: offline
 * (parsed-bibliography) edges are only computed by {@link buildGraph}, so the
 * next `library build`/refresh converges the graph to authoritative. Callers
 * treat failure as non-fatal (the work is already saved; the graph catches up
 * on the next refresh).
 */
export function mergeWorkIntoGraph(graph: GraphData, store: LibraryStore, w: Work): GraphData {
  const nodes: GraphNode[] = graph.nodes.filter((n) => n.id !== w.id);
  nodes.push(savedNode(w));

  const oaid2node = new Map<string, string>();
  for (const x of store.works) if (x.openalex_id) oaid2node.set(x.openalex_id, x.id);

  const links: [string, string][] = graph.links.map(([a, b]) => [a, b]);
  const seen = new Set(links.map(edgeKey));
  const add = (e: [string, string]): void => {
    if (e[0] !== e[1] && !seen.has(edgeKey(e))) {
      seen.add(edgeKey(e));
      links.push(e);
    }
  };

  // inbound: saved works that cite the new one
  if (w.openalex_id) {
    for (const x of store.works) {
      if (x.id !== w.id && x.referenced_works.includes(w.openalex_id)) add([x.id, w.id]);
    }
  }
  // outbound: saved works the new one cites
  for (const r of w.referenced_works) {
    const tgt = oaid2node.get(r);
    if (tgt) add([w.id, tgt]);
  }

  links.sort(compareEdges);
  return { version: CURRENT_GRAPH_VERSION, nodes, links };
}
