import type { Job, WsServerMessage } from "@argelanderspace/contracts";

// Minimal WebSocket client for the server's /ws progress channel (M4). One
// lazily-opened connection per page, native WebSocket only, no dependencies.
//
// Protocol (server → client JSON frames): `hello` (job-table snapshot on
// connect), `job.created|progress|done|failed` (full job each time), and
// `library.changed`. Reconnects with exponential backoff (1s → 2s → … → 15s)
// so a server restart silently re-subscribes.

type JobListener = (job: Job, event: string) => void;
type LibraryListener = () => void;

const jobListeners = new Set<JobListener>();
const libraryListeners = new Set<LibraryListener>();

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
