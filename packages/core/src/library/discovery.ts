/**
 * Stage 14 ADS literature discovery (core): the `AdsDiscoverySource` port and
 * the pure assembly behind `GET /api/library/discovery`.
 *
 * Boundary rules (stage plan §3):
 * - core owns provider orchestration and domain-graph assembly ONLY — it
 *   knows nothing about ADS URLs, Solr query escaping, token storage, cache
 *   paths, HTTP status codes, or response JSON shapes (those live in infra);
 * - no filesystem writes: Discovery is a read-only derived projection — it
 *   never writes `library.json` / `graph.json` and never mutates the supplied
 *   `LibraryStore` (the store is a membership snapshot, nothing more);
 * - no HTTP status logic (the server maps outcomes/failures).
 *
 * Query sequence (stage plan §5): exact seed → `similar(seed)` top N →
 * `useful()` over the EXACT related bibcodes returned (never on the seed
 * directly, never as a nested parallel similar()). `useful` failure after a
 * successful `similar` degrades to a `useful_unavailable` warning; `similar`
 * failure is fatal (propagates). An aborted signal always propagates.
 */

import type {
  DiscoveryEdge,
  DiscoveryGraph,
  DiscoveryPaper,
  DiscoveryRole,
  DiscoveryWarning,
} from "@argelanderspace/contracts";
import { compareEdges, type Edge } from "./graph.js";
import { type LibraryStore, normDoi } from "./store.js";

/** Server constants, not user-tunable query parameters (V1). */
export const RELATED_LIMIT = 18;
export const USEFUL_LIMIT = 6;

// --------------------------------------------------------------------------- //
// Port
// --------------------------------------------------------------------------- //

/** One normalized ADS record as the discovery assembly needs it. */
export interface AdsDiscoveryRecord {
  bibcode: string;
  title: string;
  /** Display-preserving author strings (not reduced to family names). */
  authors: string[];
  year: number | null;
  venue: string | null;
  abstract: string | null;
  citation_count: number | null;
  doi: string | null;
  arxiv_id: string | null;
  /** ADS bibcodes this work cites (edge derivation input; never wire-exposed). */
  references: string[];
}

/**
 * The discovery-only ADS port (interface segregation: the metadata-chain
 * `AdsSource` is NOT expanded for discovery).
 */
export interface AdsDiscoverySource {
  /** Exact seed lookup; null when ADS has no such record. */
  getByBibcode(bibcode: string, signal?: AbortSignal): Promise<AdsDiscoveryRecord | null>;
  /** Topically related papers in ADS return order (≤ limit). */
  similar(bibcode: string, limit: number, signal?: AbortSignal): Promise<AdsDiscoveryRecord[]>;
  /** Methods/foundations repeatedly cited by the given set, ADS order (≤ limit). */
  useful(
    bibcodes: readonly string[],
    limit: number,
    signal?: AbortSignal
  ): Promise<AdsDiscoveryRecord[]>;
}

// --------------------------------------------------------------------------- //
// Library membership overlay (display-only; upsert() stays the dedup authority)
// --------------------------------------------------------------------------- //

export interface LibraryMembership {
  byBibcode: Map<string, string>;
  byDoi: Map<string, string>;
}

/** Index the snapshot once per request (first work wins on collision). */
export function libraryMembership(store: LibraryStore): LibraryMembership {
  const byBibcode = new Map<string, string>();
  const byDoi = new Map<string, string>();
  for (const w of store.works) {
    if (w.bibcode && !byBibcode.has(w.bibcode)) byBibcode.set(w.bibcode, w.id);
    const d = normDoi(w.doi);
    if (d && !byDoi.has(d)) byDoi.set(d, w.id);
  }
  return { byBibcode, byDoi };
}

/**
 * Conservative match: exact stored ADS bibcode, then normalized DOI when both
 * sides have one. NO fuzzy title matching — a false negative is tolerable
 * (the authoritative add path returns `exists`); a false positive would
 * discourage saving a distinct paper.
 */
export function matchLibraryId(
  m: LibraryMembership,
  bibcode: string,
  doi: string | null
): string | null {
  const hit = m.byBibcode.get(bibcode);
  if (hit) return hit;
  const d = normDoi(doi);
  return d ? (m.byDoi.get(d) ?? null) : null;
}

// --------------------------------------------------------------------------- //
// Node merge (deterministic: seed → related by rank → useful-only by rank)
// --------------------------------------------------------------------------- //

function toPaper(
  rec: AdsDiscoveryRecord,
  roles: DiscoveryRole[],
  ranks: { relatedRank?: number; usefulRank?: number },
  membership: LibraryMembership
): DiscoveryPaper {
  return {
    bibcode: rec.bibcode,
    title: rec.title,
    authors: rec.authors,
    year: rec.year,
    venue: rec.venue,
    abstract: rec.abstract,
    citationCount: rec.citation_count,
    doi: rec.doi,
    arxivId: rec.arxiv_id,
    roles,
    ...ranks,
    libraryId: matchLibraryId(membership, rec.bibcode, rec.doi),
  };
}

