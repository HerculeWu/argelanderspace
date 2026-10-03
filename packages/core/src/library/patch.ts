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
import { type LibraryPaths, LibraryStore, workFromJson } from "./store.js";

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
      (candidate as Raw).id === workId
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

/** json and bib are staged first; only then are they renamed in place, json first (the source of truth). A failure while staging leaves both files untouched; a failure between the two renames can leave library.json updated and library.bib one change behind (the next save regenerates it). */
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
