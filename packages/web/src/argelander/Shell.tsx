import { type DiscoveryPage, DiscoverySavedViewActionSchema, discoveryActionNeedsExploration, APPEARANCE_DENSITIES, APPEARANCE_LANGUAGES, APPEARANCE_THEMES, type CopilotViewAction, type LibraryPage, type LibraryViewAction, LibraryViewActionSchema, MAX_PANES, type PageContext, type PdfPage, type TextSourcePage, type PlanPage, type PlanViewAction, type ReaderPage, type ReaderViewAction, ReaderViewActionSchema, type WorkspaceViewAction, WorkspaceViewActionSchema, type WriterPage, type WriterViewAction, WriterViewActionSchema } from "@argelanderspace/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import { fetchPapers } from "../api";
import { parseDocRoute, replaceDocUrl } from "../lib/deeplink";
import { exploreBus, parseExploreHash } from "../lib/explore-route";
import { DEFAULT_LANGUAGE } from "../i18n";
import { planResize, resizeDivider, shareOf } from "./layout";
import { ACCENTS, useTweaks } from "./theme";
import { claimViewId, loadViewIdentity, saveViewIdentity } from "./view-identity";
import { applyDocDeletion, confirmWorkspaceLeave, WorkspaceProvider, type Workspace } from "./workspace";
import { CommandPalette } from "./CommandPalette";
import { TweaksPopover } from "./TweaksPopover";
import { DocPane } from "../doc/DocPane";
import type { ReaderViewController } from "../doc/reader-bridge";
import { LibraryView, type LibraryViewController } from "../library/LibraryView";
import { PlanView, type PlanViewController } from "../plan/PlanView";
import type { WriterViewController } from "../writer/WriterView";
import { manuscriptDeleteGuard, writerPageStatus } from "../writer/writer-context";
import { WriterView } from "../writer/WriterView";
import { Copilot } from "../copilot/Copilot";

interface NavItem {
  k: string;
  ic: string;
  labelKey: "shell.nav.plan" | "shell.nav.library" | "shell.nav.doc" | "shell.nav.write" | "shell.nav.ext";
  grp: "core" | "ext";
  stub?: boolean;
}

const NAV: NavItem[] = [
  { k: "plan", ic: "telescope", labelKey: "shell.nav.plan", grp: "core" },
  { k: "library", ic: "library", labelKey: "shell.nav.library", grp: "core" },
  { k: "doc", ic: "file-text", labelKey: "shell.nav.doc", grp: "core" },
  { k: "write", ic: "pen-line", labelKey: "shell.nav.write", grp: "core" },
];
const NAV_MARKET: NavItem = { k: "ext", ic: "blocks", labelKey: "shell.nav.ext", grp: "ext", stub: true };
const NAV_MAP: Record<string, NavItem> = Object.fromEntries(
  [...NAV, NAV_MARKET].map((n) => [n.k, n])
);

