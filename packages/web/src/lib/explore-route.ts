/**
 * Stage 14 explore route + navigation bus (D2/D14).
 *
 * The active exploration owns the URL as `/#explore/<url-encoded-bibcode>`.
 * Only SUCCESSFUL seed transitions write history (pushState) — failures and
 * cancels never create entries. The bus links Shell's popstate/hashchange
 * handling to the LibraryView instance hosting the exploration (the one
 * currently exploring, else the first registered); the URL never encodes a
 * pane id. A request may name the pane whose Library page must take it
 * (ticket 09: Back puts an exploration back into the pane it was in); only
 * that pane's page serves it, and it waits as `pending` until that page
 * registers. A boot-time `#explore/…` hash is held as `pending` until a
 * LibraryView registers (Shell meanwhile ensures a library pane exists).
 * The mechanics are shared with the argument graph view (`hash-route.ts`).
 */
import { createHashRoute, createRouteBus } from "./hash-route";

const route = createHashRoute("explore");

export const parseExploreHash = route.parse;
export const exploreUrl = route.url;
/** pushState (not replaceState): browser Back/Forward walk the seed history. */
export const pushExploreUrl = route.push;
export const clearExploreUrl = route.clear;

export interface ExploreTarget {
  /** The pane the Library page is in (absent outside the workspace's panes). */
  paneId?: number;
  /** Whether this LibraryView currently hosts the active exploration. */
  isExploring(): boolean;
  /** Navigate to the seed: restore the session when known, else fetch fresh. */
  explore(seed: string): void;
  /** Leave explore mode (the URL no longer points at an exploration). */
  exit(): void;
}

interface ExploreRequest {
  seed: string;
  paneId?: number;
}

const bus = createRouteBus<ExploreTarget, ExploreRequest>({
  active: (t) => t.isExploring(),
  open: (t, r) => t.explore(r.seed),
  exit: (t) => t.exit(),
  accepts: (t, r) => r.paneId === undefined || t.paneId === r.paneId,
});

export const exploreBus = {
  /** Called by Shell on boot / popstate / hashchange for `#explore/…`; `paneId`: only that pane's Library page takes it. */
  request: (seed: string, opts: { paneId?: number } = {}): void => bus.request({ seed, ...(opts.paneId === undefined ? {} : { paneId: opts.paneId }) }),
  /** Called when the URL stops naming an exploration (popstate to a plain URL). */
  exit: (): void => bus.exit(),
  register: (t: ExploreTarget): (() => void) => bus.register(t),
  /** Whether the exploration that is open is in pane `paneId` (a page that names no pane counts as any). */
  hostedBy: (paneId: number): boolean => {
    const t = bus.peek();
    return t !== undefined && (t.paneId === undefined || t.paneId === paneId);
  },
};
