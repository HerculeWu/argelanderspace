/**
 * Orchestrate the library: seed → enrich → graph, and serve the API payload
 * (bibgraph/library/build.py).
 *
 * `rebuild()` (re)generates everything from `data/output/` + the network and
 * writes `library.json` + `cache/graph.json`. `libraryPayload()` composes the
 * frontend's `/api/library` response from those files (no network).
 *
 * Port notes (bug-for-bug):
 * - Python creates the ADS/Crossref/OpenAlex clients inside `rebuild`; the TS
 *   port takes them as an injected {@link MetadataSources} (the clients are M2
 *   infra). `enrichRemote` is applied by the caller when constructing them.
 * - Python's `_WRITE_LOCK` (a threading.Lock serializing load→mutate→save) is
 *   not ported: TS is single-threaded, and M4's serial job runner (decisions
 *   13/16) provides the same mutual exclusion around `rebuild` vs `patchWork`.
 * - `graph.json` is written with `JSON.stringify` (compact, no spaces) whereas
 *   Python's `json.dumps(ensure_ascii=False)` uses `", "`/`": "` separators —
 *   content-identical after parse, not byte-identical (documented divergence;
 *   the file is a cache, only ever read back with `JSON.parse`).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
  GraphData,
  LibraryPayload,
  LibraryRef,
  RefreshResponse,
} from "@argelanderspace/contracts";
import { parseBibtex } from "../acquire/bibtex.js";
import { classify, planToDict } from "../acquire/planner.js";
import { addBibRecords, enrichAndPlan, planFor } from "../acquire/run.js";
import { pyOr, pyTruthy } from "../documents/pyregex.js";
import { buildGraph, citeKey, workToRef } from "./graph.js";
import { seedFromOutput } from "./seed.js";
import type { CrossrefResolution, CrossrefSource, MetadataSources } from "./sources.js";
import {
  canonicalId,
  emptyWork,
  type LibraryPaths,
  LibraryStore,
  normDoi,
  type Work,
} from "./store.js";

/** Options for {@link rebuild} / {@link acquireReferences}. */
export interface RebuildOptions {
  /** The resolution-chain sources (M2 infra), pre-configured with enablement. */
  sources: MetadataSources;
  /** Optional `.bib` file whose entries are added before enriching. */
  bibPath?: string | null;
}

/**
 * Rebuild from ingested papers (+ optional `.bib`) through the resolution
 * chain (ADS▸Crossref▸OpenAlex) and the source planner. Returns a summary.
 */
export async function rebuild(paths: LibraryPaths, opts: RebuildOptions): Promise<RefreshResponse> {
  const store = LibraryStore.load(paths);
  seedFromOutput(store, paths.outputDir);
  let nBib = 0;
  if (opts.bibPath) {
    const records = parseBibtex(opts.bibPath);
    addBibRecords(store, records);
    nBib = records.length;
  }
  await enrichAndPlan(store, opts.sources);
  const graph = await buildGraph(store, opts.sources.oa, paths.outputDir);
  store.save(paths);
  mkdirSync(paths.cacheDir, { recursive: true });
  writeFileSync(paths.graphJson, JSON.stringify(graph), "utf8");
  return {
    works: store.works.length,
    bib_entries: nBib,
    saved_nodes: graph.nodes.filter((n) => n.ref).length,
    nodes: graph.nodes.length,
    links: graph.links.length,
    ads_status: opts.sources.ads.status,
    acquisition: acquisitionSummary(store),
    resolution: resolutionSummary(store),
  };
}

/** Add every entry of *bibPath* to the library (resolve + plan + graph). */
export async function acquireReferences(
  paths: LibraryPaths,
  bibPath: string,
  opts: Omit<RebuildOptions, "bibPath">
): Promise<RefreshResponse> {
  return rebuild(paths, { ...opts, bibPath });
}

