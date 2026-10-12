/**
 * What happens to Work-owned argument graphs when two Works are merged (ADR 0009, ticket 06).
 *
 * The merge itself is `LibraryStore.upsert`: a record that matches two stored Works folds the later into
 * the first (the survivor). Each graph lives in `argument-graphs/<encoded work id>.json` and carries its own
 * `work_id`, so the files are handled AFTER the library file was saved (never before: a failed library save
 * must find every graph where it was), and one fold at a time, in the order the folds happened (a chain is
 * not collapsed: C into A, then A into D, gives D the graph A has after the first step).
 *
 * Per fold (a graph with zero arguments counts as no graph):
 *
 * - the absorbed Work has no file, an empty graph, or the fold is a Work that was never stored: nothing is
 *   done and nothing is reported (an empty graph's file stays where it is);
 * - the absorbed file cannot be read: `transfer_failed`, the file is left alone;
 * - the survivor has no file or an empty graph: the absorbed graph is MOVED: new content with `work_id` set to
 *   the survivor is written to a scratch file next to the target and fsynced, published at the survivor's name
 *   (a hard link, which fails when the name exists, so nothing is overwritten; for an empty survivor graph
 *   an atomic rename over it, only after re-checking that it is still an empty readable graph), and only then
 *   is the absorbed file removed. `rev` is the larger of the two plus one over an empty file, and at least 1
 *   over no file, so a writer that holds an older rev gets a conflict (`moved`);
 * - the survivor has a graph: it stays untouched, the absorbed file stays where it is, unshown
 *   (`kept_survivor`; `survivor_unreadable` when the survivor's file is there but cannot be read).
 *
 * Crash safety: at every instant between those steps at least one complete copy of the graph is on disk
 * under a name of a file that is a graph (docs/argument-graph.md lists the states). Nothing here throws:
 * every problem is a note.
 */

import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { relative, sep } from "node:path";
import type { ArgumentGraph, ArgumentGraphMergeNote } from "@argelanderspace/contracts";
import type { LibraryPaths, LibraryStore, WorkFold } from "../library/store.js";
import { argumentGraphDir, argumentGraphPath, loadArgumentGraph } from "./store.js";

/** A leftover scratch file older than this is a crash residue, not another process mid-write. */
const STALE_SCRATCH_MS = 60 * 60 * 1000;
const SCRATCH_NAME = /\.json\.merge-\d+-\d+\.tmp$/;
let scratchSeq = 0;

function safePath(dataDir: string, workId: string): string | null {
  try {
    return argumentGraphPath(dataDir, workId);
  } catch {
    return null; // an id that cannot be a file name cannot have a graph file
  }
}

/** Remove this module's own scratch files that a crashed run left behind (older than an hour). */
function cleanStaleScratch(dataDir: string): void {
  try {
    const dir = argumentGraphDir(dataDir);
    for (const name of readdirSync(dir)) {
      if (!SCRATCH_NAME.test(name)) continue;
      try {
        const file = `${dir}/${name}`;
        if (Date.now() - statSync(file).mtimeMs > STALE_SCRATCH_MS) rmSync(file, { force: true });
      } catch {
        /* a scratch file that cannot be inspected or removed stays; it is only clutter */
      }
    }
  } catch {
    /* no directory yet */
  }
}

function writeDurable(file: string, text: string): void {
  const fd = openSync(file, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Make a directory entry change durable; best effort (not every filesystem allows opening a directory). */
function syncDirectory(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* durability of the directory entry is a bonus, never a failure */
  }
}

type SurvivorState =
  | { kind: "absent" }
  | { kind: "empty"; rev: number }
  | { kind: "occupied" }
  | { kind: "unreadable" };

function survivorState(dataDir: string, workId: string, file: string): SurvivorState {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable" };
  }
  if (stat.isSymbolicLink()) return { kind: "unreadable" }; // never replace what a link points at
  try {
    const graph = loadArgumentGraph(dataDir, workId);
    return graph.arguments.length === 0 ? { kind: "empty", rev: graph.rev } : { kind: "occupied" };
  } catch {
    return { kind: "unreadable" };
  }
}

