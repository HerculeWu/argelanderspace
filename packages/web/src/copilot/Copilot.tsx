import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ContextCoverage, Conversation, ConversationModel, CopilotConfirmation, ConversationSnapshot, CopilotOperation, CopilotProvider, CopilotViewAction, CopilotViewActionResult, PageContext, ThinkingLevel, WsCopilotEvent } from "@argelanderspace/contracts";
import { type ArgumentContextSummary, type PdfContextSummary, summarizeArgumentPage, summarizeDiscoveryPage, summarizeMailPage, summarizePdfPage, summarizeReaderPage, summarizeWriterPage } from "@argelanderspace/contracts";
import { FileToolCard } from "./FileToolCard";
import { MailSendUndo, MailSummary } from "./MailConfirmation";
import { type ConfirmationGuards, type ConfirmationProblemScope, kindOf } from "./confirmations";
import { CopilotApiError, createConversation, decideConfirmation, fetchConversation, listConversations, postViewActionResult, publishPageContext, resumeConversation, selectConversationModel, sendCopilotMessage, stopConversation, undoOperation } from "../api/copilot";
import { fmtDate } from "../plan/model";
import { fetchProviders } from "../api/providers";
import { onPlanChanged, subscribeCopilot } from "../api/ws";
import { fetchUndoableState } from "../api/plans";
import { ActionButton, Badge, Button, Dialog, getConfiguredIcon, Select } from "../ui";
import { ProviderSettingsDialog } from "./ProviderSettings";
import { LiveRunStatus, ThinkingBlock } from "./LiveStatus";
import { Icon } from "../lib/icons";
import { copilotMarkdown } from "./markdown";
import "./copilot.css";
/** How long an applied view action may take to show up in the page context before it is reported anyway (it may have changed nothing). */
const SETTLE_WAIT_MS = 400;
/** What a click-time system error (`unreadable`) says, by the card's problem scope (ticket 42). */
const UNREADABLE_COPY = {
  plan: "copilot.confirmation.unreadablePlan",
  doc: "copilot.confirmation.unreadableDoc",
  deleteDoc: "copilot.confirmation.unreadableDeleteDoc",
  manuscript: "copilot.confirmation.unreadableManuscript",
  mail: "copilot.confirmation.unreadableMail",
  argument: "copilot.confirmation.unreadableArgument",
  file: "copilot.confirmation.unreadableFile",
  shelf: "copilot.confirmation.unreadableShelf",
} as const satisfies Record<ConfirmationProblemScope, string>;

