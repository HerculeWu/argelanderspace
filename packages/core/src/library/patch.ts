/**
 * Narrow, field-preserving Work patch (copilot ticket 13).
 *
 * `patchWork` goes through the typed store, so a save re-projects every Work and drops what the typed model
 * does not know. The Web PATCH route and the Copilot `library` tool need the opposite: change only the
 * named fields of one Work and keep every other byte-level value (other Works, unknown keys, project data).
 * Both go through this one function; the caller holds the library write lock around it.
 *
 * The same validation and no-op rules as `patchWork` apply (label ≤ 32, tags ≤ 64×64, note ≤ 10000, main
 * doc = move the named Doc to the front of `doc_ids`, a patch that changes nothing writes nothing).
 * `expected` is the optional read-side check: the field values the caller saw, compared here against the
 * freshly re-read file, so a concurrent change to a field the caller relied on is a conflict while an
 * unrelated change is simply kept.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import {
  DEFAULT_PROJECT,
  emptyWork,
  type LibraryPaths,
  LibraryStore,
  type Work,
  workFromJson,
  workToDict,
} from "./store.js";

export interface WorkPatchExpectation {
  /** The main Doc (`doc_ids[0]`) the caller read; `null` means "had no Doc". */
  main_doc_id?: string | null;
}

export type WorkPatchResult =
  | { status: "ok" }
  | { status: "noop"; reason: "unchanged" | "not_linked" }
  | { status: "not_found" }
  | { status: "conflict"; current: { main_doc_id: string | null; doc_ids: string[] } };

type Raw = Record<string, unknown>;

export function patchWorkNarrow(
  paths: LibraryPaths,
  workId: string,
  patch: Record<string, unknown>,
  expected?: WorkPatchExpectation
): WorkPatchResult {
  if (!existsSync(paths.libraryJson)) return { status: "not_found" };
  const data = JSON.parse(readFileSync(paths.libraryJson, "utf8")) as Raw;
  const works = Array.isArray(data.works) ? (data.works as unknown[]) : [];
  const work = works.find(
    (candidate): candidate is Raw =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      String((candidate as Raw).id) === workId
  );
  if (work === undefined) return { status: "not_found" };
  const docIds = Array.isArray(work.doc_ids) ? work.doc_ids.map(String) : [];
  if (expected?.main_doc_id !== undefined && (docIds[0] ?? null) !== expected.main_doc_id)
    return { status: "conflict", current: { main_doc_id: docIds[0] ?? null, doc_ids: docIds } };

  let changed = false;
  let notLinked = false;
  const setOrDrop = (key: string, value: unknown, empty: boolean): void => {
    if (empty) delete work[key];
    else work[key] = value;
  };
  if (patch.label !== undefined && patch.label !== null) {
    const label = String(patch.label).slice(0, 32);
    setOrDrop("label", label, label === "");
    changed = true;
  }
  if (patch.read !== undefined && patch.read !== null) {
    work.read = Boolean(patch.read);
    changed = true;
  }
  if (patch.star !== undefined && patch.star !== null) {
    work.star = Boolean(patch.star);
    changed = true;
  }
  if (patch.note !== undefined && patch.note !== null) {
    const note = String(patch.note).slice(0, 10000);
    setOrDrop("note", note, note === "");
    changed = true;
  }
  if (patch.tags !== undefined && patch.tags !== null && Array.isArray(patch.tags)) {
    const tags = patch.tags.map((tag) => String(tag).slice(0, 64)).slice(0, 64);
    setOrDrop("tags", tags, tags.length === 0);
    changed = true;
  }
  if (patch.doc_id !== undefined && patch.doc_id !== null) {
    const doc = String(patch.doc_id);
    if (docIds.indexOf(doc) > 0) {
      work.doc_ids = [doc, ...docIds.filter((candidate) => candidate !== doc)];
      changed = true;
    } else if (docIds.indexOf(doc) < 0) notLinked = true;
  }
  if (!changed) return { status: "noop", reason: notLinked ? "not_linked" : "unchanged" };
  commit(paths, data, works);
  return { status: "ok" };
}

/**
 * Append one Doc to a Work's `doc_ids` and change nothing else (copilot ticket 15). The file is re-read raw,
 * so every other Work, every unknown key and `project` stay as stored; only library.json is rewritten
 * (a Doc association is not part of the BibTeX projection). The caller holds the library write lock.
 * A Doc that is already linked is left alone.
 */
