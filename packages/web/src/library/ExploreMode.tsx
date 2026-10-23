/**
 * Explore mode (Stage 14): the in-library-workspace exploration UI — header
 * (back / breadcrumb / history), seed card + Related|Useful side list, the
 * shared graph canvas or an accessible result table, and the candidate
 * inspector. Per-session UI state (selection/query/filter/display/tab/scroll)
 * is captured into the session object on unmount so Back/Forward restores it
 * (stage plan §15); the graph layout+viewport ride the session stash.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  type CopilotViewActionResult,
  type DiscoveryGraph,
  type DiscoveryPage,
  type DiscoveryPaper,
  type DiscoveryViewAction,
  discoveryReachableBibcodes,
  discoveryVisibleNodes,
} from "@argelanderspace/contracts";
import { captureDiscoveryPage } from "../copilot/discovery-context";
import type { GraphCanvasController } from "../graph/GraphCanvas";
import { Icon } from "../lib/icons";
import { findOnShelf, projectHas, type ShelfHit } from "../shelf/already-on-shelf";
import { useShelfAvailable } from "../shelf/availability";
import { ActionButton } from "../ui";
import { DiscoveryDetail } from "./DiscoveryDetail";
import { DiscoveryGraphView } from "./DiscoveryGraphView";
import { MergeNoteList } from "./MergeNotes";
import type { LibraryRef } from "./types";
import {
  exploreReport,
  type ExploreError,
  type ExploreFilter,
  type ExploreStack,
} from "./explore-state";

// The filter and the search predicate are the contracts' (the Copilot sees exactly the nodes this page shows).
const visibleNodes = (graph: DiscoveryGraph, q: string, filter: ExploreFilter): DiscoveryPaper[] =>
  discoveryVisibleNodes(graph.nodes, q, filter);

/** What the Copilot can ask this page to do with the controls it owns (the rest is the stack's, see LibraryView). */
export interface ExploreControl {
  apply: (action: DiscoveryViewAction) => Promise<Pick<CopilotViewActionResult, "ok" | "detail">>;
}

