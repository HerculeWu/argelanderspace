/**
 * The Shell's panes outside React (copilot ticket 37): the pane list, the active pane, the leave-draft protection on
 * every change that leaves a Doc pane, and the one place a Copilot view action finds (or opens) the pane of its page
 * and waits for that page's controls. The Shell renders from this store and only subscribes to it.
 *
 * A view action goes to the page adapter that `handles` it: `ensurePane` applies the page's `needsPane` rule (and its
 * `available` check) before anything is switched, `whenReady` waits for the controls of a pane just switched to, and
 * `applyUntilAvailable` gives an `unavailable` answer the page's own time, finding the page's pane again every round
 * (the active pane when it shows the page, else the first one): a pane the user closed meanwhile ends the wait.
 */
import { MAX_PANES, type CopilotViewAction } from "@argelanderspace/contracts";
import { DEFAULT_TIMEOUTS, type PaneAdapter, type PanePage, unavailable, type ViewActionOutcome } from "./adapter";

export interface Pane {
  id: number;
  view: string;
  size: number;
}

export interface PaneState {
  panes: readonly Pane[];
  activeId: number;
  /** Bumped whenever a page reports something new, or a page adapter comes or goes. */
  pagesVersion: number;
}

/** How often a wait looks again. */
const POLL_MS = 50;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const rounds = (ms: number) => Math.round(ms / POLL_MS);

export interface PaneManagerOptions {
  panes: Pane[];
  activeId: number;
  /** One detached adapter per page: what a page answers when no pane of it is open. */
  pages: PaneAdapter[];
  /** The workspace's leave-draft protection; false keeps the Doc pane as it is. */
  confirmLeave: () => boolean;
}

export type PaneManager = ReturnType<typeof createPaneManager>;

type Ensured = { result: ViewActionOutcome } | { opened: boolean; pin?: number };

