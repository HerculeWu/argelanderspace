/**
 * The workspace outside React (architecture-deepening ticket 04): the pane manager (manager.ts, created here and its
 * methods passed through) together with what the Shell used to keep in React state and ref mirrors — the paper list,
 * the current Doc and the anchor handed to it, whether the Copilot panel is open — and the routing around them: the
 * boot deep link, the browser's Back/Forward with the leave guard and its one-navigation permission, opening and
 * switching Docs, a Doc's deletion, and the Copilot's workspace actions. The Shell renders from one snapshot
 * (`getState`/`subscribe`, as the pane manager) and acknowledges each snapshot it committed (`rendered`).
 *
 * The browser, the timers, the paper list and the leave guards come in through ports (browser.ts), so all of it runs
 * without rendering. Every leave-guard question the workspace asks goes through `deps.leave`: pane changes (the pane
 * manager's `confirmLeave`), browser navigation, `openDoc` / `setCurrentDoc`, and the Copilot approval's `leaveDoc`.
 *
 * A workspace action is answered from this state, synchronously; an `ok` waits until the Shell has committed a render
 * of a snapshot that has the change (`shown`), so the PageContext the Copilot publishes after the answer shows it.
 */
import { MAX_PANES, type WorkspaceViewAction } from "@argelanderspace/contracts";
import type { DocPaneHost } from "../../doc/doc-pane-adapter";
import { argumentBus, argumentUrl, parseArgumentHash } from "../../lib/argument-route";
import { docRouteUrl, parseDocRoute } from "../../lib/deeplink";
import { exploreBus, parseExploreHash } from "../../lib/explore-route";
import { planResize } from "../layout";
import type { Tweaks } from "../theme";
import { applyDocDeletion, type LeaveOrigin } from "../workspace";
import type { PaneAdapter, ViewActionOutcome } from "./adapter";
import type { BrowserPort, LeavePort, TimerPort } from "./browser";
import { createPaneManager, type Pane, type PaneState } from "./manager";

export interface WorkspaceStateSnapshot extends PaneState {
  /** The ingested Docs (fetched once at boot, kept up to date locally). */
  papers: string[];
  /** The Doc the Doc panes show. */
  currentDoc: string | null;
  /** The anchor of the deep link that opened `currentDoc`, until the Doc pane has used it. */
  pendingAnchor: string | null;
  copilotOpen: boolean;
}

export interface WorkspaceStateDeps {
  initial: { panes: Pane[]; activeId: number };
  /** One detached adapter per page; the Doc page's adapter is given the workspace's `docHost`. */
  pages: (docHost: DocPaneHost) => PaneAdapter[];
  browser: BrowserPort;
  timers: TimerPort;
  leave: LeavePort;
  fetchPapers: () => Promise<string[]>;
  /** The appearance setter of the preferences (preferences.tsx): resolves with whether config.toml took the change. */
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => Promise<boolean>;
}

export interface OpenDocOptions {
  /** The caller already asked about leaving the Library page this would replace (the browser's Back). */
  libraryAsked?: boolean;
  origin?: LeaveOrigin;
  /**
   * The address bar already names this Doc: the boot deep link, or the browser's Back/Forward that arrived at it. The
   * entry is rewritten in place and none is added (a new one would drop the forward entries). Every other way in (the
   * Library, an exploration, the task drawer, the Copilot, the argument graph) opens the Doc as a new history entry.
   */
  urlIsDoc?: boolean;
}

export type WorkspaceState = ReturnType<typeof createWorkspaceState>;

/** How long a workspace action waits for the Shell to show its change before it answers `unavailable`. */
export const SHOWN_TIMEOUT_MS = 1000;
/** A Back/Forward the leave guard let through stays let through this long, and this long once it is taken. */
const ALLOW_MS = 2000;
const TAKEN_MS = 100;

type Own = Pick<WorkspaceStateSnapshot, "papers" | "currentDoc" | "pendingAnchor" | "copilotOpen">;

