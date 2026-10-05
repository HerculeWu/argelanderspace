import {
  type Annotation,
  type AnnotationsFile,
  type AnnotationTarget,
  type AssetDigest,
  buildStructureTarget,
  type DocIr,
  irIndex,
  type ReaderWriteOperation,
  resolveTextTarget,
  withAssetHash,
} from "@argelanderspace/contracts";
import { newAnnotationId } from "@argelanderspace/core";

/**
 * The agent's annotation writes (copilot ticket 19), as pure functions of ONE ensured epoch: the stored IR, the
 * asset manifest and the current annotations file of the same fingerprint. They run inside the annotations PUT's
 * critical section (see `commitAnnotations` in app.ts), after that access path has ensured the epoch and checked
 * the fingerprint and revision the caller named. They only build the next file; saving, locking, the three-state
 * fingerprint rules, archiving and notification stay with the shared handler.
 */

export type AnnotationWrite =
  /** The next file to save. `annotation` is the one created/updated; absent for a delete. */
  | {
      kind: "write";
      next: AnnotationsFile;
      annotation?: Annotation;
      deleted?: string;
      expanded?: boolean;
      /** Verbatim display text for the operation record: the Doc title and what the annotation is about. */
      label: string;
    }
  /** Nothing to write: the body bytes are what is stored already. */
  | { kind: "same"; annotation: Annotation; label: string }
  /** The stored annotation is not the one the caller last read (its `updated_at` differs): its body changed since. */
  | { kind: "annotation_changed"; annotation: Annotation }
  | { kind: "no_annotation"; annotationId: string }
  | { kind: "invalid"; detail: string }
  /** The epoch cannot supply what the target needs (never reachable after a successful ensure; kept as an error). */
  | { kind: "error"; detail: string };

export interface EnsuredEpoch {
  ir: DocIr;
  assets: readonly AssetDigest[];
  file: AnnotationsFile;
}

export function planAnnotationWrite(
  op: ReaderWriteOperation,
  epoch: EnsuredEpoch,
  now: Date = new Date()
): AnnotationWrite {
  const { file } = epoch;
  const title = epoch.ir.title ?? epoch.ir.docId;
  if (op.action === "create_annotation") {
    const target = resolveTarget(op.target, epoch);
    if ("invalid" in target) return { kind: "invalid", detail: target.invalid };
    if ("error" in target) return { kind: "error", detail: target.error };
    let id = newAnnotationId();
    while (file.annotations.some((a) => a.id === id)) id = newAnnotationId();
    const stamp = now.toISOString();
    const annotation: Annotation = {
      id,
      target: target.target,
      body: op.body,
      created_at: stamp,
      updated_at: stamp,
    };
    return {
      kind: "write",
      next: { ...file, annotations: [...file.annotations, annotation] },
      annotation,
      label: labelOf(title, target.target),
      ...(target.expanded ? { expanded: true } : {}),
    };
  }
  // Duplicate ids (a file edited by hand) behave as the page does: the first match is what is shown and compared,
  // update changes every match, delete removes every match.
  const existing = file.annotations.find((a) => a.id === op.annotationId);
  if (!existing) return { kind: "no_annotation", annotationId: op.annotationId };
  if (existing.updated_at !== op.expectedUpdatedAt)
    return { kind: "annotation_changed", annotation: existing };
  const label = labelOf(title, existing.target);
  if (op.action === "delete_annotation")
    return {
      kind: "write",
      next: { ...file, annotations: file.annotations.filter((a) => a.id !== op.annotationId) },
      deleted: op.annotationId,
      label,
    };
  // update_annotation: only the body; the page skips the write when the bytes are unchanged
  if (existing.body === op.body) return { kind: "same", annotation: existing, label };
  const stamp = now.toISOString();
  const next: AnnotationsFile = {
    ...file,
    annotations: file.annotations.map((a) =>
      a.id === op.annotationId ? { ...a, body: op.body, updated_at: stamp } : a
    ),
  };
  return {
    kind: "write",
    next,
    annotation: next.annotations.find((a) => a.id === op.annotationId) as Annotation,
    label,
  };
}

/** "Doc title · p-4" / "Doc title · “quote…”" / the bare title for a whole-document annotation. */
function labelOf(title: string, target: AnnotationTarget): string {
  if (target.type === "document") return title;
  if (target.type === "structure") return `${title} · ${target.id}`;
  const quote = target.quote.length > 40 ? `${target.quote.slice(0, 40)}…` : target.quote;
  return `${title} · “${quote}”`;
}

function resolveTarget(
  input: Extract<ReaderWriteOperation, { action: "create_annotation" }>["target"],
  epoch: EnsuredEpoch
): { target: AnnotationTarget; expanded?: boolean } | { invalid: string } | { error: string } {
  if (input.type === "document") return { target: { type: "document" } };
  const { blocks, sections } = irIndex(epoch.ir);
  if (input.type === "structure") {
    const node = blocks.get(input.id) ?? sections.get(input.id);
    if (!node)
      return {
        invalid: `no section or block ${input.id} in this document (references cannot be annotated)`,
      };
    const built = buildStructureTarget(node);
    try {
      return { target: withAssetHash(epoch.assets, blocks, built) };
    } catch {
      return {
        error: "the figure's image has no verified digest in this epoch; nothing was written",
      };
    }
  }
  const text = resolveTextTarget(epoch.ir, input);
  if (!text.ok) return { invalid: text.detail };
  return { target: text.target, ...(text.expanded ? { expanded: true } : {}) };
}
