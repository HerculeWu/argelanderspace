/**
 * The argument graph view (ticket 04): a temporary mode of the Library page, the sibling of the explore mode. Header
 * (back, breadcrumb, the work, counts, audit badge), the outline on the left, the layered canvas, and the reading panel
 * on the right. Read-only: the new-argument and clear controls are shown disabled until ticket 05 connects them.
 * The graph is read from the server and read again whenever the server says it changed; the selection survives that
 * as long as the argument still exists.
 */
import { auditArgumentGraph, type ArgumentSource } from "@argelanderspace/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { useElementWidth } from "../doc/auto-fold";
import { ActionButton, InlineMessage } from "../ui";
import type { LibraryRef } from "../library/types";
import { ArgumentAudit } from "./ArgumentAudit";
import { ArgumentGraphCanvas, type ArgumentCanvasStash } from "./ArgumentGraphCanvas";
import { ArgumentOutline, type OutlineOpenState } from "./ArgumentOutline";
import { ArgumentPanel, sourceAnchor } from "./ArgumentPanel";
import { findingsOf, listFindings } from "./findings";
import { OUTLINE_RAIL, OUTLINE_WIDTH, PANEL_WIDTH, argumentLayout, outlineAutoFold } from "./layout";
import { type ArgumentPage, captureArgumentPage } from "./page";
import { useArgumentGraph } from "./useArgumentGraph";
import { useFindingText } from "./useFindingText";

/** "Author · year — title" as the explore header writes it; the bare id when the library does not list the work. */
function workHeading(workId: string, work: LibraryRef | null): string {
  if (!work) return workId;
  const author = work.authors.split(/[,&]/)[0]?.trim() ?? "";
  return `${author} · ${work.year} — ${work.title}`;
}

