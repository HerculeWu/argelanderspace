import { DiscoverySavedViewActionSchema, APPEARANCE_DENSITIES, APPEARANCE_LANGUAGES, APPEARANCE_THEMES, type CopilotViewAction, MAX_PANES, type PageContext, SETTINGS_VIEW, WorkspaceViewActionSchema } from "@argelanderspace/contracts";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { ActionButton } from "../ui";
import { fetchPapers } from "../api";
import { DEFAULT_LANGUAGE } from "../i18n";
import { resizeDivider, shareOf } from "./layout";
import { createWorkspaceState, pageFields, type Pane, type PaneAdapter, type ViewActionOutcome, windowBrowser, windowTimers, workspaceLeave, type WorkspaceState } from "./panes";
import { PreferencesProvider, usePreferencesState } from "./preferences";
import { ACCENTS } from "./theme";
import { notePane } from "../page-errors";
import { claimViewId, loadViewIdentity, saveViewIdentity } from "./view-identity";
import { WorkspaceProvider, type Workspace } from "./workspace";
import { CommandPalette } from "./CommandPalette";
import { TweaksPopover } from "./TweaksPopover";
import { DecorativeWindowControls } from "./WindowControls";
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
import { ProjectSwitchPrompt } from "../welcome/ProjectSwitch";
import { SettingsNotices, SettingsView } from "../settings/SettingsView";
import { createSettingsPane } from "../settings/settings-pane";
import { TutorialLayer } from "../tutorial";

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
  // Opening the panel with its toggle puts the cursor in its input (the panel is after the whole page in tab order).
  const focusCopilotInput = useRef(false);
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

  // The workspace (panes/): the panes and each pane's page as the Copilot sees it, the paper list, the current Doc, the
  // Copilot panel's state, the boot deep link and Back/Forward, and the Copilot's workspace actions. The Shell renders
  // from its snapshot and acknowledges each one it committed (the layout effect below).
  const [store] = useState(() =>
    createWorkspaceState({
      initial: { panes: [{ id: INITIAL_PANE_ID, view: "plan", size: 1 }], activeId: INITIAL_PANE_ID },
      pages: (docHost) => [createPlanPane(noChange).adapter, createLibraryPane(noChange).adapter, createDocPane(noChange, docHost).adapter, createWriterPane(noChange).adapter, createMailPane(noChange).adapter, createSettingsPane().adapter],
      browser: windowBrowser(),
      timers: windowTimers(),
      leave: workspaceLeave,
      fetchPapers,
      // a stable function of the preferences (preferences.tsx): the first render's is every render's
      setTweak,
    })
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getState);
  const { panes, activeId, pagesVersion, papers, currentDoc, pendingAnchor, copilotOpen } = snapshot;
  // Committed, the whole tree included (the Copilot panel has this render's PageContext): a workspace action waiting for it may answer.
  useLayoutEffect(() => store.rendered(snapshot), [store, snapshot]);
  useEffect(() => store.start(), [store]);
  const { select: setActiveId, setActiveView, setPaneView, split: splitFrom, close: closePane, setCopilotOpen } = store;
  useEffect(() => {
    if (!copilotOpen || !focusCopilotInput.current) return;
    focusCopilotInput.current = false;
    document.querySelector<HTMLTextAreaElement>('[data-ui="copilot-input"]')?.focus();
  }, [copilotOpen]);

  // Approving a manuscript delete would discard unsaved edits of an open editor (or its Info/Preamble dialog): ask first.
  const beforeManuscriptDelete = useCallback((manuscriptId: string) => {
    return manuscriptDeleteGuard(store.mounted("write").map((writer) => writer.context().writer), manuscriptId, () => window.confirm(t("copilot.confirmation.manuscriptDraftGuard")));
  }, [t, store]);
  // The workspace's guards before a Copilot approval takes something open away; a refusal keeps the card.
  const confirmationGuards = useMemo<ConfirmationGuards>(() => ({
    // Only the open Doc asks the workspace's leave guard (unsaved drafts), as the delete dialog does.
    leaveDoc: store.leaveDoc,
    leaveManuscript: beforeManuscriptDelete,
  }), [store, beforeManuscriptDelete]);

  const panesRef = useRef<HTMLDivElement>(null);
  const multi = panes.length > 1;
  const activePane = panes.find((p) => p.id === activeId) || panes[0]!;
  // A page error is reported with the name of the pane that was open (page-errors.ts). Said here, while rendering,
  // and not in an effect: when a page throws in its first render this render is never committed and no effect runs.
  // With several panes side by side it is the active one.
  notePane(activePane.view);

  // ---- Copilot view actions (ticket 12) -------------------------------------------------------- //
  // Workspace actions are the workspace's (panes/workspace-state.ts); a page's own actions go to its pane adapter
  // through the pane manager (panes/).
  const runViewAction = useCallback(async (action: CopilotViewAction): Promise<ViewActionOutcome> => {
    // The service tells the bound view that a Doc was deleted through the Copilot: the same three-state Shell
    // update the Library page makes after its own delete (not model-callable; it is no tool action).
    if (action.action === "doc_deleted") {
      store.docDeleted(action.docId, action.remaining);
      return { ok: true };
    }
    // The service saved a candidate: every Library pane that holds that node marks it saved in place (a pane that is
    // not exploring ignores it). It never opens or switches anything.
    const saved = DiscoverySavedViewActionSchema.safeParse(action);
    if (saved.success) {
      for (const library of store.mounted("library")) void library.apply?.(saved.data);
      return { ok: true };
    }
    const workspaceAction = WorkspaceViewActionSchema.safeParse(action);
    if (workspaceAction.success) return store.runWorkspaceAction(workspaceAction.data);
    if (action.action === "open_task_doc") return store.openDocAction(action.docId);
    // Every page action (Plan, Library and Discovery, Reader and PDF, Writer) goes to the adapter that handles it.
    return store.runViewAction(action);
  }, [store]);

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
      store.update((ps) => ps.map((p, idx) => ({ ...p, size: sizes[idx] ?? p.size })));
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

  // The settings page's entries: the provider dialog belongs to the Copilot panel (asked for by a counter it watches),
  // the accounts to the Mail view.
  const [providerSettingsAsked, setProviderSettingsAsked] = useState(0);
  const openCopilotSettings = useCallback(() => {
    setCopilotOpen(true);
    setProviderSettingsAsked((n) => n + 1);
  }, [setCopilotOpen]);
  const openMailAccounts = useCallback(() => setActiveView("mail"), [setActiveView]);
  const workspace: Workspace = useMemo(
    () => ({ papers, currentDoc, setCurrentDoc: store.setCurrentDoc, openDoc: store.openDoc, pendingAnchor, clearPendingAnchor: store.clearPendingAnchor, docDeleted: store.docDeleted, openArgumentGraph: store.openArgumentGraph, openCopilotSettings, openMailAccounts, tweaks }),
    [papers, currentDoc, store, pendingAnchor, openCopilotSettings, openMailAccounts, tweaks]
  );

  // The page fields and status are the active pane's page adapter's (`pagesVersion` changes with what pages report).
  const pageContext = useMemo<PageContext>(() => {
    const page = store.pageOf(activePane);
    const fields = page?.context() ?? {};
    return {
      version: 1, viewId, revision: ++revision.current, paneId: activePane.id, view: activePane.view,
      otherPanes: panes.filter((pane) => pane.id !== activePane.id).map((pane) => ({ paneId: pane.id, view: pane.view })),
      // Example data (or a Library still loading / replaced by Discovery) is never reported as complete.
      status: page?.status() ?? "unavailable",
      // plan, library, discovery, argument, reader, pdf, textSource, writer, mail (panes/adapter.ts)
      ...pageFields(fields),
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
  }, [store, viewId, activePane.id, activePane.view, panes, pagesVersion, tweaks, copilotOpen]);
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
              <ActionButton mode="icon" iconName="panel-right-open" unstyled className="btn icon ghost" iconSize="small" data-ui="copilot-toggle" label={copilotWaiting && !copilotOpen ? t("copilot.waitingToggle") : t("copilot.title")} tooltip={copilotWaiting && !copilotOpen ? t("copilot.waitingToggle") : t("copilot.title")} aria-expanded={copilotOpen} onClick={() => { const open = !store.getState().copilotOpen; focusCopilotInput.current = open; setCopilotOpen(open); }} />
              {copilotWaiting && !copilotOpen && <span className="copilot-toggle-dot" data-ui="copilot-attention" aria-hidden="true" />}
            </span>
            {tweaksOpen && (
              <TweaksPopover tweaks={tweaks} set={setTweak} onClose={() => setTweaksOpen(false)} />
            )}
            <DecorativeWindowControls />
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
                  render={() => <PaneHost key={p.view} pane={p} store={store} />}
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
        <SettingsNotices notices={preferences.notices} dismiss={preferences.dismiss} notify={preferences.notify} configFile={preferences.settings?.file} />
        <ProjectSwitchPrompt notify={preferences.notify} />
        <TutorialLayer context={pageContext} onViewAction={runViewAction} />
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
function PaneHost({ pane, store }: { pane: Pane; store: WorkspaceState }) {
  const [page] = useState(() => mountPage(pane.view, store.changed, store.docHost));
  useEffect(() => store.register(pane.id, page.adapter), [store, pane.id, page]);
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
