/**
 * Stage 10 Writer — pane view: manuscript list ↔ editor. Each pane keeps its
 * own open-manuscript state (panes are independent views, shell precedent).
 * M2b: deleting the open doc elsewhere (WS) returns to the list with a note.
 *
 * Copilot (ticket 22): the pane reports its page (the list, or the open manuscript with its saved content and unsaved
 * draft) and offers the two navigation controls an agent may press: open a manuscript and the editor's back button.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WriterPage, WriterViewAction } from "@argelanderspace/contracts";
import { probeManuscript } from "../api/writer";
import { ManuscriptList } from "./ManuscriptList";
import { WriterEditor } from "./WriterEditor";
import { captureListPage, type WriterEditorControls, type WriterEditorPage } from "./writer-context";

export interface WriterViewController {
  /** Resolves after the pane did (or could not do) what the action says; never before the editor shows it. */
  apply(action: WriterViewAction): Promise<{ ok: boolean; detail?: "not_found" | "unavailable" | "leave_blocked" | "disabled" | "failed" }>;
}

export function WriterView({ paneId, onContext, onController }: { paneId?: number; onContext?: (paneId: number, page: WriterPage | null) => void; onController?: (paneId: number, controller: WriterViewController | null) => void } = {}) {
  const { t } = useTranslation();
  const [openId, setOpenId] = useState<string | null>(null);
  // bumping the key remounts the editor when the same id is re-opened
  const [session, setSession] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [listData, setListData] = useState<Parameters<typeof captureListPage>[0]>({ phase: "loading", rows: [], templates: [] });
  const [editorPage, setEditorPage] = useState<WriterEditorPage | null>(null);
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const editorRef = useRef(editorPage);
  editorRef.current = editorPage;
  const leaveRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerLeave = useCallback((leave: (() => Promise<boolean>) | null) => { leaveRef.current = leave; }, []);
  // The open editor's own controls (the cell clicks, panel folds, tabs, warning close, Export) and the list's Retry.
  const controlsRef = useRef<WriterEditorControls | null>(null);
  const registerControls = useCallback((controls: WriterEditorControls | null) => { controlsRef.current = controls; }, []);
  const retryRef = useRef<(() => Promise<"ok" | "disabled" | "failed">) | null>(null);
  const registerRetry = useCallback((retry: (() => Promise<"ok" | "disabled" | "failed">) | null) => { retryRef.current = retry; }, []);

  // The page this pane reports: the list while it shows, else the open manuscript (loading until its editor reports).
  useEffect(() => {
    if (paneId === undefined || !onContext) return;
    const page: WriterPage = openId
      ? { mode: "editor", list: null, editor: editorPage && editorPage.manuscriptId === openId ? editorPage : { manuscriptId: openId as never, phase: "loading", saved: null, saveState: "saved", draft: null, template: null, unsupportedCellIds: [], activeCellId: null, editingCellId: null, caret: null, modal: null, preview: { status: "unknown", failed: false, warnings: 0, rendering: false } } }
      : captureListPage(listData);
    onContext(paneId, page);
  }, [paneId, onContext, openId, editorPage, listData]);
  useEffect(() => () => { if (paneId !== undefined) onContext?.(paneId, null); }, [paneId, onContext]);

  const settle = async (done: () => boolean, ms = 4000) => {
    for (let waited = 0; waited < ms && !done(); waited += 50) await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    return done();
  };
  useEffect(() => {
    if (paneId === undefined || !onController) return;
    onController(paneId, {
      async apply(action) {
        if (action.action === "close_manuscript") {
          if (!openIdRef.current) return { ok: true };
          if (!(await leaveRef.current?.())) return { ok: false, detail: "leave_blocked" };
          setOpenId(null);
          setEditorPage(null);
          return (await settle(() => openIdRef.current === null)) ? { ok: true } : { ok: false, detail: "unavailable" };
        }
        if (action.action === "retry_manuscript_list") {
          if (openIdRef.current || !retryRef.current) return { ok: false, detail: "unavailable" };
          const outcome = await retryRef.current();
          return outcome === "ok" ? { ok: true } : { ok: false, detail: outcome };
        }
        if (action.action !== "open_manuscript") {
          // The editor's own controls act on the manuscript that is open; another one (or none) is not this page.
          const controls = controlsRef.current;
          if ("manuscriptId" in action && openIdRef.current !== action.manuscriptId) return { ok: false, detail: "unavailable" };
          if (!openIdRef.current || !controls) return { ok: false, detail: "unavailable" };
          if (action.action === "select_cell") return controls.select(action.cellId) === "ok" ? { ok: true } : { ok: false, detail: "not_found" };
          if (action.action === "edit_cell") return controls.edit(action.cellId) === "ok" ? { ok: true } : { ok: false, detail: "not_found" };
          if (action.action === "commit_cell") {
            const committed = await controls.commit(action.cellId);
            return committed === "ok" ? { ok: true } : { ok: false, detail: committed === "refused" ? "disabled" : "not_found" };
          }
          if (action.action === "set_writer_panel") { controls.setPanel(action.panel, action.collapsed); return { ok: true }; }
          if (action.action === "set_writer_tab") { controls.setTab(action.tab); return { ok: true }; }
          if (action.action === "dismiss_template_warning") return controls.dismissWarning() === "ok" ? { ok: true } : { ok: false, detail: "disabled" };
          const exported = await controls.exportNow();
          return exported === "ok" ? { ok: true } : { ok: false, detail: exported === "blocked" ? "leave_blocked" : "failed" };
        }
        const wanted = action.manuscriptId;
        if (openIdRef.current === wanted) return { ok: true };
        // The row exists only if the server has it; another open editor is left through its own back button first.
        const found = await probeManuscript(wanted);
        if (found === "missing") return { ok: false, detail: "not_found" };
        if (found === "error") return { ok: false, detail: "unavailable" };
        if (openIdRef.current && !(await leaveRef.current?.())) return { ok: false, detail: "leave_blocked" };
        setNotice(null);
        setEditorPage(null);
        setSession((s) => s + 1);
        setOpenId(wanted);
        return (await settle(() => openIdRef.current === wanted && editorRef.current?.manuscriptId === wanted && editorRef.current?.phase === "ready")) ? { ok: true } : { ok: false, detail: "unavailable" };
      },
    });
    return () => onController(paneId, null);
  }, [paneId, onController]);

  if (!openId)
    return (
      <ManuscriptList
        registerRetry={registerRetry}
        notice={notice}
        onData={setListData}
        onOpen={(id) => {
          setNotice(null);
          setSession((s) => s + 1);
          setOpenId(id);
        }}
      />
    );
  return (
    <WriterEditor
      key={`${openId}:${session}`}
      id={openId}
      onPage={setEditorPage}
      registerLeave={registerLeave}
      registerControls={registerControls}
      onBack={() => { setOpenId(null); setEditorPage(null); }}
      onGone={() => {
        setOpenId(null);
        setEditorPage(null);
        setNotice(t("writer.list.deletedElsewhere"));
      }}
    />
  );
}
