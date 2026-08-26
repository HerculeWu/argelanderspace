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
import type { HtmlAdapterInfo } from "../acquire/planner.js";
import { addBibRecords, enrichAndPlan } from "../acquire/run.js";
import { pyOr, pyTruthy } from "../documents/pyregex.js";
import { buildGraph, citeKey, workToRef } from "./graph.js";
import { seedFromOutput } from "./seed.js";
import type { MetadataSources } from "./sources.js";
import { canonicalId, emptyWork, type LibraryPaths, LibraryStore, type Work } from "./store.js";

/** Options for {@link rebuild} / {@link acquireReferences}. */
export interface RebuildOptions {
  /** The resolution-chain sources (M2 infra), pre-configured with enablement. */
  sources: MetadataSources;
  /** Optional `.bib` file whose entries are added before enriching. */
  bibPath?: string | null;
  /** HTML-adapter registry override (defaults to the static migration snapshot). */
  htmlAdapters?: readonly HtmlAdapterInfo[];
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
  await enrichAndPlan(store, opts.sources, opts.htmlAdapters);
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

/** Update per-work user state (label / read / star / tags / note), validated. */
export function patchWork(
  paths: LibraryPaths,
  workId: string,
  patch: Record<string, unknown>
): boolean {
  const store = LibraryStore.load(paths);
  const w = store.get(workId);
  if (w === undefined) return false;
  // Python `patch.get(k) is not None`: present and non-null.
  if (patch.label !== undefined && patch.label !== null) {
    w.label = String(patch.label).slice(0, 32) || null;
  }
  if (patch.read !== undefined && patch.read !== null) {
    // Python bool(); JSON `[]`/`{}` diverge (truthy in JS) — the API contract
    // only admits booleans, so this is unreachable in practice.
    w.read = Boolean(patch.read);
  }
  if (patch.star !== undefined && patch.star !== null) {
    w.star = Boolean(patch.star);
  }
  if (patch.note !== undefined && patch.note !== null) {
    w.note = String(patch.note).slice(0, 10000) || null;
  }
  if (patch.tags !== undefined && patch.tags !== null && Array.isArray(patch.tags)) {
    w.tags = patch.tags.map((t) => String(t).slice(0, 64)).slice(0, 64);
  }
  store.save(paths);
  return true;
}