/**
 * Merge seed + related + useful into wire-order nodes. A paper in both result
 * sets collapses to ONE node with both roles/ranks (sits at its related
 * position); either set returning the seed leaves the seed as `["seed"]`.
 */
export function mergeDiscoveryNodes(
  seed: AdsDiscoveryRecord,
  related: readonly AdsDiscoveryRecord[],
  useful: readonly AdsDiscoveryRecord[],
  membership: LibraryMembership
): DiscoveryPaper[] {
  const nodes: DiscoveryPaper[] = [];
  const byBibcode = new Map<string, DiscoveryPaper>();

  const seedNode = toPaper(seed, ["seed"], {}, membership);
  nodes.push(seedNode);
  byBibcode.set(seed.bibcode, seedNode);

  related.forEach((rec, i) => {
    if (rec.bibcode === seed.bibcode || byBibcode.has(rec.bibcode)) return;
    const node = toPaper(rec, ["related"], { relatedRank: i + 1 }, membership);
    nodes.push(node);
    byBibcode.set(rec.bibcode, node);
  });

  useful.forEach((rec, i) => {
    if (rec.bibcode === seed.bibcode) return;
    const existing = byBibcode.get(rec.bibcode);
    if (existing) {
      existing.roles.push("useful");
      existing.usefulRank = i + 1;
      return;
    }
    const node = toPaper(rec, ["useful"], { usefulRank: i + 1 }, membership);
    nodes.push(node);
    byBibcode.set(rec.bibcode, node);
  });

  return nodes;
}

// --------------------------------------------------------------------------- //
// Citation edge derivation (the ONLY edge source; roles never create edges)
// --------------------------------------------------------------------------- //

/**
 * For every visible paper A and each bibcode B in A.references: emit A → B
 * when B is visible and B ≠ A. Exact duplicates removed; deterministic order
 * (same tuple comparison as the Library graph). Disconnected nodes are valid
 * and preserved — no edges are invented for connectivity.
 */
export function discoveryEdges(records: readonly AdsDiscoveryRecord[]): DiscoveryEdge[] {
  const visible = new Set(records.map((r) => r.bibcode));
  const seen = new Set<string>();
  const tuples: Edge[] = [];
  for (const r of records) {
    for (const ref of r.references) {
      if (ref === r.bibcode || !visible.has(ref)) continue;
      const key = `${r.bibcode}${ref}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tuples.push([r.bibcode, ref]);
    }
  }
  tuples.sort(compareEdges);
  return tuples.map(([from, to]) => ({ from, to, kind: "citation" as const }));
}

// --------------------------------------------------------------------------- //
// Orchestration
// --------------------------------------------------------------------------- //

export interface DiscoverLiteratureDeps {
  ads: AdsDiscoverySource;
  store: LibraryStore;
}

export interface DiscoverLiteratureOptions {
  signal?: AbortSignal;
  /** Test seams; production uses the server constants. */
  relatedLimit?: number;
  usefulLimit?: number;
}

/**
 * Assemble one discovery graph. Returns null when ADS has no such seed
 * (the server maps that to 404). Provider failures propagate, EXCEPT a
 * `useful()` failure after a successful `similar()` — that degrades to a
 * partial graph with a `useful_unavailable` warning. Zero related results
 * skip the useful call entirely (seed-only graph).
 */
export async function discoverLiterature(
  seedBibcode: string,
  deps: DiscoverLiteratureDeps,
  opts: DiscoverLiteratureOptions = {}
): Promise<DiscoveryGraph | null> {
  const { ads, store } = deps;
  const signal = opts.signal;

  const seed = await ads.getByBibcode(seedBibcode, signal);
  if (!seed) return null;

  const related = await ads.similar(seedBibcode, opts.relatedLimit ?? RELATED_LIMIT, signal);

  let useful: AdsDiscoveryRecord[] = [];
  const warnings: DiscoveryWarning[] = [];
  if (related.length > 0) {
    try {
      useful = await ads.useful(
        related.map((r) => r.bibcode),
        opts.usefulLimit ?? USEFUL_LIMIT,
        signal
      );
    } catch (err) {
      if (signal?.aborted) throw err;
      warnings.push({ code: "useful_unavailable" });
    }
  }

  const membership = libraryMembership(store);
  const nodes = mergeDiscoveryNodes(seed, related, useful, membership);
  const edges = discoveryEdges([seed, ...related, ...useful]);

  return {
    version: 1,
    provider: "ads",
    seed: seed.bibcode,
    nodes,
    edges,
    warnings,
  };
}
