import { useMemo, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { PdfAnnotation } from "@argelanderspace/contracts";
import { PdfAnnotationSession } from "./PdfAnnotationSession";
import { mdWithMath } from "../lib/mdWithMath";
import { Icon } from "../lib/icons";
import { Button, IconButton, InlineMessage } from "../ui";
import { docRouteUrl } from "../lib/deeplink";
import { copyPlainText } from "./copy-text";

type Annotation = PdfAnnotation & Record<string, unknown>;
type TextTarget = { quote: string; fragments: Array<{ page_index: number; rectangles: Array<{ x: number; y: number; width: number; height: number }> }> };
const textTarget = (annotation: Annotation): TextTarget | null => annotation.kind === "highlight" || annotation.kind === "underline" || annotation.kind === "strikeout" ? annotation.target as TextTarget : null;

export function PdfAnnotationsPanel({ session, currentPage, onNavigatePage, onAddRectangle, onSelectText, selectionMode, blocked = false }: {
  session: PdfAnnotationSession;
  currentPage: number;
  onNavigatePage: (pageIndex: number) => void;
  onAddRectangle: () => void;
  onSelectText: () => void;
  selectionMode: "read" | "area" | "text";
  blocked?: boolean;
}) {
  const { t } = useTranslation();
  const [styleDrafts, setStyleDrafts] = useState<Record<string, { color: string; opacity: number; line_width: number }>>({});
  const [linkStatus, setLinkStatus] = useState("");
  const styleDraftsRef = useRef(styleDrafts);
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const items = useMemo(() => blocked ? [] : session.projectedAnnotations() as Annotation[], [blocked, session, state.file, state.pending]);
  const defaultBody = t("pdfReader.defaultBody");
  const addComment = (kind: "page_comment" | "document_comment") => {
    if (!session.isWritable()) return;
    const at = new Date().toISOString();
    const annotation = {
      id: `pann_${crypto.randomUUID()}`, kind,
      ...(kind === "page_comment" ? { page_index: currentPage } : {}),
      body: defaultBody, created_at: at, updated_at: at,
    } as Annotation;
    session.create(annotation);
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
  return <div className="pdf-workbench-panel" data-ui="pdf-annotation-workbench">
    <div className="pdf-workbench-actions" data-ui="pdf-annotation-actions">
      <Button disabled={blocked || !session.isWritable()} data-ui="add-pdf-page-comment" onClick={() => addComment("page_comment")}>{t("pdfReader.addPageComment", { page: currentPage + 1 })}</Button>
      <Button disabled={blocked || !session.isWritable()} data-ui="add-pdf-document-comment" onClick={() => addComment("document_comment")}>{t("pdfReader.addDocumentComment")}</Button>
      <span className="pdf-workbench-mode-group">
        <Button className="pdf-workbench-mode" aria-pressed={selectionMode === "area"} disabled={blocked || !session.isWritable()} data-ui="select-pdf-area-tool" onClick={onAddRectangle}>{t("pdfReader.addRectangle")}</Button>
        <Button className="pdf-workbench-mode" aria-pressed={selectionMode === "text"} disabled={blocked || !session.isWritable()} data-ui="select-pdf-text-tool" onClick={onSelectText}>{t("pdfReader.selectText")}</Button>
      </span>
    </div>
    <div className="pdf-workbench-history" data-ui="pdf-annotation-history">
      <Button disabled={!state.canUndo || blocked} data-ui="undo-pdf-annotation" onClick={session.undo}>{t("pdfReader.undo")}</Button>
      <Button disabled={!state.canRedo || blocked} data-ui="redo-pdf-annotation" onClick={session.redo}>{t("pdfReader.redo")}</Button>
    </div>
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
          <IconButton data-ui="dismiss-pdf-save-error" variant="ghost" label={t("pdfReader.dismissSaveError")} icon={<Icon name="x" cls="ico-sm" />} onClick={session.dismissFailure} />
          <span>{failure.detail}</span>
          <details><summary>{t("pdfReader.saveFailureDetails")}</summary><code>{failure.kind} · {failure.detail}</code></details>
          <Button data-ui="retry-pdf-annotation-save" disabled={state.saving} onClick={() => void session.retry()}>{t("pdfReader.retrySave")}</Button>
          <Button data-ui="discard-pdf-pending" disabled={state.saving} onClick={discard}>{t("pdfReader.discardPending")}</Button>
        </InlineMessage>)}
    {items.map((annotation) => {
      const draft = state.drafts[annotation.id] ?? annotation.body;
      const hasDraft = draft !== annotation.body;
      return <article className="pdf-workbench-item" data-ui="pdf-annotation" data-ui-key={annotation.id} id={`pdf-annotation-${annotation.id}`} key={annotation.id}>
        <button type="button" className="pdf-workbench-target" data-ui="navigate-pdf-annotation" disabled={blocked || annotation.kind === "document_comment"} onClick={() => {
          const pageIndex = "page_index" in annotation ? annotation.page_index : textTarget(annotation)?.fragments[0]?.page_index;
          if (typeof pageIndex === "number") onNavigatePage(pageIndex);
        }}>
          {annotation.kind === "document_comment" ? t("pdfReader.documentTarget") : annotation.kind === "page_comment" ? t("pdfReader.pageTarget", { page: Number(annotation.page_index) + 1 }) : annotation.kind === "rectangle" ? t("pdfReader.rectangleTarget", { page: Number(annotation.page_index) + 1 }) : t("pdfReader.textTarget", { kind: t(`pdfReader.${annotation.kind}`), pages: textTarget(annotation)?.fragments.length ?? 0 })}
        </button>
        <Button data-ui="copy-pdf-annotation-link" onClick={() => void copyAnnotationLink(annotation.id)}>{t("pdfReader.copyAnnotationLink")}</Button>
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
        <textarea data-ui="pdf-annotation-body-input" aria-label={t("pdfReader.annotationBody")} disabled={blocked} value={draft} onChange={(event) => session.setDraft(annotation.id, event.target.value)} />
        <div className="pdf-workbench-body" data-ui="pdf-annotation-body" dangerouslySetInnerHTML={{ __html: mdWithMath(annotation.body) }} />
        <div className="pdf-workbench-item-actions" data-ui="pdf-annotation-item-actions">
          <Button disabled={blocked || !hasDraft} data-ui="save-pdf-annotation-body" onClick={() => session.saveBody(annotation.id)}>{t("pdfReader.saveBody")}</Button>
          {hasDraft && <Button data-ui="copy-pdf-draft" onClick={() => copyDraft(annotation.id, annotation.body)}>{t("pdfReader.copyDraft")}</Button>}
          <Button disabled={blocked || !session.isWritable()} data-ui="delete-pdf-annotation" onClick={() => session.remove(annotation.id)}>{t("pdfReader.deleteAnnotation")}</Button>
        </div>
      </article>;
    })}
    {items.length === 0 && <p>{t("pdfReader.noAnnotations")}</p>}
  </div>;
}
