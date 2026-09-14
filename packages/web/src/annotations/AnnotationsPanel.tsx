import { useReaderSession } from "../doc/ReaderSession";
import { useLayoutEffect, useState } from "react";
import type { Annotation } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";
import { useStore } from "../store";
import { useAnnotations } from "./AnnotationStore";
import { CreateAnnotationEditor, EditAnnotationEditor } from "./AnnotationEditor";
import { sortAnnotations, targetBlockId, targetSummary } from "./model";

/**
 * The 标注 tab of the reader's right panel (Stage 8 MS3): document-level
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
  const [docCreating, setDocCreating] = useState(false);
  const { controller, state } = useReaderSession();
  useLayoutEffect(() => setDocCreating(false), [state.generation]);

  if (ann.loadState === "loading") {
    return <div className="right-empty">标注载入中…</div>;
  }
  if (ann.loadState === "error") {
    return (
      <div className="right-empty">
        标注载入失败（服务器错误）。
        <button className="ann-editor-btn" onClick={() => void ann.reload()}>
          重试
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
        添加文档标注
      </button>
      {docCreating && (
        <div className="ann-panel-editor">
          <CreateAnnotationEditor target={{ type: "document" }} onSaved={() => setDocCreating(false)} onCancel={() => setDocCreating(false)} />
        </div>
      )}
      {sorted.length === 0 && !docCreating && (
        <div className="right-empty">
          暂无标注。悬停正文中的段落 / 公式 / 图表等块，点击右侧出现的按钮添加；或用上方按钮标注整篇文档。
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
          title="编辑标注"
          aria-label="编辑标注"
          disabled={!ann.canAnnotate}
          onClick={() => { controller.beginEdit(a); setEditing(true); }}
        >
          <Icon name="pencil" cls="ico-sm" />
        </button>
        <button
          title="删除标注"
          aria-label="删除标注"
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
