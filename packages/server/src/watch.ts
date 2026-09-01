/**
 * External-write watcher (Stage 3): agents writing through the CLI mutate
 * `<dataDir>/library/library.json` (atomic tmp+rename) and
 * `<dataDir>/output/<docId>/<docId>.json` directly, bypassing the server — so
 * no in-process mutation fires and WS clients never learn about the change.
 * `createServer` runs this watcher and broadcasts `library.changed` with
 * cause "external" when it fires.
 *
 * Implementation: a polling fingerprint, not `fs.watch`. A non-recursive
 * `fs.watch` on `output/` misses `<docId>.json` landing inside a doc
 * directory that already exists (the upload layout: the directory is created
 * first, the JSON written into it later), and per-directory watchers are far
 * more machinery than this needs; a poll is deterministic in tests.
 *
 * The fingerprint is `library/library.json`'s mtime+size plus the `output/`
 * first-level directory listing with each `<dir>/<dir>.json`'s mtime+size.
 * Missing entries are tolerated (a nonexistent directory is an empty
 * fingerprint). The first poll only establishes the baseline. The server's
 * own writes re-trigger it too — accepted: the frontend reload is idempotent.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface LibraryWatcherOptions {
  dataDir: string;
  /** Poll interval in ms (default 1500); tests inject ~50. */
  intervalMs?: number;
  /** Called once per poll in which the fingerprint changed. */
  onChange: () => void;
}

export interface LibraryWatcher {
  stop(): void;
}

/** Poll the library fingerprint; call `onChange` whenever it changes. */
export function startLibraryWatcher(opts: LibraryWatcherOptions): LibraryWatcher {
  let last = fingerprint(opts.dataDir);
  const timer = setInterval(() => {
    const next = fingerprint(opts.dataDir);
    if (next === last) return;
    last = next;
    opts.onChange();
  }, opts.intervalMs ?? 1500);
  timer.unref(); // never keep the process alive just for watching
  return {
    stop: () => clearInterval(timer),
  };
}

/** The fingerprint: `library.json` plus the `output/` doc dirs' doc JSONs. */
function fingerprint(dataDir: string): string {
  const parts = [stamp(join(dataDir, "library", "library.json"))];
  const outputDir = join(dataDir, "output");
  let names: string[] = [];
  try {
    if (statSync(outputDir).isDirectory()) names = readdirSync(outputDir).sort();
  } catch {
    names = []; // not a directory / missing: empty listing (app.ts's pattern)
  }
  for (const name of names) {
    try {
      if (!statSync(join(outputDir, name)).isDirectory()) continue;
    } catch {
      continue; // vanished mid-poll
    }
    parts.push(`${name}=${stamp(join(outputDir, name, `${name}.json`))}`);
  }
  return parts.join("\n");
}

/** `mtimeNs:size` (bigint stats: `mtimeNs` only exists there); `-` if absent. */
function stamp(p: string): string {
  try {
    const st = statSync(p, { bigint: true });
    return `${st.mtimeNs}:${st.size}`;
  } catch {
    return "-"; // ENOENT tolerated: a missing file is part of the fingerprint
  }
}
