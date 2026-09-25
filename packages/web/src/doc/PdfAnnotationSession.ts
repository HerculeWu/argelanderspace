import type { PdfAnnotation, PdfAnnotationsFile } from "@argelanderspace/contracts";
import { onAnnotationChanged } from "../api/ws";
import { fetchPdfAnnotationsSnapshot, savePdfAnnotations, type SavePdfAnnotationsResult } from "../api/pdf-annotations";

export type PdfAnnotationFailure = {
  kind: "document-changed" | "rev-mismatch" | "busy" | "error";
  detail: string;
  noticeId: number;
};
export type PdfAnnotationSessionSnapshot = {
  file: PdfAnnotationsFile;
  saving: boolean;
  pending: number;
  drafts: Record<string, string>;
  failure: PdfAnnotationFailure | null;
  dismissedNoticeId: number | null;
  canUndo: boolean;
  canRedo: boolean;
  blocked: boolean;
};

type Change = { before: PdfAnnotation[]; after: PdfAnnotation[]; clearDraft?: { id: string; value: string } };
type HistoryEntry = { before: PdfAnnotation[]; after: PdfAnnotation[] };
type HistoryAction = { type: "normal" } | { type: "undo"; entry: HistoryEntry } | { type: "redo"; entry: HistoryEntry };
type PendingChange = Change & { action: HistoryAction };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stable(item)]));
  return value;
}
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(stable(a)) === JSON.stringify(stable(b)); }
function rebaseConflict(message: string): never {
  throw Object.assign(new Error(message), { kind: "rev-mismatch" as const });
}
function byId(items: PdfAnnotation[]): Map<string, PdfAnnotation> { return new Map(items.map((item) => [item.id, item])); }
function applyDiff(base: PdfAnnotation[], change: Change): PdfAnnotation[] {
  const before = byId(change.before);
  const after = byId(change.after);
  const current = byId(base);
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const prior = before.get(id);
    const next = after.get(id);
    if (!prior && next) {
      const existing = current.get(id);
      if (existing && !equal(existing, next)) rebaseConflict("annotation id changed elsewhere; copy or discard the draft");
      current.set(id, existing ?? next);
    } else if (prior && !next) {
      const existing = current.get(id);
      if (existing) {
        const comparable = (item: PdfAnnotation) => {
          const { updated_at: _updatedAt, ...rest } = item;
          return rest;
        };
        if (!equal(comparable(existing), comparable(prior))) rebaseConflict("annotation changed elsewhere; copy or discard the draft");
        current.delete(id);
      }
    } else if (prior && next) {
      const value = current.get(id);
      if (!value || value.kind !== next.kind || value.created_at !== next.created_at) rebaseConflict("annotation target changed; reload or discard the draft");
      if (next.kind === "rectangle" && (value.kind !== "rectangle" || value.page_index !== next.page_index)) rebaseConflict("rectangle target changed; reload or discard the draft");
      if (next.kind === "page_comment" && (value.kind !== "page_comment" || value.page_index !== next.page_index)) rebaseConflict("page comment target changed; reload or discard the draft");
      const merged = { ...value } as Record<string, unknown>;
      for (const key of ["body", "rectangle", "style", "segments", "color"]) {
        const previousField = (prior as unknown as Record<string, unknown>)[key];
        const nextField = (next as unknown as Record<string, unknown>)[key];
        if (!equal(previousField, nextField)) {
          if (!equal(merged[key], previousField) && !equal(merged[key], nextField))
            rebaseConflict("annotation changed elsewhere; copy or discard the draft");
          merged[key] = nextField;
        }
      }
      current.set(id, merged as PdfAnnotation);
    }
  }
  return change.after.flatMap((annotation) => {
    const currentAnnotation = current.get(annotation.id);
    return currentAnnotation ? [currentAnnotation] : [];
  }).concat([...current.values()].filter((annotation) => !after.has(annotation.id)));
}

/** One mounted PDF Doc's sole annotation authority: serialized mutations, history and late-result gates. */
export class PdfAnnotationSession {
  private generation = 0;
  private alive = false;
  private inFlight = false;
  private queue: PendingChange[] = [];
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private listeners = new Set<() => void>();
  private drafts: Record<string, string> = {};
  private noticeId = 0;
  private state: PdfAnnotationSessionSnapshot;
  private unsubscribeWs: (() => void) | null = null;
  private invalidationDuringWrite = false;

