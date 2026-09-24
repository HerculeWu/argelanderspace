/**
 * Stage 10 Writer — manuscript list: flat table (title / template / updated,
 * updated_at desc), New → NewManuscriptModal, per-row delete with double
 * confirm. No rename here — the title is edited via the editor's Info modal
 * (consensus R2 Q13f).
 *
 * M2b: data comes from the real REST api (api/writer.ts) — no fixture
 * fallback; an unreachable server shows an explicit error + retry state
 * (plans precedent). `writer.changed` WS events refresh the list/templates.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import type { ManuscriptSummary, WriterTemplate } from "@argelanderspace/contracts";
import {
  createManuscript,
  deleteManuscript,
  fetchManuscripts,
  fetchTemplates,
} from "../api/writer";
import { onWriterChanged } from "../api/ws";
import { ConfirmDeleteModal } from "./modals";

function fmtUpdated(iso: string, lang: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function NewManuscriptModal({
  templates,
  onCreate,
  onClose,
}: {
  templates: WriterTemplate[];
  onCreate: (input: { template: string; title?: string }) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [template, setTemplate] = useState("");
  const valid = template !== "";
  const submit = () => {
    if (!valid) return;
    onCreate({ template, title: title.trim() || undefined });
  };
  return (
    <div className="w-modal-overlay" data-ui="new-manuscript-overlay" onClick={onClose}>
      <div className="w-modal" data-ui="new-manuscript-dialog" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="w-modal-head">
          <strong>{t("writer.newModal.title")}</strong>
          <button className="btn icon ghost" data-ui="close-new-manuscript" onClick={onClose}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
        <div className="w-modal-body">
          <div className="w-field">
            <label htmlFor="w-new-title">{t("writer.newModal.nameLabel")}</label>
            <input
              id="w-new-title" data-ui="new-manuscript-title"
              value={title}
              placeholder={t("writer.newModal.namePlaceholder")}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          <div className="w-field">
            <label htmlFor="w-new-template">{t("writer.newModal.templateLabel")}</label>
            <select id="w-new-template" data-ui="new-manuscript-template" value={template} onChange={(e) => setTemplate(e.target.value)}>
              <option value="" disabled>
                {t("writer.newModal.templatePlaceholder")}
              </option>
              {templates.map((tp) => (
                <option key={tp.id} value={tp.id}>
                  {tp.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="w-modal-foot">
          <button className="btn" data-ui="cancel-new-manuscript" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" data-ui="confirm-create-manuscript" disabled={!valid} onClick={submit}>
            <Icon name="plus" cls="ico-sm" /> {t("writer.newModal.create")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ManuscriptList({
  notice,
  onOpen,
}: {
  /** one-shot note (e.g. "deleted elsewhere") shown above the table */
  notice?: string | null;
  onOpen: (id: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<ManuscriptSummary[] | null>(null);
  const [templates, setTemplates] = useState<WriterTemplate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<ManuscriptSummary | null>(null);
  const hasData = useRef(false);

  const reload = useCallback(async () => {
    const [ms, tps] = await Promise.all([fetchManuscripts(), fetchTemplates()]);
    if (ms === null || tps === null) {
      // only the initial load has nothing to fall back on — later failed
      // reloads keep the current table (plans precedent)
      if (!hasData.current) setLoadFailed(true);
      return;
    }
    hasData.current = true;
    setRows(ms.manuscripts);
    setTemplates(tps.templates);
    setLoadFailed(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // External writes (agent editing the JSON) or creates/deletes elsewhere:
  // refresh the list; template-dir changes also refresh the template list.
  useEffect(() => onWriterChanged(() => void reload()), [reload]);

  const templateLabel = (id: string) => templates?.find((tp) => tp.id === id)?.label ?? id;

  const onCreate = async (input: { template: string; title?: string }) => {
    try {
      const m = await createManuscript(input);
      setNewOpen(false);
      onOpen(m.id);
    } catch {
      setActionError(t("writer.list.createFailed"));
    }
  };

  const onDelete = async () => {
    if (!deleting) return;
    const ok = await deleteManuscript(deleting.id);
    setDeleting(null);
    if (ok) await reload();
    else setActionError(t("writer.list.deleteFailed"));
  };

  return (
    <div className="writer-root" data-ui="manuscript-list">
      <div className="w-topbar">
        <div className="w-title">
          <strong>{t("writer.list.title")}</strong>
          {rows !== null && <span className="w-save-status">{rows.length}</span>}
        </div>
        <button className="btn primary" data-ui="create-manuscript" disabled={templates === null} onClick={() => setNewOpen(true)}>
          <Icon name="plus" cls="ico-sm" /> {t("writer.list.new")}
        </button>
      </div>
      <div className="w-list-scroll" data-ui="manuscript-list-content">
        {notice && <div className="w-note w-padded">{notice}</div>}
        {actionError && <div className="w-note w-padded">{actionError}</div>}
        {rows === null && !loadFailed && (
          <div className="w-note w-padded">{t("writer.list.loading")}</div>
        )}
        {loadFailed && (
          <div className="w-list-empty">
            <div className="w-list-empty-ic">
              <Icon name="cloud-off" cls="ico-lg" />
            </div>
            <div>{t("writer.list.loadFailedTitle")}</div>
            <div className="w-list-empty-hint">{t("writer.list.loadFailedHint")}</div>
            <button className="btn primary" data-ui="retry-manuscript-list" onClick={() => void reload()}>
              {t("common.retry")}
            </button>
          </div>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="w-list-empty">
            <div className="w-list-empty-ic">
              <Icon name="notebook-pen" cls="ico-lg" />
            </div>
            <div>{t("writer.list.empty")}</div>
            <div className="w-list-empty-hint">{t("writer.list.emptyHint")}</div>
            <button className="btn primary" data-ui="create-first-manuscript" onClick={() => setNewOpen(true)}>
              <Icon name="plus" cls="ico-sm" /> {t("writer.list.new")}
            </button>
          </div>
        )}
        {rows !== null && rows.length > 0 && (
          <table className="w-list-table">
            <thead>
              <tr>
                <th>{t("writer.newModal.nameLabel")}</th>
                <th>{t("writer.list.colTemplate")}</th>
                <th>{t("writer.list.colUpdated")}</th>
                <th aria-label={t("common.delete")} />
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} data-ms={m.id} data-ui="manuscript-item" data-ui-key={m.id} onClick={() => onOpen(m.id)}>
                  <td className="w-list-title">{m.title}</td>
                  <td>{templateLabel(m.template)}</td>
                  <td>{fmtUpdated(m.updated_at, i18n.language)}</td>
                  <td>
                    <button
                      className="btn icon ghost"
                      data-ui="delete-manuscript"
                      title={t("common.delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleting(m);
                      }}
                    >
                      <Icon name="trash-2" cls="ico-sm" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {newOpen && templates !== null && (
        <NewManuscriptModal
          templates={templates}
          onClose={() => setNewOpen(false)}
          onCreate={(input) => void onCreate(input)}
        />
      )}
      {deleting && (
        <ConfirmDeleteModal
          title={deleting.title}
          onClose={() => setDeleting(null)}
          onConfirm={() => void onDelete()}
        />
      )}
    </div>
  );
}
