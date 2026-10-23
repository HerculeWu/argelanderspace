import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ArgumentViewAction, type CopilotViewActionResult, type DiscoveryPage, type DiscoverySavedViewAction, type DiscoveryViewAction, isArgumentViewAction, isDiscoveryViewAction, type LibraryDetailTab, type LibraryPage, type LibraryViewAction, libraryRefMatches } from "@argelanderspace/contracts";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import { askWorkspaceLeave, useWorkspace, type Workspace, whenWorkspaceMayLeave } from "../argelander/workspace";
import { fetchLibrary, type LibraryLoad } from "../api/library";
import { onLibraryChanged } from "../api/ws";
import { LibraryGraph } from "./LibraryGraph";
import { useElementWidth } from "../doc/auto-fold";
import { libraryAutoFold } from "./layout";
import type { GraphCanvasController } from "../graph/GraphCanvas";
import { RefDetail } from "./RefDetail";
import { captureLibraryPage } from "../copilot/library-context";
import { ImportDialog, type ImportMode } from "./ImportDialog";
import { type ExploreControl, ExploreMode } from "./ExploreMode";
import { exploreReport, useExploreStack } from "./explore-state";
import { exploreBus } from "../lib/explore-route";
import { argumentBus, clearArgumentUrl, pushArgumentUrl } from "../lib/argument-route";
import { ArgumentGraphMode, type ArgumentModeControl } from "../argument/ArgumentGraphMode";
import type { ArgumentPage } from "../argument/page";
import type { LibraryData, LibraryRef } from "./types";
import { useShelfAvailable } from "../shelf/availability";
import { ShelfDialog } from "../shelf/ShelfDialog";

// color labels users assign by right-clicking a reference (replaces the star)
const LABEL_COLORS = [
  { k: "red", c: "oklch(0.70 0.16 25)" },
  { k: "amber", c: "oklch(0.80 0.13 78)" },
  { k: "green", c: "oklch(0.74 0.13 158)" },
  { k: "blue", c: "oklch(0.70 0.12 235)" },
  { k: "violet", c: "oklch(0.70 0.13 292)" },
];
const LABEL_HEX: Record<string, string> = Object.fromEntries(LABEL_COLORS.map((l) => [l.k, l.c]));

// Label display names resolve at render time; keys must stay in sync with
// LABEL_COLORS above (an explicit typed mapping — no key concatenation).
const LABEL_NAME_KEYS = {
  red: "library.labels.red",
  amber: "library.labels.amber",
  green: "library.labels.green",
  blue: "library.labels.blue",
  violet: "library.labels.violet",
} as const;

/** Label key (or an already-CSS color value) → the dot's CSS color. */
export function labelColor(lab: string): string {
  return LABEL_HEX[lab] ?? lab;
}

/**
 * The dot's effective label: the session-local overlay (right-click menu)
 * wins; otherwise the persisted `label` field; unset refs keep the
 * star→amber seeding. Overlay `null` = explicitly cleared.
 */
export function effectiveLabel(
  r: LibraryRef,
  overlay: Record<string, string | null>
): string | undefined {
  return r.id in overlay ? (overlay[r.id] ?? undefined) : (r.label ?? (r.star ? "amber" : undefined));
}

const IMPORTS = [
  { mode: "identifier", ic: "hash", titleKey: "library.import.identifier.title", descKey: "library.import.identifier.desc" },
  { mode: "bibcode", ic: "telescope", titleKey: "library.import.bibcode.title", descKey: "library.import.bibcode.desc" },
  { mode: "bib", ic: "file-code-2", titleKey: "library.import.bibtex.title", descKey: "library.import.bibtex.desc" },
] as const;

