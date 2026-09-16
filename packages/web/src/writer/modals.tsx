/**
 * Stage 10 Writer — modals: document Info (title/authors/affiliations +
 * template-driven extra fields), Preamble (template read-only + user), and
 * the delete-manuscript double confirm. The shell mirrors plan/atoms.Modal.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import { LatexSourceField } from "./latexSource";
import type { WriterAuthor, WriterManuscript, WriterTemplate } from "@argelanderspace/contracts";

/** Generic modal shell (overlay click + Escape close), plan/atoms pattern. */
export function WModal({
  title,
  onClose,
  children,
  footer,
  width = 680,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="w-modal-overlay" onClick={onClose}>
      <div className="w-modal" style={{ width }} onClick={(e) => e.stopPropagation()}>
        <div className="w-modal-head">
          <strong>{title}</strong>
          <button className="btn icon ghost" onClick={onClose}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
        <div className="w-modal-body">{children}</div>
        {footer && <div className="w-modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ info ----

export interface InfoFormValues {
  title: string;
  authors: WriterAuthor[];
  affiliations: string[];
  infoValues: Record<string, string>;
}

export function InfoModal({
  doc,
  template,
  onSave,
  onClose,
}: {
  doc: WriterManuscript;
  template: WriterTemplate;
  onSave: (v: InfoFormValues) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(doc.title);
  const [authors, setAuthors] = useState<WriterAuthor[]>(doc.authors.map((a) => ({ ...a })));
  const [affils, setAffils] = useState<string[]>([...doc.affiliations]);
  const [infoValues, setInfoValues] = useState<Record<string, string>>({ ...doc.infoValues });

  const save = () =>
    onSave({
      title: title.trim() || t("writer.list.untitled"),
      authors: authors.map((a) => ({ ...a })),
      affiliations: [...affils],
      infoValues: { ...infoValues },
    });

  return (
    <WModal
      title={t("writer.info.title")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={save}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="w-modal-note">{t("writer.info.note")}</div>
      <div className="w-field">
        <label htmlFor="w-info-title">{t("writer.info.titleLabel")}</label>
        <input id="w-info-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>

      <div className="w-panel-title w-modal-sec">{t("writer.info.authors")}</div>
      {authors.map((a, i) => (
        <div className="w-author-row" key={i}>
          <input
            data-author-name={i}
            value={a.name}
            placeholder={t("writer.info.namePh")}
            onChange={(e) =>
              setAuthors((as) => as.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))
            }
          />
          <input
            data-author-aff={i}
            value={a.aff}
            placeholder={t("writer.info.affPh")}
            onChange={(e) =>
              setAuthors((as) => as.map((x, j) => (j === i ? { ...x, aff: e.target.value } : x)))
            }
          />
          <input
            data-author-email={i}
            value={a.email ?? ""}
            placeholder={t("writer.info.emailPh")}
            onChange={(e) =>
              setAuthors((as) => as.map((x, j) => (j === i ? { ...x, email: e.target.value } : x)))
            }
          />
          <button
            className="w-small-x"
            title={t("common.delete")}
            onClick={() => setAuthors((as) => as.filter((_, j) => j !== i))}
          >
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
      ))}
      <button
        className="btn"
        onClick={() =>
          setAuthors((as) => [...as, { name: "", aff: String(affils.length || 1), email: "" }])
        }
      >
        <Icon name="plus" cls="ico-sm" /> {t("writer.info.addAuthor")}
      </button>

      <div className="w-panel-title w-modal-sec">{t("writer.info.affils")}</div>
      {affils.map((a, i) => (
        <div className="w-affil-row" key={i}>
          <span>{i + 1}</span>
          <input
            data-affil={i}
            value={a}
            onChange={(e) => setAffils((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
          />
          <button
            className="w-small-x"
            title={t("common.delete")}
            onClick={() => setAffils((xs) => xs.filter((_, j) => j !== i))}
          >
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
      ))}
      <button className="btn" onClick={() => setAffils((xs) => [...xs, ""])}>
        <Icon name="plus" cls="ico-sm" /> {t("writer.info.addAffil")}
      </button>

      {template.infoFields.length > 0 && (
        <div className="w-form-grid w-modal-sec">
          {template.infoFields.map((fld) => (
            <div className="w-field" key={fld.key}>
              <label htmlFor={`w-info-fld-${fld.key}`}>{fld.label}</label>
              {fld.input === "textarea" ? (
                <textarea
                  id={`w-info-fld-${fld.key}`}
                  data-info-key={fld.key}
                  value={infoValues[fld.key] ?? ""}
                  onChange={(e) =>
                    setInfoValues((v) => ({ ...v, [fld.key]: e.target.value }))
                  }
                />
              ) : (
                <input
                  id={`w-info-fld-${fld.key}`}
                  data-info-key={fld.key}
                  value={infoValues[fld.key] ?? ""}
                  onChange={(e) =>
                    setInfoValues((v) => ({ ...v, [fld.key]: e.target.value }))
                  }
                />
              )}
            </div>
          ))}
        </div>
      )}
    </WModal>
  );
}

// -------------------------------------------------------------- preamble ----

export function PreambleModal({
  template,
  userPreamble,
  onSave,
  onClose,
}: {
  template: WriterTemplate;
  userPreamble: string;
  onSave: (userPreamble: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(userPreamble);
  return (
    <WModal
      title={t("writer.preamble.title")}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" onClick={() => onSave(value)}>
            {t("common.save")}
          </button>
        </>
      }
    >
      <div className="w-field">
        <label htmlFor="w-preamble-template">{t("writer.preamble.templateLabel")}</label>
        <textarea id="w-preamble-template" className="w-tall w-readonly" value={template.preamble} readOnly disabled />
      </div>
      <div className="w-field">
        <label htmlFor="w-preamble-user">{t("writer.preamble.userLabel")}</label>
        <LatexSourceField id="w-preamble-user" label={t("writer.preamble.userLabel")} value={value} onChange={setValue} />
      </div>
      <div className="w-modal-note">{t("writer.preamble.note")}</div>
    </WModal>
  );
}

// -------------------------------------------------------- delete confirm ----

export function ConfirmDeleteModal({
  title,
  onConfirm,
  onClose,
}: {
  title: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <WModal
      title={t("writer.list.deleteTitle")}
      width={440}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn w-danger" onClick={onConfirm}>
            <Icon name="trash-2" cls="ico-sm" /> {t("common.delete")}
          </button>
        </>
      }
    >
      <div className="w-modal-note">{t("writer.list.deleteBody", { title })}</div>
    </WModal>
  );
}
