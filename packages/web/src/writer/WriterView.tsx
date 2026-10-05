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
import { captureListPage, type WriterEditorPage } from "./writer-context";

export interface WriterViewController {
  /** Resolves after the pane did (or could not do) what the action says; never before the editor shows it. */
  apply(action: WriterViewAction): Promise<{ ok: boolean; detail?: "not_found" | "unavailable" | "leave_blocked" }>;
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
        return (await settle(() => openIdRef.current === wanted && editorRef.current?.manuscriptId === wanted && editorRef.current.phase === "ready")) ? { ok: true } : { ok: false, detail: "unavailable" };
      },
    });
    return () => onController(paneId, null);
  }, [paneId, onController]);

  if (!openId)
    return (
      <ManuscriptList
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
      onBack={() => { setOpenId(null); setEditorPage(null); }}
      onGone={() => {
        setOpenId(null);
        setEditorPage(null);
        setNotice(t("writer.list.deletedElsewhere"));
      }}
    />
  );
}
