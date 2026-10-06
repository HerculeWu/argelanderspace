import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TEXT_SOURCE_INLINE_MAX, type DocDescription, type TextDiagnostic, type TextReplacementImpact, type TextSourceAsset, type TextSourceDto, type TextSourcePage } from "@argelanderspace/contracts";
import { fetchDocDescription } from "../api/doc";
import {
  addPdfImage,
  fetchTextSource,
  generateTextDoc,
  saveTextSource,
  uploadTextAsset,
  validateTextSource,
} from "../api/text-docs";
import { onTextDocPublished, onTextSourceChanged } from "../api/ws";
import { registerWorkspaceLeaveGuard, useWorkspace } from "../argelander/workspace";
import { Icon } from "../lib/icons";
import { ActionButton, Dialog, InlineMessage, Tabs } from "../ui";
import { useReaderSession } from "./ReaderSession";
import { useReaderBridge } from "./reader-bridge";
import { PdfImagePicker } from "./PdfImagePicker";
import { TextSourceField, type TextSourceApi } from "./TextSourceField";
import "./text-doc.css";

type TextDescription = Extract<DocDescription, { format: "text" }>;

/**
 * Inside the Reader session of a text Doc: a regenerated reading text asks the session to read again. The
 * notification is invalidation only; the coherent read decides what the Reader shows.
 */
export function TextPublishSync({ docId }: { docId: string }) {
  const { controller } = useReaderSession();
  useEffect(
    () => onTextDocPublished((message) => { if (message.doc_id === docId) controller.requestSync(); }),
    [controller, docId]
  );
  return null;
}
type View = "reader" | "source";
type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
const AUTOSAVE_MS = 800;

const ASSET_TYPE = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP" } as const;
const ASSET_REJECT_CODES = ["unsupported_type", "corrupt_image", "too_many_pixels", "too_large", "empty", "bad_name", "too_many_assets", "document_changed", "bad_source_pdf", "invalid_request", "resource", "render_failed", "unavailable"] as const;
const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

type AssetMessage = { tone: "info" | "warning" | "danger"; text: string };

/** A fresh id per Generate click. The server only uses it to answer a repeated request of the same click with the stored result. */
const newOperationId = () => `gen-${crypto.randomUUID()}`;

/**
 * The text Doc pane (copilot ticket 25): the shared Reader on the last generated reading text, and the Markdown
 * source editor. `reader` is the already-built Reader session (this file never imports the LaTeX pane).
 * Editing saves automatically; only the explicit Generate button changes what the Reader shows.
 */
