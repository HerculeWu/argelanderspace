import { randomUUID } from "node:crypto";
import {
  PDF_HIGHLIGHT_DEFAULT_COLOR,
  PDF_RECTANGLE_DEFAULT_STYLE,
  type PdfAnnotation,
  type PdfAnnotationOperation,
  type PdfAnnotationsFile,
  type PdfCreateAnnotationOperation,
  type PdfDocMetadata,
  type PdfRectangleInput,
  type PdfUpdateAnnotationOperation,
} from "@argelanderspace/contracts";

/**
 * The agent's PDF workbench annotation writes (copilot ticket 21) as pure functions of ONE verified state: the stored
 * sidecar exactly as read (every key the application does not know is still on it) and the Doc's metadata. They run
 * inside the annotations lock (see `writeAnnotation` in pdf-access.ts) after the shared commit has checked the
 * original's SHA-256 and the revision the caller named. They only build the next annotation list; locking, the
 * checks, the atomic save and the notification stay with the shared handler.
 *
 * The rules are the Reader's own (`PdfAnnotationSession` and the panel): immutable kind/page/text target/created
 * time, `updated_at` moves only when body, geometry, style or colour change, a highlight in the default yellow stores
 * no `color`, a new rectangle has the area tool's default style, and a stored annotation is changed through a
 * spread of itself so unknown keys stay.
 */
export type PdfAnnotationPlan =
  | {
      kind: "write";
      next: PdfAnnotation[];
      /** The annotation created or changed; absent for a delete. */
      annotation?: PdfAnnotation;
      deleted?: string;
      /** Display text for the operation record. */
      label: string;
      /** What undo/redo restores: the whole list before and after. */
      before: PdfAnnotation[];
    }
  /** Nothing to write: the request leaves the stored annotation as it is. */
  | { kind: "same"; annotation: PdfAnnotation; label: string }
  /** The stored annotation is not the one the caller last read (its `updated_at` differs). */
  | { kind: "annotation_changed"; annotation: PdfAnnotation }
  | { kind: "no_annotation"; annotationId: string }
  | { kind: "invalid"; detail: string };

/** A text annotation's resolved target (from the original's real text layer), resolved before the lock. */
export type ResolvedTextTarget = Extract<PdfAnnotation, { kind: "highlight" }>["target"];

const fits = (rect: PdfRectangleInput): PdfRectangleInput => ({
  x: rect.x,
  y: rect.y,
  // a sum above 1 by floating-point noise only is the page edge
  width: Math.min(rect.width, 1 - rect.x),
  height: Math.min(rect.height, 1 - rect.y),
});

const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, stable(item)])
        )
      : value;
export const samePdfValue = (a: unknown, b: unknown) =>
  JSON.stringify(stable(a)) === JSON.stringify(stable(b));

function labelOf(title: string, annotation: PdfAnnotation): string {
  if (annotation.kind === "document_comment") return title;
  if (annotation.kind === "rectangle" || annotation.kind === "page_comment")
    return `${title} · p.${annotation.page_index + 1}`;
  const quote = annotation.target.quote;
  return `${title} · “${quote.length > 40 ? `${quote.slice(0, 40)}…` : quote}”`;
}

export function planPdfCreate(
  op: PdfCreateAnnotationOperation,
  current: PdfAnnotationsFile,
  metadata: PdfDocMetadata,
  title: string,
  text: ResolvedTextTarget | undefined,
  now: Date = new Date()
): PdfAnnotationPlan {
  if (op.pageIndex !== undefined && op.pageIndex >= metadata.page_count)
    return {
      kind: "invalid",
      detail: `pageIndex ${op.pageIndex} is outside 0..${metadata.page_count - 1} (pages are zero-based)`,
    };
  const stamp = now.toISOString();
  let id = `pann_${randomUUID()}`;
  while (current.annotations.some((item) => item.id === id)) id = `pann_${randomUUID()}`;
  const common = { id, body: op.body, created_at: stamp, updated_at: stamp };
  let annotation: PdfAnnotation;
  switch (op.kind) {
    case "rectangle":
      annotation = {
        ...common,
        kind: "rectangle",
        page_index: op.pageIndex as number,
        rectangle: fits(op.rectangle as PdfRectangleInput),
        style: { ...PDF_RECTANGLE_DEFAULT_STYLE, ...(op.style ?? {}) },
      };
      break;
    case "page_comment":
      annotation = { ...common, kind: "page_comment", page_index: op.pageIndex as number };
      break;
    case "document_comment":
      annotation = { ...common, kind: "document_comment" };
      break;
    default:
      if (!text) return { kind: "invalid", detail: "the text could not be resolved" };
      annotation =
        op.kind === "highlight"
          ? {
              ...common,
              kind: "highlight",
              ...(op.color !== undefined && op.color !== PDF_HIGHLIGHT_DEFAULT_COLOR
                ? { color: op.color }
                : {}),
              target: text,
            }
          : { ...common, kind: op.kind, target: text };
  }
  return {
    kind: "write",
    next: [...current.annotations, annotation],
    annotation,
    label: labelOf(title, annotation),
    before: current.annotations,
  };
}

