/**
 * Build the citation graph + API projections from enriched library works
 * (bibgraph/library/graph.py).
 *
 * Nodes = papers (saved works + suggested neighbours), edges = citation links.
 * Edges come from two sources, unioned:
 * - **OpenAlex** `referenced_works` — the broad network (saved→neighbour,
 *   neighbour→neighbour, and saved→saved when OpenAlex matched the bibliography);
 * - **offline** — each ingested paper's own parsed bibliography matched against
 *   the saved set (guarantees the saved↔saved edges regardless of OpenAlex).
 *
 * Suggested neighbours are the most-cited works referenced by the library, capped
 * so the payload stays small; the frontend's depth/count sliders filter further.
 *
 * Port notes (bug-for-bug):
 * - Python's `_saved_node` emits explicit `null`s (the graph JSON is dumped
 *   un-compacted); `_suggested_node` omits `ref`/`arxiv_id`/`doc_id` — kept.
 * - Python's `sorted(links)` orders (a, b) tuples lexicographically; the TS port
 *   compares element-wise to the same effect.
 * - Python's `log.info` lines are dropped (logging is not ported).
 */

import type { GraphData, GraphNode, LibraryRef } from "@argelanderspace/contracts";
import { pyOr } from "../documents/pyregex.js";
import { docReferenceIds } from "./seed.js";
import type { OpenAlexResolution, OpenAlexSource } from "./sources.js";
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

const MAX_SUGGEST = 120;

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

function suggestedNode(m: OpenAlexResolution): GraphNode {
  const oaid = m.openalex_id as string;
  return {
    id: `oa:${oaid}`,
    y: m.year as number,
    c: m.cited_by_count || 0,
    a: displayAuthors(m.authors) || (m.title ? m.title.slice(0, 24) : oaid),
    v: m.venue || "",
    t: m.title || oaid,
    doi: m.doi,
  };
}

export async function buildGraph(
  store: LibraryStore,
  oa: OpenAlexSource,
  outputDir: string
): Promise<GraphData> {
  const oaid2node = new Map<string, string>();
  const nodes: GraphNode[] = [];
  for (const w of store.works) {
    nodes.push(savedNode(w));
    if (w.openalex_id) oaid2node.set(w.openalex_id, w.id);
  }

  const savedOa = new Set(
    store.works.map((w) => w.openalex_id).filter((x): x is string => x !== null)
  );
  const pool = new Set<string>();
  for (const w of store.works) {
    for (const r of w.referenced_works) pool.add(r);
  }
  for (const s of savedOa) pool.delete(s);

  const meta =
    pool.size > 0 ? await oa.fetchMany([...pool].sort()) : new Map<string, OpenAlexResolution>();
  const cands = [...meta.values()]
    .filter((m) => pyOr(m.year) !== undefined)
    .sort((a, b) => (b.cited_by_count || 0) - (a.cited_by_count || 0))
    .slice(0, MAX_SUGGEST);
  for (const c of cands) {
    const nid = `oa:${c.openalex_id}`;
    oaid2node.set(c.openalex_id as string, nid);
    nodes.push(suggestedNode(c));
  }

  const linkSeen = new Set<string>();
  const links: Edge[] = [];
  const addLink = (e: Edge): void => {
    if (!linkSeen.has(edgeKey(e))) {
      linkSeen.add(edgeKey(e));
      links.push(e);
    }
  };
  const addRefs = (refs: readonly string[] | null | undefined, srcNode: string): void => {
    for (const r of refs ?? []) {
      const tgt = oaid2node.get(r);
      if (tgt && tgt !== srcNode) addLink([srcNode, tgt]);
    }
  };

  for (const w of store.works) addRefs(w.referenced_works, w.id);
  for (const c of cands) addRefs(c.referenced_works, `oa:${c.openalex_id}`);
  for (const e of offlineEdges(store, outputDir)) addLink(e);

  // keep only nodes that are saved or actually connected
  const connected = new Set<string>();
  for (const [a, b] of links) {
    connected.add(a);
    connected.add(b);
  }
  const savedIds = new Set(store.works.map((w) => w.id));
  const kept = nodes.filter((n) => savedIds.has(n.id) || connected.has(n.id));
  const keptIds = new Set(kept.map((n) => n.id));
  const keptLinks = links.filter(([a, b]) => keptIds.has(a) && keptIds.has(b));

  keptLinks.sort(compareEdges);
  return { nodes: kept, links: keptLinks.map(([a, b]) => [a, b]) };
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
