import { useEffect, useRef, useState } from "react";
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
  initial,
  busy,
  saveDisabled = false,
  onSave,
  onCancel,
}: {
  initial: string;
  busy: boolean;
  /** Hard-disable saving (the archived-target state: the annotation is gone,
   *  so a save could never land — the banner above the editor explains why). */
  saveDisabled?: boolean;
  onSave: (body: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
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
        onChange={(e) => setDraft(e.target.value)}
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
