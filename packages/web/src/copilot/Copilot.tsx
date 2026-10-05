import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Conversation, ConversationModel, CopilotConfirmation, ConversationSnapshot, CopilotOperation, CopilotProvider, CopilotViewAction, CopilotViewActionResult, PageContext, ThinkingLevel, WsCopilotEvent } from "@argelanderspace/contracts";
import { summarizeDiscoveryPage, summarizeReaderPage, summarizeWriterPage } from "@argelanderspace/contracts";
import { CopilotApiError, createConversation, decideConfirmation, fetchConversation, listConversations, postViewActionResult, publishPageContext, resumeConversation, selectConversationModel, sendCopilotMessage, uploadAttachment, removeAttachment, stopConversation, undoOperation } from "../api/copilot";
import { fmtDate } from "../plan/model";
import { fetchProviders } from "../api/providers";
import { subscribeCopilot } from "../api/ws";
import { ActionButton, Badge, Button, Dialog, getConfiguredIcon } from "../ui";
import { ProviderSettingsDialog } from "./ProviderSettings";
import { Icon } from "../lib/icons";
import { copilotMarkdown } from "./markdown";
import "./copilot.css";

export const OPERATION_ACTION_KEYS = {
  read: "copilot.operations.actions.read", create_plan: "copilot.operations.actions.create_plan", update_plan: "copilot.operations.actions.update_plan",
  create_task: "copilot.operations.actions.create_task", update_task: "copilot.operations.actions.update_task", add_task_link: "copilot.operations.actions.add_task_link",
  remove_task_link: "copilot.operations.actions.remove_task_link", move_task: "copilot.operations.actions.move_task", show: "copilot.operations.actions.show",
  open_task: "copilot.operations.actions.open_task", close_task: "copilot.operations.actions.close_task",
  provider_status: "copilot.operations.actions.provider_status", select_model: "copilot.operations.actions.select_model", open_copilot: "copilot.operations.actions.open_copilot", close_copilot: "copilot.operations.actions.close_copilot", open_doc: "copilot.operations.actions.open_doc",
  set_completed: "copilot.operations.actions.set_completed", open_task_doc: "copilot.operations.actions.open_task_doc", capabilities: "copilot.operations.actions.capabilities",
  switch_view: "copilot.operations.actions.switch_view", split_pane: "copilot.operations.actions.split_pane", close_pane: "copilot.operations.actions.close_pane", select_pane: "copilot.operations.actions.select_pane",
  resize_pane: "copilot.operations.actions.resize_pane", set_appearance: "copilot.operations.actions.set_appearance", open_copilot_settings: "copilot.operations.actions.open_copilot_settings",
  delete_plan: "copilot.operations.actions.delete_plan", delete_task: "copilot.operations.actions.delete_task",
  set_main_doc: "copilot.operations.actions.set_main_doc", filter_library: "copilot.operations.actions.filter_library", select_work: "copilot.operations.actions.select_work",
  set_detail_tab: "copilot.operations.actions.set_detail_tab", set_sidebar: "copilot.operations.actions.set_sidebar", set_temp_label: "copilot.operations.actions.set_temp_label",
  set_graph_labels: "copilot.operations.actions.set_graph_labels", graph_control: "copilot.operations.actions.graph_control", import_works: "copilot.operations.actions.import_works",
  acquire_arxiv_pdf: "copilot.operations.actions.acquire_arxiv_pdf", attach_arxiv: "copilot.operations.actions.attach_arxiv", read_jobs: "copilot.operations.actions.read_jobs", delete_doc: "copilot.operations.actions.delete_doc", upload_pdf: "copilot.operations.actions.upload_pdf", upload_latex_zip: "copilot.operations.actions.upload_latex_zip", replace_upload_source: "copilot.operations.actions.replace_upload_source",
  read_discovery: "copilot.operations.actions.read_discovery", save_candidate: "copilot.operations.actions.save_candidate", explore_work: "copilot.operations.actions.explore_work", explore_candidate: "copilot.operations.actions.explore_candidate",
  retry_exploration: "copilot.operations.actions.retry_exploration", cancel_exploration: "copilot.operations.actions.cancel_exploration", step_exploration: "copilot.operations.actions.step_exploration", exit_exploration: "copilot.operations.actions.exit_exploration",
  resume_exploration: "copilot.operations.actions.resume_exploration", filter_discovery: "copilot.operations.actions.filter_discovery", search_discovery: "copilot.operations.actions.search_discovery", set_discovery_display: "copilot.operations.actions.set_discovery_display",
  select_candidate: "copilot.operations.actions.select_candidate", set_discovery_tab: "copilot.operations.actions.set_discovery_tab", dismiss_discovery_error: "copilot.operations.actions.dismiss_discovery_error", view_candidate_in_library: "copilot.operations.actions.view_candidate_in_library",
  set_discovery_graph_labels: "copilot.operations.actions.set_discovery_graph_labels", discovery_graph_control: "copilot.operations.actions.discovery_graph_control",
  navigate: "copilot.operations.actions.navigate", jump_back: "copilot.operations.actions.jump_back", set_panel: "copilot.operations.actions.set_panel", set_right_tab: "copilot.operations.actions.set_right_tab", retry_sync: "copilot.operations.actions.retry_sync",
  create_annotation: "copilot.operations.actions.create_annotation", update_annotation: "copilot.operations.actions.update_annotation", delete_annotation: "copilot.operations.actions.delete_annotation",
  create_manuscript: "copilot.operations.actions.create_manuscript", update_manuscript: "copilot.operations.actions.update_manuscript", delete_manuscript: "copilot.operations.actions.delete_manuscript", open_manuscript: "copilot.operations.actions.open_manuscript", close_manuscript: "copilot.operations.actions.close_manuscript",
} as const;
const OPERATION_STATUS_KEYS = {
  ok: "copilot.operations.status.ok", noop: "copilot.operations.status.noop", conflict: "copilot.operations.status.conflict", not_found: "copilot.operations.status.not_found",
  rejected: "copilot.operations.status.rejected", invalid: "copilot.operations.status.invalid", not_displayed: "copilot.operations.status.not_displayed",
  unsupported: "copilot.operations.status.unsupported", unknown: "copilot.operations.status.unknown", error: "copilot.operations.status.error",
  confirmation_required: "copilot.operations.status.confirmation_required", declined: "copilot.operations.status.declined", expired: "copilot.operations.status.expired", pending: "copilot.operations.status.pending",
} as const;
const THINKING_KEYS = { off: "copilot.thinkingLevels.off", minimal: "copilot.thinkingLevels.minimal", low: "copilot.thinkingLevels.low", medium: "copilot.thinkingLevels.medium", high: "copilot.thinkingLevels.high", xhigh: "copilot.thinkingLevels.xhigh", max: "copilot.thinkingLevels.max" } as const;
const RUN_STATUS_KEYS = { "waiting-for-user": "copilot.status.waiting-for-user", running: "copilot.status.running", stopping: "copilot.status.stopping", completed: "copilot.status.completed", failed: "copilot.status.failed", stopped: "copilot.status.stopped", interrupted: "copilot.status.interrupted" } as const;
const STORED_CONVERSATION = "argelander.copilot.conversation";
// A per-viewer convenience only: the saved conversations are authoritative, this just remembers which one this browser was showing.
const readStoredConversation = () => { try { return window.localStorage.getItem(STORED_CONVERSATION); } catch { return null; } };
const writeStoredConversation = (id: string) => { try { window.localStorage.setItem(STORED_CONVERSATION, id); } catch { /* private window or blocked storage */ } };
/** What the Library page carried: where the data came from, how much, which filter and which open work. */
function LibrarySummary({ summary, title }: { summary: { source: "live" | "demo" | "error"; error?: string; query: string; total: number; matched: number; selectedRefId: string | null }; title?: string }) {
  const { t } = useTranslation();
  return <div className="copilot-library-summary" data-ui="copilot-library-summary">
    <p>{summary.source === "live" ? t("copilot.library.live") : summary.source === "demo" ? t("copilot.library.demo") : t("copilot.library.error", { reason: summary.error ?? "" })}</p>
    <p>{t("copilot.library.counts", { matched: summary.matched, total: summary.total })}{summary.query && ` · ${t("copilot.library.query", { query: summary.query })}`}</p>
    {summary.selectedRefId && <p>{t("copilot.library.open", { title: title ?? summary.selectedRefId })}</p>}
  </div>;
}

