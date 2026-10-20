/**
 * The PDF access path of a local PDF Doc (docs/contracts.md "本地 PDF Doc"; the PDF workbench sentence of
 * "归档权限与 PUT"): who owns the Doc, the verified source every PDF read starts from, the Copilot's workbench
 * annotation writes, and what a failure answers.
 *
 * The PDF routes (snapshot, annotations, count, reading position, pages, page image, download), the papers and
 * description routes, the text Docs' PDF region render, the Copilot `reader` tool's PDF read/image/write and the
 * acquisition's arXiv description all go through ONE instance of this module, made by `createApp` with the app's one
 * annotationLock (the same lock the LaTeX annotations access, the text Doc publication, the PDF annotations PUT, the
 * annotation risk read and the Doc delete description take) and its DocMutationRegistry. `onChanged` is the app's
 * `annotation.changed` notification. The HTTP wrapping of each route stays in the app.
 *
 * Every access verifies on its own: `source` checks, in this order, the id, content-busy, a unique owner, the
 * metadata, then reads the original once and verifies it against its immutable byte length and SHA-256 (core's
 * `readVerifiedPdf`) and against the hash the caller expects. A known failure is answered, never repaired: nothing
 * is reset, migrated, archived, rebound or written.
 */
import { DOCUMENT_BUSY, type PdfAnnotationOperation } from "@argelanderspace/contracts";
import {
  commitPdfAnnotationChange,
  type LibraryPaths,
  LibraryStore,
  PdfAnnotationValidationError,
  PdfContentChangedError,
  readPdfAnnotationsFile,
  readPdfMetadataIfPresent,
  readVerifiedPdf,
  type Work,
} from "@argelanderspace/core";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { PdfWriteOutcome } from "./copilot-reader-tool.js";
import { badDocId } from "./doc-id.js";
import type { DocMutationRegistry } from "./doc-mutations.js";
import type { AsyncLock } from "./lock.js";
import {
  PdfAnnotationHistory,
  type PdfAnnotationPlan,
  planPdfCreate,
  planPdfDelete,
  planPdfUpdate,
  type ResolvedTextTarget,
} from "./pdf-annotation-actions.js";
import {
  PdfMaterialContentError,
  PdfMaterialInputError,
  PdfMaterialResourceError,
  PdfQueueFullError,
  resolvePdfTextTarget,
} from "./pdf-material.js";

/** FastAPI's `HTTPException(status, msg)` body (the app's own helper, for `sourceFailure`). */
function detail(msg: string, status: ContentfulStatusCode) {
  return { body: { detail: msg }, status };
}

/** Python `f"...{value!r}..."` for the simple ids that reach these messages (the app's own helper). */
function pyRepr(s: string): string {
  return `'${s}'`;
}

/** What `source` found: the verified original, or why there is none. */
export type PdfSource =
  | {
      kind: "ok";
      metadata: NonNullable<ReturnType<typeof readPdfMetadataIfPresent>>;
      bytes: Buffer;
      title: string;
      annotations?: ReturnType<typeof readPdfAnnotationsFile>;
    }
  | { kind: "bad_id" | "busy" | "not_found" | "changed" | "inconsistent" | "error" };

export interface PdfAccessDeps {
  paths: LibraryPaths;
  docMutations: Pick<DocMutationRegistry, "isDocumentContentBusy">;
  /** The app's one annotationLock (received, never made here). */
  lock: AsyncLock;
  onChanged: (docId: string, kind: "put" | "invalidate") => void;
}

export interface PdfAccess {
  /** The Works whose `doc_ids` list the Doc, read fresh from the library each call. */
  owners(docId: string): Work[];
  /** The verified original (see the module comment); `annotations` also reads the workbench sidecar. */
  source(docId: string, options?: { expectedHash?: string; annotations?: boolean }): PdfSource;
  /** The Copilot's PDF workbench annotation write, on the lock; the undo/redo history lives in this instance. */
  writeAnnotation(
    op: PdfAnnotationOperation,
    scope: { conversationId: string }
  ): Promise<PdfWriteOutcome>;
  /** What a failed PDF material request is, as the routes answer it. */
  materialFailure(error: unknown): { status: 400 | 409 | 500 | 503; detail: string };
  /** The status a failed `source` answers on the PDF material routes. */
  sourceFailure(
    docId: string,
    kind: Exclude<PdfSource["kind"], "ok">
  ): { body: { detail: string }; status: ContentfulStatusCode };
}