export function planPdfUpdate(
  op: PdfUpdateAnnotationOperation,
  current: PdfAnnotationsFile,
  title: string,
  now: Date = new Date()
): PdfAnnotationPlan {
  const existing = current.annotations.find((item) => item.id === op.annotationId);
  if (!existing) return { kind: "no_annotation", annotationId: op.annotationId };
  if (existing.updated_at !== op.expectedUpdatedAt)
    return { kind: "annotation_changed", annotation: existing };
  const label = labelOf(title, existing);
  if (op.rectangle !== undefined && existing.kind !== "rectangle")
    return {
      kind: "invalid",
      detail: "only a rectangle has geometry; its page and target never change",
    };
  if (op.style !== undefined && existing.kind !== "rectangle")
    return { kind: "invalid", detail: "style applies to rectangles only" };
  if (op.color !== undefined && existing.kind !== "highlight")
    return { kind: "invalid", detail: "colour applies to highlights only" };
  const merged: Record<string, unknown> = { ...existing };
  if (op.body !== undefined) merged.body = op.body;
  if (existing.kind === "rectangle") {
    if (op.rectangle !== undefined)
      merged.rectangle = { ...existing.rectangle, ...fits(op.rectangle) };
    if (op.style !== undefined) merged.style = { ...existing.style, ...op.style };
  }
  if (existing.kind === "highlight" && op.color !== undefined) {
    // the colour control writes the chosen colour; choosing the one already shown changes nothing
    if ((existing.color ?? PDF_HIGHLIGHT_DEFAULT_COLOR) !== op.color) merged.color = op.color;
  }
  const watched = (item: Record<string, unknown>) => [
    item.body,
    item.rectangle ?? null,
    item.style ?? null,
    item.color ?? null,
  ];
  if (samePdfValue(watched(existing as unknown as Record<string, unknown>), watched(merged)))
    return { kind: "same", annotation: existing, label };
  merged.updated_at = now.toISOString();
  const updated = merged as unknown as PdfAnnotation;
  return {
    kind: "write",
    next: current.annotations.map((item) => (item.id === op.annotationId ? updated : item)),
    annotation: updated,
    label,
    before: current.annotations,
  };
}

export function planPdfDelete(
  op: Extract<PdfAnnotationOperation, { action: "delete_pdf_annotation" }>,
  current: PdfAnnotationsFile,
  title: string
): PdfAnnotationPlan {
  const existing = current.annotations.find((item) => item.id === op.annotationId);
  if (!existing) return { kind: "no_annotation", annotationId: op.annotationId };
  if (existing.updated_at !== op.expectedUpdatedAt)
    return { kind: "annotation_changed", annotation: existing };
  return {
    kind: "write",
    next: current.annotations.filter((item) => item.id !== op.annotationId),
    deleted: op.annotationId,
    label: labelOf(title, existing),
    before: current.annotations,
  };
}

// ---- Undo and redo --------------------------------------------------------------------------------------- //

interface HistoryEntry {
  before: PdfAnnotation[];
  after: PdfAnnotation[];
  label: string;
}
interface DocHistory {
  past: HistoryEntry[];
  future: HistoryEntry[];
  /** The sidecar revision the last history change left; a different revision means someone else wrote since. */
  rev: number;
}
/** The Reader's own history has no depth limit; a service-held one stays bounded. */
export const PDF_HISTORY_DEPTH = 50;
/** The histories held at once (one per conversation and Doc); the least recently used go first. */
export const PDF_HISTORY_KEYS = 64;

/**
 * The Copilot's undo and redo of ITS OWN changes to a Doc's workbench annotations, held in the service's memory (it is
 * gone when the service restarts, like the Plan page's undo window). It follows the Reader's session rules: the
 * history is valid only while nobody else has written (any other revision ends it, as a foreign revision ends the
 * page's history), a new change clears redo, undo and redo are writes of their own (new revision), and a change of
 * something the history does not describe is refused rather than overwritten.
 */