export function appendDocIdNarrow(
  paths: LibraryPaths,
  workId: string,
  docId: string
): "ok" | "present" | "not_found" {
  if (!existsSync(paths.libraryJson)) return "not_found";
  const data = JSON.parse(readFileSync(paths.libraryJson, "utf8")) as Raw;
  const works = Array.isArray(data.works) ? (data.works as unknown[]) : [];
  const work = works.find(
    (candidate): candidate is Raw =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      String((candidate as Raw).id) === workId
  );
  if (work === undefined) return "not_found";
  const docIds = Array.isArray(work.doc_ids) ? work.doc_ids.map(String) : [];
  if (docIds.includes(docId)) return "present";
  work.doc_ids = [...docIds, docId];
  const tmp = paths.libraryJson.replace(/\.json$/, ".json.tmp");
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, paths.libraryJson);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* keep the original error */
    }
    throw error;
  }
  return "ok";
}

export interface RemovedDocWork {
  id: string;
  title: string;
  /** The Work's Doc ids after the removal (`remaining[0]` is its main Doc). */
  remaining: string[];
}

/**
 * Take one Doc out of EVERY Work's `doc_ids` and change nothing else (copilot ticket 16). The file is re-read raw,
 * so other Works, unknown keys (top level and per Work) and `project` stay as stored, and the other entries of an
 * edited `doc_ids` keep their stored values; the Doc id is compared as a string. Only library.json is rewritten
 * (tmp + rename): a Doc association is not part of the BibTeX projection, so library.bib is left alone. The
 * remaining first entry of each Work naturally becomes its main Doc. Nothing is written when no Work holds the
 * Doc or the file does not exist. An unreadable file throws and stays as it was. The caller holds the library
 * write lock. Replaces the typed `removeDocFromWorks`, which re-projected the whole library and dropped unknown keys.
 */
export function removeDocFromWorksNarrow(
  paths: LibraryPaths,
  docId: string
): { changed: boolean; works: RemovedDocWork[] } {
  if (!existsSync(paths.libraryJson)) return { changed: false, works: [] };
  const data = JSON.parse(readFileSync(paths.libraryJson, "utf8")) as Raw;
  const works = Array.isArray(data.works) ? (data.works as unknown[]) : [];
  const affected: RemovedDocWork[] = [];
  for (const candidate of works) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const work = candidate as Raw;
    if (!Array.isArray(work.doc_ids) || !work.doc_ids.some((entry) => String(entry) === docId))
      continue;
    work.doc_ids = work.doc_ids.filter((entry) => String(entry) !== docId);
    affected.push({
      id: String(work.id),
      title: typeof work.title === "string" ? work.title : "",
      remaining: (work.doc_ids as unknown[]).map(String),
    });
  }
  if (affected.length === 0) return { changed: false, works: [] };
  const tmp = paths.libraryJson.replace(/\.json$/, ".json.tmp");
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, paths.libraryJson);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* keep the original error */
    }
    throw error;
  }
  return { changed: true, works: affected };
}

export interface NarrowWorkChanges {
  /**
   * Works that did not exist in the file: always appended, never merged into a stored object (the caller has
   * already guaranteed their id is not taken; an id collision is refused before it gets here).
   */
  created?: readonly Work[];
  /**
   * Stored Works the typed store changed (an identity match): the typed fields are written over the stored
   * object with that same id; every key the typed model does not know stays.
   */
  updated?: readonly Work[];
  /** Works the typed store folded into another (a bridging import); removed from the file. */
  removeIds?: readonly string[];
}

/**
 * Write typed Work changes into the file the way a patch does: re-read the raw `library.json`, append the
 * created Works, update only the matched ones (the typed fields override, every key the typed model does not
 * know stays on that Work),
 * remove the folded ones, and keep the top level, `project` and all other Works byte-for-byte as values.
 * Nothing is written when no stored value changes. Returns the ids of Works that were added or whose stored
 * object changed. The caller holds the library write lock. `library.bib` is regenerated from the resulting file
 * through the same typed projection `LibraryStore.save` uses, so it is the same text for the same Works.
 */
