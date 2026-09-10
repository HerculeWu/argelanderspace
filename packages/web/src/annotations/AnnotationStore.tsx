import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Annotation, AnnotationsFile, AnnotationTarget } from "@argelanderspace/contracts";
import { fetchAnnotations, putAnnotations } from "../api/annotations";
import { onAnnotationChanged } from "../api/ws";
import { useStore } from "../store";
import { buildStructureTarget, newAnnotationId, targetBlockId, withAssetHash } from "./model";

// The reader's annotation state (Stage 8 MS3): one provider per doc pane,
// mounted inside StoreProvider (which DocPane keys by docId, so switching docs
// remounts and resets everything). Holds the whole AnnotationsFile (the PUT
// is a whole-file replace echoing fingerprint+rev, roadmap §5), the active
// annotation, and the popover target. Loads on mount; refetches when the
// server broadcasts `annotation.changed` for THIS doc (another client's PUT,
// an invalidation archive, or the watcher spotting an external write — a 404
// refetch means the doc was deleted externally and clears gracefully).

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

const NOTICE_MS = 4000;

export function AnnotationProvider({ children }: { children: React.ReactNode }) {
  const store = useStore();
  const docId = store.docId;

  const [loadState, setLoadState] = useState<AnnotationLoadState>("loading");
  const [file, setFile] = useState<AnnotationsFile | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [popover, setPopover] = useState<AnnotationPopoverState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chooser, setChooser] = useState<{ ids: string[]; x: number; y: number } | null>(null);
  const fileRef = useRef<AnnotationsFile | null>(null);
  fileRef.current = file;
  // Ref mirror of `popover` (same fileRef/busyRef pattern): persist() must know
  // synchronously whether the open create popover carries a TEXT target — its
  // offsets belong to the dying fingerprint epoch and decide the toast wording.
  const popoverRef = useRef<AnnotationPopoverState | null>(null);
  popoverRef.current = popover;
  const noticeTimer = useRef<number | undefined>(undefined);
  // Ref mirror of `busy`: the double-submit guard must work within the same
  // tick (a second click can land before the state update re-renders the
  // disabled save button).
  const busyRef = useRef(false);
  const setBusyBoth = useCallback((v: boolean) => {
    busyRef.current = v;
    setBusy(v);
  }, []);

  const showNotice = useCallback((text: string) => {
    window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  // don't let a pending notice timer fire after the provider unmounts
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const load = useCallback(async () => {
    const r = await fetchAnnotations(docId);
    if (r.ok) {
      setFile(r.file);
      setLoadState("ok");
    } else if (r.missing) {
      // doc deleted externally (the watcher fires "external" for the removed
      // current.json): clear, never error
      setFile(null);
      setLoadState("missing");
    } else {
      setFile(null);
      setLoadState("error");
    }
  }, [docId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      onAnnotationChanged((changed) => {
        if (changed === docId) void load();
      }),
    [docId, load]
  );

  /** The single write path: whole-file PUT with the two 409 UX flows (§5). */
  const persist = useCallback(
    async (next: AnnotationsFile): Promise<boolean> => {
      setBusyBoth(true);
      const r = await putAnnotations(docId, next);
      setBusyBoth(false);
      if (r.ok) {
        setFile(r.file);
        return true;
      }
      if (r.kind === "document-changed") {
        // old epoch archived server-side; the response carries the fresh file
        setFile(r.file);
        // An open CREATE popover's target snapshot was built from the
        // pre-change content: rebuild it from the store's current IR so a
        // retry annotates what is on screen. If the anchor block is gone from
        // the displayed IR the create popover closes instead (its draft could
        // no longer anchor anywhere — the toast explains why). View/edit
        // popovers are reconciled by AnnotationPopover (a vanished annotation
        // closes the view; an in-progress edit keeps its draft).
        //
        // MS4: an open TEXT create can never be rebuilt — its offsets/quote
        // address the dead epoch's canonical text, and target immutability
        // forbids substituting a different target type. Close the popover
        // (the block-gone precedent) and say so in the toast.
        const closingTextCreate =
          popoverRef.current?.mode === "create" && popoverRef.current.target.type === "text";
        setPopover((p) => {
          if (p?.mode !== "create") return p;
          if (p.target.type === "text") return null;
          const bid = targetBlockId(p.target);
          if (bid === null) return p; // document target: nothing to rebuild
          const node = store.blockById.get(bid);
          if (!node) return null;
          return { ...p, target: buildStructureTarget(node) };
        });
        showNotice(
          closingTextCreate
            ? "文档内容已变化，旧标注已归档；请重新选择文本"
            : "文档内容已变化，旧标注已归档"
        );
        return false;
      }
      if (r.kind === "rev-mismatch") {
        await load();
        showNotice("标注已在其他位置更新，已重新载入");
        return false;
      }
      // 500 / network: show the error, preserve the current UI
      showNotice(`标注保存失败：${r.detail}`);
      return false;
    },
    [docId, load, showNotice, store, setBusyBoth]
  );

  const createAnnotation = useCallback(
    async (target: AnnotationTarget, body: string): Promise<string | null> => {
      const cur = fileRef.current;
      if (!cur || body.trim() === "" || busyRef.current) return null;
      // busy BEFORE the (async) asset-hash fetch: no double-submit window
      setBusyBoth(true);
      try {
        const now = new Date().toISOString();
        const annotation: Annotation = {
          id: newAnnotationId(),
          target: await withAssetHash(docId, store.blockById, target),
          body,
          created_at: now,
          updated_at: now,
        };
        const ok = await persist({ ...cur, annotations: [...cur.annotations, annotation] });
        if (!ok) return null;
        setActiveId(annotation.id);
        return annotation.id;
      } finally {
        setBusyBoth(false);
      }
    },
    [docId, store, persist, setBusyBoth]
  );

  const updateBody = useCallback(
    async (id: string, body: string): Promise<boolean> => {
      const cur = fileRef.current;
      if (!cur || body.trim() === "" || busyRef.current) return false;
      const current = cur.annotations.find((a) => a.id === id);
      if (!current) return false;
      if (current.body === body) return true; // no byte change: no PUT, updated_at untouched
      const now = new Date().toISOString();
      return persist({
        ...cur,
        annotations: cur.annotations.map((a) =>
          a.id === id ? { ...a, body, updated_at: now } : a
        ),
      });
    },
    [persist]
  );

  const removeAnnotation = useCallback(
    async (id: string): Promise<boolean> => {
      const cur = fileRef.current;
      if (!cur || busyRef.current) return false;
      const ok = await persist({
        ...cur,
        annotations: cur.annotations.filter((a) => a.id !== id),
      });
      if (ok) {
        setPopover((p) => (p?.mode === "view" && p.id === id ? null : p));
        setActiveId((a) => (a === id ? null : a));
      }
      return ok;
    },
    [persist]
  );

  const openCreate = useCallback((target: AnnotationTarget) => {
    setActiveId(null);
    setPopover({ mode: "create", target });
  }, []);

  const openView = useCallback((id: string) => {
    setActiveId(id);
    // idempotent: re-viewing the same annotation keeps the popover object
    // identity, so effect chains keyed on the annotations value settle
    setPopover((p) => (p?.mode === "view" && p.id === id ? p : { mode: "view", id }));
  }, []);

  const closePopover = useCallback(() => {
    setPopover(null);
    setActiveId(null);
  }, []);

  const openChooser = useCallback((ids: string[], x: number, y: number) => {
    setChooser({ ids, x, y });
  }, []);

  const closeChooser = useCallback(() => setChooser(null), []);

  const value = useMemo<AnnotationsValue>(() => {
    const annotations = file?.annotations ?? [];
    const byBlock = new Map<string, Annotation[]>();
    for (const a of annotations) {
      const bid = targetBlockId(a.target);
      if (bid === null) continue;
      const list = byBlock.get(bid);
      if (list) list.push(a);
      else byBlock.set(bid, [a]);
    }
    return {
      loadState,
      file,
      annotations,
      byBlock,
      activeId,
      popover,
      notice,
      busy,
      chooser,
      reload: load,
      activate: setActiveId,
      openCreate,
      openView,
      closePopover,
      dismissNotice: () => {
        window.clearTimeout(noticeTimer.current);
        setNotice(null);
      },
      notify: showNotice,
      openChooser,
      closeChooser,
      createAnnotation,
      updateBody,
      removeAnnotation,
    };
  }, [
    loadState,
    file,
    activeId,
    popover,
    notice,
    busy,
    chooser,
    load,
    openCreate,
    openView,
    closePopover,
    showNotice,
    openChooser,
    closeChooser,
    createAnnotation,
    updateBody,
    removeAnnotation,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
