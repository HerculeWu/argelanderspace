import { DiscoverySavedViewActionSchema, APPEARANCE_DENSITIES, APPEARANCE_LANGUAGES, APPEARANCE_THEMES, type CopilotViewAction, MAX_PANES, type PageContext, type WorkspaceViewAction, WorkspaceViewActionSchema } from "@argelanderspace/contracts";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import { fetchPapers } from "../api";
import { parseDocRoute, replaceDocUrl } from "../lib/deeplink";
import { argumentBus, parseArgumentHash } from "../lib/argument-route";
import { exploreBus, parseExploreHash } from "../lib/explore-route";
import { DEFAULT_LANGUAGE } from "../i18n";
import { planResize, resizeDivider, shareOf } from "./layout";
import { createPaneManager, type Pane, type PaneAdapter, type PaneManager, type ViewActionOutcome } from "./panes";
import { ACCENTS, useTweaks } from "./theme";
import { claimViewId, loadViewIdentity, saveViewIdentity } from "./view-identity";
import { applyDocDeletion, confirmWorkspaceLeave, WorkspaceProvider, type Workspace } from "./workspace";
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

interface NavItem {
  k: string;
  ic: string;
  labelKey: "shell.nav.plan" | "shell.nav.library" | "shell.nav.doc" | "shell.nav.write" | "shell.nav.mail";
  grp: "core";
}

const NAV: NavItem[] = [
  { k: "plan", ic: "telescope", labelKey: "shell.nav.plan", grp: "core" },
  { k: "library", ic: "library", labelKey: "shell.nav.library", grp: "core" },
  { k: "doc", ic: "file-text", labelKey: "shell.nav.doc", grp: "core" },
  { k: "write", ic: "pen-line", labelKey: "shell.nav.write", grp: "core" },
  { k: "mail", ic: "mail", labelKey: "shell.nav.mail", grp: "core" },
];
const NAV_MAP: Record<string, NavItem> = Object.fromEntries(NAV.map((n) => [n.k, n]));

/** The pane the Shell starts with. */
const INITIAL_PANE_ID = 1;
const noChange = () => {};

export function Shell() {
  const { t } = useTranslation();
  const [tweaks, setTweak] = useTweaks();
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
      pages: [createPlanPane(noChange).adapter, createLibraryPane(noChange).adapter, createDocPane(noChange, docHost).adapter, createWriterPane(noChange).adapter, createMailPane(noChange).adapter],
      confirmLeave: confirmWorkspaceLeave,
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
        manager.update((ps) =>
          ps.some((p) => p.view === "library")
            ? ps
            : ps.map((p) => (p.id === INITIAL_PANE_ID ? { ...p, view: "library" } : p))
        );
        exploreBus.request(exploreSeed);
        return;
      }
      // Argument graph ticket 04: a boot `#argument/<work id>` hash opens the library pane the same way
      const argumentWork = parseArgumentHash(window.location.hash);
      if (argumentWork) {
        manager.update((ps) =>
          ps.some((p) => p.view === "library")
            ? ps
            : ps.map((p) => (p.id === INITIAL_PANE_ID ? { ...p, view: "library" } : p))
        );
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
    (docId?: string, anchor?: string | null): boolean => {
      const nextDoc = docId ?? currentDocRef.current ?? papers[0] ?? null;
      if (nextDoc !== currentDocRef.current && !confirmWorkspaceLeave()) {
        if (currentDocRef.current) replaceDocUrl(currentDocRef.current);
        return false;
      }
      currentDocRef.current = nextDoc;
      setCurrentDocState(nextDoc);
      if (docId) {
        replaceDocUrl(docId, anchor);
        setPendingAnchor(anchor ?? null);
      }
      // ensure a pane shows the document: prefer an existing doc pane, else the active one
      manager.update((ps) => {
        if (ps.some((p) => p.view === "doc")) return ps;
        const active = manager.getState().activeId;
        return ps.map((p) => (p.id === active ? { ...p, view: "doc" } : p));
      });
      return true;
    },
    [manager, papers]
  );

  // deep links: react to browser back/forward and manual hash edits
  const openDocRef = useRef(openDoc);
  openDocRef.current = openDoc;
  useEffect(() => {
    const onNav = () => {
      const route = parseDocRoute(window.location.pathname, window.location.hash);
      if (route) {
        openDocRef.current(route.docId, route.anchor);
        return;
      }
      // Stage 14: `#explore/<bibcode>` drives the discovery mode; losing the
      // explore hash exits explore mode (the session stays resumable)
      const seed = parseExploreHash(window.location.hash);
      const argumentWork = parseArgumentHash(window.location.hash);
      if (seed) exploreBus.request(seed);
      else exploreBus.exit();
      // `#argument/<work id>` drives the argument graph view; losing the hash leaves it
      if (argumentWork) argumentBus.request(argumentWork);
      else argumentBus.exit();
    };
    window.addEventListener("popstate", onNav);
    window.addEventListener("hashchange", onNav);
    return () => {
      window.removeEventListener("popstate", onNav);
      window.removeEventListener("hashchange", onNav);
    };
  }, []);

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
        const applied = action.paneId === undefined ? s().setActiveView(action.view) : s().setPaneView(id, action.view);
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
        if (!s().closePane(action.paneId)) return { ok: false, detail: "leave_blocked" };
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
        if (theme) s().setTweak("theme", theme);
        if (accent) s().setTweak("accent", accent);
        if (density) s().setTweak("density", density);
        if (language) s().setTweak("language", language);
        const done = () => (!theme || s().tweaks.theme === theme) && (!accent || s().tweaks.accent === accent) && (!density || s().tweaks.density === density) && (!language || s().tweaks.language === language);
        return (await settle(done)) ? { ok: true } : { ok: false, detail: "unavailable" };
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
    if (shell.current.openDoc(docId) === false) return { ok: false, detail: "leave_blocked" };
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
      const library = manager.getState().panes.find((p) => p.view === "library");
      if (library) manager.select(library.id);
      else if (!manager.setActiveView("library")) return;
      argumentBus.request(workId, { push: true });
    },
    [manager]
  );
  const workspace: Workspace = useMemo(
    () => ({ papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, docDeleted, openArgumentGraph, tweaks }),
    [papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, docDeleted, openArgumentGraph, tweaks]
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

        <div className="app-body" data-ui="app-workspace">
          <div className="activity" data-ui="primary-navigation">
            {NAV.map((n) => {
              const label = t(n.labelKey);
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
          <Copilot open={copilotOpen} context={pageContext} onClose={() => setCopilotOpen(false)} onViewAction={runViewAction} guards={confirmationGuards} onOpenPanel={() => setCopilotOpen(true)} viewReady={viewClaimed} onAttention={setCopilotWaiting} />
        </div>

        <CommandPalette
          open={cmdOpen}
          onClose={() => setCmdOpen(false)}
          onNav={(v) => setActiveView(v)}
          onSplit={() => splitFrom(activeId)}
        />
      </div>
    </WorkspaceProvider>
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
