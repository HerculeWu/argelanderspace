import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LibraryRef } from "../library/types";
import { Icon } from "../lib/icons";
import { mdWithMath } from "../lib/mdWithMath";
import { DrawerStatusRow } from "./atoms";
import type { Plan, Task, TaskStatus } from "./model";
import { DueBadge, PinBtn } from "./taskBits";

// The task drawer (Stage 4): plan tag + title + four-state status row +
// edit (TaskModal, prefilled) + pin toggle + linked documents (search-picker
// add, library-title lookup, click-through to the doc pane; a doc the
// library no longer knows renders grayed as "doc missing" and is NOT
// auto-removed) + the note (view ⇄ edit, markdown+math, ⌘↵ saves) + delete
// (6s undo toast handled by PlanView).

interface DrawerCallbacks {
  onSetStatus: (planId: string, taskId: string, status: TaskStatus) => void;
  onTogglePin: (planId: string, taskId: string) => void;
  onEdit: (planId: string, task: Task) => void;
  onSetNote: (planId: string, taskId: string, note: string | undefined) => void;
  onAddLink: (planId: string, taskId: string, docId: string) => void;
  onRemoveLink: (planId: string, taskId: string, docId: string) => void;
  onDelete: (planId: string, taskId: string) => void;
  onOpenDoc: (docId: string) => void;
  onClose: () => void;
}

