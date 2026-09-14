import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Annotation, AnnotationsFile, AnnotationTarget } from "@argelanderspace/contracts";
import { useStore } from "../store";
import { useReaderSession } from "../doc/ReaderSession";
import { newAnnotationId, targetBlockId, withAssetHash } from "./model";

export type AnnotationLoadState = "loading" | "ok" | "missing" | "error";

export type AnnotationPopoverState =
  | { mode: "create"; target: AnnotationTarget }
  | { mode: "view"; id: string };

export interface AnnotationsValue {
  loadState: AnnotationLoadState;
  /** The current file (null until loaded / after an external doc delete). */
  file: AnnotationsFile | null;
  annotations: Annotation[];
  /** Block id → its annotations (structure + text targets; MS4 adds text). */
  byBlock: Map<string, Annotation[]>;
  /** The annotation with raised visual priority (popover open / list click). */
  activeId: string | null;
  popover: AnnotationPopoverState | null;
  /** Transient toast text (409 reloads, save failures); auto-dismisses. */
  notice: string | null;
  /** A PUT is in flight (editors disable their save button). */
  busy: boolean;
  canAnnotate: boolean;
  /** Multi-hit chooser (Stage 8 MS4): overlapping text annotations at a click
   *  point / a block's gutter count marker, positioned in viewport coords. */
  chooser: { ids: string[]; x: number; y: number } | null;
  reload: () => Promise<void>;
  activate: (id: string | null) => void;
  openCreate: (target: AnnotationTarget) => void;
  openView: (id: string) => void;
  closePopover: () => void;
  dismissNotice: () => void;
  /** Show a transient toast from outside the persist path (MS4 selection
   *  rejections: cross-container / unsupported position). */
  notify: (text: string) => void;
  openChooser: (ids: string[], x: number, y: number) => void;
  closeChooser: () => void;
  /** Create with an immutable target (+snapshot); body stored as raw bytes.
   *  Returns the new annotation's id on success, null otherwise. */
  createAnnotation: (target: AnnotationTarget, body: string) => Promise<string | null>;
  /** Body-only edit (target/snapshot/created_at are immutable). `updated_at`
   *  bumps only when the body bytes actually change; a trim-empty body or an
   *  unchanged one is rejected/skipped client-side. */
  updateBody: (id: string, body: string) => Promise<boolean>;
  removeAnnotation: (id: string) => Promise<boolean>;
}

const Ctx = createContext<AnnotationsValue | null>(null);
export function useAnnotations(): AnnotationsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAnnotations outside provider");
  return v;
}

