/**
 * Vitest global setup (runs once in the main process, before any test worker is started): gives the whole run its own
 * temporary directory and removes it, with whatever is left in it, when the run ends. The workers and the processes
 * they spawn inherit `TMPDIR`, so every `os.tmpdir()`-based fixture of every test lands below it.
 *
 * `track-temp-dirs.ts` already removes the directories each file made as the file finishes; this is the net under
 * it for the ones that appear later (a background write of the code under test landing after a test removed its own
 * directory, a child process that outlives its test) — web-test-flake ticket 06.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const previous = process.env.TMPDIR;
  const root = mkdtempSync(join(tmpdir(), "aspace-test-run-"));
  process.env.TMPDIR = root;
  return () => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      // A straggler (a background write of the code under test) was still adding to the directory while it was
      // removed, so it was not empty at the last attempt. A leftover temp directory is never a reason to fail a run.
      console.warn(
        `global-temp-dir: could not remove ${root}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
}
