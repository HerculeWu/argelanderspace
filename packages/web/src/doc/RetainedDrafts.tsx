import { useReaderSession } from "./ReaderSession";
import { useTranslation } from "react-i18next";

/** Always outside the disposable reader tree, including the missing-doc state. */
export function RetainedDrafts() {
  const { state, controller } = useReaderSession();
  const { t } = useTranslation();
  const edits = Object.values(state.editDrafts);
  if (!state.createDraft.body && !edits.length) return null;
  return (
    <details className="reader-drafts" open={state.phase !== "ready"}>
      <summary>{t("doc.drafts.summary")}</summary>
      {state.createDraft.body && (
        <div>
          <label>
            {t("doc.drafts.createLabel")}
            <textarea aria-label={t("doc.drafts.createAria")} readOnly value={state.createDraft.body} />
          </label>
          <button onClick={() => controller.clearCreate()}>{t("doc.drafts.discardCreate")}</button>
        </div>
      )}
      {edits.map((d) => (
        <div key={d.annotationId}>
          <label>
            {d.blocked ? t("doc.drafts.editLabelBlocked", { id: d.annotationId }) : t("doc.drafts.editLabel", { id: d.annotationId })}
            <textarea aria-label={t("doc.drafts.editAria", { id: d.annotationId })} readOnly value={d.body} />
          </label>
          <button onClick={() => controller.clearEdit(d.annotationId)}>{t("doc.drafts.discardEdit")}</button>
        </div>
      ))}
    </details>
  );
}