/** What the exploration carried (copilot ticket 17): its state, origin, how many papers and which filter/candidate. */
function DiscoverySummary({ summary }: { summary: { state: "ready" | "loading" | "error"; seed: string | null; filter: "all" | "related" | "useful"; shown: number; total: number; selectedBibcode: string | null } }) {
  const { t } = useTranslation();
  return <div className="copilot-library-summary" data-ui="copilot-discovery-summary">
    <p>{t(`copilot.discovery.${summary.state}`)}{summary.seed && ` · ${t("copilot.discovery.seed", { bibcode: summary.seed })}`}</p>
    <p>{t("copilot.discovery.counts", { shown: summary.shown, total: summary.total })}{summary.filter !== "all" && ` · ${t("copilot.discovery.filter", { filter: t(`explore.filter.${summary.filter}`) })}`}</p>
    {summary.selectedBibcode && <p>{t("copilot.discovery.open", { bibcode: summary.selectedBibcode })}</p>}
  </div>;
}

/** What the Reader carried (copilot ticket 18): which Doc, whether a reading was sent, how much, and the user's place and selection. */
function ReaderSummary({ summary, title }: { summary: { docId: string; phase: "ready" | "syncing" | "error" | "missing"; sections: number; blocks: number; references: number; annotations: number; selection: boolean; activeSectionId: string | null; activeSectionLabel?: string }; title?: string }) {
  const { t } = useTranslation();
  return <div className="copilot-library-summary" data-ui="copilot-reader-summary">
    <p>{t(`copilot.reader.${summary.phase}`, { id: title ?? summary.docId })}</p>
    {summary.phase === "ready" && <p>{t("copilot.reader.counts", { sections: summary.sections, blocks: summary.blocks, references: summary.references, annotations: summary.annotations })}</p>}
    {summary.phase === "ready" && summary.activeSectionId && <p>{t("copilot.reader.position", { section: summary.activeSectionLabel ?? summary.activeSectionId })}</p>}
    {summary.selection && <p>{t("copilot.reader.selection")}</p>}
  </div>;
}

/** What the Writer carried (copilot ticket 22): the list or one manuscript, what was sent whole, and whether unsaved edits went along as a draft. */
function WriterSummary({ summary, title }: { summary: { mode: "list" | "editor"; manuscriptId: string | null; title: string | null; phase: "loading" | "ready" | "missing" | "error"; rev: number | null; cells: number; comments: number; manuscripts: number; draft: boolean; unsupportedCells: number }; title?: string }) {
  const { t } = useTranslation();
  const named = summary.title ?? title ?? summary.manuscriptId ?? "";
  return <div className="copilot-library-summary" data-ui="copilot-writer-summary">
    <p>{summary.mode === "list" ? t(summary.phase === "ready" ? "copilot.writer.list" : summary.phase === "error" ? "copilot.writer.listError" : "copilot.writer.listLoading") : summary.phase === "ready" ? t("copilot.writer.editor", { title: named }) : t(summary.phase === "missing" ? "copilot.writer.missing" : "copilot.writer.loading", { id: summary.manuscriptId ?? "" })}</p>
    {summary.mode === "list" && summary.phase === "ready" && <p>{t("copilot.writer.listCounts", { count: summary.manuscripts })}</p>}
    {summary.mode === "editor" && summary.phase === "ready" && <p>{t("copilot.writer.counts", { rev: summary.rev ?? 0, cells: summary.cells, comments: summary.comments })}</p>}
    {summary.draft && <p data-ui="copilot-writer-draft">{t("copilot.writer.draft")}</p>}
    {summary.unsupportedCells > 0 && <p>{t("copilot.writer.unsupported", { count: summary.unsupportedCells })}</p>}
  </div>;
}

const isApplied = (operation: CopilotOperation) => operation.status === "ok" || operation.status === "noop";

export type CopilotViewActionHandler = (action: CopilotViewAction) => Promise<Pick<CopilotViewActionResult, "ok" | "detail" | "http">>;