export function createPdfAccess(deps: PdfAccessDeps): PdfAccess {
  const { paths, docMutations, lock: annotationLock, onChanged: annotationChanged } = deps;
  const pdfOwners = (docId: string) =>
    LibraryStore.load(paths).works.filter((work) => work.doc_ids.includes(docId));
  /**
   * The ONE way PDF page material is reached (the `/pdf/pages` routes and the Copilot's reader tool): content-busy
   * check, a unique owner, and the original read once and verified against its immutable SHA-256 (and against the
   * hash the caller expects, if it names one). The text and the image both come from the Buffer this returns.
   */
  const pdfSource = (
    docId: string,
    options: { expectedHash?: string; annotations?: boolean } = {}
  ): PdfSource => {
    if (!docId.trim() || badDocId(docId)) return { kind: "bad_id" };
    if (docMutations.isDocumentContentBusy(docId)) return { kind: "busy" };
    // The order of GET /api/paper/:doc_id/pdf: unowned 404, ownership not unique 500, then the Doc's own data; an
    // owned Doc without PDF metadata is a data error (500), not "not found".
    const owners = pdfOwners(docId);
    if (owners.length === 0) return { kind: "not_found" };
    if (owners.length !== 1 || !owners[0]) return { kind: "inconsistent" };
    try {
      const metadata = readPdfMetadataIfPresent(paths, docId);
      if (!metadata) return { kind: "error" };
      const bytes = readVerifiedPdf(paths, docId);
      if (options.expectedHash !== undefined && options.expectedHash !== metadata.sha256)
        return { kind: "changed" };
      const annotations = options.annotations ? readPdfAnnotationsFile(paths, docId) : undefined;
      return {
        kind: "ok",
        metadata,
        bytes,
        title: owners[0].title,
        ...(annotations ? { annotations } : {}),
      };
    } catch (error) {
      return { kind: error instanceof PdfContentChangedError ? "changed" : "error" };
    }
  };
  /** What a failed PDF material request is, as the routes answer it. */
  const pdfMaterialFailure = (
    error: unknown
  ): { status: 400 | 409 | 500 | 503; detail: string } => {
    if (error instanceof PdfMaterialInputError) return { status: 400, detail: error.message };
    if (error instanceof PdfMaterialContentError)
      return { status: 409, detail: "document changed" };
    if (error instanceof PdfMaterialResourceError || error instanceof PdfQueueFullError)
      return { status: 503, detail: error.message };
    return { status: 500, detail: "PDF page material could not be produced" };
  };
  /**
   * The Copilot's PDF annotation writes. The original is read once and verified (and must be the one the request names)
   * before anything else; the text of a text annotation is resolved from that same verified snapshot outside the lock
   * (it is a function of the immutable original); then one critical section on the annotations lock re-verifies the
   * original and the revision and applies the plan to the sidecar as stored, so a stale request writes nothing and
   * every key the application does not know stays. A failure before the atomic rename leaves the stored bytes alone.
   */
  const pdfHistory = new PdfAnnotationHistory();
  const writePdfAnnotation = async (
    op: PdfAnnotationOperation,
    scope: { conversationId: string }
  ): Promise<PdfWriteOutcome> => {
    // A PDF action on a Doc that is not a PDF (a LaTeX Doc) is unsupported, not a verification failure.
    if (!badDocId(op.docId) && op.docId.trim()) {
      let metadataOrNull: ReturnType<typeof readPdfMetadataIfPresent> | undefined;
      try {
        metadataOrNull = readPdfMetadataIfPresent(paths, op.docId);
      } catch {
        metadataOrNull = undefined;
      }
      if (metadataOrNull === null && pdfOwners(op.docId).length > 0) return { kind: "unsupported" };
    }
    const historyKey = PdfAnnotationHistory.key(scope.conversationId, op.docId);
    const source = pdfSource(op.docId, { expectedHash: op.sha256 });
    if (source.kind === "bad_id" || source.kind === "not_found") return { kind: "not_found" };
    if (source.kind === "busy") return { kind: "busy" };
    if (source.kind === "changed")
      return {
        kind: "conflict",
        reason: "document_changed",
        epoch: { sha256: null, annotationsRev: null },
      };
    if (source.kind !== "ok")
      return {
        kind: "error",
        detail: "the PDF or its user data could not be verified; nothing was changed",
      };
    const { metadata, title } = source;
    let text: ResolvedTextTarget | undefined;
    if (op.action === "create_pdf_annotation" && op.parts) {
      try {
        const resolved = await resolvePdfTextTarget(
          source.bytes,
          metadata.sha256,
          op.parts,
          metadata.pages
        );
        if (!resolved.ok) return { kind: "invalid", detail: resolved.detail };
        text = resolved.target;
      } catch (error) {
        const failure = pdfMaterialFailure(error);
        return failure.status === 409
          ? {
              kind: "conflict",
              reason: "document_changed",
              epoch: { sha256: null, annotationsRev: null },
            }
          : failure.status === 400
            ? { kind: "invalid", detail: failure.detail }
            : { kind: "error", detail: `${failure.detail}; nothing was written` };
      }
    }
    let plan: PdfAnnotationPlan | undefined;
    let moved: { direction: "undo" | "redo"; label: string } | undefined;
    let nothing: "nothing" | "history_ended" | "changed" | undefined;
    try {
      // The history is recorded in the same critical section as the save, so no other write can come between a
      // saved revision and the history that describes it.
      const { commit, history } = await annotationLock.run(() => {
        const commit = commitPdfAnnotationChange<undefined>(
          paths,
          op.docId,
          { sha256: op.sha256, rev: op.rev },
          (current) => {
            if (op.action === "undo_pdf_annotation" || op.action === "redo_pdf_annotation") {
              const direction = op.action === "undo_pdf_annotation" ? "undo" : "redo";
              const step = pdfHistory.plan(historyKey, direction, current);
              if (step.kind === "none") {
                nothing = step.reason;
                return { skip: undefined };
              }
              moved = { direction, label: step.label };
              return { next: step.next };
            }
            try {
              plan =
                op.action === "create_pdf_annotation"
                  ? planPdfCreate(op, current, metadata, title, text)
                  : op.action === "update_pdf_annotation"
                    ? planPdfUpdate(op, current, title)
                    : planPdfDelete(op, current, title);
            } catch (error) {
              // A bug in the planner is the application's, never a damaged file.
              throw new PdfAnnotationValidationError(
                `the request could not be planned: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            return plan.kind === "write" ? { next: plan.next } : { skip: undefined };
          },
          (id) => docMutations.isDocumentContentBusy(id)
        );
        if (commit.kind !== "saved") return { commit, history: undefined };
        if (moved)
          pdfHistory.recordMove(
            historyKey,
            moved.direction,
            commit.file.rev,
            commit.file.annotations
          );
        else if (plan?.kind === "write") pdfHistory.recordChange(historyKey, plan, commit.file.rev);
        return { commit, history: pdfHistory.depth(historyKey) };
      });
      if (commit.kind === "busy") return { kind: "busy" };
      if (commit.kind === "document_changed")
        return {
          kind: "conflict",
          reason: "document_changed",
          epoch: { sha256: null, annotationsRev: null },
        };
      if (commit.kind === "rev_mismatch")
        return {
          kind: "conflict",
          reason: "rev_mismatch",
          epoch: { sha256: metadata.sha256, annotationsRev: commit.rev },
        };
      const epoch = { sha256: metadata.sha256, annotationsRev: commit.file.rev };
      if (commit.kind === "skipped") {
        if (nothing) return { kind: "nothing", reason: nothing, epoch };
        const skipped = plan as PdfAnnotationPlan | undefined;
        if (skipped?.kind === "same")
          return { kind: "unchanged", annotation: skipped.annotation, label: skipped.label, epoch };
        if (skipped?.kind === "annotation_changed")
          return {
            kind: "conflict",
            reason: "annotation_changed",
            epoch,
            annotation: skipped.annotation,
          };
        if (skipped?.kind === "no_annotation")
          return { kind: "no_annotation", annotationId: skipped.annotationId };
        if (skipped?.kind === "invalid") return { kind: "invalid", detail: skipped.detail };
        return { kind: "error", detail: "unexpected plan; nothing was written" };
      }
      annotationChanged(op.docId, "put");
      if (moved && history) {
        return {
          kind: "saved",
          label: moved.label,
          epoch,
          moved: moved.direction,
          history,
        };
      }
      const written = plan as PdfAnnotationPlan | undefined;
      if (written?.kind !== "write" || !history)
        return {
          kind: "error",
          detail: "unexpected plan; read the Doc again to see what is stored",
        };
      return {
        kind: "saved",
        ...(written.annotation ? { annotation: written.annotation } : {}),
        ...(written.deleted ? { deleted: written.deleted } : {}),
        label: written.label,
        epoch,
        history,
      };
    } catch (error) {
      // Nothing is reset and the sidecar is replaced atomically or not at all. What failed decides the words: a
      // change the application built that does not satisfy the contract is its own bug, not a damaged file.
      if (error instanceof PdfAnnotationValidationError)
        return {
          kind: "error",
          detail: `the application could not apply this change (${error.message}); nothing was written and the stored file was not touched. This is not a damaged file; tell the user`,
        };
      return {
        kind: "error",
        detail:
          "the PDF annotations could not be read or written (the stored file, if damaged, was left as it is); read the Doc again to see what is stored now",
      };
    }
  };
  /** The status a failed `pdfSource` answers on the PDF material routes. */
  const pdfSourceFailure = (docId: string, kind: Exclude<PdfSource["kind"], "ok">) => {
    switch (kind) {
      case "bad_id":
        return detail("bad doc id", 400);
      case "busy":
        return { body: { detail: DOCUMENT_BUSY }, status: 409 as const };
      case "not_found":
        return detail(`paper ${pyRepr(docId)} not found`, 404);
      case "changed":
        return { body: { detail: "document changed" }, status: 409 as const };
      case "inconsistent":
        return detail(`PDF document ${pyRepr(docId)} has inconsistent Work ownership`, 500);
      default:
        return detail(`PDF document ${pyRepr(docId)} cannot be verified`, 500);
    }
  };
  return {
    owners: pdfOwners,
    source: pdfSource,
    writeAnnotation: writePdfAnnotation,
    materialFailure: pdfMaterialFailure,
    sourceFailure: pdfSourceFailure,
  };
}