export function createWorkspaceState(deps: WorkspaceStateDeps) {
  const { browser, timers, leave } = deps;
  let own: Own = { papers: [], currentDoc: null, pendingAnchor: null, copilotOpen: false };
  const listeners = new Set<() => void>();

  // A Doc pane's Reader actions name their Doc; one that is not open is opened through the workspace's own openDoc.
  const docHost: DocPaneHost = { currentDoc: () => own.currentDoc, openDoc: (docId) => openDocAction(docId) };
  const manager = createPaneManager({ panes: deps.initial.panes, activeId: deps.initial.activeId, pages: deps.pages(docHost), confirmLeave: leave.ask });

  // ---- the snapshot ------------------------------------------------------------------------------ //

  let seq = 0;
  let snapshot: WorkspaceStateSnapshot = { ...manager.getState(), ...own };
  const seqOf = new WeakMap<WorkspaceStateSnapshot, number>([[snapshot, seq]]);
  let batching = 0;
  let dirty = false;
  const emit = () => {
    if (batching > 0) {
      dirty = true;
      return;
    }
    dirty = false;
    snapshot = { ...manager.getState(), ...own };
    seqOf.set(snapshot, ++seq);
    for (const listener of [...listeners]) listener();
  };
  /** Several changes, one new snapshot. */
  const batch = <T>(run: () => T): T => {
    batching++;
    try {
      return run();
    } finally {
      batching--;
      if (batching === 0 && dirty) emit();
    }
  };
  /** Each Library page's selected graph node, kept while a Doc pane has replaced the page (see `Workspace.librarySelection`). */
  const selections = new Map<number, string | null>();
  manager.subscribe(() => {
    const open = new Set(manager.getState().panes.map((pane) => pane.id));
    for (const id of [...selections.keys()]) if (!open.has(id)) selections.delete(id); // a closed pane takes its entry with it
    emit();
  });
  /** A value that is already so is not a change: no new snapshot (an effect that clears the anchor must not loop). */
  const setOwn = (patch: Partial<Own>) => {
    const keys = Object.keys(patch) as (keyof Own)[];
    if (keys.every((key) => own[key] === patch[key])) return;
    own = { ...own, ...patch };
    emit();
  };

  // ---- shown: the Shell's render receipts --------------------------------------------------------- //

  let receipt = -1;
  const waiting = new Set<() => void>();
  /** The Shell committed a render of `shown` (its layout effect: the whole tree, the Copilot panel included). */
  const rendered = (shown: WorkspaceStateSnapshot) => {
    const at = seqOf.get(shown);
    if (at === undefined || at <= receipt) return;
    receipt = at;
    for (const check of [...waiting]) check();
  };
  /** True once a committed render has the current snapshot (or a later one); false after SHOWN_TIMEOUT_MS. */
  const shown = (): Promise<boolean> => {
    const target = seq;
    if (receipt >= target) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        waiting.delete(check);
        timers.clear(timer);
        resolve(ok);
      };
      const check = () => {
        if (receipt >= target) done(true);
      };
      const timer = timers.set(() => done(false), SHOWN_TIMEOUT_MS);
      waiting.add(check);
    });
  };
  const ok = (): ViewActionOutcome => ({ ok: true });
  const notShown = (): ViewActionOutcome => ({ ok: false, detail: "unavailable" });
  /** The answer of an action whose change `check` describes: ok once it is shown. */
  const settled = async (check: () => boolean): Promise<ViewActionOutcome> => ((await shown()) && check() ? ok() : notShown());

  // ---- Docs ------------------------------------------------------------------------------------- //

  /**
   * A mode that lives in the Library page (exploration, the argument graph view) needs a Library pane to open in: the one
   * already there, else the active pane becomes one. `guard`: ask the leave guard first (a navigation of the user's, with
   * a Doc possibly holding a draft); the boot path has nothing to lose. False: refused, nothing changed.
   */
  const ensureLibraryPane = (guard: boolean): boolean => {
    if (manager.getState().panes.some((p) => p.view === "library")) return true;
    if (guard) return manager.setActiveView("library");
    const active = manager.getState().activeId;
    manager.update((ps) => ps.map((p) => (p.id === active ? { ...p, view: "library" } : p)));
    return true;
  };

  const setCurrentDoc = (id: string) => {
    if (id === own.currentDoc) return;
    if (!leave.confirm()) return;
    setOwn({ currentDoc: id });
    browser.replace(docRouteUrl(id)); // UI-driven switch: any stale #anchor no longer applies
  };

  /**
   * What a pushed Doc entry writes into the history state of the entry it leaves, so Back there can put the pane the Doc
   * took over back as it was: the pane (the Doc pane that already existed, else the active pane), the view it had (`doc`
   * when it already showed a Doc, then `prevDocId` names that Doc), and the Doc that was opened (`docId`: the record only
   * applies while that pane still shows it, which also keeps a stale record, or one from before a reload, from touching
   * a pane that has since become something else).
   */
  interface LeftRecord {
    paneId: number;
    view: string;
    docId: string;
    prevDocId?: string;
  }
  const leftRecordOf = (pane: Pane, docId: string): { argelanderReplaced: LeftRecord } => ({
    argelanderReplaced: { paneId: pane.id, view: pane.view, docId, ...(pane.view === "doc" && own.currentDoc ? { prevDocId: own.currentDoc } : {}) },
  });
  const leftRecord = (): LeftRecord | null => {
    const state = browser.state() as { argelanderReplaced?: Partial<LeftRecord> } | null;
    const left = state?.argelanderReplaced;
    if (!left || typeof left.paneId !== "number" || typeof left.view !== "string" || typeof left.docId !== "string") return null;
    return { paneId: left.paneId, view: left.view, docId: left.docId, ...(typeof left.prevDocId === "string" ? { prevDocId: left.prevDocId } : {}) };
  };

  /** Show a Doc (the current one, else the first) in a Doc pane; false when the leave guard keeps things as they are (or has not answered yet). */
  const openDoc = (docId?: string, anchor?: string | null, opts: OpenDocOptions = {}): boolean => {
    const nextDoc = docId ?? own.currentDoc ?? own.papers[0] ?? null;
    // A refused switch puts a URL the browser already moved back; a click from the argument graph view has not moved
    // it (the view is still open, and its URL must still say so).
    const restoreUrl = () => {
      if (own.currentDoc && parseArgumentHash(browser.location().hash) === null) browser.replace(docRouteUrl(own.currentDoc));
    };
    if (nextDoc !== own.currentDoc && !leave.confirm()) {
      restoreUrl();
      return false;
    }
    const apply = () =>
      batch(() => {
        if (docId) {
          // A Doc opened from anywhere but the address bar is a new history entry, so Back returns to where it was opened
          // from (the Library page, an exploration, the argument graph); onNav turns a plain URL back into the Library page.
          const url = docRouteUrl(docId, anchor);
          const at = browser.location();
          if (opts.urlIsDoc || at.pathname + at.hash === url) browser.replace(url);
          else {
            // the entry being left remembers which view this Doc replaces, so Back to it puts that view back (see onNav)
            const { panes: before, activeId: at0 } = manager.getState();
            const target = before.find((p) => p.view === "doc") ?? before.find((p) => p.id === at0);
            if (target && nextDoc) browser.setState(leftRecordOf(target, nextDoc));
            browser.push(url);
          }
          // the Doc and its anchor in one change: the Doc pane gets the anchor with the Doc
          setOwn({ currentDoc: nextDoc, pendingAnchor: anchor ?? null });
        } else setOwn({ currentDoc: nextDoc });
        // ensure a pane shows the document: prefer an existing doc pane, else the active one
        manager.update((ps) => {
          if (ps.some((p) => p.view === "doc")) return ps;
          const active = manager.getState().activeId;
          return ps.map((p) => (p.id === active ? { ...p, view: "doc" } : p));
        });
      });
    // With no Doc pane the active pane becomes one: if that pane is a Library page, its unsaved argument draft is lost
    // (the page asks, unless the caller already asked about leaving it: the browser's Back).
    const { panes: current, activeId } = manager.getState();
    const replaced = current.some((p) => p.view === "doc") ? undefined : current.find((p) => p.id === activeId);
    if (replaced?.view === "library" && !opts.libraryAsked) {
      const verdict = leave.ask("library", replaced.id, opts.origin);
      if (verdict !== true) {
        if (verdict === false) restoreUrl();
        else
          void verdict.then((yes) => {
            if (yes) apply();
            else restoreUrl();
          });
        return false;
      }
    }
    apply();
    return true;
  };

  const clearPendingAnchor = () => setOwn({ pendingAnchor: null });

  const librarySelection = { get: (paneId: number) => selections.get(paneId), set: (paneId: number, node: string | null) => void selections.set(paneId, node) };

  /**
   * A Doc was physically deleted (the Library page's delete, or the Copilot's): the paper list loses it and the current Doc
   * moves per the three-state rule (applyDocDeletion); the address follows (the new main Doc, or `/` with nothing left).
   */
  const docDeleted = (docId: string, remaining: string[]) => {
    const next = applyDocDeletion({ papers: own.papers, currentDoc: own.currentDoc }, docId, remaining);
    const moved = next.currentDoc !== own.currentDoc;
    setOwn(moved ? { papers: next.papers, currentDoc: next.currentDoc } : { papers: next.papers });
    if (moved) {
      if (next.currentDoc) browser.replace(docRouteUrl(next.currentDoc));
      else browser.replace("/"); // nothing left to show
    }
  };

  /** The Copilot approval that would take `docId` away: only the open Doc asks the leave guard (unsaved drafts), as the delete dialog does. */
  const leaveDoc = (docId: string): boolean => docId !== own.currentDoc || leave.confirm();

  // ---- the browser's Back/Forward ------------------------------------------------------------------ //

  /**
   * The URL a confirmed Back/Forward is let through to (see onNav): one navigation's worth of permission. It is taken by the
   * navigation that arrives at that URL (a traversal fires `popstate` and then, when the hash differs, `hashchange`: the
   * second must not ask again, so a taken permission lingers for a moment), and it is dropped when a graph is entered again
   * and after a couple of seconds, so it can never excuse a later, different Back.
   */
  let allowed: { href: string; timer: number } | null = null;
  const dropAllowed = () => {
    if (allowed) timers.clear(allowed.timer);
    allowed = null;
  };
  const allowHref = (href: string) => {
    dropAllowed();
    const entry = { href, timer: 0 };
    entry.timer = timers.set(() => {
      if (allowed === entry) allowed = null;
    }, ALLOW_MS);
    allowed = entry;
  };
  /** Whether `href` is the navigation that was let through; taking it shortens the permission to the rest of this navigation. */
  const takeAllowed = (href: string): boolean => {
    const entry = allowed;
    if (!entry || entry.href !== href) return false;
    timers.clear(entry.timer);
    entry.timer = timers.set(() => {
      if (allowed === entry) allowed = null;
    }, TAKEN_MS);
    return true;
  };
  /** The question a browser navigation is waiting on (a late-answering guard): the newest URL asked for, where "discard" goes. */
  let pendingNav: { href: string } | null = null;
  const onNav = () => {
    const location = browser.location();
    const route = parseDocRoute(location.pathname, location.hash);
    const argumentWork = parseArgumentHash(location.hash);
    // The browser's Back/Forward (or a hand-edited hash) away from an open argument graph, to a plain URL, a Doc, an
    // exploration or another Work's graph: the leave guard of the pane that shows that graph decides first (an unsaved
    // draft is asked about with the app's own dialog, which answers later). The URL has already moved. Until the answer
    // is yes, the graph's URL is pushed back over it (a new entry after the one the browser moved to, so the forward
    // entries are dropped); on yes, `back()` returns to the entry the person chose and that one navigation is let
    // through without asking again (`allowed`). A navigation made while the question is open asks nothing more: it
    // only becomes the destination "discard" goes to (every such navigation adds its own entry and the graph's URL again).
    const hit = argumentBus.affected(argumentWork);
    const leavingView = hit !== null;
    const href = location.href;
    if (hit && !takeAllowed(href)) {
      if (pendingNav) {
        pendingNav.href = href;
        browser.push(argumentUrl(hit.open));
        return;
      }
      const verdict = leave.ask("library", hit.paneId);
      if (verdict !== true) {
        browser.push(argumentUrl(hit.open));
        if (verdict !== false) {
          const pending = { href };
          pendingNav = pending;
          void verdict.then((yes) => {
            if (pendingNav === pending) pendingNav = null;
            if (!yes) return;
            allowHref(pending.href);
            browser.back();
          });
        }
        return;
      }
    }
    // `#argument/<work id>` drives the argument graph view; any other URL (a Doc, a plain URL, an exploration) leaves it
    if (!argumentWork) argumentBus.exit();
    if (route) {
      // the Doc address leaves an exploration too: with a Doc pane already open the picture would not change otherwise
      exploreBus.exit();
      openDoc(route.docId, route.anchor, { libraryAsked: leavingView, urlIsDoc: true });
      return;
    }
    // Stage 14: `#explore/<bibcode>` drives the discovery mode; losing the
    // explore hash exits explore mode (the session stays resumable)
    const seed = parseExploreHash(location.hash);
    // Back to an exploration with no Library pane (the Reader replaced it): make one first, as the boot path does
    if (seed) {
      // the pane the Doc took over first gets its view back (a Plan page stays a Plan page next to the exploration)
      withLeftView(() => {
        if (manager.getState().panes.some((p) => p.view === "library")) return exploreBus.request(seed);
        const active = manager.getState().panes.find((p) => p.id === manager.getState().activeId);
        if (active) leaveDocPane(active, paneTo(active, "library"), () => exploreBus.request(seed));
      });
      return;
    }
    exploreBus.exit();
    // Back to a graph URL with no Library pane (the Reader replaced it): make one first, as the boot path does
    if (argumentWork) {
      withLeftView(() => {
        if (ensureLibraryPane(true)) argumentBus.request(argumentWork, { confirmed: leavingView });
      });
      return;
    }
    libraryForPlainUrl();
  };

  /**
   * `pane`'s Doc is left for a Back/Forward that moved the URL away from it: `change` runs after the Doc's leave guard, as
   * the person's own move, then `then`. Refused (now or later) the open Doc's URL is put back, so the address does not say
   * something the screen does not show. A traversal fires `popstate` and then `hashchange`: while the question for that
   * address is open the second asks nothing. A later, different navigation asks for itself and the earlier answer is void,
   * as is an answer that arrives after the address moved on.
   */
  let pendingLeave: { href: string } | null = null;
  const leaveDocPane = (pane: Pane, change: () => void, then?: () => void) => {
    const href = browser.location().href;
    const apply = () => {
      change();
      then?.();
    };
    if (pane.view !== "doc") return apply();
    if (pendingLeave?.href === href) return;
    const stillHere = () => browser.location().href === href;
    const restoreUrl = () => {
      if (own.currentDoc && stillHere()) browser.replace(docRouteUrl(own.currentDoc));
    };
    const verdict = leave.ask("doc", pane.id, "user");
    if (verdict === true) apply();
    else if (verdict === false) restoreUrl();
    else {
      const mine = { href };
      pendingLeave = mine;
      void verdict.then((yes) => {
        if (pendingLeave !== mine) return; // a newer navigation has its own question
        pendingLeave = null;
        if (!stillHere()) return;
        if (yes) apply();
        else restoreUrl();
      });
    }
  };
  const paneTo = (pane: Pane, view: string) => () => manager.update((ps) => ps.map((p) => (p.id === pane.id && p.view === pane.view ? { ...p, view } : p)));

  /**
   * The entry Back/Forward arrived at may carry the record a pushed Doc entry wrote (`LeftRecord`): the pane the Doc took
   * over gets its view back (a Doc it showed before: that Doc), but only while it still shows the Doc the record names;
   * otherwise the record is stale and no pane is touched. `then` runs afterwards in every case (also after a late answer).
   * Returns whether the entry had a record.
   */
  const withLeftView = (then: () => void): boolean => {
    const left = leftRecord();
    if (!left) {
      then();
      return false;
    }
    const pane = manager.getState().panes.find((p) => p.id === left.paneId && p.view === "doc");
    if (!pane || own.currentDoc !== left.docId) {
      then();
      return true;
    }
    const prev = left.prevDocId;
    const change = left.view === "doc" ? () => prev && setOwn({ currentDoc: prev, pendingAnchor: null }) : paneTo(pane, left.view);
    leaveDocPane(pane, change, then);
    return true;
  };

  /**
   * Back/Forward arrived at a URL that names neither a Doc nor an exploration nor an argument graph (`/`). With a record on
   * that entry the Doc's pane is put back as it was (see `withLeftView`) and nothing else changes. With no record (a boot
   * deep link, an older entry) the Library page is what is there: when no pane shows it, the Doc pane (the active pane if
   * it is one) turns into it.
   */
  const libraryForPlainUrl = () => {
    if (withLeftView(() => {})) return;
    const { panes: current, activeId } = manager.getState();
    if (current.some((p) => p.view === "library")) return;
    const pane = current.find((p) => p.id === activeId && p.view === "doc") ?? current.find((p) => p.view === "doc");
    if (pane) leaveDocPane(pane, paneTo(pane, "library"));
  };

  /**
   * The Reader's "argument graph" entry: show a Library page (the pane that has one, else the active pane) and open the
   * work's graph there; entering the view writes its history entry.
   */
  const openArgumentGraph = (workId: string) => {
    dropAllowed(); // entering a graph again ends any earlier "let this one Back through"
    // The pane that shows the view is chosen here and named in the request, so the bus serves exactly it.
    const { panes: current, activeId: active } = manager.getState();
    const library = current.find((p) => p.id === active && p.view === "library") ?? current.find((p) => p.view === "library");
    if (library) manager.select(library.id);
    else if (!manager.setActiveView("library")) return;
    argumentBus.request(workId, { push: true, paneId: library?.id ?? manager.getState().activeId });
  };

  // ---- boot ------------------------------------------------------------------------------------- //

  /**
   * Load the paper list once and pick the first Doc; a deep link takes precedence: `/doc/<id>[#anchor]` opens it,
   * `#explore/<bibcode>` and `#argument/<work id>` open the Library pane and hand the request to its bus, `?doc=<id>`
   * picks a listed Doc. Listens to Back/Forward and hand-edited hashes. The returned function stops both (a boot still
   * waiting for the list is dropped).
   */
  const start = () => {
    let alive = true;
    const at = browser.location();
    const route = parseDocRoute(at.pathname, at.hash);
    void (async () => {
      let list: string[] = [];
      try {
        list = await deps.fetchPapers();
      } catch {
        /* reader may be offline; Library still works on fixture data */
      }
      if (!alive) return;
      batch(() => {
        setOwn({ papers: list });
        if (route) {
          // unknown ids are opened anyway: DocPane shows its normal load error
          openDoc(route.docId, route.anchor, { urlIsDoc: true });
          return;
        }
        const now = browser.location();
        // Stage 14: a boot `#explore/<bibcode>` hash opens the library pane and
        // hands the seed to the explore bus (the LibraryView consumes it once
        // mounted — exploreBus keeps it pending until then)
        const exploreSeed = parseExploreHash(now.hash);
        if (exploreSeed) {
          ensureLibraryPane(false);
          exploreBus.request(exploreSeed);
          return;
        }
        // Argument graph ticket 04: a boot `#argument/<work id>` hash opens the library pane the same way
        const argumentWork = parseArgumentHash(now.hash);
        if (argumentWork) {
          ensureLibraryPane(false);
          argumentBus.request(argumentWork);
          return;
        }
        const want = new URL(now.href).searchParams.get("doc");
        setOwn({ currentDoc: want && list.includes(want) ? want : list[0] ?? null });
      });
    })();
    const unlisten = browser.listen(onNav);
    return () => {
      alive = false;
      unlisten();
      dropAllowed();
    };
  };

  // ---- Copilot workspace actions (copilot ticket 12) ------------------------------------------------ //
  // Everything below drives the same calls the controls use: the pane limit, the leave-draft protection and the divider
  // rule are the UI's own. Nothing here calls focus(): another tab or window is never raised.

  const setCopilotOpen = (open: boolean) => setOwn({ copilotOpen: open });

  /** Opening a Doc (the library's open button, the task drawer's linked-document button, a Doc pane's Reader action). */
  async function openDocAction(docId: string): Promise<ViewActionOutcome> {
    if (!own.papers.includes(docId)) {
      let fresh: string[];
      try {
        fresh = await deps.fetchPapers();
      } catch {
        return { ok: false, detail: "unavailable" };
      }
      if (!fresh.includes(docId)) return { ok: false, detail: "not_found" };
      setOwn({ papers: fresh });
    }
    if (!openDoc(docId, undefined, { origin: "agent" })) return { ok: false, detail: "leave_blocked" };
    return settled(() => own.currentDoc === docId && manager.getState().panes.some((pane) => pane.view === "doc"));
  }

  const runWorkspaceAction = async (action: WorkspaceViewAction): Promise<ViewActionOutcome> => {
    const s = () => manager.getState();
    const missing = (id: number) => !s().panes.some((pane) => pane.id === id);
    switch (action.action) {
      case "switch_view": {
        const id = action.paneId ?? s().activeId;
        if (missing(id)) return { ok: false, detail: "not_found" };
        const applied = action.paneId === undefined ? manager.setActiveView(action.view, "agent") : manager.setPaneView(id, action.view, "agent");
        if (!applied) return { ok: false, detail: "leave_blocked" };
        return settled(() => s().panes.find((pane) => pane.id === id)?.view === action.view && (action.paneId === undefined || s().activeId === id));
      }
      case "split_pane": {
        const id = action.paneId ?? s().activeId;
        if (missing(id)) return { ok: false, detail: "not_found" };
        const before = s().panes.length;
        if (before >= MAX_PANES) return { ok: false, detail: "disabled" };
        manager.split(id);
        return settled(() => s().panes.length === before + 1);
      }
      case "close_pane": {
        if (missing(action.paneId)) return { ok: false, detail: "not_found" };
        if (s().panes.length <= 1) return { ok: false, detail: "disabled" };
        if (!manager.close(action.paneId, "agent")) return { ok: false, detail: "leave_blocked" };
        return settled(() => missing(action.paneId));
      }
      case "select_pane": {
        if (missing(action.paneId)) return { ok: false, detail: "not_found" };
        manager.select(action.paneId);
        return settled(() => s().activeId === action.paneId);
      }
      case "resize_pane": {
        const index = s().panes.findIndex((pane) => pane.id === action.paneId);
        if (index < 0) return { ok: false, detail: "not_found" };
        const sizes = planResize(s().panes.map((pane) => pane.size), index, action.share);
        if (!sizes) return { ok: false, detail: "disabled" };
        manager.update((ps) => (ps.length === sizes.length ? ps.map((pane, i) => ({ ...pane, size: sizes[i] ?? pane.size })) : ps));
        return ok();
      }
      case "set_appearance": {
        const { theme, accent, density, language } = action;
        // Done only when config.toml has every one of them: each change resolves with what the file took.
        const made = await Promise.all([
          ...(theme ? [deps.setTweak("theme", theme)] : []),
          ...(accent ? [deps.setTweak("accent", accent)] : []),
          ...(density ? [deps.setTweak("density", density)] : []),
          ...(language ? [deps.setTweak("language", language)] : []),
        ]);
        return made.every(Boolean) ? ok() : notShown();
      }
      case "open_copilot":
      case "close_copilot": {
        // The toolbar's own toggle: only the panel is shown or collapsed, the conversation keeps running.
        const want = action.action === "open_copilot";
        setCopilotOpen(want);
        return settled(() => own.copilotOpen === want);
      }
      case "open_doc":
        return openDocAction(action.docId);
      default:
        // open_copilot_settings belongs to the Copilot panel itself, which handles it before the Shell is asked.
        return { ok: false, detail: "unavailable" };
    }
  };

  const { getState: _panes, subscribe: _panesListener, ...panes } = manager;
  return {
    ...panes,
    getState: (): WorkspaceStateSnapshot => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    rendered,
    docHost,
    setCurrentDoc,
    openDoc,
    clearPendingAnchor,
    librarySelection,
    docDeleted,
    leaveDoc,
    openArgumentGraph,
    setCopilotOpen,
    runWorkspaceAction,
    openDocAction,
  };
}
