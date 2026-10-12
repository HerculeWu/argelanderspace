/**
 * What happens to Work-owned argument graphs when two Works are merged (ADR 0009, ticket 06).
 *
 * The merge itself is `LibraryStore.upsert`: a record that matches two stored Works folds the later into
 * the first (the survivor). Each graph lives in `argument-graphs/<encoded work id>.json` and carries its own
 * `work_id`, so the files are handled AFTER the library file was saved (never before: a failed library save
 * must find every graph where it was), and per fold:
 *
 * - the absorbed Work has no graph file: nothing to do, nothing reported;
 * - the survivor already has a graph file (whatever is in it, it is not read): the survivor's stays, the
 *   absorbed one stays where it is, unshown (`kept_survivor`);
 * - only the absorbed one has a graph: a COPY with `work_id` set to the survivor is published at the survivor's
 *   name (`moved`), `rev` kept (nothing in the graph was edited; the survivor had no file, so the rev only grows);
 * - the copy cannot be made (unreadable absorbed file, filesystem error): reported as `transfer_failed`.
 *
 * The absorbed file is NEVER modified, renamed or removed in any outcome: it is the user's data, and a copy
 * that was published but whose bookkeeping failed must not cost the original. The only file this module
 * deletes is its own scratch copy. Publishing is exclusive (hard link, tmp → target fails if the target
 * exists), so a graph that appears at the survivor's name in the meantime is never overwritten. Nothing here
 * throws: every problem is a note.
 */

import { existsSync, linkSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { ArgumentGraphMergeNote } from "@argelanderspace/contracts";
import type { WorkFold } from "../library/store.js";
import { argumentGraphDir, argumentGraphPath, loadArgumentGraph } from "./store.js";

/**
 * Collapse chains (B→A, then A→C means B→C) so every absorbed Work points at the Work that is finally alive.
 * Keeps only the folds whose absorbed Work was stored (could own a file); order of folding decides which of
 * two graphs competing for one survivor gets it (the first fold's).
 */
export function resolveFolds(folds: readonly WorkFold[]): { absorbed: string; survivor: string }[] {
  const next = new Map<string, string>();
  for (const f of folds) next.set(f.absorbed, f.survivor);
  const final = (id: string): string => {
    const seen = new Set<string>();
    let at = id;
    while (next.has(at) && !seen.has(at)) {
      seen.add(at);
      at = next.get(at) as string;
    }
    return at;
  };
  const out: { absorbed: string; survivor: string }[] = [];
  for (const f of folds) {
    if (!f.stored) continue;
    const survivor = final(f.absorbed);
    if (survivor !== f.absorbed) out.push({ absorbed: f.absorbed, survivor });
  }
  return out;
}

function safePath(dataDir: string, workId: string): string | null {
  try {
    return argumentGraphPath(dataDir, workId);
  } catch {
    return null; // an id that cannot be a file name cannot have a graph file
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    if (existsSync(target)) return false;
    renameSync(tmp, target);
    return true;
  }
}

/** One fold's graph handling. Returns `null` when the absorbed Work had no graph file. */
export function followFold(
  dataDir: string,
  absorbed: string,
  survivor: string
): ArgumentGraphMergeNote | null {
  const absorbedFile = safePath(dataDir, absorbed);
  const survivorFile = safePath(dataDir, survivor);
  if (absorbedFile === null || !existsSync(absorbedFile)) return null;
  const base = { absorbed_id: absorbed, survivor_id: survivor, absorbed_file: absorbedFile };
  if (survivorFile === null) {
    return {
      ...base,
      outcome: "transfer_failed",
      survivor_file: "",
      error: "the surviving Work's id cannot be used as a graph file name",
    };
  }
  if (existsSync(survivorFile)) {
    return { ...base, outcome: "kept_survivor", survivor_file: survivorFile };
  }
  const tmp = `${survivorFile}.merge-${process.pid}.tmp`;
  try {
    const graph = loadArgumentGraph(dataDir, absorbed);
    mkdirSync(argumentGraphDir(dataDir), { recursive: true });
    writeFileSync(tmp, JSON.stringify({ ...graph, work_id: survivor }, null, 2), "utf8");
    const published = publishExclusive(tmp, survivorFile);
    return {
      ...base,
      outcome: published ? "moved" : "kept_survivor",
      survivor_file: survivorFile,
    };
  } catch (error) {
    return {
      ...base,
      outcome: "transfer_failed",
      survivor_file: survivorFile,
      error: message(error),
    };
  } finally {
    try {
      rmSync(tmp, { force: true }); // our own scratch copy (a hard link leaves the published name in place)
    } catch {
      /* a scratch file that cannot be removed must not turn into an exception, or hide the outcome */
    }
  }
}

/**
 * Follow every fold of a saved merge. Call it only after the library file holding the merge was written.
 * Never throws. One note per absorbed Work that had a graph file, in fold order.
 */
export function followWorkFolds(
  dataDir: string,
  folds: readonly WorkFold[]
): ArgumentGraphMergeNote[] {
  const notes: ArgumentGraphMergeNote[] = [];
  for (const { absorbed, survivor } of resolveFolds(folds)) {
    const note = followFold(dataDir, absorbed, survivor);
    if (note !== null) notes.push(note);
  }
  return notes;
}

/** One English sentence for a note (CLI, logs, tool results). */
export function describeArgumentGraphMerge(note: ArgumentGraphMergeNote): string {
  const who = `${note.absorbed_id} was merged into ${note.survivor_id}`;
  switch (note.outcome) {
    case "moved":
      return `${who}; its argument graph now belongs to ${note.survivor_id} (${note.survivor_file}). The original file stays at ${note.absorbed_file}, unused.`;
    case "kept_survivor":
      return `${who}; both had an argument graph. ${note.survivor_id}'s was kept; the one of ${note.absorbed_id} stays on disk at ${note.absorbed_file}, not shown and not deleted.`;
    case "transfer_failed":
      return `${who}; its argument graph could not be moved (${note.error ?? "unknown error"}). It is intact at ${note.absorbed_file}.`;
  }
}
