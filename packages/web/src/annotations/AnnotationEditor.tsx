import { useReaderSession } from "../doc/ReaderSession";
import { useAnnotations } from "./AnnotationStore";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { ActionButton } from "../ui";

/**
 * The annotation body editor (Stage 8 MS3), mirroring the TaskDrawer NoteBody
 * pattern: a plain textarea; the saved bytes are the raw draft (whitespace
 * matters in markdown/code — validation is trim-nonempty, storage untrimmed).
 * ⌘↵ / Ctrl↵ saves; Escape cancels; an IME-composing Enter only commits the
 * composition, never saves (the Stage-4 smoke bug guard).
 *
 * `onSave` resolves true when the write landed; only then does the parent
 * close/switch the editor — a 409/500 keeps the draft on screen.
 */
export function AnnotationEditor({
  body: draft,
  onChange,
  busy,
  saveDisabled = false,
  onSave,
  onCancel,
}: {
  body: string;
  onChange: (body: string) => void;
  busy: boolean;
  /** Hard-disable saving (the archived-target state: the annotation is gone,
   *  so a save could never land — the banner above the editor explains why). */
  saveDisabled?: boolean;
  onSave: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (ta.current) {
      ta.current.focus();
      ta.current.setSelectionRange(ta.current.value.length, ta.current.value.length);
    }
  }, []);

  const valid = draft.trim() !== "";
  const canSave = valid && !busy && !saveDisabled;
  const save = () => {
    if (!canSave) return;
    void onSave(draft);
  };

  return (
    <div className="ann-editor" data-ui="latex-annotation-editor">
      <textarea
        ref={ta}
        className="ann-editor-textarea mono" data-ui="latex-annotation-body-input"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // an IME-composing Enter only commits the composition, never saves
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder={t("annotation.editor.placeholder")}
        rows={4}
      />
      <div className="ann-editor-foot">
        <span className="ann-editor-hint">
          <Icon name="sparkles" cls="ico-sm" />
          {t("annotation.editor.hint")}
        </span>
        <div style={{ flex: 1 }} />
        <ActionButton unstyled mode="text" label={t("common.cancel")} tooltip={t("common.cancel")} className="ann-editor-btn" data-ui="cancel-annotation-edit" onClick={onCancel}>
          {t("common.cancel")}
        </ActionButton>
        <ActionButton
          unstyled
          mode="text"
          label={t("common.save")}
          tooltip={t("common.save")}
          className="ann-editor-btn primary"
          data-ui="save-latex-annotation"
          disabled={!canSave}
          onClick={save}
        >
          {t("common.save")}
        </ActionButton>
      </div>
    </div>
  );
}

/** Controlled drafts survive popover and inner reader unmounts. */
export function CreateAnnotationEditor({ target, onSaved, onCancel }: {
  target: import("@argelanderspace/contracts").AnnotationTarget;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const { controller, state, canAnnotate } = useReaderSession();
  const ann = useAnnotations();
  const { t } = useTranslation();
  return <>
    {!state.createDraft.use && state.createDraft.body && <button className="ann-editor-btn" data-ui="use-retained-annotation-draft" onClick={controller.useCreateDraft}>{t("annotation.editor.useRetained")}</button>}
    <AnnotationEditor body={state.createDraft.use ? state.createDraft.body : ""} onChange={controller.setCreateBody}
      busy={ann.busy} saveDisabled={!canAnnotate} onCancel={onCancel}
      onSave={async (body) => {
        const revision = controller.getSnapshot().createDraft.revision;
        const generation = state.generation;
        const id = await ann.createAnnotation(target, body);
        const latest = controller.getSnapshot();
        if (id && latest.generation === generation && latest.createDraft.revision === revision + 1 && !latest.createDraft.body) onSaved(id);
        return id !== null;
      }} />
  </>;
}
export function EditAnnotationEditor({ annotation, onSaved, onCancel }: {
  annotation: import("@argelanderspace/contracts").Annotation;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { controller, state, canAnnotate } = useReaderSession();
  const ann = useAnnotations();
  const { t } = useTranslation();
  const d = state.editDrafts[annotation.id];
  if (!d) return null;
  return <>
    {d.blocked && <div className="ann-popover-archived">{t("annotation.editor.blocked")}</div>}
    <AnnotationEditor body={d.body} onChange={(body) => controller.setEditBody(annotation.id, body)}
      busy={ann.busy} saveDisabled={d.blocked || !canAnnotate} onCancel={onCancel}
      onSave={async (body) => {
        const ok = await ann.updateBody(annotation.id, body);
        if (ok && !controller.getSnapshot().editDrafts[annotation.id]) onSaved();
        return ok;
      }} />
  </>;
}
