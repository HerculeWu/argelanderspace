import { useSyncExternalStore } from "react";
import { type ArgumentGraphMergeNote, ArgumentGraphMergeNoteSchema, type Job, jobTarget } from "@argelanderspace/contracts";
import { onJobEvent } from "../api/ws";

/*
 * The argument-graph notes of finished background tasks (ticket 06). A notice comes from the task RECORD, not from this
 * page having watched it run: the server keeps every job (its `result` included) and replays the table in `hello` on
 * every (re)connect, so a task that finished while the Work detail was closed, the Reader was open or the page was
 * reloaded still has its note. The store lives at module level (the Work detail mounts and unmounts; this does not) and
 * is started once by the app shell. "Dismissed" is per job id in this browser's localStorage, so a reload does not
 * bring back a note the user closed.
 */

/** What a finished task's library rebuild did with argument graphs when it merged Works. */
export interface MergeNotice {
  jobId: string;
  /** The Work the task was started for (the notice is shown on that Work). */
  workId: string;
  notes: ArgumentGraphMergeNote[];
}

const DISMISSED_KEY = "argelander.dismissedGraphMergeNotices";
const DISMISSED_CAP = 300;

/** The notes a finished job carries in its result (a foreign shape yields none). */
export function jobMergeNotes(job: Job): ArgumentGraphMergeNote[] {
  const raw = (job.result as { argument_graph_merges?: unknown } | null)?.argument_graph_merges;
  const parsed = ArgumentGraphMergeNoteSchema.array().safeParse(raw);
  return parsed.success ? parsed.data : [];
}

function loadDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return []; // storage blocked or corrupt: nothing is remembered as dismissed
  }
}

let dismissed = new Set<string>(loadDismissed());
const entries = new Map<string, MergeNotice>();
const listeners = new Set<() => void>();
let snapshot: readonly MergeNotice[] = [];
let stop: (() => void) | null = null;

function publish(): void {
  snapshot = [...entries.values()].filter((n) => !dismissed.has(n.jobId));
  for (const cb of listeners) cb();
}

/**
 * Take a job frame in. Only a finished job counts: done, or failed/interrupted AFTER it already merged Works and
 * moved graphs (its result then still carries the notes).
 */
export function ingestMergeNotice(job: Job): void {
  if (job.status === "queued" || job.status === "running") return;
  // The Work the task was started for; an empty one is none.
  const workId = jobTarget(job).workId || null;
  const notes = workId ? jobMergeNotes(job) : [];
  if (!workId || notes.length === 0) return;
  entries.set(job.id, { jobId: job.id, workId, notes });
  publish();
}

/** Subscribe the store to the job feed for the page's lifetime (idempotent). */
export function startMergeNotices(): void {
  if (stop !== null) return;
  const off = onJobEvent((job) => ingestMergeNotice(job));
  window.addEventListener("storage", onStorage);
  stop = () => {
    off();
    window.removeEventListener("storage", onStorage);
  };
}

/** Fold what another tab (or an earlier load) stored into this page's set; order is kept, the newest last. */
function absorbStored(): void {
  for (const id of loadDismissed()) {
    // an id seen again moves to the recent end, so the cap drops the oldest, not the latest closed
    dismissed.delete(id);
    dismissed.add(id);
  }
}

function onStorage(e: StorageEvent): void {
  if (e.key !== DISMISSED_KEY && e.key !== null) return;
  absorbStored();
  publish();
}

export function dismissMergeNotice(jobId: string): void {
  // another tab may have closed notices since this page last wrote: take the union, never overwrite it
  const stored = loadDismissed();
  const merged = new Set<string>(stored);
  for (const id of dismissed) {
    merged.delete(id);
    merged.add(id);
  }
  merged.delete(jobId);
  merged.add(jobId); // the one just closed is the most recent
  while (merged.size > DISMISSED_CAP) merged.delete(merged.values().next().value as string);
  dismissed = merged;
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch {
    /* kept for this page only */
  }
  publish();
}

/**
 * Test seam: forget every notice. By default the remembered dismissals go too; with `reload` they are read back from
 * localStorage, which is what a page reload does.
 */
export function resetMergeNoticesForTests(reload = false): void {
  entries.clear();
  if (reload) dismissed = new Set(loadDismissed());
  else {
    dismissed = new Set();
    try {
      localStorage.removeItem(DISMISSED_KEY);
    } catch {
      /* ignore */
    }
  }
  stop?.();
  stop = null;
  publish();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** The notices not yet dismissed, all Works; callers pick their own. */
export function useMergeNotices(): readonly MergeNotice[] {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
