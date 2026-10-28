import type { Job, WsCopilotEvent, WsCopilotViewAction, WsServerMessage } from "@argelanderspace/contracts";

// Typed event bus for the server's /ws channel. Every server message type is
// routed through one exhaustive table (`HANDLERS`): a type added to the
// contracts union without a row here is a compile error, and a type the table
// does not know (an older client, a newer server) is dropped — it can never
// fall through to the job listeners, the accident the former if/else chain
// suffered three times (Stage 4 plan.changed, Stage 8 annotation.changed,
// Stage 10 writer.changed).
//
// Connection: one lazily-opened socket; reconnects with exponential backoff
// (1s → 2s → … → 15s); every (re)open re-sends the Copilot subscriptions, and
// every close reports `connection(false)` to them.

export type WsType = WsServerMessage["type"];
/** The message(s) carrying `type` T, narrowed to it (the four job.* types share one schema). */
export type WsMessageOf<T extends WsType> = WsServerMessage extends infer M
  ? M extends WsServerMessage
    ? T extends M["type"]
      ? M & { type: T }
      : never
    : never
  : never;
export type JobListener = (job: Job, event: string) => void;

export interface CopilotSubscription {
  conversationId: string;
  viewId: string;
  event: (event: WsCopilotEvent) => void;
  viewAction?: (action: WsCopilotViewAction) => void;
  ready: () => void;
  connection: (connected: boolean) => void;
}

export interface WsBus {
  /**
   * Listen to one message type; the same handler is held once per type.
   * For the job.*, copilot.* and hello types the built-in listeners (job,
   * resync, Copilot subscriptions) run first and `on` handlers after them, so
   * a built-in listener that throws keeps this frame from `on` handlers — as
   * before, a throwing listener ends that frame's dispatch and onmessage
   * swallows the error.
   */
  on<T extends WsType>(type: T, handler: (msg: WsMessageOf<T>) => void): () => void;
  /** Job transitions (`job.*`, under their own type) and the `hello` snapshot replay (under `"hello"`). */
  onJob(cb: JobListener): () => void;
  /** Every (re)connect (`hello`), before the job snapshot replays: events may have been missed. */
  onResync(cb: () => void): () => void;
  /** Install event buffering before subscribe. The server acknowledgement precedes authoritative GET. */
  subscribeCopilot(subscription: CopilotSubscription): () => void;
  /** Open the connection if it is not open yet; every subscription above calls it. */
  start(): void;
}

type Handlers = { [K in WsType]: (msg: WsMessageOf<K>) => void };

const RETRY_MAX_MS = 15000;
const WS_OPEN = 1; // WebSocket.OPEN

