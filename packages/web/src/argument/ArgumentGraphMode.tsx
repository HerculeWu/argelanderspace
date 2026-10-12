/**
 * The argument graph view (tickets 04 and 05): a temporary mode of the Library page, the sibling of the explore mode.
 * Header (back, breadcrumb, the work, counts, audit badge, New argument, Clear), the outline on the left, the layered
 * canvas, and the panel on the right. The graph is read from the server and read again whenever the server says it
 * changed; the selection survives that as long as the argument still exists.
 *
 * Editing: every write is a pure edit operation (contracts `argument-edit.ts`) applied by the one commit path
 * (`useArgumentWrites` over `commit.ts`). The only unsaved state is the panel's draft (a new argument, or a form edit);
 * it is guarded here against every way of leaving it: another argument, closing the panel, the back button, a pane
 * switch (the workspace leave guard) and closing the page. Deleting an argument is not confirmed and is undoable for a
 * few seconds; clearing the graph is confirmed.
 */
import { type Argument, type ArgumentDraft, type ArgumentEdge, type ArgumentEdgeRole, type ArgumentGraph, type ArgumentSource, BLANK_ARGUMENT, addEdge, auditArgumentGraph, clearArgumentGraph, createArgument, deleteArgument, removeEdge, restoreArgument, sameArgument, updateArgument } from "@argelanderspace/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { registerWorkspaceLeaveGuard } from "../argelander/workspace";
import { Icon } from "../lib/icons";
import { setOpenArgumentWork } from "../lib/argument-route";
import { useElementWidth } from "../doc/auto-fold";
import { ActionButton, Dialog, InlineMessage } from "../ui";
import type { LibraryRef } from "../library/types";
import { ArgumentAudit } from "./ArgumentAudit";
import { ArgumentGraphCanvas, type ArgumentCanvasStash } from "./ArgumentGraphCanvas";
import { ArgumentOutline, type OutlineOpenState } from "./ArgumentOutline";
import { ArgumentPanel, type PanelSaveOutcome, ROLE_NAME, sourceAnchor } from "./ArgumentPanel";
import { rejectionMessages, serverInvalidText } from "./editText";
import { RoleChooser } from "./RoleChooser";
import { useArgumentWrites } from "./useArgumentWrites";
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
  const { state, reload, refresh, refreshFailed, refreshing, adopt } = useArgumentGraph(workId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const stash = useRef<ArgumentCanvasStash>({}).current;
  const graph = state.phase === "ready" ? state.graph : null;
  const audit = useMemo(() => (graph ? auditArgumentGraph(graph) : null), [graph]);
  const findings = useMemo(() => (audit ? listFindings(audit) : []), [audit]);
  const describe = useFindingText(graph);
  const workDocIds = useMemo(() => work?.doc_ids ?? (work?.doc_id ? [work.doc_id] : []), [work]);
  const selected = graph?.arguments.find((a) => a.id === selectedId) ?? null;
  const heading = workHeading(workId, work);
  const writes = useArgumentWrites({ workId, graph, adopt, refresh });

  // ---- the draft and its protection ------------------------------------------------------------------------ //
  /** A new argument is being written (not in the graph until it is saved). */
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  creatingRef.current = creating;
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const lastSelected = useRef<Argument | null>(null);
  if (selected) lastSelected.current = selected;
  // an argument deleted elsewhere while its form is dirty stays on screen with the draft (the panel says so)
  const panelArgument: Argument | null = creating ? { ...BLANK_ARGUMENT, id: "" } : (selected ?? (selectedId !== null && dirty ? lastSelected.current : null));
  const confirmDiscard = useCallback(() => !dirtyRef.current || window.confirm(t("argument.edit.discardConfirm")), [t]);
  /** Select an argument (or none); a dirty draft is asked about first. */
  const choose = useCallback(
    (id: string | null) => {
      if (id === selectedIdRef.current && !creatingRef.current) return;
      if (!confirmDiscard()) return;
      setCreating(false);
      setSelectedId(id);
    },
    [confirmDiscard]
  );
  useEffect(() => {
    setOpenArgumentWork(workId);
    return () => setOpenArgumentWork(null);
  }, [workId]);
  // leaving the page (a pane switch or close: the workspace guard; the browser's Back: Shell; closing the tab: here)
  useEffect(() => {
    if (!dirty) return;
    const off = registerWorkspaceLeaveGuard(() => window.confirm(t("argument.edit.unsavedLeave")), "library");
    const beforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      off();
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [dirty, t]);
  const exit = () => {
    if (confirmDiscard()) onExit();
  };

  // Narrow pane (user decision 2026-10-12, see layout.ts): an open panel folds the outline, then floats over the canvas.
  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef);
  const [outlineOpen, setOutlineOpen] = useState<OutlineOpenState>(new Map());
  const [userFolded, setUserFolded] = useState(false);
  const [userUnfolded, setUserUnfolded] = useState(false);
  const graphHasArguments = !!graph && graph.arguments.length > 0;
  const panelOpen = panelArgument !== null;
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
  // Closing the panel drops the selection; the keyboard goes back to the node of the argument that was open (never to
  // the page behind), unless the focus was somewhere else on purpose.
  const refocus = useRef<string | null>(null);
  const closePanel = useCallback(() => {
    const active = document.activeElement;
    const inPanel = !!rootRef.current?.querySelector('[data-ui="argument-detail"]')?.contains(active);
    if (!confirmDiscard()) return;
    if (selectedIdRef.current !== null && (inPanel || !active || active === document.body)) refocus.current = selectedIdRef.current;
    setCreating(false);
    setSelectedId(null);
  }, [confirmDiscard]);
  useEffect(() => {
    const id = refocus.current;
    if (selectedId !== null || id === null) return;
    refocus.current = null;
    [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-ui="argument-node"]') ?? [])].find((node) => node.getAttribute("data-ui-key") === id)?.focus();
  }, [selectedId]);
  // Esc closes a floating panel. An open audit list takes the first Esc, and so does any layer above the panel: a modal
  // Dialog (it prevents the default in the capture phase) or the command palette (closed by the Shell's own listener).
  useEffect(() => {
    if (!overlay) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[data-ui="argument-audit-popover"], [data-ui="command-palette"], [role="dialog"][aria-modal="true"]')) return;
      closePanel();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [overlay, closePanel]);

  // the selection follows the argument, not the read: it is dropped only when a graph that was read no longer has it
  useEffect(() => {
    if (graph && selectedId !== null && !dirtyRef.current && !graph.arguments.some((a) => a.id === selectedId)) setSelectedId(null);
  }, [graph, selectedId, dirty]);

  const page = useMemo(() => captureArgumentPage({ workId, title: work?.title ?? workId, graph, phase: state.phase, selectedId, stale: refreshFailed }), [workId, work?.title, graph, state.phase, selectedId, refreshFailed]);
  useEffect(() => {
    onPage?.(page);
  }, [page, onPage]);
  useEffect(() => () => onPage?.(null), [onPage]);

  const openSource = (target: NonNullable<ArgumentSource["target"]>) => onOpenDoc(target.doc_id, sourceAnchor(target));
  const hasArguments = !!graph && graph.arguments.length > 0;

  // ---- writes ------------------------------------------------------------------------------------------------- //
  const undoNotice = useRef<number | null>(null);
  /** A later successful write ends the chance to undo the delete before it (the undo would only find a changed graph). */
  const settleUndo = () => {
    if (undoNotice.current !== null) writes.dismiss(undoNotice.current);
    undoNotice.current = null;
  };
  const saveArgument = async (draft: ArgumentDraft, base: Argument | null, id: string | null): Promise<PanelSaveOutcome> => {
    const current = writes.latest.current;
    // the argument changed (or went) since the form started: nothing is sent, the draft stays, the person reloads first
    if (base) {
      const stored = current?.arguments.find((a) => a.id === base.id);
      if (!stored || !sameArgument(stored, base)) return { kind: "conflict", rev: current?.rev ?? null };
    }
    const outcome = base ? await writes.commit((g) => updateArgument(g, base.id, draft)) : await writes.commit((g) => createArgument(g, draft, id ?? undefined));
    if (outcome.kind === "ok") {
      settleUndo();
      if (!base) {
        const created = "id" in outcome ? (outcome as { id: string }).id : null;
        setCreating(false);
        if (created) setSelectedId(created);
      }
      return { kind: "ok" };
    }
    if (outcome.kind === "conflict") return { kind: "conflict", rev: outcome.rev };
    if (outcome.kind === "rejected") return { kind: "refused", messages: rejectionMessages(t, outcome.rejection) };
    if (outcome.kind === "invalid") return { kind: "refused", messages: serverInvalidText(t, outcome.detail) };
    return { kind: "refused", messages: [writes.failureText(outcome) ?? ""] };
  };
  const startCreate = () => {
    if (creatingRef.current && !dirtyRef.current) return;
    if (!confirmDiscard()) return;
    setSelectedId(null);
    setCreating(true);
  };
  const linkEdge = async (edge: ArgumentEdge) => {
    const outcome = await writes.perform((g) => addEdge(g, edge));
    if (outcome.kind === "ok") settleUndo();
  };
  const unlinkEdge = async (edge: ArgumentEdge) => {
    const outcome = await writes.perform((g) => removeEdge(g, edge));
    if (outcome.kind === "ok") settleUndo();
  };
  const undoDelete = async (removed: Parameters<typeof restoreArgument>[1], after: ArgumentGraph) => {
    // applied to the graph the delete produced, at its rev: a graph changed since then is a conflict, never overwritten
    const outcome = await writes.commit((g) => restoreArgument(g, removed), after);
    if (outcome.kind === "ok") {
      writes.notify("info", t("argument.edit.undone", { title: removed.argument.title }));
      setSelectedId(removed.argument.id);
    } else if (outcome.kind === "conflict") writes.notify("danger", t("argument.edit.undoFailedChanged"), { ttl: 0 });
    else writes.notify("danger", writes.failureText(outcome) ?? "");
  };
  const removeArgument = async (id: string) => {
    if (!confirmDiscard()) return;
    const outcome = await writes.perform((g) => deleteArgument(g, id));
    if (outcome.kind !== "ok") return;
    settleUndo();
    setCreating(false);
    setSelectedId(null);
    const { removed } = outcome;
    undoNotice.current = writes.notify("info", t("argument.edit.deleted", { title: removed.argument.title, e: removed.edges.length }), {
      ttl: 8000,
      action: { label: t("argument.edit.undo"), run: () => void undoDelete(removed, outcome.graph) },
    });
  };

  // a drag on the canvas: the role is chosen where it was dropped
  const [chooser, setChooser] = useState<{ from: string; to: string; at: { x: number; y: number } } | null>(null);
  const connect = useCallback(
    (from: string, to: string, at: { x: number; y: number }) => {
      if (from === to) {
        writes.notify("warning", t("argument.edit.selfLoop"));
        return;
      }
      setChooser({ from, to, at });
    },
    [writes.notify, t]
  );
  const roleName = (r: ArgumentEdgeRole) => ROLE_NAME[r];

  // clearing the whole graph is confirmed
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const cancelClearRef = useRef<HTMLButtonElement>(null);
  const clearGraph = async () => {
    setClearing(true);
    setClearError(null);
    const outcome = await writes.commit((g) => clearArgumentGraph(g));
    setClearing(false);
    if (outcome.kind === "ok") {
      settleUndo();
      setClearOpen(false);
      setCreating(false);
      setSelectedId(null);
    } else setClearError(writes.failureText(outcome) ?? "");
  };

  return (
    <div className="explore-root" ref={rootRef} data-ui="argument-graph-view" data-ui-key={workId} data-phase={state.phase}>
      <div className="explore-header" data-ui="argument-graph-header">
        <ActionButton unstyled mode="icon" iconName="arrow-left" className="btn icon ghost" data-ui="argument-return-to-library" label={t("argument.view.back")} tooltip={t("argument.view.backTooltip")} onClick={exit} />
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
          {hasArguments && <ArgumentAudit findings={findings} describe={describe} onSelect={choose} />}
          {graph && (
            <ActionButton mode="text" label={t("argument.view.newArg")} tooltip={t("argument.edit.newArgTooltip")} data-ui="create-argument" onClick={startCreate}>
              <Icon name="plus" cls="ico-sm" />
              {t("argument.view.newArg")}
            </ActionButton>
          )}
          {hasArguments && (
            <ActionButton
              unstyled
              mode="icon"
              iconName="trash-2"
              className="btn icon ghost"
              data-ui="clear-argument-graph"
              label={t("argument.view.clear")}
              tooltip={t("argument.edit.clearTooltip")}
              onClick={() => {
                if (!confirmDiscard()) return;
                setClearError(null);
                setClearOpen(true);
              }}
            />
          )}
        </div>
      </div>

      {refreshFailed && (
        <div className="ag-refresh-failed" data-ui="argument-graph-refresh-failed">
          <InlineMessage tone="warning" uiId="argument-graph-refresh-failed-message">
            {t("argument.view.state.refreshFailed")}{" "}
            <ActionButton mode="text" label={t("argument.view.state.retry")} tooltip={t("argument.view.state.retry")} data-ui="retry-argument-graph-refresh" busy={refreshing} busyLabel={t("argument.view.state.retrying")} onClick={refresh}>
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
            <ArgumentOutline graph={graph} audit={audit} selectedId={selectedId} onSelect={choose} openState={outlineOpen} setOpenState={setOutlineOpen} />
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
              <ActionButton mode="text" appearance="primary" label={t("argument.view.newArg")} tooltip={t("argument.edit.newArgTooltip")} data-ui="create-first-argument" onClick={startCreate}>
                {t("argument.view.newArg")}
              </ActionButton>
            </div>
          )}
          {graph && hasArguments && <ArgumentGraphCanvas graph={graph} selectedId={selectedId} onSelect={choose} stash={stash} sceneKey={workId} coverRight={coverRight} onConnect={connect} />}
        </div>

        {graph && panelArgument && (
          <ArgumentPanel
            key={creating ? "new" : panelArgument.id}
            graph={graph}
            argument={panelArgument}
            isNew={creating}
            findings={creating ? [] : findingsOf(findings, panelArgument.id)}
            describe={describe}
            workDocIds={workDocIds}
            onSelect={choose}
            onClose={closePanel}
            onOpenSource={openSource}
            overlay={overlay}
            busy={writes.writing}
            onSave={saveArgument}
            onDiscardNew={() => {
              setCreating(false);
            }}
            onDelete={() => void removeArgument(panelArgument.id)}
            onAddEdge={(e) => void linkEdge(e)}
            onRemoveEdge={(e) => void unlinkEdge(e)}
            onReload={writes.reload}
            onDirtyChange={setDirty}
          />
        )}
      </div>

      {chooser && graph && (
        <RoleChooser
          from={graph.arguments.find((a) => a.id === chooser.from)?.title ?? chooser.from}
          to={graph.arguments.find((a) => a.id === chooser.to)?.title ?? chooser.to}
          at={chooser.at}
          taken={new Set(graph.edges.filter((e) => e.from === chooser.from && e.to === chooser.to).map((e) => e.role))}
          roleName={roleName}
          onCancel={() => setChooser(null)}
          onChoose={(role) => {
            const edge = { from: chooser.from, to: chooser.to, role };
            setChooser(null);
            void linkEdge(edge);
          }}
        />
      )}

      {clearOpen && graph && (
        <Dialog
          title={t("argument.edit.clearTitle")}
          uiId="clear-argument-graph-dialog"
          closeLabel={t("argument.view.panel.close")}
          onClose={() => setClearOpen(false)}
          width={420}
          busy={clearing}
          initialFocusRef={cancelClearRef}
          footer={
            <>
              <ActionButton ref={cancelClearRef} mode="text" label={t("argument.edit.cancel")} tooltip={t("argument.edit.cancel")} data-ui="cancel-clear-argument-graph" onClick={() => setClearOpen(false)}>
                {t("argument.edit.cancel")}
              </ActionButton>
              <ActionButton mode="text" appearance="primary" tone="danger" label={t("argument.edit.clearConfirm")} tooltip={t("argument.edit.clearConfirm")} data-ui="confirm-clear-argument-graph" busy={clearing} busyLabel={t("argument.edit.clearing")} onClick={() => void clearGraph()}>
                {t("argument.edit.clearConfirm")}
              </ActionButton>
            </>
          }
        >
          <p>{t("argument.edit.clearBody", { n: graph.arguments.length, e: graph.edges.length })}</p>
          {clearError && <InlineMessage tone="danger" uiId="clear-argument-graph-error">{clearError}</InlineMessage>}
        </Dialog>
      )}

      <div className="ag-notices" role="region" aria-label={t("argument.edit.notices")} aria-live="polite" data-ui="argument-notices">
        {writes.notices.map((n) => (
          <InlineMessage key={n.id} tone={n.tone} uiId="argument-notice">
            <span className="ag-notice-row">
              <span>{n.text}</span>
              {n.action && (
                <ActionButton
                  mode="text"
                  label={n.action.label}
                  tooltip={n.action.label}
                  data-ui="argument-notice-action"
                  onClick={() => {
                    writes.dismiss(n.id);
                    n.action?.run();
                  }}
                >
                  {n.action.label}
                </ActionButton>
              )}
              <ActionButton unstyled mode="icon" iconName="x" className="btn icon ghost" data-ui="dismiss-argument-notice" label={t("argument.edit.dismiss")} tooltip={t("argument.edit.dismiss")} onClick={() => writes.dismiss(n.id)} />
            </span>
          </InlineMessage>
        ))}
      </div>
    </div>
  );
}
