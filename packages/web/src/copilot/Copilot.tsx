import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Conversation, ConversationModel, ConversationSnapshot, CopilotOperation, CopilotProvider, CopilotViewActionResult, PageContext, PlanViewAction, ThinkingLevel, WsCopilotEvent } from "@argelanderspace/contracts";
import { CopilotApiError, createConversation, fetchConversation, listConversations, postViewActionResult, publishPageContext, resumeConversation, selectConversationModel, sendCopilotMessage, stopConversation } from "../api/copilot";
import { fmtDate } from "../plan/model";
import { fetchProviders } from "../api/providers";
import { subscribeCopilot } from "../api/ws";
import { ActionButton, Badge, Button, Dialog, getConfiguredIcon } from "../ui";
import { ProviderSettingsDialog } from "./ProviderSettings";
import { Icon } from "../lib/icons";
import { copilotMarkdown } from "./markdown";
import "./copilot.css";

const OPERATION_ACTION_KEYS = {
  read: "copilot.operations.actions.read", create_plan: "copilot.operations.actions.create_plan", update_plan: "copilot.operations.actions.update_plan",
  create_task: "copilot.operations.actions.create_task", update_task: "copilot.operations.actions.update_task", add_task_link: "copilot.operations.actions.add_task_link",
  remove_task_link: "copilot.operations.actions.remove_task_link", move_task: "copilot.operations.actions.move_task", show: "copilot.operations.actions.show",
  open_task: "copilot.operations.actions.open_task", close_task: "copilot.operations.actions.close_task",
} as const;
const OPERATION_STATUS_KEYS = {
  ok: "copilot.operations.status.ok", noop: "copilot.operations.status.noop", conflict: "copilot.operations.status.conflict", not_found: "copilot.operations.status.not_found",
  rejected: "copilot.operations.status.rejected", invalid: "copilot.operations.status.invalid", not_displayed: "copilot.operations.status.not_displayed",
  unsupported: "copilot.operations.status.unsupported", unknown: "copilot.operations.status.unknown", error: "copilot.operations.status.error",
} as const;
const THINKING_KEYS = { off: "copilot.thinkingLevels.off", minimal: "copilot.thinkingLevels.minimal", low: "copilot.thinkingLevels.low", medium: "copilot.thinkingLevels.medium", high: "copilot.thinkingLevels.high", xhigh: "copilot.thinkingLevels.xhigh", max: "copilot.thinkingLevels.max" } as const;
const RUN_STATUS_KEYS = { running: "copilot.status.running", stopping: "copilot.status.stopping", completed: "copilot.status.completed", failed: "copilot.status.failed", stopped: "copilot.status.stopped", interrupted: "copilot.status.interrupted" } as const;
const STORED_CONVERSATION = "argelander.copilot.conversation";
// A per-viewer convenience only: the saved conversations are authoritative, this just remembers which one this browser was showing.
const readStoredConversation = () => { try { return window.localStorage.getItem(STORED_CONVERSATION); } catch { return null; } };
const writeStoredConversation = (id: string) => { try { window.localStorage.setItem(STORED_CONVERSATION, id); } catch { /* private window or blocked storage */ } };
const isApplied = (operation: CopilotOperation) => operation.status === "ok" || operation.status === "noop";

export type CopilotViewActionHandler = (action: PlanViewAction) => Promise<Pick<CopilotViewActionResult, "ok" | "detail">>;