export function TextDocPane({
  docId,
  description,
  reader,
  onPage,
}: {
  docId: string;
  description: TextDescription;
  reader: ReactNode;
  /** The source panel's page for the Copilot (copilot ticket 29); null when the pane goes away. */
  onPage?: (page: TextSourcePage | null) => void;
}) {
  const { t } = useTranslation();
  const ws = useWorkspace();
  const [desc, setDesc] = useState<TextDescription>(description);
  const [view, setView] = useState<View>(description.generated ? "reader" : "source");
  const [editor, setEditor] = useState<{ rev: number; dirty: boolean }>({ rev: description.source_rev, dirty: false });

  // The Copilot's `set_text_view` presses the same tabs the user does (file-level: never a position).
  const bridge = useReaderBridge();
  useEffect(() => {
    bridge.setTextView(setView);
    return () => bridge.setTextView(null);
  }, [bridge]);
  useEffect(() => () => onPage?.(null), [onPage]);

  const refreshDescription = useCallback(() => {
    void fetchDocDescription(docId).then((result) => {
      if (result.ok && result.description.format === "text") setDesc(result.description);
    });
  }, [docId]);
  useEffect(() => onTextDocPublished((message) => { if (message.doc_id === docId) refreshDescription(); }), [docId, refreshDescription]);

  // The file relation to the PDF this text came from: only openable while that Doc still exists.
  const pdfId = desc.source_pdf?.doc_id ?? null;
  const [pdfState, setPdfState] = useState<"unknown" | "ok" | "missing">("unknown");
  useEffect(() => {
    if (!pdfId) return;
    const abort = new AbortController();
    setPdfState("unknown");
    void fetchDocDescription(pdfId, abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      setPdfState(result.ok ? "ok" : "missing");
    });
    return () => abort.abort();
  }, [pdfId]);

  const unpublished = desc.generated && (desc.published_source_rev !== editor.rev || editor.dirty);
  const trailing = (
    <div className="text-doc-trailing">
      {unpublished && (
        <span className="text-doc-unpublished" data-ui="text-unpublished" role="status">
          {t("doc.text.unpublished")}
        </span>
      )}
      {pdfId && (
        <ActionButton
          mode="text"
          unstyled
          className="text-doc-pdf"
          data-ui="text-open-source-pdf"
          label={pdfState === "missing" ? t("doc.text.sourcePdfMissing") : t("doc.text.openSourcePdf")}
          tooltip={pdfState === "missing" ? t("doc.text.sourcePdfMissing") : t("doc.text.openSourcePdf")}
          disabled={pdfState !== "ok"}
          onClick={() => ws.openDoc(pdfId)}
        >
          {pdfState === "missing" ? t("doc.text.sourcePdfMissing") : t("doc.text.openSourcePdf")}
        </ActionButton>
      )}
    </div>
  );

  return (
    <div className="text-doc" data-ui="text-doc" data-ui-key={docId}>
      <Tabs
        ariaLabel={t("doc.text.tabsAria")}
        className="text-doc-tabs"
        panelClassName="text-doc-body"
        items={[
          { value: "reader", label: t("doc.text.readerTab") },
          { value: "source", label: t("doc.text.sourceTab") },
        ]}
        value={view}
        onValueChange={setView}
        trailing={trailing}
      >
        {/* both panes stay mounted: the Reader keeps its place and drafts while the source is edited */}
        <div className="text-doc-reader" hidden={view !== "reader"} data-ui="text-reader-panel">
          {desc.generated ? (
            reader
          ) : (
            <div className="text-doc-empty" data-ui="text-doc-first-draft">
              <Icon name="file-text" cls="ico-lg" />
              <h2>{t("doc.text.emptyReaderTitle")}</h2>
              <ActionButton mode="text" data-ui="text-open-source" label={t("doc.text.sourceTab")} tooltip={t("doc.text.sourceTab")} onClick={() => setView("source")}>
                {t("doc.text.sourceTab")}
              </ActionButton>
            </div>
          )}
        </div>
        <div className="text-doc-source" hidden={view !== "source"} data-ui="text-source-panel">
          <TextSourceEditor
            docId={docId}
            generated={desc.generated}
            publishedRev={desc.published_source_rev}
            onState={setEditor}
            onPublished={refreshDescription}
            onOpenReader={() => setView("reader")}
            view={view}
            sourcePdf={desc.source_pdf ?? null}
            sourcePdfAvailable={pdfState === "ok"}
            {...(onPage ? { onPage } : {})}
          />
        </div>
      </Tabs>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Source editor
// --------------------------------------------------------------------------- //

const FAILED_KEY = {
  diagnostics: "doc.text.failed.diagnostics",
  stale: "doc.text.failed.stale",
  changed: "doc.text.failed.changed",
  busy: "doc.text.failed.busy",
  error: "doc.text.failed.error",
} as const;

/** The page's own wording per diagnostic code; an unknown code (a newer server) falls back to the server's message. */
const DIAGNOSTIC_KEYS = {
  link_unsupported: "doc.text.diag.link_unsupported",
  image_remote: "doc.text.diag.image_remote",
  image_path_unsafe: "doc.text.diag.image_path_unsafe",
  image_path_invalid: "doc.text.diag.image_path_invalid",
  image_asset_missing: "doc.text.diag.image_asset_missing",
  image_inline: "doc.text.diag.image_inline",
  image_alt_token: "doc.text.diag.image_alt_token",
  image_title_ignored: "doc.text.diag.image_title_ignored",
  table_json: "doc.text.diag.table_json",
  table_invalid: "doc.text.diag.table_invalid",
  table_unknown_field: "doc.text.diag.table_unknown_field",
  table_span_bounds: "doc.text.diag.table_span_bounds",
  table_span_overlap: "doc.text.diag.table_span_overlap",
  table_row_incomplete: "doc.text.diag.table_row_incomplete",
  table_extra_cells: "doc.text.diag.table_extra_cells",
  table_align_ignored: "doc.text.diag.table_align_ignored",
  table_too_large: "doc.text.diag.table_too_large",
  table_more_problems: "doc.text.diag.table_more_problems",
  table_math_dollar: "doc.text.diag.table_math_dollar",
  table_token_unsupported: "doc.text.diag.table_token_unsupported",
  math_display_in_table: "doc.text.diag.math_display_in_table",
  quote_unsupported: "doc.text.diag.quote_unsupported",
  rule_unsupported: "doc.text.diag.rule_unsupported",
  html_unsupported: "doc.text.diag.html_unsupported",
  definition_unsupported: "doc.text.diag.definition_unsupported",
  strike_unsupported: "doc.text.diag.strike_unsupported",
  setext_unsupported: "doc.text.diag.setext_unsupported",
  task_unsupported: "doc.text.diag.task_unsupported",
  nested_list_unsupported: "doc.text.diag.nested_list_unsupported",
  list_item_unsupported: "doc.text.diag.list_item_unsupported",
  syntax_unsupported: "doc.text.diag.syntax_unsupported",
  empty_document: "doc.text.diag.empty_document",
  document_meta_json: "doc.text.diag.document_meta_json",
  document_meta_invalid: "doc.text.diag.document_meta_invalid",
  document_meta_unknown_field: "doc.text.diag.document_meta_unknown_field",
  document_meta_position: "doc.text.diag.document_meta_position",
  document_meta_duplicate: "doc.text.diag.document_meta_duplicate",
  block_meta_json: "doc.text.diag.block_meta_json",
  block_meta_invalid: "doc.text.diag.block_meta_invalid",
  block_meta_unknown_field: "doc.text.diag.block_meta_unknown_field",
  block_meta_dangling: "doc.text.diag.block_meta_dangling",
  block_meta_adjacent: "doc.text.diag.block_meta_adjacent",
  block_meta_target: "doc.text.diag.block_meta_target",
  block_meta_field: "doc.text.diag.block_meta_field",
  block_meta_kind: "doc.text.diag.block_meta_kind",
  references_json: "doc.text.diag.references_json",
  references_invalid: "doc.text.diag.references_invalid",
  references_unknown_field: "doc.text.diag.references_unknown_field",
  references_not_last: "doc.text.diag.references_not_last",
  references_duplicate: "doc.text.diag.references_duplicate",
  reference_id_duplicate: "doc.text.diag.reference_id_duplicate",
  id_duplicate: "doc.text.diag.id_duplicate",
  id_reserved: "doc.text.diag.id_reserved",
  fence_unclosed: "doc.text.diag.fence_unclosed",
  fence_unknown_marker: "doc.text.diag.fence_unknown_marker",
  code_indented: "doc.text.diag.code_indented",
  code_info_ignored: "doc.text.diag.code_info_ignored",
  algorithm_lang_ignored: "doc.text.diag.algorithm_lang_ignored",
  math_unclosed: "doc.text.diag.math_unclosed",
  math_empty: "doc.text.diag.math_empty",
  math_katex: "doc.text.diag.math_katex",
  cite_syntax: "doc.text.diag.cite_syntax",
  cite_unclosed: "doc.text.diag.cite_unclosed",
  cite_unresolved: "doc.text.diag.cite_unresolved",
  cite_plain: "doc.text.diag.cite_plain",
  cite_stray_bracket: "doc.text.diag.cite_stray_bracket",
  ref_stray_bracket: "doc.text.diag.cite_stray_bracket",
  ref_syntax: "doc.text.diag.ref_syntax",
  ref_unclosed: "doc.text.diag.ref_unclosed",
  ref_unresolved: "doc.text.diag.ref_unresolved",
  ref_target_unsupported: "doc.text.diag.ref_target_unsupported",
  heading_token_unsupported: "doc.text.diag.heading_token_unsupported",
  heading_dollar: "doc.text.diag.heading_dollar",
  reserved_character: "doc.text.diag.reserved_character",
  math_contains_code: "doc.text.diag.math_contains_code",
  math_display_in_heading: "doc.text.diag.math_display_in_heading",
  math_display_in_list: "doc.text.diag.math_display_in_list",
  title_dollar: "doc.text.diag.title_dollar",
  reference_id_collision: "doc.text.diag.reference_id_collision",
  math_not_checked: "doc.text.diag.math_not_checked",
  math_macro_unsupported: "doc.text.diag.math_macro_unsupported",
  math_untrusted_command: "doc.text.diag.math_untrusted_command",
  scan_mismatch: "doc.text.diag.scan_mismatch",
  math_url_swallowed: "doc.text.diag.math_url_swallowed",
  math_display_inline: "doc.text.diag.math_display_inline",
  too_many_diagnostics: "doc.text.diag.too_many_diagnostics",
} as const;

type Generation =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "validated"; sections: number; paragraphs: number; lists: number }
  /** `archived`: how many annotations the confirmed replacement leaves for the Reader's next read to archive. */
  | { kind: "generated"; rev: number; archived: number }
  /** The user declined the replacement: nothing was written. */
  | { kind: "cancelled" }
  | { kind: "failed"; reason: "diagnostics" | "stale" | "changed" | "busy" | "error"; detail: string };

