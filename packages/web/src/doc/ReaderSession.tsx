import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  Annotation,
  AnnotationsFile,
  CoherentAnnotationsRead,
} from "@argelanderspace/contracts";
import { fetchCoherentAnnotations, putAnnotations } from "../api/annotations";
import { onAnnotationChanged, onLibraryChanged } from "../api/ws";

export interface EditDraft {
  annotationId: string;
  sourceFingerprint: string;
  originalBody: string;
  body: string;
  revision: number;
  blocked: boolean;
}
export interface ReaderSessionState {
  phase: "initial" | "ready" | "syncing" | "error" | "missing";
  accepted: CoherentAnnotationsRead | null;
  generation: number;
  writePending: boolean;
  writeFailure?: "document-changed" | "rev-mismatch" | "busy" | "error";
  reason?: "busy" | "read" | "asset" | "document-changed";
  createDraft: { body: string; revision: number; use: boolean };
  editDrafts: Record<string, EditDraft>;
}
export interface AssetBinding {
  docId: string;
  generation: number;
  imgPath: string;
  sha256: string;
}

/** One doc's authority: GET/PUT serialization, display binding and the shared
 * asset episode budget. A notification is invalidation, never version proof. */
export class ReaderSessionController {
  private state: ReaderSessionState = {
    phase: "initial",
    accepted: null,
    generation: 0,
    writePending: false,
    createDraft: { body: "", revision: 0, use: false },
    editDrafts: {},
  };
  private listeners = new Set<() => void>();
  private alive = false;
  private serial = 0;
  private lifecycle = 0;
  private reading: AbortController | null = null;
  private dirty = false;
  private terminal = false;
  private assetSpent = false;
  private draftRevision = 0;
  private invalidationListeners = new Set<() => void>();
  constructor(readonly docId: string) {}
  getSnapshot = () => this.state;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  onInvalidate = (fn: () => void) => {
    this.invalidationListeners.add(fn);
    return () => {
      this.invalidationListeners.delete(fn);
    };
  };
  private patch(next: Partial<ReaderSessionState>) {
    this.state = { ...this.state, ...next };
    for (const fn of this.listeners) fn();
  }
  start = () => {
    this.lifecycle++;
    this.alive = true;
    this.retry();
  };
  stop = () => {
    this.alive = false;
    this.lifecycle++;
    this.serial++;
    this.reading?.abort();
    this.reading = null;
    for (const fn of this.invalidationListeners) fn();
  };
  canAnnotate = () =>
    this.alive &&
    this.state.phase === "ready" &&
    !this.state.writePending &&
    !this.reading &&
    !this.dirty;
  private freeze(reason?: ReaderSessionState["reason"]) {
    this.state = {
      ...this.state,
      phase: "syncing",
      reason,
      generation: this.state.generation + 1,
      createDraft: { ...this.state.createDraft, use: false },
    };
    for (const fn of this.invalidationListeners) fn();
    for (const fn of this.listeners) fn();
  }
  private fail(reason: ReaderSessionState["reason"]) {
    this.terminal = true;
    this.dirty = false;
    this.serial++;
    this.reading?.abort();
    this.reading = null;
    this.freeze(reason);
    this.patch({ phase: "error" });
  }
  requestSync = () => {
    if (!this.alive || this.terminal) return;
    if (this.assetSpent) {
      this.fail("asset");
      return;
    }
    this.freeze();
    this.dirty = true;
    if (!this.reading && !this.state.writePending) void this.read();
  };
  retry = () => {
    if (!this.alive) return;
    this.serial++;
    this.reading?.abort();
    this.reading = null;
    this.terminal = false;
    this.assetSpent = false;
    this.dirty = true;
    this.freeze();
    if (!this.state.writePending) void this.read();
  };
  private async read() {
    if (!this.alive || this.terminal || this.reading || this.state.writePending) return;
    this.dirty = false;
    const requestId = ++this.serial;
    const abort = new AbortController();
    this.reading = abort;
    const r = await fetchCoherentAnnotations(this.docId, abort.signal);
    if (!this.alive || requestId !== this.serial || this.terminal) return;
    this.reading = null;
    if (!r.ok) {
      if (r.status === 404) {
        this.terminal = true;
        this.dirty = false;
        this.patch({ phase: "missing" });
      } else if (r.busy && !this.assetSpent) {
        this.dirty = false;
        this.patch({ phase: "syncing", reason: "busy" });
      } else this.fail(this.assetSpent ? "asset" : "read");
      return;
    }
    if (this.dirty) {
      void this.read();
      return;
    }
    const editDrafts = { ...this.state.editDrafts };
    for (const [id, d] of Object.entries(editDrafts)) {
      const a = r.value.file.annotations.find((a) => a.id === id);
      editDrafts[id] = {
        ...d,
        blocked:
          d.blocked ||
          d.sourceFingerprint !== r.value.file.content_fingerprint ||
          !a ||
          a.body !== d.originalBody,
      };
    }
    this.patch({
      accepted: r.value,
      phase: "ready",
      reason: undefined,
      editDrafts,
      generation: this.state.generation + 1,
    });
  }
  isCurrentAsset = (b: AssetBinding) =>
    this.alive &&
    this.state.phase === "ready" &&
    b.docId === this.docId &&
    b.generation === this.state.generation &&
    this.state.accepted?.assets.some((a) => a.imgPath === b.imgPath && a.sha256 === b.sha256) ===
      true;
  reportAssetFailure = (b: AssetBinding, kind: "changed" | "busy" | "error") => {
    if (!this.isCurrentAsset(b)) return;
    if (kind === "busy" && !this.assetSpent) {
      this.freeze("busy");
      this.dirty = false;
      return;
    }
    if (kind !== "changed" || this.assetSpent) {
      this.fail("asset");
      return;
    }
    this.assetSpent = true;
    this.freeze("asset");
    this.dirty = true;
    if (!this.state.writePending) void this.read();
  };
  persist = async (next: AnnotationsFile, generation: number): Promise<boolean> => {
    if (
      !this.canAnnotate() ||
      generation !== this.state.generation ||
      next.content_fingerprint !== this.state.accepted?.file.content_fingerprint ||
      next.rev !== this.state.accepted?.file.rev
    )
      return false;
    const lifecycle = this.lifecycle;
    this.patch({ writePending: true, writeFailure: undefined });
    const r = await putAnnotations(this.docId, next);
    if (!this.alive) return false;
    if (lifecycle !== this.lifecycle) {
      // A detached session may have been reconnected by React. The old write
      // only releases serialization; its response cannot acknowledge new UI.
      this.patch({ writePending: false });
      if (this.dirty && !this.terminal) void this.read();
      return false;
    }
    if (r.ok) {
      if (r.file.content_fingerprint !== next.content_fingerprint) {
        this.fail("read");
        this.patch({ writePending: false, writeFailure: "error" });
        return false;
      }
      if (
        !this.terminal &&
        !this.dirty &&
        generation === this.state.generation &&
        this.state.phase === "ready" &&
        this.state.accepted
      ) {
        this.patch({ accepted: { ...this.state.accepted, file: r.file }, writePending: false });
      }
    } else if (r.kind === "document-changed" || r.kind === "rev-mismatch" || r.kind === "busy") {
      if (r.kind === "document-changed") {
        const editDrafts = Object.fromEntries(
          Object.entries(this.state.editDrafts).map(([id, d]) => [id, { ...d, blocked: true }])
        );
        this.patch({ editDrafts });
      }
      this.requestSync();
    } else this.fail("read");
    this.patch({ writePending: false, writeFailure: r.ok ? undefined : r.kind });
    if (this.dirty && !this.terminal) void this.read();
    return r.ok;
  };
  beginCreate = () => this.patch({ createDraft: { ...this.state.createDraft, use: false } });
  useCreateDraft = () => this.patch({ createDraft: { ...this.state.createDraft, use: true } });
  setCreateBody = (body: string) =>
    this.patch({ createDraft: { body, revision: this.state.createDraft.revision + 1, use: true } });
  clearCreate = (revision?: number) => {
    if (revision !== undefined && revision !== this.state.createDraft.revision) return false;
    this.patch({
      createDraft: { body: "", revision: this.state.createDraft.revision + 1, use: false },
    });
    return true;
  };
  beginEdit = (a: Annotation) => {
    if (!this.canAnnotate() || this.state.editDrafts[a.id]) return;
    this.patch({
      editDrafts: {
        ...this.state.editDrafts,
        [a.id]: {
          annotationId: a.id,
          sourceFingerprint: this.state.accepted!.file.content_fingerprint,
          originalBody: a.body,
          body: a.body,
          blocked: false,
          revision: ++this.draftRevision,
        },
      },
    });
  };
  setEditBody = (id: string, body: string) => {
    const d = this.state.editDrafts[id];
    if (!d) return;
    this.patch({
      editDrafts: {
        ...this.state.editDrafts,
        [id]: { ...d, body, revision: ++this.draftRevision },
      },
    });
  };
  acknowledgeEdit = (id: string, revision: number, body: string) => {
    const d = this.state.editDrafts[id];
    if (!d) return;
    if (d.revision === revision) {
      this.clearEdit(id, revision);
      return;
    }
    this.patch({ editDrafts: { ...this.state.editDrafts, [id]: { ...d, originalBody: body } } });
  };
  clearEdit = (id: string, revision?: number) => {
    const d = this.state.editDrafts[id];
    if (!d || (revision !== undefined && revision !== d.revision)) return false;
    const editDrafts = { ...this.state.editDrafts };
    delete editDrafts[id];
    this.patch({ editDrafts });
    return true;
  };
}

const Context = createContext<ReaderSessionController | null>(null);
export function ReaderSession({ docId, children }: { docId: string; children: ReactNode }) {
  const [controller] = useState(() => new ReaderSessionController(docId));
  useEffect(() => {
    const offLibrary = onLibraryChanged(controller.requestSync);
    const offAnnotations = onAnnotationChanged((id) => {
      if (id === docId) controller.requestSync();
    });
    controller.start();
    return () => {
      offLibrary();
      offAnnotations();
      controller.stop();
    };
  }, [controller, docId]);
  return <Context.Provider value={controller}>{children}</Context.Provider>;
}
export function useReaderSession() {
  const controller = useContext(Context);
  if (!controller) throw new Error("useReaderSession outside ReaderSession");
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  return { controller, state, canAnnotate: controller.canAnnotate() };
}