export function Copilot({ open, context, onClose, onViewAction }: { open: boolean; context: PageContext; onClose: () => void; onViewAction?: CopilotViewActionHandler }) {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [id, setId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ConversationSnapshot | null>(null);
  const [providers, setProviders] = useState<CopilotProvider[]>([]);
  const [draftModel, setDraftModel] = useState<ConversationModel | null>(null);
  const [text, setText] = useState("");
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
  const publishLatest = async () => {
    const next = latestContext.current, done = published.current;
    if (done?.viewId === next.viewId && done.revision === next.revision) return next;
    await publishPageContext(next); published.current = { viewId: next.viewId, revision: next.revision }; return next;
  };
  const viewActionRef = useRef(onViewAction); viewActionRef.current = onViewAction;
  const handledActions = useRef(new Set<string>());
  useEffect(() => {
    if (!id || publishQueued.current) return;
    publishQueued.current = true;
    void enqueue(async () => { publishQueued.current = false; await publishLatest(); }).catch((reason) => setError(reason instanceof CopilotApiError ? reason.code : "unavailable"));
  }, [id, context]);
  // A restarted service knows no views: forget what was published and send the current page again.
  const republish = () => { published.current = null; void enqueue(publishLatest).catch(() => undefined); };
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
    if (!open || loaded.current) return;
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
    if (!id) return;
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
          const outcome = viewActionRef.current ? await viewActionRef.current(message.action).catch(() => ({ ok: false, detail: "unavailable" as const })) : { ok: false, detail: "unavailable" as const };
          try { await postViewActionResult(message.viewId, { actionId: message.actionId, ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}) }); } catch { /* the service times the action out as not displayed */ }
        })();
      },
      ready: () => { transportConnected = true; republish(); void refresh(); }, connection: (value) => { if (alive) { transportConnected = value; setConnected(value); if (!value) syncing = true; } } });
    return () => { alive = false; generation++; refreshCurrent.current = null; unsubscribe(); };
  }, [id, context.viewId]);
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
  const running = runStatus === "running";
  const stopping = runStatus === "stopping";
  const resumable = runStatus === "stopped" || runStatus === "interrupted" || runStatus === "failed";
  const thinkingLabel = (level: ThinkingLevel) => t(THINKING_KEYS[level]);
  const lastTask = [...(snapshot?.messages ?? [])].reverse().find((message) => message.role === "user" && message.kind !== "resume" && !message.pending);
  // The task's objects are what was captured when it started. Name them only when that is unambiguous (one object).
  const workObjects = lastTask?.context?.objects ?? [];
  const workObject = workObjects.length === 1 ? workObjects[0] : undefined;
  const elsewhere = running && workObjects.length > 0 && context.view === "plan" && !!context.plan?.selectedPlanId && !workObjects.some((object) => object.id === context.plan?.selectedPlanId);
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
  const send = async () => {
    if (!text.trim() || stopping || (!!id && !connected) || !thinkingValid || !begin()) return;
    try {
      let conversationId = id;
      if (!conversationId) {
        const result = await createConversation(choice); conversationId = result.conversation.id; setId(conversationId);
      }
      const attempt = retry.current?.id === conversationId && retry.current.text === text ? retry.current : { id: conversationId, text, clientMessageId: crypto.randomUUID() };
      retry.current = attempt;
      const target = conversationId;
      await enqueue(async () => { const sent = await publishLatest(); await sendCopilotMessage(target, { clientMessageId: attempt.clientMessageId, text, viewId: sent.viewId, contextRevision: sent.revision }); });
      setText(""); retry.current = null; following.current = true; textarea.current?.focus();
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
        {message.role === "user" ? <><div className={message.kind === "resume" ? "copilot-user copilot-user-resume" : "copilot-user"} data-ui={message.kind === "resume" ? "copilot-resume-marker" : undefined}>{message.kind === "resume" ? t("copilot.resumed") : message.text}</div>{message.pending && <div className="copilot-queued" data-ui="copilot-queued" role="status">{t("copilot.queued")}</div>}</> : <>{!continued && <div className="copilot-assistant-label">{t("copilot.title")}</div>}{message.operations && message.operations.length > 0 && <OperationRecord operations={message.operations} />}{message.text && <><div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(message.text) }} /><ActionButton unstyled mode="icon" iconName="copy" label={t("copilot.copy")} data-ui="copilot-copy" className="btn icon ghost" onClick={() => void failCopy(message.text)} /></>}</>}
        {message.context && <details className="copilot-message-context" data-ui="copilot-message-context"><summary>{message.context.objects[0]?.name ?? viewName(message.context?.view ?? "")}</summary><p>{t(message.context.status === "complete" ? "copilot.complete" : "copilot.unavailable")}</p>{message.context.objects.map((object) => <p key={object.id}>{t("copilot.objectVersion", { name: object.name ?? viewName(message.context?.view ?? ""), rev: object.rev })}</p>)}</details>}
      </article>; })}
      {snapshot?.stream && <article className="copilot-message" data-ui="copilot-stream"><div className="copilot-assistant-label">{t("copilot.title")}</div><div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(snapshot.stream) }} /></article>}
      {(running || stopping) && <div className="copilot-run-card" role="status" data-ui="copilot-running"><span className="copilot-pulse" aria-hidden="true" />{t(stopping ? "copilot.stopping" : "copilot.running")}{elsewhere && <small data-ui="copilot-work-continues">{workObject?.name ? t("copilot.workContinues", { name: workObject.name }) : t("copilot.workContinuesOriginal")}</small>}</div>}
      {resumable && <div className={runStatus === "failed" ? "copilot-notice error" : "copilot-notice"} data-ui="copilot-run-result" role={runStatus === "failed" ? "alert" : "status"} data-status={runStatus}>
        <span data-ui={runStatus === "failed" ? "copilot-run-error" : runStatus === "interrupted" ? "copilot-interrupted" : "copilot-stopped"}>{runStatus === "failed" ? errorCopy(snapshot?.conversation.run?.error ?? null) : t(runStatus === "interrupted" ? "copilot.interrupted" : "copilot.stoppedNote")}</span>
        <Button data-ui="copilot-resume" disabled={busy || (!!id && !connected)} onClick={() => void resume()}>{t(runStatus === "failed" ? "common.retry" : "copilot.resume")}</Button>
      </div>}
    </div>
    {newContent && <Button className="copilot-new-content" data-ui="copilot-new-content" onClick={() => { following.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setNewContent(false); }}>{t("copilot.newContent")}</Button>}
    <div className="copilot-composer" data-ui="copilot-composer">
      <Button className="copilot-context" data-ui="copilot-context" onClick={() => setDetail(true)}><span className="copilot-context-icon" aria-hidden="true">{getConfiguredIcon(context.view === "plan" ? "list-checks" : context.view === "doc" ? "file-text" : "layers", "copilot-context")}</span><span className="copilot-context-name">{context.plan?.plans[0]?.name || viewName(context.view)}</span><Badge>{t(context.status === "complete" ? "copilot.complete" : "copilot.unavailable")}</Badge><span className="copilot-context-icon" aria-hidden="true">{getConfiguredIcon("chevron-down", "copilot-context")}</span></Button>
      {id && !connected && <p role="status" data-ui="copilot-disconnected">{t("copilot.disconnected")}</p>}
      {error && <p role="alert" data-ui="copilot-error">{errorCopy(error)} <Button onClick={() => { void refreshCatalog(); void refreshList(); void refreshCurrent.current?.(); }}>{t("common.retry")}</Button></p>}
      <div className="copilot-composer-box">
        <textarea ref={textarea} data-ui="copilot-input" aria-label={t("copilot.input")} placeholder={t(running ? "copilot.steerHint" : "copilot.input")} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
        }} />
        <div className="copilot-composer-actions">
          <select aria-label={t("copilot.model")} data-ui="copilot-model" value={choice ? `${choice.provider}\n${choice.model}` : ""} disabled={busy} onChange={(event) => {
            const [providerId, modelId] = event.target.value.split("\n"); void choose({ provider: providerId, model: modelId, thinking: null });
          }}><option value="" disabled>{t("copilot.model")}</option>{providers.map((item) => <optgroup key={item.id} label={item.name}>{item.models.filter((model) => model.tools).map((model) => <option key={model.id} value={`${item.id}\n${model.id}`}>{model.name}</option>)}</optgroup>)}</select>
          <span className="copilot-spacer" />
          {!(running || stopping) && <ActionButton unstyled mode="icon" iconName="arrow-up" label={t("copilot.send")} data-ui="copilot-send" className="copilot-send" disabled={busy || stopping || !text.trim() || !thinkingValid || (!!id && !connected)} onClick={() => void send()} />}
          {(running || stopping) && <ActionButton unstyled mode="icon" iconName="square" label={t(stopping ? "copilot.status.stopping" : "copilot.stop")} data-ui="copilot-stop" className="copilot-send copilot-stop" disabled={stopping || !connected} onClick={() => void stop()} />}
        </div>
      </div>
      <div className="copilot-composer-foot"><select aria-label={t("copilot.thinking")} data-ui="copilot-thinking" value={choice?.thinking ?? "default"} disabled={busy || !model || (levels.length <= 1 && thinkingValid)} onChange={(event) => { if (choice) void choose({ ...choice, thinking: event.target.value === "default" ? null : event.target.value as ThinkingLevel }); }}>
        <option value="default">{t("copilot.defaultChoice")}{model?.defaultThinking ? ` · ${thinkingLabel(model.defaultThinking)}` : ""}</option>{choice?.thinking && !levels.includes(choice.thinking) && <option value={choice.thinking} disabled>{thinkingLabel(choice.thinking)}</option>}{levels.length > 1 && levels.map((level) => <option key={level} value={level}>{thinkingLabel(level)}</option>)}
      </select><span>{t("copilot.scope")}</span></div>
      {!thinkingValid && choice && <p role="alert">{t("copilot.errors.capabilities")}</p>}
    </div>
    {settings && <ProviderSettingsDialog onClose={() => { setSettings(false); void refreshCatalog(); }} />}
    {list && <Dialog title={t("copilot.conversations")} closeLabel={t("copilot.close")} onClose={() => setList(false)} uiId="copilot-conversation-list"><div className="copilot-conversation-list"><Button onClick={() => void newConversation()} disabled={busy}>{t("copilot.new")}</Button>{conversations.map((conversation) => <Button key={conversation.id} data-ui="copilot-conversation" data-ui-key={conversation.id} data-status={conversation.run?.status} aria-pressed={conversation.id === id} onClick={() => { setId(conversation.id); setList(false); setText(""); retry.current = null; resumeAttempt.current = null; }}><span className="copilot-conversation-title">{conversation.title || t("copilot.new")}</span>{conversation.run && conversation.run.status !== "completed" && <Badge tone={conversation.run.status === "running" || conversation.run.status === "stopping" ? "accent" : "neutral"}>{t(RUN_STATUS_KEYS[conversation.run.status])}</Badge>}</Button>)}{unreadable.map((entry) => <p key={entry.id} className="copilot-conversation-unreadable" data-ui="copilot-conversation-unreadable" role="alert">{t("copilot.unreadable")}</p>)}</div></Dialog>}
    {detail && <Dialog title={t("copilot.context")} closeLabel={t("copilot.close")} onClose={() => setDetail(false)} uiId="copilot-context-detail"><div className="copilot-context-detail"><p>{t(context.status === "complete" ? "copilot.completeDetail" : "copilot.unavailableDetail")}</p>{context.plan && <><p>{t(context.plan.mode === "list" ? "plan.modes.list" : context.plan.mode === "board" ? "plan.modes.board" : context.plan.mode === "focus" ? "plan.focus.title" : "plan.timeline.title")} · {t("copilot.version", { rev: context.plan.rev })} · {t(context.plan.saveState === "saved" ? "copilot.saved" : context.plan.saveState === "pending" ? "copilot.saving" : "plan.notice.saveFailed")}</p>{context.plan.plans.map((plan) => <section key={plan.id}><h3>{plan.name}</h3><p>{plan.desc}</p><ul>{plan.tasks.map((task) => <li key={task.id}>{task.title} · {t(task.status === "todo" ? "plan.status.todo" : task.status === "doing" ? "plan.status.doing" : task.status === "blocked" ? "plan.status.blocked" : "plan.status.done")} · {fmtDate(task.due)}</li>)}</ul></section>)}{context.plan.detail && <p>{t("copilot.taskDetail")} · {context.plan.detail.task.title}</p>}</>}</div></Dialog>}
  </aside>;
}

