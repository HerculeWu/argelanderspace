import { useReaderSession } from "../doc/ReaderSession";
import { useAnnotations } from "./AnnotationStore";
import { useEffect, useRef } from "react";
import { Icon } from "../lib/icons";

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
    <div className="ann-editor">
      <textarea
        ref={ta}
        className="ann-editor-textarea mono"
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // IME 组词中的 Enter 只是上屏，不是提交
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="支持 Markdown 与 $…$ / $$…$$ 数学"
        rows={4}
      />
      <div className="ann-editor-foot">
        <span className="ann-editor-hint">
          <Icon name="sparkles" cls="ico-sm" />
          Markdown + 数学 · ⌘↵ 保存
        </span>
        <div style={{ flex: 1 }} />
        <button className="ann-editor-btn" onClick={onCancel}>
          取消
        </button>
        <button
          className="ann-editor-btn primary"
          disabled={!canSave}
          onClick={save}
        >
          <Icon name="check" cls="ico-sm" />
          保存
        </button>
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
  return <>
    {!state.createDraft.use && state.createDraft.body && <button className="ann-editor-btn" onClick={controller.useCreateDraft}>使用保留文字</button>}
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
  const d = state.editDrafts[annotation.id];
  if (!d) return null;
  return <>
    {d.blocked && <div className="ann-popover-archived">原目标或内容已变化，草稿不可保存；可复制或明确丢弃。</div>}
    <AnnotationEditor body={d.body} onChange={(body) => controller.setEditBody(annotation.id, body)}
      busy={ann.busy} saveDisabled={d.blocked || !canAnnotate} onCancel={onCancel}
      onSave={async (body) => {
        const ok = await ann.updateBody(annotation.id, body);
        if (ok && !controller.getSnapshot().editDrafts[annotation.id]) onSaved();
        return ok;
      }} />
  </>;
}
