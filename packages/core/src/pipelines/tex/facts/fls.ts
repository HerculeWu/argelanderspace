/**
 * .fls parser: the -recorder dependency facts.
 *
 *   PWD <workspace>
 *   INPUT <path>
 *   OUTPUT <path>
 *
 * Only INPUT lines are collected (the input file list is what the fusion
 * layer needs). Paths are normalized and deduplicated, first-appearance
 * order preserved; relative paths are relative to the workspace root and
 * stay relative, absolute paths (system .sty/.cls/.fmt) stay absolute.
 */
import { posix } from "node:path";

function normalizeFlsPath(p: string): string {
  const norm = posix.normalize(p);
  return norm.startsWith("./") ? norm.slice(2) : norm;
}

/** INPUT lines of a .fls recorder file → normalized, deduped path list. */
export function parseFls(content: string): string[] {
  const inputs: string[] = [];
  const seen = new Set<string>();
  for (const line of content.split("\n")) {
    const m = /^INPUT\s+(\S(?:.*\S)?)\s*$/.exec(line);
    const p = m?.[1];
    if (p === undefined) continue;
    const norm = normalizeFlsPath(p);
    if (!seen.has(norm)) {
      seen.add(norm);
      inputs.push(norm);
    }
  }
  return inputs;
}