  constructor(readonly docId: string, readonly contentSha256: string, file: PdfAnnotationsFile) {
    this.state = { file, saving: false, pending: 0, drafts: {}, failure: null, dismissedNoticeId: null, canUndo: false, canRedo: false, blocked: false };
  }
  getSnapshot = () => this.state;
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => this.listeners.delete(callback); };
  private publish(patch: Partial<PdfAnnotationSessionSnapshot> = {}) {
    this.state = { ...this.state, ...patch, pending: this.queue.length, drafts: { ...this.drafts }, canUndo: this.past.length > 0 && !this.queue.length && !this.inFlight, canRedo: this.future.length > 0 && !this.queue.length && !this.inFlight };
    for (const listener of this.listeners) listener();
  }
  start = () => {
    if (this.alive) return;
    this.alive = true;
    const generation = ++this.generation;
    this.unsubscribeWs = onAnnotationChanged((docId) => {
      if (docId !== this.docId || !this.alive) return;
      if (this.inFlight) { this.invalidationDuringWrite = true; return; }
      if (this.queue.length === 0) void this.reloadExternal(generation);
    });
  };
  stop = () => { this.alive = false; this.generation++; this.unsubscribeWs?.(); this.unsubscribeWs = null; };
  hasUnsaved = () => this.queue.length > 0 || this.inFlight || Object.entries(this.drafts).some(([id, body]) => this.annotation(id)?.body !== body) || this.state.failure !== null;
  isWritable = () => this.alive && !this.state.blocked;
  annotation = (id: string) => this.projectedAnnotations().find((item) => item.id === id);
  projectedAnnotations = () => this.queue.reduce((items, change) => applyDiff(items, change), this.state.file.annotations);
  mutate = (after: PdfAnnotation[], clearDraft?: { id: string; value: string }) => {
    if (!this.isWritable()) return false;
    const before = this.projectedAnnotations();
    if (equal(before, after)) return false;
    this.queue.push({ before, after, ...(clearDraft ? { clearDraft } : {}), action: { type: "normal" } });
    this.future = [];
    // New edits may be kept locally after a failed write, but only a deliberate
    // retry may restart the failed operation (especially after a rev conflict).
    if (this.state.failure) this.publish();
    else { this.publish(); void this.pump(); }
    return true;
  };
  create = (annotation: PdfAnnotation) => this.mutate([...this.projectedAnnotations(), annotation]);
  setDraft = (id: string, body: string) => { this.drafts[id] = body; this.publish(); };
  clearDraft = (id: string, expectedValue?: string) => {
    if (expectedValue !== undefined && this.drafts[id] !== expectedValue) return;
    if (id in this.drafts) { delete this.drafts[id]; this.publish(); }
  };
  saveBody = (id: string) => {
    const annotation = this.annotation(id);
    const body = this.drafts[id];
    if (!annotation || body === undefined || !body.trim() || body === annotation.body || !this.isWritable()) return false;
    const after = this.projectedAnnotations().map((item) => item.id === id ? { ...item, body } as PdfAnnotation : item);
    return this.mutate(after, { id, value: body });
  };
  remove = (id: string) => {
    const draft = this.drafts[id];
    return this.mutate(this.projectedAnnotations().filter((item) => item.id !== id), draft === undefined ? undefined : { id, value: draft });
  };
  undo = () => {
    if (!this.state.canUndo) return false;
    const entry = this.past[this.past.length - 1];
    if (!entry) return false;
    const before = this.projectedAnnotations();
    const after = applyDiff(before, { before: entry.after, after: entry.before });
    this.queue.push({ before, after, action: { type: "undo", entry } });
    this.publish(); void this.pump(); return true;
  };
  redo = () => {
    if (!this.state.canRedo) return false;
    const entry = this.future[this.future.length - 1];
    if (!entry) return false;
    const before = this.projectedAnnotations();
    const after = applyDiff(before, { before: entry.before, after: entry.after });
    this.queue.push({ before, after, action: { type: "redo", entry } });
    this.publish(); void this.pump(); return true;
  };
  dismissFailure = () => { if (this.state.failure) this.publish({ dismissedNoticeId: this.state.failure.noticeId }); };
  private setFailure(kind: PdfAnnotationFailure["kind"], detail: string) {
    if (kind === "document-changed") { this.past = []; this.future = []; }
    const failure = { kind, detail, noticeId: ++this.noticeId };
    this.publish({ failure, dismissedNoticeId: null, blocked: this.state.blocked || kind === "document-changed" });
  }
  private async pump() {
    if (!this.alive || this.inFlight || this.state.failure || this.queue.length === 0) return;
    const generation = this.generation;
    const change = this.queue[0];
    if (!change) return;
    let annotations: PdfAnnotation[];
    try { annotations = applyDiff(this.state.file.annotations, change); }
    catch (error) { this.setFailure("rev-mismatch", error instanceof Error ? error.message : String(error)); return; }
    this.inFlight = true;
    this.publish({ saving: true });
    const candidate = { ...this.state.file, annotations, rev: this.state.file.rev };
    const result: SavePdfAnnotationsResult = await savePdfAnnotations(this.docId, candidate);
    if (!this.alive || generation !== this.generation) return;
    this.inFlight = false;
    if (!result.ok) {
      this.publish({ saving: false });
      this.setFailure(result.kind, result.detail);
      return;
    }
    this.state.file = result.file;
    this.queue.shift();
    if (result.file.rev === candidate.rev) {
      if (change.clearDraft && this.drafts[change.clearDraft.id] === change.clearDraft.value) delete this.drafts[change.clearDraft.id];
      this.publish({ file: result.file, saving: false, failure: null, dismissedNoticeId: null });
      void this.pump();
      return;
    }
    if (change.action.type === "normal") this.past.push({ before: change.before, after: change.after });
    else if (change.action.type === "undo") { this.past.pop(); this.future.push(change.action.entry); }
    else { this.future.pop(); this.past.push(change.action.entry); }
    if (change.clearDraft && this.drafts[change.clearDraft.id] === change.clearDraft.value) delete this.drafts[change.clearDraft.id];
    this.publish({ file: result.file, saving: false, failure: null, dismissedNoticeId: null });
    if (this.invalidationDuringWrite) {
      this.invalidationDuringWrite = false;
      if (this.queue.length === 0) void this.reloadExternal(generation);
    }
    void this.pump();
  }
  retry = async () => {
    const failure = this.state.failure;
    if (!failure || !this.alive) return;
    if (failure.kind !== "rev-mismatch" && failure.kind !== "document-changed") { this.publish({ failure: null, dismissedNoticeId: null }); void this.pump(); return; }
    const generation = this.generation;
    try {
      const latest = await fetchPdfAnnotationsSnapshot(this.docId, this.contentSha256);
      if (!this.alive || generation !== this.generation) return;
      if (latest.rev !== this.state.file.rev) { this.past = []; this.future = []; }
      let rebased = latest.annotations;
      const changes: PendingChange[] = [];
      for (const pending of this.queue) {
        const before = rebased;
        rebased = applyDiff(rebased, pending);
        changes.push({ ...pending, before, after: rebased, action: { type: "normal" } });
      }
      this.queue = changes;
      this.publish({ file: latest, failure: null, dismissedNoticeId: null, blocked: false });
      void this.pump();
    } catch (error) {
      if (!this.alive || generation !== this.generation) return;
      const kind = (error as { kind?: PdfAnnotationFailure["kind"] }).kind ?? "error";
      this.setFailure(kind, error instanceof Error ? error.message : String(error));
    }
  };
  discard = () => {
    this.queue = [];
    this.drafts = {};
    this.past = [];
    this.future = [];
    this.publish({ failure: null, dismissedNoticeId: null, blocked: this.state.blocked });
  };
  private async reloadExternal(generation: number) {
    try {
      const latest = await fetchPdfAnnotationsSnapshot(this.docId, this.contentSha256);
      if (!this.alive || generation !== this.generation) return;
      // A notification read may begin before a local PUT, then observe that PUT on
      // disk before its response reaches this session. Do not classify our own
      // in-flight revision as a foreign edit; verify again after the queue settles.
      if (this.inFlight || this.queue.length > 0) { this.invalidationDuringWrite = true; return; }
      if (latest.rev <= this.state.file.rev) return;
      this.past = [];
      this.future = [];
      if (this.hasUnsaved()) { this.setFailure("rev-mismatch", "PDF annotations changed elsewhere"); return; }
      this.publish({ file: latest });
    } catch (error) {
      if (!this.alive || generation !== this.generation) return;
      const kind = (error as { kind?: PdfAnnotationFailure["kind"] }).kind ?? "error";
      this.setFailure(kind, error instanceof Error ? error.message : String(error));
    }
  }
}
