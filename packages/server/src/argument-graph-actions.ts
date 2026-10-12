/**
 * Argument-graph reads and writes (ADR 0009): thin wrappers over the core
 * store. Writes serialize on the app's argument-graph lock; the rev check and
 * the save are one critical section. A corrupt / future-version file throws
 * (the route answers 500) and is never overwritten.
 */

import type { ArgumentGraph } from "@argelanderspace/contracts";
import {
  loadArgumentGraph,
  type ReplaceArgumentGraphOutcome,
  replaceArgumentGraph,
} from "@argelanderspace/core";
import type { AsyncLock } from "./lock.js";

export function readArgumentGraph(dataDir: string, workId: string): ArgumentGraph {
  return loadArgumentGraph(dataDir, workId);
}

export type WriteArgumentGraphOutcome =
  | ReplaceArgumentGraphOutcome
  /** The Work was no longer in the library when the write's turn came (merged away or removed): nothing written. */
  | { gone: true }
  /** The library could not be read when the write's turn came: nothing written. */
  | { libraryUnreadable: true };

/**
 * Replace a validated whole graph; `onChanged` fires only after a successful save.
 *
 * `workStillInLibrary` runs INSIDE the lock, in the same synchronous turn as the write. A Work merge follows its
 * folds in one synchronous turn right after library.json was replaced (ticket 06), so a write either happens
 * before that turn (and the merge then carries it along) or finds the Work already gone here and writes nothing.
 * A check made before the request body arrived, outside the lock, cannot give that guarantee.
 */
export async function writeArgumentGraph(
  dataDir: string,
  lock: AsyncLock,
  graph: ArgumentGraph,
  onChanged: () => void,
  workStillInLibrary: () => boolean | "error" = () => true
): Promise<WriteArgumentGraphOutcome> {
  const outcome = await lock.run((): WriteArgumentGraphOutcome => {
    const known = workStillInLibrary();
    if (known === "error") return { libraryUnreadable: true };
    if (!known) return { gone: true };
    return replaceArgumentGraph(dataDir, graph);
  });
  if ("saved" in outcome) onChanged();
  return outcome;
}
