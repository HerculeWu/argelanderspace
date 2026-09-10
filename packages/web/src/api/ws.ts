import type { Job, WsServerMessage } from "@argelanderspace/contracts";

// Minimal WebSocket client for the server's /ws progress channel (M4). One
// lazily-opened connection per page, native WebSocket only, no dependencies.
//
// Protocol (server → client JSON frames): `hello` (job-table snapshot on
// connect), `job.created|progress|done|failed` (full job each time),
// `library.changed`, `plan.changed` (Stage 4), and `annotation.changed`
// (Stage 8).
// Reconnects with exponential backoff (1s → 2s → … → 15s)
// so a server restart silently re-subscribes.

type JobListener = (job: Job, event: string) => void;
type LibraryListener = () => void;
type PlanListener = () => void;
type AnnotationListener = (docId: string) => void;

const jobListeners = new Set<JobListener>();
const libraryListeners = new Set<LibraryListener>();
const planListeners = new Set<PlanListener>();
const annotationListeners = new Set<AnnotationListener>();

const RETRY_MAX_MS = 15000;

let started = false;
let socket: WebSocket | null = null;
let retryMs = 1000;
let retryTimer: number | undefined;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

function dispatch(msg: WsServerMessage): void {
  if (msg.type === "hello") {
    // late-joiner catch-up: surface the snapshot like ordinary job events
    for (const job of msg.jobs) {
      for (const cb of jobListeners) cb(job, "hello");
    }
  } else if (msg.type === "library.changed") {
    for (const cb of libraryListeners) cb();
  } else if (msg.type === "plan.changed") {
    for (const cb of planListeners) cb();
  } else if (msg.type === "annotation.changed") {
    // Stage 8 MS1: the listener set is in place (the else branch must never
    // treat this as a job event — the Stage-4 MS1 blocker precedent); MS3
    // wires the reader's annotation store to it.
    for (const cb of annotationListeners) cb(msg.doc_id);
  } else {
    for (const cb of jobListeners) cb(msg.job, msg.type);
  }
}

function scheduleReconnect(): void {
  if (!started) return;
  window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
}

function connect(): void {
  try {
    socket = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    retryMs = 1000;
  };
  socket.onmessage = (ev: MessageEvent) => {
    try {
      dispatch(JSON.parse(String(ev.data)) as WsServerMessage);
    } catch {
      /* a malformed frame must not kill the channel */
    }
  };
  socket.onclose = () => {
    socket = null;
    scheduleReconnect();
  };
  socket.onerror = () => {
    socket?.close();
  };
}

function ensureStarted(): void {
  if (started) return;
  started = true;
  connect();
}

/** Subscribe to job transitions (`hello` replays the current table once). */
export function onJobEvent(cb: JobListener): () => void {
  jobListeners.add(cb);
  ensureStarted();
  return () => {
    jobListeners.delete(cb);
  };
}

/** Subscribe to library mutations (refresh / patch / add / upload-done). */
export function onLibraryChanged(cb: LibraryListener): () => void {
  libraryListeners.add(cb);
  ensureStarted();
  return () => {
    libraryListeners.delete(cb);
  };
}

/** Subscribe to plan mutations (`PUT /api/plans` or an external plans.json write). */
export function onPlanChanged(cb: PlanListener): () => void {
  planListeners.add(cb);
  ensureStarted();
  return () => {
    planListeners.delete(cb);
  };
}

/** Subscribe to annotation mutations of one doc (`PUT` / invalidation /
 *  external write; Stage 8 — MS1 listener set, the reader subscribes in MS3). */
export function onAnnotationChanged(cb: AnnotationListener): () => void {
  annotationListeners.add(cb);
  ensureStarted();
  return () => {
    annotationListeners.delete(cb);
  };
}
