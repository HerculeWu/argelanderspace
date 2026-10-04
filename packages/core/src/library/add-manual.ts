/**
 * Manual work creation (Stage 13): the webui "导入文献" menu's server-side
 * core. Three modes, all in-place (no library rebuild — the addDoiWork
 * precedent), all composing the EXISTING pipeline pieces
 * (resolveWork / parseBibtexText / parseAdsBibtexFields / planFor /
 * assignCiteKey / upsert), per the user's reuse mandate:
 *
 * - **identifier** (DOI): stub anchored on `doi:`, full resolution chain,
 *   tolerant — a total network miss still saves the bare stub (CLI
 *   `addDoiWork` semantics), the next build re-enriches.
 * - **identifier** (arXiv): same, anchored on `arxiv:` (many papers have no
 *   journal DOI but are cited and read — the user, Stage 13 Q10). Reading
 *   the full text goes through the existing upload-zip attach flow.
 * - **bibcode**: fail-fast — ADS export must return the entry (the semantic
 *   is "pick from ADS"); fields come from the export, `cite_key = bibcode`
 *   (Stage 12 rule), `bib_fields = "ads"` so enrichBibFields skips it.
 * - **bib**: raw BibTeX text, one or many entries, pure-local (offline-safe).
 *   The user's own key becomes `cite_key` (D5); a key held by a DIFFERENT
 *   work is a per-entry error, never a silent rewrite. Entries are applied
 *   independently (partial success), the store is saved once.
 *
 * Duplicates (identity-key match) are `exists` outcomes: upsert merges blank
 * fields only, user data (note/label/star/read/tags) is never touched.
 *
 * Single-work modes additionally update the citation graph incrementally
 * (mergeWorkIntoGraph); batch bib only adds the bare saved nodes — full
 * resolution and neighbour expansion wait for the next build (N×3 requests
 * for N pasted entries is not acceptable interactivity).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type LibraryRef, WRITER_JOURNAL_MACROS } from "@argelanderspace/contracts";
import {
  type AdsBibFields,
  type BibRecord,
  isConf,
  parseAdsBibtexFields,
  parseBibtexText,
} from "../acquire/bibtex.js";
import { classify, planToDict } from "../acquire/planner.js";
import { resolveWork } from "../acquire/resolve.js";
import { planFor } from "../acquire/run.js";
import { pyOr } from "../documents/pyregex.js";
import { healGraph, loadCurrentGraph } from "./build.js";
import { assignCiteKey, mergeWorkIntoGraph, workToRef } from "./graph.js";
import { saveWorksNarrow } from "./patch.js";
import type { MetadataSources } from "./sources.js";
import {
  canonicalId,
  emptyWork,
  type LibraryPaths,
  LibraryStore,
  normArxiv,
  normDoi,
  type Work,
} from "./store.js";

// --------------------------------------------------------------------------- //
// Outcomes
// --------------------------------------------------------------------------- //

/** One entry's result (Stage 13 contract: created | exists | error). */
export interface ManualAddOutcome {
  status: "created" | "exists" | "error";
  ref?: LibraryRef;
  /** The attempted/assigned cite key. */
  key?: string;
  error?: string;
  /**
   * The stored Work was added or its stored object actually changed (an `exists` entry whose blank fields were
   * filled or whose acquisition plan was recomputed is `changed`; one that left the file as it was is not).
   */
  changed?: boolean;
  /** Only with `bridge: "reject"`: the entry was not imported because it would fold these stored Works into one. */
  bridged?: string[];
}

/**
 * - `merge` (the page's behaviour): a record bridging two stored Works folds one into the other.
 * - `reject` (the Copilot tool): an import that would fold or delete a stored Work is refused as a whole, with
 *   nothing written.
 */
export interface ManualAddOptions {
  bridge?: "merge" | "reject";
}

function errorOutcome(error: string, key?: string): ManualAddOutcome {
  return key === undefined ? { status: "error", error } : { status: "error", error, key };
}

// --------------------------------------------------------------------------- //
// Shared helpers
// ---------------------------------------------------------------------------;