function TextSourceEditor({
  docId,
  generated,
  publishedRev,
  onState,
  onPublished,
  onOpenReader,
  view,
  sourcePdf,
  sourcePdfAvailable,
  onPage,
}: {
  docId: string;
  generated: boolean;
  publishedRev: number | null;
  onState: (state: { rev: number; dirty: boolean }) => void;
  onPublished: () => void;
  onOpenReader: () => void;
  view: View;
  sourcePdf: { doc_id: string; sha256: string } | null;
  sourcePdfAvailable: boolean;
  onPage?: (page: TextSourcePage) => void;
}) {
  const { t } = useTranslation();
  const [load, setLoad] = useState<{ phase: "loading" } | { phase: "error"; detail: string } | { phase: "ready" }>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  // The load-error page's Retry is the model's `reader retry_sync` for as long as that page is shown (ticket 32).
  const bridge = useReaderBridge();
  useEffect(() => {
    if (load.phase !== "error") return;
    return bridge.addRetry(() => setAttempt((n) => n + 1));
  }, [bridge, load.phase]);
  const [initialText, setInitialText] = useState("");
  const [chars, setChars] = useState(0);
  const [save, setSave] = useState<SaveState>("saved");
  const [saveDetail, setSaveDetail] = useState("");
  const [latest, setLatest] = useState<TextSourceDto | null>(null);
  const [diagnostics, setDiagnostics] = useState<TextDiagnostic[]>([]);
  const [generation, setGeneration] = useState<Generation>({ kind: "idle" });
  /** The replacement the server asked the user to confirm (a modal question; nothing is held while it is open). */
  const [asking, setAsking] = useState<{ impact: TextReplacementImpact; changed: boolean } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const regenCancelRef = useRef<HTMLButtonElement>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState(false);
  const [assets, setAssets] = useState<TextSourceAsset[]>([]);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const [assetMessage, setAssetMessage] = useState<AssetMessage | null>(null);
  const [pdfPickerOpen, setPdfPickerOpen] = useState(false);
  const assetFileRef = useRef<HTMLInputElement>(null);
  const assetUploadRef = useRef<HTMLButtonElement>(null);

  // What is on the server (rev + text) and what is in the editor are kept in refs so the autosave chain always
  // sees the newest typing; `text`/`save` state only drive rendering.
  const server = useRef<{ rev: number; markdown: string }>({ rev: 0, markdown: "" });
  const api = useRef<TextSourceApi | null>(null);
  /** The editor's whole text; the string is built only here, on demand (see TextSourceField). */
  const getDraft = (): string => api.current?.get() ?? server.current.markdown;
  const status = useRef<SaveState>("saved");
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceCancelRef = useRef<HTMLButtonElement>(null);

  const setStatus = useCallback((next: SaveState) => {
    status.current = next;
    setSave(next);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
    };
  }, []);

  useEffect(() => {
    const abort = new AbortController();
    setLoad({ phase: "loading" });
    void fetchTextSource(docId, abort.signal).then((result) => {
      if (abort.signal.aborted) return;
      if (!result.ok) {
        setLoad({ phase: "error", detail: result.detail });
        return;
      }
      server.current = { rev: result.source.rev, markdown: result.source.markdown };
      setAssets(result.source.assets);
      setInitialText(result.source.markdown);
      setChars(result.source.markdown.length);
      setStatus("saved");
      setLoad({ phase: "ready" });
    });
    return () => abort.abort();
  }, [docId, attempt, setStatus]);

  useEffect(() => {
    onState({ rev: server.current.rev, dirty: save !== "saved" });
  }, [save, load, onState]);

  /** One PUT at a time; each reads the newest draft when it runs. Resolves when the draft is saved or save stopped. */
  const flush = useCallback((): Promise<void> => {
    window.clearTimeout(timer.current);
    const run = async () => {
      while (alive.current && status.current !== "conflict" && getDraft() !== server.current.markdown) {
        const sent = getDraft();
        setStatus("saving");
        const result = await saveTextSource(docId, server.current.rev, sent);
        if (!alive.current) return;
        if (result.ok) {
          server.current = { rev: result.source.rev, markdown: result.source.markdown };
          setAssets(result.source.assets);
          onState({ rev: result.source.rev, dirty: getDraft() !== sent });
          continue;
        }
        if (result.kind === "conflict") {
          // another writer saved first: nothing is replaced; the user chooses
          setLatest(result.source);
          setStatus("conflict");
          return;
        }
        setSaveDetail(result.detail);
        setStatus("error");
        return;
      }
      if (alive.current && (status.current === "saving" || status.current === "dirty") && getDraft() === server.current.markdown) setStatus("saved");
    };
    chain.current = chain.current.then(run, run);
    return chain.current;
  }, [docId, onState, setStatus]);

  /** The user typed (or imported): the editor holds the text; only its length is read here. */
  const edit = (length: number) => {
    setChars(length);
    setGeneration((current) => (current.kind === "running" ? current : { kind: "idle" }));
    if (status.current === "conflict") return;
    setStatus("dirty");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  // another tab (or the agent) saved: adopt it only when this editor has nothing of its own to protect
  useEffect(
    () =>
      onTextSourceChanged((message) => {
        if (message.doc_id !== docId || message.rev <= server.current.rev) return;
        if (status.current !== "saved") return;
        void fetchTextSource(docId).then((result) => {
          if (!alive.current || !result.ok || status.current !== "saved" || result.source.rev <= server.current.rev) return;
          server.current = { rev: result.source.rev, markdown: result.source.markdown };
          setAssets(result.source.assets);
          api.current?.set(result.source.markdown, { silent: true });
          setChars(result.source.markdown.length);
          onState({ rev: result.source.rev, dirty: false });
        });
      }),
    [docId, onState]
  );

  // leaving with unsaved or unsaveable text asks first (the workspace guard) and the browser warns on close
  useEffect(() => {
    const remove = registerWorkspaceLeaveGuard(() => status.current === "saved" || window.confirm(t("doc.text.unsavedLeave")));
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (status.current === "saved") return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      remove();
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [t]);

  const settle = async (): Promise<boolean> => {
    await flush();
    return status.current === "saved" && getDraft() === server.current.markdown;
  };

  const validate = async () => {
    if (!(await settle())) return;
    const result = await validateTextSource(docId, server.current.rev);
    if (!alive.current) return;
    if (!result.ok) {
      setDiagnostics([]);
      setGeneration({ kind: "failed", reason: result.kind === "stale" ? "stale" : "error", detail: result.detail });
      return;
    }
    setDiagnostics(result.result.diagnostics);
    setGeneration(
      result.result.valid
        ? { kind: "validated", ...result.result.stats }
        : { kind: "failed", reason: "diagnostics", detail: "" }
    );
  };

  /** One generation request; `confirm` is the impact a real click on the question confirmed, sent back unchanged. */
  const runGenerate = async (sourceRev: number, confirm?: TextReplacementImpact) => {
    const result = await generateTextDoc(docId, sourceRev, newOperationId(), confirm);
    if (!alive.current) return;
    if (result.ok) {
      setAsking(null);
      setDiagnostics(result.result.diagnostics);
      setGeneration({ kind: "generated", rev: result.result.publishedSourceRev, archived: result.result.replacedAnnotations });
      onPublished();
      return;
    }
    if (result.kind === "confirmation") {
      // nothing was written: the user decides on the values as they are now
      setAsking({ impact: result.impact, changed: result.changed });
      setGeneration({ kind: "idle" });
      return;
    }
    setAsking(null);
    setDiagnostics(result.kind === "diagnostics" ? result.diagnostics : []);
    setGeneration({ kind: "failed", reason: result.kind, detail: result.detail });
  };

  const generate = async () => {
    // the newest typing is saved first; the revision sent is the one the server now holds
    setGeneration({ kind: "running" });
    if (!(await settle())) {
      setGeneration({ kind: "idle" });
      return;
    }
    await runGenerate(server.current.rev);
  };

  /** The click: the revision is the one the question was about, never a newer draft. */
  const confirmReplacement = async () => {
    if (!asking || confirming) return;
    setConfirming(true);
    setGeneration({ kind: "running" });
    await runGenerate(asking.impact.sourceRev, asking.impact);
    if (alive.current) setConfirming(false);
  };
  const declineReplacement = () => {
    setAsking(null);
    setGeneration({ kind: "cancelled" });
  };

  const useLatest = () => {
    if (!latest) return;
    server.current = { rev: latest.rev, markdown: latest.markdown };
    setAssets(latest.assets);
    api.current?.set(latest.markdown, { silent: true });
    setChars(latest.markdown.length);
    setLatest(null);
    setStatus("saved");
  };
  const keepMine = () => {
    if (!latest) return;
    // an explicit choice: the next save is made on top of the latest revision
    server.current = { rev: latest.rev, markdown: latest.markdown };
    setAssets(latest.assets);
    setLatest(null);
    setStatus("dirty");
    void flush();
  };

  /**
   * Add one image. It runs in the same serialized chain as the autosave, so a save can never be sent with a revision the
   * upload has just replaced; the text typed meanwhile is saved right after, on top of the new revision.
   */
  const addAsset = async (file: File | undefined) => {
    if (assetFileRef.current) assetFileRef.current.value = "";
    if (!file) return;
    await runAssetRequest((rev) => uploadTextAsset(docId, rev, file));
  };
  /** One picture of the source PDF (a page, or a region of it): the same serialized asset path, the same messages. */
  const addFromPdf = async (request: { pageIndex: number; region?: { x: number; y: number; width: number; height: number } }): Promise<boolean> => {
    if (!sourcePdf) return false;
    return runAssetRequest((rev) => addPdfImage(docId, { expectedRev: rev, sha256: sourcePdf.sha256, pageIndex: request.pageIndex, ...(request.region ? { region: request.region } : {}) }));
  };
  const runAssetRequest = async (send: (rev: number) => ReturnType<typeof uploadTextAsset>): Promise<boolean> => {
    setAssetMessage(null);
    setAssetBusy(true);
    let added = false;
    const run = async () => {
      if (!alive.current) return;
      if (status.current === "conflict" || status.current === "error") {
        setAssetMessage({ tone: "warning", text: t("doc.text.assetsSaveFirst") });
        return;
      }
      const result = await send(server.current.rev);
      if (!alive.current) return;
      if (result.ok) {
        // the Markdown did not change: only the revision and the asset list moved
        server.current = { rev: result.source.rev, markdown: server.current.markdown };
        setAssets(result.source.assets);
        onState({ rev: result.source.rev, dirty: getDraft() !== server.current.markdown });
        setAssetMessage({ tone: result.restored ? "warning" : "info", text: t(result.restored ? "doc.text.assetsRestored" : result.reused ? "doc.text.assetsReused" : "doc.text.assetsAdded", { name: result.asset.name }) });
        added = true;
        return;
      }
      if (result.kind === "conflict") {
        if (result.source) {
          setLatest(result.source);
          setStatus("conflict");
        }
        setAssetMessage({ tone: "warning", text: t("doc.text.assetsConflict") });
        return;
      }
      if (result.kind === "busy") setAssetMessage({ tone: "warning", text: t("doc.text.assetsBusy") });
      else if (result.kind === "rejected")
        setAssetMessage({
          tone: "danger",
          text: (ASSET_REJECT_CODES as readonly string[]).includes(result.code) ? t(`doc.text.assetReject.${result.code}` as never) : `${t("doc.text.assetReject.other")} ${result.detail}`,
        });
      else setAssetMessage({ tone: "danger", text: result.detail });
    };
    chain.current = chain.current.then(run, run);
    await chain.current;
    if (alive.current) setAssetBusy(false);
    return added;
  };

  const jumpTo = (diagnostic: TextDiagnostic) => {
    if (diagnostic.line) api.current?.jump(diagnostic.line, diagnostic.column ?? 1);
  };

  const pick = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = "";
    if (!file) return;
    setImportError(false);
    let content: string;
    try {
      content = await file.text();
    } catch {
      setImportError(true);
      return;
    }
    if (getDraft().trim() === "") api.current?.set(content);
    else setImporting(content);
  };

  const diagnosticText = (diagnostic: TextDiagnostic): string => {
    const key = (DIAGNOSTIC_KEYS as Record<string, (typeof DIAGNOSTIC_KEYS)[keyof typeof DIAGNOSTIC_KEYS] | undefined>)[diagnostic.code];
    return key ? t(key, { count: diagnostic.count ?? 0, subject: diagnostic.subject ?? "", field: diagnostic.field ?? "" }) : diagnostic.message;
  };

  const statusText = useMemo(
    () =>
      ({
        saved: t("doc.text.state.saved"),
        dirty: t("doc.text.state.dirty"),
        saving: t("doc.text.state.saving"),
        error: t("doc.text.state.error"),
        conflict: t("doc.text.state.conflict"),
      })[save],
    [save, t]
  );

  // The Copilot's page: the editor's CURRENT text (a newer draft is marked unsaved and is the user's, not the disk's).
  const publishNow = () => {
    if (!onPage) return;
    const unsaved = load.phase === "ready" && getDraft() !== server.current.markdown;
    const text = load.phase === "ready" ? getDraft() : "";
    const inline = text.length <= TEXT_SOURCE_INLINE_MAX;
    onPage({
      docId,
      view,
      phase: load.phase,
      rev: load.phase === "ready" ? server.current.rev : null,
      save,
      unsaved,
      characters: text.length,
      markdown: load.phase === "ready" && inline ? text : null,
      ...(load.phase === "ready" && !inline ? { omitted: "the source is longer than the page carries inline; read it with text read_source in parts" } : {}),
      assets,
      generated,
      publishedSourceRev: publishedRev,
      diagnostics: diagnostics.slice(0, 200),
      generation: generation.kind === "idle" || generation.kind === "running" || generation.kind === "validated" || generation.kind === "generated" || generation.kind === "cancelled" ? generation.kind : "failed",
      ...(sourcePdf ? { sourcePdf: { doc_id: sourcePdf.doc_id, sha256: sourcePdf.sha256 } } : {}),
    });
  };
  const publishRef = useRef(publishNow);
  publishRef.current = publishNow;
  useEffect(() => {
    const timer = window.setTimeout(() => publishRef.current(), chars > 0 && save === "dirty" ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [load.phase, save, chars, assets, generated, publishedRev, diagnostics, generation, view, sourcePdf, docId]);

  if (load.phase === "loading") return <div className="loading" data-ui="text-source-loading">{t("doc.loadingPaper")}</div>;
  if (load.phase === "error")
    return (
      <div className="text-source-load-error" data-ui="text-source-load-error">
        <InlineMessage tone="danger" title={t("doc.text.loadFailed")}>{load.detail}</InlineMessage>
        <ActionButton mode="text" data-ui="retry-text-source" label={t("doc.sync.manualRetry")} tooltip={t("doc.sync.manualRetry")} onClick={() => setAttempt((n) => n + 1)}>{t("doc.sync.manualRetry")}</ActionButton>
      </div>
    );

  const running = generation.kind === "running";
  return (
    <div className="text-source-editor" data-ui="text-source-editor">
      <div className="text-source-toolbar" data-ui="text-source-toolbar">
        <span className={`text-source-status ${save === "error" || save === "conflict" ? "warn" : ""}`} role="status" data-ui="text-source-status" data-state={save}>{statusText}</span>
        <span className="text-doc-spacer" />
        <input ref={fileRef} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" hidden data-ui="text-source-import-input" onChange={(event) => void pick(event.target.files?.[0])} />
        <ActionButton mode="icon" iconName="file-up" iconSize="small" data-ui="text-source-import" label={t("doc.text.import")} tooltip={t("doc.text.import")} disabled={running} onClick={() => fileRef.current?.click()} />
        <ActionButton mode="icon" iconName="images" iconSize="small" data-ui="text-source-assets" label={t("doc.text.assets")} tooltip={t("doc.text.assets")} onClick={() => setAssetsOpen(true)} />
        <ActionButton mode="text" data-ui="text-source-validate" label={t("doc.text.validate")} tooltip={t("doc.text.validate")} disabled={running || save === "conflict"} onClick={() => void validate()}>{t("doc.text.validate")}</ActionButton>
        <ActionButton mode="text" appearance="primary" data-ui="text-source-generate" label={t("doc.text.generate")} tooltip={t("doc.text.generate")} busy={running} busyLabel={t("doc.text.generating")} disabled={save === "conflict"} onClick={() => void generate()}>{t("doc.text.generate")}</ActionButton>
      </div>

      {importError && <InlineMessage tone="danger" uiId="text-source-import-error" title={t("doc.text.importFailed")}>{""}</InlineMessage>}
      {save === "error" && (
        <InlineMessage tone="danger" uiId="text-source-save-error" title={t("doc.text.saveFailedTitle")}>
          <p>{saveDetail}</p>
          <ActionButton mode="text" data-ui="retry-text-source-save" label={t("doc.sync.manualRetry")} tooltip={t("doc.sync.manualRetry")} onClick={() => { setStatus("dirty"); void flush(); }}>{t("doc.sync.manualRetry")}</ActionButton>
        </InlineMessage>
      )}
      {save === "conflict" && (
        <div className="text-source-conflict" data-ui="text-source-conflict" role="alert">
          <strong>{t("doc.text.conflictTitle")}</strong>
          <div className="text-source-conflict-latest">
            <b>{t("doc.text.conflictLatest")}</b>
            <pre data-ui="text-source-conflict-latest">{latest?.markdown ?? ""}</pre>
          </div>
          <div className="text-source-conflict-actions">
            <ActionButton mode="text" data-ui="text-source-keep-mine" label={t("doc.text.keepMine")} tooltip={t("doc.text.keepMine")} disabled={!latest} onClick={keepMine}>{t("doc.text.keepMine")}</ActionButton>
            <ActionButton mode="text" data-ui="text-source-use-latest" label={t("doc.text.useLatest")} tooltip={t("doc.text.useLatest")} disabled={!latest} onClick={useLatest}>{t("doc.text.useLatest")}</ActionButton>
          </div>
        </div>
      )}
      {generation.kind === "cancelled" && <InlineMessage uiId="text-source-regeneration-cancelled" title={t("doc.text.replace.cancelled")}>{""}</InlineMessage>}
      {generation.kind === "generated" && (
        <InlineMessage uiId="text-source-generated" title={t("doc.text.generatedTitle", { rev: generation.rev })}>
          {generation.archived > 0 && <p data-ui="text-source-replacement-note">{t("doc.text.replace.after", { count: generation.archived })}</p>}
          <ActionButton mode="text" data-ui="text-open-reader" label={t("doc.text.openReader")} tooltip={t("doc.text.openReader")} onClick={onOpenReader}>{t("doc.text.openReader")}</ActionButton>
        </InlineMessage>
      )}
      {generation.kind === "validated" && (
        <InlineMessage uiId="text-source-valid" title={t("doc.text.validTitle")}>
          {t("doc.text.validStats", { sections: generation.sections, paragraphs: generation.paragraphs, lists: generation.lists })}
        </InlineMessage>
      )}
      {generation.kind === "failed" && (
        <InlineMessage tone={generation.reason === "stale" || generation.reason === "changed" || generation.reason === "busy" ? "warning" : "danger"} uiId="text-source-generation-error" title={t(FAILED_KEY[generation.reason])}>
          {generation.reason === "diagnostics" ? t("doc.text.failedKept") : generation.reason === "error" ? generation.detail : ""}
        </InlineMessage>
      )}
      {diagnostics.length > 0 && (
        <ul className="text-source-diagnostics" data-ui="text-source-diagnostics" aria-label={t("doc.text.diagnostics")}>
          {diagnostics.map((diagnostic, index) => (
            <li key={`${diagnostic.code}:${diagnostic.line ?? 0}:${diagnostic.column ?? 0}:${index}`} className={diagnostic.severity} data-ui="text-source-diagnostic" data-ui-key={String(index)}>
              <button type="button" className="text-source-diagnostic-where" disabled={!diagnostic.line} onClick={() => jumpTo(diagnostic)}>
                {diagnostic.line ? t("doc.text.diagnosticAt", { line: diagnostic.line, column: diagnostic.column ?? 1 }) : t("doc.text.diagnosticDocument")}
              </button>
              <span>{diagnosticText(diagnostic)}</span>
            </li>
          ))}
        </ul>
      )}

      <TextSourceField
        initial={initialText}
        readOnly={save === "conflict"}
        label={t("doc.text.sourceAria")}
        apiRef={api}
        onUserChange={edit}
      />
      <div className="text-source-footer" data-ui="text-source-footer">
        <span>argelander-text v1</span>
        <span>{t("doc.text.characters", { count: chars })}</span>
        <span data-ui="text-source-asset-count">{t("doc.text.assetCount", { count: assets.length })}</span>
        {generated && publishedRev !== null && <span>{t("doc.text.publishedRev", { rev: publishedRev })}</span>}
      </div>

      {assetsOpen && (
        <Dialog
          uiId="text-source-assets-dialog"
          width={520}
          title={t("doc.text.assetsTitle")}
          closeLabel={t("common.close")}
          initialFocusRef={assetUploadRef}
          busy={assetBusy}
          onClose={() => { setAssetsOpen(false); setAssetMessage(null); }}
          footer={
            <ActionButton mode="text" data-ui="close-text-source-assets" label={t("doc.text.assetsClose")} tooltip={t("doc.text.assetsClose")} disabled={assetBusy} onClick={() => { setAssetsOpen(false); setAssetMessage(null); }}>{t("doc.text.assetsClose")}</ActionButton>
          }
        >
          <div className="text-assets" data-ui="text-source-assets-panel">
            <input ref={assetFileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden data-ui="text-source-asset-input" onChange={(event) => void addAsset(event.target.files?.[0])} />
            {assets.length === 0 ? (
              <p className="text-assets-empty" data-ui="text-source-assets-empty">{t("doc.text.assetsEmpty")}</p>
            ) : (
              <ul className="text-assets-list" data-ui="text-source-assets-list">
                {assets.map((asset) => (
                  <li key={asset.name} className="text-asset-row" data-ui="text-source-asset" data-ui-key={asset.name}>
                    <strong>{asset.name}</strong>
                    <small>
                      {asset.media_type && asset.width && asset.height
                        ? t("doc.text.assetMeta", { type: ASSET_TYPE[asset.media_type], width: asset.width, height: asset.height, size: formatSize(asset.byte_length) })
                        : formatSize(asset.byte_length)}
                    </small>
                    <small className="text-asset-path">{t("doc.text.assetsPath", { name: asset.name })}</small>
                  </li>
                ))}
              </ul>
            )}
            {assetMessage && (
              <InlineMessage tone={assetMessage.tone} uiId="text-source-asset-message" title={assetMessage.tone === "danger" ? t("doc.text.assetsFailedTitle") : assetMessage.text}>
                {assetMessage.tone === "danger" ? assetMessage.text : ""}
              </InlineMessage>
            )}
            <div className="text-assets-actions">
              {sourcePdf && (
                <ActionButton mode="text" data-ui="text-source-asset-from-pdf" label={t("doc.text.fromPdf")} tooltip={sourcePdfAvailable ? t("doc.text.fromPdf") : t("doc.text.sourcePdfMissing")} disabled={assetBusy || !sourcePdfAvailable} onClick={() => { setAssetsOpen(false); setPdfPickerOpen(true); }}>{t("doc.text.fromPdf")}</ActionButton>
              )}
              <ActionButton mode="text" ref={assetUploadRef} data-ui="text-source-asset-upload" label={t("doc.text.assetsUpload")} tooltip={t("doc.text.assetsUpload")} busy={assetBusy} busyLabel={t("doc.text.assetsUploading")} onClick={() => assetFileRef.current?.click()}>{t("doc.text.assetsUpload")}</ActionButton>
            </div>
          </div>
        </Dialog>
      )}

      {pdfPickerOpen && sourcePdf && (
        <PdfImagePicker
          pdfDocId={sourcePdf.doc_id}
          sha256={sourcePdf.sha256}
          busy={assetBusy}
          message={assetMessage}
          onAdd={async (request) => { const added = await addFromPdf(request); if (added) { setPdfPickerOpen(false); setAssetsOpen(true); } }}
          onClose={() => { setPdfPickerOpen(false); setAssetsOpen(true); setAssetMessage(null); }}
        />
      )}

      {asking && (
        <Dialog
          uiId="text-regeneration-dialog"
          title={t("doc.text.replace.title")}
          closeLabel={t("common.close")}
          initialFocusRef={regenCancelRef}
          busy={confirming}
          onClose={declineReplacement}
          footer={
            <>
              <ActionButton mode="text" ref={regenCancelRef} data-ui="cancel-text-regeneration" label={t("common.cancel")} tooltip={t("common.cancel")} disabled={confirming} onClick={declineReplacement}>{t("common.cancel")}</ActionButton>
              <ActionButton mode="text" appearance="primary" data-ui="confirm-text-regeneration" label={t("doc.text.replace.confirm", { count: asking.impact.annotations })} tooltip={t("doc.text.replace.confirm", { count: asking.impact.annotations })} busy={confirming} onClick={() => void confirmReplacement()}>{t("doc.text.replace.confirm", { count: asking.impact.annotations })}</ActionButton>
            </>
          }
        >
          {asking.changed && <InlineMessage tone="warning" uiId="text-regeneration-changed" title={t("doc.text.replace.changed")}>{""}</InlineMessage>}
          <p data-ui="text-regeneration-impact">{t("doc.text.replace.body", { count: asking.impact.annotations })}</p>
          <p className="text-regeneration-basis" data-ui="text-regeneration-basis">{t("doc.text.replace.basis", { source: asking.impact.sourceRev, published: asking.impact.publishedSourceRev, annotationsRev: asking.impact.annotationsRev })}</p>
        </Dialog>
      )}

      {importing !== null && (
        <Dialog
          uiId="text-source-import-dialog"
          title={t("doc.text.importReplaceTitle")}
          description={t("doc.text.importReplaceHelp")}
          closeLabel={t("common.close")}
          initialFocusRef={replaceCancelRef}
          onClose={() => setImporting(null)}
          footer={
            <>
              <ActionButton mode="text" ref={replaceCancelRef} data-ui="cancel-text-import" label={t("common.cancel")} tooltip={t("common.cancel")} onClick={() => setImporting(null)}>{t("common.cancel")}</ActionButton>
              <ActionButton mode="text" appearance="primary" data-ui="confirm-text-import" label={t("doc.text.importReplace")} tooltip={t("doc.text.importReplace")} onClick={() => { api.current?.set(importing); setImporting(null); }}>{t("doc.text.importReplace")}</ActionButton>
            </>
          }
        >
          <p>{t("doc.text.importReplaceBody")}</p>
        </Dialog>
      )}
    </div>
  );
}
