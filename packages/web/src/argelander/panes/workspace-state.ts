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
import { applyDocDeletion, type LeaveOrigin, type LeaveVerdict } from "../workspace";
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
  /**
   * A Back/Forward or a deep link arrived at the address of a Doc that is gone (ticket 11): the notice the Shell shows
   * for a moment (`seq` tells one arrival from the next at the same Doc).
   */
  docGoneNotice: { docId: string; seq: number } | null;
}

export interface WorkspaceStateDeps {
  initial: { panes: Pane[]; activeId: number };
  /** One detached adapter per page; the Doc page's adapter is given the workspace's `docHost`. */
  pages: (docHost: DocPaneHost) => PaneAdapter[];
  browser: BrowserPort;
  timers: TimerPort;
  leave: LeavePort;
  fetchPapers: () => Promise<string[]>;
  /**
   * The server's `library.changed` (a Doc deleted, added or rebuilt, here or elsewhere): the paper list is read again, so
   * it stays fresh. Returns the unsubscribe. Optional: without it the list is read at boot and kept up locally.
   */
  onLibraryChanged?: (cb: () => void) => () => void;
  /** The HTTP status of a Doc's description (`GET /api/paper/:id/description`): 404 says it is gone. Rejects when unreachable. */
  docStatus: (docId: string) => Promise<number>;
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
/** How long the notice that a Doc is gone stays (as the leave guard's own status toast). */
export const DOC_GONE_NOTICE_MS = 5000;

type Own = Pick<WorkspaceStateSnapshot, "papers" | "currentDoc" | "pendingAnchor" | "copilotOpen" | "docGoneNotice">;

export function createWorkspaceState(deps: WorkspaceStateDeps) {
  const { browser, timers, leave } = deps;
  let own: Own = { papers: [], currentDoc: null, pendingAnchor: null, copilotOpen: false, docGoneNotice: null };
  const listeners = new Set<() => void>();

  // A Doc pane's Reader actions name their Doc; one that is not open is opened through the workspace's own openDoc.
  const docHost: DocPaneHost = { currentDoc: () => own.currentDoc, openDoc: (docId) => openDocAction(docId) };
  const manager = createPaneManager({
    panes: deps.initial.panes,
    activeId: deps.initial.activeId,
    pages: deps.pages(docHost),
    confirmLeave: leave.ask,
    // a Copilot page action that switches a pane to its page goes the workspace's way (switchView: history, leave_blocked)
    switchPane: (id, view, origin) => setPaneView(id, view, origin),
  });

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
  /**
   * Each pane's view session (ticket 07; first only Doc panes had one): an opaque token minted each time a pane changes
   * view, kept while it stays in that view (a Doc pane switching Docs with `setCurrentDoc` stays in its session) and
   * dropped when it changes view again or closes. A pane switched away by hand and back is a new session; the page-load
   * prefix keeps a token written into history before a reload (which numbers the panes again) from matching any pane
   * after it. See `LeftRecord`.
   */
  const pageLoad = newPageLoadId();
  let sessionSeq = 0;
  const sessions = new Map<number, { view: string; token: string }>();
  const mintSession = () => `${pageLoad}:${++sessionSeq}`;
  const sessionOf = (paneId: number): string | undefined => sessions.get(paneId)?.token;
  /**
   * Parked view sessions, one per entry: when a Back puts a pane's recorded view back (`withLeftView`), the view session the
   * pane leaves is parked under its token — the session the entry that Back left names (`ShownRecord`) — with the view it
   * had (`prevView`) and the view session the Back put the pane into (`restored`). The Forward that returns to that entry
   * finds its shown session here and, while the pane is still in `restored`, gives the pane that view and that session
   * back: a Doc entry the Doc in that pane, whichever pane is active (ticket 06); a plain entry its Plan page, Writer, ….
   * Because a Back also gives the restored view the session its own entry names, the records on either side keep
   * applying along a chain of Backs and Forwards, pane by pane. A parking whose pane left `restored` (switched by hand,
   * closed) is void: Forward then does what it did before.
   */
  const parks = new Map<string, { paneId: number; prevView: string; restored: string }>();
  /** The current entry's parking, while it applies (see `parks`). */
  const parkingHere = (): { session: string; paneId: number; prevView: string } | null => {
    const shown = shownRecord();
    const park = shown ? parks.get(shown.session) : undefined;
    if (!shown || !park || park.paneId !== shown.paneId || sessionOf(park.paneId) !== park.restored) return null;
    return { session: shown.session, paneId: park.paneId, prevView: park.prevView };
  };
  const syncSessions = () => {
    const panes = manager.getState().panes;
    const open = new Set(panes.map((pane) => pane.id));
    for (const id of [...sessions.keys()]) if (!open.has(id)) sessions.delete(id);
    for (const pane of panes) if (sessions.get(pane.id)?.view !== pane.view) sessions.set(pane.id, { view: pane.view, token: mintSession() });
    for (const [session, park] of [...parks]) if (!open.has(park.paneId)) parks.delete(session);
  };
  syncSessions();
  manager.subscribe(() => {
    const open = new Set(manager.getState().panes.map((pane) => pane.id));
    for (const id of [...selections.keys()]) if (!open.has(id)) selections.delete(id); // a closed pane takes its entry with it
    syncSessions();
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

  /** The current entry's address rewritten, its history state (records, the shown session) kept: it is the same entry. */
  const replaceKeepingState = (url: string) => {
    const kept = browser.state();
    browser.replace(url);
    if (kept !== null && kept !== undefined) browser.setState(kept);
  };

  const setCurrentDoc = (id: string) => {
    if (id === own.currentDoc) return;
    const change = () => {
      if (id === own.currentDoc) return;
      setOwn({ currentDoc: id });
      replaceKeepingState(docRouteUrl(id)); // UI-driven switch: any stale #anchor no longer applies
      noteDocAddress();
    };
    // the Doc views' guard may answer later (their dialog): the switch waits for a yes, and a no leaves everything as it was
    const verdict = leave.ask(undefined, undefined, "user");
    if (verdict === true) change();
    else if (verdict !== false) void verdict.then((yes) => yes && change());
  };

  /**
   * What a pushed entry writes into the history state of the entry it leaves, so Back there can put the pane it changed
   * back as it was: a Doc opened (`openDoc`: the Doc pane that already existed, else the active pane), or a pane switched
   * away from an exploration or a graph to any view (`switchView`, tickets 01, 05, 07). It names the pane, the view it had
   * (`doc` when it already showed a Doc, then `prevDocId` names that Doc), and the view session the change made or used
   * (`session`). The record applies while that pane is still in that view session, whichever Doc it shows now (a switch
   * inside a Doc pane with `setCurrentDoc` keeps it); a pane switched away by hand, or one numbered again after a reload,
   * is not, and the record is void (`invalid`: the fallback then never takes another Doc pane).
   */
  interface LeftRecord {
    paneId: number;
    view: string;
    session: string;
    prevDocId?: string;
  }
  /** The current entry's history state as an object (what is there is kept when a record is added). */
  const stateObject = (): Record<string, unknown> => {
    const state = browser.state();
    return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
  };
  const writeLeftRecord = (pane: Pane, session: string) =>
    browser.setState({
      ...stateObject(),
      argelanderReplaced: { paneId: pane.id, view: pane.view, session, ...(pane.view === "doc" && own.currentDoc ? { prevDocId: own.currentDoc } : {}) } satisfies LeftRecord,
    });
  /**
   * What a pushed entry (`openDoc`, a switch away from an exploration or a graph) carries in its history state: the pane it
   * changed, and the view and view session that pane entered there. Forward back to that entry finds the parking of that
   * session (see `parks`); Back to it gives a restored view that same session (see `withLeftView`).
   */
  interface ShownRecord {
    paneId: number;
    session: string;
    view: string;
  }
  const shownRecord = (): ShownRecord | null => {
    const shown = stateObject().argelanderShown as Partial<ShownRecord> | undefined;
    return shown && typeof shown.paneId === "number" && typeof shown.session === "string" && typeof shown.view === "string"
      ? { paneId: shown.paneId, session: shown.session, view: shown.view }
      : null;
  };
  /**
   * The current entry's identity (a token in its history state, written the first time it is asked for): a late answer
   * checks it is still on the very entry it was asked at, not another entry at the same address (the graph's address its
   * own refusal pushed back).
   */
  const entryToken = (): string => {
    const known = stateObject().argelanderEntry;
    if (typeof known === "string") return known;
    const token = mintSession();
    browser.setState({ ...stateObject(), argelanderEntry: token });
    return token;
  };
  /**
   * The Docs deleted in this page load (`docDeleted`, `docGone`), each with the number of paper-list reads sent by then
   * (`readsSent`): a record that would put one back is void. A Doc re-ingested under the same id comes back: an applied
   * read sent after its deletion that lists it takes it off (`applyRead`); a read sent before cannot.
   */
  const deletedDocs = new Map<string, number>();
  /** The current entry's record: none, void (its pane left that view session, or the Doc it names was deleted), or one that applies, with its pane. */
  type RecordLookup = { kind: "none" } | { kind: "invalid"; paneId: number } | { kind: "valid"; left: LeftRecord; pane: Pane };
  const leftRecord = (): RecordLookup => {
    const state = browser.state() as { argelanderReplaced?: Partial<LeftRecord> } | null;
    const left = state?.argelanderReplaced;
    if (!left || typeof left.paneId !== "number" || typeof left.view !== "string" || typeof left.session !== "string") return { kind: "none" };
    const pane = manager.getState().panes.find((p) => p.id === left.paneId);
    // Applied already: a Back put this record's view back and the pane is still in the session that Back made (its
    // parking says so). The same traversal's second event (popstate, then hashchange) finds it so, and the record still
    // names the pane the mode reappears in (ticket 09); there is nothing left to change.
    const park = parks.get(left.session);
    const applied = !!pane && park?.paneId === pane.id && park.restored === sessionOf(pane.id) && pane.view === left.view;
    if (!pane || (sessionOf(pane.id) !== left.session && !applied)) return { kind: "invalid", paneId: left.paneId };
    // a record that would put back a Doc deleted since is void (ticket 08): a deleted Doc never comes back
    if (typeof left.prevDocId === "string" && deletedDocs.has(left.prevDocId)) return { kind: "invalid", paneId: left.paneId };
    return { kind: "valid", left: { paneId: left.paneId, view: left.view, session: left.session, ...(typeof left.prevDocId === "string" ? { prevDocId: left.prevDocId } : {}) }, pane };
  };
  /**
   * The pane a mode's Library page is made in when the entry's record does not apply: the active pane (as at boot), but a
   * void record never lets the fallback take a Doc pane other than the one it names (ticket 07) — then the recorded pane,
   * else the first pane that is not such a Doc pane.
   */
  const fallbackModePane = (lookup: RecordLookup): Pane | undefined => {
    const { panes: current, activeId } = manager.getState();
    const active = current.find((p) => p.id === activeId);
    if (lookup.kind !== "invalid") return active;
    const otherDoc = (p: Pane) => p.view === "doc" && p.id !== lookup.paneId;
    if (active && !otherDoc(active)) return active;
    return current.find((p) => p.id === lookup.paneId) ?? current.find((p) => !otherDoc(p));
  };

  /** The address that last showed the open Doc, its anchor included: what a refused Back/Forward puts back. */
  let docAddress: { docId: string; url: string } | null = null;
  const noteDocAddress = () => {
    const at = browser.location();
    const route = parseDocRoute(at.pathname, at.hash);
    if (route && route.docId === own.currentDoc) docAddress = { docId: route.docId, url: at.pathname + at.search + at.hash };
  };
  const openDocUrl = (): string | null => {
    if (!own.currentDoc) return null;
    return docAddress?.docId === own.currentDoc ? docAddress.url : docRouteUrl(own.currentDoc);
  };
  /**
   * The open Doc's address pushed back over the entry a Back/Forward moved to, which stays as it is with its history state
   * (a new entry after it, so the forward entries are dropped, as the argument graph does). The rest of that same
   * traversal (its `hashchange`) then finds the address it was put back to and is ignored (`pushedBack`). Returns the
   * pushed address, or null with no open Doc.
   */
  let pushedBack: { href: string; timer: number } | null = null;
  const pushDocBack = (): string | null => {
    const url = openDocUrl();
    if (!url) return null;
    browser.push(url);
    const href = browser.location().href;
    if (pushedBack) timers.clear(pushedBack.timer);
    const entry = { href, timer: 0 };
    entry.timer = timers.set(() => {
      if (pushedBack === entry) pushedBack = null;
    }, ALLOW_MS);
    pushedBack = entry;
    return href;
  };
  const takePushedBack = (href: string): boolean => {
    if (!pushedBack || pushedBack.href !== href) return false;
    timers.clear(pushedBack.timer);
    pushedBack = null;
    return true;
  };
  /**
   * The late answer to the Doc's question about a Back/Forward that left `href` (the Doc's address was pushed back at
   * `pushedAt`): still on that pushed address, yes goes back for real and that one traversal is let through (`allowHref`);
   * at `href` again (a further Back arrived there while the question was open) yes applies here and no pushes the address
   * back again; anywhere else the address moved on and the answer is void.
   */
  const settleDocQuestion = (href: string, pushedAt: string | null, yes: boolean, applyHere: () => void) => {
    const at = browser.location().href;
    if (pushedAt && at === pushedAt && at !== href) {
      if (!yes) return;
      allowHref("doc", href);
      browser.back();
    } else if (at === href) {
      if (yes) applyHere();
      else pushDocBack();
    }
  };

  /** Show a Doc (the current one, else the first) in a Doc pane; false when the leave guard keeps things as they are (or has not answered yet). */
  const openDoc = (docId?: string, anchor?: string | null, opts: OpenDocOptions = {}): boolean => {
    const nextDoc = docId ?? own.currentDoc ?? own.papers[0] ?? null;
    // A Back/Forward to the Doc address whose pane a Back parked (ticket 06): that pane, while its parking applies (it is
    // still in the view session the Back put it in) and no other pane shows a Doc; else none (the Doc pane, else the
    // active pane, as for any open). Only a parked Doc session counts here.
    const parkedPane = (): Pane | undefined => {
      if (!opts.urlIsDoc) return undefined;
      const here = parkingHere();
      if (!here || here.prevView !== "doc") return undefined;
      const { panes: now } = manager.getState();
      if (now.some((p) => p.view === "doc")) return undefined;
      return now.find((p) => p.id === here.paneId);
    };
    // A refused open puts the open Doc's address back only where the address already names the Doc refused (the browser
    // moved there: a Back/Forward the Library page's guard refused); any other address (`/`, `#explore/…`,
    // `#argument/…`, another Doc's) still says what is on screen and stays (ticket 10).
    // The entry keeps its history state (its records and its shown session: it is the same entry, ticket 08).
    const restoreUrl = () => {
      const at = browser.location();
      if (own.currentDoc && parseDocRoute(at.pathname, at.hash)?.docId === nextDoc) replaceKeepingState(docRouteUrl(own.currentDoc));
    };
    // A late no puts the address back only while it is still the one the question was asked at: once a later navigation
    // (a Back with its own question) moved it, that entry is not this open's to rewrite (as leaveDocPane).
    const restoreUrlIfAt = (askedAt: string) => {
      if (browser.location().href === askedAt) restoreUrl();
    };
    const apply = () =>
      batch(() => {
        if (docId) {
          // A Doc opened from anywhere but the address bar is a new history entry, so Back returns to where it was opened
          // from (the Library page, an exploration, the argument graph); onNav turns a plain URL back into the Library page.
          const url = docRouteUrl(docId, anchor);
          const at = browser.location();
          if (opts.urlIsDoc || at.pathname + at.hash === url) replaceKeepingState(url);
          else {
            // the entry being left remembers which view this Doc replaces, so Back to it puts that view back (see onNav)
            const { panes: before, activeId: at0 } = manager.getState();
            const target = before.find((p) => p.view === "doc") ?? before.find((p) => p.id === at0);
            let session: string | undefined;
            if (target && nextDoc) {
              // the Doc pane this open uses: the one there already keeps its session, a pane it turns into one starts one
              session = target.view === "doc" ? sessionOf(target.id) : undefined;
              if (!session) {
                session = mintSession();
                sessions.set(target.id, { view: "doc", token: session });
              }
              writeLeftRecord(target, session);
            }
            browser.push(url);
            // the entry names the Doc pane's session, so Forward back to it after a Back finds its parking (see `parks`)
            if (target && session) browser.setState({ argelanderShown: { paneId: target.id, session, view: "doc" } satisfies ShownRecord });
          }
          // the Doc and its anchor in one change: the Doc pane gets the anchor with the Doc
          setOwn({ currentDoc: nextDoc, pendingAnchor: anchor ?? null });
        } else setOwn({ currentDoc: nextDoc });
        // Forward back to the Doc entry a Back left: the pane it parked becomes the Doc pane it was again, whichever pane
        // is active now (see `parks`)
        const back = parkedPane();
        const here = back ? parkingHere() : null;
        if (back && here) {
          sessions.set(back.id, { view: "doc", token: here.session });
          parks.delete(here.session);
        }
        // ensure a pane shows the document: prefer an existing doc pane, else the parked one, else the active one
        manager.update((ps) => {
          if (ps.some((p) => p.view === "doc")) return ps;
          const into = back?.id ?? manager.getState().activeId;
          return ps.map((p) => (p.id === into ? { ...p, view: "doc" } : p));
        });
        syncSessions(); // a Doc session started above for a pane that did not become a Doc pane gives way to its view's
        noteDocAddress();
      });
    // With no Doc pane the active pane becomes one: if that pane is a Library page, its unsaved argument draft is lost
    // (the page asks, unless the caller already asked about leaving it: the browser's Back).
    const afterDocAsked = (): boolean => {
      const { panes: current, activeId } = manager.getState();
      const replaced = current.some((p) => p.view === "doc") ? undefined : parkedPane() ?? current.find((p) => p.id === activeId);
      if (replaced?.view === "library" && !opts.libraryAsked) {
        const askedAt = browser.location().href;
        const verdict = leave.ask("library", replaced.id, opts.origin);
        if (verdict !== true) {
          if (verdict === false) restoreUrl();
          else
            void verdict.then((yes) => {
              if (yes) apply();
              else restoreUrlIfAt(askedAt);
            });
          return false;
        }
      }
      apply();
      return true;
    };
    // Switching the open Doc asks the Doc views' guard (unsaved PDF work, the text source, annotation drafts): the person is
    // asked with the app's dialog, which answers later; the Copilot (`origin: agent`) is refused instead of asked.
    if (nextDoc === own.currentDoc) return afterDocAsked();
    // A traversal fires popstate and then hashchange, and both arrive here: while the question for this address is open the
    // second asks nothing. A later, different navigation asks for itself and the earlier answer is void.
    const href = browser.location().href;
    if (pendingDocOpen?.href === href && pendingDocOpen.docId === nextDoc) return false;
    // A Back/Forward to another Doc's address (`urlIsDoc`): the browser has moved, and a refusal pushes the open Doc's
    // address back, as leaveDocPane does, so the entry it arrived at stays; the traversal a late yes lets through asks nothing.
    if (opts.urlIsDoc && takeAllowed("doc", href)) return afterDocAsked();
    const verdict = leave.ask(undefined, undefined, opts.origin);
    if (verdict === true) return afterDocAsked();
    if (verdict === false) {
      if (opts.urlIsDoc) pushDocBack();
      else restoreUrl();
      return false;
    }
    const pushedAt = opts.urlIsDoc ? pushDocBack() : null;
    const mine = { href, docId: nextDoc };
    pendingDocOpen = mine;
    void verdict.then((yes) => {
      if (pendingDocOpen !== mine) return;
      pendingDocOpen = null;
      if (opts.urlIsDoc) return settleDocQuestion(href, pushedAt, yes, afterDocAsked);
      if (yes) afterDocAsked();
      else restoreUrlIfAt(href);
    });
    return false;
  };
  let pendingDocOpen: { href: string; docId: string | null } | null = null;

  const clearPendingAnchor = () => setOwn({ pendingAnchor: null });

  const librarySelection = { get: (paneId: number) => selections.get(paneId), set: (paneId: number, node: string | null) => void selections.set(paneId, node) };

  /**
   * A Doc was physically deleted (the Library page's delete, or the Copilot's): the paper list loses it and the current Doc
   * moves per the three-state rule (applyDocDeletion); an address that names the deleted Doc follows (the new main Doc,
   * or `/` with nothing left), any other address (`/`, `#explore/…`, `#argument/…`, another Doc's) stays as it is: it
   * still says what is on screen (ticket 10).
   * The entry keeps its history state (ticket 08): the Doc pane stays in its view session, so the records and the shown
   * session on it still apply. A record that names the deleted Doc as the one to put back is void (`leftRecord`): Back
   * never shows a deleted Doc again, and an entry whose address names it is not opened (`docGone`, ticket 11).
   */
  const docDeleted = (docId: string, remaining: string[]) => {
    deletedDocs.set(docId, readsSent);
    const next = applyDocDeletion({ papers: own.papers, currentDoc: own.currentDoc }, docId, remaining);
    const moved = next.currentDoc !== own.currentDoc;
    setOwn(moved ? { papers: next.papers, currentDoc: next.currentDoc } : { papers: next.papers });
    const at = browser.location();
    const named = parseDocRoute(at.pathname, at.hash)?.docId === docId;
    if (moved && named) replaceKeepingState(next.currentDoc ? docRouteUrl(next.currentDoc) : "/"); // `/`: nothing left to show
  };

  /**
   * The paper list read from the server (the boot, an arrival at a Doc address, `library.changed`, the Copilot's
   * `open_doc`): reads can answer out of order, so only a read newer than the one last applied replaces the list. A read
   * sent before a Doc's deletion in this page never brings it back; one sent after it that lists it means it was ingested
   * again under that id, and once applied the Doc is no longer counted deleted. Rejects when it cannot be read.
   */
  let readsSent = 0;
  let readApplied = 0;
  /** What read `mine` says is there: a Doc deleted after that read was sent is left out. */
  const listedBy = (mine: number, ids: string[]): string[] =>
    ids.filter((id) => {
      const at = deletedDocs.get(id);
      return at === undefined || mine > at;
    });
  /** Read `mine` (listing `ids`, as `listedBy` gives them) becomes the paper list when it is the newest. */
  const applyRead = (mine: number, ids: string[]) => {
    if (mine <= readApplied) return;
    readApplied = mine;
    for (const id of ids) deletedDocs.delete(id); // re-ingested since its deletion: records naming it apply again
    setOwn({ papers: ids });
  };
  const readPapers = async (): Promise<string[]> => {
    const mine = ++readsSent;
    const fresh = listedBy(mine, await deps.fetchPapers());
    applyRead(mine, fresh);
    return fresh;
  };

  /**
   * Whether a Doc whose address the browser reached is gone, asked of the server (ticket 11): listed in `/api/papers` is
   * there; one it does not list is asked about by its description (`GET /api/paper/:id/description`), and only a 404 is
   * gone — the list leaves out PDF Docs not owned by exactly one Work, and one owned by more than one still exists
   * (its description answers 500), so not being listed alone is not proof. A read that fails is `unknown`: the Doc opens
   * as before and its pane shows the load error.
   */
  const docExists = async (docId: string): Promise<"gone" | "there" | "unknown"> => {
    if (deletedDocs.has(docId)) return "gone";
    let list: string[];
    try {
      list = await readPapers();
    } catch {
      return "unknown";
    }
    if (list.includes(docId)) return "there";
    try {
      return (await deps.docStatus(docId)) === 404 ? "gone" : "there";
    } catch {
      return "unknown";
    }
  };

  let noticeTimer: number | null = null;
  let noticeSeq = 0;
  const showDocGone = (docId: string) => {
    if (noticeTimer !== null) timers.clear(noticeTimer);
    setOwn({ docGoneNotice: { docId, seq: ++noticeSeq } });
    const mine = timers.set(() => {
      if (noticeTimer !== mine) return;
      noticeTimer = null;
      setOwn({ docGoneNotice: null });
    }, DOC_GONE_NOTICE_MS);
    noticeTimer = mine;
  };

  /**
   * The browser arrived at the address of a Doc that is gone (ticket 11: Back, Forward, or the boot deep link): it is not
   * opened. A notice says the Doc was deleted; the Doc pane (the active one if it is one, else the first) turns back into
   * the Library page through its leave guard, as the person's own move (refused, the open Doc's address is pushed back,
   * as for any Back that leaves a Doc), and no other pane changes (a parked Doc session of that entry is dropped: Forward
   * can never put the gone Doc back). The address becomes the plain URL, the entry keeping its history state (ticket 08).
   */
  const docGone = (docId: string) =>
    batch(() => {
      // from here on it counts as deleted in this page load: a record that would put it back is void (`leftRecord`),
      // also when the Doc pane's guard keeps the open Doc and the entry stays with its record
      deletedDocs.set(docId, readsSent);
      exploreBus.exit(); // the address names no exploration any more
      const here = parkingHere();
      if (here) parks.delete(here.session);
      replaceKeepingState("/");
      showDocGone(docId);
      const { panes: current, activeId } = manager.getState();
      const pane = current.find((p) => p.id === activeId && p.view === "doc") ?? current.find((p) => p.view === "doc");
      if (pane) leaveDocPane(pane, paneTo(pane, "library"));
    });

  /** The Copilot approval that would take `docId` away: only the open Doc asks the leave guard (unsaved drafts), as the delete dialog does. */
  const leaveDoc = (docId: string): LeaveVerdict => (docId !== own.currentDoc ? true : leave.ask(undefined, undefined, "user"));

  // ---- the browser's Back/Forward ------------------------------------------------------------------ //

  /**
   * The URL a confirmed Back/Forward is let through to (see onNav): one navigation's worth of permission, one per guard that
   * grants it (`graph`: the argument graph's question, `doc`: the Doc's), so one guard's yes never answers another's
   * question. It is taken by the navigation that arrives at that URL (a traversal fires `popstate` and then, when the hash
   * differs, `hashchange`: the second must not ask again, so a taken permission lingers for a moment), and it is dropped
   * when a graph is entered again and after a couple of seconds, so it can never excuse a later, different Back.
   */
  type Grantor = "graph" | "doc";
  const allowed = new Map<Grantor, { href: string; timer: number }>();
  const dropAllowed = () => {
    for (const entry of allowed.values()) timers.clear(entry.timer);
    allowed.clear();
  };
  const allowHref = (by: Grantor, href: string) => {
    const old = allowed.get(by);
    if (old) timers.clear(old.timer);
    const entry = { href, timer: 0 };
    entry.timer = timers.set(() => {
      if (allowed.get(by) === entry) allowed.delete(by);
    }, ALLOW_MS);
    allowed.set(by, entry);
  };
  /** Whether `href` is the navigation `by` let through; taking it shortens the permission to the rest of this navigation. */
  const takeAllowed = (by: Grantor, href: string): boolean => {
    const entry = allowed.get(by);
    if (!entry || entry.href !== href) return false;
    timers.clear(entry.timer);
    entry.timer = timers.set(() => {
      if (allowed.get(by) === entry) allowed.delete(by);
    }, TAKEN_MS);
    return true;
  };
  /** The question a browser navigation is waiting on (a late-answering guard): the newest URL asked for, where "discard" goes. */
  let pendingNav: { href: string } | null = null;
  const onNav = () => {
    const location = browser.location();
    // the hashchange of a traversal whose popstate already put the open Doc's address back (pushDocBack)
    if (takePushedBack(location.href)) return;
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
    if (hit && !takeAllowed("graph", href)) {
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
            allowHref("graph", pending.href);
            browser.back();
          });
        }
        return;
      }
    }
    // `#argument/<work id>` drives the argument graph view; any other URL (a Doc, a plain URL, an exploration) leaves it
    if (!argumentWork) argumentBus.exit();
    if (route) {
      arriveAtDoc(route.docId, route.anchor, leavingView);
      return;
    }
    // Stage 14: `#explore/<bibcode>` drives the discovery mode; losing the
    // explore hash exits explore mode (the session stays resumable)
    const seed = parseExploreHash(location.hash);
    // Back to an exploration with no Library pane (the Reader replaced it): make one first, as the boot path does
    if (seed) {
      // the pane the Doc took over first gets its view back (a Plan page stays a Plan page next to the exploration); a
      // Library page a record put back takes the exploration, not another Library page (ticket 09)
      withLeftView((lookup) => {
        if (manager.getState().panes.some((p) => p.view === "library")) return exploreBus.request(seed, { paneId: restoredLibrary(lookup) });
        const pane = fallbackModePane(lookup);
        if (pane) leaveDocPane(pane, paneTo(pane, "library"), () => exploreBus.request(seed, { paneId: pane.id }));
      });
      return;
    }
    exploreBus.exit();
    // Back to a graph URL with no Library pane (the Reader replaced it): make one first, as the boot path does
    if (argumentWork) {
      withLeftView((lookup) => {
        // the pane the request names, when one was chosen here (ticket 09): the Library page a record put back, else the
        // pane the fallback made one; none keeps the bus's own rule
        const request = (paneId?: number) => argumentBus.request(argumentWork, { confirmed: leavingView, ...(paneId === undefined ? {} : { paneId }) });
        if (lookup.kind !== "invalid") {
          const made = !manager.getState().panes.some((p) => p.view === "library");
          if (ensureLibraryPane(true)) request(made ? manager.getState().activeId : restoredLibrary(lookup));
          return;
        }
        if (manager.getState().panes.some((p) => p.view === "library")) return request();
        // a void record: the pane an exploration would take (never another Doc pane; the active pane stays active), and
        // with none left nothing changes (the address names the graph, the screen keeps its Doc)
        const pane = fallbackModePane(lookup);
        if (pane) leaveDocPane(pane, paneTo(pane, "library"), () => request(pane.id));
      });
      return;
    }
    libraryForPlainUrl();
  };

  /**
   * Back/Forward (or a hand-edited address) arrived at a Doc's address: the Doc opens, unless it is gone (ticket 11). A Doc
   * deleted in this page load is gone at once; any other is checked against the server's paper list (`/api/papers`, a
   * directory listing), read again at each arrival: the page's own list cannot know a Doc deleted elsewhere (another tab,
   * the Copilot, a bare DELETE) or ingested since. Its answer applies only while the address is still the one it was asked
   * for, and a list that cannot be read opens the Doc as before (the Doc pane shows its load error). The same traversal's
   * second event asks nothing.
   */
  let pendingCheck: { href: string } | null = null;
  const arriveAtDoc = (docId: string, anchor: string | null, leavingView: boolean) => {
    const open = () => {
      // the Doc address leaves an exploration too: with a Doc pane already open the picture would not change otherwise
      exploreBus.exit();
      openDoc(docId, anchor, { libraryAsked: leavingView, urlIsDoc: true });
    };
    if (deletedDocs.has(docId)) return docGone(docId);
    const href = browser.location().href;
    // The traversal the Doc's own late yes let through (settleDocQuestion): the existence was checked before that
    // question was asked, so it opens at once and its permission is still there (a slow read would outlast it and the
    // person would be asked twice for one traversal).
    if (allowed.get("doc")?.href === href) return open();
    if (pendingCheck?.href === href) return;
    const mine = { href };
    pendingCheck = mine;
    void docExists(docId).then((found) => {
      if (pendingCheck !== mine) return;
      pendingCheck = null;
      if (browser.location().href !== href) return; // the address moved on: that navigation decides
      // deleted in this page while the read was out: gone, whatever the read said
      if (found === "gone" || deletedDocs.has(docId)) docGone(docId);
      else open();
    });
  };

  /** The pane a record put back as a Library page (where the exploration or the graph it left is to reappear), if any. */
  const restoredLibrary = (lookup: RecordLookup): number | undefined =>
    lookup.kind === "valid" && lookup.left.view === "library" ? lookup.pane.id : undefined;

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
    // the traversal the Doc's own late yes let through (settleDocQuestion): asked already
    if (takeAllowed("doc", href)) return apply();
    if (pendingLeave?.href === href) return;
    // Until the answer is yes the open Doc's address is pushed back over the entry the browser moved to: that entry, and
    // the record it carries, stay for a later Back.
    const verdict = leave.ask("doc", pane.id, "user");
    if (verdict === true) return apply();
    if (verdict === false) return void pushDocBack();
    const pushedAt = pushDocBack();
    const mine = { href };
    pendingLeave = mine;
    void verdict.then((yes) => {
      if (pendingLeave !== mine) return; // a newer navigation has its own question
      pendingLeave = null;
      settleDocQuestion(href, pushedAt, yes, apply);
    });
  };
  const paneTo = (pane: Pane, view: string) => () => manager.update((ps) => ps.map((p) => (p.id === pane.id && p.view === pane.view ? { ...p, view } : p)));

  /**
   * The entry Back/Forward arrived at may carry the record a pushed entry wrote (`LeftRecord`): the pane that change took
   * over gets its view back (a Doc it showed before: that Doc), while it is still in the view session that change made or
   * used. A record whose pane is not (switched away by hand, numbered again after a reload) is void. `then` runs afterwards
   * in every case (also after a late answer) with what was found. Returns what was found.
   */
  const withLeftView = (then: (lookup: RecordLookup) => void): RecordLookup => {
    const found = leftRecord();
    if (found.kind !== "valid") {
      then(found);
      return found;
    }
    const { left, pane } = found;
    const prev = left.prevDocId;
    const change =
      left.view === "doc"
        ? () => prev && setOwn({ currentDoc: prev, pendingAnchor: null })
        : () => {
            // the view comes back with the session this entry names (`ShownRecord`), so the record of the entry before it
            // still applies on a further Back
            const shown = shownRecord();
            if (shown && shown.paneId === pane.id && shown.view === left.view) sessions.set(pane.id, { view: left.view, token: shown.session });
            paneTo(pane, left.view)();
            syncSessions();
            // the view session it left is parked (any view): Forward to the entry that showed it puts it back
            const restored = sessionOf(pane.id);
            if (restored && left.view !== pane.view && manager.getState().panes.some((p) => p.id === pane.id && p.view === left.view))
              parks.set(left.session, { paneId: pane.id, prevView: pane.view, restored });
          };
    leaveDocPane(pane, change, () => then(found));
    return found;
  };

  /**
   * Forward arrived at a plain entry a switch pushed (`ShownRecord`) whose view session a Back parked, and the pane is still
   * in the session that Back made: the pane gets that view and that session back (the Plan page a switch away from an
   * exploration showed), so a later Back finds the exploration's record still applies. Returns whether it applied; a void
   * parking changes nothing here. (A Library page it leaves showed an exploration, which has no unsaved work, or a graph,
   * whose guard onNav already asked.)
   */
  const unparkForShown = (): boolean => {
    const here = parkingHere();
    if (!here) return false;
    parks.delete(here.session);
    sessions.set(here.paneId, { view: here.prevView, token: here.session });
    manager.update((ps) => ps.map((pane) => (pane.id === here.paneId ? { ...pane, view: here.prevView } : pane)));
    syncSessions();
    return true;
  };

  /**
   * Back/Forward arrived at a URL that names neither a Doc nor an exploration nor an argument graph (`/`). With a record on
   * that entry that still applies the pane is put back as it was (see `withLeftView`) and nothing else changes. With no
   * record (a boot deep link, an older entry) the Library page is what is there: when no pane shows it, the Doc pane (the
   * active pane if it is one) turns into it. A void record turns only the pane it names, when that is a Doc pane (ticket 07).
   */
  const libraryForPlainUrl = () => {
    if (unparkForShown()) return;
    const lookup = withLeftView(() => {});
    if (lookup.kind === "valid") return;
    const { panes: current, activeId } = manager.getState();
    if (current.some((p) => p.view === "library")) return;
    // a void record lets the fallback turn only the pane it names, never another Doc pane (ticket 07)
    const pane =
      lookup.kind === "invalid"
        ? current.find((p) => p.id === lookup.paneId && p.view === "doc")
        : current.find((p) => p.id === activeId && p.view === "doc") ?? current.find((p) => p.view === "doc");
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

  // ---- switching a pane's view (the activity bar, the pane menu, the Copilot's switch_view) ---------- //

  /**
   * Pane `id` is switched to `view` (the activity bar: the active pane; the pane menu: that pane, which becomes active; the
   * Copilot's `switch_view` the same way with origin `agent`). A pane that shows the open exploration (`#explore/…`) or
   * the open argument graph (`#argument/…`) leaves it this way: the mode ends with the Library page, and a new history
   * entry names what is on screen now — the Doc's address when the pane becomes a Doc pane showing a Doc, else the plain
   * URL — so Back returns to the exploration or the graph. The pane's new view session is recorded on the entry it leaves
   * (`LeftRecord`, whatever the view), as `openDoc` does. The Library page's leave guard (the graph's draft) is asked once,
   * as the pane manager would; refused, nothing changes. A late yes still switches, but writes the entry only while the
   * address is still the one asked at (a later navigation's entry is not this switch's to bury).
   */
  const switchView = (id: number, view: string, origin: LeaveOrigin, activate: boolean): boolean => {
    const pane = manager.getState().panes.find((p) => p.id === id);
    const at = browser.location();
    // the Library page's two modes that own the address: an exploration, and the argument graph (ticket 05)
    const showsMode = (parseExploreHash(at.hash) !== null && exploreBus.hostedBy(id)) || (parseArgumentHash(at.hash) !== null && argumentBus.hostedBy(id));
    const leavesMode = pane?.view === "library" && view !== "library" && showsMode;
    if (!pane || !leavesMode) return activate ? manager.setPaneView(id, view, origin) : manager.setActiveView(view, origin);
    // the entry asked at, by identity: another entry at the same address (the graph's address its own refusal pushed
    // back while this question was open) is not it
    const askedAt = entryToken();
    const apply = () =>
      batch(() => {
        if (!manager.getState().panes.some((p) => p.id === id && p.view === pane.view)) return;
        const write = stateObject().argelanderEntry === askedAt;
        const docUrl = view === "doc" ? openDocUrl() : null;
        const session = write ? mintSession() : null;
        if (session) {
          // the pane enters a view session of its own (any view: ticket 07), recorded on the entry it leaves (see onNav)
          sessions.set(id, { view, token: session });
          writeLeftRecord(pane, session);
        }
        manager.update((ps) => ps.map((p) => (p.id === id ? { ...p, view } : p)));
        if (activate) manager.select(id);
        syncSessions();
        if (session) {
          browser.push(docUrl ?? "/");
          // the entry it pushes names that session, so Forward back to it after a Back finds the parked view (see `parks`)
          browser.setState({ argelanderShown: { paneId: id, session, view } satisfies ShownRecord });
          if (docUrl) noteDocAddress();
        }
      });
    const verdict = leave.ask(pane.view, pane.id, origin);
    if (verdict === true) {
      apply();
      return true;
    }
    if (verdict !== false) void verdict.then((yes) => yes && apply());
    return false;
  };
  const setActiveView = (view: string, origin: LeaveOrigin = "user"): boolean => switchView(manager.getState().activeId, view, origin, false);
  const setPaneView = (id: number, view: string, origin: LeaveOrigin = "user"): boolean => switchView(id, view, origin, true);

  // ---- boot ------------------------------------------------------------------------------------- //

  /**
   * Load the paper list once and pick the first Doc; a deep link takes precedence: `/doc/<id>[#anchor]` opens it (one the
   * list read does not have is gone: `docGone`, ticket 11),
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
      let read = false;
      // a read of its own, applied below in the boot's one change, counted with the others (`readPapers`)
      const mine = ++readsSent;
      try {
        list = listedBy(mine, await deps.fetchPapers());
        read = true;
      } catch {
        /* reader may be offline; Library still works on fixture data */
      }
      if (!alive) return;
      // A deep link to a Doc the list does not have is asked about by its description, as an arrival is (`docExists`):
      // only a 404 is gone. With no list to check (offline) or no answer it is opened anyway: DocPane shows its load error.
      let gone = false;
      if (route && read && !list.includes(route.docId)) {
        try {
          gone = (await deps.docStatus(route.docId)) === 404;
        } catch {
          gone = false;
        }
        if (!alive) return;
      }
      batch(() => {
        // a newer read (an arrival, library.changed) that answered first keeps its list
        applyRead(mine, list);
        // A Doc opened while the list was read (the person's open, the Copilot's open_doc: it wrote `/doc/<id>`) stays open
        // with its address, over the boot's own deep link or default too: the later open wins. The current Doc starts
        // empty and only an open sets it, so a page that merely pushed an exploration or a graph meanwhile still gets the
        // boot's choice (shelf-followups 11).
        if (own.currentDoc !== null) return;
        if (route) {
          // A gone Doc (ticket 11): not opened; the Library page, the plain URL and the notice, as for Back/Forward to it.
          if (gone) {
            setOwn({ currentDoc: list[0] ?? null });
            docGone(route.docId);
            ensureLibraryPane(false); // the pane the deep link would have made the Doc pane (nothing to lose at boot)
            return;
          }
          openDoc(route.docId, route.anchor, { urlIsDoc: true });
          return;
        }
        // The boot acts on the address it booted from. One that changed while the list was read was written by the
        // page itself (an exploration or a graph opened meanwhile, pushState) or by a hand edit that `onNav` already
        // served: handing it to a bus again would open the same thing twice (shelf-followups 07: a second ADS request).
        const moved = browser.location().href !== at.href;
        // Stage 14: a boot `#explore/<bibcode>` hash opens the library pane and
        // hands the seed to the explore bus (the LibraryView consumes it once
        // mounted — exploreBus keeps it pending until then)
        const exploreSeed = moved ? null : parseExploreHash(at.hash);
        if (exploreSeed) {
          ensureLibraryPane(false);
          exploreBus.request(exploreSeed);
          return;
        }
        // Argument graph ticket 04: a boot `#argument/<work id>` hash opens the library pane the same way
        const argumentWork = moved ? null : parseArgumentHash(at.hash);
        if (argumentWork) {
          ensureLibraryPane(false);
          argumentBus.request(argumentWork);
          return;
        }
        const want = new URL(at.href).searchParams.get("doc");
        setOwn({ currentDoc: want && list.includes(want) ? want : list[0] ?? null });
      });
    })();
    const unlisten = browser.listen(onNav);
    // the server says the library changed (a Doc deleted or added, here or elsewhere): the paper list is read again; only
    // the newest read is kept, and a read that fails leaves the list as it is
    const unlistenLibrary =
      deps.onLibraryChanged?.(() => {
        if (alive) readPapers().catch(() => {});
      }) ?? (() => {});
    return () => {
      alive = false;
      unlisten();
      unlistenLibrary();
      dropAllowed();
      pendingCheck = null;
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
        fresh = await readPapers(); // the list is replaced too, when this read is the newest
      } catch {
        return { ok: false, detail: "unavailable" };
      }
      if (!fresh.includes(docId)) return { ok: false, detail: "not_found" };
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
        // the same path as the person's switch (switchView: leaving an exploration or a graph writes history), as the agent
        const applied = action.paneId === undefined ? setActiveView(action.view, "agent") : setPaneView(id, action.view, "agent");
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
    setActiveView,
    setPaneView,
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

/** A token unique to this page load (history state outlives a reload; the pane ids and sessions do not). */
function newPageLoadId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
