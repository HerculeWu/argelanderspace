import { useEffect, useSyncExternalStore } from "react";
import { type Job, jobTarget } from "@argelanderspace/contracts";
import { bus } from "../api/ws-instance";

/*
 * The one-time "add to Shelf?" reminder after an ingest succeeded (shelf ticket 05; spec Q5, review Q2/Q3).
 *
 * - Shown on the Work whose full text was just acquired: a LaTeX zip upload, a PDF upload, an arXiv source or PDF
 *   acquisition that this page saw finish (`job.done`). A `hello` replay of the job table is not a new success: the
 *   server keeps every old job, and treating them as new would remind about every Work ever ingested.
 * - It stays until the person closes it (×) or adds the Work through it — switching Works, reloading the page or
 *   reopening the detail does not make it go (review Q3). So the state is kept in this browser's localStorage, per
 *   project folder (Work ids repeat across projects): the Works with a standing reminder, and the Works it was closed
 *   for. A Work reminded about once is never reminded about again in that project ("each Work once").
 * - localStorage is a per-browser convenience: a private window or blocked storage keeps it for this page only, and
 *   another browser does not see it. That is acceptable for a reminder; nothing about the Shelf depends on it.
 */

const KEY = "argelander.shelfIngestPrompts";
/** At most this many Works are remembered per project (the oldest go first). */
const CAP = 500;

interface ProjectRecord {
  /** Works with a standing reminder, oldest first. */
  pending: string[];
  /** Works whose reminder was closed or used, oldest first. */
  done: string[];
}

let project: string | null = null;
/** Successes seen before the project folder was known (kept for this page, merged in once it is). */
let early: string[] = [];
let record: ProjectRecord = { pending: [], done: [] };
let snapshot: readonly string[] = [];
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function readAll(): Record<string, ProjectRecord> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const out: Record<string, ProjectRecord> = {};
    for (const [root, value] of Object.entries(raw as Record<string, unknown>)) {
      const v = (value ?? {}) as { pending?: unknown; done?: unknown };
      out[root] = { pending: strings(v.pending), done: strings(v.done) };
    }
    return out;
  } catch {
    return {}; // blocked or corrupt storage: nothing remembered
  }
}

function save(): void {
  if (project === null) return;
  try {
    const all = readAll();
    all[project] = record;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* kept for this page only */
  }
}

const capped = (list: string[]) => (list.length > CAP ? list.slice(list.length - CAP) : list);

function publish(): void {
  snapshot = record.pending.filter((w) => !record.done.includes(w));
  for (const cb of listeners) cb();
}

function remember(workId: string): void {
  if (record.done.includes(workId) || record.pending.includes(workId)) return;
  record = { ...record, pending: capped([...record.pending, workId]) };
}

/** A finished acquisition of a Work's full text (the kinds the Full text tab follows). */
export function isIngestSuccess(job: Job): boolean {
  return job.status === "done" && (job.kind === "upload" || job.kind === "ingest") && !!jobTarget(job).workId;
}

/** Take a job frame in (`event` is the frame type; `hello` replays are ignored). */
export function ingestPromptJob(job: Job, event: string): void {
  if (event === "hello" || !isIngestSuccess(job)) return;
  const workId = jobTarget(job).workId as string;
  if (project === null) {
    if (!early.includes(workId)) early.push(workId);
    return;
  }
  const before = record;
  remember(workId);
  if (record !== before) {
    save();
    publish();
  }
}

/** The open project's folder (from the settings); the reminders are kept per folder. */
export function setIngestPromptProject(root: string | null): void {
  if (root === project) return;
  project = root;
  record = root === null ? { pending: [], done: [] } : (readAll()[root] ?? { pending: [], done: [] });
  if (root !== null && early.length > 0) {
    for (const w of early) remember(w);
    early = [];
    save();
  }
  publish();
}

/** The Shell keeps the reminders per open folder: `undefined` while the settings are not read, `null` for no project. */
export function useIngestPromptProject(root: string | null | undefined): void {
  useEffect(() => {
    if (root !== undefined) setIngestPromptProject(root);
  }, [root]);
}

/** The reminder for this Work was closed (×) or used to add it: it does not come back. */
export function dismissIngestPrompt(workId: string): void {
  early = early.filter((w) => w !== workId);
  record = { pending: record.pending.filter((w) => w !== workId), done: capped([...record.done.filter((w) => w !== workId), workId]) };
  save();
  publish();
}

function onStorage(e: StorageEvent): void {
  if ((e.key !== KEY && e.key !== null) || project === null) return;
  record = readAll()[project] ?? { pending: [], done: [] };
  publish();
}

/** Subscribe the store to the job feed for the page's lifetime (idempotent); the app shell starts it. */
export function startIngestPrompts(): () => void {
  if (stop === null) {
    const off = bus.onJob(ingestPromptJob);
    window.addEventListener("storage", onStorage);
    stop = () => {
      off();
      window.removeEventListener("storage", onStorage);
    };
  }
  return () => undefined;
}

/** Test seam: forget everything in memory (the stored copy stays unless `clearStorage`). */
export function resetIngestPromptsForTests(clearStorage = true): void {
  stop?.();
  stop = null;
  project = null;
  early = [];
  record = { pending: [], done: [] };
  if (clearStorage) {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }
  publish();
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

/** Whether this Work has a standing reminder. */
export function useIngestPrompt(workId: string): boolean {
  const pending = useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
  return pending.includes(workId);
}
