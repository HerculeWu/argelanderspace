/**
 * Stage 10 Writer — right tool panel: References (live library, inserts
 * bare keys), Crossrefs (shared-IR targets, inserts the label) and
 * Comments (per-cell plain-text notes embedded in the manuscript).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import type { WriterComment, WriterManuscript, WriterNumberingResponse } from "@argelanderspace/contracts";
import { fetchLibrary } from "../api/library";
import type { LibraryRef } from "../library/types";
import { writerCrossrefs, type CrossrefTarget } from "./model";
import { TYPE_LABEL_KEY } from "./cells";

export type RightTab = "references" | "crossrefs" | "comments";

// ------------------------------------------------------------ references ----

function ReferencesPanel({ onInsertCite }: { onInsertCite: (key: string) => void }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [refs, setRefs] = useState<LibraryRef[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetchLibrary()
      .then(({ data }) => {
        if (alive) setRefs(data.refs);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const list = useMemo(() => {
    if (!refs) return [];
    const needle = q.trim().toLowerCase();
    return refs.filter(
      (r) => !needle || `${r.title} ${r.authors} ${r.cite}`.toLowerCase().includes(needle),
    );
  }, [refs, q]);

  return (
    <div className="w-panel-body">
      <div className="w-panel-title">{t("writer.refs.title")}</div>
      <div className="w-search">
        <Icon name="search" cls="ico-sm" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("writer.refs.search")}
        />
      </div>
      {error && <div className="w-note">{t("writer.refs.error")}</div>}
      {!error && refs === null && <div className="w-note">{t("writer.refs.loading")}</div>}
      {!error && refs !== null && list.length === 0 && (
        <div className="w-note">{t("writer.refs.empty")}</div>
      )}
      {list.map((r) => (
        <div className="w-ref-card" key={r.id}>
          <div className="w-ref-title">{r.title}</div>
          <div className="w-ref-meta">
            {r.authors} · {r.year}
          </div>
          <div className="w-ref-foot">
            <span className="w-key">{r.cite}</span>
            <button
              className="w-insert-key"
              data-ref-key={r.cite}
              title={t("writer.refs.insert")}
              onClick={() => onInsertCite(r.cite)}
            >
              <Icon name="plus" cls="ico-sm" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------ crossrefs ----

function CrossrefsPanel({
  doc,
  numbering,
  onInsertLabel,
}: {
  doc: WriterManuscript;
  /** Compile-truth numbering; missing facts display unresolved placeholders. */
  numbering?: WriterNumberingResponse | null;
  onInsertLabel: (targetCell: string, label: string, envIndex?: number, sectionIndex?: number) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const targets = writerCrossrefs(doc.cells, numbering);
  const needle = q.trim().toLowerCase();
  const list = targets.filter(
    (x) => !needle || `${x.title} ${x.label}`.toLowerCase().includes(needle),
  );
  const kindLabel = (k: CrossrefTarget["kind"]) =>
    k === "section"
      ? t("writer.outline.sections")
      : k === "equation"
        ? t("writer.outline.equations")
        : t(TYPE_LABEL_KEY[k]);

  return (
    <div className="w-panel-body">
      <div className="w-panel-title">
        {t("writer.xref.title")}
        {numbering?.status === "stale" && (
          <span className="w-stale" title={numbering.lastError ?? undefined}>
            {t("writer.numbering.stale")}
          </span>
        )}
      </div>
      <div className="w-search">
        <Icon name="search" cls="ico-sm" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("writer.xref.search")}
        />
      </div>
      {list.map((x) => (
        <div className="w-ref-card" key={`${x.cell}-${x.targetId ?? `${x.kind}-${x.sectionIndex ?? x.envIndex ?? 0}`}`}>
          <div className="w-ref-title">
            {kindLabel(x.kind)} {x.number} · {x.title}
          </div>
          <div className="w-ref-foot">
            <span className="w-key">{x.label || t("writer.xref.noLabel")}</span>
            <button
              className="w-insert-key"
              data-xref-insert={x.label}
              data-target-cell={x.cell}
              title={t(x.insertable === false ? "writer.xref.needsLabel" : "writer.xref.insert")}
              disabled={x.insertable === false}
              onClick={() => onInsertLabel(x.cell, x.label, x.envIndex, x.sectionIndex)}
            >
              <Icon name="plus" cls="ico-sm" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------- comments ----

function CommentsPanel({
  doc,
  activeId,
  onAdd,
}: {
  doc: WriterManuscript;
  activeId: string | null;
  onAdd: (cellId: string, body: string) => void;
}) {
  const { t } = useTranslation();
  const [body, setBody] = useState("");
  // prototype: with no active cell, ALL comments are listed; a new comment
  // attaches to the active cell (or the first cell as a fallback).
  const shown = doc.comments.filter((c) => !activeId || c.cell === activeId);
  const target = activeId ?? doc.cells[0]?.id ?? null;
  const activeType = doc.cells.find((c) => c.id === activeId)?.type;

  const add = () => {
    const text = body.trim();
    if (!text || !target) return;
    onAdd(target, text);
    setBody("");
  };

  return (
    <div className="w-panel-body w-comments">
      <div className="w-panel-title">
        {t("writer.comments.title")}
        {activeType ? t("writer.comments.forCell", { type: t(TYPE_LABEL_KEY[activeType]) }) : ""}
      </div>
      {shown.length === 0 && <div className="w-note">{t("writer.comments.empty")}</div>}
      {shown.map((c: WriterComment) => (
        <div className="w-comment-card" key={c.id}>
          <div className="w-comment-head">
            <span className="w-who">{c.who}</span>
            <span>· cell {c.cell}</span>
          </div>
          <div className="w-comment-body">{c.body}</div>
        </div>
      ))}
      <div className="w-comment-compose">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("writer.comments.placeholder")}
        />
        <button className="btn primary" disabled={!body.trim() || !target} onClick={add}>
          {t("writer.comments.add")}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- shell ----

export function RightTabs({
  doc,
  numbering,
  tab,
  onTab,
  activeId,
  onInsertCite,
  onInsertLabel,
  onAddComment,
}: {
  doc: WriterManuscript;
  /** Compile-truth numbering (M3b); forwarded to the Crossrefs panel. */
  numbering?: WriterNumberingResponse | null;
  tab: RightTab;
  onTab: (t: RightTab) => void;
  activeId: string | null;
  onInsertCite: (key: string) => void;
  onInsertLabel: (targetCell: string, label: string, envIndex?: number, sectionIndex?: number) => void;
  onAddComment: (cellId: string, body: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <div className="w-right-tabs">
        <button
          className={"w-right-tab" + (tab === "references" ? " on" : "")}
          onClick={() => onTab("references")}
        >
          {t("writer.tabs.references")}
        </button>
        <button
          className={"w-right-tab" + (tab === "crossrefs" ? " on" : "")}
          onClick={() => onTab("crossrefs")}
        >
          {t("writer.tabs.crossrefs")}
        </button>
        <button
          className={"w-right-tab" + (tab === "comments" ? " on" : "")}
          onClick={() => onTab("comments")}
        >
          {t("writer.tabs.comments")}{" "}
          <span className="w-badge">{doc.comments.length}</span>
        </button>
      </div>
      {tab === "references" && <ReferencesPanel onInsertCite={onInsertCite} />}
      {tab === "crossrefs" && (
        <CrossrefsPanel doc={doc} numbering={numbering} onInsertLabel={onInsertLabel} />
      )}
      {tab === "comments" && (
        <CommentsPanel doc={doc} activeId={activeId} onAdd={onAddComment} />
      )}
    </>
  );
}