export const OPERATION_ACTION_KEYS = {
  read: "copilot.operations.actions.read", create_plan: "copilot.operations.actions.create_plan", update_plan: "copilot.operations.actions.update_plan",
  create_task: "copilot.operations.actions.create_task", update_task: "copilot.operations.actions.update_task", add_task_link: "copilot.operations.actions.add_task_link",
  remove_task_link: "copilot.operations.actions.remove_task_link", move_task: "copilot.operations.actions.move_task", show: "copilot.operations.actions.show",
  open_task: "copilot.operations.actions.open_task", close_task: "copilot.operations.actions.close_task",
  provider_status: "copilot.operations.actions.provider_status", select_model: "copilot.operations.actions.select_model", open_copilot: "copilot.operations.actions.open_copilot", close_copilot: "copilot.operations.actions.close_copilot", open_doc: "copilot.operations.actions.open_doc",
  set_completed: "copilot.operations.actions.set_completed", retry_plans: "copilot.operations.actions.retry_plans", open_task_doc: "copilot.operations.actions.open_task_doc", capabilities: "copilot.operations.actions.capabilities",
  switch_view: "copilot.operations.actions.switch_view", split_pane: "copilot.operations.actions.split_pane", close_pane: "copilot.operations.actions.close_pane", select_pane: "copilot.operations.actions.select_pane",
  resize_pane: "copilot.operations.actions.resize_pane", set_appearance: "copilot.operations.actions.set_appearance", open_copilot_settings: "copilot.operations.actions.open_copilot_settings",
  delete_plan: "copilot.operations.actions.delete_plan", delete_task: "copilot.operations.actions.delete_task", undo_delete_task: "copilot.operations.actions.undo_delete_task",
  set_main_doc: "copilot.operations.actions.set_main_doc", filter_library: "copilot.operations.actions.filter_library", select_work: "copilot.operations.actions.select_work",
  set_detail_tab: "copilot.operations.actions.set_detail_tab", set_sidebar: "copilot.operations.actions.set_sidebar", set_temp_label: "copilot.operations.actions.set_temp_label",
  set_graph_labels: "copilot.operations.actions.set_graph_labels", graph_control: "copilot.operations.actions.graph_control", import_works: "copilot.operations.actions.import_works",
  acquire_arxiv_pdf: "copilot.operations.actions.acquire_arxiv_pdf", attach_arxiv: "copilot.operations.actions.attach_arxiv", read_jobs: "copilot.operations.actions.read_jobs", delete_doc: "copilot.operations.actions.delete_doc",
  read_discovery: "copilot.operations.actions.read_discovery", save_candidate: "copilot.operations.actions.save_candidate", explore_work: "copilot.operations.actions.explore_work", explore_candidate: "copilot.operations.actions.explore_candidate",
  retry_exploration: "copilot.operations.actions.retry_exploration", cancel_exploration: "copilot.operations.actions.cancel_exploration", step_exploration: "copilot.operations.actions.step_exploration", exit_exploration: "copilot.operations.actions.exit_exploration",
  resume_exploration: "copilot.operations.actions.resume_exploration", filter_discovery: "copilot.operations.actions.filter_discovery", search_discovery: "copilot.operations.actions.search_discovery", set_discovery_display: "copilot.operations.actions.set_discovery_display",
  select_candidate: "copilot.operations.actions.select_candidate", set_discovery_tab: "copilot.operations.actions.set_discovery_tab", dismiss_discovery_error: "copilot.operations.actions.dismiss_discovery_error", view_candidate_in_library: "copilot.operations.actions.view_candidate_in_library",
  set_discovery_graph_labels: "copilot.operations.actions.set_discovery_graph_labels", discovery_graph_control: "copilot.operations.actions.discovery_graph_control",
  navigate: "copilot.operations.actions.navigate", jump_back: "copilot.operations.actions.jump_back", set_panel: "copilot.operations.actions.set_panel", set_right_tab: "copilot.operations.actions.set_right_tab", retry_sync: "copilot.operations.actions.retry_sync",
  read_page_image: "copilot.operations.actions.read_page_image", read_image: "copilot.operations.actions.read_image", read_svg_image: "copilot.operations.actions.read_svg_image", load_instruction: "copilot.operations.actions.load_instruction", goto_page: "copilot.operations.actions.goto_page", next_page: "copilot.operations.actions.next_page", previous_page: "copilot.operations.actions.previous_page",
  open_outline_item: "copilot.operations.actions.open_outline_item", search: "copilot.operations.actions.search", open_search_result: "copilot.operations.actions.open_search_result", open_annotation: "copilot.operations.actions.open_annotation", zoom: "copilot.operations.actions.zoom", download_original: "copilot.operations.actions.download_original",
  create_annotation: "copilot.operations.actions.create_annotation", update_annotation: "copilot.operations.actions.update_annotation", delete_annotation: "copilot.operations.actions.delete_annotation",
  create_manuscript: "copilot.operations.actions.create_manuscript", update_manuscript: "copilot.operations.actions.update_manuscript", delete_manuscript: "copilot.operations.actions.delete_manuscript", open_manuscript: "copilot.operations.actions.open_manuscript", close_manuscript: "copilot.operations.actions.close_manuscript",
  insert_cell: "copilot.operations.actions.insert_cell", update_cell: "copilot.operations.actions.update_cell", delete_cell: "copilot.operations.actions.delete_cell", convert_cell: "copilot.operations.actions.convert_cell", add_comment: "copilot.operations.actions.add_comment", insert_reference: "copilot.operations.actions.insert_reference",
  render_manuscript: "copilot.operations.actions.render_manuscript", export_manuscript: "copilot.operations.actions.export_manuscript", select_cell: "copilot.operations.actions.select_cell", edit_cell: "copilot.operations.actions.edit_cell", commit_cell: "copilot.operations.actions.commit_cell", set_writer_panel: "copilot.operations.actions.set_writer_panel", set_writer_tab: "copilot.operations.actions.set_writer_tab", dismiss_template_warning: "copilot.operations.actions.dismiss_template_warning", retry_manuscript_list: "copilot.operations.actions.retry_manuscript_list",
  create_pdf_annotation: "copilot.operations.actions.create_pdf_annotation", update_pdf_annotation: "copilot.operations.actions.update_pdf_annotation", delete_pdf_annotation: "copilot.operations.actions.delete_pdf_annotation",
  undo_pdf_annotation: "copilot.operations.actions.undo_pdf_annotation", redo_pdf_annotation: "copilot.operations.actions.redo_pdf_annotation",
  create: "copilot.operations.actions.create", read_source: "copilot.operations.actions.read_source", save_source: "copilot.operations.actions.save_source",
  add_pdf_image: "copilot.operations.actions.add_pdf_image", validate: "copilot.operations.actions.validate", generate: "copilot.operations.actions.generate", open_source_pdf: "copilot.operations.actions.open_source_pdf", set_text_view: "copilot.operations.actions.set_text_view",
} as const;
/** The name of an operation as the user's record shows it; the live status uses the same words. */
export function operationActionLabel(t: TFunction, tool: string, action: string | undefined): string {
  if (!action) return tool;
  if (tool === "mail") return t(`copilot.operations.mail.${action}`, { defaultValue: action });
  if (tool === "argument") return t(`copilot.operations.argument.${action}`, { defaultValue: action });
  if (tool === "shelf") return t(`copilot.operations.shelf.${action}`, { defaultValue: action });
  return tool === "library" && action === "read" ? t("copilot.operations.actions.read_library") : tool === "reader" && action === "read" ? t("copilot.operations.actions.read_reader") : tool === "writer" && action === "read" ? t("copilot.operations.actions.read_writer") : action in OPERATION_ACTION_KEYS ? t(OPERATION_ACTION_KEYS[action as keyof typeof OPERATION_ACTION_KEYS]) : action;
}
const OPERATION_STATUS_KEYS = {
  ok: "copilot.operations.status.ok", noop: "copilot.operations.status.noop", conflict: "copilot.operations.status.conflict", not_found: "copilot.operations.status.not_found",
  rejected: "copilot.operations.status.rejected", invalid: "copilot.operations.status.invalid", not_displayed: "copilot.operations.status.not_displayed",
  unsupported: "copilot.operations.status.unsupported", unknown: "copilot.operations.status.unknown", error: "copilot.operations.status.error",
  confirmation_required: "copilot.operations.status.confirmation_required", declined: "copilot.operations.status.declined", expired: "copilot.operations.status.expired", interrupted: "copilot.operations.status.interrupted", pending: "copilot.operations.status.pending",
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

/** What the argument graph view carried (argument graph ticket 04): its state, size and revision, the audit count, the open argument, and whether the field text was sent in part. */
function ArgumentSummary({ summary }: { summary: ArgumentContextSummary }) {
  const { t } = useTranslation();
  const loaded = summary.rev !== null;
  return <div className="copilot-library-summary" data-ui="copilot-argument-summary">
    <p>{t(`copilot.argument.${summary.state}`)}</p>
    {loaded && <p>{t("copilot.argument.counts", { arguments: summary.arguments, edges: summary.edges, rev: summary.rev })}{summary.findings > 0 && ` · ${t("copilot.argument.findings", { count: summary.findings })}`}</p>}
    {summary.selectedId && <p>{t("copilot.argument.open", { title: summary.selectedTitle ?? summary.selectedId })}</p>}
    {summary.partial && <p data-ui="copilot-argument-partial">{t("copilot.argument.partial")}</p>}
  </div>;
}

/** What the Reader carried (copilot ticket 18): which Doc, whether a reading was sent, how much, and the user's place and selection. */
function ReaderSummary({ summary, title, sent = true }: { sent?: boolean; summary: { docId: string; phase: "ready" | "syncing" | "error" | "missing"; sections: number; blocks: number; references: number; annotations: number; selection: boolean; activeSectionId: string | null; activeSectionLabel?: string }; title?: string }) {
  const { t } = useTranslation();
  return <div className="copilot-library-summary" data-ui="copilot-reader-summary">
    <p>{t(`copilot.reader.${summary.phase}`, { id: title ?? summary.docId })}</p>
    {summary.phase === "ready" && <p>{t(sent ? "copilot.reader.counts" : "copilot.reader.totals", { sections: summary.sections, blocks: summary.blocks, references: summary.references, annotations: summary.annotations })}</p>}
    {summary.phase === "ready" && summary.activeSectionId && <p>{t("copilot.reader.position", { section: summary.activeSectionLabel ?? summary.activeSectionId })}</p>}
    {summary.selection && <p>{t("copilot.reader.selection")}</p>}
  </div>;
}

/**
 * The status a message's context badge shows. The page's own status says the PAGE was complete; what the model was
 * really given of a PDF is the material's: not attached (busy, changed, error, not found) is unavailable, and pages
 * without a text layer that a text-only model cannot read make it partial, never "complete".
 */
export function messageContextStatus(context: { status: "complete" | "unavailable" | "error"; pdf?: PdfContextSummary; argument?: { partial: boolean }; coverage?: ContextCoverage }): "complete" | "unavailable" | "partial" {
  // A reading delivered in parts, or left out for want of room, is never "complete" (ticket 24).
  if (context.coverage && (context.coverage.status === "partial" || context.coverage.status === "omitted")) return "partial";
  // What the ledger took out of the conversation (or the provider rejected) was read at most once: never "Complete".
  if (context.coverage && (context.coverage.evicted || context.coverage.withdrawn)) return "partial";
  // An argument graph whose other arguments' field text was left out is not the whole page (argument graph ticket 04).
  if (context.argument?.partial) return "partial";
  const material = context.pdf?.material;
  if (material) {
    if (material.status === "omitted") return "partial";
    if (material.status !== "ok" && material.status !== "held") return "unavailable";
    // Pages without a text layer that a text-only model cannot read: partial, whatever was sent in this message.
    const unreadable = material.totals?.pagesWithoutText ?? material.pagesWithoutText;
    if (!material.modelAcceptsImages && unreadable > 0) return "partial";
  }
  return context.status === "complete" ? "complete" : "unavailable";
}

/** What of the Reader reading / PDF material one message delivered (ticket 24): the range, the total and what is not read yet. Ranges are shown one-based, as the Reader numbers them. */
function CoverageSummary({ coverage }: { coverage: ContextCoverage }) {
  const { t } = useTranslation();
  const unit = t(coverage.unit === "pages" ? "copilot.coverage.pages" : coverage.unit === "characters" ? "copilot.coverage.characters" : "copilot.coverage.entries");
  const key = coverage.withdrawn ? "withdrawn" : coverage.status === "held" && coverage.evicted ? "heldGone" : coverage.status;
  return <p data-ui="copilot-coverage" data-status={coverage.status}>{t(`copilot.coverage.${key}`, { unit, from: coverage.from + 1, to: coverage.to, total: coverage.total, remaining: coverage.total - coverage.to })}{coverage.evicted && coverage.status !== "held" && ` ${t("copilot.coverage.evicted")}`}</p>;
}

/** What the PDF Reader carried (copilot ticket 20): which Doc, where the user is (one-based, as the Reader shows it), what the service attached. */
function PdfSummary({ summary, title }: { summary: PdfContextSummary; title?: string }) {
  const { t } = useTranslation();
  const material = summary.material;
  return <div className="copilot-library-summary" data-ui="copilot-pdf-summary">
    <p>{t(`copilot.pdf.${summary.phase}`, { id: title ?? summary.docId })}</p>
    {summary.phase === "ready" && summary.currentPage !== null && <p>{t("copilot.pdf.position", { page: summary.currentPage + 1, total: summary.pageCount })}</p>}
    {material && (material.status === "ok"
      ? <p>{t(material.pagesWithoutText === 0 ? "copilot.pdf.material" : material.modelAcceptsImages ? "copilot.pdf.materialScans" : "copilot.pdf.materialBlind", { pages: material.pages, withText: material.pagesWithText, withoutText: material.pagesWithoutText })}</p>
      : material.status === "held" || material.status === "omitted" ? null : <p>{t(`copilot.pdf.materialMissing.${material.status}`)}</p>)}
    {summary.selection && <p>{t("copilot.pdf.selection")}</p>}
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

export type CopilotViewActionHandler = (action: CopilotViewAction) => Promise<Pick<CopilotViewActionResult, "ok" | "detail" | "http" | "folded">>;

export function Copilot({ open, context, onClose, onViewAction, onOpenPanel, settingsAsked = 0, viewReady = true, onAttention, guards }: { open: boolean; /** Counts the requests to open the provider settings dialog from elsewhere (the settings page's entry): each new count opens it, as the panel's own settings button does. */ settingsAsked?: number; /** The page's own guards before an approval takes something open away (unsaved draft protection); false keeps the card. A missing guard lets the approval through. */ guards?: Partial<ConfirmationGuards>; context: PageContext; onClose: () => void; onViewAction?: CopilotViewActionHandler; /** Shows the panel itself: an explicit request to open its settings must be visible. */ onOpenPanel?: () => void; /** False until this tab knows its view id is its own: nothing subscribes or publishes before. */ viewReady?: boolean; /** True while a confirmation waits for the user, so a collapsed panel can say so. */ onAttention?: (waiting: boolean) => void }) {
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
  useEffect(() => { if (settingsAsked > 0) setSettings(true); }, [settingsAsked]);
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
  // What an action changed reaches the page context through renders of unknown delay: wait for a revision newer than the one the action started from (an applied action that changes nothing times out), then for the renders that follow it to go quiet.
  const settlePublished = async (startRevision: number, expectChange: boolean) => {
    const deadline = Date.now() + SETTLE_WAIT_MS;
    while (expectChange && latestContext.current.revision <= startRevision && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
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
      if (event.kind === "stream") setSnapshot((current) => current ? { ...current, stream: event.text ?? "", live: event.live ?? null, eventCursor: event.eventCursor } : current);
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
          const startRevision = latestContext.current.revision;
          const outcome: Pick<CopilotViewActionResult, "ok" | "detail" | "http" | "folded"> = message.action.action === "open_copilot_settings" ? { ok: true } : viewActionRef.current ? await viewActionRef.current(message.action).catch(() => ({ ok: false, detail: "unavailable" as const })) : { ok: false, detail: "unavailable" as const };
          // What the action changed reaches the page context through a few renders: report only once the service holds the page that shows it, so a call that follows (read_discovery, save_candidate) never sees the old page.
          await settlePublished(startRevision, outcome.ok && message.action.action !== "open_copilot_settings");
          try { await postViewActionResult(message.viewId, { actionId: message.actionId, ok: outcome.ok, ...(outcome.detail ? { detail: outcome.detail } : {}), ...(outcome.http !== undefined ? { http: outcome.http } : {}), ...(outcome.folded ? { folded: outcome.folded } : {}) }); } catch { /* the service times the action out as not displayed */ }
        })();
      },
      ready: () => { transportConnected = true; republish(); void refresh(); }, connection: (value) => { if (alive) { transportConnected = value; setConnected(value); if (!value) syncing = true; } } });
    return () => { alive = false; generation++; refreshCurrent.current = null; unsubscribe(); };
  }, [id, context.viewId, viewReady]);
  useEffect(() => {
    if (!snapshot || !open) return;
    if (following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    else setNewContent(true);
  }, [snapshot?.stream, snapshot?.live?.thinking, snapshot?.live?.phase, snapshot?.messages.length, open]);
  const viewName = (view: string) => view === "plan" ? t("shell.nav.plan") : view === "library" ? t("shell.nav.library") : view === "doc" ? t("shell.nav.doc") : view === "write" ? t("shell.nav.write") : view === "mail" ? t("shell.nav.mail") : t("copilot.unavailable");
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
  const failed = runStatus === "failed";
  // A run the user stopped, or the service interrupted, is resumed from the composer's one action button; a failed run keeps its notice and Retry.
  const resumable = !running && !stopping && (runStatus === "stopped" || runStatus === "interrupted");
  // The button resumes only while the composer is empty; with text typed it is Send (Enter sends in both cases).
  const resumeAction = resumable && !text.trim();
  const thinkingLabel = (level: ThinkingLevel) => t(THINKING_KEYS[level]);
  const lastTask = [...(snapshot?.messages ?? [])].reverse().find((message) => message.role === "user" && message.kind !== "resume" && !message.pending);
  // The task's objects are what was captured when it started. Name them only when that is unambiguous (one object).
  const workObjects = lastTask?.context?.objects ?? [];
  const workObject = workObjects.length === 1 ? workObjects[0] : undefined;
  const elsewhere = running && workObjects.length > 0 && context.view === "plan" && !!context.plan?.selectedPlanId && !workObjects.some((object) => object.id === context.plan?.selectedPlanId);
  // The undo (8 s window) for a confirmed task delete: shown only while the service still holds it.
  const [undone, setUndone] = useState<Set<string>>(() => new Set());
  const [, setClock] = useState(0);
  // The toolCallIds of this conversation's deletes the service can still undo; null while unknown. A task already restored
  // elsewhere (the Plan page, the Copilot's own tool) stops being offered here.
  const [live, setLive] = useState<Set<string> | null>(null);
  const undoable = (snapshot?.messages ?? []).flatMap((message) => message.operations ?? []).reverse().find((operation) => operation.undo && !operation.mailSend && !undone.has(operation.id) && Date.parse(operation.undo.until) > Date.now() && (live === null || live.has(operation.id)));
  const pendingUndoId = (snapshot?.messages ?? []).flatMap((message) => message.operations ?? []).reverse().find((operation) => operation.undo && !operation.mailSend && !undone.has(operation.id) && Date.parse(operation.undo.until) > Date.now())?.id;
  const refreshLive = useCallback(async () => {
    const state = await fetchUndoableState();
    setLive(state ? new Set(state.flatMap((entry) => (entry.conversationId === id && entry.toolCallId ? [entry.toolCallId] : []))) : null);
  }, [id]);
  useEffect(() => {
    if (!pendingUndoId) return;
    void refreshLive();
    return onPlanChanged(() => void refreshLive());
  }, [pendingUndoId, refreshLive]);
  const undoUntil = undoable?.undo ? Date.parse(undoable.undo.until) : 0;
  useEffect(() => {
    if (!undoUntil) return;
    const timer = window.setTimeout(() => setClock((value) => value + 1), Math.max(0, undoUntil - Date.now()) + 50);
    return () => window.clearTimeout(timer);
  }, [undoUntil]);
  // What the user's undo did stays visible (restored, or why not) until dismissed; the service also tells the model.
  const [undoResult, setUndoResult] = useState<{ kind: "restored" | "failed"; label: string } | null>(null);
  // A refused confirmation click is explained here, not only on the card: the card disappears when the list is reread.
  const [decisionProblem, setDecisionProblem] = useState<{ kind: "expired" | "failed" | "unreadable"; scope: ConfirmationProblemScope } | null>(null);
  const cardGuards: ConfirmationGuards = { leaveDoc: (docId) => guards?.leaveDoc?.(docId) ?? true, leaveManuscript: (id) => guards?.leaveManuscript?.(id) ?? true };
  const waitingForConfirmation = !!snapshot?.confirmations?.length;
  const attentionRef = useRef(onAttention); attentionRef.current = onAttention;
  useEffect(() => { attentionRef.current?.(waitingForConfirmation); return () => attentionRef.current?.(false); }, [waitingForConfirmation]);
  useEffect(() => { setUndoResult(null); setDecisionProblem(null); }, [id]);
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
  /** One conversation however many sends arrive at once with none open yet. */
  const creating = useRef<Promise<string> | null>(null);
  const ensureConversation = (): Promise<string> => {
    if (id) return Promise.resolve(id);
    creating.current ??= (async () => {
      const result = await createConversation(choice);
      const created = result.conversation.id;
      setId(created);
      return created;
    })().finally(() => { creating.current = null; });
    return creating.current;
  };
  const send = async () => {
    if (!text.trim() || stopping || (!!id && !connected) || !thinkingValid || !begin()) return;
    try {
      const conversationId = await ensureConversation();
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
  const errorCopy = (code: string | null) => t(code === "storage" ? "copilot.errors.storage" : code === "capabilities" ? "copilot.errors.capabilities" : code === "capacity" ? "copilot.errors.capacity" : code === "provider_capacity" ? "copilot.errors.providerCapacity" : code === "credentials" ? "copilot.errors.credentials" : code === "busy" ? "copilot.errors.busy" : code === "stale" ? "copilot.errors.stale" : code === "clipboard" ? "copilot.errors.clipboard" : code === "rate_limit" ? "copilot.errors.rateLimit" : code === "transient" ? "copilot.errors.transient" : code === "quota" ? "copilot.errors.quota" : "copilot.errors.unavailable");
  const failCopy = async (value: string) => { try { await navigator.clipboard.writeText(value); } catch { setError("clipboard"); } };
  return <aside className="copilot" data-ui="copilot-sidebar" aria-label={t("copilot.title")} hidden={!open}>
    <header className="copilot-header" data-ui="copilot-header">
      <ActionButton unstyled mode="text" label={t("copilot.conversations")} tooltip={t("copilot.conversations")} data-ui="copilot-conversations" className="copilot-title" onClick={() => { setList(true); void refreshList(); }}>{t("copilot.title")}<span aria-hidden="true" className="copilot-chevron">{getConfiguredIcon("chevron-down", "copilot-conversations")}</span></ActionButton>
      <span className="copilot-spacer" />
      <ActionButton unstyled mode="icon" iconName="square-pen" label={t("copilot.new")} data-ui="copilot-new-conversation" className="btn icon ghost" disabled={busy} onClick={() => void newConversation()} />
      <ActionButton unstyled mode="icon" iconName="settings-2" label={t("providers.title")} data-ui="copilot-settings" className="btn icon ghost" onClick={() => setSettings(true)} />
      <ActionButton unstyled mode="icon" iconName="panel-right-close" label={t("copilot.close")} data-ui="copilot-close" className="btn icon ghost" onClick={() => { onClose(); document.querySelector<HTMLElement>('[data-ui="copilot-toggle"]')?.focus(); }} />
    </header>
    <div ref={scroll} className="copilot-messages" data-ui="copilot-messages" onScroll={() => {
      const node = scroll.current; if (!node) return;
      following.current = node.scrollHeight - node.clientHeight - node.scrollTop < 40;
      if (following.current) setNewContent(false);
    }}>
      {!snapshot?.messages.length && <div className="copilot-empty"><Icon name="sparkles" /><h2>{t("copilot.emptyTitle")}</h2><p>{t("copilot.empty")}</p></div>}
      {snapshot?.messages.map((message, index) => { const continued = message.role === "assistant" && snapshot.messages[index - 1]?.role === "assistant"; return <article key={message.id} className={`copilot-message copilot-message-${message.role}${continued ? " copilot-message-continued" : ""}`} data-ui="copilot-message" data-ui-key={message.id}>
        {message.role === "user" ? <><div className={message.kind === "resume" ? "copilot-user copilot-user-resume" : "copilot-user"} data-ui={message.kind === "resume" ? "copilot-resume-marker" : undefined}>{message.kind === "resume" ? t("copilot.resumed") : message.text}</div>{!!message.attachments?.length && <div className="copilot-attachments sent" data-ui="copilot-message-attachments">{message.attachments.map((item, at) => <span key={at} className="copilot-attachment" data-ui="copilot-message-attachment" title={item.filename}><Icon name="paperclip" /><span className="copilot-attachment-name">{item.filename}</span></span>)}</div>}{message.pending && <div className="copilot-queued" data-ui="copilot-queued" role="status">{t("copilot.queued")}</div>}</> : <>{!continued && <div className="copilot-assistant-label">{t("copilot.title")}</div>}{message.thinking && <ThinkingBlock text={message.thinking} />}{message.operations && message.operations.length > 0 && <MessageOperations operations={message.operations} confirmations={snapshot.confirmations ?? []} renderConfirmation={(confirmation) => <ConfirmationCard key={confirmation.id} confirmation={confirmation} viewId={context.viewId} connected={connected} guards={cardGuards} onProblem={setDecisionProblem} onSettled={() => void refreshCurrent.current?.()} />} />}{message.text && <><div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(message.text) }} /><ActionButton unstyled mode="icon" iconName="copy" label={t("copilot.copy")} data-ui="copilot-copy" className="btn icon ghost" onClick={() => void failCopy(message.text)} /></>}</>}
        {message.context && <details className="copilot-message-context" data-ui="copilot-message-context"><summary>{message.context.objects[0]?.name ?? viewName(message.context?.view ?? "")}</summary><p>{t(`copilot.${messageContextStatus(message.context)}`)}</p>{message.context.library && <LibrarySummary summary={message.context.library} />}{message.context.discovery && <DiscoverySummary summary={message.context.discovery} />}{message.context.argument && <ArgumentSummary summary={message.context.argument} />}{message.context.coverage && <CoverageSummary coverage={message.context.coverage} />}{message.context.reader && <ReaderSummary summary={message.context.reader} title={message.context.objects[0]?.name} sent={!message.context.coverage || message.context.coverage.status === "complete"} />}{message.context.pdf && <PdfSummary summary={message.context.pdf} title={message.context.objects[0]?.name} />}{message.context.writer && <WriterSummary summary={message.context.writer} title={message.context.objects[0]?.name} />}{message.context.mail && <MailSummary summary={message.context.mail} />}{message.context.view !== "mail" && message.context.objects.map((object) => <p key={object.id}>{message.context?.view === "library" || message.context?.view === "doc" ? (object.name ?? object.id) : t("copilot.objectVersion", { name: object.name ?? viewName(message.context?.view ?? ""), rev: object.rev })}</p>)}</details>}
      </article>; })}
      {(snapshot?.stream || snapshot?.live?.thinking) && <article className="copilot-message" data-ui="copilot-stream"><div className="copilot-assistant-label">{t("copilot.title")}</div>{snapshot.live?.thinking && <ThinkingBlock text={snapshot.live.thinking} live={snapshot.live.phase === "thinking"} />}{snapshot.stream && <div className="copilot-markdown" dangerouslySetInnerHTML={{ __html: copilotMarkdown(snapshot.stream) }} />}</article>}
      {snapshot?.confirmations?.filter((confirmation) => !inlineConfirmation(snapshot, confirmation)).map((confirmation) => <ConfirmationCard key={confirmation.id} confirmation={confirmation} viewId={context.viewId} connected={connected} guards={cardGuards} onProblem={setDecisionProblem} onSettled={() => void refreshCurrent.current?.()} />)}
      {decisionProblem && <div className="copilot-notice error" data-ui="copilot-confirmation-problem" role="alert"><span>{decisionProblem.kind === "unreadable" ? t(UNREADABLE_COPY[decisionProblem.scope]) : t(`copilot.confirmation.${decisionProblem.kind}${decisionProblem.scope === "plan" ? "" : decisionProblem.scope === "deleteDoc" ? "DeleteDoc" : decisionProblem.scope === "manuscript" ? "Manuscript" : decisionProblem.scope === "mail" ? "Mail" : decisionProblem.scope === "argument" ? "Argument" : decisionProblem.scope === "file" ? "File" : decisionProblem.scope === "shelf" ? "Shelf" : "Doc"}`)}</span><ActionButton unstyled mode="icon" iconSize="small" iconName="x" label={t("plan.action.dismissUndo")} tooltip={t("plan.action.dismissUndo")} data-ui="copilot-confirmation-problem-dismiss" className="btn icon ghost" onClick={() => setDecisionProblem(null)} /></div>}
      <div className="copilot-run-live" role="status" aria-atomic="false" data-ui="copilot-run-live">{((running && !waiting) || stopping) && <div className="copilot-run-card" data-ui="copilot-running"><span className="copilot-pulse" aria-hidden="true" /><LiveRunStatus live={stopping ? null : snapshot?.live ?? null} stopping={stopping} actionLabel={(operation) => operation.action && operation.action in OPERATION_ACTION_KEYS ? operationActionLabel(t, operation.tool, operation.action) : null} />{elsewhere && <small data-ui="copilot-work-continues">{workObject?.name ? t("copilot.workContinues", { name: workObject.name }) : t("copilot.workContinuesOriginal")}</small>}</div>}</div>
      <MailSendUndo operations={(snapshot?.messages ?? []).flatMap((message) => message.operations ?? [])} />
      {undoable && <div className="copilot-notice" data-ui="copilot-undo" role="status"><span>{t("plan.undo.deleted", { title: undoable.label ?? "" })}</span><Button data-ui="copilot-undo-delete" onClick={() => void undo()}>{t("plan.undo.action")}</Button><ActionButton unstyled mode="icon" iconSize="small" iconName="x" label={t("plan.action.dismissUndo")} tooltip={t("plan.action.dismissUndo")} data-ui="copilot-undo-dismiss" className="btn icon ghost" onClick={() => setUndone((previous) => new Set(previous).add(undoable.id))} /></div>}
      {undoResult && <div className={undoResult.kind === "failed" ? "copilot-notice error" : "copilot-notice"} data-ui="copilot-undo-result" data-status={undoResult.kind} role={undoResult.kind === "failed" ? "alert" : "status"}><span>{t(undoResult.kind === "restored" ? "copilot.undo.restored" : "copilot.undo.failed", { title: undoResult.label })}</span><ActionButton unstyled mode="icon" iconSize="small" iconName="x" label={t("plan.action.dismissUndo")} tooltip={t("plan.action.dismissUndo")} data-ui="copilot-undo-result-dismiss" className="btn icon ghost" onClick={() => setUndoResult(null)} /></div>}
      {runStatus === "interrupted" && <div className="copilot-notice" data-ui="copilot-run-result" role="status" data-status="interrupted"><span data-ui="copilot-interrupted">{t("copilot.interrupted")}</span></div>}
      {failed && <div className="copilot-notice error" data-ui="copilot-run-result" role="alert" data-status="failed">
        <span data-ui="copilot-run-error">{errorCopy(snapshot?.conversation.run?.error ?? null)}</span>
        <Button data-ui="copilot-retry" disabled={busy || (!!id && !connected)} onClick={() => void resume()}>{t("common.retry")}</Button>
      </div>}
    </div>
    {newContent && <Button className="copilot-new-content" data-ui="copilot-new-content" onClick={() => { following.current = true; if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setNewContent(false); }}>{t("copilot.newContent")}</Button>}
    <div className="copilot-composer" data-ui="copilot-composer">
      <Button className="copilot-context" data-ui="copilot-context" onClick={() => setDetail(true)}><span className="copilot-context-icon" aria-hidden="true">{getConfiguredIcon(context.view === "plan" ? "list-checks" : context.view === "doc" ? "file-text" : "layers", "copilot-context")}</span><span className="copilot-context-name">{context.plan?.plans[0]?.name || context.reader?.reading?.title || context.writer?.editor?.saved?.title || viewName(context.view)}</span><Badge>{t(context.status === "complete" ? "copilot.complete" : "copilot.unavailable")}</Badge><span className="copilot-context-icon" aria-hidden="true">{getConfiguredIcon("chevron-down", "copilot-context")}</span></Button>
      {id && !connected && <p role="status" data-ui="copilot-disconnected">{t("copilot.disconnected")}</p>}
      {error && <p role="alert" data-ui="copilot-error">{errorCopy(error)} <Button onClick={() => { void refreshCatalog(); void refreshList(); void refreshCurrent.current?.(); }}>{t("common.retry")}</Button></p>}
      <div className="copilot-composer-box">
        <textarea ref={textarea} data-ui="copilot-input" aria-label={t("copilot.input")} placeholder={t(running ? "copilot.steerHint" : "copilot.input")} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); }
        }} />
        <div className="copilot-composer-actions">
          <Select variant="inline" data-ui="copilot-model" aria-label={t("copilot.model")} value={choice ? `${choice.provider}\n${choice.model}` : ""} disabled={busy}
            onChange={(next) => { const [providerId, modelId] = next.split("\n"); void choose({ provider: providerId, model: modelId, thinking: null }); }}
            options={[{ value: "", label: t("copilot.model"), disabled: true }, ...providers.flatMap((item) => item.models.filter((model) => model.tools).map((model) => ({ value: `${item.id}\n${model.id}`, label: model.name, group: item.name })))]} />
          <span className="copilot-spacer" />
          <ComposerAction kind={stopping || running ? "stop" : resumeAction ? "resume" : "send"} stopping={stopping} disabled={stopping ? true : running ? !connected : resumeAction ? busy || (!!id && !connected) : busy || !text.trim() || !thinkingValid || (!!id && !connected)} onSend={() => void send()} onStop={() => void stop()} onResume={() => void resume()} />
        </div>
      </div>
      <div className="copilot-composer-foot"><Select variant="inline" data-ui="copilot-thinking" aria-label={t("copilot.thinking")} value={choice?.thinking ?? "default"} disabled={busy || !model || (levels.length <= 1 && thinkingValid)}
        onChange={(next) => { if (choice) void choose({ ...choice, thinking: next === "default" ? null : next as ThinkingLevel }); }}
        options={[
          { value: "default", label: `${t("copilot.defaultChoice")}${model?.defaultThinking ? ` · ${thinkingLabel(model.defaultThinking)}` : ""}` },
          ...(choice?.thinking && !levels.includes(choice.thinking) ? [{ value: choice.thinking, label: thinkingLabel(choice.thinking), disabled: true }] : []),
          ...(levels.length > 1 ? levels.map((level) => ({ value: level, label: thinkingLabel(level) })) : []),
        ]} /></div>
      {!thinkingValid && choice && <p role="alert">{t("copilot.errors.capabilities")}</p>}
      {context.pdf && model && !model.image && <div className="copilot-notice warning" data-ui="copilot-pdf-no-image" role="status"><span>{t("copilot.pdf.noImage")}</span></div>}
    </div>
    {settings && <ProviderSettingsDialog onClose={() => { setSettings(false); void refreshCatalog(); }} />}
    {list && <Dialog title={t("copilot.conversations")} closeLabel={t("copilot.close")} onClose={() => setList(false)} uiId="copilot-conversation-list"><div className="copilot-conversation-list"><Button onClick={() => void newConversation()} disabled={busy}>{t("copilot.new")}</Button>{conversations.map((conversation) => <Button key={conversation.id} data-ui="copilot-conversation" data-ui-key={conversation.id} data-status={conversation.run?.status} aria-pressed={conversation.id === id} onClick={() => { setId(conversation.id); setList(false); setText(""); retry.current = null; resumeAttempt.current = null; }}><span className="copilot-conversation-title">{conversation.title || t("copilot.new")}</span>{conversation.run && conversation.run.status !== "completed" && <Badge tone={conversation.run.status === "running" || conversation.run.status === "waiting-for-user" || conversation.run.status === "stopping" ? "accent" : "neutral"}>{t(RUN_STATUS_KEYS[conversation.run.status])}</Badge>}</Button>)}{unreadable.map((entry) => <p key={entry.id} className="copilot-conversation-unreadable" data-ui="copilot-conversation-unreadable" role="alert">{t("copilot.unreadable")}</p>)}</div></Dialog>}
    {detail && <Dialog title={t("copilot.context")} closeLabel={t("copilot.close")} onClose={() => setDetail(false)} uiId="copilot-context-detail"><div className="copilot-context-detail">{!context.reader && !context.pdf && !context.writer && !context.mail && !context.argument && <p>{t(context.status === "complete" ? "copilot.completeDetail" : "copilot.unavailableDetail")}</p>}{context.writer && <WriterSummary summary={summarizeWriterPage(context.writer)} />}{context.mail && <MailSummary summary={summarizeMailPage(context.mail)} />}{context.library && <LibrarySummary summary={{ source: context.library.source, error: context.library.error, query: context.library.query, total: context.library.total, matched: context.library.matched, selectedRefId: context.library.selectedRefId }} title={context.library.detail?.ref.title} />}{context.discovery && <DiscoverySummary summary={summarizeDiscoveryPage(context.discovery)} />}{context.argument && <ArgumentSummary summary={summarizeArgumentPage(context.argument)} />}{context.reader && <ReaderSummary summary={summarizeReaderPage(context.reader)} title={context.reader.reading?.title} />}{context.pdf && <PdfSummary summary={summarizePdfPage(context.pdf)} />}{context.plan && <><p>{t(context.plan.mode === "list" ? "plan.modes.list" : context.plan.mode === "board" ? "plan.modes.board" : context.plan.mode === "focus" ? "plan.focus.title" : "plan.timeline.title")} · {t("copilot.version", { rev: context.plan.rev })} · {t(context.plan.saveState === "saved" ? "copilot.saved" : context.plan.saveState === "pending" ? "copilot.saving" : "plan.notice.saveFailed")}</p>{context.plan.plans.map((plan) => <section key={plan.id}><h3>{plan.name}</h3><p>{plan.desc}</p><ul>{plan.tasks.map((task) => <li key={task.id}>{task.title} · {t(task.status === "todo" ? "plan.status.todo" : task.status === "doing" ? "plan.status.doing" : task.status === "blocked" ? "plan.status.blocked" : "plan.status.done")} · {fmtDate(task.due)}</li>)}</ul></section>)}{context.plan.detail && <p>{t("copilot.taskDetail")} · {context.plan.detail.task.title}</p>}</>}</div></Dialog>}
  </aside>;
}