/** UI-only state. ReaderSession is the sole owner of files and writes. */
export function AnnotationProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const { state, controller, canAnnotate } = useReaderSession();
  const file = state.accepted?.file ?? null;
  const generation = state.generation;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [popover, setPopover] = useState<AnnotationPopoverState | null>(null);
  const [chooser, setChooser] = useState<AnnotationsValue["chooser"]>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number>();
  const mounted = useRef(true);
  const notify = (text: string) => {
    if (!mounted.current) return;
    window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      window.clearTimeout(noticeTimer.current);
    };
  }, []);
  useLayoutEffect(() => {
    setActiveId(null);
    setPopover(null);
    setChooser(null);
    window.getSelection()?.removeAllRanges();
  }, [generation]);

  const value = useMemo<AnnotationsValue>(() => {
    const annotations = state.phase === "ready" ? (file?.annotations ?? []) : [];
    const byBlock = new Map<string, Annotation[]>();
    for (const a of canAnnotate ? annotations : []) {
      const bid = targetBlockId(a.target);
      if (bid !== null) byBlock.set(bid, [...(byBlock.get(bid) ?? []), a]);
    }
    const persist = async (next: AnnotationsFile) => {
      const ok = await controller.persist(next, generation);
      if (!ok) {
        const failure = controller.getSnapshot().writeFailure;
        notify(
          failure === "document-changed"
            ? "文档内容已变化，旧标注已归档；" +
                (popover?.mode === "create" && popover.target.type === "text"
                  ? "请重新选择文本"
                  : "请重新选择目标")
            : failure === "rev-mismatch"
              ? "标注已在其他位置更新，请等待同步"
              : "标注保存失败；草稿已保留，请手动重试"
        );
      }
      return ok;
    };
    return {
      file,
      annotations,
      byBlock,
      canAnnotate,
      loadState:
        state.phase === "ready"
          ? "ok"
          : state.phase === "missing"
            ? "missing"
            : state.phase === "error"
              ? "error"
              : "loading",
      busy: state.writePending || !canAnnotate,
      activeId: canAnnotate ? activeId : null,
      popover: state.phase === "ready" ? popover : null,
      chooser: canAnnotate ? chooser : null,
      notice,
      reload: async () => controller.retry(),
      activate: (id) => {
        if (controller.canAnnotate()) setActiveId(id);
      },
      openCreate: (target) => {
        if (!controller.canAnnotate()) return;
        controller.beginCreate();
        setActiveId(null);
        setPopover({ mode: "create", target });
      },
      openView: (id) => {
        if (
          !controller.canAnnotate() ||
          !controller.getSnapshot().accepted?.file.annotations.some((a) => a.id === id)
        )
          return;
        setActiveId(id);
        setPopover((p) => (p?.mode === "view" && p.id === id ? p : { mode: "view", id }));
      },
      closePopover: () => {
        setPopover(null);
        setActiveId(null);
      },
      dismissNotice: () => {
        window.clearTimeout(noticeTimer.current);
        setNotice(null);
      },
      notify,
      openChooser: (ids, x, y) => {
        if (controller.canAnnotate()) setChooser({ ids, x, y });
      },
      closeChooser: () => setChooser(null),
      createAnnotation: async (target, body) => {
        if (
          !file ||
          !controller.canAnnotate() ||
          generation !== controller.getSnapshot().generation ||
          !body.trim()
        )
          return null;
        const draft = controller.getSnapshot().createDraft;
        const now = new Date().toISOString();
        const a: Annotation = {
          id: newAnnotationId(),
          target: withAssetHash(state.accepted!.assets, store.blockById, target),
          body,
          created_at: now,
          updated_at: now,
        };
        const ok = await persist({ ...file, annotations: [...file.annotations, a] });
        if (!ok) return null;
        controller.clearCreate(draft.revision);
        if (controller.canAnnotate() && controller.getSnapshot().generation === generation)
          setActiveId(a.id);
        return a.id;
      },
      updateBody: async (id, body) => {
        if (
          !file ||
          !controller.canAnnotate() ||
          generation !== controller.getSnapshot().generation ||
          !body.trim()
        )
          return false;
        const d = controller.getSnapshot().editDrafts[id];
        if (d && (d.blocked || d.sourceFingerprint !== file.content_fingerprint)) return false;
        const a = file.annotations.find((a) => a.id === id);
        if (!a) return false;
        const ok =
          a.body === body ||
          (await persist({
            ...file,
            annotations: file.annotations.map((a) =>
              a.id === id ? { ...a, body, updated_at: new Date().toISOString() } : a
            ),
          }));
        if (ok && d) controller.acknowledgeEdit(id, d.revision, body);
        return ok;
      },
      removeAnnotation: async (id) => {
        if (
          !file ||
          !controller.canAnnotate() ||
          generation !== controller.getSnapshot().generation
        )
          return false;
        const ok = await persist({
          ...file,
          annotations: file.annotations.filter((a) => a.id !== id),
        });
        if (ok) {
          setPopover((p) => (p?.mode === "view" && p.id === id ? null : p));
          setActiveId((a) => (a === id ? null : a));
        }
        return ok;
      },
    };
  }, [file, state, controller, canAnnotate, generation, store, activeId, popover, chooser, notice]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