/** What the Shell can ask the visible Library page to do for a Copilot view action. */
export interface LibraryViewController {
  /** `DiscoverySavedViewAction` is the service's own state sync after it saved a candidate (never a tool action). */
  apply: (action: LibraryViewAction | DiscoverySavedViewAction | ArgumentViewAction) => Promise<Pick<CopilotViewActionResult, "ok" | "detail" | "http">>;
}
export function LibraryView({
  paneId,
  onContext,
  onDiscovery,
  onArgument,
  onController,
}: {
  paneId?: number;
  onContext?: (paneId: number, page: LibraryPage | null) => void;
  /** The exploration page while this tab explores (null otherwise); replaces the Library page for the Copilot then. */
  onDiscovery?: (paneId: number, page: DiscoveryPage | null) => void;
  /** The argument graph page while this tab shows one (null otherwise). */
  onArgument?: (paneId: number, page: ArgumentPage | null) => void;
  onController?: (paneId: number, controller: LibraryViewController | null) => void;
} = {}) {
  const ws = useWorkspace();
  const { t } = useTranslation();
  const [payload, setPayload] = useState<LibraryData | null>(null);
  const [live, setLive] = useState(false);
  const [failure, setFailure] = useState<LibraryLoad["failure"]>(undefined);

  const reload = useCallback(async () => {
    const { data, live, failure } = await fetchLibrary();
    setPayload(data);
    setLive(live);
    setFailure(failure);
    return { data, live };
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // live-refresh on server-side library mutations (refresh / patch / add /
  // upload-done) pushed over /ws
  useEffect(() => onLibraryChanged(() => void reload()), [reload]);

  useEffect(() => {
    // Still loading: there is no page to describe yet.
    if (!payload && paneId !== undefined) onContext?.(paneId, null);
  }, [payload, paneId, onContext]);

  if (!payload) {
    return (
      <div className="cg-loading" style={{ position: "relative", height: "100%" }}>
        <div className="cg-spinner" />
        <div className="cg-loading-t">{t("library.loading")}</div>
      </div>
    );
  }
  return (
    <LibraryBody
      payload={payload}
      live={live}
      failure={failure}
      onOpenDoc={ws.openDoc}
      onReload={() => void reload()}
      onRefetch={reload}
      paneId={paneId}
      onContext={onContext}
      onDiscovery={onDiscovery}
      onArgument={onArgument}
      onController={onController}
      onDocDeleted={ws.docDeleted}
      onBeforeDocDelete={(docId) => docId !== ws.currentDoc || askWorkspaceLeave()}
      selectionMemory={ws.librarySelection}
    />
  );
}

function LibraryBody({
  payload,
  live,
  failure,
  onOpenDoc,
  onReload,
  onRefetch,
  paneId,
  onContext,
  onDiscovery,
  onArgument,
  onController,
  onDocDeleted,
  onBeforeDocDelete,
  selectionMemory,
}: {
  payload: LibraryData;
  live: boolean;
  failure?: LibraryLoad["failure"];
  onOpenDoc: (docId?: string, anchor?: string | null) => void;
  onReload: () => void;
  /** Read the library again and hand back what was read (an id the page does not know yet gets one reload). */
  onRefetch: () => Promise<{ data: LibraryData; live: boolean }>;
  paneId?: number;
  onContext?: (paneId: number, page: LibraryPage | null) => void;
  onDiscovery?: (paneId: number, page: DiscoveryPage | null) => void;
  onArgument?: (paneId: number, page: ArgumentPage | null) => void;
  onController?: (paneId: number, controller: LibraryViewController | null) => void;
  /** Stage 8 §8: forwarded to RefDetail — the workspace three-state transition
   *  after a document is physically deleted. */
  onDocDeleted: (docId: string, remaining: string[]) => void;
  onBeforeDocDelete: (docId: string) => boolean | Promise<boolean>;
  /** The workspace's memory of this pane's selected Work, for when a Doc pane has replaced the page and Back brings it back. */
  selectionMemory?: Workspace["librarySelection"];
}) {
  const { refs, graph } = payload;
  const { t } = useTranslation();
  const byId = useMemo(() => Object.fromEntries(graph.nodes.map((n) => [n.id, n])), [graph]);
  const refToNode = useMemo(() => {
    const m: Record<string, string> = {};
    graph.nodes.forEach((n) => {
      if (n.ref) m[n.ref] = n.id;
    });
    return m;
  }, [graph]);

  const refToNodeRef = useRef(refToNode);
  refToNodeRef.current = refToNode;
  const [selNode, setSelNode] = useState<string | null>(() => {
    const remembered = paneId === undefined ? undefined : selectionMemory?.get(paneId);
    if (remembered === null || (remembered !== undefined && byId[remembered])) return remembered;
    return graph.nodes.find((n) => n.ref)?.id ?? null;
  });
  useEffect(() => {
    if (paneId !== undefined) selectionMemory?.set(paneId, selNode);
  }, [paneId, selectionMemory, selNode]);
  const [q, setQ] = useState("");
  const [sideCollapsed, setSideCollapsed] = useState(false);

  // ---- Stage 14: ADS Discovery (explore) mode ---------------------------- //
  const explore = useExploreStack();
  // the hash navigation bus (`#explore/<bibcode>`): this instance handles a
  // hash request when it is exploring or when it is the first registered pane
  useEffect(
    () =>
      exploreBus.register({
        paneId,
        isExploring: () => explore.isExploringRef.current,
        explore: explore.exploreFromHash,
        exit: explore.exitExplore,
      }),
    [paneId, explore.isExploringRef, explore.exploreFromHash, explore.exitExplore]
  );

  // ---- Argument graph view (ticket 04): a sibling mode of exploration, `#argument/<work id>` ---------------- //
  const [argumentWorkId, setArgumentWorkId] = useState<string | null>(null);
  const argumentOpenRef = useRef(false);
  argumentOpenRef.current = argumentWorkId !== null;
  const exploreRef = useRef(explore);
  exploreRef.current = explore;
  const argumentWorkRef = useRef<string | null>(null);
  argumentWorkRef.current = argumentWorkId;
  const openArgument = useCallback(
    (workId: string, opts: { push: boolean; confirmed?: boolean }) => {
      const show = () => {
        // one mode at a time: a hash-driven open leaves an exploration (its session stays resumable)
        // (its plain-URL history entry is skipped: this open writes the one entry the user's Back returns through)
        if (exploreRef.current.active) exploreRef.current.yieldExplore();
        setArgumentWorkId(workId);
        setSelNode(refToNodeRef.current[workId] ?? workId);
        if (opts.push) pushArgumentUrl(workId);
      };
      // Showing another Work's graph replaces the one that is open, with its unsaved draft: that is asked first (the
      // Shell already asked when the request came from the browser's Back/Forward). Cancelled: nothing changes, no entry is written.
      const open = argumentWorkRef.current;
      if (open !== null && open !== workId && !opts.confirmed) whenWorkspaceMayLeave(show, "library", paneId);
      else show();
    },
    [paneId]
  );
  const argumentControl = useRef<ArgumentModeControl | null>(null);
  const registerArgumentControl = useCallback((control: ArgumentModeControl | null) => {
    argumentControl.current = control;
  }, []);
  const exitArgument = useCallback(() => setArgumentWorkId(null), []);
  const leaveArgument = useCallback(() => {
    setArgumentWorkId(null);
    clearArgumentUrl();
  }, []);
  useEffect(
    () =>
      argumentBus.register({
        paneId,
        isOpen: () => argumentOpenRef.current,
        workId: () => argumentWorkRef.current,
        open: openArgument,
        exit: exitArgument,
      }),
    [openArgument, exitArgument, paneId]
  );
  // an exploration that starts takes over the page
  useEffect(() => {
    if (explore.active) setArgumentWorkId(null);
  }, [explore.active]);
  useEffect(() => {
    if (paneId === undefined) return;
    if (argumentWorkId === null) onArgument?.(paneId, null);
  }, [paneId, onArgument, argumentWorkId]);
  const onArgumentPage = useCallback((page: ArgumentPage | null) => { if (paneId !== undefined) onArgument?.(paneId, page); }, [paneId, onArgument]);

  // color labels: session-local overlay (right-click menu) on top of the
  // persisted `label` field; unset refs keep the star→amber seeding
  const [labels, setLabels] = useState<Record<string, string | null>>({});
  const effLabel = (r: LibraryRef): string | undefined => effectiveLabel(r, labels);
  const [labelMenu, setLabelMenu] = useState<{ x: number; y: number; refId: string } | null>(null);
  const setLabel = (refId: string, k: string | null) => {
    setLabels((m) => ({ ...m, [refId]: k }));
    setLabelMenu(null);
  };
  useEffect(() => {
    if (!labelMenu) return;
    const close = () => setLabelMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [labelMenu]);

  const [importOpen, setImportOpen] = useState(false);
  // Stage 13: which import-menu dialog is open (null = closed). A resolved
  // (created/existing) ref is selected by its work id — the saved graph node
  // carries the same id, and the WS library.changed reload lands right after.
  const [importMode, setImportMode] = useState<ImportMode | null>(null);
  // The Shelf dialog (shelf ticket 05): the import menu's fourth item; never in the tutorial Project.
  const shelfAvailable = useShelfAvailable();
  const [shelfOpen, setShelfOpen] = useState<{ entryId?: string; take?: boolean } | null>(null);
  const onImportResolved = (r: LibraryRef) => {
    setSelNode(r.id);
    onReload();
  };

  const list = refs.filter((r) => libraryRefMatches(r, q));
  const curNode = selNode ? byId[selNode] : null;
  const curRef: LibraryRef | null = curNode?.ref
    ? (refs.find((r) => r.id === curNode.ref) ?? null)
    : null;
  const curRefRef = useRef(curRef);
  curRefRef.current = curRef;
  // A narrow pane (the 1024 window with the Copilot open): the detail sits beside the graph, never over it, and the
  // work list folds to its rail while a detail is open (see layout.ts). A manual unfold wins until the width class changes.
  const rootRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(rootRef, !explore.active);
  const autoSide = libraryAutoFold(paneWidth, curRef !== null);
  const autoSideRef = useRef(autoSide);
  autoSideRef.current = autoSide;
  const [sideForcedOpen, setSideForcedOpen] = useState(false);
  useEffect(() => setSideForcedOpen(false), [autoSide]);
  const sideFolded = sideCollapsed || (autoSide && !sideForcedOpen);
  const setSide = useCallback((collapsed: boolean) => {
    setSideCollapsed(collapsed);
    setSideForcedOpen(!collapsed && autoSideRef.current);
  }, []);
  const menuRef = labelMenu ? (refs.find((r) => r.id === labelMenu.refId) ?? null) : null;

  // ---- Copilot: the page it sees and the bound-view actions it can ask for ------------------------------ //
  const [detailTab, setDetailTab] = useState<LibraryDetailTab>("meta");
  const [graphLabelsOn, setGraphLabelsOn] = useState(false);
  const graphControls = useRef<GraphCanvasController | null>(null);
  const registerGraph = useCallback((controller: GraphCanvasController | null) => { graphControls.current = controller; }, []);
  // the exploration page (reported by ExploreMode) and the controls it owns
  const [explorePage, setExplorePage] = useState<DiscoveryPage | null>(null);
  const onExplorePage = useCallback((page: DiscoveryPage | null) => setExplorePage(page), []);
  const exploreControl = useRef<ExploreControl | null>(null);
  const registerExploreControl = useCallback((control: ExploreControl | null) => { exploreControl.current = control; }, []);
  useEffect(() => {
    if (paneId === undefined || !onContext) return;
    onContext(
      paneId,
      explore.active || argumentWorkId !== null
        ? null
        : captureLibraryPage({ data: payload, live, failure, query: q, selectedNodeId: selNode, tab: detailTab, labels, sidebarCollapsed: sideFolded, graphLabelsOn, exploration: explore.sessions.length > 0 ? { sessions: explore.sessions.length, seed: explore.current?.seed ?? null } : undefined })
    );
  }, [paneId, onContext, payload, live, failure, q, selNode, detailTab, labels, sideFolded, graphLabelsOn, explore.active, argumentWorkId, explore.sessions, explore.current]);
  useEffect(() => {
    if (paneId === undefined) return;
    onDiscovery?.(paneId, explore.active ? explorePage : null);
  }, [paneId, onDiscovery, explore.active, explorePage]);
  // A pane that leaves the Library page (or goes away) holds no exploration any more: never let the last one linger.
  useEffect(
    () => () => {
      if (paneId !== undefined) onDiscovery?.(paneId, null);
    },
    [paneId, onDiscovery]
  );
  // A pane that leaves the Library page holds no argument graph page either.
  useEffect(
    () => () => {
      if (paneId !== undefined) onArgument?.(paneId, null);
    },
    [paneId, onArgument]
  );
  const latest = useRef({ refs, graph, live, exploring: explore.active, argumentOpen: argumentWorkId !== null, explore, onRefetch });
  latest.current = { refs, graph, live, exploring: explore.active, argumentOpen: argumentWorkId !== null, explore, onRefetch };
  const applyViewAction = useRef<LibraryViewController["apply"]>(async () => ({ ok: false, detail: "unavailable" }));
  // The explore UI's controls. Each answers what the control itself would do: an absent control is `unavailable`
  // (the page that has it is not shown), a present but unusable one `disabled`; a request the click would send is
  // sent once and reported as it ended (never retried, never followed by another hop).
  const runDiscoveryAction = async (action: DiscoveryViewAction): Promise<Pick<CopilotViewActionResult, "ok" | "detail" | "http">> => {
    const state = latest.current;
    const stack = state.explore;
    switch (action.action) {
      case "explore_work": {
        // the work detail's button lives on the Library page, which exploration (or the argument graph view) replaces
        if (stack.active || state.argumentOpen) return { ok: false, detail: "unavailable" };
        let current = { refs: state.refs, graph: state.graph, live: state.live };
        if (!current.refs.some((r) => r.id === action.refId)) {
          const fresh = await state.onRefetch();
          current = { refs: fresh.data.refs, graph: fresh.data.graph, live: fresh.live };
          if (!current.refs.some((r) => r.id === action.refId)) return { ok: false, detail: "not_found" };
        }
        const ref = current.refs.find((r) => r.id === action.refId);
        // enabled only with a live library and an ADS bibcode (RefDetail's own condition), as of the latest read
        if (!ref?.bibcode || !current.live) return { ok: false, detail: "disabled" };
        setSelNode(current.graph.nodes.find((n) => n.ref === ref.id)?.id ?? ref.id);
        return exploreReport(await stack.startExplore(ref.bibcode));
      }
      case "retry_exploration": {
        if (!stack.active) return { ok: false, detail: "unavailable" };
        if (stack.loading) return { ok: false, detail: "disabled" };
        // The error banner's Retry re-sends the seed that failed; the useful-unavailable note's and the empty state's
        // Retry re-send the seed shown. Both exist at once after a failed request on a graph with a useful warning.
        const session = stack.current;
        const hasCurrent = !!session && (session.graph.warnings.some((w) => w.code === "useful_unavailable") || session.graph.nodes.length <= 1);
        const target = action.target ?? (stack.error ? "failed" : "current");
        const seed = target === "failed" ? (stack.error?.seed ?? null) : hasCurrent ? session.seed : null;
        if (!seed) return { ok: false, detail: "disabled" };
        return exploreReport(await stack.startExplore(seed));
      }
      case "cancel_exploration":
        if (!stack.loading) return { ok: false, detail: "disabled" };
        stack.cancelExplore();
        return { ok: true };
      case "step_exploration": {
        if (!stack.active) return { ok: false, detail: "unavailable" };
        const delta = action.direction === "back" ? -1 : 1;
        const target = stack.index + delta;
        if (stack.loading || target < 0 || target >= stack.sessions.length) return { ok: false, detail: "disabled" };
        stack.step(delta);
        return { ok: true };
      }
      case "exit_exploration":
        if (!stack.active) return { ok: false, detail: "unavailable" };
        stack.exitExplore();
        return { ok: true };
      case "resume_exploration":
        // the toolbar's button shows only on the Library page, and only with a history
        if (stack.active || state.argumentOpen) return { ok: false, detail: "unavailable" };
        if (stack.sessions.length === 0) return { ok: false, detail: "disabled" };
        stack.resumeExplore();
        return { ok: true };
      default: {
        if (!stack.active || !exploreControl.current) return { ok: false, detail: "unavailable" };
        return exploreControl.current.apply(action);
      }
    }
  };
  // The argument graph view's navigation for the Copilot (ticket 09): open a Work's graph, select an argument, leave the
  // view. The model is waiting for an answer and the user has not chosen to leave, so a draft that would be lost is
  // never asked about: the guards are asked as `agent`, and a refusal is `leave_blocked`.
  const runArgumentAction = async (action: ArgumentViewAction): Promise<Pick<CopilotViewActionResult, "ok" | "detail" | "http">> => {
    const state = latest.current;
    const mayLeave = () => askWorkspaceLeave("library", paneId, "agent") === true;
    if (action.action === "open_argument_graph") {
      if (argumentWorkRef.current === action.workId && !state.exploring) return { ok: true };
      let known = state.refs.some((r) => r.id === action.workId);
      if (!known) known = (await state.onRefetch()).data.refs.some((r) => r.id === action.workId);
      if (!known) return { ok: false, detail: "not_found" };
      if (argumentWorkRef.current !== null && !mayLeave()) return { ok: false, detail: "leave_blocked" };
      // a UI entry: one history entry, so the browser's Back returns to the Library (the guard was asked just above)
      openArgument(action.workId, { push: true, confirmed: true });
      return { ok: true };
    }
    if (action.action === "exit_argument_graph") {
      if (!state.argumentOpen) return { ok: false, detail: "unavailable" };
      if (!mayLeave()) return { ok: false, detail: "leave_blocked" };
      leaveArgument();
      return { ok: true };
    }
    // select_argument: the view that shows this Work's graph
    if (!state.argumentOpen || argumentWorkRef.current !== action.workId) return { ok: false, detail: "unavailable" };
    return argumentControl.current ? argumentControl.current.select(action.argumentId) : { ok: false, detail: "unavailable" };
  };
  applyViewAction.current = async (action) => {
    const state = latest.current;
    // The service saved a candidate: mark it in place, as the page's own Add does.
    if (action.action === "discovery_saved") {
      state.explore.markSaved(action.bibcode, action.workId);
      return { ok: true };
    }
    if (isArgumentViewAction(action)) return runArgumentAction(action);
    if (isDiscoveryViewAction(action)) return runDiscoveryAction(action);
    // Exploration replaces this page: its own controls are the discovery actions above.
    if (state.exploring || state.argumentOpen) return { ok: false, detail: "unavailable" };
    if (action.action === "filter_library") {
      setQ(action.query);
      return { ok: true };
    }
    if (action.action === "set_graph_labels") {
      if (!graphControls.current) return { ok: false, detail: "unavailable" };
      setGraphLabelsOn(action.on);
      return { ok: true };
    }
    if (action.action === "graph_control") {
      const graphButtons = graphControls.current;
      if (!graphButtons) return { ok: false, detail: "unavailable" };
      ({ zoom_in: graphButtons.zoomIn, zoom_out: graphButtons.zoomOut, fit: graphButtons.fit, relayout: graphButtons.relayout })[action.control]();
      return { ok: true };
    }
    if (action.action === "set_sidebar") {
      setSide(action.collapsed);
      return { ok: true };
    }
    // The remaining actions name a work. An id the page does not know yet (just imported) gets one reload.
    const target = action.refId;
    let current = { refs: state.refs, graph: state.graph };
    if (target && !current.refs.some((r) => r.id === target)) {
      const fresh = await state.onRefetch();
      current = { refs: fresh.data.refs, graph: fresh.data.graph };
      if (!current.refs.some((r) => r.id === target)) return { ok: false, detail: "not_found" };
    }
    const nodeOf = (id: string) => current.graph.nodes.find((n) => n.ref === id)?.id ?? id;
    if (action.action === "select_work") {
      setSelNode(action.refId === null ? null : nodeOf(action.refId));
      return { ok: true };
    }
    if (action.action === "set_detail_tab") {
      if (target) setSelNode(nodeOf(target));
      else if (!curRefRef.current) return { ok: false, detail: "disabled" };
      setDetailTab(action.tab);
      return { ok: true };
    }
    // set_temp_label: the right-click menu's own state change; a display overlay in this tab only.
    setLabels((m) => ({ ...m, [action.refId]: action.label }));
    return { ok: true };
  };
  useEffect(() => {
    if (paneId === undefined || !onController) return;
    onController(paneId, { apply: (action) => applyViewAction.current(action) });
    return () => onController(paneId, null);
  }, [paneId, onController]);

  /** "View in library" from a discovery candidate: exit explore + select it. */
  const viewInLibrary = (workId: string) => {
    explore.exitExplore();
    setSelNode(refToNode[workId] ?? workId);
    onReload(); // the new member's node arrives with the fresh payload
  };

  if (argumentWorkId !== null && !explore.active) {
    return (
      <ArgumentGraphMode
        key={argumentWorkId}
        workId={argumentWorkId}
        work={refs.find((r) => r.id === argumentWorkId) ?? null}
        paneId={paneId}
        onExit={leaveArgument}
        onOpenDoc={onOpenDoc}
        onPage={onArgumentPage}
        onControl={registerArgumentControl}
      />
    );
  }

  if (explore.active) {
    return (
      <ExploreMode
        key={explore.current?.key ?? "explore-pending"}
        explore={explore}
        onExit={explore.exitExplore}
        onViewInLibrary={viewInLibrary}
        onPage={onExplorePage}
        onControl={registerExploreControl}
      />
    );
  }

  return (
    <div className="view-row" data-ui="library-view" ref={rootRef}>
      {sideFolded ? (
        <ActionButton unstyled mode="icon" iconName="panel-left-open" label={t("library.side.expand")} tooltip={t("library.side.expand")} data-ui="expand-library-sidebar" className="lib-rail" onClick={() => setSide(false)} />
      ) : (
        <div className="lib-side" data-ui="library-sidebar">
          <div className="lib-import" data-ui="library-import">
            <ActionButton
              mode="text"
              unstyled
              label={t("library.import.button")}
              tooltip={t("library.import.button")}
              className="btn primary"
              data-ui="open-import-menu"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={() => setImportOpen((v) => !v)}
            >
              {t("library.import.button")}
            </ActionButton>
            {importOpen && (
              <div className="import-menu view-in" data-ui="import-menu">
                {IMPORTS.map((im) => (
                  <ActionButton
                    unstyled
                    mode="text"
                    key={im.titleKey}
                    label={t(im.titleKey)}
                    tooltip={t(im.titleKey)}
                    data-ui="import-option" data-ui-key={im.mode}
                    className="import-opt"
                    onClick={() => {
                      setImportMode(im.mode);
                      setImportOpen(false);
                    }}
                  >
                    <span className="import-ic">
                      <Icon name={im.ic} cls="ico-sm" />
                    </span>
                    <span className="import-body">
                      <span className="import-t">{t(im.titleKey)}</span>
                      <span className="import-d">{t(im.descKey)}</span>
                    </span>
                  </ActionButton>
                ))}
                {shelfAvailable && (
                  <ActionButton
                    unstyled
                    mode="text"
                    label={t("library.import.shelf.title")}
                    tooltip={t("library.import.shelf.title")}
                    data-ui="import-option" data-ui-key="shelf"
                    className="import-opt"
                    onClick={() => {
                      setShelfOpen({});
                      setImportOpen(false);
                    }}
                  >
                    <span className="import-ic">
                      <Icon name="archive" cls="ico-sm" />
                    </span>
                    <span className="import-body">
                      <span className="import-t">{t("library.import.shelf.title")}</span>
                      <span className="import-d">{t("library.import.shelf.desc")}</span>
                    </span>
                  </ActionButton>
                )}
              </div>
            )}
          </div>
          <div className="lib-side-head">
            <span className="lib-side-title">{t("library.side.title")}</span>
            <span className="lib-side-count mono">{list.length}</span>
            <ActionButton unstyled mode="icon" iconName="panel-left-close" label={t("library.side.collapse")} tooltip={t("library.side.collapse")} data-ui="collapse-library-sidebar" className="lib-side-collapse" onClick={() => setSide(true)} />
          </div>
          <div className="side-reflist" data-ui="work-list">
            {list.map((r) => {
              const nid = refToNode[r.id] || r.id;
              const lab = effLabel(r);
              return (
                <button
                  key={r.id}
                  data-ui="work-item" data-ui-key={r.id}
                  className={"side-ref" + (nid === selNode ? " sel" : "") + (r.read ? " read" : " unread")}
                  onClick={() => setSelNode(nid)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setLabelMenu({ x: e.clientX, y: e.clientY, refId: r.id });
                  }}
                >
                  <span className="side-ref-mark">
                    {lab ? (
                      <span className="label-dot" style={{ background: labelColor(lab) }} />
                    ) : !r.read ? (
                      <span className="unread-dot" />
                    ) : null}
                  </span>
                  <span className="side-ref-body">
                    <span className="side-ref-title">{r.title}</span>
                    <span className="side-ref-meta mono">
                      {r.authors.split(/ (?:&|et) /)[0].replace(/,$/, "")} · {r.year} · {r.venue}
                      {r.read && <span className="read-flag">{t("library.side.readFlag")}</span>}
                      {!r.doc_id && r.needs_upload && (
                        <span style={{ color: "oklch(0.80 0.13 78)" }}>{t("library.side.needsSource")}</span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
            {!list.length && <div className="side-reflist-empty mono" data-ui="work-list-empty">{t("library.side.empty")}</div>}
          </div>
        </div>
      )}

      {importMode && (
        <ImportDialog
          mode={importMode}
          onClose={() => setImportMode(null)}
          onResolved={onImportResolved}
        />
      )}

      {shelfOpen && shelfAvailable && (
        <ShelfDialog
          {...shelfOpen}
          works={refs}
          onClose={() => setShelfOpen(null)}
          onViewWork={(workId) => {
            setShelfOpen(null);
            setSelNode(refToNode[workId] ?? workId);
            setDetailTab("files");
            onReload();
          }}
        />
      )}

      {labelMenu && (
        <div
          className="label-menu"
          data-ui="work-label-menu" data-ui-key={labelMenu.refId}
          style={{ left: labelMenu.x, top: labelMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="label-menu-head mono">{t("library.labelMenu.head")}</div>
          <div className="label-menu-row">
            {LABEL_COLORS.map((l) => (
              <ActionButton
                key={l.k}
                unstyled
                mode="icon"
                iconName="circle"
                variant="ghost"
                data-ui="set-work-label" data-ui-key={l.k}
                className={"label-swatch" + (menuRef && effLabel(menuRef) === l.k ? " on" : "")}
                label={t(LABEL_NAME_KEYS[l.k as keyof typeof LABEL_NAME_KEYS])}
                tooltip={t(LABEL_NAME_KEYS[l.k as keyof typeof LABEL_NAME_KEYS])}
                style={{ background: l.c }}
                onClick={() => setLabel(labelMenu.refId, l.k)}
              />
            ))}
          </div>
          <ActionButton unstyled mode="text" label={t("library.labelMenu.clear")} tooltip={t("library.labelMenu.clear")} data-ui="clear-work-label" className="label-clear" onClick={() => setLabel(labelMenu.refId, null)}>
            {t("library.labelMenu.clear")}
          </ActionButton>
        </div>
      )}

      <div className="lib-main" data-ui="library-graph-area">
        <div className="lib-toolbar" data-ui="library-toolbar">
          <div className="lib-search">
            <Icon name="search" cls="ico-sm" />
            <input
              data-ui="search-library"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t("library.toolbar.searchPlaceholder")}
            />
          </div>
          <div style={{ flex: 1 }} />
          {!live && (
            <span data-ui="library-demo-notice" className="lib-banner" title={t("library.toolbar.demoTitle")}>
              <Icon name="flask-conical" cls="ico-sm" />
              {t("library.toolbar.demoBadge")}
            </span>
          )}
          {explore.sessions.length > 0 && (
            <ActionButton
              mode="text"
              unstyled
              label={t("explore.resume")}
              tooltip={t("explore.resume")}
              className="btn ghost"
              data-testid="resume-explore"
              data-ui="resume-exploration"
              onClick={explore.resumeExplore}
            >
              {t("explore.resume")}
            </ActionButton>
          )}
        </div>

        <LibraryGraph graph={graph} selId={selNode} onSel={setSelNode} query={q} labelsOn={graphLabelsOn} onLabelsOnChange={setGraphLabelsOn} onController={registerGraph} />
      </div>

      {curRef && (
        <RefDetail
          r={curRef}
          node={curNode}
          onClose={() => setSelNode(null)}
          tab={detailTab}
          onTabChange={setDetailTab}
          onOpenDoc={onOpenDoc}
          onReload={onReload}
          onDocDeleted={onDocDeleted}
          onBeforeDocDelete={onBeforeDocDelete}
          explore={{ bibcode: curRef.bibcode ?? null, live, onExplore: (b) => void explore.startExplore(b) }}
          argumentGraph={{ live, onOpen: (workId) => openArgument(workId, { push: true }) }}
        />
      )}
    </div>
  );
}