/** The waiting card of prototype A: the plan, what it takes with it, and the user's own decision. */
/** The composer's single action button: send when a message can go, stop while a run works, resume after a stop or an interruption. */
export function ComposerAction({ kind, stopping, disabled, onSend, onStop, onResume }: { kind: "send" | "stop" | "resume"; stopping: boolean; disabled: boolean; onSend: () => void; onStop: () => void; onResume: () => void }) {
  const { t } = useTranslation();
  const label = t(kind === "send" ? "copilot.send" : kind === "stop" ? (stopping ? "copilot.status.stopping" : "copilot.stop") : "copilot.resume");
  // Each state is its own stable data-ui, so the icon catalog and agents address the action by what it does now.
  return <ActionButton unstyled mode="icon" iconName={kind === "send" ? "arrow-up" : kind === "stop" ? "square" : "play"} label={label} tooltip={label} data-ui={`copilot-${kind}`} className={`copilot-send copilot-${kind}`} disabled={disabled} onClick={kind === "send" ? onSend : kind === "stop" ? onStop : onResume} />;
}

function ConfirmationCard({ confirmation, viewId, connected, onSettled, onProblem, guards }: { confirmation: CopilotConfirmation; viewId: string; connected: boolean; onSettled: () => void; onProblem: (problem: { kind: "expired" | "failed" | "unreadable"; scope: ConfirmationProblemScope } | null) => void; guards: ConfirmationGuards }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  // A late answer of the page's guard (its dialog) must not send for a card that is gone (settled or withdrawn: the card
  // unmounts) or while the panel is disconnected: the decision was made about a state that may no longer exist.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const connectedNow = useRef(connected);
  connectedNow.current = connected;
  // Each card is paired with ONE kind: that kind's `match` picked it, so its `Body`, label and guard receive the card type they expect.
  const kind = kindOf(confirmation);
  // Unreachable within the contracts (every member of the union has a kind; `confirmations/index.ts` checks that at compile time):
  // only an older bundle meeting a newer action lands here, and drawing nothing is safer than passing it off as another card.
  if (!kind) return null;
  const decide = async (decision: "approve" | "decline", remember = false) => {
    if (guard.current) return;
    // The page's own guard first (the open Doc's leave guard, an open manuscript's unsaved edits); a refusal keeps the card.
    // The guard may ask with a dialog and answer later: the card waits, and a second press meanwhile does nothing.
    if (decision === "approve" && kind.beforeApprove) {
      const verdict = kind.beforeApprove(confirmation, guards);
      if (verdict === false) return;
      if (verdict !== true) {
        guard.current = true;
        let ok = false;
        try { ok = await verdict; } finally { guard.current = false; }
        if (!ok || !alive.current || !connectedNow.current) return;
      }
    }
    guard.current = true; setBusy(true); onProblem(null);
    try { await decideConfirmation(confirmation.id, { decision, viewId, action: confirmation.action, objectId: confirmation.object.id, baseRev: confirmation.baseRev, ...(remember ? { remember: true } : {}) }); }
    catch (reason) { onProblem({ kind: reason instanceof CopilotApiError && reason.code === "stale" ? "expired" : reason instanceof CopilotApiError && reason.code === "unreadable" ? "unreadable" : "failed", scope: kind.problemScope }); }
    finally { guard.current = false; setBusy(false); onSettled(); }
  };
  return <section className="copilot-confirmation" data-ui="copilot-confirmation" data-action={confirmation.action} aria-label={t("copilot.confirmation.needed")}>
    <div className="copilot-confirmation-warn" role="status"><Icon name="triangle-alert" />{t("copilot.confirmation.needed")}</div>
    <kind.Body card={confirmation} />
    {kind.session
      ? <div className="copilot-confirmation-actions copilot-tool-actions">
        <Button data-ui="copilot-confirmation-deny" disabled={busy || !connected} onClick={() => void decide("decline")}>{t("copilot.tools.deny")}</Button>
        <Button data-ui="copilot-confirmation-allow-session" disabled={busy || !connected} onClick={() => void decide("approve", true)}>{kind.session.label(t)}</Button>
        <Button appearance="primary" tone={kind.toneOf ? kind.toneOf(confirmation) : kind.tone} data-ui="copilot-confirmation-allow-once" disabled={busy || !connected} onClick={() => void decide("approve")}>{kind.confirmLabel(t, confirmation)}</Button>
      </div>
      : <div className="copilot-confirmation-actions">
        <Button data-ui="copilot-confirmation-cancel" disabled={busy || !connected} onClick={() => void decide("decline")}>{t("common.cancel")}</Button>
        <Button appearance="primary" tone={kind.toneOf ? kind.toneOf(confirmation) : kind.tone} data-ui="copilot-confirmation-confirm" disabled={busy || !connected} onClick={() => void decide("approve")}>{kind.confirmLabel(t, confirmation)}</Button>
      </div>}
  </section>;
}