/** `dict(Counter(...))`: first-seen order; JSON key semantics for bool/number keys. */
function tally(values: unknown[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) {
    const key =
      v === null || v === undefined
        ? "—"
        : typeof v === "boolean"
          ? v
            ? "true"
            : "false"
          : String(v);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

function acquisitionSummary(store: LibraryStore): RefreshResponse["acquisition"] {
  const acq = store.works.map((w) => (pyOr(w.acquisition) ?? {}) as Record<string, unknown>);
  return {
    chosen: tally(acq.map((a) => a.chosen)),
    ready_now: tally(acq.map((a) => a.ready)),
    status: tally(acq.map((a) => a.status)),
    ingested: acq.filter((a) => pyTruthy(a.ingested_doc)).length,
  };
}

function resolutionSummary(store: LibraryStore): RefreshResponse["resolution"] {
  return {
    count_source: tally(
      store.works.map((w) => ((pyOr(w.resolution) ?? {}) as Record<string, unknown>).count)
    ),
  };
}

export function loadGraph(paths: LibraryPaths): GraphData {
  if (existsSync(paths.graphJson)) {
    try {
      return JSON.parse(readFileSync(paths.graphJson, "utf8")) as GraphData;
    } catch {
      // fall through (Python: except ValueError)
    }
  }
  return { nodes: [], links: [] };
}

/** The /api/library response: project + saved refs + tags + citation graph. */
export function libraryPayload(paths: LibraryPaths): LibraryPayload {
  const store = LibraryStore.load(paths);
  const tags = [...new Set(store.works.flatMap((w) => w.tags))].sort();
  return {
    project: store.project as LibraryPayload["project"],
    refs: store.works.map(workToRef),
    tags,
    graph: loadGraph(paths),
  };
}

/** Persist a suggested graph node as a saved work; return its ref (or null). */
export function addNodeToLibrary(paths: LibraryPaths, nodeId: string): LibraryRef | null {
  const node = loadGraph(paths).nodes.find((n) => n.id === nodeId);
  if (node === undefined) return null;
  const store = LibraryStore.load(paths);
  const oaid = nodeId.startsWith("oa:") ? nodeId.slice(3) : null;
  const venue = (pyOr(node.v) as string | undefined) ?? "";
  let w: Work = {
    ...emptyWork(
      canonicalId({ doi: node.doi, openalex: oaid, title: node.t, year: node.y ?? null })
    ),
    title: node.t ?? "",
    authors: node.a ? [node.a] : [],
    year: node.y ?? null,
    venue: (pyOr(venue) as string | undefined) ?? null,
    type: ["ICLR", "ICML", "NeurIPS", "CVPR", "Proc"].some((k) => venue.includes(k))
      ? "conf"
      : "article",
    doi: node.doi ?? null,
    openalex_id: oaid,
    cited_by_count: node.c ?? null,
    origin: "graph-node",
  };
  w = store.upsert(w);
  if (!w.cite_key) {
    w.cite_key = citeKey(
      w,
      new Set(store.works.map((x) => x.cite_key).filter((x): x is string => x !== null))
    );
  }
  store.save(paths);
  return workToRef(w);
}

/** Result of {@link addDoiWork}. */
export interface AddDoiWorkResult {
  /** The work's API projection (existing or newly created). */
  ref: LibraryRef;
  /** false when the DOI already belonged to a saved work (no fetch, no write). */
  created: boolean;
  /** false when Crossref had no record / was unreachable — a bare stub was saved. */
  enriched: boolean;
}

/**
 * Create a docless library work anchored on a DOI (Stage 7 MS4: CLI `ingest`
 * on a DOI / DOI-carrying publisher URL). Crossref is consulted immediately;
 * when it has no record (or is unreachable) a bare stub is saved instead —
 * the entry is never blocked on the network. No rebuild is triggered (the
 * {@link addNodeToLibrary} precedent): the acquisition plan is stamped
 * locally and the next `library build` runs the full ADS▸Crossref▸OpenAlex
 * chain over the entry.
 */
export async function addDoiWork(
  paths: LibraryPaths,
  doi: string,
  crossref: CrossrefSource
): Promise<AddDoiWorkResult | null> {
  const d = normDoi(doi);
  // normDoi normalizes (case/prefixes) but does not validate the DOI shape.
  if (!d || !/^10\.\d{4,9}\/\S+$/.test(d)) return null;
  const store = LibraryStore.load(paths);
  const existing = store.match(`doi:${d}`);
  if (existing !== undefined) {
    return { ref: workToRef(existing), created: false, enriched: false };
  }
  let c: CrossrefResolution | null = null;
  try {
    c = await crossref.resolve({ doi: d });
  } catch {
    c = null; // a client that throws (instead of returning null) still degrades to a stub
  }
  const [, label] = classify(d, c?.venue ?? null);
  let w: Work = {
    ...emptyWork(canonicalId({ doi: d, title: c?.title ?? null, year: c?.year ?? null })),
    title: c?.title ?? "",
    authors: c ? [...c.authors] : [],
    year: c?.year ?? null,
    venue: (pyOr(label, c?.venue ?? null) as string | undefined) ?? null,
    type: c?.type === "conf" ? "conf" : "article",
    doi: d,
    abstract: c?.abstract ?? null,
    cited_by_count: c?.cited_by_count ?? null,
    origin: "manual",
    journal: (pyOr(label) as string | undefined) ?? null,
  };
  w = store.upsert(w);
  if (!w.cite_key) {
    w.cite_key = citeKey(
      w,
      new Set(store.works.map((x) => x.cite_key).filter((x): x is string => x !== null))
    );
  }
  w.acquisition = planToDict(planFor(w));
  store.save(paths);
  return { ref: workToRef(w), created: true, enriched: c !== null };
}

/** Update per-work user state (label / read / star / tags / note / main doc), validated. */
export function patchWork(
  paths: LibraryPaths,
  workId: string,
  patch: Record<string, unknown>
): boolean {
  const store = LibraryStore.load(paths);
  const w = store.get(workId);
  if (w === undefined) return false;
  // `changed` tracks whether any field was applied; a patch that changes
  // nothing is a side-effect-free no-op (no save, returns false — Stage 7 MS3
  // review N5, so a rejected main-doc switch can't rewrite the store or
  // broadcast library.changed).
  let changed = false;
  // Python `patch.get(k) is not None`: present and non-null.
  if (patch.label !== undefined && patch.label !== null) {
    w.label = String(patch.label).slice(0, 32) || null;
    changed = true;
  }
  if (patch.read !== undefined && patch.read !== null) {
    // Python bool(); JSON `[]`/`{}` diverge (truthy in JS) — the API contract
    // only admits booleans, so this is unreachable in practice.
    w.read = Boolean(patch.read);
    changed = true;
  }
  if (patch.star !== undefined && patch.star !== null) {
    w.star = Boolean(patch.star);
    changed = true;
  }
  if (patch.note !== undefined && patch.note !== null) {
    w.note = String(patch.note).slice(0, 10000) || null;
    changed = true;
  }
  if (patch.tags !== undefined && patch.tags !== null && Array.isArray(patch.tags)) {
    w.tags = patch.tags.map((t) => String(t).slice(0, 64)).slice(0, 64);
    changed = true;
  }
  // Main-doc switch (Stage 7 MS3): the main doc is `doc_ids[0]`, so "set main"
  // moves the named doc to the front. The order then survives rebuilds: the
  // seed merge keeps the existing work's doc_ids order and only appends
  // genuinely new docs (mergeInto: dst first). A doc the work does not hold —
  // or one that already IS the main doc — changes nothing (no-op per N5).
  if (patch.doc_id !== undefined && patch.doc_id !== null) {
    const d = String(patch.doc_id);
    if (w.doc_ids.indexOf(d) > 0) {
      w.doc_ids = [d, ...w.doc_ids.filter((x) => x !== d)];
      changed = true;
    }
  }
  if (!changed) return false;
  store.save(paths);
  return true;
}

/**
 * Remove *docId* from EVERY work's `doc_ids` (Stage 8 §8 document delete): one
 * doc can appear in several works through identity merge, so this is the same
 * all-works traversal as the seed's `pruneMissingDocs`. Each work's remaining
 * `doc_ids[0]` naturally stays/becomes its main doc (the main-doc pointer is
 * positional). Pure library-store mutation under the caller's writer lock —
 * no rebuild, no enrichment; saves (library.json + library.bib regen) only
 * when something actually changed, per patchWork's no-op discipline. Returns
 * whether anything changed.
 */
export function removeDocFromWorks(paths: LibraryPaths, docId: string): boolean {
  const store = LibraryStore.load(paths);
  let changed = false;
  for (const w of store.works) {
    if (w.doc_ids.includes(docId)) {
      w.doc_ids = w.doc_ids.filter((d) => d !== docId);
      changed = true;
    }
  }
  if (!changed) return false;
  store.save(paths);
  return true;
}
