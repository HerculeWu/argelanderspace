import { useReaderSession } from "../doc/ReaderSession";
import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Annotation } from "@argelanderspace/contracts";
import { useStore } from "../store";
import { useAnnotations } from "./AnnotationStore";
import { CreateAnnotationEditor, EditAnnotationEditor } from "./AnnotationEditor";
import { sortAnnotations, targetBlockId, targetSummary } from "./model";
import { ActionButton } from "../ui";

/**
 * The Annotations tab of the reader's right panel (Stage 8 MS3): document-level
 * creation at the top (panel-top editor), then every annotation in document
 * order (document-level first, then by target block order). An entry shows the
 * target summary (kind+number / section path / quote for text targets) + a
 * body preview; clicking jumps to the target block with the usual flash and
 * activates the annotation; edit/delete are inline per entry (delete asks no
 * confirmation — a single annotation, matching the house UX).
 */
export function AnnotationsPanel() {
  const store = useStore();
  const ann = useAnnotations();
  const { t } = useTranslation();
  const [docCreating, setDocCreating] = useState(false);
  const { controller, state } = useReaderSession();
  useLayoutEffect(() => setDocCreating(false), [state.generation]);

  if (ann.loadState === "loading") {
    return <div className="right-empty">{t("annotation.panel.loading")}</div>;
  }
  if (ann.loadState === "error") {
    return (
      <div className="right-empty">
        {t("annotation.panel.error")}
        <ActionButton unstyled mode="text" label={t("common.retry")} tooltip={t("common.retry")} className="ann-editor-btn" data-ui="reload-latex-annotations" onClick={() => void ann.reload()}>
          {t("common.retry")}
        </ActionButton>
      </div>
    );
  }
  // "missing" (doc deleted externally) falls through to the empty list — the
  // reader itself will show its own load error on the next doc fetch.

  const sorted = sortAnnotations(ann.annotations, store.blockOrder);

  return (
    <div className="ann-panel" data-ui="latex-annotations-list">
      <ActionButton
        unstyled
        mode="text"
        label={t("annotation.action.addDoc")}
        tooltip={t("annotation.action.addDocTooltip")}
        className="ann-add-doc"
        data-ui="add-document-annotation"
        onClick={() => { controller.beginCreate(); setDocCreating(true); }}
        disabled={docCreating || !ann.canAnnotate}
      >
        {t("annotation.action.addDoc")}
      </ActionButton>
      {docCreating && (
        <div className="ann-panel-editor" data-ui="latex-annotation-create-editor">
          <CreateAnnotationEditor target={{ type: "document" }} onSaved={() => setDocCreating(false)} onCancel={() => setDocCreating(false)} />
        </div>
      )}
      {sorted.length === 0 && !docCreating && (
        <div className="right-empty">
          {t("annotation.panel.empty")}
        </div>
      )}
      {sorted.map((a) => (
        <AnnotationEntry key={a.id} a={a} />
      ))}
    </div>
  );
}

function AnnotationEntry({ a }: { a: Annotation }) {
  const store = useStore();
  const ann = useAnnotations();
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const { controller } = useReaderSession();
  const sum = targetSummary(a, store);
  const active = ann.activeId === a.id;

  const openTarget = () => {
    ann.activate(a.id);
    const bid = targetBlockId(a.target);
    if (bid !== null && store.blockById.has(bid)) store.jumpTo(bid); // scroll + flash
  };

  return (
    <div className={"ann-entry" + (active ? " active" : "")} data-ann-id={a.id} data-ui="latex-annotation" data-ui-key={a.id}>
      <button className="ann-entry-main" data-ui="navigate-latex-annotation" disabled={!ann.canAnnotate} onClick={openTarget} title={sum.path ?? sum.label}>
        <span className="ann-entry-head">
          <span className="ann-entry-kind">{sum.label}</span>
          {sum.path && <span className="ann-entry-path">{sum.path}</span>}
        </span>
        {sum.snippet && <span className="ann-entry-quote">{sum.snippet}</span>}
        <span className="ann-entry-preview">{a.body}</span>
      </button>
      <span className="ann-entry-actions">
        <ActionButton
          mode="icon"
          iconName="pencil"
          label={t("annotation.action.edit")}
          tooltip={t("annotation.action.edit")}
          data-ui="edit-latex-annotation"
          disabled={!ann.canAnnotate}
          onClick={() => { controller.beginEdit(a); setEditing(true); }}
        />
        <ActionButton
          mode="icon"
          iconName="trash-2"
          label={t("annotation.action.delete")}
          tooltip={t("annotation.action.delete")}
          data-ui="delete-latex-annotation"
          disabled={ann.busy}
          onClick={() => void ann.removeAnnotation(a.id)}
        />
      </span>
      {editing && (
        <EditAnnotationEditor annotation={a} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
      )}
    </div>
  );
}
