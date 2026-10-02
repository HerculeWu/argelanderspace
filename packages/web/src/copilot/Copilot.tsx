import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Conversation, ConversationModel, ConversationSnapshot, CopilotProvider, PageContext, ThinkingLevel, WsCopilotEvent } from "@argelanderspace/contracts";
import { CopilotApiError, createConversation, fetchConversation, listConversations, publishPageContext, selectConversationModel, sendCopilotMessage } from "../api/copilot";
import { fetchProviders } from "../api/providers";
import { subscribeCopilot } from "../api/ws";
import { ActionButton, Badge, Button, Dialog, getConfiguredIcon } from "../ui";
import { ProviderSettingsDialog } from "./ProviderSettings";
import { Icon } from "../lib/icons";
import { copilotMarkdown } from "./markdown";
import "./copilot.css";

export function Copilot({ open, context, onClose }: { open: boolean; context: PageContext; onClose: () => void }) {
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
  const publications = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    if (!id) return;
    publications.current = publications.current.catch(() => {}).then(async () => { await publishPageContext(context); }).catch((reason) => setError(reason instanceof CopilotApiError ? reason.code : "unavailable"));
  }, [id, context]);
  const refreshCatalog = async () => {
    try {
      const result = await fetchProviders(); setProviders(result.providers);
      const provider = result.providers.find((item) => item.credential.configured && item.models.some((model) => model.tools));
      const model = provider?.models.find((item) => item.tools);
      if (provider && model) setDraftModel((current) => current ?? { provider: provider.id, model: model.id, thinking: null });
    } catch { setError("unavailable"); }
  };
  const refreshList = async () => {
    try { const result = await listConversations(); setConversations(result.conversations); return result.conversations; }
    catch { setError("storage"); return []; }
  };
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    void refreshCatalog();
    void refreshList().then((items) => { if (items[0]) setId((previous) => previous ?? items[0].id); });
  }, [open]);
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
      ready: () => { void refresh(); }, connection: (value) => { if (alive) { transportConnected = value; setConnected(value); if (!value) syncing = true; } } });
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
  const running = snapshot?.conversation.run?.status === "running";
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
    if (!text.trim() || running || (!!id && !connected) || !thinkingValid || !begin()) return;
    try {
      let conversationId = id;
      if (!conversationId) {
        const result = await createConversation(choice); conversationId = result.conversation.id; setId(conversationId);
      }
      const attempt = retry.current?.id === conversationId && retry.current.text === text ? retry.current : { id: conversationId, text, clientMessageId: crypto.randomUUID() };
      retry.current = attempt;
      await publishPageContext(context);
      await sendCopilotMessage(conversationId, { clientMessageId: attempt.clientMessageId, text, viewId: context.viewId, contextRevision: context.revision });
      setText(""); retry.current = null; following.current = true; textarea.current?.focus();
      await refreshList();
    } catch (reason) { setError(reason instanceof CopilotApiError ? reason.code : "unavailable"); }
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
      {snapshot?.messages.map((message) => <article key={message.id} className={`copilot-message copilot-message-${message.role}`} data-ui="copilot-message" data-ui-key={message.id}>
        {message.role === "user" ? <div className="copilot-user">{message.text}</div> : <><div className="copilot-assistant-label">{t("copilot.title")}</div><div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(message.text) }} /><ActionButton unstyled mode="icon" iconName="copy" label={t("copilot.copy")} data-ui="copilot-copy" className="btn icon ghost" onClick={() => void failCopy(message.text)} /></>}
        {message.context && <details className="copilot-message-context" data-ui="copilot-message-context"><summary>{message.context.objects[0]?.name ?? viewName(message.context?.view ?? "")}</summary><p>{t(message.context.status === "complete" ? "copilot.complete" : "copilot.unavailable")}</p>{message.context.objects.map((object) => <p key={object.id}>{object.name ?? viewName(message.context?.view ?? "")} · v{object.rev}</p>)}</details>}
      </article>)}
      {snapshot?.stream && <article className="copilot-message" data-ui="copilot-stream"><div className="copilot-assistant-label">{t("copilot.title")}</div><div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(snapshot.stream) }} /></article>}
      {running && <p role="status" data-ui="copilot-running">{t("copilot.running")}</p>}
      {snapshot?.conversation.run?.status === "failed" && <p role="alert" data-ui="copilot-run-error">{errorCopy(snapshot.conversation.run.error)}</p>}
      {snapshot?.conversation.run?.status === "interrupted" && <p role="status" data-ui="copilot-interrupted">{t("copilot.interrupted")}</p>}
    </div>
    {newContent && <Button className="copilot-new-content" data-ui="copilot-new-content" onClick={() => { following.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setNewContent(false); }}>{t("copilot.newContent")}</Button>}
    <div className="copilot-composer" data-ui="copilot-composer">
      <Button className="copilot-context" data-ui="copilot-context" onClick={() => setDetail(true)}><span className="copilot-context-icon" aria-hidden="true">{getConfiguredIcon(context.view === "plan" ? "list-checks" : context.view === "doc" ? "file-text" : "layers", "copilot-context")}</span><span className="copilot-context-name">{context.plan?.plans[0]?.name || viewName(context.view)}</span><Badge>{t(context.status === "complete" ? "copilot.complete" : "copilot.unavailable")}</Badge><span className="copilot-context-icon" aria-hidden="true">{getConfiguredIcon("chevron-down", "copilot-context")}</span></Button>
      {id && !connected && <p role="status" data-ui="copilot-disconnected">{t("copilot.disconnected")}</p>}
      {error && <p role="alert" data-ui="copilot-error">{errorCopy(error)} <Button onClick={() => { void refreshCatalog(); void refreshList(); void refreshCurrent.current?.(); }}>{t("common.retry")}</Button></p>}
      <div className="copilot-composer-box">
        <textarea ref={textarea} data-ui="copilot-input" aria-label={t("copilot.input")} placeholder={t("copilot.input")} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
        }} />
        <div className="copilot-composer-actions">
          <select aria-label={t("copilot.model")} data-ui="copilot-model" value={choice ? `${choice.provider}\n${choice.model}` : ""} disabled={busy} onChange={(event) => {
            const [providerId, modelId] = event.target.value.split("\n"); void choose({ provider: providerId, model: modelId, thinking: null });
          }}><option value="" disabled>{t("copilot.model")}</option>{providers.map((item) => <optgroup key={item.id} label={item.name}>{item.models.filter((model) => model.tools).map((model) => <option key={model.id} value={`${item.id}\n${model.id}`}>{model.name}</option>)}</optgroup>)}</select>
          <span className="copilot-spacer" />
          <ActionButton unstyled mode="icon" iconName="arrow-up" label={t("copilot.send")} data-ui="copilot-send" className="copilot-send" disabled={busy || running || !text.trim() || !thinkingValid || (!!id && !connected)} onClick={() => void send()} />
        </div>
      </div>
      <div className="copilot-composer-foot"><select aria-label={t("copilot.thinking")} data-ui="copilot-thinking" value={choice?.thinking ?? "default"} disabled={busy || !model || (levels.length <= 1 && thinkingValid)} onChange={(event) => { if (choice) void choose({ ...choice, thinking: event.target.value === "default" ? null : event.target.value as ThinkingLevel }); }}>
        <option value="default">{t("copilot.defaultChoice")}{model?.defaultThinking ? ` · ${model.defaultThinking}` : ""}</option>{choice?.thinking && !levels.includes(choice.thinking) && <option value={choice.thinking} disabled>{choice.thinking}</option>}{levels.length > 1 && levels.map((level) => <option key={level} value={level}>{level}</option>)}
      </select><span>{t("copilot.readOnly")}</span></div>
      {!thinkingValid && choice && <p role="alert">{t("copilot.errors.capabilities")}</p>}
    </div>
    {settings && <ProviderSettingsDialog onClose={() => { setSettings(false); void refreshCatalog(); }} />}
    {list && <Dialog title={t("copilot.conversations")} closeLabel={t("copilot.close")} onClose={() => setList(false)} uiId="copilot-conversation-list"><div className="copilot-conversation-list"><Button onClick={() => void newConversation()} disabled={busy}>{t("copilot.new")}</Button>{conversations.map((conversation) => <Button key={conversation.id} data-ui="copilot-conversation" data-ui-key={conversation.id} aria-pressed={conversation.id === id} onClick={() => { setId(conversation.id); setList(false); setText(""); retry.current = null; }}>{conversation.title || t("copilot.new")}</Button>)}</div></Dialog>}
    {detail && <Dialog title={t("copilot.context")} closeLabel={t("copilot.close")} onClose={() => setDetail(false)} uiId="copilot-context-detail"><div className="copilot-context-detail"><p>{t(context.status === "complete" ? "copilot.completeDetail" : "copilot.unavailableDetail")}</p>{context.plan && <><p>{t(context.plan.mode === "list" ? "plan.modes.list" : context.plan.mode === "board" ? "plan.modes.board" : context.plan.mode === "focus" ? "plan.focus.title" : "plan.timeline.title")} · v{context.plan.rev} · {t(context.plan.saveState === "saved" ? "copilot.saved" : context.plan.saveState === "pending" ? "copilot.saving" : "plan.notice.saveFailed")}</p>{context.plan.plans.map((plan) => <section key={plan.id}><h3>{plan.name}</h3><p>{plan.desc}</p><ul>{plan.tasks.map((task) => <li key={task.id}>{task.title} · {t(task.status === "todo" ? "plan.status.todo" : task.status === "doing" ? "plan.status.doing" : task.status === "blocked" ? "plan.status.blocked" : "plan.status.done")} · {task.due}</li>)}</ul></section>)}{context.plan.detail && <p>{t("copilot.taskDetail")} · {context.plan.detail.task.title}</p>}</>}</div></Dialog>}
  </aside>;
}
