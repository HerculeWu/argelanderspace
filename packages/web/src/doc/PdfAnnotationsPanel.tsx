import { useEffect, useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { PdfAnnotation } from "@argelanderspace/contracts";
import { PdfAnnotationSession } from "./PdfAnnotationSession";
import { PdfHighlightColorPicker } from "./PdfHighlightColorPicker";
import { mdWithMath } from "../lib/mdWithMath";
import { ActionButton, Button, getConfiguredIcon, InlineMessage } from "../ui";
import { docRouteUrl } from "../lib/deeplink";
import { copyPlainText } from "./copy-text";

type Annotation = PdfAnnotation & Record<string, unknown>;
type TextTarget = { quote: string; fragments: Array<{ page_index: number; rectangles: Array<{ x: number; y: number; width: number; height: number }> }> };
const textTarget = (annotation: Annotation): TextTarget | null => annotation.kind === "highlight" || annotation.kind === "underline" || annotation.kind === "strikeout" ? annotation.target as TextTarget : null;

export type PdfAnnotationTool = "read" | "area" | "highlight" | "underline" | "strikeout";

export function PdfAnnotationToolButtons({ mode, blocked, onMode }: {
  mode: PdfAnnotationTool;
  blocked: boolean;
  onMode: (mode: PdfAnnotationTool) => void;
}) {
  const { t } = useTranslation();
  const tools = [
    { mode: "area", ui: "select-pdf-area-tool", icon: "target", label: "addRectangle" },
    { mode: "highlight", ui: "select-pdf-highlight-tool", icon: "highlight-mark", label: "highlight" },
    { mode: "underline", ui: "select-pdf-underline-tool", icon: "underline-mark", label: "underline" },
    { mode: "strikeout", ui: "select-pdf-strikeout-tool", icon: "strikeout-mark", label: "strikeout" },
  ] as const;
  return <>
    {tools.map((tool) => <ActionButton
      key={tool.mode}
      mode="icon"
      iconName={tool.icon}
      data-ui={tool.ui}
      aria-pressed={mode === tool.mode}
      disabled={blocked}
      label={t(`pdfReader.${tool.label}`)}
      tooltip={t(`pdfReader.${tool.label}`)}
      onClick={() => onMode(mode === tool.mode ? "read" : tool.mode)}
    />)}
  </>;
}

export function PdfAnnotationsPanel({ session, currentPage, onNavigatePage, commentRequest, blocked = false }: {
  session: PdfAnnotationSession;
  currentPage: number;
  onNavigatePage: (pageIndex: number) => void;
  commentRequest?: { kind: "page_comment" | "document_comment"; pageIndex?: number; key: number } | null;
  blocked?: boolean;
}) {
  const { t } = useTranslation();
  const [styleDrafts, setStyleDrafts] = useState<Record<string, { color: string; opacity: number; line_width: number }>>({});
  const [linkStatus, setLinkStatus] = useState("");
  const [newComment, setNewComment] = useState<{ kind: "page_comment" | "document_comment"; pageIndex?: number; id: string } | null>(null);
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const lastCommentRequest = useRef<number | null>(null);
  const styleDraftsRef = useRef(styleDrafts);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const items = useMemo(() => blocked ? [] : session.projectedAnnotations() as Annotation[], [blocked, session, state.file, state.pending]);
  const startComment = (kind: "page_comment" | "document_comment", capturedPage = currentPage) => {
    if (!session.isWritable() || newComment) return;
    const id = `draft:${crypto.randomUUID()}`;
    const pageIndex = kind === "page_comment" ? capturedPage : undefined;
    setNewComment({ kind, ...(pageIndex !== undefined ? { pageIndex } : {}), id });
    session.setDraft(id, "");
    requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-ui="pdf-new-comment-body"]')?.focus());
  };
  useEffect(() => {
    if (!commentRequest || lastCommentRequest.current === commentRequest.key) return;
    lastCommentRequest.current = commentRequest.key;
    startComment(commentRequest.kind, commentRequest.pageIndex);
  }, [commentRequest]);
  const cancelNewComment = () => {
    if (!newComment) return;
    session.clearDraft(newComment.id);
    setNewComment(null);
  };
  const saveNewComment = (body: string) => {
    if (!newComment || !body.trim() || !session.isWritable()) return;
    const at = new Date().toISOString();
    const annotation = {
      id: `pann_${crypto.randomUUID()}`, kind: newComment.kind,
      ...(newComment.kind === "page_comment" ? { page_index: newComment.pageIndex } : {}),
      body, created_at: at, updated_at: at,
    } as PdfAnnotation;
    if (!session.mutate([...session.projectedAnnotations(), annotation], { id: annotation.id, value: body })) return;
    session.setDraft(annotation.id, body);
    session.clearDraft(newComment.id);
    setEditing((value) => ({ ...value, [annotation.id]: true }));
    setNewComment(null);
  };
  const updateHighlightColor = (annotation: Annotation, color: string) => {
    if (annotation.kind !== "highlight" || !session.isWritable() || (annotation.color ?? "#ffd228") === color) return;
    const after = session.projectedAnnotations().map((item) => item.id === annotation.id ? { ...item, color } as PdfAnnotation : item);
    session.mutate(after);
  };
  const updateRectangleStyle = (annotation: Annotation, patch: Record<string, unknown>, clearDraft?: { id: string; value: string }) => {
    if (annotation.kind !== "rectangle" || !session.isWritable()) return;
    const after = session.projectedAnnotations().map((item) => item.id === annotation.id
      ? { ...item, ...patch, style: { ...annotation.style, ...(patch.style as object | undefined) } } as PdfAnnotation
      : item);
    const changed = session.mutate(after, clearDraft);
    if (!changed && clearDraft) session.clearDraft(clearDraft.id, clearDraft.value);
  };
  const copyDraft = (id: string, body: string) => { void copyPlainText(state.drafts[id] ?? body); };
  const copyAnnotationLink = async (id: string) => {
    try { const copied = await copyPlainText(new URL(docRouteUrl(session.docId, `ann-${id}`), window.location.origin).href); setLinkStatus(t(copied ? "pdfReader.linkCopied" : "pdfReader.copyFailed")); }
    catch { setLinkStatus(t("pdfReader.copyFailed")); }
  };
  const discard = () => { styleDraftsRef.current = {}; setStyleDrafts({}); session.discard(); };
  const failure = state.failure;
  useEffect(() => {
    setEditing((current) => {
      const next = { ...current };
      let changed = false;
      for (const id of Object.keys(current)) if (current[id] && state.drafts[id] === undefined) { delete next[id]; changed = true; }
      return changed ? next : current;
    });
  }, [state.drafts]);
  return <div className="pdf-workbench-panel" data-ui="pdf-annotation-workbench">
    <div className="pdf-workbench-history" data-ui="pdf-annotation-history">
      <ActionButton unstyled mode="icon" iconName="undo-2" className="pdf-icon-action" disabled={!state.canUndo || blocked} data-ui="undo-pdf-annotation" label={t("pdfReader.undo")} tooltip={t("pdfReader.undo")} onClick={session.undo} />
      <ActionButton unstyled mode="icon" iconName="corner-up-right" className="pdf-icon-action" disabled={!state.canRedo || blocked} data-ui="redo-pdf-annotation" label={t("pdfReader.redo")} tooltip={t("pdfReader.redo")} onClick={session.redo} />
    </div>
    {newComment && <section className="pdf-workbench-new-comment" data-ui="pdf-comment-draft" data-ui-instance={newComment.id}>
      <h3>{t("pdfReader.newComment")}{newComment.kind === "page_comment" ? ` · ${t("pdfReader.pageTarget", { page: (newComment.pageIndex ?? 0) + 1 })}` : ` · ${t("pdfReader.documentTarget")}`}</h3>
      <textarea data-ui="pdf-new-comment-body" aria-label={t("pdfReader.annotationBody")} value={state.drafts[newComment.id] ?? ""} onChange={(event) => session.setDraft(newComment.id, event.target.value)} />
      <div className="pdf-workbench-item-actions">
        <Button disabled={!session.isWritable() || !(state.drafts[newComment.id] ?? "").trim()} data-ui="save-new-pdf-comment" onClick={() => saveNewComment(state.drafts[newComment.id] ?? "")}>{t("pdfReader.saveBody")}</Button>
        <Button data-ui="cancel-new-pdf-comment" onClick={cancelNewComment}>{t("common.cancel")}</Button>
      </div>
    </section>}
    {blocked && <p role="status">{t("pdfReader.changedBlocked")}</p>}
    {blocked && Object.entries(state.drafts).filter(([id]) => !id.startsWith("style:")).map(([id, body]) => <div className="pdf-workbench-item" data-ui="pdf-annotation-draft" data-ui-key={id} key={id}>
      <p>{t("pdfReader.unsavedDraft")}</p>
      <textarea data-ui="pdf-unsaved-draft-body" aria-label={t("pdfReader.annotationBody")} value={body} readOnly />
      <Button data-ui="copy-pdf-draft" onClick={() => copyDraft(id, body)}>{t("pdfReader.copyDraft")}</Button>
      <Button data-ui="discard-pdf-pending" onClick={discard}>{t("pdfReader.discardPending")}</Button>
    </div>)}
    {state.saving && <p role="status">{t("pdfReader.saving")}</p>}
    {!state.saving && !failure && state.pending === 0 && <p role="status">{session.hasUnsaved() ? t("pdfReader.unsavedDraft") : t("pdfReader.saved")}</p>}
    {failure && (state.dismissedNoticeId === failure.noticeId
      ? <div className="pdf-annotation-failure-status" data-ui="pdf-annotation-save-error" role="status">
          <span>{t("pdfReader.saveFailureSummary")}</span>
          <details><summary>{t("pdfReader.saveFailureDetails")}</summary><code>{failure.kind} · {failure.detail}</code></details>
          <Button data-ui="retry-pdf-annotation-save" disabled={state.saving} onClick={() => void session.retry()}>{t("pdfReader.retrySave")}</Button>
          <Button data-ui="discard-pdf-pending" disabled={state.saving} onClick={discard}>{t("pdfReader.discardPending")}</Button>
        </div>
      : <InlineMessage tone={failure.kind === "busy" ? "warning" : "danger"} title={t(failure.kind === "busy" ? "pdfReader.saveBusy" : "pdfReader.saveFailed")}>
          <ActionButton mode="icon" iconName="x" data-ui="dismiss-pdf-save-error" variant="ghost" label={t("pdfReader.dismissSaveError")} tooltip={t("pdfReader.dismissSaveError")} onClick={session.dismissFailure} />
          <span>{failure.detail}</span>
          <details><summary>{t("pdfReader.saveFailureDetails")}</summary><code>{failure.kind} · {failure.detail}</code></details>
          <Button data-ui="retry-pdf-annotation-save" disabled={state.saving} onClick={() => void session.retry()}>{t("pdfReader.retrySave")}</Button>
          <Button data-ui="discard-pdf-pending" disabled={state.saving} onClick={discard}>{t("pdfReader.discardPending")}</Button>
        </InlineMessage>)}
    {items.map((annotation) => {
      const draft = state.drafts[annotation.id] ?? annotation.body;
      const hasDraft = draft !== annotation.body;
      const targetPage = "page_index" in annotation ? annotation.page_index : textTarget(annotation)?.fragments[0]?.page_index;
      const targetTitle = annotation.kind === "document_comment" ? t("pdfReader.documentTarget") : t("pdfReader.pageTarget", { page: Number(targetPage ?? 0) + 1 });
      const kindName = annotation.kind === "page_comment" ? t("pdfReader.commentThisPage") : annotation.kind === "document_comment" ? t("pdfReader.addDocumentComment") : annotation.kind === "rectangle" ? t("pdfReader.addRectangle") : t(`pdfReader.${annotation.kind}`);
      const targetIcon = annotation.kind === "page_comment" ? "message-square-plus" : annotation.kind === "document_comment" ? "book-open" : annotation.kind === "rectangle" ? "target" : annotation.kind === "highlight" ? "highlight-mark" : annotation.kind === "underline" ? "underline-mark" : "strikeout-mark";
      return <article className="pdf-workbench-item" data-ui="pdf-annotation" data-ui-key={annotation.id} id={`pdf-annotation-${annotation.id}`} key={annotation.id}>
        <div className="pdf-workbench-item-head">
          <button type="button" className="pdf-workbench-target" data-ui="navigate-pdf-annotation" aria-label={`${kindName} · ${targetTitle}`} disabled={blocked || annotation.kind === "document_comment"} onClick={() => {
            if (typeof targetPage === "number") onNavigatePage(targetPage);
          }}>
            {getConfiguredIcon(targetIcon, "navigate-pdf-annotation")}
            <span>{targetTitle}</span>
          </button>
          {annotation.kind === "highlight" && <PdfHighlightColorPicker value={(annotation.color ?? "#ffd228") as import("@argelanderspace/contracts").PdfHighlightColor} disabled={blocked || !session.isWritable()} ui="pdf-highlight-color-picker" onChange={(color) => updateHighlightColor(annotation, color)} />}
        </div>
        {linkStatus && <span role="status">{linkStatus}</span>}
        {textTarget(annotation) && <p className="pdf-workbench-quote">{textTarget(annotation)?.quote}</p>}
        {annotation.kind === "rectangle" && (() => {
        const style = styleDraftsRef.current[annotation.id] ?? {
          color: String((annotation.style as Record<string, unknown>).color),
          opacity: Number((annotation.style as Record<string, unknown>).opacity),
          line_width: Number((annotation.style as Record<string, unknown>).line_width),
        };
        const commitStyleValue = (latestStyle: { color: string; opacity: number; line_width: number }) => {
          const draftId = `style:${annotation.id}`;
          updateRectangleStyle(annotation, { style: latestStyle }, { id: draftId, value: JSON.stringify(latestStyle) });
          const next = { ...styleDraftsRef.current }; delete next[annotation.id]; styleDraftsRef.current = next; setStyleDrafts(next);
        };
        const commitStyle = () => { const latestStyle = styleDraftsRef.current[annotation.id]; if (latestStyle) commitStyleValue(latestStyle); };
        const setStyle = (next: { color: string; opacity: number; line_width: number }) => {
          styleDraftsRef.current = { ...styleDraftsRef.current, [annotation.id]: next };
          setStyleDrafts(styleDraftsRef.current);
          session.setDraft(`style:${annotation.id}`, JSON.stringify(next));
        };
        return <>
          <p className="pdf-workbench-quote">{t("pdfReader.rectangleDescription")}</p>
          <label>{t("pdfReader.rectangleColor")} <input data-ui="pdf-rectangle-color" aria-label={t("pdfReader.rectangleColor")} disabled={blocked} type="color" value={style.color} onChange={(event) => { const next = { ...(styleDraftsRef.current[annotation.id] ?? style), color: event.target.value }; setStyle(next); commitStyleValue(next); }} onKeyUp={(event) => { if (event.key === "Enter") commitStyle(); }} /></label>
          <label>{t("pdfReader.rectangleOpacity")} <input data-ui="pdf-rectangle-opacity" aria-label={t("pdfReader.rectangleOpacity")} disabled={blocked} type="range" min="0.1" max="1" step="0.05" value={style.opacity} onChange={(event) => setStyle({ ...style, opacity: Number(event.target.value) })} onPointerUp={commitStyle} onKeyUp={commitStyle} /></label>
          <label>{t("pdfReader.rectangleLineWidth")} <input data-ui="pdf-rectangle-line-width" aria-label={t("pdfReader.rectangleLineWidth")} disabled={blocked} type="number" min="1" max="32" value={style.line_width} onChange={(event) => setStyle({ ...style, line_width: Number(event.target.value) })} onBlur={commitStyle} onKeyUp={(event) => { if (event.key === "Enter") commitStyle(); }} /></label>
        </>;
      })()}
        {editing[annotation.id] ? <textarea data-ui="pdf-annotation-body-input" aria-label={t("pdfReader.annotationBody")} disabled={blocked} value={draft} onChange={(event) => session.setDraft(annotation.id, event.target.value)} /> : <div className="pdf-workbench-body" data-ui="pdf-annotation-body" dangerouslySetInnerHTML={{ __html: mdWithMath(annotation.body) }} />}
        <div className="pdf-workbench-item-actions" data-ui="pdf-annotation-item-actions">
          {editing[annotation.id] ? <>
            <Button disabled={blocked || !hasDraft || !draft.trim()} data-ui="save-pdf-annotation-body" onClick={() => { session.saveBody(annotation.id); }}>{t("pdfReader.saveBody")}</Button>
            <Button disabled={state.saving || state.pending > 0} data-ui="cancel-pdf-annotation-edit" onClick={() => { session.clearDraft(annotation.id); setEditing((value) => ({ ...value, [annotation.id]: false })); }}>{t("common.cancel")}</Button>
          </> : <ActionButton unstyled mode="icon" iconName="pencil" className="pdf-icon-action" disabled={blocked} data-ui="edit-pdf-annotation-body" label={t("pdfReader.editComment")} tooltip={t("pdfReader.editComment")} onClick={() => { session.setDraft(annotation.id, annotation.body); setEditing((value) => ({ ...value, [annotation.id]: true })); }} />}
          {hasDraft && <Button data-ui="copy-pdf-draft" onClick={() => copyDraft(annotation.id, annotation.body)}>{t("pdfReader.copyDraft")}</Button>}
          <ActionButton unstyled mode="icon" iconName="copy" className="pdf-icon-action" data-ui="copy-pdf-annotation-link" label={t("pdfReader.copyAnnotationLink")} tooltip={t("pdfReader.copyAnnotationLink")} onClick={() => void copyAnnotationLink(annotation.id)} />
          <ActionButton unstyled mode="icon" iconName="trash-2" className="pdf-icon-action" disabled={blocked || !session.isWritable()} data-ui="delete-pdf-annotation" label={t("pdfReader.deleteAnnotation")} tooltip={t("pdfReader.deleteAnnotation")} onClick={() => session.remove(annotation.id)} />
        </div>
      </article>;
    })}
    {items.length === 0 && <p>{t("pdfReader.noAnnotations")}</p>}
  </div>;
}
