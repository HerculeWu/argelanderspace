/**
 * The identity of this browser tab as a Copilot view. It is kept apart from message context: a message
 * remembers the page it was written from, while the view id/revision only say which tab receives
 * navigation and which published page is newest.
 *
 * The id lives in sessionStorage, so a reload (F5) is the same view: an action that waited for a dropped
 * connection still finds its tab, and the revision keeps counting upwards so the service never mistakes
 * the reloaded page for an older one. sessionStorage is per tab; a duplicated tab inherits it, which the
 * lock below detects. Without storage the tab simply gets a fresh id each load.
 */
const KEY = "argelander.copilot.view";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ViewIdentity {
  viewId: string;
  revision: number;
}

export function loadViewIdentity(): ViewIdentity {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ViewIdentity>;
      if (typeof parsed.viewId === "string" && UUID.test(parsed.viewId) && Number.isInteger(parsed.revision) && (parsed.revision as number) >= 0)
        return { viewId: parsed.viewId, revision: parsed.revision as number };
    }
  } catch {
    /* private window or blocked storage: a new id for this load */
  }
  return { viewId: crypto.randomUUID(), revision: 0 };
}

export function saveViewIdentity(identity: ViewIdentity): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(identity));
  } catch {
    /* per-tab convenience only */
  }
}

interface LockManagerLike {
  request: (name: string, options: { ifAvailable: true }, callback: (lock: unknown) => Promise<void> | void) => Promise<unknown>;
}

interface Claim {
  state: "pending" | "held" | "taken";
  users: number;
  release: () => void;
  listeners: Set<{ onHeld: () => void; onTaken: () => void }>;
  dropTimer?: number;
}
// One claim per view id for the whole document: React may mount, clean up and mount an effect again (StrictMode),
// and the second request must not be refused by the first one's lock.
const claims = new Map<string, Claim>();

/**
 * Hold a lock named after the view id for the life of the tab. When another tab already holds it (this tab
 * was duplicated and inherited the id), `onTaken` runs so the caller can switch to a fresh id: two tabs must
 * never answer to the same view. `onHeld` says the id is this tab's alone (also when the browser has no Web
 * Locks): the caller may subscribe and publish only after one of the two. The returned function gives the
 * claim up; a remount in the same tick keeps it.
 */
export function claimViewId(
  viewId: string,
  handlers: { onHeld: () => void; onTaken: () => void },
  locks: LockManagerLike | undefined = (navigator as unknown as { locks?: LockManagerLike }).locks
): () => void {
  let claim = claims.get(viewId);
  if (!claim) {
    const created: Claim = { state: "pending", users: 0, release: () => {}, listeners: new Set() };
    claim = created;
    claims.set(viewId, created);
    const settle = (state: "held" | "taken") => {
      created.state = state;
      for (const listener of [...created.listeners]) (state === "held" ? listener.onHeld : listener.onTaken)();
    };
    if (!locks) queueMicrotask(() => settle("held"));
    else
      void locks
        .request(`argelander-view-${viewId}`, { ifAvailable: true }, (lock) => {
          if (!lock) {
            settle("taken");
            return;
          }
          settle("held");
          return new Promise<void>((resolve) => {
            created.release = resolve;
          }); // held until the tab closes or the claim is given up
        })
        .catch(() => settle("held"));
  }
  const entry = claim;
  entry.users++;
  if (entry.dropTimer !== undefined) {
    window.clearTimeout(entry.dropTimer);
    entry.dropTimer = undefined;
  }
  entry.listeners.add(handlers);
  if (entry.state === "held") queueMicrotask(() => entry.listeners.has(handlers) && handlers.onHeld());
  if (entry.state === "taken") queueMicrotask(() => entry.listeners.has(handlers) && handlers.onTaken());
  return () => {
    entry.listeners.delete(handlers);
    entry.users--;
    if (entry.users > 0) return;
    entry.dropTimer = window.setTimeout(() => {
      if (entry.users > 0) return;
      entry.release();
      claims.delete(viewId);
    }, 0);
  };
}
