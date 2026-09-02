/**
 * External-write watcher (Stage 3; plans sub-fingerprint added in Stage 4):
 * agents writing through the CLI mutate `<dataDir>/library/library.json`
 * (atomic tmp+rename), `<dataDir>/output/<docId>/<docId>.json`, and
 * `<statusDir>/plans.json` directly, bypassing the server — so no in-process
 * mutation fires and WS clients never learn about the change. `createServer`
 * runs this watcher and rebroadcasts: library-side changes as
 * `library.changed` "external", plans-side as `plan.changed` "external".
 *
 * Implementation: a polling fingerprint, not `fs.watch`. A non-recursive
 * `fs.watch` on `output/` misses `<docId>.json` landing inside a doc
 * directory that already exists (the upload layout: the directory is created
 * first, the JSON written into it later), and per-directory watchers are far
 * more machinery than this needs; a poll is deterministic in tests.
 *
 * Two sub-fingerprints are compared independently so the rebroadcast names
 * the right domain: the library one is `library/library.json`'s mtime+size
 * plus the `output/` first-level directory listing with each
 * `<dir>/<dir>.json`'s mtime+size; the plans one is `status/plans.json`'s
 * mtime+size. Both changing inside one poll fires both callbacks. Missing
 * entries are tolerated (a nonexistent directory is an empty fingerprint).
 * The first poll only establishes the baseline. The server's own writes
 * re-trigger it too — accepted: the frontend reload is idempotent.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { plansPath } from "@argelanderspace/core";

export interface WatcherOptions {
  dataDir: string;
  /** The plan page's status dir (`plans.json` inside); `statusDirFor(dataDir)`. */
  statusDir: string;
  /** Poll interval in ms (default 1500); tests inject ~50. */
  intervalMs?: number;
  /** Called once per poll in which the library sub-fingerprint changed. */
  onLibraryChange: () => void;
  /** Called once per poll in which the plans sub-fingerprint changed. */
  onPlansChange: () => void;
}

export interface Watcher {
  stop(): void;
}

/** Poll both sub-fingerprints; fire the matching callback(s) on change. */
export function startWatcher(opts: WatcherOptions): Watcher {
  let lastLibrary = libraryFingerprint(opts.dataDir);
  let lastPlans = plansFingerprint(opts.statusDir);
  const timer = setInterval(() => {
    const nextLibrary = libraryFingerprint(opts.dataDir);
    if (nextLibrary !== lastLibrary) {
      lastLibrary = nextLibrary;
      opts.onLibraryChange();
    }
    const nextPlans = plansFingerprint(opts.statusDir);
    if (nextPlans !== lastPlans) {
      lastPlans = nextPlans;
      opts.onPlansChange();
    }
  }, opts.intervalMs ?? 1500);
  timer.unref(); // never keep the process alive just for watching
  return {
    stop: () => clearInterval(timer),
  };
}

/** The library fingerprint: `library.json` plus the `output/` doc dirs' doc JSONs. */
function libraryFingerprint(dataDir: string): string {
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

/** The plans fingerprint: just `status/plans.json`'s stamp. */
function plansFingerprint(statusDir: string): string {
  return stamp(plansPath(statusDir));
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
