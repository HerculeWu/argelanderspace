import type { WsHostSwitchConfirmation, WsHostTutorialResult, WsArgumentGraphChanged, WsWriterChanged, WsTextSourceChanged, WsTextDocPublished, WsMailChanged } from "@argelanderspace/contracts";
import type { CopilotSubscription, JobListener } from "./ws-bus";
import { bus } from "./ws-instance";

// Minimal WebSocket client for the server's /ws progress channel (M4). One
// lazily-opened connection per page, native WebSocket only, no dependencies.
//
// Protocol (server → client JSON frames): the complete list is the contracts
// `WsServerMessageSchema`, and each type's routing is a row of `HANDLERS` in
// `ws-bus.ts`.
// Reconnects with exponential backoff (1s → 2s → … → 15s)
// so a server restart silently re-subscribes.
//
// Routing and the connection live in `ws-bus.ts`; the exports below forward to
// the page's one bus.

type LibraryListener = () => void;
type PlanListener = () => void;
type AnnotationListener = (docId: string) => void;
type WriterListener = (msg: WsWriterChanged) => void;


/** One adapter per listener, so registering the same listener twice still holds it once (set semantics). */
function adapter<C extends object, H>(make: (cb: C) => H): (cb: C) => H {
  const made = new WeakMap<C, H>();
  return (cb) => {
    let handler = made.get(cb);
    if (!handler) {
      handler = make(cb);
      made.set(cb, handler);
    }
    return handler;
  };
}
// Pure identity caches: they keep the old Set semantics (the same cb registered twice is delivered once, one off removes it).
const withoutMessage = adapter((cb: () => void) => () => cb());
const docIdOf = adapter((cb: AnnotationListener) => (msg: { doc_id: string }) => cb(msg.doc_id));

/** Subscribe to job transitions (`hello` replays the current table once). */
export const onJobEvent = (cb: JobListener): (() => void) => bus.onJob(cb);

/** A text Doc's source was saved (`text-source.changed`), or its reading text published (`text-doc.published`). */
export const onTextSourceChanged = (cb: (msg: WsTextSourceChanged) => void): (() => void) => bus.on("text-source.changed", cb);
export const onTextDocPublished = (cb: (msg: WsTextDocPublished) => void): (() => void) => bus.on("text-doc.published", cb);

/** Subscribe to live Mail INBOX changes (`mail.changed`, ticket 08); `onResync` fires on every (re)connect, when events may have been missed. */
export function onMailChanged(cb: (msg: WsMailChanged) => void, onResync?: () => void): () => void {
  const offs = [bus.on("mail.changed", cb), ...(onResync ? [bus.onResync(onResync)] : [])];
  return () => {
    for (const off of offs) off();
  };
}

/** Subscribe to library mutations (refresh / patch / add / upload-done). */
export const onLibraryChanged = (cb: LibraryListener): (() => void) => bus.on("library.changed", withoutMessage(cb));

/** Subscribe to plan mutations (`PUT /api/plans` or an external plans.json write). */
export const onPlanChanged = (cb: PlanListener): (() => void) => bus.on("plan.changed", withoutMessage(cb));

/** Subscribe to annotation mutations of one doc (`PUT` / invalidation /
 *  external write; Stage 8 — MS1 listener set, the reader subscribes in MS3). */
export const onAnnotationChanged = (cb: AnnotationListener): (() => void) => bus.on("annotation.changed", docIdOf(cb));

/**
 * A Work's argument graph was written (`PUT`, or its file changed on disk); the message names the Work. `onResync` fires on
 * every (re)connect, when a change may have been missed (the view reads once more).
 */
export function onArgumentGraphChanged(cb: (msg: WsArgumentGraphChanged) => void, onResync?: () => void): () => void {
  const offs = [bus.on("argument-graph.changed", cb), ...(onResync ? [bus.onResync(onResync)] : [])];
  return () => {
    for (const off of offs) off();
  };
}

/**
 * config.toml changed (a key changed through the settings endpoint, or the file changed on disk). `onResync` fires on
 * every (re)connect, when a change may have been missed.
 */
export function onSettingsChanged(cb: () => void, onResync?: () => void): () => void {
  const offs = [bus.on("settings.changed", withoutMessage(cb)), ...(onResync ? [bus.onResync(onResync)] : [])];
  return () => {
    for (const off of offs) off();
  };
}

/** Subscribe to writer mutations (`writer.changed`, Stage 10; wired in M2). */
export const onWriterChanged = (cb: WriterListener): (() => void) => bus.on("writer.changed", cb);

/** Install event buffering before subscribe. The server acknowledgement precedes authoritative GET. */
export const subscribeCopilot = (subscription: CopilotSubscription): (() => void) => bus.subscribeCopilot(subscription);

/** The desktop host holds a folder the shell picked until the user confirms the switch (desktop-app ticket 19). */
export const onHostSwitchConfirmation = (cb: (msg: WsHostSwitchConfirmation) => void): (() => void) =>
  bus.on("host.switch-confirmation", cb);

/** A tutorial entry the desktop host took failed (in-app-tutorial ticket 25): why, and the folder it was about. */
export const onHostTutorialResult = (cb: (msg: WsHostTutorialResult) => void): (() => void) =>
  bus.on("host.tutorial-result", cb);