/** The routing shared by the real and the fake bus; `send` reaches the socket when it is open. */
function createRouter(send: (frame: object) => void) {
  const listeners = new Map<WsType, Set<(msg: never) => void>>();
  const jobListeners = new Set<JobListener>();
  const resyncListeners = new Set<() => void>();
  const copilotSubscriptions = new Set<CopilotSubscription>();

  const emit = <T extends WsType>(msg: WsMessageOf<T>): void => {
    const set = listeners.get(msg.type);
    if (set) for (const cb of set) (cb as (m: WsMessageOf<T>) => void)(msg);
  };
  const job = (msg: WsMessageOf<"job.created" | "job.progress" | "job.done" | "job.failed">): void => {
    for (const cb of jobListeners) cb(msg.job, msg.type);
    emit(msg);
  };

  const HANDLERS: Handlers = {
    "copilot.event": (msg) => {
      for (const subscription of copilotSubscriptions) if (subscription.conversationId === msg.conversationId) subscription.event(msg);
      emit(msg);
    },
    "copilot.view-action": (msg) => {
      // Targeted at one view: exactly one local subscription may execute it.
      for (const subscription of copilotSubscriptions)
        if (subscription.viewId === msg.viewId && subscription.viewAction) {
          subscription.viewAction(msg);
          break;
        }
      emit(msg);
    },
    "copilot.subscribed": (msg) => {
      for (const subscription of copilotSubscriptions)
        if (subscription.conversationId === msg.conversationId && subscription.viewId === msg.viewId) subscription.ready();
      emit(msg);
    },
    hello: (msg) => {
      // A (re)connect: Mail may have changed while the socket was down.
      for (const cb of resyncListeners) cb();
      // late-joiner catch-up: surface the snapshot like ordinary job events
      for (const j of msg.jobs) for (const cb of jobListeners) cb(j, "hello");
      emit(msg);
    },
    "job.created": job,
    "job.progress": job,
    "job.done": job,
    "job.failed": job,
    "library.changed": emit,
    "plan.changed": emit,
    "annotation.changed": emit,
    "argument-graph.changed": emit,
    "writer.changed": emit,
    "text-source.changed": emit,
    "text-doc.published": emit,
    "mail.changed": emit,
    "settings.changed": emit,
    // The Project root's intake checklist appeared or went (project-intake ticket 06): only an explicit `on` (the Library entries).
    "intake.changed": emit,
    // The Shelf changed through this server (shelf ticket 03): only an explicit `on` (the Shelf dialog, the add button).
    "shelf.changed": emit,
    // A folder the shell picked waits for the user's confirmation (desktop-app ticket 19): only an explicit `on`.
    "host.switch-confirmation": emit,
    // A tutorial entry the host took failed (in-app-tutorial ticket 25): only an explicit `on`.
    "host.tutorial-result": emit,
    // The external requests queue changed (release-0.2 ticket 04): only an explicit `on` (the dock reads it again).
    "external-requests.changed": emit,
    // Position notifications never navigate another tab; its reader remains
    // user-controlled. No built-in routing: only an explicit `on` sees it.
    "pdf-reading-position.changed": emit,
  };

  // Own keys only: `toString` and friends are not message types.
  const routed = new Set<unknown>(Object.keys(HANDLERS));

  /** Route one parsed frame; a type outside the table is ignored. Listener errors propagate to the caller. */
  function dispatch(msg: WsServerMessage): void {
    const type = (msg as { type?: unknown }).type;
    if (!routed.has(type)) return;
    (HANDLERS[type as WsType] as (m: WsServerMessage) => void)(msg);
  }

  function sendSubscription(subscription: CopilotSubscription, type = "copilot.subscribe"): void {
    send({ type, conversationId: subscription.conversationId, viewId: subscription.viewId });
  }

  const add = <V>(set: Set<V>, value: V, start: () => void): (() => void) => {
    set.add(value);
    start();
    return () => {
      set.delete(value);
    };
  };

  function bus(start: () => void): WsBus {
    return {
      on(type, handler) {
        let set = listeners.get(type);
        if (!set) listeners.set(type, (set = new Set()));
        return add(set, handler as (msg: never) => void, start);
      },
      onJob: (cb) => add(jobListeners, cb, start),
      onResync: (cb) => add(resyncListeners, cb, start),
      subscribeCopilot(subscription) {
        copilotSubscriptions.add(subscription);
        start();
        sendSubscription(subscription);
        return () => {
          copilotSubscriptions.delete(subscription);
          sendSubscription(subscription, "copilot.unsubscribe");
        };
      },
      start,
    };
  }

  return { dispatch, sendSubscription, copilotSubscriptions, bus };
}

/** The live bus over a socket from `socketFactory` (called once per (re)connect). */
export function createWsBus(socketFactory: () => WebSocket): WsBus {
  let started = false;
  let socket: WebSocket | null = null;
  let retryMs = 1000;
  let retryTimer: number | undefined;

  const router = createRouter((frame) => {
    if (socket?.readyState === WS_OPEN) socket.send(JSON.stringify(frame));
  });

  function scheduleReconnect(): void {
    if (!started) return;
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }

  function connect(): void {
    try {
      socket = socketFactory();
    } catch {
      scheduleReconnect();
      return;
    }
    socket.onopen = () => {
      retryMs = 1000;
      for (const subscription of router.copilotSubscriptions) router.sendSubscription(subscription);
    };
    socket.onmessage = (ev: MessageEvent) => {
      try {
        router.dispatch(JSON.parse(String(ev.data)) as WsServerMessage);
      } catch {
        /* a malformed frame must not kill the channel */
      }
    };
    socket.onclose = () => {
      socket = null;
      for (const subscription of router.copilotSubscriptions) subscription.connection(false);
      scheduleReconnect();
    };
    socket.onerror = () => {
      socket?.close();
    };
  }

  return router.bus(() => {
    if (started) return;
    started = true;
    connect();
  });
}

/** A socket-free bus for tests: `emit` runs the same table the live bus runs; Copilot subscribe frames go nowhere. */
export function createFakeBus(): WsBus & { emit<T extends WsType>(type: T, msg: Omit<WsMessageOf<T>, "type">): void } {
  const router = createRouter(() => {});
  return {
    ...router.bus(() => {}),
    emit(type, msg) {
      router.dispatch({ ...msg, type } as unknown as WsServerMessage);
    },
  };
}
