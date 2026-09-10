/**
 * External-write watcher (Stage 3; plans sub-fingerprint added in Stage 4;
 * annotations sub-fingerprint in Stage 8): agents writing through the CLI
 * mutate `<dataDir>/library/library.json` (atomic tmp+rename),
 * `<dataDir>/output/<docId>/<docId>.json`, and `<statusDir>/plans.json`
 * directly, bypassing the server — so no in-process mutation fires and WS
 * clients never learn about the change. `createServer` runs this watcher and
 * rebroadcasts: library-side changes as `library.changed` "external",
 * plans-side as `plan.changed` "external", annotations-side as one
 * `annotation.changed` "external" per changed doc.
 *
 * Implementation: a polling fingerprint, not `fs.watch`. A non-recursive
 * `fs.watch` on `output/` misses `<docId>.json` landing inside a doc
 * directory that already exists (the upload layout: the directory is created
 * first, the JSON written into it later), and per-directory watchers are far
 * more machinery than this needs; a poll is deterministic in tests.
 *
 * The three sub-fingerprints are compared independently so the rebroadcast
 * names the right domain: the library one is `library/library.json`'s
 * mtime+size plus the `output/` first-level directory listing with each
 * `<dir>/<dir>.json`'s mtime+size; the plans one is `status/plans.json`'s
 * mtime+size; the annotations one is each `annotations/<docId>/current.json`'s
 * mtime+size, PER DOC — the callback carries the changed doc ids so the
 * broadcast can name the doc. `archive/` is deliberately NOT observed
 * (archives are server-produced, immutable, and invisible to readers), and
 * the watcher only notifies — archiving itself happens on the REST access
 * path (roadmap §4), never here. Missing entries are tolerated (a
 * nonexistent directory is an empty fingerprint). The first poll only
 * establishes the baseline. The server's own writes re-trigger it too —
 * accepted: the frontend reload is idempotent.
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
  /** Called once per poll in which any doc's annotations `current.json`
   *  changed (created/rewritten/deleted), with those doc ids (sorted). */
  onAnnotationsChange: (docIds: string[]) => void;
}

export interface Watcher {
  stop(): void;
}

/** Poll the three sub-fingerprints; fire the matching callback(s) on change. */
export function startWatcher(opts: WatcherOptions): Watcher {
  let lastLibrary = libraryFingerprint(opts.dataDir);
  let lastPlans = plansFingerprint(opts.statusDir);
  let lastAnnotations = annotationsFingerprint(opts.dataDir);
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
    const nextAnnotations = annotationsFingerprint(opts.dataDir);
    const changedDocs = changedAnnotationDocs(lastAnnotations, nextAnnotations);
    if (changedDocs.length > 0) {
      lastAnnotations = nextAnnotations;
      opts.onAnnotationsChange(changedDocs);
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

/**
 * The annotations fingerprint: a per-doc map of `current.json` stamps under
 * `annotations/` (doc dirs that vanished mid-poll are skipped). Only
 * `current.json` is stamped — `archive/` stays unobserved (see the banner).
 */
function annotationsFingerprint(dataDir: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = join(dataDir, "annotations");
  let names: string[] = [];
  try {
    if (statSync(root).isDirectory()) names = readdirSync(root).sort();
  } catch {
    names = []; // not a directory / missing: empty listing (library pattern above)
  }
  for (const name of names) {
    try {
      if (!statSync(join(root, name)).isDirectory()) continue;
    } catch {
      continue; // vanished mid-poll
    }
    out.set(name, stamp(join(root, name, "current.json")));
  }
  return out;
}

/** Doc ids whose stamp changed between two polls: changed, created, or
 *  deleted `current.json`. Sorted for a deterministic callback payload. */
function changedAnnotationDocs(prev: Map<string, string>, next: Map<string, string>): string[] {
  const changed = new Set<string>();
  for (const [docId, s] of next) {
    if (prev.get(docId) !== s) changed.add(docId);
  }
  for (const docId of prev.keys()) {
    if (!next.has(docId)) changed.add(docId);
  }
  return [...changed].sort();
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
