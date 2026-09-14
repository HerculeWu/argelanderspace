import { useReaderSession } from "../doc/ReaderSession";
import { useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Annotation } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";
import { useStore } from "../store";
import { useAnnotations } from "./AnnotationStore";
import { CreateAnnotationEditor, EditAnnotationEditor } from "./AnnotationEditor";
import { sortAnnotations, targetBlockId, targetSummary } from "./model";

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
        <button className="ann-editor-btn" onClick={() => void ann.reload()}>
          {t("common.retry")}
        </button>
      </div>
    );
  }
  // "missing" (doc deleted externally) falls through to the empty list — the
  // reader itself will show its own load error on the next doc fetch.

  const sorted = sortAnnotations(ann.annotations, store.blockOrder);

  return (
    <div className="ann-panel">
      <button
        className="ann-add-doc"
        onClick={() => { controller.beginCreate(); setDocCreating(true); }}
        disabled={docCreating || !ann.canAnnotate}
      >
        <Icon name="plus" cls="ico-sm" />
        {t("annotation.action.addDoc")}
      </button>
      {docCreating && (
        <div className="ann-panel-editor">
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
    <div className={"ann-entry" + (active ? " active" : "")} data-ann-id={a.id}>
      <button className="ann-entry-main" disabled={!ann.canAnnotate} onClick={openTarget} title={sum.path ?? sum.label}>
        <span className="ann-entry-head">
          <span className="ann-entry-kind">{sum.label}</span>
          {sum.path && <span className="ann-entry-path">{sum.path}</span>}
        </span>
        {sum.snippet && <span className="ann-entry-quote">{sum.snippet}</span>}
        <span className="ann-entry-preview">{a.body}</span>
      </button>
      <span className="ann-entry-actions">
        <button
          title={t("annotation.action.edit")}
          aria-label={t("annotation.action.edit")}
          disabled={!ann.canAnnotate}
          onClick={() => { controller.beginEdit(a); setEditing(true); }}
        >
          <Icon name="pencil" cls="ico-sm" />
        </button>
        <button
          title={t("annotation.action.delete")}
          aria-label={t("annotation.action.delete")}
          disabled={ann.busy}
          onClick={() => void ann.removeAnnotation(a.id)}
        >
          <Icon name="trash-2" cls="ico-sm" />
        </button>
      </span>
      {editing && (
        <EditAnnotationEditor annotation={a} onSaved={() => setEditing(false)} onCancel={() => setEditing(false)} />
      )}
    </div>
  );
}
