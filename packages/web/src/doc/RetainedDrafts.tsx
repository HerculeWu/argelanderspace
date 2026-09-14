import { useReaderSession } from "./ReaderSession";

/** Always outside the disposable reader tree, including the missing-doc state. */
export function RetainedDrafts() {
  const { state, controller } = useReaderSession();
  const edits = Object.values(state.editDrafts);
  if (!state.createDraft.body && !edits.length) return null;
  return (
    <details className="reader-drafts" open={state.phase !== "ready"}>
      <summary>保留的草稿（可复制；重新选位后使用创建文字）</summary>
      {state.createDraft.body && (
        <div>
          <label>
            创建草稿
            <textarea aria-label="保留的创建草稿" readOnly value={state.createDraft.body} />
          </label>
          <button onClick={() => controller.clearCreate()}>丢弃创建草稿</button>
        </div>
      )}
      {edits.map((d) => (
        <div key={d.annotationId}>
          <label>
            编辑草稿 {d.annotationId}
            {d.blocked ? " · 不可保存" : ""}
            <textarea aria-label={`保留的编辑草稿 ${d.annotationId}`} readOnly value={d.body} />
          </label>
          <button onClick={() => controller.clearEdit(d.annotationId)}>丢弃编辑草稿</button>
        </div>
      ))}
    </details>
  );
}