export function saveWorksNarrow(paths: LibraryPaths, changes: NarrowWorkChanges): Set<string> {
  const data: Raw = existsSync(paths.libraryJson)
    ? (JSON.parse(readFileSync(paths.libraryJson, "utf8")) as Raw)
    : { version: 1, project: { ...DEFAULT_PROJECT }, works: [] };
  const works: unknown[] = Array.isArray(data.works) ? (data.works as unknown[]) : [];
  const idOf = (w: unknown): unknown =>
    w !== null && typeof w === "object" ? (w as Raw).id : undefined;
  const changedIds = new Set<string>();
  const remove = new Set(changes.removeIds ?? []);
  let next = works;
  if (remove.size > 0) {
    next = works.filter((w) => !remove.has(String(idOf(w))));
    if (next.length !== works.length) for (const id of remove) changedIds.add(id);
  }
  for (const work of changes.updated ?? []) {
    const dict = workToDict(work);
    const at = next.findIndex((w) => String(idOf(w)) === work.id);
    // A matched Work is one the caller just read from this file under the same lock.
    if (at < 0) throw new Error(`stored work ${work.id} is no longer in the library file`);
    const before = next[at] as Raw;
    const after = { ...before, ...dict };
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      next[at] = after;
      changedIds.add(work.id);
    }
  }
  for (const work of changes.created ?? []) {
    next.push(workToDict(work));
    changedIds.add(work.id);
  }
  if (changedIds.size === 0) return changedIds;
  data.works = next;
  commit(paths, data, next);
  return changedIds;
}

/** json and bib are staged first; only then are they renamed in place, json first (the source of truth). A failure while staging leaves both files untouched; a failure between the two renames can leave library.json updated and library.bib one change behind (the next actual write regenerates it). */
function commit(paths: LibraryPaths, data: Raw, works: unknown[]): void {
  mkdirSync(paths.libraryDir, { recursive: true });
  const jsonTmp = paths.libraryJson.replace(/\.json$/, ".json.tmp");
  const bibTmp = paths.libraryBib.replace(/\.bib$/, ".bib.tmp");
  const store = new LibraryStore(
    works.filter((w) => w !== null && typeof w === "object").map((w) => workFromJson(w as Raw)),
    typeof data.project === "object" && data.project !== null ? (data.project as Raw) : undefined
  );
  try {
    writeFileSync(jsonTmp, JSON.stringify(data, null, 2), "utf8");
    writeFileSync(bibTmp, store.toBibtex(), "utf8");
    renameSync(jsonTmp, paths.libraryJson);
    renameSync(bibTmp, paths.libraryBib);
  } catch (error) {
    // A failed cleanup must never replace the error that explains the failure.
    for (const tmp of [jsonTmp, bibTmp]) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* keep the original error */
      }
    }
    throw error;
  }
}

/** Every field the typed Work model has. A known key with an empty or odd value is the model's business, not an unknown key. */
const KNOWN_WORK_KEYS: ReadonlySet<string> = new Set(Object.keys(emptyWork("")));

/**
 * After a typed whole-library rewrite (`rebuild`), put back what the typed model does not know: top-level keys other
 * than version/project/works, and per-Work keys the typed round trip of the BEFORE object strips. Works are matched by
 * id; one whose id changed or that was merged away cannot be matched and its unknown keys are not restored.
 * Only library.json is rewritten (tmp + rename); library.bib is a typed projection and is untouched. Returns the
 * number of Works that got keys back. A failure throws and leaves the typed file in place. The caller holds the lock.
 */
export function restoreUnknownKeys(paths: LibraryPaths, before: unknown): number {
  if (before === null || typeof before !== "object" || Array.isArray(before)) return 0;
  const old = before as Raw;
  if (!existsSync(paths.libraryJson)) return 0;
  const data = JSON.parse(readFileSync(paths.libraryJson, "utf8")) as Raw;
  let changed = 0;
  let touched = false;
  for (const [key, value] of Object.entries(old))
    if (!["version", "project", "works"].includes(key) && !(key in data)) {
      data[key] = value;
      touched = true;
    }
  const now = Array.isArray(data.works) ? (data.works as unknown[]) : [];
  const byId = new Map<string, Raw>();
  for (const w of now)
    if (w !== null && typeof w === "object" && !Array.isArray(w))
      byId.set(String((w as Raw).id), w as Raw);
  for (const w of Array.isArray(old.works) ? (old.works as unknown[]) : []) {
    if (w === null || typeof w !== "object" || Array.isArray(w)) continue;
    const prior = w as Raw;
    const target = byId.get(String(prior.id));
    if (!target) continue;
    let restored = false;
    for (const [key, value] of Object.entries(prior))
      if (!KNOWN_WORK_KEYS.has(key) && !(key in target)) {
        target[key] = value;
        restored = true;
      }
    if (restored) {
      changed += 1;
      touched = true;
    }
  }
  if (!touched) return 0;
  const tmp = paths.libraryJson.replace(/\.json$/, ".json.tmp");
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, paths.libraryJson);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* keep the original error */
    }
    throw error;
  }
  return changed;
}
