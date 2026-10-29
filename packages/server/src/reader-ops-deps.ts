/**
 * The Reader's data seam (`ReaderOpDeps`) over the Project's files, built once from the annotations access path
 * (annotations-access.ts), the PDF access path (pdf-access.ts) and the Doc mutation registry. The running workbench
 * (`createApp`) and the in-process operation runtime of a CLI command (`createLocalOperationRuntime`) both call this,
 * so the Copilot `reader` tool, the page's routes and `argelanderspace annotation ...` / `reader ...` reach a Doc's
 * annotations through the very same code: the annotation commit (three-state fingerprint rules, archive only on the
 * access path), the PDF sidecar write, and the read-only background reads. Nothing here writes a file itself.
 */
import { join } from "node:path";
import { buildReaderReading, type PdfSourceMaterial } from "@argelanderspace/contracts";
import {
  AnnotationsError,
  DocumentAssetError,
  type LibraryPaths,
  readDocumentAsset,
} from "@argelanderspace/core";
import { type AnnotationAccess, DocMetadataError } from "./annotations-access.js";
import { type AnnotationWrite, planAnnotationWrite } from "./copilot-reader-annotations.js";
import type {
  AssetImageOutcome,
  PdfImageOutcome,
  PdfReadOutcome,
  ReaderOpDeps,
  ReaderReadOutcome,
  ReaderWriteOutcome,
} from "./copilot-reader-tool.js";
import { badDocId } from "./doc-id.js";
import type { DocMutationRegistry } from "./doc-mutations.js";
import type { PdfAccess } from "./pdf-access.js";
import { readPdfTextMaterialCached, renderPdfPageImage } from "./pdf-material.js";

export interface ReaderOpsInput {
  paths: LibraryPaths;
  annotationAccess: AnnotationAccess;
  pdfAccess: PdfAccess;
  docMutations: Pick<DocMutationRegistry, "isDocumentContentBusy">;
}