export function createPaneManager(options: PaneManagerOptions) {
  let state: PaneState = { panes: options.panes, activeId: options.activeId, pagesVersion: 0 };
  let nextId = Math.max(0, ...options.panes.map((pane) => pane.id)) + 1;
  const listeners = new Set<() => void>();
  const adapters = new Map<number, PaneAdapter>();

  const set = (next: Partial<PaneState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const activePane = () => state.panes.find((pane) => pane.id === state.activeId) ?? state.panes[0]!;
  const adapterOn = (paneId: number, page: string) => {
    const adapter = adapters.get(paneId);
    return adapter && adapter.page === page ? adapter : undefined;
  };
  const leaves = (pane: Pane | undefined, view?: string) => pane?.view === "doc" && view !== "doc";

  // ---- the panes ----------------------------------------------------------------------------- //

  const select = (id: number) => {
    if (state.activeId !== id) set({ activeId: id });
  };
  /** The activity bar: the active pane shows `view`. False when the leave-draft protection keeps a Doc pane. */
  const setActiveView = (view: string): boolean => {
    if (leaves(state.panes.find((pane) => pane.id === state.activeId), view) && !options.confirmLeave()) return false;
    set({ panes: state.panes.map((pane) => (pane.id === state.activeId ? { ...pane, view } : pane)) });
    return true;
  };
  /** The pane header menu: pane `id` shows `view` and becomes active. */
  const setPaneView = (id: number, view: string): boolean => {
    if (leaves(state.panes.find((pane) => pane.id === id), view) && !options.confirmLeave()) return false;
    set({ panes: state.panes.map((pane) => (pane.id === id ? { ...pane, view } : pane)), activeId: id });
    return true;
  };
  /** A copy of pane `id` next to it, which becomes active; nothing past the pane limit. */
  const split = (id: number) => {
    const panes = state.panes;
    if (panes.length >= MAX_PANES) return;
    const source = panes.find((pane) => pane.id === id) || panes[0]!;
    const created = nextId++;
    const index = panes.findIndex((pane) => pane.id === id);
    const copy = panes.map((pane) => ({ ...pane, size: 1 }));
    copy.splice(index + 1, 0, { id: created, view: source.view, size: 1 });
    set({ panes: copy, activeId: created });
  };
  /** False when the leave-draft protection keeps a Doc pane; the last pane is kept. */
  const close = (id: number): boolean => {
    if (state.panes.find((pane) => pane.id === id)?.view === "doc" && !options.confirmLeave()) return false;
    if (state.panes.length <= 1) return true;
    const filtered = state.panes.filter((pane) => pane.id !== id).map((pane) => ({ ...pane, size: 1 }));
    set({ panes: filtered, ...(id === state.activeId ? { activeId: filtered[0]!.id } : {}) });
    return true;
  };
  /** Any other change of the pane list (sizes, a Doc shown by openDoc); no leave protection of its own. */
  const update = (change: (panes: readonly Pane[]) => readonly Pane[]) => {
    const panes = change(state.panes);
    if (panes !== state.panes) set({ panes });
  };

  // ---- the pages ----------------------------------------------------------------------------- //

  /** A page mounted in a pane; the returned function forgets it (its context and controller with it). */
  const register = (paneId: number, adapter: PaneAdapter) => {
    adapters.set(paneId, adapter);
    changed();
    return () => {
      if (adapters.get(paneId) !== adapter) return;
      adapters.delete(paneId);
      changed();
    };
  };
  /** A page reported something new. */
  const changed = () => set({ pagesVersion: state.pagesVersion + 1 });
  /** The page a pane shows: its mounted adapter, else what the page answers before it is mounted. */
  const pageOf = (pane: Pane): PaneAdapter | undefined => adapterOn(pane.id, pane.view) ?? options.pages.find((page) => page.page === pane.view);
  const mounted = (page: PanePage) => [...adapters.values()].filter((adapter) => adapter.page === page);

  // ---- Copilot view actions ------------------------------------------------------------------ //

  const can = (pane: Pane, page: PanePage, action: CopilotViewAction) => {
    const adapter = adapterOn(pane.id, page);
    return !!adapter && (adapter.available ? adapter.available(action) : true);
  };
  /** The pane an action runs on: the pinned one (active-only), else the active pane when it shows the page, else the first. */
  const resolve = (page: PanePage, pin?: number) => {
    if (pin !== undefined) return state.panes.find((pane) => pane.id === pin && pane.view === page);
    const active = activePane();
    return active.view === page ? active : state.panes.find((pane) => pane.view === page);
  };
  const whenReady = async (paneId: number, page: PanePage, readyMs: number) => {
    const ready = () => {
      const adapter = adapterOn(paneId, page);
      return !!adapter && (adapter.ready?.() ?? true);
    };
    for (let attempt = 0; attempt < rounds(readyMs) && !ready(); attempt++) await wait(POLL_MS);
    return ready();
  };
  /** Finds or opens the pane per the page's `needsPane` rule; a refusal is decided before anything is switched. */
  const ensurePane = async (kind: PaneAdapter, action: CopilotViewAction): Promise<Ensured> => {
    const page = kind.page;
    const rule = kind.needsPane(action);
    const active = activePane();
    if (rule === "active-only") {
      // the pane whose page the Copilot was shown: never another one, never switched to
      if (active.view !== page || !can(active, page, action)) return { result: kind.refused?.(action) ?? unavailable() };
      return { opened: false, pin: active.id };
    }
    const ofPage = [active, ...state.panes].filter((pane) => pane.view === page);
    const present = ofPage.length > 0 && (kind.shows?.(action) ?? true);
    if (rule === "existing-only") {
      if (!present) return { result: unavailable() };
      if (kind.available) {
        const pane = ofPage.find((candidate) => can(candidate, page, action));
        if (!pane) return { result: kind.refused?.(action) ?? unavailable() };
        select(pane.id);
      }
      return { opened: false };
    }
    if (present) return { opened: false };
    const none = kind.noPaneResult?.(action);
    if (none) return { result: none };
    if (kind.open) {
      const opened = await kind.open(action);
      return opened.ok ? { opened: true } : { result: opened };
    }
    if (!setPaneView(active.id, page)) return { result: { ok: false, detail: "leave_blocked" } };
    const readyMs = kind.timeouts?.readyMs ?? DEFAULT_TIMEOUTS.readyMs;
    if (readyMs > 0 && !(await whenReady(active.id, page, readyMs))) return { result: unavailable() };
    return { opened: true };
  };
  /** Runs the action on the page's pane; an `unavailable` answer is tried again for `applyMs` (0: once). */
  const applyUntilAvailable = async (kind: PaneAdapter, action: CopilotViewAction, applyMs: number, pin?: number): Promise<ViewActionOutcome> => {
    const total = Math.max(1, rounds(applyMs));
    for (let attempt = 0; attempt < total; attempt++) {
      const pane = resolve(kind.page, pin);
      if (!pane) return unavailable();
      if (pin === undefined) select(pane.id);
      const adapter = adapterOn(pane.id, kind.page);
      const result = adapter?.apply ? await adapter.apply(action) : unavailable();
      if (result.detail !== "unavailable") return result;
      if (applyMs > 0) await wait(POLL_MS);
    }
    return unavailable();
  };
  const runViewAction = async (action: CopilotViewAction): Promise<ViewActionOutcome> => {
    const kind = options.pages.find((page) => page.handles(action));
    if (!kind) return unavailable();
    const ensured = await ensurePane(kind, action);
    if ("result" in ensured) return ensured.result;
    const timeouts = { ...DEFAULT_TIMEOUTS, ...kind.timeouts };
    const applyMs = ensured.opened && timeouts.openedApplyMs !== undefined ? timeouts.openedApplyMs : timeouts.applyMs;
    return applyUntilAvailable(kind, action, applyMs, ensured.pin);
  };

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    select,
    setActiveView,
    setPaneView,
    split,
    close,
    update,
    register,
    changed,
    pageOf,
    mounted,
    whenReady,
    ensurePane,
    applyUntilAvailable,
    runViewAction,
  };
}