export function ExploreMode({
  explore,
  onExit,
  onViewInLibrary,
  onPage,
  onControl,
  onTakeFromShelf,
  works = [],
}: {
  explore: ExploreStack;
  onExit: () => void;
  /** "View in library": exit explore mode and select the work there. */
  onViewInLibrary: (workId: string) => void;
  /** The page as the Copilot should see it (null when this page goes away). */
  onPage?: (page: DiscoveryPage | null) => void;
  onControl?: (control: ExploreControl | null) => void;
  /** "Take from Shelf…" in a candidate's already-on-Shelf hint (shelf ticket 06). Absent: no hint. */
  onTakeFromShelf?: (bibcode: string, hits: readonly ShelfHit[]) => void;
  /** The project's Works: a candidate the project already has (same DOI or arXiv id) is not looked up. */
  works?: readonly LibraryRef[];
}) {
  const { t } = useTranslation();
  const session = explore.current;

  // per-session UI state (initialized from the session; captured back on unmount)
  const [selection, setSelection] = useState<string | null>(session?.selection ?? null);
  const [query, setQuery] = useState(session?.query ?? "");
  const [filter, setFilter] = useState<ExploreFilter>(session?.filter ?? "all");
  const [display, setDisplay] = useState<"graph" | "list">(session?.display ?? "graph");
  // the inspector's tab and the graph's label toggle are held here (not inside their components) so the Copilot can set them
  const [detailTab, setDetailTab] = useState<"abstract" | "citations">("abstract");
  const [labelsOn, setLabelsOn] = useState(false);
  const graphControls = useRef<GraphCanvasController | null>(null);
  const registerGraph = useRef((controller: GraphCanvasController | null) => { graphControls.current = controller; }).current;
  /** Opening another candidate always starts on its abstract (the inspector used to remount per candidate). */
  const select = (bibcode: string | null) => {
    if (bibcode !== selection) setDetailTab("abstract"); // choosing the open candidate again keeps its tab
    if (bibcode !== shelfHint?.bibcode) setShelfHint(null);
    setSelection(bibcode);
  };
  // The already-on-Shelf hint (shelf ticket 06): an Add asks the Shelf first (DOI / arXiv only, read-only); with a hit
  // the candidate's detail shows the hint instead of adding. Never in the tutorial Project; no mark on the graph or
  // the candidate list (spec Q22).
  const shelfAvailable = useShelfAvailable() && onTakeFromShelf !== undefined;
  const [shelfHint, setShelfHint] = useState<{ bibcode: string; hits: ShelfHit[] } | null>(null);
  const [checkingShelf, setCheckingShelf] = useState<string | null>(null);
  const lookup = useRef<AbortController | null>(null);
  useEffect(() => () => lookup.current?.abort(), []);
  // read after the lookup's await: the stack's latest adding guard and the selection the person has now
  const exploreRef = useRef(explore);
  exploreRef.current = explore;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const requestAdd = async (bibcode: string) => {
    if (explore.adding !== null || checkingShelf !== null) return;
    const node = session?.graph.nodes.find((n) => n.bibcode === bibcode);
    const ids = node ? { doi: node.doi, arxiv: node.arxivId } : null;
    if (shelfAvailable && ids && (ids.doi || ids.arxiv) && !projectHas(ids, works)) {
      const controller = new AbortController();
      lookup.current = controller;
      const selectedThen = selection;
      setCheckingShelf(bibcode);
      let found: ShelfHit[] | null;
      try {
        found = await findOnShelf(ids, controller.signal);
      } catch {
        return; // aborted: this page is gone
      } finally {
        if (!controller.signal.aborted) setCheckingShelf(null);
      }
      // Another candidate was opened, or the detail closed, while the Shelf was asked: the answer is dropped (no hint
      // that pulls the selection back, no add the person no longer looks at).
      if (selectionRef.current !== selectedThen) return;
      // Not known (the Shelf could not be asked): added as usual, without a word about the Shelf.
      if (found && found.length > 0) {
        select(bibcode);
        setShelfHint({ bibcode, hits: found });
        return;
      }
    }
    if (exploreRef.current.adding !== null) return;
    void exploreRef.current.addToLibrary(bibcode);
  };
  const addAsUsual = (bibcode: string) => {
    setShelfHint(null);
    void explore.addToLibrary(bibcode);
  };
  /** The graph is only drawn in the graph display: leaving it resets the label toggle, as unmounting the canvas always did. */
  const changeDisplay = (next: "graph" | "list") => {
    if (next !== display) setLabelsOn(false);
    setDisplay(next);
  };
  const listRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const uiRef = useRef({ selection, query, filter, display });
  uiRef.current = { selection, query, filter, display };

  // capture the UI state into the session object when this session unmounts
  // (Back/Forward / exit / a new seed replacing us via key change)
  useEffect(() => {
    const list = listRef.current;
    return () => {
      const s = sessionRef.current;
      if (!s) return;
      s.selection = uiRef.current.selection;
      s.query = uiRef.current.query;
      s.filter = uiRef.current.filter;
      s.display = uiRef.current.display;
      s.scrollTop = list?.scrollTop ?? 0;
    };
  }, []);
  // restore the list scroll after the first paint
  useEffect(() => {
    if (listRef.current && session?.scrollTop) listRef.current.scrollTop = session.scrollTop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const graph = session?.graph ?? null;
  const seedPaper = graph?.nodes.find((n) => n.roles.includes("seed")) ?? null;
  const selected = graph?.nodes.find((n) => n.bibcode === selection) ?? null;
  const visible = graph ? visibleNodes(graph, query, filter) : [];
  const usefulUnavailable = graph?.warnings.some((w) => w.code === "useful_unavailable") ?? false;
  const relatedCount = graph?.nodes.filter((n) => n.roles.includes("related")).length ?? 0;
  const usefulCount = graph?.nodes.filter((n) => n.roles.includes("useful")).length ?? 0;

  // ---- Copilot: the page it sees and the controls it can press ---------------------------------------- //
  const page = useMemo(
    () =>
      captureDiscoveryPage({
        graph,
        seeds: explore.sessions.map((entry) => entry.seed),
        index: explore.index,
        loading: explore.loading,
        error: explore.error,
        adding: explore.adding,
        addFailed: explore.addError,
        selection,
        query,
        filter,
        display,
        detailTab,
        labelsOn,
      }),
    [graph, explore.sessions, explore.index, explore.loading, explore.error, explore.adding, explore.addError, selection, query, filter, display, detailTab, labelsOn]
  );
  useEffect(() => {
    onPage?.(page);
  }, [page, onPage]);
  useEffect(() => () => onPage?.(null), [onPage]);
  const latest = useRef({ graph, selection, explore, onViewInLibrary, page });
  latest.current = { graph, selection, explore, onViewInLibrary, page };
  const applyControl = useRef<ExploreControl["apply"]>(async () => ({ ok: false, detail: "unavailable" }));
  applyControl.current = async (action) => {
    const now = latest.current;
    switch (action.action) {
      case "filter_discovery":
        // the filter tabs exist once a graph is shown
        if (!now.graph) return { ok: false, detail: "disabled" };
        setFilter(action.filter);
        return { ok: true };
      case "search_discovery":
        setQuery(action.query);
        return { ok: true };
      case "set_discovery_display":
        changeDisplay(action.display);
        return { ok: true };
      case "select_candidate":
        // only what the page lets the user reach: the visible nodes, the open candidate and its citations
        if (action.bibcode !== null && !discoveryReachableBibcodes(now.page).has(action.bibcode)) return { ok: false, detail: "not_found" };
        select(action.bibcode);
        return { ok: true };
      case "explore_candidate": {
        // the inspector's "Explore from here": the candidate must be one the user can reach, and never the origin
        if (!discoveryReachableBibcodes(now.page).has(action.bibcode)) return { ok: false, detail: "not_found" };
        if (now.graph?.nodes.find((n) => n.bibcode === action.bibcode)?.roles.includes("seed")) return { ok: false, detail: "disabled" };
        return exploreReport(await now.explore.startExplore(action.bibcode));
      }
      case "set_discovery_tab": {
        // the tabs belong to the open inspector
        const open = now.graph?.nodes.some((n) => n.bibcode === now.selection);
        if (!open) return { ok: false, detail: "disabled" };
        setDetailTab(action.tab);
        return { ok: true };
      }
      case "dismiss_discovery_error":
        if (!now.explore.error) return { ok: false, detail: "disabled" };
        now.explore.dismissError();
        return { ok: true };
      case "view_candidate_in_library": {
        const node = now.graph?.nodes.find((n) => n.bibcode === action.bibcode);
        if (!node || !discoveryReachableBibcodes(now.page).has(action.bibcode)) return { ok: false, detail: "not_found" };
        // the inspector shows this button only for a saved candidate
        if (node.libraryId === null) return { ok: false, detail: "disabled" };
        now.onViewInLibrary(node.libraryId);
        return { ok: true };
      }
      case "set_discovery_graph_labels":
        if (!graphControls.current) return { ok: false, detail: "unavailable" };
        setLabelsOn(action.on);
        return { ok: true };
      case "discovery_graph_control": {
        const buttons = graphControls.current;
        if (!buttons) return { ok: false, detail: "unavailable" };
        ({ zoom_in: buttons.zoomIn, zoom_out: buttons.zoomOut, fit: buttons.fit, relayout: buttons.relayout, focus_seed: buttons.focusSeed })[action.control]();
        return { ok: true };
      }
      default:
        return { ok: false, detail: "unavailable" };
    }
  };
  useEffect(() => {
    onControl?.({ apply: (action) => applyControl.current(action) });
    return () => onControl?.(null);
  }, [onControl]);

  const errText = (e: ExploreError): string => {
    switch (e.status) {
      case 400:
        return t("explore.error.badBibcode");
      case 404:
        return t("explore.error.notFound");
      case 429:
        return t("explore.error.rateLimited");
      case 503:
        return t("explore.error.unavailable");
      default:
        return t("explore.error.failed");
    }
  };

  return (
    <div className="explore-root" data-ui="discovery-view">
      <div className="explore-header" data-ui="discovery-header">
        <ActionButton unstyled mode="icon" iconName="arrow-left" className="btn icon ghost" label={t("explore.backLibrary")} tooltip={t("explore.backLibrary")} data-testid="back-to-library" data-ui="return-to-library" onClick={onExit} />
        <div className="explore-context">
          <div className="explore-eyebrow">
            <span>{t("shell.nav.library")}</span>
            <Icon name="chevron-right" cls="ico-sm" />
            <span style={{ color: "var(--accent)" }}>{t("explore.toolbarTitle")}</span>
          </div>
          <div className="explore-title">
            {seedPaper ? `${seedPaper.authors[0]?.split(",")[0] ?? ""} · ${seedPaper.year ?? ""} — ${seedPaper.title}` : (explore.loading?.seed ?? explore.error?.seed ?? "")}
          </div>
        </div>
        <div className="history-buttons">
          <span className="history-count mono">
            {explore.index + 1} / {explore.sessions.length}
          </span>
          <ActionButton unstyled mode="icon" iconName="chevron-left" className="btn icon ghost" label={t("explore.prev")} tooltip={t("explore.prev")} data-testid="explore-history-back" data-ui="discovery-back" disabled={explore.index <= 0 || !!explore.loading} onClick={() => explore.step(-1)} />
          <ActionButton unstyled mode="icon" iconName="chevron-right" className="btn icon ghost" label={t("explore.next")} tooltip={t("explore.next")} data-testid="explore-history-forward" data-ui="discovery-forward" disabled={explore.index >= explore.sessions.length - 1 || !!explore.loading} onClick={() => explore.step(1)} />
        </div>
      </div>

      <div className="view-row">
        <div className="lib-side">
          {seedPaper && (
            <div className="seed-card" data-ui="discovery-seed" data-ui-key={seedPaper.bibcode}>
              <div className="seed-kicker">
                <Icon name="target" cls="ico-sm" />
                {t("explore.origin")}
              </div>
              <button data-ui="select-seed" className="seed-title" onClick={() => select(seedPaper.bibcode)}>
                {seedPaper.title}
              </button>
              <div className="seed-meta mono">
                {seedPaper.authors[0]?.split(",")[0] ?? "—"} · {seedPaper.year ?? "—"} ·{" "}
                {seedPaper.venue ?? "—"}
              </div>
            </div>
          )}
          {graph && (
            <>
              <div className="source-tabs" data-ui="discovery-filters" role="tablist" aria-label={t("explore.toolbarTitle")}>
                {(
                  [
                    ["all", t("explore.filter.all"), graph.nodes.length - 1],
                    ["related", t("explore.filter.related"), relatedCount],
                    ["useful", t("explore.filter.useful"), usefulCount],
                  ] as const
                ).map(([key, label, count]) => (
                  <ActionButton
                    unstyled
                    mode="text"
                    key={key}
                    label={label}
                    tooltip={label}
                    className={"source-tab" + (filter === key ? " on" : "")}
                    data-testid={`explore-filter-${key}`} data-ui="discovery-filter" data-ui-key={key}
                    aria-pressed={filter === key}
                    onClick={() => setFilter(key)}
                  >
                    <span>{label}</span>
                    <b className="mono">{count}</b>
                  </ActionButton>
                ))}
              </div>
              <p className="source-copy">{t(`explore.filterHint.${filter}`)}</p>
            </>
          )}
          <div className="side-reflist" data-ui="discovery-results" ref={listRef}>
            {graph &&
              visible
                .filter((n) => !n.roles.includes("seed"))
                .map((n) => (
                  <button
                    key={n.bibcode}
                    className={"side-ref" + (n.bibcode === selection ? " sel" : "")}
                    data-testid={`explore-row-${n.bibcode}`} data-ui="discovery-paper" data-ui-key={n.bibcode}
                    onClick={() => select(n.bibcode)}
                  >
                    <span className="side-ref-mark">
                      <span
                        className={
                          "role-dot" +
                          (n.roles.includes("useful") ? " useful" : "") +
                          (n.libraryId !== null ? " saved" : "")
                        }
                      />
                    </span>
                    <span className="side-ref-body">
                      <span className="side-ref-title">{n.title}</span>
                      <span className="side-ref-meta mono">
                        {n.authors[0]?.split(",")[0] ?? "—"} · {n.year ?? "—"} · {n.venue ?? "—"}
                        {n.libraryId !== null && (
                          <span className="side-ref-saved" title={t("explore.savedChip")}>
                            {" ✓"}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                ))}
            {graph && visible.filter((n) => !n.roles.includes("seed")).length === 0 && (
              <div className="side-reflist-empty mono">{t("explore.noMatches")}</div>
            )}
          </div>
          {usefulUnavailable && (
            <div className="disconnected-note" style={{ position: "static", margin: "6px 10px" }} data-testid="useful-unavailable" data-ui="useful-unavailable">
              <Icon name="info" cls="ico-sm" />
              {t("explore.usefulUnavailable")}
              <ActionButton unstyled mode="text" className="btn ghost" label={t("explore.retry")} tooltip={t("explore.retry")} data-ui="retry-useful" onClick={() => void explore.startExplore(session!.seed)}>{t("explore.retry")}</ActionButton>
            </div>
          )}
          <div className="side-footer">
            <span>{t("explore.noAutoAdd")}</span>
            <br />
            <strong>{graph?.nodes.filter((n) => n.libraryId !== null).length ?? 0}</strong>
            {" / "}
            {graph?.nodes.length ?? 0} {t("explore.savedCount")}
          </div>
        </div>

        <div className="lib-main" data-ui="discovery-main">
          {explore.mergeNotes.length > 0 && (
            <div className="merge-note-bar" data-ui="discovery-graph-merges">
              <div className="merge-note-bar-head">
                <strong>{t("library.graphMerge.title")}</strong>
                <ActionButton unstyled mode="icon" iconName="x" className="btn icon ghost" label={t("library.graphMerge.dismiss")} tooltip={t("library.graphMerge.dismiss")} data-ui="dismiss-discovery-graph-merges" onClick={explore.dismissMergeNotes} />
              </div>
              <MergeNoteList notes={explore.mergeNotes} uiId="discovery-graph-merge" />
            </div>
          )}
          <div className="lib-toolbar">
            <div className="lib-search">
              <Icon name="search" cls="ico-sm" />
              <input
                data-ui="search-discovery"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("explore.searchPlaceholder")}
                aria-label={t("explore.searchPlaceholder")}
              />
              {query && (
                <ActionButton unstyled mode="icon" iconName="x" className="btn icon ghost" label={t("explore.clearSearch")} tooltip={t("explore.clearSearch")} data-ui="clear-discovery-search" onClick={() => setQuery("")} />
              )}
            </div>
            <div style={{ flex: 1 }} />
            <span className="scope-chip mono">{t("explore.shown", { count: visible.length })}</span>
            <div className="mode-switch">
              <ActionButton unstyled mode="icon" iconName="waypoints" label={t("explore.graphView")} tooltip={t("explore.graphView")} aria-pressed={display === "graph"} className={display === "graph" ? "on" : ""} data-testid="explore-graph-view" data-ui="show-discovery-graph" onClick={() => changeDisplay("graph")} />
              <ActionButton unstyled mode="icon" iconName="list" label={t("explore.listView")} tooltip={t("explore.listView")} aria-pressed={display === "list"} className={display === "list" ? "on" : ""} data-testid="explore-list-view" data-ui="show-discovery-list" onClick={() => changeDisplay("list")} />
            </div>
          </div>

          {explore.error && (
            <div className="explore-banner" role="alert" data-testid="explore-error" data-ui="discovery-error">
              <Icon name="info" cls="ico-sm" />
              <span>
                {t("explore.error.title")}
                {" — "}
                {errText(explore.error)}
              </span>
              <ActionButton unstyled mode="text" className="btn" label={t("explore.retry")} tooltip={t("explore.retry")} data-ui="retry-discovery" onClick={() => void explore.startExplore(explore.error!.seed)}>{t("explore.retry")}</ActionButton>
              <ActionButton unstyled mode="icon" iconName="x" className="btn icon ghost" label={t("common.close")} tooltip={t("common.close")} data-testid="explore-error-dismiss" data-ui="dismiss-discovery-error" onClick={explore.dismissError} />
            </div>
          )}

          {graph && graph.nodes.length <= 1 && !explore.loading && !explore.error && (
            <div className="empty-state" data-testid="explore-empty" data-ui="discovery-empty">
              <Icon name="search" cls="ico-lg" />
              <h3>{t("explore.empty.title")}</h3>
              <p>{t("explore.empty.hint")}</p>
              <ActionButton unstyled mode="text" className="btn" label={t("explore.retry")} tooltip={t("explore.retry")} data-ui="retry-discovery" onClick={() => void explore.startExplore(session!.seed)}>{t("explore.retry")}</ActionButton>
            </div>
          )}

          {graph && graph.nodes.length > 1 && display === "graph" && (
            <DiscoveryGraphView
              graph={visibleGraph(graph, visible)}
              stash={session!.stash}
              layoutKey={session!.key}
              selectedId={selection}
              onSelect={(id) => select(id)}
              query=""
              addingId={explore.adding}
              labelsOn={labelsOn}
              onLabelsOnChange={setLabelsOn}
              onController={registerGraph}
            />
          )}
          {graph && graph.nodes.length > 1 && display === "list" && (
            <div className="result-table-wrap" data-ui="discovery-table">
              <table className="result-table">
                <thead>
                  <tr>
                    <th>{t("explore.table.paper")}</th>
                    <th className="year-cell">{t("library.detail.meta.year")}</th>
                    <th className="src-cell">{t("explore.table.source")}</th>
                    <th className="status-cell">{t("graph.legendSaved")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((n) => (
                    <tr key={n.bibcode} data-ui="discovery-table-paper" data-ui-key={n.bibcode} className={selection === n.bibcode ? "sel" : ""}>
                      <td>
                        <button className="table-paper" data-ui="select-discovery-paper" onClick={() => select(n.bibcode)}>
                          {n.title}
                        </button>
                        <div className="table-auth mono">
                          {n.authors[0]?.split(",")[0] ?? "—"} · {n.venue ?? "—"}
                        </div>
                      </td>
                      <td className="year-cell mono">{n.year ?? "—"}</td>
                      <td className="src-cell">
                        <span className="tag" style={{ fontSize: 9 }}>
                          {n.roles.includes("seed")
                            ? t("explore.role.origin")
                            : n.roles.includes("useful")
                              ? t("explore.role.useful")
                              : t("explore.role.related")}
                        </span>
                      </td>
                      <td className="status-cell">
                        {n.libraryId !== null ? (
                          <span style={{ color: "var(--ok, oklch(0.74 0.13 158))" }} title={t("explore.savedChip")}>
                            <Icon name="check" cls="ico-sm" />
                          </span>
                        ) : (
                          <ActionButton unstyled mode="text" className="btn" label={t("explore.add")} tooltip={t("explore.add")} data-ui="save-discovery-paper" data-ui-key={n.bibcode} disabled={explore.adding !== null || checkingShelf !== null} busy={checkingShelf === n.bibcode} onClick={() => void requestAdd(n.bibcode)}>{t("explore.add")}</ActionButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!graph && explore.error && !explore.loading && (
            <div className="empty-state" data-testid="explore-fatal">
              <Icon name="info" cls="ico-lg" />
              <h3>{t("explore.error.title")}</h3>
              <p>{errText(explore.error)}</p>
              <p className="record-note">{t("explore.error.unchanged")}</p>
              <ActionButton unstyled mode="text" className="btn" label={t("explore.retry")} tooltip={t("explore.retry")} data-testid="explore-retry" data-ui="retry-discovery" onClick={() => void explore.startExplore(explore.error!.seed)}>{t("explore.retry")}</ActionButton>
            </div>
          )}

          {explore.loading && (
            <div className="cg-loading" role="status" aria-live="polite" data-testid="explore-loading" data-ui="discovery-loading">
              <div className="cg-spinner" />
              <div className="cg-loading-t">{t("explore.loading.title")}</div>
              <div className="cg-loading-d">{t("explore.loading.desc")}</div>
              <ActionButton unstyled mode="text" className="btn ghost" label={t("common.cancel")} tooltip={t("common.cancel")} data-testid="explore-cancel" data-ui="cancel-discovery" onClick={explore.cancelExplore}>{t("common.cancel")}</ActionButton>
            </div>
          )}
        </div>

        {selected && session && (
          <DiscoveryDetail
            key={`${session.key}:${selected.bibcode}`}
            paper={selected}
            graph={session.graph}
            onSelect={select}
            onClose={() => select(null)}
            tab={detailTab}
            onTabChange={setDetailTab}
            onAdd={(b) => void requestAdd(b)}
            onExploreHere={(b) => void explore.startExplore(b)}
            onViewInLibrary={onViewInLibrary}
            adding={explore.adding === selected.bibcode || checkingShelf === selected.bibcode}
            addFailed={explore.addError === selected.bibcode}
            addBlocked={explore.adding !== null || checkingShelf !== null}
            shelfHint={shelfHint?.bibcode === selected.bibcode && selected.libraryId === null && onTakeFromShelf ? { hits: shelfHint.hits, onTake: () => onTakeFromShelf(selected.bibcode, shelfHint.hits), onAddAsUsual: () => addAsUsual(selected.bibcode) } : null}
          />
        )}
      </div>
    </div>
  );
}

/** Restrict edges to visible nodes (the filter/search only changes the view). */
function visibleGraph(graph: DiscoveryGraph, visible: DiscoveryPaper[]): DiscoveryGraph {
  const ids = new Set(visible.map((n) => n.bibcode));
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => ids.has(n.bibcode)),
    edges: graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
  };
}