interface Draft { key: string; name: string; file: File; status: "uploading" | "ready" | "failed"; id?: string; /** The conversation it belongs to (null until the first upload creates one). */ conversationId: string | null; /** Why it failed: too big or not acceptable means retrying cannot help. */ reason?: "retry" | "final" }
export function Copilot({ open, context, onClose, onViewAction, onOpenPanel, viewReady = true, onAttention, onBeforeDocDelete }: { open: boolean; /** The page's own guard before a Doc delete takes the open Doc away (unsaved draft protection); false keeps the card. */ onBeforeDocDelete?: (docId: string) => boolean; context: PageContext; onClose: () => void; onViewAction?: CopilotViewActionHandler; /** Shows the panel itself: an explicit request to open its settings must be visible. */ onOpenPanel?: () => void; /** False until this tab knows its view id is its own: nothing subscribes or publishes before. */ viewReady?: boolean; /** True while a confirmation waits for the user, so a collapsed panel can say so. */ onAttention?: (waiting: boolean) => void }) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [providers, setProviders] = useState<CopilotProvider[]>([]);
  const [draftModel, setDraftModel] = useState<ConversationModel | null>(null);
  const [text, setText] = useState("");
  // Files the user is handing over with the next message (prototype A: the plus button and the removable chips).
  const [files, setFiles] = useState<Draft[]>([]);
  const picker = useRef<HTMLInputElement>(null);
  const dropped = useRef(new Set<string>());
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [settings, setSettings] = useState(false);
  const [list, setList] = useState(false);
  const [detail, setDetail] = useState(false);
  const [newContent, setNewContent] = useState(false);
  const scroll = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const retry = useRef<{ id: string; text: string; clientMessageId: string } | null>(null);
  const loaded = useRef(false);
  const refreshCurrent = useRef<(() => Promise<void>) | null>(null);
  const [unreadable, setUnreadable] = useState<{ id: string; code: string }[]>([]);
  const resumeAttempt = useRef<string | null>(null);
  // One serial chain carries every page publication and every send. What is published is whatever is newest when
  // its turn comes, so scroll bursts collapse and a message always names the revision the service already holds.
  const latestContext = useRef(context); latestContext.current = context;
  const publishChain = useRef<Promise<unknown>>(Promise.resolve());
  const publishQueued = useRef(false);
  const published = useRef<{ viewId: string; revision: number } | null>(null);
  const enqueue = <T,>(task: () => Promise<T>): Promise<T> => { const run = publishChain.current.then(task, task); publishChain.current = run.catch(() => undefined); return run; };
  // The Reader's reading the service already holds for this view: a later page that only scrolled is sent by reference.
  const sentReading = useRef<string | null>(null);
  const readingId = (page: PageContext) => { const reading = page.reader?.reading; return reading ? `${page.viewId}|${reading.docId}|${reading.epoch.fingerprint}|${reading.epoch.annotationsRev}` : null; };
  const publishLatest = async () => {
    const next = latestContext.current, done = published.current;
    if (done?.viewId === next.viewId && done.revision === next.revision) return next;
    const id = readingId(next);
    const reading = next.reader?.reading;
    if (id && id === sentReading.current && next.reader && reading) {
      const { reading: _held, ...rest } = next.reader;
      try {
        await publishPageContext({ ...next, reader: { ...rest, reading: null, readingRef: { fingerprint: reading.epoch.fingerprint, annotationsRev: reading.epoch.annotationsRev } } });
      } catch (reason) {
        // the service holds no such reading (restart, another view): send it whole
        if (!(reason instanceof CopilotApiError && reason.code === "stale")) throw reason;
        sentReading.current = null; await publishPageContext(next);
      }
    } else await publishPageContext(next);
    sentReading.current = id; published.current = { viewId: next.viewId, revision: next.revision }; return next;
  };
  const settlePublished = async () => {
    for (let round = 0; round < 6; round++) {
      const before = latestContext.current.revision;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (latestContext.current.revision === before) break;
    }
    await enqueue(publishLatest).catch(() => undefined);
  };
  const viewActionRef = useRef(onViewAction); viewActionRef.current = onViewAction;
  const openPanelRef = useRef(onOpenPanel); openPanelRef.current = onOpenPanel;
  const handledActions = useRef(new Set<string>());
  useEffect(() => {
    if (!id || !viewReady || publishQueued.current) return;
    publishQueued.current = true;
    void enqueue(async () => { publishQueued.current = false; await publishLatest(); }).catch((reason) => setError(reason instanceof CopilotApiError ? reason.code : "unavailable"));
  }, [id, context, viewReady]);
  // A restarted service knows no views: forget what was published and send the current page again.
  const republish = () => { published.current = null; sentReading.current = null; void enqueue(publishLatest).catch(() => undefined); };
  const refreshCatalog = async () => {
    try {
      const result = await fetchProviders(); setProviders(result.providers);
      const provider = result.providers.find((item) => item.credential.configured && item.models.some((model) => model.tools));
      const model = provider?.models.find((item) => item.tools);
      if (provider && model) setDraftModel((current) => current ?? { provider: provider.id, model: model.id, thinking: null });
    } catch { setError("unavailable"); }
  };
  const refreshList = async () => {
    try { const result = await listConversations(); setConversations(result.conversations); setUnreadable(result.unreadable ?? []); return result.conversations; }
    catch { setError("storage"); return []; }
  };
  useEffect(() => {
    // A closed panel still loads the conversation this browser remembers, so a waiting confirmation can be signalled.
    if (loaded.current || (!open && !readStoredConversation())) return;
    loaded.current = true;
    void refreshCatalog();
    void refreshList().then((items) => {
      // F5 returns to the conversation this browser was showing; otherwise the most recently updated one.
      const remembered = readStoredConversation();
      const chosen = items.find((item) => item.id === remembered) ?? items[0];
      if (chosen) setId((previous) => previous ?? chosen.id);
    });
  }, [open]);
  useEffect(() => { if (id) writeStoredConversation(id); }, [id]);
  useEffect(() => {
    if (!id || !viewReady) return;
    let alive = true, syncing = true, generation = 0, transportConnected = true;
    let buffer: WsCopilotEvent[] = [];
    let cursor: ConversationSnapshot["eventCursor"] | null = null;
    setSnapshot(null); setConnected(false); setError(null);
    following.current = true; setNewContent(false);
    const apply = (event: WsCopilotEvent) => {
      if (syncing) { buffer.push(event); return; }
      if (!cursor || event.eventCursor.instanceId !== cursor.instanceId) { void refresh(); return; }
      if (event.eventCursor.seq <= cursor.seq) return;
      cursor = event.eventCursor;
      if (event.kind === "stream") setSnapshot((current) => current ? { ...current, stream: event.text ?? "", eventCursor: event.eventCursor } : current);
      else void refresh();
    };
    const refresh = async () => {
      const current = ++generation; syncing = true;
      try {
        const result = await fetchConversation(id);
        if (!alive || current !== generation) return;
        cursor = result.eventCursor; setSnapshot(result); setConnected(transportConnected); setError(null); syncing = false;
        const queued = buffer; buffer = []; queued.forEach(apply);
      } catch (reason) {
        if (alive && current === generation) { setError(reason instanceof CopilotApiError ? reason.code : "unavailable"); setConnected(false); }
      }
    };
    refreshCurrent.current = refresh;
    const unsubscribe = subscribeCopilot({ conversationId: id, viewId: context.viewId, event: apply,
      viewAction: (message) => {
        // A reconnect can redeliver; an action runs once and its outcome is reported by what the page really did.
        if (handledActions.current.has(message.actionId)) return;
        handledActions.current.add(message.actionId);
        void (async () => {
          // The provider settings dialog is this panel's own: opening it only shows the dialog, the user types any secret there.
          if (message.action.action === "open_copilot_settings") { openPanelRef.current?.(); setSettings(true); }
          const outcome: Pick<CopilotViewActionResult, "ok" | "detail" | "http"> = message.action.action === "open_copilot_settings" ? { ok: true } : viewActionRef.current ? await viewActionRef.current(message.action).catch(() => ({ ok: false, detail: "unavailable" as const })) : { ok: false, detail: "unavailable" as const };
          // What the action changed reaches the page context through a few renders: report only once the service holds the page that shows it, so a call that follows (read_discovery, save_candidate) never sees the old page.
          await settlePublished();
          try { await postViewActionResult(message.viewId, { actionId: message.actionId, ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.http !== undefined ? { http: outcome.http } : {}) }); } catch { /* the service times the action out as not displayed */ }
        })();
      },
      ready: () => { transportConnected = true; republish(); void refresh(); }, connection: (value) => { if (alive) { transportConnected = value; setConnected(value); if (!value) syncing = true; } } });
    return () => { alive = false; generation++; refreshCurrent.current = null; unsubscribe(); };
  }, [id, context.viewId, viewReady]);
  useEffect(() => {
    if (!snapshot || !open) return;
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    else setNewContent(true);
  }, [snapshot?.stream, snapshot?.messages.length, open]);
  const viewName = (view: string) => view === "plan" ? t("shell.nav.plan") : view === "library" ? t("shell.nav.library") : view === "doc" ? t("shell.nav.doc") : view === "write" ? t("shell.nav.write") : t("copilot.unavailable");
  const choice = snapshot?.conversation.model ?? draftModel;
  const provider = providers.find((item) => item.id === choice?.provider);
  const model = provider?.models.find((item) => item.id === choice?.model);
  const thinkingValid = !!model && (choice?.thinking === null ? model.defaultThinkingValid : !!choice && model.thinkingLevels.includes(choice.thinking));
  const levels = model?.capabilitiesKnown ? model.thinkingLevels : [];
  const runStatus = snapshot?.conversation.run?.status;
  const waiting = runStatus === "waiting-for-user";
  // A run held at a confirmation is still the user's live run: Stop and steering work the same.
  const running = runStatus === "running" || waiting;
  const stopping = runStatus === "stopping";
  const resumable = runStatus === "stopped" || runStatus === "interrupted" || runStatus === "failed";
  const thinkingLabel = (level: ThinkingLevel) => t(THINKING_KEYS[level]);
  const lastTask = [...(snapshot?.messages ?? [])].reverse().find((message) => message.role === "user" && message.kind !== "resume" && !message.pending);
  // The task's objects are what was captured when it started. Name them only when that is unambiguous (one object).
  const workObjects = lastTask?.context?.objects ?? [];
  const workObject = workObjects.length === 1 ? workObjects[0] : undefined;
  const elsewhere = running && workObjects.length > 0 && context.view === "plan" && !!context.plan?.selectedPlanId && !workObjects.some((object) => object.id === context.plan?.selectedPlanId);
  // The six-second undo for a confirmed task delete: shown only while the service still holds it.
  const [undone, setUndone] = useState<Set<string>>(() => new Set());
  const [, setClock] = useState(0);
  const undoable = (snapshot?.messages ?? []).flatMap((message) => message.operations ?? []).reverse().find((operation) => operation.undo && !undone.has(operation.id) && Date.parse(operation.undo.until) > Date.now());
  const undoUntil = undoable?.undo ? Date.parse(undoable.undo.until) : 0;
  useEffect(() => {
    if (!undoUntil) return;
    const timer = window.setTimeout(() => setClock((value) => value + 1), Math.max(0, undoUntil - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [undoUntil]);
  // What the user's undo did stays visible (restored, or why not) until dismissed; the service also tells the model.
  const [undoResult, setUndoResult] = useState<{ kind: "restored" | "failed"; label: string } | null>(null);
  // A refused confirmation click is explained here, not only on the card: the card disappears when the list is reread.
  const [decisionProblem, setDecisionProblem] = useState<{ kind: "expired" | "failed"; scope: "plan" | "doc" | "upload" | "deleteDoc" | "manuscript" } | null>(null);
  const waitingForConfirmation = !!snapshot?.confirmations?.length;
  const attentionRef = useRef(onAttention); attentionRef.current = onAttention;
  useEffect(() => { attentionRef.current?.(waitingForConfirmation); return () => attentionRef.current?.(false); }, [waitingForConfirmation]);
  useEffect(() => { setUndoResult(null); setDecisionProblem(null); setFiles((current) => current.filter((item) => { const keep = item.conversationId === id || item.conversationId === null; if (!keep) dropped.current.add(item.key); return keep; })); }, [id]);
  const undo = async () => {
    if (!id || !undoable) return;
    const target = undoable.id, label = undoable.label ?? "";
    try { await undoOperation(id, target, context.viewId); setUndoResult({ kind: "restored", label }); }
    catch (reason) { setUndoResult({ kind: "failed", label }); if (!(reason instanceof CopilotApiError && (reason.code === "stale" || reason.code === "not_found"))) setError(reason instanceof CopilotApiError ? reason.code : "unavailable"); }
    finally { setUndone((previous) => new Set(previous).add(target)); }
  };
  const begin = () => { if (busyRef.current) return false; busyRef.current = true; setBusy(true); setError(null); return true; };
  const end = () => { busyRef.current = false; setBusy(false); };
  const newConversation = async () => {
    if (!begin()) return;
    try { const result = await createConversation(choice ? { ...choice, thinking: null } : null); setId(result.conversation.id); setList(false); setText(""); retry.current = null; await refreshList(); }
    catch (reason) { setError(reason instanceof CopilotApiError ? reason.code : "unavailable"); }
    finally { end(); }
  };
  const choose = async (selected: ConversationModel) => {
    if (!begin()) return;
    try {
      if (id) { const result = await selectConversationModel(id, selected); setSnapshot((current) => current ? { ...current, conversation: result.conversation } : result); }
      else setDraftModel(selected);
      await refreshCatalog();
    } catch (reason) { setError(reason instanceof CopilotApiError ? reason.code : "unavailable"); }
    finally { end(); }
  };
  const pending = files.some((item) => item.status !== "ready");
  /** One conversation however many files arrive at once with none open yet. */
  const creating = useRef<Promise<string> | null>(null);
  const ensureConversation = (): Promise<string> => {
    if (id) return Promise.resolve(id);
    creating.current ??= (async () => {
      const result = await createConversation(choice);
      const created = result.conversation.id;
      setFiles((current) => current.map((entry) => entry.conversationId === null ? { ...entry, conversationId: created } : entry));
      setId(created);
      return created;
    })().finally(() => { creating.current = null; });
    return creating.current;
  };
  const upload = async (item: Draft) => {
    try {
      const conversationId = await ensureConversation();
      const saved = await uploadAttachment(conversationId, item.file);
      if (dropped.current.has(item.key)) { void removeAttachment(conversationId, saved.id).catch(() => {}); return; }
      setFiles((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: "ready", id: saved.id, conversationId } : entry));
    } catch (reason) {
      const final = reason instanceof CopilotApiError && (reason.code === "capacity" || reason.code === "invalid_input");
      setFiles((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: "failed", reason: final ? "final" : "retry" } : entry));
    }
  };
  const pick = (list: FileList | null) => {
    const chosen = [...(list ?? [])].slice(0, 5 - files.length);
    const drafts = chosen.map((file): Draft => ({ key: crypto.randomUUID(), name: file.name, file, status: "uploading", conversationId: id }));
    setFiles((current) => [...current, ...drafts]);
    for (const draft of drafts) void upload(draft);
  };
  const retryUpload = (item: Draft) => { setFiles((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: "uploading", reason: undefined } : entry)); void upload(item); };
  const dropFile = (item: Draft) => {
    dropped.current.add(item.key);
    const at = files.findIndex((entry) => entry.key === item.key);
    setFiles((current) => current.filter((entry) => entry.key !== item.key));
    if (item.id && item.conversationId) void removeAttachment(item.conversationId, item.id).catch(() => {});
    // The removed chip's focus goes to the next chip's remove button, or back to the attach button.
    setTimeout(() => {
      const buttons = document.querySelectorAll<HTMLElement>('[data-ui="copilot-attachment-remove"]');
      (buttons[Math.min(at, buttons.length - 1)] ?? document.querySelector<HTMLElement>('[data-ui="copilot-attach"]'))?.focus();
    }, 0);
  };
  const send = async () => {
    if (!text.trim() || stopping || pending || (!!id && !connected) || !thinkingValid || !begin()) return;
    try {
      const conversationId = await ensureConversation();
      const attempt = retry.current?.id === conversationId && retry.current.text === text ? retry.current : { id: conversationId, text, clientMessageId: crypto.randomUUID() };
      retry.current = attempt;
      const target = conversationId;
      await enqueue(async () => { const sent = await publishLatest(); await sendCopilotMessage(target, { clientMessageId: attempt.clientMessageId, text, viewId: sent.viewId, contextRevision: sent.revision, ...(files.length ? { attachmentIds: files.map((item) => item.id as string) } : {}) }); });
      setText(""); setFiles([]); retry.current = null; following.current = true; textarea.current?.focus();
      await refreshList();
    } catch (reason) { if (reason instanceof CopilotApiError && reason.code === "stale") published.current = null; setError(reason instanceof CopilotApiError ? reason.code : "unavailable"); }
    finally { end(); }
  };
  const stop = async () => {
    if (!id || stopping) return;
    try { const result = await stopConversation(id); setSnapshot((current) => current ? { ...current, conversation: result.conversation } : current); }
    catch (reason) { setError(reason instanceof CopilotApiError ? reason.code : "unavailable"); }
  };
  const resume = async () => {
    if (!id || !begin()) return;
    try {
      const clientMessageId = resumeAttempt.current ?? crypto.randomUUID(); resumeAttempt.current = clientMessageId;
      await enqueue(async () => { const sent = await publishLatest(); await resumeConversation(id, { clientMessageId, viewId: sent.viewId, contextRevision: sent.revision }); });
      resumeAttempt.current = null; following.current = true; await refreshList();
    } catch (reason) { if (reason instanceof CopilotApiError && reason.code === "stale") published.current = null; setError(reason instanceof CopilotApiError ? reason.code : "unavailable"); }
    finally { end(); }
  };
  const errorCopy = (code: string | null) => t(code === "storage" ? "copilot.errors.storage" : code === "capabilities" ? "copilot.errors.capabilities" : code === "capacity" ? "copilot.errors.capacity" : code === "credentials" ? "copilot.errors.credentials" : code === "busy" ? "copilot.errors.busy" : code === "stale" ? "copilot.errors.stale" : code === "clipboard" ? "copilot.errors.clipboard" : code === "rate_limit" ? "copilot.errors.rateLimit" : code === "transient" ? "copilot.errors.transient" : code === "quota" ? "copilot.errors.quota" : "copilot.errors.unavailable");
  const failCopy = async (value: string) => { try { await navigator.clipboard.writeText(value); } catch { setError("clipboard"); } };
  return <aside className="copilot" data-ui="copilot-sidebar" aria-label={t("copilot.title")} hidden={!open}>
    <header className="copilot-header" data-ui="copilot-header">
      <ActionButton unstyled mode="text" label={t("copilot.conversations")} tooltip={t("copilot.conversations")} data-ui="copilot-conversations" className="copilot-title" onClick={() => { setList(true); void refreshList(); }}>{t("copilot.title")}<span aria-hidden="true" className="copilot-chevron">{getConfiguredIcon("chevron-down", "copilot-conversations")}</span></ActionButton>
      <span className="copilot-spacer" />
      <ActionButton unstyled mode="icon" iconName="square-pen" label={t("copilot.new")} data-ui="copilot-new-conversation" className="btn icon ghost" disabled={busy} onClick={() => void newConversation()} />
      <ActionButton unstyled mode="icon" iconName="settings-2" label={t("providers.title")} data-ui="copilot-settings" className="btn icon ghost" onClick={() => setSettings(true)} />
      <ActionButton unstyled mode="icon" iconName="panel-right-close" label={t("copilot.close")} data-ui="copilot-close" className="btn icon ghost" onClick={onClose} />
    </header>
    <div ref={scroll} className="copilot-messages" data-ui="copilot-messages" onScroll={() => {
      const node = scroll.current; if (!node) return;
      following.current = node.scrollHeight - node.clientHeight - node.scrollTop < 40;
      if (following.current) setNewContent(false);
    }}>
      {!snapshot?.messages.length && <div className="copilot-empty"><Icon name="sparkles" /><h2>{t("copilot.emptyTitle")}</h2><p>{t("copilot.empty")}</p></div>}
      {snapshot?.messages.map((message, index) => { const continued = message.role === "assistant" && snapshot.messages[index - 1]?.role === "assistant"; return <article key={message.id} className={`copilot-message copilot-message-${message.role}${continued ? " copilot-message-continued" : ""}`} data-ui="copilot-message" data-ui-key={message.id}>
        {message.role === "user" ? <><div className={message.kind === "resume" ? "copilot-user copilot-user-resume" : "copilot-user"} data-ui={message.kind === "resume" ? "copilot-resume-marker" : undefined}>{message.kind === "resume" ? t("copilot.resumed") : message.text}</div>{!!message.attachments?.length && <div className="copilot-attachments sent" data-ui="copilot-message-attachments">{message.attachments.map((item) => <span key={item.id} className="copilot-attachment" data-ui="copilot-message-attachment" data-ui-key={item.id} title={item.filename}><Icon name="paperclip" /><span className="copilot-attachment-name">{item.filename}</span></span>)}</div>}{message.pending && <div className="copilot-queued" data-ui="copilot-queued" role="status">{t("copilot.queued")}</div>}</> : <>{!continued && <div className="copilot-assistant-label">{t("copilot.title")}</div>}{message.operations && message.operations.length > 0 && <OperationRecord operations={message.operations} />}{message.text && <><div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(message.text) }} /><ActionButton unstyled mode="icon" iconName="copy" label={t("copilot.copy")} data-ui="copilot-copy" className="btn icon ghost" onClick={() => void failCopy(message.text)} /></>}</>}
        {message.context && <details className="copilot-message-context" data-ui="copilot-message-context"><summary>{message.context.objects[0]?.name ?? viewName(message.context?.view ?? "")}</summary><p>{t(message.context.status === "complete" ? "copilot.complete" : "copilot.unavailable")}</p>{message.context.library && <LibrarySummary summary={message.context.library} />}{message.context.discovery && <DiscoverySummary summary={message.context.discovery} />}{message.context.reader && <ReaderSummary summary={message.context.reader} title={message.context.objects[0]?.name} />}{message.context.writer && <WriterSummary summary={message.context.writer} title={message.context.objects[0]?.name} />}{message.context.objects.map((object) => <p key={object.id}>{message.context?.view === "library" || message.context?.view === "doc" ? (object.name ?? object.id) : t("copilot.objectVersion", { name: object.name ?? viewName(message.context?.view ?? ""), rev: object.rev })}</p>)}</details>}
      </article>; })}
      {snapshot?.stream && <article className="copilot-message" data-ui="copilot-stream"><div className="copilot-assistant-label">{t("copilot.title")}</div><div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(snapshot.stream) }} /></article>}
      {snapshot?.confirmations?.map((confirmation) => <ConfirmationCard key={confirmation.id} confirmation={confirmation} viewId={context.viewId} connected={connected} beforeDocDelete={onBeforeDocDelete} onProblem={setDecisionProblem} onSettled={() => void refreshCurrent.current?.()} />)}
      {decisionProblem && <div className="copilot-notice error" data-ui="copilot-confirmation-problem" role="alert"><span>{t(`copilot.confirmation.${decisionProblem.kind}${decisionProblem.scope === "plan" ? "" : decisionProblem.scope === "doc" ? "Doc" : decisionProblem.scope === "deleteDoc" ? "DeleteDoc" : decisionProblem.scope === "manuscript" ? "Manuscript" : "Upload"}`)}</span><ActionButton unstyled mode="icon" iconName="x" label={t("plan.action.dismissUndo")} tooltip={t("plan.action.dismissUndo")} data-ui="copilot-confirmation-problem-dismiss" className="btn icon ghost" onClick={() => setDecisionProblem(null)} /></div>}
      {((running && !waiting) || stopping) && <div className="copilot-run-card" role="status" data-ui="copilot-running"><span className="copilot-pulse" aria-hidden="true" />{t(stopping ? "copilot.stopping" : "copilot.running")}{elsewhere && <small data-ui="copilot-work-continues">{workObject?.name ? t("copilot.workContinues", { name: workObject.name }) : t("copilot.workContinuesOriginal")}</small>}</div>}
      {undoable && <div className="copilot-notice" data-ui="copilot-undo" role="status"><span>{t("plan.undo.deleted", { title: undoable.label ?? "" })}</span><Button data-ui="copilot-undo-delete" onClick={() => void undo()}>{t("plan.undo.action")}</Button><ActionButton unstyled mode="icon" iconName="x" label={t("plan.action.dismissUndo")} tooltip={t("plan.action.dismissUndo")} data-ui="copilot-undo-dismiss" className="btn icon ghost" onClick={() => setUndone((previous) => new Set(previous).add(undoable.id))} /></div>}
      {undoResult && <div className={undoResult.kind === "failed" ? "copilot-notice error" : "copilot-notice"} data-ui="copilot-undo-result" data-status={undoResult.kind} role={undoResult.kind === "failed" ? "alert" : "status"}><span>{t(undoResult.kind === "restored" ? "copilot.undo.restored" : "copilot.undo.failed", { title: undoResult.label })}</span><ActionButton unstyled mode="icon" iconName="x" label={t("plan.action.dismissUndo")} tooltip={t("plan.action.dismissUndo")} data-ui="copilot-undo-result-dismiss" className="btn icon ghost" onClick={() => setUndoResult(null)} /></div>}
      {resumable && <div className={runStatus === "failed" ? "copilot-notice error" : "copilot-notice"} data-ui="copilot-run-result" role={runStatus === "failed" ? "alert" : "status"} data-status={runStatus}>
        <span data-ui={runStatus === "failed" ? "copilot-run-error" : runStatus === "interrupted" ? "copilot-interrupted" : "copilot-stopped"}>{runStatus === "failed" ? errorCopy(snapshot?.conversation.run?.error ?? null) : t(runStatus === "interrupted" ? "copilot.interrupted" : "copilot.stoppedNote")}</span>
        <Button data-ui="copilot-resume" disabled={busy || (!!id && !connected)} onClick={() => void resume()}>{t(runStatus === "failed" ? "common.retry" : "copilot.resume")}</Button>
      </div>}
    </div>
    {newContent && <Button className="copilot-new-content" data-ui="copilot-new-content" onClick={() => { following.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setNewContent(false); }}>{t("copilot.newContent")}</Button>}
    <div className="copilot-composer" data-ui="copilot-composer">
      <Button className="copilot-context" data-ui="copilot-context" onClick={() => setDetail(true)}><span className="copilot-context-icon" aria-hidden="true">{getConfiguredIcon(context.view === "plan" ? "list-checks" : context.view === "doc" ? "file-text" : "layers", "copilot-context")}</span><span className="copilot-context-name">{context.plan?.plans[0]?.name || context.reader?.reading?.title || context.writer?.editor?.saved?.title || viewName(context.view)}</span><Badge>{t(context.status === "complete" ? "copilot.complete" : "copilot.unavailable")}</Badge><span className="copilot-context-icon" aria-hidden="true">{getConfiguredIcon("chevron-down", "copilot-context")}</span></Button>
      {id && !connected && <p role="status" data-ui="copilot-disconnected">{t("copilot.disconnected")}</p>}
      {error && <p role="alert" data-ui="copilot-error">{errorCopy(error)} <Button onClick={() => { void refreshCatalog(); void refreshList(); void refreshCurrent.current?.(); }}>{t("common.retry")}</Button></p>}
      {!!files.length && <div className="copilot-attachments" data-ui="copilot-attachments">{files.map((item) => <span key={item.key} className="copilot-attachment" data-ui="copilot-attachment" data-status={item.status} title={item.name} role={item.status === "ready" ? undefined : "status"}><Icon name="paperclip" /><span className="copilot-attachment-name">{item.name}</span>{item.status === "uploading" && <small>{t("copilot.attachUploading")}</small>}{item.status === "failed" && <small>{t(item.reason === "final" ? "copilot.attachTooLarge" : "copilot.attachFailed")}</small>}{item.status === "failed" && item.reason !== "final" && <button type="button" className="copilot-attachment-retry" data-ui="copilot-attachment-retry" aria-label={t("copilot.attachRetryNamed", { name: item.name })} onClick={() => retryUpload(item)}>{t("copilot.attachRetry")}</button>}<ActionButton unstyled mode="icon" iconName="x" label={t("copilot.attachRemove", { name: item.name })} data-ui="copilot-attachment-remove" className="copilot-attachment-remove" onClick={() => dropFile(item)} /></span>)}</div>}
      <div className="copilot-composer-box">
        <textarea ref={textarea} data-ui="copilot-input" aria-label={t("copilot.input")} placeholder={t(running ? "copilot.steerHint" : "copilot.input")} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
        }} />
        <div className="copilot-composer-actions">
          <ActionButton unstyled mode="icon" iconName="plus" label={t("copilot.attach")} data-ui="copilot-attach" className="copilot-attach" disabled={stopping || files.length >= 5} onClick={() => picker.current?.click()} />
          <input ref={picker} type="file" hidden data-ui="copilot-attach-input" onChange={(event) => { pick(event.target.files); event.target.value = ""; }} />
          <select aria-label={t("copilot.model")} data-ui="copilot-model" value={choice ? `${choice.provider}\n${choice.model}` : ""} disabled={busy} onChange={(event) => {
            const [providerId, modelId] = event.target.value.split("\n"); void choose({ provider: providerId, model: modelId, thinking: null });
          }}><option value="" disabled>{t("copilot.model")}</option>{providers.map((item) => <optgroup key={item.id} label={item.name}>{item.models.filter((model) => model.tools).map((model) => <option key={model.id} value={`${item.id}\n${model.id}`}>{model.name}</option>)}</optgroup>)}</select>
          <span className="copilot-spacer" />
          {!(running || stopping) && <ActionButton unstyled mode="icon" iconName="arrow-up" label={t("copilot.send")} data-ui="copilot-send" className="copilot-send" disabled={busy || stopping || pending || !text.trim() || !thinkingValid || (!!id && !connected)} onClick={() => void send()} />}
          {(running || stopping) && <ActionButton unstyled mode="icon" iconName="square" label={t(stopping ? "copilot.status.stopping" : "copilot.stop")} data-ui="copilot-stop" className="copilot-send copilot-stop" disabled={stopping || !connected} onClick={() => void stop()} />}
        </div>
      </div>
      <div className="copilot-composer-foot"><select aria-label={t("copilot.thinking")} data-ui="copilot-thinking" value={choice?.thinking ?? "default"} disabled={busy || !model || (levels.length <= 1 && thinkingValid)} onChange={(event) => { if (choice) void choose({ ...choice, thinking: event.target.value === "default" ? null : event.target.value as ThinkingLevel }); }}>
        <option value="default">{t("copilot.defaultChoice")}{model?.defaultThinking ? ` · ${thinkingLabel(model.defaultThinking)}` : ""}</option>{choice?.thinking && !levels.includes(choice.thinking) && <option value={choice.thinking} disabled>{thinkingLabel(choice.thinking)}</option>}{levels.length > 1 && levels.map((level) => <option key={level} value={level}>{thinkingLabel(level)}</option>)}
      </select><span>{t("copilot.scope")}</span></div>
      {!thinkingValid && choice && <p role="alert">{t("copilot.errors.capabilities")}</p>}
    </div>
    {settings && <ProviderSettingsDialog onClose={() => { setSettings(false); void refreshCatalog(); }} />}
    {list && <Dialog title={t("copilot.conversations")} closeLabel={t("copilot.close")} onClose={() => setList(false)} uiId="copilot-conversation-list"><div className="copilot-conversation-list"><Button onClick={() => void newConversation()} disabled={busy}>{t("copilot.new")}</Button>{conversations.map((conversation) => <Button key={conversation.id} data-ui="copilot-conversation" data-ui-key={conversation.id} data-status={conversation.run?.status} aria-pressed={conversation.id === id} onClick={() => { setId(conversation.id); setList(false); setText(""); retry.current = null; resumeAttempt.current = null; }}><span className="copilot-conversation-title">{conversation.title || t("copilot.new")}</span>{conversation.run && conversation.run.status !== "completed" && <Badge tone={conversation.run.status === "running" || conversation.run.status === "waiting-for-user" || conversation.run.status === "stopping" ? "accent" : "neutral"}>{t(RUN_STATUS_KEYS[conversation.run.status])}</Badge>}</Button>)}{unreadable.map((entry) => <p key={entry.id} className="copilot-conversation-unreadable" data-ui="copilot-conversation-unreadable" role="alert">{t("copilot.unreadable")}</p>)}</div></Dialog>}
    {detail && <Dialog title={t("copilot.context")} closeLabel={t("copilot.close")} onClose={() => setDetail(false)} uiId="copilot-context-detail"><div className="copilot-context-detail">{!context.reader && !context.writer && <p>{t(context.status === "complete" ? "copilot.completeDetail" : "copilot.unavailableDetail")}</p>}{context.writer && <WriterSummary summary={summarizeWriterPage(context.writer)} />}{context.library && <LibrarySummary summary={{ source: context.library.source, error: context.library.error, query: context.library.query, total: context.library.total, matched: context.library.matched, selectedRefId: context.library.selectedRefId }} title={context.library.detail?.ref.title} />}{context.discovery && <DiscoverySummary summary={summarizeDiscoveryPage(context.discovery)} />}{context.reader && <ReaderSummary summary={summarizeReaderPage(context.reader)} title={context.reader.reading?.title} />}{context.plan && <><p>{t(context.plan.mode === "list" ? "plan.modes.list" : context.plan.mode === "board" ? "plan.modes.board" : context.plan.mode === "focus" ? "plan.focus.title" : "plan.timeline.title")} · {t("copilot.version", { rev: context.plan.rev })} · {t(context.plan.saveState === "saved" ? "copilot.saved" : context.plan.saveState === "pending" ? "copilot.saving" : "plan.notice.saveFailed")}</p>{context.plan.plans.map((plan) => <section key={plan.id}><h3>{plan.name}</h3><p>{plan.desc}</p><ul>{plan.tasks.map((task) => <li key={task.id}>{task.title} · {t(task.status === "todo" ? "plan.status.todo" : task.status === "doing" ? "plan.status.doing" : task.status === "blocked" ? "plan.status.blocked" : "plan.status.done")} · {fmtDate(task.due)}</li>)}</ul></section>)}{context.plan.detail && <p>{t("copilot.taskDetail")} · {context.plan.detail.task.title}</p>}</>}</div></Dialog>}
  </aside>;
}