function OperationRecord({ operations }: { operations: CopilotOperation[] }) {
  const { t } = useTranslation();
  const failed = operations.filter((operation) => !isApplied(operation)).length;
  const actionName = (operation: CopilotOperation) => operation.action in OPERATION_ACTION_KEYS ? t(OPERATION_ACTION_KEYS[operation.action as keyof typeof OPERATION_ACTION_KEYS]) : operation.action;
  const summary = operations.length === 1 ? actionName(operations[0] as CopilotOperation) : t("copilot.operations.count", { count: operations.length });
  return <details className="copilot-operation" data-ui="copilot-operation">
    <summary><span className={failed ? "copilot-operation-mark warn" : "copilot-operation-mark ok"} aria-hidden="true"><Icon name={failed ? "triangle-alert" : "check"} /></span><span className="copilot-operation-summary">{summary}{failed > 0 && ` · ${t("copilot.operations.notApplied", { count: failed })}`}</span><span className="copilot-operation-chevron" aria-hidden="true"><Icon name="chevron-down" /></span></summary>
    <ul>{operations.map((operation) => <li key={operation.id} data-ui="copilot-operation-item" data-ui-key={operation.id} data-status={operation.status}>
      <span>{actionName(operation)}</span>{operation.label && <span className="copilot-operation-label">{operation.label}</span>}
      <Badge tone={isApplied(operation) ? "accent" : "neutral"}>{t(OPERATION_STATUS_KEYS[operation.status])}</Badge>
      {operation.warnings?.includes("task_due_after_plan_due") && <span className="copilot-operation-warn">{t("copilot.operations.dueAfterPlan")}</span>}
      {operation.rev !== undefined && isApplied(operation) && <code>v{operation.rev}</code>}
    </li>)}</ul>
  </details>;
}
