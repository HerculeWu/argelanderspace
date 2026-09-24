import { useReaderSession } from "./ReaderSession";
import { useTranslation } from "react-i18next";

/** Always outside the disposable reader tree, including the missing-doc state. */
export function RetainedDrafts() {
  const { state, controller } = useReaderSession();
  const { t } = useTranslation();
  const edits = Object.values(state.editDrafts);
  if (!state.createDraft.body && !edits.length) return null;
  return (
    <details className="reader-drafts" data-ui="latex-retained-drafts" open={state.phase !== "ready"}>
      <summary>{t("doc.drafts.summary")}</summary>
      {state.createDraft.body && (
        <div>
          <label>
            {t("doc.drafts.createLabel")}
            <textarea data-ui="retained-create-body" aria-label={t("doc.drafts.createAria")} readOnly value={state.createDraft.body} />
          </label>
          <button data-ui="discard-create-draft" onClick={() => controller.clearCreate()}>{t("doc.drafts.discardCreate")}</button>
        </div>
      )}
      {edits.map((d) => (
        <div key={d.annotationId}>
          <label>
            {d.blocked ? t("doc.drafts.editLabelBlocked", { id: d.annotationId }) : t("doc.drafts.editLabel", { id: d.annotationId })}
            <textarea data-ui="retained-edit-body" data-ui-key={d.annotationId} aria-label={t("doc.drafts.editAria", { id: d.annotationId })} readOnly value={d.body} />
          </label>
          <button data-ui="discard-edit-draft" data-ui-key={d.annotationId} onClick={() => controller.clearEdit(d.annotationId)}>{t("doc.drafts.discardEdit")}</button>
        </div>
      ))}
    </details>
  );
}