export function createReaderOps(input: ReaderOpsInput): ReaderOpDeps {
  const { annotationAccess, pdfAccess, docMutations } = input;
  const outputDir = input.paths.outputDir;
  return {
    write: async (op): Promise<ReaderWriteOutcome> => {
      if (badDocId(op.docId) || !op.docId.trim()) return { kind: "not_found" };
      let plan: AnnotationWrite | undefined;
      try {
        const commit = await annotationAccess.commit<AnnotationWrite>(
          op.docId,
          { fingerprint: op.fingerprint, rev: op.rev },
          (epoch) => {
            plan = planAnnotationWrite(op, epoch);
            return plan.kind === "write"
              ? { next: plan.next, preserveUnknown: true }
              : { skip: plan };
          }
        );
        if (commit.kind === "busy") return { kind: "busy" };
        if (commit.kind === "pdf") return { kind: "pdf" };
        const archived = commit.archived !== undefined ? { archived: commit.archived } : {};
        if (commit.kind === "document_changed")
          return {
            kind: "conflict",
            reason: "document_changed",
            epoch: {
              fingerprint: commit.file.content_fingerprint,
              annotationsRev: commit.file.rev,
            },
            ...archived,
          };
        if (commit.kind === "rev_mismatch")
          return {
            kind: "conflict",
            reason: "rev_mismatch",
            epoch: { fingerprint: op.fingerprint, annotationsRev: commit.rev },
            ...archived,
          };
        const epoch = {
          fingerprint: commit.file.content_fingerprint,
          annotationsRev: commit.file.rev,
        };
        if (commit.kind === "skipped") {
          const skipped = commit.value;
          if (skipped.kind === "same")
            return {
              kind: "unchanged",
              annotation: skipped.annotation,
              label: skipped.label,
              epoch,
              ...archived,
            };
          if (skipped.kind === "annotation_changed")
            return {
              kind: "conflict",
              reason: "annotation_changed",
              epoch,
              annotation: skipped.annotation,
              ...archived,
            };
          if (skipped.kind === "no_annotation")
            return { kind: "no_annotation", annotationId: skipped.annotationId, ...archived };
          if (skipped.kind === "invalid")
            return { kind: "invalid", detail: skipped.detail, ...archived };
          return {
            kind: "error",
            detail: skipped.kind === "error" ? skipped.detail : "unexpected plan",
          };
        }
        const done = plan?.kind === "write" ? plan : undefined;
        return {
          kind: "saved",
          ...(done?.annotation ? { annotation: done.annotation } : {}),
          ...(done?.deleted ? { deleted: done.deleted } : {}),
          ...(done?.expanded ? { expanded: true } : {}),
          label: done?.label ?? op.docId,
          epoch,
          ...archived,
        };
      } catch (err) {
        // A system error is never a mismatch and nothing is reset or rewritten. The page's own PUT answers 500.
        if (err instanceof AnnotationsError)
          return err.code === "not_found"
            ? { kind: "not_found" }
            : {
                kind: "error",
                detail: annotationAccess.describeError(err).detail,
                ...(err.code === "new_current" ? { archivedOlder: true } : {}),
              };
        if (err instanceof DocMetadataError)
          return {
            kind: "error",
            detail: "the Doc's metadata could not be read; nothing was changed",
          };
        return {
          kind: "error",
          detail:
            "the annotations file could not be written; it is replaced atomically or not at all, so read the Doc again to see what is stored now",
        };
      }
    },
    // One picture of a LaTeX or text Doc (copilot ticket 30): the very read of the images route's hash-checked mode
    // (`readDocumentAsset`: contained path, no symlinks, one byte read), refused while a content mutation is queued
    // or running, and the file must be the one the reading listed (its SHA-256).
    asset: async ({ docId, path, sha256 }): Promise<AssetImageOutcome> => {
      if (!docId.trim() || badDocId(docId) || docId.includes("\0")) return { kind: "not_found" };
      if (docMutations.isDocumentContentBusy(docId)) return { kind: "busy" };
      try {
        const asset = readDocumentAsset(join(outputDir, docId), path);
        if (asset.sha256 !== sha256.toLowerCase()) return { kind: "changed" };
        return { kind: "ok", bytes: asset.bytes, sha256: asset.sha256 };
      } catch (err) {
        if (err instanceof DocumentAssetError)
          return err.code === "missing"
            ? { kind: "not_found" }
            : err.code === "invalid"
              ? { kind: "invalid", detail: "the picture path is not one of the Doc's pictures" }
              : { kind: "error", detail: "the picture could not be read" };
        throw err;
      }
    },
    pdf: {
      // The PDF Reader's material for the model (copilot ticket 20): every page's real text, the outline and the
      // workbench annotations, from the verified original. Read-only; nothing is written, opened or moved.
      read: async (docId): Promise<PdfReadOutcome> => {
        const source = pdfAccess.source(docId, { annotations: true });
        if (source.kind === "bad_id" || source.kind === "not_found") return { kind: "not_found" };
        if (source.kind === "busy" || source.kind === "changed") return { kind: source.kind };
        if (source.kind !== "ok" || !source.annotations)
          return {
            kind: "error",
            detail: "the PDF or its user data could not be verified; nothing was changed",
          };
        try {
          const material = await readPdfTextMaterialCached(source.bytes, source.metadata.sha256);
          const pdf: PdfSourceMaterial = {
            docId,
            title: source.title,
            sha256: material.contentSha256,
            pageCount: material.pageCount,
            pages: material.pages,
            outline: material.outline,
            outlineTruncated: material.outlineTruncated,
            annotations: source.annotations.annotations,
            annotationsRev: source.annotations.rev,
          };
          return { kind: "ok", material: pdf };
        } catch (error) {
          const failure = pdfAccess.materialFailure(error);
          return failure.status === 409
            ? { kind: "changed" }
            : failure.status === 503
              ? { kind: "resource", detail: failure.detail }
              : { kind: "error", detail: failure.detail };
        }
      },
      // The PDF workbench annotation writes (copilot ticket 21): the page's own commit rules (the annotations lock,
      // the busy check, the original verified against its SHA-256, the expected revision, the atomic save and the
      // `annotation.changed` notification), applied as a narrow change to the sidecar as stored.
      write: (op, scope) => pdfAccess.writeAnnotation(op, scope),
      image: async (op): Promise<PdfImageOutcome> => {
        const source = pdfAccess.source(op.docId, {
          ...(op.sha256 ? { expectedHash: op.sha256 } : {}),
        });
        if (source.kind === "bad_id" || source.kind === "not_found") return { kind: "not_found" };
        if (source.kind === "busy" || source.kind === "changed") return { kind: source.kind };
        if (source.kind !== "ok")
          return { kind: "error", detail: "the PDF could not be verified; nothing was changed" };
        try {
          const image = await renderPdfPageImage(
            source.bytes,
            source.metadata.sha256,
            op.pageIndex,
            op.longEdge
          );
          return { kind: "ok", ...image };
        } catch (error) {
          const failure = pdfAccess.materialFailure(error);
          return failure.status === 400
            ? { kind: "invalid", detail: failure.detail }
            : failure.status === 409
              ? { kind: "changed" }
              : failure.status === 503
                ? { kind: "resource", detail: failure.detail }
                : { kind: "error", detail: failure.detail };
        }
      },
    },
    // The background read: the same reads as the coherent GET below but READ-ONLY (no ensure, no archive, never the
    // archive's content), refused while a content mutation is queued or running.
    read: async (docId): Promise<ReaderReadOutcome> => {
      if (badDocId(docId) || !docId.trim()) return { kind: "not_found" };
      try {
        const peeked = await annotationAccess.peek(docId);
        if (peeked.kind !== "ok") return peeked;
        const { ir, file, assets, stale } = peeked.reading;
        return { kind: "ok", reading: buildReaderReading({ ir, file, assets, stale }) };
      } catch (err) {
        if (err instanceof DocMetadataError)
          return { kind: "error", detail: "the Doc's metadata could not be read" };
        if (!(err instanceof AnnotationsError)) throw err;
        // The message names no path: the user's data stays untouched, whatever the reason.
        if (err.code === "not_found") return { kind: "not_found" };
        return { kind: "error", detail: annotationAccess.describeError(err).detail };
      }
    },
  };
}