/** Full-text venue label for an ADS journal shorthand (`aap` → "Astronomy & Astrophysics"). */
function macroVenue(macro: string | null): string | null {
  if (!macro) return null;
  const hit = WRITER_JOURNAL_MACROS.find(([name]) => name === macro);
  // expansions carry LaTeX-escaped specials ("Astronomy \& Astrophysics")
  return hit?.[1]?.replace(/\\([&%#_])/g, "$1") ?? null;
}

/** cite keys already taken in *store* (for conflict checks / assignment). */
function usedKeys(store: LibraryStore): Set<string> {
  return new Set(store.works.map((x) => x.cite_key).filter((x): x is string => x !== null));
}

/**
 * Resolution is best-effort for manual adds: a throwing client degrades to
 * the bare stub rather than failing the creation (the tolerant identifier
 * modes; the next build re-runs the full chain).
 */
async function tryResolve(w: Work, sources: MetadataSources): Promise<void> {
  try {
    await resolveWork(w, sources);
  } catch {
    // sources degrade individually; a throw here must not block creation
  }
}

/**
 * The canonical id AFTER resolution — a work created from an arXiv id may
 * have gained its journal DOI (doi > arxiv priority), and a manual bib entry
 * its OpenAlex id. Recompute before upsert so identity lands canonically.
 */
function recanonicalize(w: Work): void {
  w.id = canonicalId({
    doi: w.doi,
    arxiv: w.arxiv_id,
    openalex: w.openalex_id,
    title: w.title,
    year: w.year,
  });
}

/**
 * A new Work's canonical id is derived (title slug + year when it has no DOI/arXiv/OpenAlex id) and is NOT
 * unique across different papers: series titles that share their first 48 characters and a year map to one id
 * although their identity keys differ. The library has no id-uniquifying rule, and ids are what Doc links, the
 * graph and every PATCH address a Work by, so a made-up suffix would be a new identity scheme. A new Work whose
 * id is already held by a different Work is therefore refused with a reason (nothing written); the user adds a
 * DOI/arXiv id or changes the title/year.
 */
function idCollision(store: LibraryStore, w: Work): ManualAddOutcome | null {
  const holder = store.get(w.id);
  if (holder === undefined) return null;
  return errorOutcome(
    `not imported: its work id '${w.id}' (derived from the title and year) is already used by a different paper (${holder.title || holder.id}); give the entry a DOI or arXiv id, or change its title or year`,
    w.cite_key ?? undefined
  );
}

/**
 * The shared single-work tail: re-identity → duplicate check → upsert →
 * assign-only cite key → acquisition plan → narrow save (only this Work's
 * stored object is written; the rest of the file is kept) → incremental graph.
 * Returns `exists` when the store already held a matching work (upsert still
 * merged blank fields into it).
 */
async function commitWork(
  paths: LibraryPaths,
  store: LibraryStore,
  w: Work,
  options: ManualAddOptions = {}
): Promise<ManualAddOutcome> {
  recanonicalize(w);
  const matches = store.matchesAll(w);
  if (matches.length > 1 && options.bridge === "reject") {
    const ids = matches.map((m) => m.id);
    return {
      ...errorOutcome(
        `not imported: this record would merge ${ids.length} existing works into one (${ids.join(", ")}); merge or fix them in the Library page`,
        w.cite_key ?? undefined
      ),
      bridged: ids,
    };
  }
  const matched = matches[0];
  if (matched === undefined) {
    const collision = idCollision(store, w);
    if (collision) return collision;
  }
  const removeIds = matches.slice(1).map((m) => m.id);
  const saved = store.upsert(w);
  if (!saved.cite_key) saved.cite_key = assignCiteKey(saved, usedKeys(store));
  saved.acquisition = planToDict(planFor(saved));
  const changedIds = saveWorksNarrow(
    paths,
    matched === undefined ? { created: [saved], removeIds } : { updated: [saved], removeIds }
  );
  await mergeGraphQuiet(paths, store, saved);
  return {
    status: matched !== undefined ? "exists" : "created",
    ref: workToRef(saved),
    key: saved.cite_key ?? undefined,
    changed: changedIds.size > 0,
  };
}

/**
 * Incremental graph update must never fail a creation (Stage 13 boundary).
 * Stage 14: merges into the current saved-only graph — a stale/missing cache
 * is healed first (derived-cache rebuild from the latest store, still under
 * the caller's libraryLock); any failure just defers to the next refresh.
 */
async function mergeGraphQuiet(paths: LibraryPaths, store: LibraryStore, w: Work): Promise<void> {
  try {
    const graph = mergeWorkIntoGraph(loadCurrentGraph(paths) ?? healGraph(paths), store, w);
    mkdirSync(dirname(paths.graphJson), { recursive: true });
    writeFileSync(paths.graphJson, JSON.stringify(graph), "utf8");
  } catch {
    // the next library build/refresh converges the graph to authoritative
  }
}

// --------------------------------------------------------------------------- //
// identifier mode (DOI / arXiv)
// --------------------------------------------------------------------------- //

export type ManualIdentifier = { kind: "doi"; doi: string } | { kind: "arxiv"; arxiv: string };

/**
 * Create a docless work from a DOI or arXiv id (already detected/normalized
 * by the server). Tolerant: when every source misses, the bare stub is still
 * saved (the user explicitly allowed arXiv-only stubs, Stage 13 Q14).
 */
export async function addManualIdentifier(
  paths: LibraryPaths,
  sources: MetadataSources,
  id: ManualIdentifier,
  options: ManualAddOptions = {}
): Promise<ManualAddOutcome> {
  const store = LibraryStore.load(paths);
  const key = id.kind === "doi" ? `doi:${normDoi(id.doi)}` : `arxiv:${normArxiv(id.arxiv)}`;
  const existing = store.match(key);
  if (existing !== undefined) {
    return {
      status: "exists",
      ref: workToRef(existing),
      key: existing.cite_key ?? undefined,
      changed: false,
    };
  }
  const w = emptyWork(canonicalId(id.kind === "doi" ? { doi: id.doi } : { arxiv: id.arxiv }));
  if (id.kind === "doi") w.doi = normDoi(id.doi);
  else w.arxiv_id = normArxiv(id.arxiv);
  w.origin = "manual";
  w.added_at = new Date().toISOString();
  await tryResolve(w, sources);
  return commitWork(paths, store, w, options);
}

// --------------------------------------------------------------------------- //
// bibcode mode (fail-fast ADS pick)
// --------------------------------------------------------------------------- //

/**
 * Create a work from one ADS bibcode. Fail-fast: ADS unreachable / no such
 * record → an error outcome, never a stub (the semantic is "pick from ADS").
 */
export async function addManualBibcode(
  paths: LibraryPaths,
  sources: MetadataSources,
  bibcode: string,
  options: ManualAddOptions = {}
): Promise<ManualAddOutcome> {
  const bc = bibcode.trim();
  const store = LibraryStore.load(paths);
  const dup = store.works.find((w) => w.bibcode === bc);
  if (dup !== undefined) {
    return {
      status: "exists",
      ref: workToRef(dup),
      key: dup.cite_key ?? undefined,
      changed: false,
    };
  }
  const text = await sources.ads.exportBibtex([bc]);
  if (!text) {
    return errorOutcome(
      "ADS BibTeX export unavailable (offline, missing token, or request failed); try again later",
      bc
    );
  }
  let rec: BibRecord | undefined;
  let extras: AdsBibFields | undefined;
  try {
    rec = parseBibtexText(text).find((r) => r.key === bc);
    extras = parseAdsBibtexFields(text).get(bc);
  } catch {
    rec = undefined;
  }
  if (rec === undefined) {
    return errorOutcome(`bibcode ${bc} not found on ADS`, bc);
  }
  const w = workFromBib(rec, extras ?? null, "manual");
  w.bibcode = bc;
  w.bib_fields = "ads"; // the export already supplied the bibliography fields
  await tryResolve(w, sources);
  return commitWork(paths, store, w, options);
}

// --------------------------------------------------------------------------- //
// bib mode (raw BibTeX text, one or many entries, pure-local)
// --------------------------------------------------------------------------- //

/** Build a Work from a user-supplied bib entry, keeping every parsed field. */
function workFromBib(rec: BibRecord, extras: AdsBibFields | null, origin: string): Work {
  const macro = extras?.journalMacro ?? null;
  const [pub, label] = classify(rec.doi, rec.journal);
  // classify's label is only trustworthy when a publisher matched; its
  // no-match fallback echoes the raw journal, which for a macro entry is the
  // latexenc-mangled remnant (\aap → "åp") — never display that.
  const classified = pub !== null ? (pyOr(label) as string | undefined) : undefined;
  const venue =
    classified ??
    (macro === null ? (pyOr(rec.journal) as string | undefined) : undefined) ??
    macroVenue(macro) ??
    null;
  const w = emptyWork(
    canonicalId({ doi: rec.doi, arxiv: rec.arxivId, title: rec.title, year: rec.year })
  );
  w.title = rec.title;
  w.authors = [...rec.authors];
  w.year = rec.year;
  w.venue = venue;
  w.journal = classified ?? null;
  w.type = isConf(rec) ? "conf" : "article";
  w.doi = rec.doi;
  w.arxiv_id = rec.arxivId;
  w.origin = origin;
  w.added_at = new Date().toISOString();
  // Stage 13 D11: unlike the build --bib path (workFromBibrecord), keep the
  // full Stage 12 bibliography field set.
  w.volume = rec.volume ?? extras?.volume ?? null;
  w.number = extras?.number ?? null;
  w.pages = rec.pages ?? extras?.pages ?? null;
  w.eid = extras?.eid ?? null;
  w.month = extras?.month ?? null;
  w.journal_macro = macro;
  return w;
}

/**
 * Add every entry of a raw BibTeX text. Per-entry independence: a cite-key
 * conflict (key held by a DIFFERENT work) or an unparseable blob entry fails
 * that entry only. No resolution/graph network — the next build enriches.
 */
export async function addManualBibText(
  paths: LibraryPaths,
  bib: string,
  options: ManualAddOptions = {}
): Promise<ManualAddOutcome[]> {
  let recs: BibRecord[];
  let extras: Map<string, AdsBibFields>;
  try {
    recs = parseBibtexText(bib);
    extras = parseAdsBibtexFields(bib);
  } catch {
    return [errorOutcome("could not parse the BibTeX text (no valid entries)")];
  }
  if (recs.length === 0) {
    return [errorOutcome("could not parse the BibTeX text (no valid entries)")];
  }
  const store = LibraryStore.load(paths);
  const used = usedKeys(store);
  const outcomes: ManualAddOutcome[] = [];
  const created: Work[] = [];
  const touched: Work[] = [];
  const touchedAt = new Map<Work, number[]>();
  const removeIds: string[] = [];
  let refusedBridge = false;
  for (const rec of recs) {
    const key = rec.key.trim();
    const w = workFromBib(rec, extras.get(rec.key) ?? extras.get(key) ?? null, "bib");
    const matches = store.matchesAll(w);
    const matched = matches[0];
    const holder = store.works.find((x) => x.cite_key === key);
    if (holder !== undefined && holder !== matched) {
      outcomes.push(
        errorOutcome(`cite key '${key}' is already used by another work (${holder.id})`, key)
      );
      continue;
    }
    if (matches.length > 1 && options.bridge === "reject") {
      // Refuse the whole batch, but keep reporting every entry's own problems; nothing is written below.
      const ids = matches.map((m) => m.id);
      const fromBatch = matches.some((m) => created.includes(m));
      outcomes.push({
        ...errorOutcome(
          `not imported: '${key}' would merge ${ids.length} ${fromBatch ? "works (one created earlier in this import)" : "existing works"} into one (${ids.join(", ")}); merge or fix them in the Library page`,
          key
        ),
        bridged: ids,
      });
      refusedBridge = true;
      continue;
    }
    if (matched === undefined) {
      const collision = idCollision(store, w);
      if (collision) {
        outcomes.push({ ...collision, key });
        continue;
      }
    }
    w.cite_key = key; // the user's own key (Stage 13 D5)
    for (const extra of matches.slice(1)) removeIds.push(extra.id);
    const saved = store.upsert(w);
    if (!saved.cite_key) saved.cite_key = assignCiteKey(saved, used);
    else used.add(saved.cite_key);
    saved.acquisition = planToDict(planFor(saved));
    if (matched === undefined) created.push(saved);
    if (!touched.includes(saved)) touched.push(saved);
    const outcome: ManualAddOutcome = {
      status: matched !== undefined ? "exists" : "created",
      ref: workToRef(saved),
      key: saved.cite_key ?? key,
    };
    touchedAt.set(saved, [...(touchedAt.get(saved) ?? []), outcomes.length]);
    outcomes.push(outcome);
  }
  if (refusedBridge) {
    return outcomes.map((o) =>
      o.status === "error"
        ? o
        : errorOutcome(
            "not imported: another entry of this batch would merge works, so the whole batch was refused",
            o.key
          )
    );
  }
  if (touched.length > 0 || removeIds.length > 0) {
    // a Work an earlier entry created and a later bridging entry folded away is gone from the store
    const alive = touched.filter((t) => store.works.includes(t));
    const changedIds = saveWorksNarrow(paths, {
      created: alive.filter((t) => created.includes(t)),
      updated: alive.filter((t) => !created.includes(t)),
      removeIds,
    });
    for (const [saved, indexes] of touchedAt)
      for (const index of indexes)
        (outcomes[index] as ManualAddOutcome).changed = changedIds.has(saved.id);
  }
  // Bare saved nodes only — batch mode defers resolution/neighbours to the
  // next build, but the new entries must be selectable in the graph view now.
  try {
    let graph = loadCurrentGraph(paths) ?? healGraph(paths);
    for (const w of created) {
      graph = mergeWorkIntoGraph(graph, store, w);
    }
    if (created.length > 0) {
      mkdirSync(dirname(paths.graphJson), { recursive: true });
      writeFileSync(paths.graphJson, JSON.stringify(graph), "utf8");
    }
  } catch {
    // graph catches up on the next refresh
  }
  return outcomes;
}