export class PdfAnnotationHistory {
  private readonly docs = new Map<string, DocHistory>();

  /** The history of one conversation's changes to one Doc: what "the changes you made" means. */
  static key(conversationId: string, docId: string): string {
    return `${conversationId}\u0000${docId}`;
  }

  private store(key: string, history: DocHistory): void {
    // Most recently used last; the oldest histories go first so the map stays bounded.
    this.docs.delete(key);
    this.docs.set(key, history);
    while (this.docs.size > PDF_HISTORY_KEYS) {
      const oldest = this.docs.keys().next().value;
      if (oldest === undefined) break;
      this.docs.delete(oldest);
    }
  }

  /** Record a change that was just saved as `rev`. */
  recordChange(
    key: string,
    plan: Extract<PdfAnnotationPlan, { kind: "write" }>,
    rev: number
  ): void {
    const history = this.live(key, rev - 1) ?? { past: [], future: [], rev };
    history.past.push({ before: plan.before, after: plan.next, label: plan.label });
    if (history.past.length > PDF_HISTORY_DEPTH) history.past.shift();
    history.future = [];
    history.rev = rev;
    this.store(key, history);
  }

  /** Whether undo and redo have something to do right now (as of the revision the history last left). */
  depth(key: string): { canUndo: boolean; canRedo: boolean } {
    const history = this.docs.get(key);
    return {
      canUndo: (history?.past.length ?? 0) > 0,
      canRedo: (history?.future.length ?? 0) > 0,
    };
  }

  /** How many histories are held (a test reads it to see the bound). */
  get size(): number {
    return this.docs.size;
  }

  private live(key: string, currentRev: number): DocHistory | undefined {
    const history = this.docs.get(key);
    if (!history) return undefined;
    if (history.rev !== currentRev) {
      this.docs.delete(key);
      return undefined;
    }
    return history;
  }

  /** What undo (or redo) would do now, or why there is nothing to do. */
  plan(
    key: string,
    direction: "undo" | "redo",
    current: PdfAnnotationsFile,
    now: Date = new Date()
  ):
    | { kind: "write"; next: PdfAnnotation[]; label: string }
    | { kind: "none"; reason: "nothing" | "history_ended" | "changed" } {
    const had = this.docs.has(key);
    const history = this.live(key, current.rev);
    if (!history) return { kind: "none", reason: had ? "history_ended" : "nothing" };
    const stack = direction === "undo" ? history.past : history.future;
    const entry = stack[stack.length - 1];
    if (!entry) return { kind: "none", reason: "nothing" };
    const from = direction === "undo" ? entry.after : entry.before;
    const to = direction === "undo" ? entry.before : entry.after;
    // The file at this revision is what the history left; anything else was edited by hand, and is not overwritten.
    if (!samePdfValue(current.annotations, from)) {
      this.docs.delete(key);
      return { kind: "none", reason: "changed" };
    }
    const stamp = now.toISOString();
    const stored = new Map(current.annotations.map((item) => [item.id, item]));
    // An annotation brought back to an earlier content is a change of it (a new updated_at); one restored whole,
    // like a deleted one, is as it was.
    const next = to.map((item) => {
      const there = stored.get(item.id);
      return there && !samePdfValue(there, item) ? { ...item, updated_at: stamp } : item;
    });
    return { kind: "write", next, label: entry.label };
  }

  /**
   * The undo or redo was saved as `rev` with these annotations (their `updated_at` may be new). The saved list is now
   * the state both the moved entry and the entry that comes next in the same direction start from, so it is written
   * into both: otherwise the next undo (or redo) would compare the file with a list that still has the old
   * `updated_at` and refuse a history nobody has touched.
   */
  recordMove(key: string, direction: "undo" | "redo", rev: number, saved: PdfAnnotation[]): void {
    const history = this.docs.get(key);
    if (!history) return;
    if (direction === "undo") {
      const entry = history.past.pop();
      if (entry) {
        entry.before = saved;
        history.future.push(entry);
      }
      const next = history.past[history.past.length - 1];
      if (next) next.after = saved;
    } else {
      const entry = history.future.pop();
      if (entry) {
        entry.after = saved;
        history.past.push(entry);
      }
      const next = history.future[history.future.length - 1];
      if (next) next.before = saved;
    }
    history.rev = rev;
    this.store(key, history);
  }
}