/** File and command calls are shown one card each (ticket 57); the other operations of a message stay one grouped record. */
const isFileToolOperation = (operation: CopilotOperation) => operation.fileTool !== undefined;
/** A file or command confirmation sits where its call is, in the message that requested it. */
const FILE_TOOL_ACTIONS: ReadonlySet<string> = new Set(["run_command", "edit_file", "write_file"]);
function inlineConfirmation(snapshot: ConversationSnapshot, confirmation: CopilotConfirmation): boolean {
  return FILE_TOOL_ACTIONS.has(confirmation.action) && snapshot.messages.some((message) => message.operations?.some((operation) => operation.id === confirmation.toolCallId && isFileToolOperation(operation)));
}
function MessageOperations({ operations, confirmations, renderConfirmation }: { operations: CopilotOperation[]; confirmations: CopilotConfirmation[]; renderConfirmation: (confirmation: CopilotConfirmation) => JSX.Element }) {
  const parts: JSX.Element[] = [];
  let group: CopilotOperation[] = [];
  const flush = () => { if (group.length) parts.push(<OperationRecord key={`group-${group[0]?.id}`} operations={group} />); group = []; };
  for (const operation of operations) {
    if (!isFileToolOperation(operation)) { group.push(operation); continue; }
    flush();
    // The waiting call is its confirmation card; once decided, the same place shows the tool card.
    const waiting = FILE_TOOL_ACTIONS.size && confirmations.find((confirmation) => confirmation.toolCallId === operation.id && FILE_TOOL_ACTIONS.has(confirmation.action));
    parts.push(waiting ? renderConfirmation(waiting) : <FileToolCard key={operation.id} operation={operation} />);
  }
  flush();
  return <>{parts}</>;
}

