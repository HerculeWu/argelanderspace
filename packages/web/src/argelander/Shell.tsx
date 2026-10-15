import { DiscoverySavedViewActionSchema, APPEARANCE_DENSITIES, APPEARANCE_LANGUAGES, APPEARANCE_THEMES, type CopilotViewAction, MAX_PANES, type PageContext, SETTINGS_VIEW, type WorkspaceViewAction, WorkspaceViewActionSchema } from "@argelanderspace/contracts";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import { fetchPapers } from "../api";
import { parseDocRoute, pushDocUrl, replaceDocUrl } from "../lib/deeplink";
import { argumentBus, argumentUrl, parseArgumentHash } from "../lib/argument-route";
import { exploreBus, parseExploreHash } from "../lib/explore-route";
import { DEFAULT_LANGUAGE } from "../i18n";
import { planResize, resizeDivider, shareOf } from "./layout";
import { createPaneManager, type Pane, type PaneAdapter, type PaneManager, type ViewActionOutcome } from "./panes";
import { PreferencesProvider, usePreferencesState } from "./preferences";
import { ACCENTS } from "./theme";
import { notePane } from "../page-errors";
import { claimViewId, loadViewIdentity, saveViewIdentity } from "./view-identity";
import { applyDocDeletion, askWorkspaceLeave, confirmWorkspaceLeave, type LeaveOrigin, WorkspaceProvider, type Workspace } from "./workspace";
import { CommandPalette } from "./CommandPalette";
import { TweaksPopover } from "./TweaksPopover";
import { DocPane } from "../doc/DocPane";
import { createDocPane, type DocPaneHost } from "../doc/doc-pane-adapter";
import { LibraryView } from "../library/LibraryView";
import { createLibraryPane } from "../library/library-pane";
import { PlanView } from "../plan/PlanView";
import { createPlanPane } from "../plan/plan-pane";
import { manuscriptDeleteGuard } from "../writer/writer-context";
import { WriterView } from "../writer/WriterView";
import { createWriterPane } from "../writer/writer-pane";
import { Copilot } from "../copilot/Copilot";
import type { ConfirmationGuards } from "../copilot/confirmations";
import { MailNavItem } from "../mail/MailNavItem";
import { MailView } from "../mail/MailView";
import { createMailPane } from "../mail/mail-pane";
import { ConfigProblemsBanner } from "../settings/ConfigProblemsBanner";
import { PortFallbackBanner } from "../settings/PortFallbackBanner";
import { SettingsNotices, SettingsView } from "../settings/SettingsView";
import { createSettingsPane } from "../settings/settings-pane";

interface NavItem {
  k: string;
  ic: string;
  labelKey: "shell.nav.plan" | "shell.nav.library" | "shell.nav.doc" | "shell.nav.write" | "shell.nav.mail" | "shell.nav.settings";
  /** `core`: the workbench views at the head of the rail; `foot`: the settings page, at its foot. */
  grp: "core" | "foot";
}

const NAV: NavItem[] = [
  { k: "plan", ic: "telescope", labelKey: "shell.nav.plan", grp: "core" },
  { k: "library", ic: "library", labelKey: "shell.nav.library", grp: "core" },
  { k: "doc", ic: "file-text", labelKey: "shell.nav.doc", grp: "core" },
  { k: "write", ic: "pen-line", labelKey: "shell.nav.write", grp: "core" },
  { k: "mail", ic: "mail", labelKey: "shell.nav.mail", grp: "core" },
  { k: SETTINGS_VIEW, ic: "settings", labelKey: "shell.nav.settings", grp: "foot" },
];
const NAV_MAP: Record<string, NavItem> = Object.fromEntries(NAV.map((n) => [n.k, n]));

/** The pane the Shell starts with. */
const INITIAL_PANE_ID = 1;
const noChange = () => {};

