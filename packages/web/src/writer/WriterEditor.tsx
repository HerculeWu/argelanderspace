/**
 * Stage 10 Writer — the cell editor: topbar (back/title/save state/template/
 * Info/Preamble/Export), collapsible outline (left) and tool panel (right),
 * the cell flow with hover tools and between-cell add rows, add/type menus,
 * caret-aware insertion for \cite keys and labels, debounced autosave through
 * the real REST api (M2b), and client-side single-.tex export (M3 → server
 * zip).
 *
 * Data layer (plans precedent): the whole manuscript is held in state; every
 * edit is an optimistic local update plus a debounced (~800 ms) whole-doc PUT
 * through a serial write chain (rapid edits coalesce into the latest
 * snapshot). Success adopts the response's bumped rev; a 409 adopts the
 * server's current document (the 409 body carries it) and toasts a conflict
 * note; other failures mark the save state `error`. `writer.changed` events
 * for the open id trigger a refetch — deferred (pendingExternal) while a
 * local write/debounce is in flight; deletion of the open doc returns to the
 * list with a note.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../lib/icons";
import {
  defaultCellData,
  writerNumberingForDraft,
  type CellType,
  type WriterManuscript,
  type WriterNumberingResponse,
  type WriterTemplate,
} from "@argelanderspace/contracts";
import {
  exportUrl,
  fetchManuscript,
  fetchNumbering,
  fetchTemplates,
  putManuscript,
  refreshNumbering,
  uploadAsset,
} from "../api/writer";
import { onWriterChanged } from "../api/ws";
import {
  fileSlug,
  newCellId,
  newCommentId,
  randomLabel,
  withEnsuredLabel,
  convertCellData,
} from "./model";
import { CellWrap, TYPE_LABEL_KEY, type CellCtx } from "./cells";
import { OutlinePanel } from "./outline";
import { RightTabs, type RightTab } from "./rightTabs";
import { InfoModal, PreambleModal } from "./modals";
import type { WriterTextTarget } from "./latexSource";

type Menu =
  | { kind: "add"; index: number; x: number; y: number }
  | { kind: "type"; cellId: string; x: number; y: number };

interface Caret {
  cellId: string;
  field: string;
  start: number;
  end: number;
}

export function WriterEditor({
  id,
  onBack,
  onGone,
}: {
  id: string;
  onBack: () => void;
  /** the open manuscript was deleted elsewhere — return to the list */
  onGone: () => void;
}) {
  const { t } = useTranslation();
  // undefined = loading, null = not found
  const [doc, setDoc] = useState<WriterManuscript | null | undefined>(undefined);
  const [templates, setTemplates] = useState<WriterTemplate[] | null>(null);
  const [templateWarnings, setTemplateWarnings] = useState<string[]>([]);
  const [warningsDismissed, setWarningsDismissed] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>("references");
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [modal, setModal] = useState<"info" | "preamble" | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [toast, setToast] = useState<string | null>(null);
  const [numbering, setNumbering] = useState<WriterNumberingResponse | null>(null);
  const [numberingBusy, setNumberingBusy] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const dirtyRef = useRef(false);
  const writeFailed = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);
  const caretRef = useRef<{ cellId: string; field: string; el: WriterTextTarget } | null>(null);
  const pendingCaretRef = useRef<{ cellId: string; field: string; pos: number } | null>(null);

  // ---- write machinery (plans precedent) --------------------------------------
  const docRef = useRef<WriterManuscript | null>(null);
  const writeChain = useRef<Promise<void>>(Promise.resolve());
  const localWrites = useRef(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingExternal = useRef(false);

  const applyDoc = (d: WriterManuscript | null) => {
    docRef.current = d;
    setDoc(d);
  };

  const template =
    doc && templates
      ? templates.find((tp) => tp.id === doc.template)
      : undefined;

  const acceptNumbering = (next: WriterNumberingResponse | null) => {
    if (!next || docRef.current?.id !== id) return;
    setNumbering((prev) => prev?.at && next.at && prev.at > next.at ? prev : next);
  };

  // ---- toast --------------------------------------------------------------------
  const showToast = (msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 1800);
  };
  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  // ---- initial load ---------------------------------------------------------------
  const loadTemplatesNow = async () => {
    const tps = await fetchTemplates();
    if (tps) {
      setTemplates(tps.templates);
      setTemplateWarnings(tps.warnings);
    }
  };
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [d, tps, num] = await Promise.all([fetchManuscript(id), fetchTemplates(), fetchNumbering(id)]);
      if (!alive) return;
      applyDoc(d);
      if (tps) {
        setTemplates(tps.templates);
        setTemplateWarnings(tps.warnings);
      }
      if (num) acceptNumbering(num);
      // I031 (Stage 12): no automatic compile on open — rendering is explicit
      // only (Shift+Enter / Render). Stale/absent caches show the placeholder.
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  /** Refetch the open doc from the server (external change / deferred resync). */
  const refetchDoc = async () => {
    const d = await fetchManuscript(id);
    if (d === null) {
      // a failed refetch keeps the current doc; only treat null as "gone"
      // when we currently hold nothing or the delete was signalled via WS
      if (docRef.current === null || docRef.current === undefined) applyDoc(null);
      return;
    }
    // Do not let a slow external GET overwrite edits made while it was in flight.
    if (writeBusy()) { pendingExternal.current = true; return; }
    const previous = docRef.current;
    if (previous && d.rev < previous.rev) return;
    applyDoc(d);
    writeFailed.current = false;
    setSaveState("saved");
    const latest = await fetchNumbering(id);
    acceptNumbering(latest);
    // I031: external changes mark the preview stale; they never compile.
  };

  // ---- autosave: debounce → serial PUT chain --------------------------------------
  const writeBusy = () => localWrites.current > 0 || saveTimer.current !== undefined || dirtyRef.current;

  const flushSave = (): Promise<void> => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = undefined;
    writeChain.current = writeChain.current.then(async () => {
      const snapshot = docRef.current;
      if (!snapshot || !dirtyRef.current) return;
      dirtyRef.current = false;
      localWrites.current++;
      setSaveState("saving");
      try {
        const res = await putManuscript(snapshot);
        if (res.ok) {
          // adopt the bumped rev; keep newer optimistic edits, if any
          const cur = docRef.current;
          if (cur) applyDoc(cur === snapshot ? res.doc : { ...cur, rev: res.doc.rev });
          writeFailed.current = false;
          setSaveState(dirtyRef.current ? "saving" : "saved");
        } else if (res.conflict) {
          // 409: the server's current doc comes with the response — adopt it
          applyDoc(res.conflict);
          dirtyRef.current = false;
          writeFailed.current = true;
          setSaveState("saved");
          showToast(t("writer.toast.conflict"));
        } else {
          dirtyRef.current = true;
          writeFailed.current = true;
          setSaveState("error");
          showToast(t("writer.toast.saveFailed"));
        }
      } catch {
        dirtyRef.current = true;
        writeFailed.current = true;
        setSaveState("error");
        showToast(t("writer.toast.saveFailed"));
      } finally {
        localWrites.current--;
        if (!writeBusy() && pendingExternal.current) {
          // an external change arrived while we were writing — resync now
          pendingExternal.current = false;
          void refetchDoc();
        }
      }
    });
    return writeChain.current;
  };

  async function requestPreview() {
    if (!dirtyRef.current) writeFailed.current = false;
    setNumberingBusy(true);
    try {
      await flushSave();
      if (dirtyRef.current && !writeFailed.current) await flushSave();
      if (dirtyRef.current || writeFailed.current) return;
      acceptNumbering(await refreshNumbering(id));
    } catch { showToast(t("writer.numbering.refreshFailed")); }
    finally { setNumberingBusy(false); }
  }

  const scheduleSave = () => {
    dirtyRef.current = true;
    setSaveState("saving");
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushSave, 800);
  };
  useEffect(
    () => () => {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    },
    []
  );

  // ---- external sync (writer.changed) ------------------------------------------------
  useEffect(
    () =>
      onWriterChanged((msg) => {
        if (msg.cause === "template" || msg.id === undefined) {
          void loadTemplatesNow();
          // I031: a changed template marks previews stale via draft keys; no auto-compile.
          if (writeBusy()) pendingExternal.current = true;
          else void refetchDoc();
          return;
        }
        if (msg.id !== id) return; // another manuscript — the list refreshes itself
        if (msg.cause === "delete") {
          onGone();
          return;
        }
        // put/external for the open doc: defer while a local write is in flight
        if (msg.cause === "numbering") {
          // numbering facts arrived: just refresh the panel state
          void fetchNumbering(id).then(acceptNumbering);
          return;
        }
        if (writeBusy()) {
          pendingExternal.current = true;
          return;
        }
        void refetchDoc();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id]
  );

  // restore the caret after a programmatic insert re-rendered the field
  useEffect(() => {
    const p = pendingCaretRef.current;
    if (!p) return;
    pendingCaretRef.current = null;
    const tracked = caretRef.current;
    const el = tracked?.cellId === p.cellId && tracked.field === p.field && tracked.el.isConnected
      ? tracked.el
      : rootRef.current?.querySelector<HTMLTextAreaElement>(`[data-cell="${p.cellId}"] [data-field="${p.field}"]`);
    if (el) {
      el.focus();
      el.setSelectionRange(p.pos, p.pos);
    }
  }, [doc]);

  // scroll the cell being edited into view
  useEffect(() => {
    if (!editingId) return;
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-cell="${editingId}"]`);
    if (el && typeof el.scrollIntoView === "function")
      el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [editingId]);

  // close menus on outside mousedown / Escape
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest(".w-menu") && !el.closest(".w-add-cell") && !el.closest(".w-cell-type"))
        setMenu(null);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  if (doc === undefined || templates === null) {
    return (
      <div className="writer-root">
        <div className="w-topbar">
          <button className="btn" onClick={onBack}>
            <Icon name="chevron-left" cls="ico-sm" /> {t("writer.topbar.back")}
          </button>
        </div>
        <div className="w-note w-padded">{t("writer.editor.loading")}</div>
      </div>
    );
  }

  if (!doc || !template) {
    return (
      <div className="writer-root">
        <div className="w-topbar">
          <button className="btn" onClick={onBack}>
            <Icon name="chevron-left" cls="ico-sm" /> {t("writer.topbar.back")}
          </button>
        </div>
        <div className="w-note w-padded">{t("writer.editor.notFound")}</div>
      </div>
    );
  }

  // ---- mutation helpers ------------------------------------------------------
  const mutate = (fn: (draft: WriterManuscript) => void) => {
    const prev = docRef.current;
    if (!prev) return;
    const next = structuredClone(prev);
    fn(next);
    applyDoc(next); // optimistic
    scheduleSave();
  };

  const editCell = (cellId: string) => {
    setEditingId(cellId);
    setActiveId(cellId);
  };
  const commitCell = (cellId: string) => {
    if (editingId === cellId) setEditingId(null);
    void requestPreview();
  };
  const deleteCell = (cellId: string) => {
    mutate((d) => {
      d.cells = d.cells.filter((c) => c.id !== cellId);
    });
    if (activeId === cellId) setActiveId(null);
    if (editingId === cellId) setEditingId(null);
  };
  const createCell = (index: number, type: CellType) => {
    const cellId = newCellId();
    mutate((d) => {
      d.cells.splice(index, 0, { id: cellId, type, data: defaultCellData(type) } as never);
    });
    setActiveId(cellId);
    setEditingId(cellId);
  };
  const convertCell = (cellId: string, type: CellType) => {
    mutate((d) => {
      const i = d.cells.findIndex((c) => c.id === cellId);
      if (i < 0) return;
      const c = d.cells[i]!;
      if (c.type === type) return;
      d.cells[i] = { ...c, type, data: convertCellData(c, type) } as never;
    });
    setEditingId(cellId);
    setActiveId(cellId);
  };

  // ---- caret-aware insertion --------------------------------------------------
  const resolveCaret = (): Caret | null => {
    if (!editingId) return null;
    const c = caretRef.current;
    if (c && c.cellId === editingId && c.el.isConnected) {
      const el = c.el;
      const start = el.selectionStart ?? el.value.length;
      return { cellId: editingId, field: c.field, start, end: el.selectionEnd ?? start };
    }
    const el = rootRef.current?.querySelector<HTMLTextAreaElement>(`[data-cell="${editingId}"] textarea`);
    if (!el) return null;
    return { cellId: editingId, field: el.dataset.field ?? "source", start: el.value.length, end: el.value.length };
  };

  /**
   * Insert `text` into the editing cell at the caret; optionally complete a
   * missing \label on another cell first (single mutation, so the two edits
   * cannot clobber each other).
   */
  const insertText = (text: string, ensureTarget?: string, ensureEnvIndex?: number, ensureSectionIndex?: number) => {
    if (!editingId) {
      showToast(t("writer.toast.noEditingCell"));
      return;
    }
    const caret = resolveCaret();
    if (!caret) {
      showToast(t("writer.toast.noCaret"));
      return;
    }
    mutate((d) => {
      if (ensureTarget) {
        const i = d.cells.findIndex((c) => c.id === ensureTarget);
        if (i >= 0) {
          const before = String(d.cells[i]!.data[caret.field] ?? "");
          d.cells[i] = withEnsuredLabel(d.cells[i]!, text, ensureEnvIndex, ensureSectionIndex);
          const after = String(d.cells[i]!.data[caret.field] ?? "");
          if (ensureTarget === caret.cellId && before !== after) {
            let at = 0;
            while (at < before.length && before[at] === after[at]) at++;
            const delta = after.length - before.length;
            if (caret.start >= at) caret.start += delta;
            if (caret.end >= at) caret.end += delta;
          }
        }
      }
      pendingCaretRef.current = { cellId: caret.cellId, field: caret.field, pos: caret.start + text.length };
      const cell = d.cells.find((c) => c.id === caret.cellId);
      if (!cell) return;
      const data = cell.data as Record<string, unknown>;
      const cur = String(data[caret.field] ?? "");
      data[caret.field] = cur.slice(0, caret.start) + text + cur.slice(caret.end);
    });
    showToast(t("writer.toast.inserted", { text }));
  };

  const onInsertCite = (key: string) => insertText(key);
  const onInsertLabel = (targetCell: string, label: string, envIndex?: number, sectionIndex?: number) =>
    insertText(label || randomLabel(), targetCell, envIndex, sectionIndex);

  // ---- comments / outline / header --------------------------------------------
  const onComment = (cellId: string) => {
    setActiveId(cellId);
    setRightTab("comments");
    setRightCollapsed(false);
  };
  const onAddComment = (cellId: string, body: string) => {
    mutate((d) => {
      d.comments.push({
        id: newCommentId(),
        cell: cellId,
        who: "You",
        body,
        created_at: new Date().toISOString(),
      });
    });
    showToast(t("writer.comments.added"));
  };
  const onJump = (cellId: string) => {
    setActiveId(cellId);
    const el = rootRef.current?.querySelector<HTMLElement>(`[data-cell="${cellId}"]`);
    if (el && typeof el.scrollIntoView === "function")
      el.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const onTemplateChange = (templateId: string) => {
    mutate((d) => {
      d.template = templateId;
    });
    const next = templates.find((tp) => tp.id === templateId);
    const unsupported = doc.cells.filter((c) => !next?.types.includes(c.type)).length;
    showToast(
      unsupported
        ? t("writer.toast.templateUnsupported", { count: unsupported })
        : t("writer.toast.templateSwitched", { label: next?.label ?? templateId }),
    );
  };

  const doExport = async () => {
    // M3: server-assembled zip (manuscript.tex + references.bib + assets);
    // missing bib keys come back in the X-Writer-Bib-Missing header.
    try {
      if (!dirtyRef.current) writeFailed.current = false;
      await flushSave();
      if (dirtyRef.current || writeFailed.current) return;
      const res = await fetch(exportUrl(id));
      if (!res.ok) throw new Error(`export failed: ${res.status}`);
      const missingHeader = res.headers.get("X-Writer-Bib-Missing");
      const missing: string[] = missingHeader
        ? JSON.parse(decodeURIComponent(missingHeader))
        : [];
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${fileSlug(doc.title)}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      const warnings = JSON.parse(decodeURIComponent(res.headers.get("X-Writer-Warnings") ?? "%5B%5D")) as string[];
      if (warnings.length) showToast(t("writer.preview.exportWarnings"));
      else if (missing.length > 0) showToast(t("writer.toast.bibMissing", { count: missing.length }));
      else showToast(t("writer.toast.exported", { file: a.download }));
    } catch {
      showToast(t("writer.toast.exportFailed"));
    }
  };

  const onImageFile = (cellId: string, file: File) => {
    // M2b: real asset upload; the cell stores the returned NAME and the
    // render side serves it via assetUrl (the M1 data-URL mock is gone).
    void uploadAsset(id, file)
      .then((name) => {
        mutate((d) => {
          const cell = d.cells.find((c) => c.id === cellId);
          if (cell) (cell.data as Record<string, unknown>).image = name;
        });
      })
      .catch(() => showToast(t("writer.toast.uploadFailed")));
  };

  // ---- cell context -------------------------------------------------------------
  const currentNumbering = writerNumberingForDraft(numbering, doc, template);
  const ctx: CellCtx = {
    numbering: currentNumbering,
    onJump,
    onCite: () => { setRightTab("references"); setRightCollapsed(false); },
    docId: id,
    activeId,
    editingId,
    onActivate: setActiveId,
    onEdit: editCell,
    onCommit: commitCell,
    onDelete: deleteCell,
    onComment,
    onOpenTypeMenu: (cellId, e) => {
      setMenu({ kind: "type", cellId, x: e.clientX, y: e.clientY });
    },
    onField: (cellId, field, value) => {
      mutate((d) => {
        const cell = d.cells.find((c) => c.id === cellId);
        if (cell) (cell.data as Record<string, unknown>)[field] = value;
      });
      setActiveId(cellId);
    },
    onCaret: (cellId, field, el) => {
      caretRef.current = { cellId, field, el };
      setActiveId(cellId);
    },
    onImageFile,
  };

  const openAddMenu = (index: number, e: React.MouseEvent) =>
    setMenu({ kind: "add", index, x: e.clientX, y: e.clientY });

  const typeMenuTypes: CellType[] = [...new Set([...template.types, "latex" as const])];

  // ---- render -------------------------------------------------------------------
  return (
    <div
      className="writer-root"
      ref={rootRef}
      onKeyDown={(e) => {
        // I031: Shift+Enter outside an editing cell renders the manuscript.
        // Inside form fields / CodeMirror the editors own the key (commit +
        // render), and comment inputs keep Shift+Enter as a plain newline.
        if (e.key !== "Enter" || !e.shiftKey || e.nativeEvent.isComposing || editingId) return;
        if ((e.target as HTMLElement).closest("input, textarea, select, .cm-editor")) return;
        e.preventDefault();
        void requestPreview();
      }}
    >
      <div className="w-topbar">
        <button className="btn icon ghost" title={t("writer.topbar.back")} onClick={() => {
          if (!dirtyRef.current) writeFailed.current = false;
          void flushSave().then(() => { if (!dirtyRef.current && !writeFailed.current) onBack(); });
        }}>
          <Icon name="chevron-left" cls="ico-sm" />
        </button>
        <div className="w-title">
          <strong>{doc.title}</strong>
          <span className="w-save-status">
            {saveState === "saved"
              ? t("writer.topbar.saved")
              : saveState === "saving"
                ? t("writer.topbar.saving")
                : t("writer.topbar.saveError")}
          </span>
        </div>
        <select
          className="w-template-select"
          title={t("writer.topbar.template")}
          value={doc.template}
          onChange={(e) => onTemplateChange(e.target.value)}
        >
          {templates.map((tp) => (
            <option key={tp.id} value={tp.id}>
              {tp.label}
            </option>
          ))}
        </select>
        <button className="btn w-hide-narrow" onClick={() => setModal("info")}>
          {t("writer.topbar.info")}
        </button>
        <button className="btn w-hide-narrow" onClick={() => setModal("preamble")}>
          {t("writer.topbar.preamble")}
        </button>
        <button
          className="btn primary"
          data-render-button
          disabled={numberingBusy}
          onClick={() => void requestPreview()}
        >
          <Icon name="refresh-cw" cls={numberingBusy ? "ico-sm spin" : "ico-sm"} /> {t("writer.topbar.render")}
        </button>
        <button className="btn primary" onClick={doExport}>
          <Icon name="file-down" cls="ico-sm" /> {t("writer.topbar.export")}
        </button>
      </div>

      {templateWarnings.length > 0 && !warningsDismissed && (
        <div className="w-note w-padded w-warnings">
          <span>{t("writer.editor.templateWarnings", { warnings: templateWarnings.join("; ") })}</span>
          <button className="btn icon ghost" onClick={() => setWarningsDismissed(true)}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
      )}

      {(currentNumbering?.lastError || currentNumbering?.preview?.warnings.length) ? (
        <details className="w-preview-diagnostics">
          <summary>{currentNumbering.lastError ? t("writer.preview.failed") : t("writer.preview.warnings")}</summary>
          <pre>{[currentNumbering.lastError, ...(currentNumbering.preview?.warnings ?? [])].filter(Boolean).join("\n")}</pre>
        </details>
      ) : null}
      <div className="w-main">
        <aside className={"w-side left" + (leftCollapsed ? " collapsed" : "")}>
          <button
            className="w-panel-toggle"
            onClick={() => setLeftCollapsed((v) => !v)}
            title={t("writer.outline.title")}
          >
            <Icon name={leftCollapsed ? "panel-left-open" : "panel-left-close"} cls="ico-sm" />
          </button>
          <span className="w-rail-label">{t("writer.outline.title")}</span>
          {!leftCollapsed && (
            <OutlinePanel
              cells={doc.cells}
              numbering={currentNumbering}
              onJump={onJump}
              onInsertLabel={onInsertLabel}
            />
          )}
        </aside>

        <div className="w-reader-col">
          <div className="w-reader-scroll">
            <main className="w-paper">
              <div className="w-paper-header">
                <div className="w-template-chip">{template.chip}</div>
                <div className="w-paper-title">{doc.title}</div>
                <div className="w-paper-authors">
                  {doc.authors.map((a, i) => (
                    <span key={i}>
                      {i > 0 && " · "}
                      {a.name}
                      <sup>{a.aff}</sup>
                    </span>
                  ))}
                </div>
                <div className="w-paper-affil">
                  {doc.affiliations.filter(Boolean).map((a, i) => (
                    <span key={i}>
                      {i > 0 && " · "}
                      {i + 1} {a}
                    </span>
                  ))}
                </div>
              </div>
              <div className="w-cells">
                {doc.cells.length === 0 && (
                  <div className="w-cells-empty">
                    <p>{t("writer.editor.emptyCells")}</p>
                    <div className="w-add-row">
                      <button
                        className="w-add-cell"
                        data-add-index={0}
                        title={t("writer.cell.addCell")}
                        onClick={(e) => openAddMenu(0, e)}
                      >
                        <Icon name="plus" cls="ico-sm" />
                      </button>
                    </div>
                  </div>
                )}
                {doc.cells.map((cell, idx) => (
                  <div key={cell.id} className="w-cell-block">
                    <CellWrap
                      cell={cell}
                      cells={doc.cells}
                      supported={template.types.includes(cell.type)}
                      ctx={ctx}
                    />
                    <div className="w-add-row">
                      <button
                        className="w-add-cell"
                        data-add-index={idx + 1}
                        title={t("writer.cell.addCell")}
                        onClick={(e) => openAddMenu(idx + 1, e)}
                      >
                        <Icon name="plus" cls="ico-sm" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </main>
          </div>
        </div>

        <aside className={"w-side right" + (rightCollapsed ? " collapsed" : "")}>
          <button
            className="w-panel-toggle"
            onClick={() => setRightCollapsed((v) => !v)}
            title={t("writer.tabs.references")}
          >
            <Icon name={rightCollapsed ? "panel-right-open" : "panel-right-close"} cls="ico-sm" />
          </button>
          <span className="w-rail-label">{t("writer.tabs.references")}</span>
          {!rightCollapsed && (
            <RightTabs
              doc={doc}
              numbering={currentNumbering}
              tab={rightTab}
              onTab={setRightTab}
              activeId={activeId}
              onInsertCite={onInsertCite}
              onInsertLabel={onInsertLabel}
              onAddComment={onAddComment}
            />
          )}
        </aside>
      </div>

      {menu?.kind === "add" && (
        <div className="w-menu" style={{ left: menu.x, top: menu.y }}>
          {template.types.map((tp) => (
            <button
              key={tp}
              className="w-menu-item"
              data-new-type={tp}
              onClick={() => {
                createCell(menu.index, tp);
                setMenu(null);
              }}
            >
              {t(TYPE_LABEL_KEY[tp])}
            </button>
          ))}
        </div>
      )}
      {menu?.kind === "type" && (
        <div className="w-menu" style={{ left: menu.x, top: menu.y }}>
          {typeMenuTypes.map((tp) => (
            <button
              key={tp}
              className="w-menu-item"
              data-type={tp}
              onClick={() => {
                convertCell(menu.cellId, tp);
                setMenu(null);
              }}
            >
              {t(TYPE_LABEL_KEY[tp])}
            </button>
          ))}
          <div className="w-menu-sep" />
          <button
            className="w-menu-item w-menu-danger"
            onClick={() => {
              deleteCell(menu.cellId);
              setMenu(null);
            }}
          >
            <Icon name="x" cls="ico-sm" /> {t("writer.cell.deleteCell")}
          </button>
        </div>
      )}

      {modal === "info" && (
        <InfoModal
          doc={doc}
          template={template}
          onClose={() => setModal(null)}
          onSave={(v) => {
            mutate((d) => {
              d.title = v.title;
              d.authors = v.authors;
              d.affiliations = v.affiliations;
              d.infoValues = v.infoValues;
            });
            setModal(null);
          }}
        />
      )}
      {modal === "preamble" && (
        <PreambleModal
          template={template}
          userPreamble={doc.userPreamble}
          onClose={() => setModal(null)}
          onSave={(userPreamble) => {
            mutate((d) => {
              d.userPreamble = userPreamble;
            });
            setModal(null);
          }}
        />
      )}

      {toast && <div className="w-toast">{toast}</div>}
    </div>
  );
}