/** The waiting card of prototype A: the plan, what it takes with it, and the user's own decision. */
function ConfirmationCard({ confirmation, viewId, connected, onSettled, onProblem, beforeDocDelete }: { confirmation: CopilotConfirmation; viewId: string; connected: boolean; onSettled: () => void; onProblem: (problem: { kind: "expired" | "failed"; scope: "plan" | "doc" | "upload" | "deleteDoc" | "manuscript" } | null) => void; beforeDocDelete?: (docId: string) => boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const decide = async (decision: "approve" | "decline") => {
    if (guard.current) return;
    // The dialog's own order: deleting the open Doc first asks the workspace's leave guard (unsaved drafts); a refusal keeps the card.
    if (decision === "approve" && confirmation.action === "delete_doc" && beforeDocDelete && !beforeDocDelete(confirmation.object.id)) return;
    guard.current = true; setBusy(true); onProblem(null);
    try { await decideConfirmation(confirmation.id, { decision, viewId, action: confirmation.action, objectId: confirmation.object.id, baseRev: confirmation.baseRev }); }
    catch (reason) { onProblem({ kind: reason instanceof CopilotApiError && reason.code === "stale" ? "expired" : "failed", scope: confirmation.action === "delete_plan" ? "plan" : confirmation.action === "delete_manuscript" ? "manuscript" : confirmation.action === "accept_pdf_resource_warning" ? "upload" : confirmation.action === "delete_doc" ? "deleteDoc" : "doc" }); }
    finally { guard.current = false; setBusy(false); onSettled(); }
  };
  return <section className="copilot-confirmation" data-ui="copilot-confirmation" data-action={confirmation.action} aria-label={t("copilot.confirmation.needed")}>
    <div className="copilot-confirmation-warn" role="status"><Icon name="triangle-alert" />{t("copilot.confirmation.needed")}</div>
    {confirmation.action === "delete_plan" ? <>
      <h3>{t("copilot.confirmation.deletePlan", { name: confirmation.label })}</h3>
      <p>{t("copilot.confirmation.planScope", { count: confirmation.impact.tasks, open: confirmation.impact.openTasks })}</p>
      <div className="copilot-confirmation-meta">{t("copilot.confirmation.meta", { id: confirmation.object.id, rev: confirmation.baseRev })}</div>
    </> : confirmation.action === "delete_manuscript" ? <>
      <h3>{t("copilot.confirmation.deleteManuscript", { title: confirmation.label })}</h3>
      <p>{t("writer.list.deleteBody", { title: confirmation.label })}</p>
      <p data-ui="copilot-confirmation-scope">{t("copilot.confirmation.manuscriptScope", { cells: confirmation.impact.cells, comments: confirmation.impact.comments, assets: confirmation.impact.assets })}</p>
      <div className="copilot-confirmation-meta">{t("copilot.confirmation.metaManuscript", { id: confirmation.object.id, rev: confirmation.baseRev })}</div>
    </> : confirmation.action === "delete_doc" ? <>
      <h3>{t("copilot.confirmation.deleteDoc", { id: confirmation.object.id })}</h3>
      <p data-ui="copilot-confirmation-risk">{t("library.detail.deleteDoc.risk")}</p>
      <p data-ui="copilot-confirmation-scope"><strong>{t("library.detail.deleteDoc.scopeTitle")}</strong> {t(confirmation.format === "pdf" ? "library.detail.deleteDoc.pdfScope" : "library.detail.deleteDoc.scope")}</p>
      {confirmation.works.length > 0 && <ul className="copilot-confirmation-works" data-ui="copilot-confirmation-works">{confirmation.works.map((item) => <li key={item.id} data-ui="copilot-confirmation-work" data-ui-key={item.id}>{t("copilot.confirmation.deleteDocWork", { title: item.title || item.id, state: t(item.main ? "library.detail.files.mainBadge" : "library.detail.files.additionalBadge"), count: item.remaining })}</li>)}</ul>}
      <p role="status" data-ui="copilot-confirmation-count">{confirmation.impact.annotations === "known" ? t("library.detail.deleteDoc.count", { count: confirmation.impact.count }) : t("library.detail.deleteDoc.countUnknown")}</p>
      <div className="copilot-confirmation-meta">{confirmation.impact.annotations === "known" ? t("copilot.confirmation.metaDoc", { id: confirmation.object.id, rev: confirmation.baseRev }) : confirmation.object.id}</div>
    </> : confirmation.action === "accept_pdf_resource_warning" ? <>
      <h3>{t("copilot.confirmation.acceptPdf", { name: confirmation.label, file: confirmation.attachment.filename })}</h3>
      <p>{t("library.detail.pdfUpload.resourceWarningDetail", { filename: confirmation.attachment.filename, size: (confirmation.attachment.size / (1024 * 1024)).toFixed(1) })}</p>
      <div className="copilot-confirmation-meta">{confirmation.object.workId}</div>
    </> : <>
      <h3>{confirmation.action === "replace_upload_source" ? t("copilot.confirmation.replaceUpload", { name: confirmation.label, file: confirmation.attachment?.filename ?? "" }) : t("copilot.confirmation.refreshArxiv", { name: confirmation.label })}</h3>
      <p>{confirmation.impact.annotations === "known" ? (confirmation.impact.count > 0 ? t("library.detail.acquisition.riskKnown", { count: confirmation.impact.count }) : t("library.detail.acquisition.riskZero")) : t("library.detail.acquisition.riskUnknown")}</p>
      <div className="copilot-confirmation-meta">{confirmation.impact.annotations === "known" ? t("copilot.confirmation.metaDoc", { id: confirmation.object.id, rev: confirmation.baseRev }) : confirmation.object.id}</div>
    </>}
    <div className="copilot-confirmation-actions">
      <Button data-ui="copilot-confirmation-cancel" disabled={busy || !connected} onClick={() => void decide("decline")}>{t("common.cancel")}</Button>
      <Button appearance="primary" tone="danger" data-ui="copilot-confirmation-confirm" disabled={busy || !connected} onClick={() => void decide("approve")}>{t(confirmation.action === "delete_plan" ? "plan.deletePlan.confirm" : confirmation.action === "delete_manuscript" ? "common.delete" : confirmation.action === "delete_doc" ? "library.detail.deleteDoc.confirm" : confirmation.action === "accept_pdf_resource_warning" ? "library.detail.pdfUpload.continue" : "library.detail.acquisition.confirmUpdate")}</Button>
    </div>
  </section>;
}

function OperationRecord({ operations }: { operations: CopilotOperation[] }) {
  const { t } = useTranslation();
  const failed = operations.filter((operation) => !isApplied(operation) && operation.status !== "pending").length;
  const pending = operations.filter((operation) => operation.status === "pending").length;
  const actionName = (operation: CopilotOperation) => operation.tool === "library" && operation.action === "read" ? t("copilot.operations.actions.read_library") : operation.tool === "reader" && operation.action === "read" ? t("copilot.operations.actions.read_reader") : operation.tool === "writer" && operation.action === "read" ? t("copilot.operations.actions.read_writer") : operation.action in OPERATION_ACTION_KEYS ? t(OPERATION_ACTION_KEYS[operation.action as keyof typeof OPERATION_ACTION_KEYS]) : operation.action;
  const summary = operations.length === 1 ? actionName(operations[0] as CopilotOperation) : t(operations.every((operation) => operation.tool === "plan") ? "copilot.operations.count" : operations.every((operation) => operation.tool === "library") ? "copilot.operations.countLibrary" : "copilot.operations.countMixed", { count: operations.length });
  return <details className="copilot-operation" data-ui="copilot-operation">
    <summary><span className={failed ? "copilot-operation-mark warn" : pending ? "copilot-operation-mark pending" : "copilot-operation-mark ok"} aria-hidden="true"><Icon name={failed ? "triangle-alert" : pending ? "clock" : "check"} /></span><span className="copilot-operation-summary">{summary}{failed > 0 && ` · ${t("copilot.operations.notApplied", { count: failed })}`}{pending > 0 && ` · ${t("copilot.operations.status.pending")}`}</span><span className="copilot-operation-chevron" aria-hidden="true"><Icon name="chevron-down" /></span></summary>
    <ul>{operations.map((operation) => <li key={operation.id} data-ui="copilot-operation-item" data-ui-key={operation.id} data-status={operation.status}>
      <span>{actionName(operation)}</span>{operation.label && <span className="copilot-operation-label">{operation.label}</span>}
      <Badge tone={isApplied(operation) ? "accent" : "neutral"}>{t(operation.tool === "library" && operation.status === "conflict" ? "copilot.operations.status.conflictLibrary" : operation.tool === "reader" && operation.status === "conflict" ? "copilot.operations.status.conflictReader" : OPERATION_STATUS_KEYS[operation.status])}</Badge>
      {operation.warnings?.includes("import_partial") && <span className="copilot-operation-warn">{t("copilot.operations.importPartial")}</span>}
      {operation.warnings?.includes("task_due_after_plan_due") && <span className="copilot-operation-warn">{t("copilot.operations.dueAfterPlan")}</span>}
      {operation.rev !== undefined && isApplied(operation) && <code>v{operation.rev}</code>}
      {operation.job && <code data-ui="copilot-operation-job" title={t("copilot.operations.job")}>{operation.job.id}</code>}
      {operation.docId && <code data-ui="copilot-operation-doc" title={t("copilot.operations.doc")}>{operation.docId}</code>}
    </li>)}</ul>
  </details>;
}
