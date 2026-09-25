/**
 * Explore mode (Stage 14): the in-library-workspace exploration UI — header
 * (back / breadcrumb / history), seed card + Related|Useful side list, the
 * shared graph canvas or an accessible result table, and the candidate
 * inspector. Per-session UI state (selection/query/filter/display/tab/scroll)
 * is captured into the session object on unmount so Back/Forward restores it
 * (stage plan §15); the graph layout+viewport ride the session stash.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DiscoveryGraph, DiscoveryPaper } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";
import { DiscoveryDetail } from "./DiscoveryDetail";
import { DiscoveryGraphView } from "./DiscoveryGraphView";
import {
  type ExploreError,
  type ExploreFilter,
  type ExploreStack,
} from "./explore-state";

function paperMatches(p: DiscoveryPaper, q: string): boolean {
  if (!q) return true;
  const hay = (p.title + " " + p.authors.join(" ") + " " + (p.year ?? "") + " " + p.bibcode).toLowerCase();
  return hay.includes(q.toLowerCase());
}

function visibleNodes(graph: DiscoveryGraph, q: string, filter: ExploreFilter): DiscoveryPaper[] {
  return graph.nodes.filter(
    (n) =>
      n.roles.includes("seed") ||
      (paperMatches(n, q) && (filter === "all" || n.roles.includes(filter)))
  );
}

export function ExploreMode({
  explore,
  onExit,
  onViewInLibrary,
}: {
  explore: ExploreStack;
  onExit: () => void;
  /** "View in library": exit explore mode and select the work there. */
  onViewInLibrary: (workId: string) => void;
}) {
  const { t } = useTranslation();
  const session = explore.current;

  // per-session UI state (initialized from the session; captured back on unmount)
  const [selection, setSelection] = useState<string | null>(session?.selection ?? null);
  const [query, setQuery] = useState(session?.query ?? "");
  const [filter, setFilter] = useState<ExploreFilter>(session?.filter ?? "all");
  const [display, setDisplay] = useState<"graph" | "list">(session?.display ?? "graph");
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
              <button data-ui="select-seed" className="seed-title" onClick={() => setSelection(seedPaper.bibcode)}>
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
                    onClick={() => setSelection(n.bibcode)}
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
              <ActionButton unstyled mode="icon" iconName="waypoints" label={t("explore.graphView")} tooltip={t("explore.graphView")} aria-pressed={display === "graph"} className={display === "graph" ? "on" : ""} data-testid="explore-graph-view" data-ui="show-discovery-graph" onClick={() => setDisplay("graph")} />
              <ActionButton unstyled mode="icon" iconName="list" label={t("explore.listView")} tooltip={t("explore.listView")} aria-pressed={display === "list"} className={display === "list" ? "on" : ""} data-testid="explore-list-view" data-ui="show-discovery-list" onClick={() => setDisplay("list")} />
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
              onSelect={(id) => setSelection(id)}
              query=""
              addingId={explore.adding}
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
                        <button className="table-paper" data-ui="select-discovery-paper" onClick={() => setSelection(n.bibcode)}>
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
                          <ActionButton unstyled mode="text" className="btn" label={t("explore.add")} tooltip={t("explore.add")} data-ui="save-discovery-paper" data-ui-key={n.bibcode} disabled={explore.adding !== null} onClick={() => void explore.addToLibrary(n.bibcode)}>{t("explore.add")}</ActionButton>
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
            onSelect={setSelection}
            onClose={() => setSelection(null)}
            onAdd={(b) => void explore.addToLibrary(b)}
            onExploreHere={(b) => void explore.startExplore(b)}
            onViewInLibrary={onViewInLibrary}
            adding={explore.adding === selected.bibcode}
            addFailed={explore.addError === selected.bibcode}
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