/** Publish `tmp` at `target` without ever replacing an existing file; false when `target` exists. */
function publishExclusive(tmp: string, target: string): boolean {
  try {
    linkSync(tmp, target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    // A filesystem without hard links: check-then-rename (the same-process window is the only one left).
    if (lstatExists(target)) return false;
    renameSync(tmp, target);
    return true;
  }
}

function lstatExists(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** One fold's graph handling. Returns `null` when there was nothing to move or report. */
export function followFold(
  dataDir: string,
  absorbed: string,
  survivor: string
): ArgumentGraphMergeNote | null {
  const absorbedFile = safePath(dataDir, absorbed);
  if (absorbed === survivor || absorbedFile === null || !lstatExists(absorbedFile)) return null;
  const survivorFile = safePath(dataDir, survivor);
  const base = {
    absorbed_id: absorbed,
    survivor_id: survivor,
    absorbed_file: absorbedFile,
  };
  let graph: ArgumentGraph;
  try {
    graph = loadArgumentGraph(dataDir, absorbed);
  } catch {
    // A file that is a directory or unreadable: lstat said it is there, so it may be someone's only copy.
    return {
      ...base,
      outcome: "transfer_failed",
      survivor_file: survivorFile ?? "",
      error: "absorbed_unreadable",
    };
  }
  if (graph.arguments.length === 0) return null; // an empty graph is "no graph": no transfer, no note, file stays
  if (survivorFile === null) {
    return {
      ...base,
      outcome: "transfer_failed",
      survivor_file: "",
      error: "survivor_name_unusable",
    };
  }
  const tmp = `${survivorFile}.merge-${process.pid}-${++scratchSeq}.tmp`;
  try {
    mkdirSync(argumentGraphDir(dataDir), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const state = survivorState(dataDir, survivor, survivorFile);
      if (state.kind === "occupied" || state.kind === "unreadable") {
        return {
          ...base,
          outcome: "kept_survivor",
          survivor_file: survivorFile,
          ...(state.kind === "unreadable" ? { survivor_unreadable: true } : {}),
        };
      }
      const rev =
        state.kind === "empty" ? Math.max(graph.rev, state.rev) + 1 : Math.max(graph.rev, 1);
      writeDurable(tmp, JSON.stringify({ ...graph, work_id: survivor, rev }, null, 2));
      if (state.kind === "absent") {
        if (!publishExclusive(tmp, survivorFile)) continue; // someone published meanwhile: classify again
      } else {
        // Re-confirm right before the atomic replace: still the same empty readable graph.
        const again = survivorState(dataDir, survivor, survivorFile);
        if (again.kind !== "empty" || again.rev !== state.rev) continue;
        renameSync(tmp, survivorFile);
      }
      syncDirectory(argumentGraphDir(dataDir));
      // The graph is now complete under the survivor's name; only now may the original go.
      let left = false;
      try {
        unlinkSync(absorbedFile);
        syncDirectory(argumentGraphDir(dataDir));
      } catch {
        left = true;
      }
      return {
        ...base,
        outcome: "moved",
        survivor_file: survivorFile,
        ...(left ? { absorbed_file_left: true } : {}),
      };
    }
    // Two rounds lost to concurrent writers: whatever is there now is not ours to replace.
    return { ...base, outcome: "kept_survivor", survivor_file: survivorFile };
  } catch {
    return {
      ...base,
      outcome: "transfer_failed",
      survivor_file: survivorFile,
      error: "write_failed",
    };
  } finally {
    try {
      rmSync(tmp, { force: true }); // our own scratch file (a hard link leaves the published name in place)
    } catch {
      /* a scratch file that cannot be removed must not turn into an exception, or hide the outcome */
    }
  }
}

export interface FoldNote {
  fold: WorkFold;
  note: ArgumentGraphMergeNote;
}

/**
 * Follow every fold of a saved merge, one step at a time in the order they happened, and EMPTY `folds`
 * (a second call on the same store reports nothing again). Call it only after the library file holding the
 * merge was written. Never throws. Returns the fold each note belongs to, in order.
 */
export function followFolds(dataDir: string, folds: WorkFold[]): FoldNote[] {
  const todo = folds.splice(0, folds.length);
  if (todo.length === 0) return [];
  cleanStaleScratch(dataDir);
  const out: FoldNote[] = [];
  for (const fold of todo) {
    if (!fold.stored) continue; // a Work created in this session owns no file (its id may be a reused one)
    const note = followFold(dataDir, fold.absorbed, fold.survivor);
    if (note !== null) out.push({ fold, note });
  }
  return out;
}

/** {@link followFolds} without the fold each note belongs to. */
export function followWorkFolds(dataDir: string, folds: WorkFold[]): ArgumentGraphMergeNote[] {
  return followFolds(dataDir, folds).map((x) => x.note);
}

/** The ids in library.json right now, or null when it cannot be read. */
function libraryIds(paths: LibraryPaths): Set<string> | null {
  try {
    const data = JSON.parse(readFileSync(paths.libraryJson, "utf8")) as {
      works?: { id?: unknown }[];
    };
    return new Set((data.works ?? []).map((w) => String(w.id)));
  } catch {
    return null;
  }
}

/**
 * A library save threw. When library.json was nevertheless replaced (the save renames it before it writes
 * library.bib), the merge is part of the library and its graphs must follow: do it, put the notes on the error
 * (`argumentGraphMerges`) and say so in its message (paths relative to the data directory). The error is returned
 * for the caller to throw; nothing else changes about it.
 */
export function followFoldsAfterFailedSave(
  paths: LibraryPaths,
  store: LibraryStore,
  error: unknown
): unknown {
  if (store.folds.length === 0 || !(error instanceof Error)) return error;
  const ids = libraryIds(paths);
  const mine = new Set(store.works.map((w) => w.id));
  const committed = ids !== null && ids.size === mine.size && [...mine].every((id) => ids.has(id));
  if (!committed) return error;
  const notes = followWorkFolds(paths.dataDir, store.folds);
  if (notes.length === 0) return error;
  (error as Error & { argumentGraphMerges?: ArgumentGraphMergeNote[] }).argumentGraphMerges = notes;
  error.message += ` (the Work merge itself was saved. ${notes
    .map((n) => describeArgumentGraphMerge(relativeMergeNote(paths.dataDir, n)))
    .join(" ")})`;
  return error;
}

/** The same note with both locations relative to the data directory (`argument-graphs/<name>.json`), for clients. */
export function relativeMergeNote(
  dataDir: string,
  note: ArgumentGraphMergeNote
): ArgumentGraphMergeNote {
  const rel = (p: string) => (p === "" ? "" : relative(dataDir, p).split(sep).join("/"));
  return {
    ...note,
    absorbed_file: rel(note.absorbed_file),
    survivor_file: rel(note.survivor_file),
  };
}

const ERROR_TEXT: Record<NonNullable<ArgumentGraphMergeNote["error"]>, string> = {
  absorbed_unreadable: "its file could not be read",
  survivor_name_unusable: "the surviving Work's id cannot be used as a file name",
  write_failed: "the new file could not be written",
};

/** One English sentence for a note (CLI, logs, error messages, tool results). */
export function describeArgumentGraphMerge(note: ArgumentGraphMergeNote): string {
  const who = `${note.absorbed_id} was merged into ${note.survivor_id}`;
  switch (note.outcome) {
    case "moved":
      return note.absorbed_file_left === true
        ? `${who}; its argument graph now belongs to ${note.survivor_id} (${note.survivor_file}), but the original file could not be removed and is still at ${note.absorbed_file}, unused.`
        : `${who}; its argument graph was moved to ${note.survivor_id} (${note.survivor_file}).`;
    case "kept_survivor":
      return `${who}; both had an argument graph${note.survivor_unreadable === true ? " (the file of the surviving Work could not be read and was not replaced)" : ""}. ${note.survivor_id}'s was kept; the one of ${note.absorbed_id} stays on disk at ${note.absorbed_file}, not shown and not deleted.`;
    case "transfer_failed":
      return `${who}; its argument graph could not be moved (${ERROR_TEXT[note.error ?? "write_failed"]}). It is intact at ${note.absorbed_file}.`;
  }
}