export function TaskDrawer({
  task,
  plan,
  today,
  refs,
  cb,
}: {
  task: Task;
  plan: Plan;
  today: string;
  refs: LibraryRef[];
  cb: DrawerCallbacks;
}) {
  const { t } = useTranslation();
  const byDocId = new Map(refs.filter((r) => r.doc_id).map((r) => [r.doc_id as string, r]));
  return (
    <div className="plan-drawer view-in">
      <div className="plan-drawer-head">
        <span className="tag">{plan.name}</span>
        <div className="plan-drawer-head-actions">
          <button className="btn icon ghost" title={t("plan.action.editTask")} onClick={() => cb.onEdit(plan.id, task)}>
            <Icon name="pencil" cls="ico-sm" />
          </button>
          <PinBtn focused={task.focused} onToggle={() => cb.onTogglePin(plan.id, task.id)} />
          <button className="btn icon ghost" title={t("common.close")} onClick={cb.onClose}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
      </div>
      <div className="plan-drawer-title">{task.title}</div>
      <div className="plan-drawer-duerow">{task.due && <DueBadge due={task.due} today={today} />}</div>
      <DrawerStatusRow status={task.status} onSet={(s) => cb.onSetStatus(plan.id, task.id, s)} />

      <div className="plan-drawer-section">{t("plan.drawer.links")}</div>
      {task.links.length > 0 && (
        <div className="plan-drawer-arts">
          {task.links.map((l) => {
            const ref = byDocId.get(l.doc_id);
            if (!ref) {
              // the library no longer has this doc: grayed, kept, removable
              return (
                <div key={l.doc_id} className="plan-drawer-art missing" title={l.doc_id}>
                  <Icon name="file-x" cls="ico-sm" />
                  <span className="mono">{t("plan.drawer.docMissing")}</span>
                  <span className="plan-drawer-art-kind">{l.doc_id}</span>
                  <button
                    className="plan-drawer-art-x"
                    title={t("plan.drawer.removeLink")}
                    onClick={() => cb.onRemoveLink(plan.id, task.id, l.doc_id)}
                  >
                    <Icon name="x" cls="ico-sm" />
                  </button>
                </div>
              );
            }
            return (
              <div key={l.doc_id} className="plan-drawer-art-wrap">
                <button
                  className="plan-drawer-art"
                  title={t("plan.drawer.openDoc", { title: ref.title })}
                  onClick={() => cb.onOpenDoc(l.doc_id)}
                >
                  <Icon name="file-text" cls="ico-sm" />
                  <span className="plan-drawer-art-t">{ref.title}</span>
                  <Icon name="arrow-up-right" cls="ico-sm" />
                </button>
                <button
                  className="plan-drawer-art-x"
                  title={t("plan.drawer.removeLink")}
                  onClick={() => cb.onRemoveLink(plan.id, task.id, l.doc_id)}
                >
                  <Icon name="x" cls="ico-sm" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <LinkPicker
        candidates={refs.filter(
          (r) => r.doc_id && !task.links.some((l) => l.doc_id === r.doc_id)
        )}
        onPick={(docId) => cb.onAddLink(plan.id, task.id, docId)}
      />

      <div className="plan-drawer-section">{t("plan.drawer.note")}</div>
      <NoteEditor key={task.id} value={task.note} onSave={(v) => cb.onSetNote(plan.id, task.id, v)} />

      <div className="plan-drawer-spacer" />
      <button className="plan-drawer-delete" onClick={() => cb.onDelete(plan.id, task.id)}>
        <Icon name="trash-2" cls="ico-sm" />
        {t("plan.drawer.deleteTask")}
      </button>
    </div>
  );
}

/** CommandPalette-style filter picker over library refs that have a doc. */
function LinkPicker({
  candidates,
  onPick,
}: {
  candidates: LibraryRef[];
  onPick: (docId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open) {
    return (
      <button className="plan-drawer-art add" onClick={() => setOpen(true)}>
        <Icon name="plus" cls="ico-sm" />
        {t("plan.drawer.addLink")}
      </button>
    );
  }
  const needle = q.trim().toLowerCase();
  const filtered = candidates
    .filter(
      (r) =>
        !needle ||
        r.title.toLowerCase().includes(needle) ||
        r.authors.toLowerCase().includes(needle) ||
        (r.doc_id ?? "").toLowerCase().includes(needle)
    )
    .slice(0, 8);
  return (
    <div className="plan-linkpick">
      <div className="plan-linkpick-input">
        <Icon name="search" cls="ico-sm" />
        <input
          ref={ref}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder={t("plan.drawer.searchPlaceholder")}
        />
        <button className="btn icon ghost" title={t("common.close")} onClick={() => setOpen(false)}>
          <Icon name="x" cls="ico-sm" />
        </button>
      </div>
      <div className="plan-linkpick-list">
        {filtered.map((r) => (
          <button
            key={r.id}
            className="plan-linkpick-item"
            onClick={() => {
              onPick(r.doc_id as string);
              setOpen(false);
              setQ("");
            }}
          >
            <Icon name="file-text" cls="ico-sm" />
            <span className="plan-linkpick-t">{r.title}</span>
          </button>
        ))}
        {filtered.length === 0 && <div className="plan-linkpick-empty">{t("plan.drawer.noMatch")}</div>}
      </div>
    </div>
  );
}

/** The note's view/edit split: view = markdown+math render; edit = textarea, ⌘↵ saves. */
function NoteEditor({
  value,
  onSave,
}: {
  value: string | undefined;
  onSave: (v: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (editing && ta.current) {
      ta.current.focus();
      ta.current.setSelectionRange(ta.current.value.length, ta.current.value.length);
    }
  }, [editing]);

  if (editing) {
    return (
      <div className="plan-note-edit">
        <textarea
          ref={ta}
          className="plan-note-textarea mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              onSave(draft.trim() || undefined);
              setEditing(false);
            }
            if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(value ?? "");
              setEditing(false);
            }
          }}
          placeholder={t("plan.drawer.notePlaceholder")}
        />
        <div className="plan-note-edit-foot">
          <span className="plan-note-hint">
            <Icon name="sparkles" cls="ico-sm" />
            {t("plan.drawer.noteHint")}
          </span>
          <div style={{ flex: 1 }} />
          <button
            className="plan-note-btn"
            onClick={() => {
              setDraft(value ?? "");
              setEditing(false);
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            className="plan-note-btn primary"
            onClick={() => {
              onSave(draft.trim() || undefined);
              setEditing(false);
            }}
          >
            <Icon name="check" cls="ico-sm" />
            {t("common.save")}
          </button>
        </div>
      </div>
    );
  }
  const html = mdWithMath(value ?? "");
  return (
    <div className="plan-note-view">
      {html ? (
        <>
          <div className="plan-md-body" dangerouslySetInnerHTML={{ __html: html }} />
          <button
            className="plan-note-edit-btn"
            onClick={() => {
              setDraft(value ?? "");
              setEditing(true);
            }}
          >
            <Icon name="pencil" cls="ico-sm" />
            {t("common.edit")}
          </button>
        </>
      ) : (
        <button
          className="plan-note-empty"
          onClick={() => {
            setDraft("");
            setEditing(true);
          }}
        >
          <Icon name="plus" cls="ico-sm" />
          {t("plan.drawer.noteEmpty")}
        </button>
      )}
    </div>
  );
}