export function Shell() {
  const { t } = useTranslation();
  // The appearance and the settings behind it: read from and written to config.toml through the server (preferences.tsx).
  const preferences = usePreferencesState();
  const { tweaks, setTweak } = preferences;
  const [cmdOpen, setCmdOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [copilotOpen, setCopilotOpen] = useState(false);
  // Opening the panel with its toggle puts the cursor in its input (the panel is after the whole page in tab order).
  const focusCopilotInput = useRef(false);
  useEffect(() => {
    if (!copilotOpen || !focusCopilotInput.current) return;
    focusCopilotInput.current = false;
    document.querySelector<HTMLTextAreaElement>('[data-ui="copilot-input"]')?.focus();
  }, [copilotOpen]);
  const [copilotWaiting, setCopilotWaiting] = useState(false);
  // This tab's Copilot view: stable across a reload, and its revision keeps counting upwards (view-identity.ts).
  const [identity] = useState(loadViewIdentity);
  const [viewId, setViewId] = useState(identity.viewId);
  const revision = useRef(identity.revision);
  // The id is this tab's only once the lock answer is known: until then nothing subscribes or publishes under it.
  const [viewClaimed, setViewClaimed] = useState(false);
  useEffect(() => {
    // A duplicated tab inherits its sibling's id; two tabs must never answer to one view.
    setViewClaimed(false);
    return claimViewId(viewId, { onHeld: () => setViewClaimed(true), onTaken: () => { revision.current = 0; setViewId(crypto.randomUUID()); } });
  }, [viewId]);

  const [papers, setPapers] = useState<string[]>([]);
  const [currentDoc, setCurrentDocState] = useState<string | null>(null);
  const currentDocRef = useRef(currentDoc);
  currentDocRef.current = currentDoc;
  const openLibraryDocRef = useRef<(docId: string) => Promise<ViewActionOutcome>>(async () => ({ ok: false, detail: "unavailable" }));
  // A Doc pane's Reader actions name their Doc; one that is not open is opened through the Shell's own openDoc.
  const [docHost] = useState<DocPaneHost>(() => ({ currentDoc: () => currentDocRef.current, openDoc: (docId) => openLibraryDocRef.current(docId) }));
  // The panes, and each pane's page as the Copilot sees it (panes/): the Shell renders from the manager's state.
  const [manager] = useState(() =>
    createPaneManager({
      panes: [{ id: INITIAL_PANE_ID, view: "plan", size: 1 }],
      activeId: INITIAL_PANE_ID,
      pages: [createPlanPane(noChange).adapter, createLibraryPane(noChange).adapter, createDocPane(noChange, docHost).adapter, createWriterPane(noChange).adapter, createMailPane(noChange).adapter, createSettingsPane().adapter],
      confirmLeave: askWorkspaceLeave,
    })
  );
  const { panes, activeId, pagesVersion } = useSyncExternalStore(manager.subscribe, manager.getState);
  const { select: setActiveId, setActiveView, setPaneView, split: splitFrom, close: closePane } = manager;

  // Approving a manuscript delete would discard unsaved edits of an open editor (or its Info/Preamble dialog): ask first.
  const beforeManuscriptDelete = useCallback((manuscriptId: string) => {
    return manuscriptDeleteGuard(manager.mounted("write").map((writer) => writer.context().writer), manuscriptId, () => window.confirm(t("copilot.confirmation.manuscriptDraftGuard")));
  }, [t, manager]);
  // The workspace's guards before a Copilot approval takes something open away; a refusal keeps the card.
  const confirmationGuards = useMemo<ConfirmationGuards>(() => ({
    // Only the open Doc asks the workspace's leave guard (unsaved drafts), as the delete dialog does.
    leaveDoc: (docId) => docId !== currentDocRef.current || confirmWorkspaceLeave(),
    leaveManuscript: beforeManuscriptDelete,
  }), [beforeManuscriptDelete]);
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const clearPendingAnchor = useCallback(() => setPendingAnchor(null), []);

  const panesRef = useRef<HTMLDivElement>(null);
  const multi = panes.length > 1;
  const activePane = panes.find((p) => p.id === activeId) || panes[0]!;
  // A page error is reported with the name of the pane that was open (page-errors.ts). Said here, while rendering,
  // and not in an effect: when a page throws in its first render this render is never committed and no effect runs.
  // With several panes side by side it is the active one.
  notePane(activePane.view);

  // A mode that lives in the Library page (exploration, the argument graph view) needs a Library pane to open in: the one
  // already there, else the active pane becomes one. `guard`: ask the leave guard first (a navigation of the user's, with
  // a Doc possibly holding a draft); the boot path has nothing to lose. False: refused, nothing changed.
  const ensureLibraryPane = useCallback(
    (guard: boolean): boolean => {
      if (manager.getState().panes.some((p) => p.view === "library")) return true;
      if (guard) return manager.setActiveView("library");
      const active = manager.getState().activeId;
      manager.update((ps) => ps.map((p) => (p.id === active ? { ...p, view: "library" } : p)));
      return true;
    },
    [manager]
  );

  // load the ingested-papers list once, pick an initial document; a
  // `/doc/<id>[#anchor]` deep link takes precedence and opens the doc pane
  useEffect(() => {
    let alive = true;
    const route = parseDocRoute(window.location.pathname, window.location.hash);
    (async () => {
      let list: string[] = [];
      try {
        list = await fetchPapers();
      } catch {
        /* reader may be offline; Library still works on fixture data */
      }
      if (!alive) return;
      setPapers(list);
      if (route) {
        // unknown ids are opened anyway: DocPane shows its normal load error
        openDocRef.current(route.docId, route.anchor);
        return;
      }
      // Stage 14: a boot `#explore/<bibcode>` hash opens the library pane and
      // hands the seed to the explore bus (the LibraryView consumes it once
      // mounted — exploreBus keeps it pending until then)
      const exploreSeed = parseExploreHash(window.location.hash);
      if (exploreSeed) {
        ensureLibraryPane(false);
        exploreBus.request(exploreSeed);
        return;
      }
      // Argument graph ticket 04: a boot `#argument/<work id>` hash opens the library pane the same way
      const argumentWork = parseArgumentHash(window.location.hash);
      if (argumentWork) {
        ensureLibraryPane(false);
        argumentBus.request(argumentWork);
        return;
      }
      const want = new URL(window.location.href).searchParams.get("doc");
      const initialDoc = want && list.includes(want) ? want : list[0] ?? null;
      currentDocRef.current = initialDoc;
      setCurrentDocState(initialDoc);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const setCurrentDoc = useCallback((id: string) => {
    if (id === currentDocRef.current) return;
    if (!confirmWorkspaceLeave()) return;
    currentDocRef.current = id;
    setCurrentDocState(id);
    replaceDocUrl(id); // UI-driven switch: any stale #anchor no longer applies
  }, []);

  const openDoc = useCallback(
    (docId?: string, anchor?: string | null, opts: { libraryAsked?: boolean; origin?: LeaveOrigin } = {}): boolean => {
      const nextDoc = docId ?? currentDocRef.current ?? papers[0] ?? null;
      // A refused switch puts a URL the browser already moved back; a click from the argument graph view has not moved
      // it (the view is still open, and its URL must still say so).
      const restoreUrl = () => {
        if (currentDocRef.current && parseArgumentHash(window.location.hash) === null) replaceDocUrl(currentDocRef.current);
      };
      if (nextDoc !== currentDocRef.current && !confirmWorkspaceLeave()) {
        restoreUrl();
        return false;
      }
      const apply = () => {
        currentDocRef.current = nextDoc;
        setCurrentDocState(nextDoc);
        if (docId) {
          // Opened from the argument graph view (its URL is `#argument/…`): keep that entry, so Back returns to the graph.
          if (parseArgumentHash(window.location.hash) !== null) pushDocUrl(docId, anchor);
          else replaceDocUrl(docId, anchor);
          setPendingAnchor(anchor ?? null);
        }
        // ensure a pane shows the document: prefer an existing doc pane, else the active one
        manager.update((ps) => {
          if (ps.some((p) => p.view === "doc")) return ps;
          const active = manager.getState().activeId;
          return ps.map((p) => (p.id === active ? { ...p, view: "doc" } : p));
        });
      };
      // With no Doc pane the active pane becomes one: if that pane is a Library page, its unsaved argument draft is lost
      // (the page asks, unless the caller already asked about leaving it: the browser's Back).
      const { panes: current, activeId } = manager.getState();
      const replaced = current.some((p) => p.view === "doc") ? undefined : current.find((p) => p.id === activeId);
      if (replaced?.view === "library" && !opts.libraryAsked) {
        const verdict = askWorkspaceLeave("library", replaced.id, opts.origin);
        if (verdict !== true) {
          if (verdict === false) restoreUrl();
          else
            void verdict.then((ok) => {
              if (ok) apply();
              else restoreUrl();
            });
          return false;
        }
      }
      apply();
      return true;
    },
    [manager, papers]
  );

  // deep links: react to browser back/forward and manual hash edits
  const openDocRef = useRef(openDoc);
  openDocRef.current = openDoc;
  /**
   * The URL a confirmed Back/Forward is let through to (see onNav): one navigation's worth of permission. It is taken by the
   * navigation that arrives at that URL (a traversal fires `popstate` and then, when the hash differs, `hashchange`: the
   * second must not ask again, so a taken permission lingers for a moment), and it is dropped when a graph is entered again
   * and after a couple of seconds, so it can never excuse a later, different Back.
   */
  const allowed = useRef<{ href: string; timer: number } | null>(null);
  const dropAllowed = useCallback(() => {
    if (allowed.current) window.clearTimeout(allowed.current.timer);
    allowed.current = null;
  }, []);
  const allowHref = useCallback(
    (href: string) => {
      dropAllowed();
      const entry = { href, timer: 0 };
      entry.timer = window.setTimeout(() => {
        if (allowed.current === entry) allowed.current = null;
      }, 2000);
      allowed.current = entry;
    },
    [dropAllowed]
  );
  /** Whether `href` is the navigation that was let through; taking it shortens the permission to the rest of this navigation. */
  const takeAllowed = useCallback((href: string): boolean => {
    const entry = allowed.current;
    if (!entry || entry.href !== href) return false;
    window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(() => {
      if (allowed.current === entry) allowed.current = null;
    }, 100);
    return true;
  }, []);
  useEffect(() => dropAllowed, [dropAllowed]);
  /** The question a browser navigation is waiting on (a late-answering guard): the newest URL asked for, where "discard" goes. */
  const pendingNav = useRef<{ href: string } | null>(null);
  useEffect(() => {
    const onNav = () => {
      const route = parseDocRoute(window.location.pathname, window.location.hash);
      const argumentWork = parseArgumentHash(window.location.hash);
      // The browser's Back/Forward (or a hand-edited hash) away from an open argument graph, to a plain URL, a Doc, an
      // exploration or another Work's graph: the leave guard of the pane that shows that graph decides first (an unsaved
      // draft is asked about with the app's own dialog, which answers later). The URL has already moved. Until the answer
      // is yes, the graph's URL is pushed back over it (a new entry after the one the browser moved to, so the forward
      // entries are dropped); on yes, `history.back()` returns to the entry the person chose and that one navigation is
      // let through without asking again (`allowed`). A navigation made while the question is open asks nothing more: it
      // only becomes the destination "discard" goes to (every such navigation adds its own entry and the graph's URL again).
      const hit = argumentBus.affected(argumentWork);
      const leavingView = hit !== null;
      const href = window.location.href;
      if (hit && !takeAllowed(href)) {
        if (pendingNav.current) {
          pendingNav.current.href = href;
          window.history.pushState(null, "", argumentUrl(hit.open));
          return;
        }
        const verdict = askWorkspaceLeave("library", hit.paneId);
        if (verdict !== true) {
          window.history.pushState(null, "", argumentUrl(hit.open));
          if (verdict !== false) {
            const pending = { href };
            pendingNav.current = pending;
            void verdict.then((ok) => {
              if (pendingNav.current === pending) pendingNav.current = null;
              if (!ok) return;
              allowHref(pending.href);
              window.history.back();
            });
          }
          return;
        }
      }
      // `#argument/<work id>` drives the argument graph view; any other URL (a Doc, a plain URL, an exploration) leaves it
      if (!argumentWork) argumentBus.exit();
      if (route) {
        openDocRef.current(route.docId, route.anchor, { libraryAsked: leavingView });
        return;
      }
      // Stage 14: `#explore/<bibcode>` drives the discovery mode; losing the
      // explore hash exits explore mode (the session stays resumable)
      const seed = parseExploreHash(window.location.hash);
      if (seed) exploreBus.request(seed);
      else exploreBus.exit();
      // Back to a graph URL with no Library pane (the Reader replaced it): make one first, as the boot path does
      if (argumentWork && ensureLibraryPane(true)) argumentBus.request(argumentWork, { confirmed: leavingView });
    };
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
    };
  }, [ensureLibraryPane, allowHref, takeAllowed]);

  // Stage 8 §8: a document delete lands here (the papers list is fetched only
  // once at boot, so the deleted id must be dropped locally; currentDoc
  // migrates per the three-state rule — the library.changed broadcast covers
  // the OTHER library surfaces, not this local transition).
  const papersRef = useRef(papers);
  papersRef.current = papers;
  const docDeleted = useCallback((docId: string, remaining: string[]) => {
    const next = applyDocDeletion(
      { papers: papersRef.current, currentDoc: currentDocRef.current },
      docId,
      remaining
    );
    setPapers(next.papers);
    if (next.currentDoc !== currentDocRef.current) {
      currentDocRef.current = next.currentDoc;
      setCurrentDocState(next.currentDoc);
      if (next.currentDoc) replaceDocUrl(next.currentDoc);
      else window.history.replaceState(null, "", "/"); // nothing left to show
    }
  }, []);

  // ---- Copilot view actions (ticket 12) -------------------------------------------------------- //
  // Everything below drives the same callbacks the controls use: the pane limit, the leave-draft
  // protection and the divider rule are the UI's own. Reads go through `shell.current` because an action
  // outlives the render that started it. Nothing here calls focus(): another tab or window is never raised.
  // A page's own actions go to its pane adapter through the pane manager (panes/).
  const shell = useRef({ panes, activeId, setActiveView, setPaneView, splitFrom, closePane, setTweak, tweaks, papers, setPapers, openDoc, copilotOpen });
  shell.current = { panes, activeId, setActiveView, setPaneView, splitFrom, closePane, setTweak, tweaks, papers, setPapers, openDoc, copilotOpen };
  type Report = ViewActionOutcome;
  const settle = async (check: () => boolean): Promise<boolean> => {
    for (let attempt = 0; attempt < 40; attempt++) {
      if (check()) return true;
      await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
    }
    return false;
  };
  const runWorkspaceAction = useCallback(async (action: WorkspaceViewAction): Promise<Report> => {
    const s = () => shell.current;
    const missing = (id: number) => !s().panes.some((pane) => pane.id === id);
    switch (action.action) {
      case "switch_view": {
        const id = action.paneId ?? s().activeId;
        if (missing(id)) return { ok: false, detail: "not_found" };
        const applied = action.paneId === undefined ? s().setActiveView(action.view, "agent") : s().setPaneView(id, action.view, "agent");
        if (!applied) return { ok: false, detail: "leave_blocked" };
        return (await settle(() => s().panes.find((pane) => pane.id === id)?.view === action.view && (action.paneId === undefined || s().activeId === id))) ? { ok: true } : { ok: false, detail: "unavailable" };
      }
      case "split_pane": {
        const id = action.paneId ?? s().activeId;
        if (missing(id)) return { ok: false, detail: "not_found" };
        const before = s().panes.length;
        if (before >= MAX_PANES) return { ok: false, detail: "disabled" };
        s().splitFrom(id);
        return (await settle(() => s().panes.length === before + 1)) ? { ok: true } : { ok: false, detail: "unavailable" };
      }
      case "close_pane": {
        if (missing(action.paneId)) return { ok: false, detail: "not_found" };
        if (s().panes.length <= 1) return { ok: false, detail: "disabled" };
        if (!s().closePane(action.paneId, "agent")) return { ok: false, detail: "leave_blocked" };
        return (await settle(() => missing(action.paneId))) ? { ok: true } : { ok: false, detail: "unavailable" };
      }
      case "select_pane": {
        if (missing(action.paneId)) return { ok: false, detail: "not_found" };
        setActiveId(action.paneId);
        return (await settle(() => s().activeId === action.paneId)) ? { ok: true } : { ok: false, detail: "unavailable" };
      }
      case "resize_pane": {
        const index = s().panes.findIndex((pane) => pane.id === action.paneId);
        if (index < 0) return { ok: false, detail: "not_found" };
        const sizes = planResize(s().panes.map((pane) => pane.size), index, action.share);
        if (!sizes) return { ok: false, detail: "disabled" };
        manager.update((ps) => (ps.length === sizes.length ? ps.map((pane, i) => ({ ...pane, size: sizes[i] ?? pane.size })) : ps));
        return { ok: true };
      }
      case "set_appearance": {
        const { theme, accent, density, language } = action;
        // Done only when config.toml has every one of them: each change resolves with what the file took.
        const made = await Promise.all([
          ...(theme ? [s().setTweak("theme", theme)] : []),
          ...(accent ? [s().setTweak("accent", accent)] : []),
          ...(density ? [s().setTweak("density", density)] : []),
          ...(language ? [s().setTweak("language", language)] : []),
        ]);
        return made.every(Boolean) ? { ok: true } : { ok: false, detail: "unavailable" };
      }
      case "open_copilot":
      case "close_copilot": {
        // The toolbar's own toggle: only the panel is shown or collapsed, the conversation keeps running.
        const want = action.action === "open_copilot";
        setCopilotOpen(want);
        return (await settle(() => s().copilotOpen === want)) ? { ok: true } : { ok: false, detail: "unavailable" };
      }
      case "open_doc":
        return openLibraryDoc(action.docId);
      default:
        // open_copilot_settings belongs to the Copilot panel itself, which handles it before the Shell is asked.
        return { ok: false, detail: "unavailable" };
    }
  }, []);
  // Opening a Doc (the library's open button, the task drawer's linked-document button): the same openDoc callback.
  const openLibraryDoc = useCallback(async (docId: string): Promise<Report> => {
    if (!shell.current.papers.includes(docId)) {
      let fresh: string[];
      try { fresh = await fetchPapers(); } catch { return { ok: false, detail: "unavailable" }; }
      if (!fresh.includes(docId)) return { ok: false, detail: "not_found" };
      shell.current.setPapers(fresh);
    }
    if (shell.current.openDoc(docId, undefined, { origin: "agent" }) === false) return { ok: false, detail: "leave_blocked" };
    return (await settle(() => currentDocRef.current === docId && shell.current.panes.some((pane) => pane.view === "doc"))) ? { ok: true } : { ok: false, detail: "unavailable" };
  }, []);
  openLibraryDocRef.current = openLibraryDoc;
  const openTaskDoc = openLibraryDoc;
  const docDeletedRef = useRef(docDeleted);
  docDeletedRef.current = docDeleted;
  const runViewAction = useCallback(async (action: CopilotViewAction): Promise<Report> => {
    // The service tells the bound view that a Doc was deleted through the Copilot: the same three-state Shell
    // update the Library page makes after its own delete (not model-callable; it is no tool action).
    if (action.action === "doc_deleted") {
      docDeletedRef.current(action.docId, action.remaining);
      return { ok: true };
    }
    // The service saved a candidate: every Library pane that holds that node marks it saved in place (a pane that is
    // not exploring ignores it). It never opens or switches anything.
    const saved = DiscoverySavedViewActionSchema.safeParse(action);
    if (saved.success) {
      for (const library of manager.mounted("library")) void library.apply?.(saved.data);
      return { ok: true };
    }
    const workspaceAction = WorkspaceViewActionSchema.safeParse(action);
    if (workspaceAction.success) return runWorkspaceAction(workspaceAction.data);
    if (action.action === "open_task_doc") return openTaskDoc(action.docId);
    // Every page action (Plan, Library and Discovery, Reader and PDF, Writer) goes to the adapter that handles it.
    return manager.runViewAction(action);
  }, [manager, runWorkspaceAction, openTaskDoc]);

  // divider drag-resize
  const onDividerDown = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    const rect = panesRef.current!.getBoundingClientRect();
    const startX = e.clientX;
    const start = panes.map((p) => p.size);
    const total = start.reduce((a, b) => a + b, 0);
    const move = (ev: MouseEvent) => {
      const d = ((ev.clientX - startX) / rect.width) * total;
      const sizes = resizeDivider(start, i, d);
      manager.update((ps) => ps.map((p, idx) => ({ ...p, size: sizes[idx] ?? p.size })));
    };
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  // keyboard
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((o) => !o);
      } else if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        splitFrom(activeId);
      } else if (e.key === "Escape") {
        setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [activeId, splitFrom]);

  // The Reader's "argument graph" entry: show a Library page (the pane that has one, else the active pane) and open the
  // work's graph there; entering the view writes its history entry.
  const openArgumentGraph = useCallback(
    (workId: string) => {
      dropAllowed(); // entering a graph again ends any earlier "let this one Back through"
      // The pane that shows the view is chosen here and named in the request, so the bus serves exactly it.
      const { panes: current, activeId: active } = manager.getState();
      const library = current.find((p) => p.id === active && p.view === "library") ?? current.find((p) => p.view === "library");
      if (library) manager.select(library.id);
      else if (!manager.setActiveView("library")) return;
      argumentBus.request(workId, { push: true, paneId: library?.id ?? manager.getState().activeId });
    },
    [manager, dropAllowed]
  );
  // The settings page's entries: the provider dialog belongs to the Copilot panel (asked for by a counter it watches),
  // the accounts to the Mail view.
  const [providerSettingsAsked, setProviderSettingsAsked] = useState(0);
  const openCopilotSettings = useCallback(() => {
    setCopilotOpen(true);
    setProviderSettingsAsked((n) => n + 1);
  }, []);
  const openMailAccounts = useCallback(() => setActiveView("mail"), [setActiveView]);
  const workspace: Workspace = useMemo(
    () => ({ papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, docDeleted, openArgumentGraph, openCopilotSettings, openMailAccounts, tweaks }),
    [papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, docDeleted, openArgumentGraph, openCopilotSettings, openMailAccounts, tweaks]
  );

  // The page fields and status are the active pane's page adapter's (`pagesVersion` changes with what pages report).
  const pageContext = useMemo<PageContext>(() => {
    const page = manager.pageOf(activePane);
    const fields = page?.context() ?? {};
    return {
      version: 1, viewId, revision: ++revision.current, paneId: activePane.id, view: activePane.view,
      otherPanes: panes.filter((pane) => pane.id !== activePane.id).map((pane) => ({ paneId: pane.id, view: pane.view })),
      // Example data (or a Library still loading / replaced by Discovery) is never reported as complete.
      status: page?.status() ?? "unavailable",
      plan: fields.plan ?? null,
      library: fields.library ?? null,
      discovery: fields.discovery ?? null,
      // The Library tab's argument graph view (it replaces `library` while open).
      argument: fields.argument ?? null,
      // The Reader of the ACTIVE pane: the page the user is working in, and the one navigation acts on.
      reader: fields.reader ?? null,
      pdf: fields.pdf ?? null,
      textSource: fields.textSource ?? null,
      // The Writer of the ACTIVE pane: the list or the open manuscript (saved content, and the draft apart from it).
      writer: fields.writer ?? null,
      // The Mail page of the ACTIVE pane: untrusted external data (the open message and the list headers).
      mail: fields.mail ?? null,
      workspace: {
        maxPanes: MAX_PANES, activePaneId: activePane.id,
        panes: panes.map((pane, index) => ({ paneId: pane.id, view: pane.view, share: shareOf(panes.map((item) => item.size), index) })),
        // Stored tweaks can be damaged; the published snapshot only ever carries values the service accepts.
        appearance: {
          theme: (APPEARANCE_THEMES as readonly string[]).includes(tweaks.theme) ? tweaks.theme : "dark",
          accent: tweaks.accent in ACCENTS ? tweaks.accent : "azure",
          density: (APPEARANCE_DENSITIES as readonly string[]).includes(tweaks.density) ? tweaks.density : "regular",
          language: (APPEARANCE_LANGUAGES as readonly string[]).includes(tweaks.language ?? "") ? tweaks.language ?? DEFAULT_LANGUAGE : DEFAULT_LANGUAGE,
        },
        copilotOpen,
      },
    };
  }, [manager, viewId, activePane.id, activePane.view, panes, pagesVersion, tweaks, copilotOpen]);
  useEffect(() => { saveViewIdentity({ viewId, revision: pageContext.revision }); }, [viewId, pageContext]);

  // F12 locators: data-ui names a semantic role (never translated copy),
  // data-ui-key distinguishes repeated instances using an existing public id.
  // Scope selectors by workspace-pane key when multiple panes show the same view.
  return (
    <PreferencesProvider value={preferences}>
    <WorkspaceProvider value={workspace}>
      <div className="app" data-ui="app-shell">
        <div className="titlebar" data-ui="app-titlebar">
          <div className="tb-left">
            <span className="wordmark">
              <span className="wordmark-mark">✦</span>ArgelanderSpace
            </span>
          </div>
          <div className="tb-center">{t("shell.tagline")}</div>
          <div className="tb-right" data-ui="titlebar-actions">
            <ActionButton
              mode="icon"
              iconName="columns-2"
              unstyled
              className="btn icon ghost"
              data-ui="split-pane"
              iconSize="small"
              label={t("shell.titlebar.split")}
              tooltip={t("shell.titlebar.split")}
              disabled={panes.length >= MAX_PANES}
              onClick={() => splitFrom(activeId)}
            />
            <ActionButton
              mode="icon"
              iconName={tweaks.theme === "dark" ? "sun" : "moon"}
              unstyled
              className="btn icon ghost"
              data-ui="toggle-theme"
              iconSize="small"
              label={t("shell.titlebar.toggleTheme")}
              onClick={() => setTweak("theme", tweaks.theme === "dark" ? "light" : "dark")}
            />
            <ActionButton
              mode="icon"
              iconName="sliders-horizontal"
              unstyled
              className="btn icon ghost"
              data-ui="open-tweaks"
              iconSize="small"
              label={t("shell.titlebar.tweaks")}
              tooltip={t("shell.titlebar.tweaks")}
              aria-expanded={tweaksOpen}
              onClick={() => setTweaksOpen((o) => !o)}
            />
            <span className="copilot-toggle-wrap">
              <ActionButton mode="icon" iconName="panel-right-open" unstyled className="btn icon ghost" iconSize="small" data-ui="copilot-toggle" label={copilotWaiting && !copilotOpen ? t("copilot.waitingToggle") : t("copilot.title")} tooltip={copilotWaiting && !copilotOpen ? t("copilot.waitingToggle") : t("copilot.title")} aria-expanded={copilotOpen} onClick={() => { focusCopilotInput.current = !copilotOpen; setCopilotOpen((open) => !open); }} />
              {copilotWaiting && !copilotOpen && <span className="copilot-toggle-dot" data-ui="copilot-attention" aria-hidden="true" />}
            </span>
            {tweaksOpen && (
              <TweaksPopover tweaks={tweaks} set={setTweak} onClose={() => setTweaksOpen(false)} />
            )}
            <div className="win-ctrl">
              <span className="win-b">
                <Icon name="minus" cls="ico-sm" />
              </span>
              <span className="win-b">
                <Icon name="square" cls="ico-sm" />
              </span>
              <span className="win-b close">
                <Icon name="x" cls="ico-sm" />
              </span>
            </div>
          </div>
        </div>

        <ConfigProblemsBanner settings={preferences.settings} onOpenSettings={() => setActiveView(SETTINGS_VIEW)} />
        <PortFallbackBanner />
        <div className="app-body" data-ui="app-workspace">
          <div className="activity" data-ui="primary-navigation">
            {NAV.map((n) => {
              const label = t(n.labelKey);
              // The settings page: the gear at the foot of the rail, selected like the views above it.
              if (n.grp === "foot")
                return (
                  <Fragment key={n.k}>
                    <div className="rail-spacer" />
                    <ActionButton unstyled iconSize="navigation" mode="icon" iconName="settings" label={label} tooltip={label} data-ui="navigate-view" data-ui-key={n.k} className={"nav-icon-action" + (activePane.view === n.k ? " on" : "")} aria-current={activePane.view === n.k ? "page" : undefined} onClick={() => setActiveView(n.k)} />
                  </Fragment>
                );
              const className = "nav-icon-action" + (activePane.view === n.k ? " on" : "");
              // Mail (ticket 05) keeps the approved prototype's lucide icon: a Dazzle icons.json entry for it awaits the user's icon choice.
              if (n.k === "mail") return <MailNavItem key={n.k} label={label} className={className} active={activePane.view === n.k} onClick={() => setActiveView(n.k)} />;
              return <ActionButton key={n.k} unstyled iconSize={n.k === "plan" ? undefined : "navigation"} mode="icon" iconName={n.k === "plan" ? "telescope" : n.k === "library" ? "library" : n.k === "doc" ? "file-text" : "pen-line"} label={label} tooltip={label} data-ui="navigate-view" data-ui-key={n.k} className={className} aria-current={activePane.view === n.k ? "page" : undefined} onClick={() => setActiveView(n.k)} />;
            })}
          </div>

          <div className="main">
            <div className="panes" data-ui="workspace-panes" ref={panesRef}>
              {panes.map((p, i) => (
                <PaneFragment
                  key={p.id}
                  pane={p}
                  index={i}
                  total={panes.length}
                  active={p.id === activeId}
                  multi={multi}
                  onActivate={() => setActiveId(p.id)}
                  onSwitch={(v) => setPaneView(p.id, v)}
                  onSplit={() => splitFrom(p.id)}
                  onClose={() => closePane(p.id)}
                  onDividerDown={(e) => onDividerDown(i, e)}
                  render={() => <PaneHost key={p.view} pane={p} manager={manager} docHost={docHost} />}
                />
              ))}
            </div>
          </div>
          <Copilot open={copilotOpen} context={pageContext} onClose={() => setCopilotOpen(false)} onViewAction={runViewAction} guards={confirmationGuards} onOpenPanel={() => setCopilotOpen(true)} settingsAsked={providerSettingsAsked} viewReady={viewClaimed} onAttention={setCopilotWaiting} />
        </div>

        <CommandPalette
          open={cmdOpen}
          onClose={() => setCmdOpen(false)}
          onNav={(v) => setActiveView(v)}
          onSplit={() => splitFrom(activeId)}
        />
        <SettingsNotices notices={preferences.notices} dismiss={preferences.dismiss} notify={preferences.notify} />
      </div>
    </WorkspaceProvider>
    </PreferencesProvider>
  );
}

/** A page mounted in a pane, with the adapter it reports to (created for this mount, registered while it lasts). */
interface MountedPage {
  adapter: PaneAdapter;
  render: (paneId: number) => React.ReactNode;
}

function mountPage(view: string, changed: () => void, docHost: DocPaneHost): MountedPage {
  switch (view) {
    case "library": {
      const { adapter, props } = createLibraryPane(changed);
      return { adapter, render: (paneId) => <LibraryView paneId={paneId} {...props} /> };
    }
    case "doc": {
      const { adapter, props } = createDocPane(changed, docHost);
      return { adapter, render: (paneId) => <DocPane paneId={paneId} {...props} /> };
    }
    case "mail": {
      const { adapter, props } = createMailPane(changed);
      return { adapter, render: (paneId) => <MailView paneId={paneId} {...props} /> };
    }
    case "write": {
      const { adapter, props } = createWriterPane(changed);
      return { adapter, render: (paneId) => <WriterView paneId={paneId} {...props} /> };
    }
    case SETTINGS_VIEW:
      return { adapter: createSettingsPane().adapter, render: (paneId) => <SettingsView paneId={paneId} /> };
    default: {
      // "plan" and any unknown view: the plan view is the default landing.
      const { adapter, props } = createPlanPane(changed);
      return { adapter, render: (paneId) => <PlanView paneId={paneId} {...props} /> };
    }
  }
}

/** One pane's page: keyed by its view, so a new page gets a new adapter. */
function PaneHost({ pane, manager, docHost }: { pane: Pane; manager: PaneManager; docHost: DocPaneHost }) {
  const [page] = useState(() => mountPage(pane.view, manager.changed, docHost));
  useEffect(() => manager.register(pane.id, page.adapter), [manager, pane.id, page]);
  return page.render(pane.id);
}

function PaneFragment({
  pane,
  index,
  total,
  active,
  multi,
  onActivate,
  onSwitch,
  onSplit,
  onClose,
  onDividerDown,
  render,
}: {
  pane: Pane;
  index: number;
  total: number;
  active: boolean;
  multi: boolean;
  onActivate: () => void;
  onSwitch: (v: string) => void;
  onSplit: () => void;
  onClose: () => void;
  onDividerDown: (e: React.MouseEvent) => void;
  render: () => React.ReactNode;
}) {
  return (
    <>
      <div
        className={"pane" + (multi && active ? " active" : "")}
        data-ui="workspace-pane"
        data-ui-key={pane.id}
        style={{ flexGrow: pane.size, flexBasis: 0 }}
        onMouseDown={onActivate}
      >
        {multi && (
          <PaneHeader
            pane={pane}
            canClose
            canSplit={total < MAX_PANES}
            onSwitch={onSwitch}
            onSplit={onSplit}
            onClose={onClose}
          />
        )}
        <div className="pane-body" data-ui="pane-content">{render()}</div>
      </div>
      {index < total - 1 && (
        <div className="pane-divider" data-ui="resize-pane" onMouseDown={onDividerDown}>
          <span />
        </div>
      )}
    </>
  );
}

function PaneHeader({
  pane,
  onSwitch,
  onSplit,
  onClose,
  canClose,
  canSplit,
}: {
  pane: Pane;
  onSwitch: (v: string) => void;
  onSplit: () => void;
  onClose: () => void;
  canClose: boolean;
  canSplit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation();
  const nav = NAV_MAP[pane.view] || NAV[0];
  useEffect(() => {
    if (!open) return;
    const h = () => setOpen(false);
    window.addEventListener("click", h);
    return () => window.removeEventListener("click", h);
  }, [open]);
  return (
    <div className="pane-head" data-ui="pane-header">
      <div className="pane-tool-wrap" onClick={(e) => e.stopPropagation()}>
        <ActionButton unstyled mode="text" data-ui="choose-pane-view" className="pane-tool" label={t("shell.pane.switchView")} tooltip={t("shell.pane.switchView")} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span>{t(nav.labelKey)}</span>
        </ActionButton>
        {open && (
          <div className="pane-tool-menu view-in" data-ui="pane-view-menu">
            {NAV.map((n) => (
              <ActionButton
                key={n.k}
                unstyled
                mode="text"
                label={t(n.labelKey)}
                tooltip={t(n.labelKey)}
                data-ui="pane-view-option"
                data-ui-key={n.k}
                aria-current={n.k === pane.view ? "page" : undefined}
                className={"pane-tool-opt" + (n.k === pane.view ? " on" : "")}
                onClick={() => {
                  onSwitch(n.k);
                  setOpen(false);
                }}
              >
                <span>{t(n.labelKey)}</span>
              </ActionButton>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: 1 }} />
      {canSplit && (
        <ActionButton unstyled mode="icon" iconName="columns-2" iconSize="small" data-ui="split-pane" className="pane-h-btn" label={t("shell.split")} tooltip={t("shell.split")} onClick={onSplit} />
      )}
      {canClose && (
        <ActionButton unstyled mode="icon" iconName="x" data-ui="close-pane" className="pane-h-btn" label={t("shell.closePane")} tooltip={t("shell.closePane")} onClick={onClose} />
      )}
    </div>
  );
}
