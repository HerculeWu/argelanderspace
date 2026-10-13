/**
 * A log sink that keeps its records in memory, for tests of this package and of the packages built on it (they import
 * this file by path). It is not part of the log module: production code has no sink that only tests use.
 */

import type { LogJson, LogSink } from "../src/log/index.js";

export interface MemorySink extends LogSink {
  readonly lines: string[];
  /** The records written so far, parsed. */
  records(): Array<Record<string, LogJson>>;
}

export function createMemorySink(): MemorySink {
  const lines: string[] = [];
  return {
    lines,
    write: (line) => void lines.push(line),
    records: () => lines.map((line) => JSON.parse(line) as Record<string, LogJson>),
  };
}
