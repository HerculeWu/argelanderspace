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
  /** The Work whose graph this Library page shows (null when it shows none). */
  workId(): string | null;
  /** Show the Work's graph; `push` writes the URL (a UI entry), a hash-driven request leaves it as it is. */
  open(workId: string, opts: { push: boolean; confirmed?: boolean }): void;
  /** Leave the view (the URL no longer names a graph). */
  exit(): void;
}

interface ArgumentRequest {
  workId: string;
  push: boolean;
  paneId?: number;
  /** The caller already asked about leaving the graph that is open (the Shell, for the browser's Back/Forward). */
  confirmed?: boolean;
}

const bus = createRouteBus<ArgumentTarget, ArgumentRequest>({
  active: (t) => t.isOpen(),
  open: (t, r) => t.open(r.workId, { push: r.push, ...(r.confirmed ? { confirmed: true } : {}) }),
  exit: (t) => t.exit(),
  accepts: (t, r) => r.paneId === undefined || t.paneId === r.paneId,
});

export const argumentBus = {
  /** Shell on boot / popstate / hashchange (`push: false`), and any entry point outside the Library page (`push: true`, with the pane it chose). */
  request(workId: string, opts: { push?: boolean; paneId?: number; confirmed?: boolean } = {}): void {
    bus.request({ workId, push: opts.push ?? false, ...(opts.paneId === undefined ? {} : { paneId: opts.paneId }), ...(opts.confirmed ? { confirmed: true } : {}) });
  },
  /** The URL stopped naming a graph (popstate to a plain URL). */
  exit: (): void => bus.exit(),
  register: (t: ArgumentTarget): (() => void) => bus.register(t),
  /**
   * The Library page whose open graph a navigation to `workId` (null: the URL no longer names a graph) would replace or
   * close, with the Work it shows; null when that navigation leaves every open graph as it is. This is per pane: which pane
   * shows a graph is the pane's own business (two Library panes can both have shown one, and one of them be back at the
   * Library), and it is asked of the page the bus would act on. The Shell asks that pane's leave guard before it lets a
   * browser Back/Forward through.
   */
  affected(workId: string | null): { paneId: number | undefined; open: string } | null {
    const target = workId === null ? bus.peek() : bus.peek({ workId, push: false });
    const open = target?.isOpen() ? target.workId() : null;
    if (!target || open === null || open === workId) return null;
    return { paneId: target.paneId, open };
  },
};


