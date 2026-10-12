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

/** Replace a validated whole graph; `onChanged` fires only after a successful save. */
export async function writeArgumentGraph(
  dataDir: string,
  lock: AsyncLock,
  graph: ArgumentGraph,
  onChanged: () => void
): Promise<ReplaceArgumentGraphOutcome> {
  const outcome = await lock.run(() => replaceArgumentGraph(dataDir, graph));
  if ("saved" in outcome) onChanged();
  return outcome;
}
