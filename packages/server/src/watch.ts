/**
 * External-write watcher (Stage 3; plans sub-fingerprint added in Stage 4;
 * annotations sub-fingerprint in Stage 8): agents writing through the CLI
 * mutate `<dataDir>/library/library.json` (atomic tmp+rename),
 * `<dataDir>/output/<docId>/<docId>.json`, and `<statusDir>/plans.json`
 * directly, bypassing the server — so no in-process mutation fires and WS
 * clients never learn about the change. `createServer` runs this watcher and
 * rebroadcasts: library-side changes as `library.changed` "external",
 * plans-side as `plan.changed` "external", annotations-side as one
 * `annotation.changed` "external" per changed doc, and writer-side (Stage 10)
 * as `writer.changed` per changed manuscript / a templates-dir flag.
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
  /** Called once per poll in which writer manuscripts or the templates dir
   *  changed (Stage 10). `ids` = changed/created/deleted manuscript ids
   *  (sorted); `templates: true` marks a templates-dir change. Assets are
   *  deliberately NOT fingerprinted (epoch-review D4). Optional: pre-Stage-10
   *  callers don't observe the domain. */
  onWriterChange?: (changes: { ids: string[]; templates: boolean }) => void;
}

export interface Watcher {
  stop(): void;
}

/** Poll the three sub-fingerprints; fire the matching callback(s) on change. */
export function startWatcher(opts: WatcherOptions): Watcher {
  let lastLibrary = libraryFingerprint(opts.dataDir);
  let lastPlans = plansFingerprint(opts.statusDir);
  let lastAnnotations = annotationsFingerprint(opts.dataDir);
  let lastWriter = writerFingerprint(opts.dataDir);
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
    const nextWriter = writerFingerprint(opts.dataDir);
    const writerChanges = changedWriter(lastWriter, nextWriter);
    if (writerChanges.ids.length > 0 || writerChanges.templates) {
      lastWriter = nextWriter;
      opts.onWriterChange?.(writerChanges);
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

/**
 * The writer fingerprints (Stage 10): per manuscript `manuscript.json` stamps
 * under `manuscripts/m_.../`, plus the `templates/*.json` name-stamp set. Like
 * annotations this is a per-entry map so the callback can name the changed
 * manuscript. `assets/` is deliberately NOT observed (epoch-review D4: no
 * asset watching).
 */
function writerFingerprint(dataDir: string): {
  manuscripts: Map<string, string>;
  templates: string;
} {
  const manuscripts = new Map<string, string>();
  const root = join(dataDir, "manuscripts");
  let names: string[] = [];
  try {
    if (statSync(root).isDirectory()) names = readdirSync(root).sort();
  } catch {
    names = []; // not a directory / missing: empty listing (library pattern above)
  }
  for (const name of names) {
    if (!/^m_[0-9a-f]{8}$/.test(name)) continue;
    try {
      if (!statSync(join(root, name)).isDirectory()) continue;
    } catch {
      continue; // vanished mid-poll
    }
    manuscripts.set(name, stamp(join(root, name, "manuscript.json")));
  }
  const templatesDir = join(dataDir, "templates");
  let templates = "-";
  try {
    if (statSync(templatesDir).isDirectory()) {
      templates = readdirSync(templatesDir)
        .filter((n) => n.endsWith(".json"))
        .sort()
        .map((n) => `${n}=${stamp(join(templatesDir, n))}`)
        .join("\n");
    }
  } catch {
    templates = "-"; // missing/vanished: still part of the fingerprint
  }
  return { manuscripts, templates };
}

/** Manuscript ids whose stamp changed (changed/created/deleted), plus the
 *  templates-dir change flag. Sorted for a deterministic callback payload. */
function changedWriter(
  prev: { manuscripts: Map<string, string>; templates: string },
  next: { manuscripts: Map<string, string>; templates: string }
): { ids: string[]; templates: boolean } {
  const ids = new Set<string>();
  for (const [id, s] of next.manuscripts) {
    if (prev.manuscripts.get(id) !== s) ids.add(id);
  }
  for (const id of prev.manuscripts.keys()) {
    if (!next.manuscripts.has(id)) ids.add(id);
  }
  return { ids: [...ids].sort(), templates: prev.templates !== next.templates };
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
