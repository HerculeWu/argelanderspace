import { useReaderSession } from "../doc/ReaderSession";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Annotation, AnnotationTarget } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";
import { mdWithMath } from "../lib/mdWithMath";
import i18n from "../i18n";
import { useAnnotations } from "./AnnotationStore";
import { CreateAnnotationEditor, EditAnnotationEditor } from "./AnnotationEditor";
import { kindLabel, targetBlockId } from "./model";

// The annotation popover (Stage 8 MS3): creation and editing both go through
// it. Rendered as a child of the reader's <main> so block lookups stay scoped
// to this pane when several doc panes are split open; positioned `fixed` near
// the target block's right edge and re-anchored on reader scroll / window
// resize (a static fixed box would detach from its block on scroll). A
// document-level target anchors to the reader's top-right corner instead.

const POPOVER_W = 320;

export function AnnotationPopover() {
  const ann = useAnnotations();
  const { controller, state } = useReaderSession();
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // View → edit switch, held as a SNAPSHOT of the annotation being edited: if
  // the annotation vanishes mid-edit (a 409 "document changed" archived it
  // under our feet, or an external delete refetched it away), the popover
  // transitions to an archived state that keeps the editor mounted with the
  // draft intact — user keystrokes are never silently dropped. Saving is then
  // impossible (the id is gone); Cancel closes.
  const [editSession, setEditSession] = useState<Annotation | null>(null);

  // Discarding the controlled draft also exits this popover's local edit mode.
  useLayoutEffect(() => {
    if (editSession && !state.editDrafts[editSession.id]) setEditSession(null);
  }, [editSession, state.editDrafts]);

  const popover = ann.popover;
  const viewed =
    popover?.mode === "view"
      ? (ann.annotations.find((a) => a.id === popover.id) ?? null)
      : null;

  // reset the local edit session whenever the popover targets something else
  const popoverKey = popover
    ? popover.mode === "create"
      ? "create:" + targetBlockId(popover.target)
      : "view:" + popover.id
    : null;
  useEffect(() => {
    setEditSession(null);
  }, [popoverKey]);

  // a viewed annotation that vanished closes the popover — UNLESS an edit is
  // in flight (see the editSession comment)
  useEffect(() => {
    if (popover?.mode === "view" && !editSession && ann.loadState !== "loading" && !viewed) {
      ann.closePopover();
    }
  }, [popover, viewed, editSession, ann]);

  // Escape closes (the editor's own Escape cancels editing and stops propagation)
  useEffect(() => {
    if (!popover) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") ann.closePopover();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [popover, ann]);

  // anchor + follow the target block (mid-edit after archival, keep the
  // session's last known anchor rather than jumping to the reader corner)
  const anchorSource = viewed ?? editSession;
  const anchorId = popover
    ? popover.mode === "create"
      ? targetBlockId(popover.target)
      : anchorSource
        ? targetBlockId(anchorSource.target)
        : null
    : null;
  useLayoutEffect(() => {
    if (!popover) {
      setPos(null);
      return;
    }
    const root = rootRef.current?.closest("main.reader") ?? null;
    const anchorEl = anchorId
      ? (root?.querySelector<HTMLElement>(`[data-block-id="${cssEscape(anchorId)}"]`) ?? null)
      : null;
    const place = () => {
      const rect = (anchorEl ?? root)?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) {
        // no layout (test envs) or detached: park at a sane corner
        setPos({ top: 76, left: Math.max(8, window.innerWidth - POPOVER_W - 16) });
        return;
      }
      const left = anchorEl
        ? Math.min(rect.right + 10, Math.max(8, window.innerWidth - POPOVER_W - 8))
        : Math.max(8, rect.right - POPOVER_W - 12); // document target: reader top-right
      const top = Math.max(8, Math.min(anchorEl ? rect.top : rect.top + 12, window.innerHeight - 120));
      setPos({ top, left });
    };
    place();
    root?.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    return () => {
      root?.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
    };
  }, [popover, anchorId]);

  if (!popover) return null;
  if (popover.mode === "view" && !viewed && !editSession) return null;

  const headLabel =
    popover.mode === "create"
      ? createLabel(popover.target)
      : anchorSource
        ? viewLabel(anchorSource.target)
        : "";

  return (
    <div
      ref={rootRef}
      className="ann-popover view-in" data-ui="latex-annotation-popover"
      // rendered (hidden) before the first measurement so rootRef is available
      style={pos ?? { top: -2000, left: -2000, visibility: "hidden" }}
      role="dialog"
      aria-label={t("annotation.popover.aria")}
    >
      <div className="ann-popover-head">
        <span className="ann-popover-target" title={headLabel}>
          {headLabel}
        </span>
        <button className="btn icon ghost" data-ui="close-latex-annotation" title={t("common.close")} onClick={ann.closePopover}>
          <Icon name="x" cls="ico-sm" />
        </button>
      </div>

      {popover.mode === "create" && (
        <CreateAnnotationEditor target={popover.target} onSaved={ann.openView} onCancel={ann.closePopover} />
      )}

      {popover.mode === "view" && viewed && !editSession && (
        <>
          <div
            className="ann-popover-body plan-md-body" data-ui="latex-annotation-body"
            // single-user tool: the body is the user's own markdown (mdWithMath ruling)
            dangerouslySetInnerHTML={{ __html: mdWithMath(viewed.body) }}
          />
          <div className="ann-popover-foot">
            <button className="ann-editor-btn" data-ui="edit-latex-annotation" disabled={!ann.canAnnotate} onClick={() => { controller.beginEdit(viewed); setEditSession(viewed); }}>
              <Icon name="pencil" cls="ico-sm" />
              {t("common.edit")}
            </button>
            <button
              className="ann-editor-btn danger" data-ui="delete-latex-annotation"
              disabled={ann.busy}
              onClick={() => void ann.removeAnnotation(viewed.id)}
            >
              <Icon name="trash-2" cls="ico-sm" />
              {t("common.delete")}
            </button>
          </div>
        </>
      )}

      {popover.mode === "view" && editSession && (
        <>
          {!viewed && (
            <div className="ann-popover-archived">
              {t("annotation.popover.archived")}
            </div>
          )}
          <EditAnnotationEditor annotation={editSession} onSaved={() => setEditSession(null)} onCancel={() => setEditSession(null)} />
        </>
      )}
    </div>
  );
}

function createLabel(target: AnnotationTarget): string {
  if (target.type === "document") return i18n.t("annotation.action.addDoc");
  if (target.type === "text") return i18n.t("annotation.action.addText");
  return i18n.t("annotation.action.addStructure", { kind: kindLabel(target.kind) }) + (target.snapshot.number ? " " + target.snapshot.number : "");
}

function viewLabel(target: AnnotationTarget): string {
  if (target.type === "document") return i18n.t("annotation.popover.viewDoc");
  if (target.type === "text") return i18n.t("annotation.summary.text");
  return i18n.t("annotation.popover.viewStructure", { kind: kindLabel(target.kind) + (target.snapshot.number ? " " + target.snapshot.number : "") });
}

function cssEscape(s: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(s);
  return s.replace(/["\\]/g, "\\$&");
}
