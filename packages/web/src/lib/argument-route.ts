/**
 * The argument graph view's route and navigation bus (ticket 04), the same arrangement as the explore mode
 * (explore-route.ts, both on hash-route.ts): the open view owns the URL as `/#argument/<url-encoded work id>`. Entering the
 * view pushes one history entry (Back leaves it); a boot-time or hashchange `#argument/…` is held as `pending` until a
 * Library page registers. The selected argument is not in the URL.
 *
 * A request may name the Library pane that must host the view (`paneId`): the Reader's entry shows that pane first, and
 * the view opens in exactly it, however many Library panes there are.
 */
import { createHashRoute, createRouteBus } from "./hash-route";

const route = createHashRoute("argument");

export const parseArgumentHash = route.parse;
export const argumentUrl = route.url;
/** pushState: browser Back returns to the Library. */
export const pushArgumentUrl = route.push;
export const clearArgumentUrl = route.clear;

export interface ArgumentTarget {
  /** The pane this Library page is in (a request that names a pane is served by that pane only). */
  paneId?: number;
  /** Whether this Library page currently shows an argument graph. */
  isOpen(): boolean;
  /** Show the Work's graph; `push` writes the URL (a UI entry), a hash-driven request leaves it as it is. */
  open(workId: string, opts: { push: boolean }): void;
  /** Leave the view (the URL no longer names a graph). */
  exit(): void;
}

interface ArgumentRequest {
  workId: string;
  push: boolean;
  paneId?: number;
}

const bus = createRouteBus<ArgumentTarget, ArgumentRequest>({
  active: (t) => t.isOpen(),
  open: (t, r) => t.open(r.workId, { push: r.push }),
  exit: (t) => t.exit(),
  accepts: (t, r) => r.paneId === undefined || t.paneId === r.paneId,
});

export const argumentBus = {
  /** Shell on boot / popstate / hashchange (`push: false`), and any entry point outside the Library page (`push: true`, with the pane it chose). */
  request(workId: string, opts: { push?: boolean; paneId?: number } = {}): void {
    bus.request({ workId, push: opts.push ?? false, ...(opts.paneId === undefined ? {} : { paneId: opts.paneId }) });
  },
  /** The URL stopped naming a graph (popstate to a plain URL). */
  exit: (): void => bus.exit(),
  register: (t: ArgumentTarget): (() => void) => bus.register(t),
};

let openWork: string | null = null;
/** The Work whose graph the open view shows (null when none is open): what Shell restores the URL to when a draft keeps the view. */
export const openArgumentWork = (): string | null => openWork;
export const setOpenArgumentWork = (workId: string | null): void => {
  openWork = workId;
};