function OperationRecord({ operations }: { operations: CopilotOperation[] }) {
  const { t } = useTranslation();
  const failed = operations.filter((operation) => !isApplied(operation) && operation.status !== "pending").length;
  const pending = operations.filter((operation) => operation.status === "pending").length;
  const actionName = (operation: CopilotOperation) => operationActionLabel(t, operation.tool, operation.action);
  const summary = operations.length === 1 ? actionName(operations[0] as CopilotOperation) : t(operations.every((operation) => operation.tool === "plan") ? "copilot.operations.count" : operations.every((operation) => operation.tool === "library") ? "copilot.operations.countLibrary" : "copilot.operations.countMixed", { count: operations.length });
  return <details className="copilot-operation" data-ui="copilot-operation">
    <summary><span className={failed ? "copilot-operation-mark warn" : pending ? "copilot-operation-mark pending" : "copilot-operation-mark ok"} aria-hidden="true"><Icon name={failed ? "triangle-alert" : pending ? "clock" : "check"} /></span><span className="copilot-operation-summary">{summary}{failed > 0 && ` · ${t("copilot.operations.notApplied", { count: failed })}`}{pending > 0 && ` · ${t("copilot.operations.status.pending")}`}</span><span className="copilot-operation-chevron" aria-hidden="true"><Icon name="chevron-down" /></span></summary>
    <ul>{operations.map((operation) => <li key={operation.id} data-ui="copilot-operation-item" data-ui-key={operation.id} data-status={operation.status}>
      <span>{actionName(operation)}</span>{operation.label && <span className="copilot-operation-label">{operation.label}</span>}
      <Badge tone={isApplied(operation) ? "accent" : "neutral"}>{t(operation.tool === "library" && operation.status === "conflict" ? "copilot.operations.status.conflictLibrary" : operation.tool === "reader" && operation.status === "conflict" ? "copilot.operations.status.conflictReader" : operation.tool === "writer" && operation.status === "conflict" ? "copilot.operations.status.conflictWriter" : OPERATION_STATUS_KEYS[operation.status])}</Badge>
      {operation.warnings?.includes("import_partial") && <span className="copilot-operation-warn">{t("copilot.operations.importPartial")}</span>}
      {operation.warnings?.map((warning) => warning.startsWith("source_unviewed:") ? <span key={warning} className="copilot-operation-warn" data-warning="source_unviewed">{t("copilot.operations.sourceUnviewed", { pages: warning.slice("source_unviewed:".length) })}</span> : null)}
      {operation.warnings?.includes("source_coverage_unverifiable") && <span className="copilot-operation-warn" data-warning="source_coverage_unverifiable">{t("copilot.operations.sourceUnverifiable")}</span>}
      {operation.warnings?.includes("task_due_after_plan_due") && <span className="copilot-operation-warn">{t("copilot.operations.dueAfterPlan")}</span>}
      {operation.batch && <code data-ui="copilot-operation-batch" data-status={operation.batch.status} title={t("copilot.operations.batch")}>{(() => { const batch = operation.batch; const unit = t(batch.unit === "pages" ? "copilot.coverage.pages" : batch.unit === "characters" ? "copilot.coverage.characters" : "copilot.coverage.entries"); if (batch.gap) return t("copilot.coverage.gap", { unit, id: batch.gap.id, bytes: batch.gap.bytes }); const key = batch.withdrawn ? "batchWithdrawn" : batch.status === "complete" ? "batchDone" : "batch"; return t(`copilot.coverage.${key}`, { unit, from: batch.from + 1, to: batch.to, total: batch.total, remaining: batch.total - batch.to }) + (batch.evicted ? ` ${t("copilot.coverage.evicted")}` : ""); })()}</code>}
      {operation.rev !== undefined && isApplied(operation) && <code>v{operation.rev}</code>}
      {operation.job && <code data-ui="copilot-operation-job" title={t("copilot.operations.job")}>{operation.job.id}</code>}
      {operation.docId && <code data-ui="copilot-operation-doc" title={t("copilot.operations.doc")}>{operation.docId}</code>}
    </li>)}</ul>
  </details>;
}