interface Pane {
  id: number;
  view: string;
  size: number;
}


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
  const [planPages, setPlanPages] = useState<Record<number, PlanPage | null>>({});
  const reportPlan = useCallback((paneId: number, page: PlanPage | null) => { setPlanPages((previous) => ({ ...previous, [paneId]: page })); }, []);
  const [libraryPages, setLibraryPages] = useState<Record<number, LibraryPage | null>>({});
  const reportLibrary = useCallback((paneId: number, page: LibraryPage | null) => { setLibraryPages((previous) => (previous[paneId] === page ? previous : { ...previous, [paneId]: page })); }, []);
  // The exploration of a Library pane (Discovery): while a pane explores, this page replaces its Library page for the Copilot.
  const [discoveryPages, setDiscoveryPages] = useState<Record<number, DiscoveryPage | null>>({});
  const reportDiscovery = useCallback((paneId: number, page: DiscoveryPage | null) => { setDiscoveryPages((previous) => (previous[paneId] === page ? previous : { ...previous, [paneId]: page })); }, []);
  const discoveryPagesRef = useRef(discoveryPages);
  discoveryPagesRef.current = discoveryPages;
  // The Reader of each Doc pane: the page it reports (built from its admitted epoch) and its own controllers.
  const [readerPages, setReaderPages] = useState<Record<number, ReaderPage | null>>({});
  const reportReader = useCallback((paneId: number, page: ReaderPage | null) => { setReaderPages((previous) => (previous[paneId] === page ? previous : { ...previous, [paneId]: page })); }, []);
  // The PDF Reader of each Doc pane (copilot ticket 20): identity, position and control state; the pages' content is the service's.
  // A text Doc's source panel (copilot ticket 29): the editor's current text, assets, diagnostics and revisions.
  const [textPages, setTextPages] = useState<Record<number, TextSourcePage | null>>({});
  const reportText = useCallback((paneId: number, page: TextSourcePage | null) => { setTextPages((previous) => (previous[paneId] === page ? previous : { ...previous, [paneId]: page })); }, []);
  const [pdfPages, setPdfPages] = useState<Record<number, PdfPage | null>>({});
  const reportPdf = useCallback((paneId: number, page: PdfPage | null) => { setPdfPages((previous) => (previous[paneId] === page ? previous : { ...previous, [paneId]: page })); }, []);
  // The Writer of each Write pane (copilot ticket 22): its page (list or open manuscript with saved content and unsaved draft) and its controller.
  const [writerPages, setWriterPages] = useState<Record<number, WriterPage | null>>({});
  const reportWriter = useCallback((paneId: number, page: WriterPage | null) => { setWriterPages((previous) => (previous[paneId] === page ? previous : { ...previous, [paneId]: page })); }, []);
  const writerPagesRef = useRef(writerPages);
  writerPagesRef.current = writerPages;
  // Approving a manuscript delete would discard unsaved edits of an open editor (or its Info/Preamble dialog): ask first.
  const beforeManuscriptDelete = useCallback((manuscriptId: string) => {
    return manuscriptDeleteGuard(Object.values(writerPagesRef.current), manuscriptId, () => window.confirm(t("copilot.confirmation.manuscriptDraftGuard")));
  }, [t]);
  const writerControllers = useRef(new Map<number, WriterViewController>());
  const registerWriterController = useCallback((paneId: number, controller: WriterViewController | null) => {
    if (controller) writerControllers.current.set(paneId, controller); else writerControllers.current.delete(paneId);
  }, []);
  const readerControllers = useRef(new Map<number, ReaderViewController>());
  const registerReaderController = useCallback((paneId: number, controller: ReaderViewController | null) => {
    if (controller) readerControllers.current.set(paneId, controller); else readerControllers.current.delete(paneId);
  }, []);
  const libraryControllers = useRef(new Map<number, LibraryViewController>());
  const registerLibraryController = useCallback((paneId: number, controller: LibraryViewController | null) => {
    if (controller) libraryControllers.current.set(paneId, controller); else libraryControllers.current.delete(paneId);
  }, []);
  const planControllers = useRef(new Map<number, PlanViewController>());
  const registerPlanController = useCallback((paneId: number, controller: PlanViewController | null) => {
    if (controller) planControllers.current.set(paneId, controller); else planControllers.current.delete(paneId);
  }, []);

  const [papers, setPapers] = useState<string[]>([]);
  const [currentDoc, setCurrentDocState] = useState<string | null>(null);
  const currentDocRef = useRef(currentDoc);
  currentDocRef.current = currentDoc;
  const [pendingAnchor, setPendingAnchor] = useState<string | null>(null);
  const clearPendingAnchor = useCallback(() => setPendingAnchor(null), []);

  const [panes, setPanes] = useState<Pane[]>([{ id: 1, view: "plan", size: 1 }]);
  const [activeId, setActiveId] = useState(1);
  const nextId = useRef(2);
  const panesRef = useRef<HTMLDivElement>(null);
  const multi = panes.length > 1;
  const activePane = panes.find((p) => p.id === activeId) || panes[0];

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
        setPanes((ps) =>
          ps.some((p) => p.view === "library")
            ? ps
            : ps.map((p) => (p.id === activeId ? { ...p, view: "library" } : p))
        );
        exploreBus.request(exploreSeed);
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

  // These return whether the change was made: the leave-draft protection can refuse it, and a Copilot
  // request must then say so instead of claiming the page changed.
  const setActiveView = useCallback(
    (view: string): boolean => {
      const currentPane = panes.find((pane) => pane.id === activeId);
      if (currentPane?.view === "doc" && view !== "doc" && !confirmWorkspaceLeave()) return false;
      setPanes((ps) => ps.map((p) => (p.id === activeId ? { ...p, view } : p)));
      return true;
    },
    [activeId, panes]
  );
  const setPaneView = (id: number, view: string): boolean => {
    const currentPane = panes.find((pane) => pane.id === id);
    if (currentPane?.view === "doc" && view !== "doc" && !confirmWorkspaceLeave()) return false;
    setPanes((ps) => ps.map((p) => (p.id === id ? { ...p, view } : p)));
    setActiveId(id);
    return true;
  };

  // Copilot-requested navigation: runs on the visible Plan page, or opens one first. Background edits
  // never come through here.
  const viewActionState = useRef({ panes, activeId, setPaneView });
  viewActionState.current = { panes, activeId, setPaneView };
  const runPlanViewAction = useCallback(async (action: PlanViewAction): Promise<{ ok: boolean; detail?: "not_found" | "unavailable" | "leave_blocked" | "disabled" | "failed" | "cancelled"; http?: number }> => {
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const state = viewActionState.current;
    const active = state.panes.find((pane) => pane.id === state.activeId) ?? state.panes[0];
    // An action that only a mounted list can do must not first take the user to the Plan page and then fail.
    if (action.action === "set_completed") {
      const candidates = [active, ...state.panes].filter((pane) => pane.view === "plan");
      if (!candidates.some((pane) => planControllers.current.get(pane.id)?.available(action))) return { ok: false, detail: "unavailable" };
    }
    let pane = active.view === "plan" ? active : state.panes.find((candidate) => candidate.view === "plan");
    if (action.action === "set_completed")
      pane = [active, ...state.panes].find((candidate) => candidate.view === "plan" && planControllers.current.get(candidate.id)?.available(action)) ?? pane;
    if (!pane) {
      state.setPaneView(active.id, "plan");
      for (let attempt = 0; attempt < 40 && !planControllers.current.has(active.id); attempt++) await wait(50);
      if (!planControllers.current.has(active.id))
        return { ok: false, detail: viewActionState.current.panes.find((candidate) => candidate.id === active.id)?.view === "doc" ? "leave_blocked" : "unavailable" };
      pane = active;
    } else if (pane.id !== state.activeId) setActiveId(pane.id);
    for (let attempt = 0; attempt < 40; attempt++) {
      const controller = planControllers.current.get(pane.id);
      const result = controller ? await controller.apply(action) : { ok: false, detail: "unavailable" as const };
      if (result.detail !== "unavailable") return result;
      await wait(50);
    }
    return { ok: false, detail: "unavailable" };
  }, []);

  // Copilot-requested Library navigation: runs on the visible Library page, or opens one first. Background
  // reads and edits never come through here.
  const runLibraryViewAction = useCallback(async (action: LibraryViewAction): Promise<{ ok: boolean; detail?: "not_found" | "unavailable" | "leave_blocked" | "disabled" | "failed" | "cancelled"; http?: number }> => {
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const state = viewActionState.current;
    const active = state.panes.find((pane) => pane.id === state.activeId) ?? state.panes[0];
    // An exploration control acts on the pane the Copilot was shown: the ACTIVE pane, when it is a Library pane that
    // explores (its page is the published context and the one `save_candidate` checks). It never opens a Library page,
    // switches pane or reaches into another pane. Every other Library action, and the two entry actions (the work's
    // explore button, resume), open or use a Library page as before.
    const isDiscoveryControl = discoveryActionNeedsExploration(action);
    if (isDiscoveryControl && !(active.view === "library" && discoveryPagesRef.current[active.id])) return { ok: false, detail: "unavailable" };
    let pane = isDiscoveryControl || active.view === "library" ? active : state.panes.find((candidate) => candidate.view === "library");
    if (!pane) {
      if (state.setPaneView(active.id, "library") === false) return { ok: false, detail: "leave_blocked" };
      pane = active;
    } else if (pane.id !== state.activeId) setActiveId(pane.id);
    for (let attempt = 0; attempt < 40; attempt++) {
      const controller = libraryControllers.current.get(pane.id);
      const result = controller ? await controller.apply(action) : { ok: false, detail: "unavailable" as const };
      if (result.detail !== "unavailable") return result;
      await wait(50);
    }
    return { ok: false, detail: "unavailable" };
  }, []);

  const splitFrom = useCallback(
    (id: number) => {
      setPanes((ps) => {
        if (ps.length >= MAX_PANES) return ps;
        const src = ps.find((p) => p.id === id) || ps[0];
        const nid = nextId.current++;
        const i = ps.findIndex((p) => p.id === id);
        const copy = ps.map((p) => ({ ...p, size: 1 }));
        copy.splice(i + 1, 0, { id: nid, view: src.view, size: 1 });
        setActiveId(nid);
        return copy;
      });
    },
    []
  );

  const closePane = (id: number): boolean => {
    const currentPane = panes.find((pane) => pane.id === id);
    if (currentPane?.view === "doc" && !confirmWorkspaceLeave()) return false;
    setPanes((ps) => {
      if (ps.length <= 1) return ps;
      const filtered = ps.filter((p) => p.id !== id).map((p) => ({ ...p, size: 1 }));
      if (id === activeId) setActiveId(filtered[0].id);
      return filtered;
    });
    return true;
  };

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
      setPanes((ps) => {
        if (ps.some((p) => p.view === "doc")) return ps;
        return ps.map((p) => (p.id === activeId ? { ...p, view: "doc" } : p));
      });
      return true;
    },
    [activeId, papers]
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
      if (seed) exploreBus.request(seed);
      else exploreBus.exit();
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
  const shell = useRef({ panes, activeId, setActiveView, setPaneView, splitFrom, closePane, setTweak, tweaks, papers, setPapers, openDoc, copilotOpen });
  shell.current = { panes, activeId, setActiveView, setPaneView, splitFrom, closePane, setTweak, tweaks, papers, setPapers, openDoc, copilotOpen };
  type Report = { ok: boolean; detail?: "not_found" | "unavailable" | "leave_blocked" | "disabled" | "failed" | "cancelled"; http?: number; folded?: "outline" | "right" };
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
        setPanes((ps) => (ps.length === sizes.length ? ps.map((pane, i) => ({ ...pane, size: sizes[i] ?? pane.size })) : ps));
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
  const openTaskDoc = openLibraryDoc;
  // Copilot-requested Reader navigation. The Doc is named; if it is not the one open it is opened first by the
  // Shell's own openDoc (leave-draft protection included). The action then runs on the ACTIVE pane when that is a
  // Doc pane (the pane whose page the Copilot was shown), else on the first Doc pane, through that Reader's own
  // controllers; a Reader that is still loading or syncing answers `unavailable` and is given the UI's own two
  // seconds (longer after opening a Doc, which has to load first). Background reads never come through here.
  const runReaderViewAction = useCallback(async (action: ReaderViewAction): Promise<Report> => {
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const opened = currentDocRef.current === action.docId && shell.current.panes.some((pane) => pane.view === "doc");
    if (!opened) {
      // Retry has nothing to retry on a Doc that is not open: opening it is the user's open button, not a retry.
      if (action.action === "retry_sync") return { ok: false, detail: "unavailable" };
      const result = await openLibraryDoc(action.docId);
      if (!result.ok) return result;
    }
    let attempts = opened ? 40 : 100;
    for (; attempts > 0; attempts--) {
      const { panes, activeId } = shell.current;
      const active = panes.find((pane) => pane.id === activeId) ?? panes[0];
      const pane = active?.view === "doc" ? active : panes.find((candidate) => candidate.view === "doc");
      const controller = pane ? readerControllers.current.get(pane.id) : undefined;
      if (pane && controller) {
        if (pane.id !== shell.current.activeId) setActiveId(pane.id);
        const result = await controller.apply(action);
        if (result.detail !== "unavailable") return result;
      }
      await wait(50);
    }
    return { ok: false, detail: "unavailable" };
  }, [openLibraryDoc]);
  // Copilot-requested Writer navigation: runs on the active Write pane (the page the Copilot was shown), else the first
  // one, else the active pane is switched to the Writer first (the activity-bar button, with its leave protection).
  const runWriterViewAction = useCallback(async (action: WriterViewAction): Promise<Report> => {
    const wait = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const { panes: current, activeId: activeNow } = shell.current;
    const active = current.find((pane) => pane.id === activeNow) ?? current[0];
    let pane = active?.view === "write" ? active : current.find((candidate) => candidate.view === "write");
    if (!pane) {
      if (action.action === "close_manuscript") return { ok: true };
      if (!active || shell.current.setPaneView(active.id, "write") === false) return { ok: false, detail: "leave_blocked" };
      for (let attempt = 0; attempt < 40 && !writerControllers.current.has(active.id); attempt++) await wait(50);
      if (!writerControllers.current.has(active.id)) return { ok: false, detail: "unavailable" };
      pane = active;
    } else if (pane.id !== shell.current.activeId) setActiveId(pane.id);
    const controller = writerControllers.current.get(pane.id);
    return controller ? controller.apply(action) : { ok: false, detail: "unavailable" };
  }, []);
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
      for (const controller of libraryControllers.current.values()) void controller.apply(saved.data);
      return { ok: true };
    }
    const workspaceAction = WorkspaceViewActionSchema.safeParse(action);
    if (workspaceAction.success) return runWorkspaceAction(workspaceAction.data);
    if (action.action === "open_task_doc") return openTaskDoc(action.docId);
    const readerAction = ReaderViewActionSchema.safeParse(action);
    if (readerAction.success) return runReaderViewAction(readerAction.data);
    const writerAction = WriterViewActionSchema.safeParse(action);
    if (writerAction.success) return runWriterViewAction(writerAction.data);
    const libraryAction = LibraryViewActionSchema.safeParse(action);
    if (libraryAction.success) return runLibraryViewAction(libraryAction.data);
    return runPlanViewAction(action as PlanViewAction);
  }, [runPlanViewAction, runWorkspaceAction, openTaskDoc, runLibraryViewAction, runReaderViewAction, runWriterViewAction]);

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
      setPanes((ps) => ps.map((p, idx) => ({ ...p, size: sizes[idx] ?? p.size })));
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

  const workspace: Workspace = useMemo(
    () => ({ papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, docDeleted, tweaks }),
    [papers, currentDoc, setCurrentDoc, openDoc, pendingAnchor, clearPendingAnchor, docDeleted, tweaks]
  );

  const pageContext = useMemo<PageContext>(() => ({
    version: 1, viewId, revision: ++revision.current, paneId: activePane.id, view: activePane.view,
    otherPanes: panes.filter((pane) => pane.id !== activePane.id).map((pane) => ({ paneId: pane.id, view: pane.view })),
    // Example data (or a Library still loading / replaced by Discovery) is never reported as complete.
    status: activePane.view === "plan" ? planPages[activePane.id] ? "complete" : "error"
      : activePane.view === "library" && discoveryPages[activePane.id] ? (discoveryPages[activePane.id]?.graph ? "complete" : discoveryPages[activePane.id]?.error ? "error" : "unavailable")
      : activePane.view === "library" ? (libraryPages[activePane.id]?.source === "live" ? "complete" : libraryPages[activePane.id]?.source === "error" ? "error" : "unavailable")
      // A Reader is complete only with the reading of an admitted epoch; updating is unavailable, a failed read is an error.
      : activePane.view === "doc" && pdfPages[activePane.id] ? (pdfPages[activePane.id]?.phase === "ready" ? "complete" : ["error", "changed"].includes(pdfPages[activePane.id]?.phase ?? "") ? "error" : "unavailable")
      : activePane.view === "doc" && textPages[activePane.id] ? (textPages[activePane.id]?.phase === "ready" ? "complete" : textPages[activePane.id]?.phase === "error" ? "error" : "unavailable")
      : activePane.view === "doc" ? (readerPages[activePane.id]?.reading ? "complete" : ["error", "missing"].includes(readerPages[activePane.id]?.sync.phase ?? "") ? "error" : "unavailable")
      : activePane.view === "write" ? writerPageStatus(writerPages[activePane.id])
      : "unavailable",
    plan: activePane.view === "plan" ? planPages[activePane.id] ?? null : null,
    library: activePane.view === "library" && !discoveryPages[activePane.id] ? libraryPages[activePane.id] ?? null : null,
    discovery: activePane.view === "library" ? discoveryPages[activePane.id] ?? null : null,
    // The Reader of the ACTIVE pane: the page the user is working in, and the one navigation acts on.
    reader: activePane.view === "doc" ? readerPages[activePane.id] ?? null : null,
    pdf: activePane.view === "doc" ? pdfPages[activePane.id] ?? null : null,
    textSource: activePane.view === "doc" ? textPages[activePane.id] ?? null : null,
    // The Writer of the ACTIVE pane: the list or the open manuscript (saved content, and the draft apart from it).
    writer: activePane.view === "write" ? writerPages[activePane.id] ?? null : null,
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
  }), [viewId, activePane.id, activePane.view, panes, planPages, libraryPages, discoveryPages, readerPages, pdfPages, textPages, writerPages, tweaks, copilotOpen]);
  useEffect(() => { saveViewIdentity({ viewId, revision: pageContext.revision }); }, [viewId, pageContext]);

  const renderView = (p: Pane) => {
    switch (p.view) {
      case "plan":
        return <PlanView paneId={p.id} onContext={reportPlan} onController={registerPlanController} />;
      case "library":
        return <LibraryView paneId={p.id} onContext={reportLibrary} onDiscovery={reportDiscovery} onController={registerLibraryController} />;
      case "doc":
        return <DocPane paneId={p.id} onContext={reportReader} onPdfContext={reportPdf} onTextContext={reportText} onController={registerReaderController} />;
      case "write":
        return <WriterView paneId={p.id} onContext={reportWriter} onController={registerWriterController} />;
      default:
        return <StubPane nav={NAV_MAP[p.view] || NAV[0]} />;
    }
  };

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
              return <ActionButton key={n.k} unstyled iconSize={n.k === "plan" ? undefined : "navigation"} mode="icon" iconName={n.k === "plan" ? "telescope" : n.k === "library" ? "library" : n.k === "doc" ? "file-text" : "pen-line"} label={label} tooltip={label} data-ui="navigate-view" data-ui-key={n.k} className={className} aria-current={activePane.view === n.k ? "page" : undefined} onClick={() => setActiveView(n.k)} />;
            })}
            <div style={{ flex: 1 }} />
            <ActionButton unstyled mode="icon" iconName="blocks" label={t("shell.nav.extMarket")} tooltip={t("shell.nav.extMarket")} data-ui="navigate-extensions" className={"nav-icon-action" + (activePane.view === "ext" ? " on" : "")} aria-current={activePane.view === "ext" ? "page" : undefined} onClick={() => setActiveView("ext")} />
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
                  render={() => renderView(p)}
                />
              ))}
            </div>
          </div>
          <Copilot open={copilotOpen} context={pageContext} onClose={() => setCopilotOpen(false)} onViewAction={runViewAction} onBeforeDocDelete={(docId) => docId !== currentDocRef.current || confirmWorkspaceLeave()} onBeforeManuscriptDelete={beforeManuscriptDelete} onOpenPanel={() => setCopilotOpen(true)} viewReady={viewClaimed} onAttention={setCopilotWaiting} />
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

function StubPane({ nav }: { nav: NavItem }) {
  const { t } = useTranslation();
  return (
    <div className="stub-pane" data-ui="unavailable-view">
      <div className="stub-ic">
        <Icon name={nav.ic} cls="ico-lg" />
      </div>
      <div className="stub-title">{t(nav.labelKey)}</div>
      <div className="stub-sub">
        {t("shell.stub.desc", { view: t(nav.labelKey) })}
      </div>
    </div>
  );
}