export function ArgumentGraphMode({
  workId,
  work,
  onExit,
  onOpenDoc,
  onPage,
}: {
  workId: string;
  /** The library's entry for the work; null when the library does not list it (the server's answer still decides). */
  work: LibraryRef | null;
  onExit: () => void;
  /** The reading pane: a Doc at a structural anchor, or `page-<n>` for a PDF Doc. */
  onOpenDoc: (docId: string, anchor: string | null) => void;
  /** The page as the Copilot should see it (null when this view goes away). */
  onPage?: (page: ArgumentPage | null) => void;
}) {
  const { t } = useTranslation();
  const { state, reload, refresh, refreshFailed } = useArgumentGraph(workId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const stash = useRef<ArgumentCanvasStash>({}).current;
  const graph = state.phase === "ready" ? state.graph : null;
  const audit = useMemo(() => (graph ? auditArgumentGraph(graph) : null), [graph]);
  const findings = useMemo(() => (audit ? listFindings(audit) : []), [audit]);
  const describe = useFindingText(graph);
  const workDocIds = useMemo(() => work?.doc_ids ?? (work?.doc_id ? [work.doc_id] : []), [work]);
  const selected = graph?.arguments.find((a) => a.id === selectedId) ?? null;
  const heading = workHeading(workId, work);

  // Narrow pane (user decision 2026-10-12, see layout.ts): an open panel folds the outline, then floats over the canvas.
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  const [outlineOpen, setOutlineOpen] = useState<OutlineOpenState>(new Map());
  const [userFolded, setUserFolded] = useState(false);
  const [userUnfolded, setUserUnfolded] = useState(false);
  const graphHasArguments = !!graph && graph.arguments.length > 0;
  const panelOpen = selected !== null;
  const autoFold = outlineAutoFold(width, panelOpen);
  const autoFoldRef = useRef(autoFold);
  autoFoldRef.current = autoFold;
  // a manual unfold wins while the panel stays open at this width class; closing the panel gives the fold back
  useEffect(() => setUserUnfolded(false), [autoFold]);
  const layout = argumentLayout({ width, panelOpen, userFolded, userUnfolded });
  const setOutlineFolded = useCallback((folded: boolean) => {
    setUserFolded(folded);
    setUserUnfolded(!folded && autoFoldRef.current);
  }, []);
  const overlay = layout.panel === "overlay";
  // what the floating panel covers of the canvas: its width, kept 60 px short of the canvas so the zoom stack stays on it
  const canvasWidth = width === null ? null : width - (graphHasArguments ? (layout.outlineFolded ? OUTLINE_RAIL : OUTLINE_WIDTH) : 0);
  const coverRight = overlay ? Math.max(0, Math.min(PANEL_WIDTH, (canvasWidth ?? PANEL_WIDTH + 60) - 60)) : 0;
  // Esc closes a floating panel (an open audit list takes the first Esc)
  useEffect(() => {
    if (!overlay) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector('[data-ui="argument-audit-popover"]')) return;
      setSelectedId(null);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [overlay]);

  // the selection follows the argument, not the read: it is dropped only when a graph that was read no longer has it
  useEffect(() => {
    if (graph && selectedId !== null && !graph.arguments.some((a) => a.id === selectedId)) setSelectedId(null);
  }, [graph, selectedId]);

  const page = useMemo(() => captureArgumentPage({ workId, title: work?.title ?? workId, graph, phase: state.phase, selectedId }), [workId, work?.title, graph, state.phase, selectedId]);
  useEffect(() => {
    onPage?.(page);
  }, [page, onPage]);
  useEffect(() => () => onPage?.(null), [onPage]);

  const openSource = (target: NonNullable<ArgumentSource["target"]>) => onOpenDoc(target.doc_id, sourceAnchor(target));
  const editLater = t("argument.view.editLater");
  const hasArguments = !!graph && graph.arguments.length > 0;

  return (
    <div className="explore-root" ref={rootRef} data-ui="argument-graph-view" data-ui-key={workId} data-phase={state.phase}>
      <div className="explore-header" data-ui="argument-graph-header">
        <ActionButton unstyled mode="icon" iconName="arrow-left" className="btn icon ghost" data-ui="argument-return-to-library" label={t("argument.view.back")} tooltip={t("argument.view.backTooltip")} onClick={onExit} />
        <div className="explore-context">
          <div className="explore-eyebrow">
            <span>{t("shell.nav.library")}</span>
            <Icon name="chevron-right" cls="ico-sm" />
            <span style={{ color: "var(--accent)" }}>{t("argument.view.breadcrumb")}</span>
          </div>
          <div className="explore-title" data-ui="argument-graph-title" title={heading}>
            {heading}
          </div>
        </div>
        <div className="history-buttons ag-header-actions">
          {graph && (
            <span className="history-count mono" data-ui="argument-graph-counts">
              {t("argument.view.argCount", { n: graph.arguments.length })} · {t("argument.view.edgeCount", { n: graph.edges.length })}
            </span>
          )}
          {hasArguments && <ArgumentAudit findings={findings} describe={describe} onSelect={setSelectedId} />}
          {graph && (
            <ActionButton mode="text" label={t("argument.view.newArg")} tooltip={editLater} data-ui="create-argument" disabled>
              <Icon name="plus" cls="ico-sm" />
              {t("argument.view.newArg")}
            </ActionButton>
          )}
          {hasArguments && <ActionButton unstyled mode="icon" iconName="trash-2" className="btn icon ghost" data-ui="clear-argument-graph" label={t("argument.view.clear")} tooltip={editLater} disabled />}
        </div>
      </div>

      {refreshFailed && (
        <div className="ag-refresh-failed" data-ui="argument-graph-refresh-failed">
          <InlineMessage tone="warning" uiId="argument-graph-refresh-failed-message">
            {t("argument.view.state.refreshFailed")}{" "}
            <ActionButton mode="text" label={t("argument.view.state.retry")} tooltip={t("argument.view.state.retry")} data-ui="retry-argument-graph-refresh" onClick={refresh}>
              {t("argument.view.state.retry")}
            </ActionButton>
          </InlineMessage>
        </div>
      )}

      <div className="view-row ag-view-row" data-layout={layout.panel} data-outline={layout.outlineFolded ? "folded" : "open"}>
        {hasArguments && graph && audit && (layout.outlineFolded ? (
          <ActionButton unstyled mode="icon" iconName="panel-left-open" label={t("argument.view.outline.unfoldSide")} tooltip={t("argument.view.outline.unfoldSide")} data-ui="expand-argument-outline" className="lib-rail" onClick={() => setOutlineFolded(false)} />
        ) : (
          <div className="lib-side wide" data-ui="argument-side">
            <div className="lib-side-head">
              <span className="lib-side-title ag-side-title">{t("argument.view.outline.title")}</span>
              <ActionButton unstyled mode="icon" iconName="panel-left-close" label={t("argument.view.outline.foldSide")} tooltip={t("argument.view.outline.foldSide")} data-ui="collapse-argument-outline" className="lib-side-collapse" onClick={() => setOutlineFolded(true)} />
            </div>
            <ArgumentOutline graph={graph} audit={audit} selectedId={selectedId} onSelect={setSelectedId} openState={outlineOpen} setOpenState={setOutlineOpen} />
          </div>
        ))}

        <div className="lib-main" data-ui="argument-main">
          {state.phase === "loading" && (
            <div className="cg-loading" role="status" aria-live="polite" data-ui="argument-graph-loading">
              <div className="cg-spinner" />
              <div className="cg-loading-t">{t("argument.view.state.loading")}</div>
            </div>
          )}
          {state.phase === "not-found" && (
            <div className="empty-state" role="alert" data-ui="argument-graph-not-found">
              <Icon name="info" cls="ico-lg" />
              <h3>{t("argument.view.state.notFound")}</h3>
              <p>{t("argument.view.state.notFoundHint")}</p>
              <ActionButton mode="text" label={t("argument.view.back")} tooltip={t("argument.view.back")} data-ui="argument-not-found-return" onClick={onExit}>
                {t("argument.view.back")}
              </ActionButton>
            </div>
          )}
          {state.phase === "corrupt" && (
            <div className="empty-state" role="alert" data-ui="argument-graph-corrupt">
              <Icon name="info" cls="ico-lg" />
              <h3>{t("argument.view.state.corrupt")}</h3>
              <p>{t("argument.view.state.corruptHint")}</p>
              <ActionButton mode="text" label={t("argument.view.state.retry")} tooltip={t("argument.view.state.retry")} data-ui="retry-argument-graph" onClick={reload}>
                {t("argument.view.state.retry")}
              </ActionButton>
            </div>
          )}
          {state.phase === "error" && (
            <div className="empty-state" role="alert" data-ui="argument-graph-error">
              <Icon name="info" cls="ico-lg" />
              <h3>{t("argument.view.state.error")}</h3>
              <p>{t(state.unreachable ? "argument.view.state.errorUnreachable" : "argument.view.state.errorOther")}</p>
              <ActionButton mode="text" label={t("argument.view.state.retry")} tooltip={t("argument.view.state.retry")} data-ui="retry-argument-graph" onClick={reload}>
                {t("argument.view.state.retry")}
              </ActionButton>
            </div>
          )}
          {graph && !hasArguments && (
            <div className="empty-state" data-ui="argument-graph-empty">
              <Icon name="workflow" cls="ico-lg" />
              <h3>{t("argument.view.state.emptyTitle")}</h3>
              <p>{t("argument.view.state.emptyHint")}</p>
              <ActionButton mode="text" appearance="primary" label={t("argument.view.newArg")} tooltip={editLater} data-ui="create-first-argument" disabled>
                {t("argument.view.newArg")}
              </ActionButton>
              <p className="record-note">{t("argument.view.state.emptyNote")}</p>
            </div>
          )}
          {graph && hasArguments && <ArgumentGraphCanvas graph={graph} selectedId={selectedId} onSelect={setSelectedId} stash={stash} sceneKey={workId} coverRight={coverRight} />}
        </div>

        {graph && selected && (
          <ArgumentPanel
            key={selected.id}
            graph={graph}
            argument={selected}
            findings={findingsOf(findings, selected.id)}
            describe={describe}
            workDocIds={workDocIds}
            onSelect={setSelectedId}
            onClose={() => setSelectedId(null)}
            onOpenSource={openSource}
            overlay={overlay}
          />
        )}
      </div>
    </div>
  );
}
