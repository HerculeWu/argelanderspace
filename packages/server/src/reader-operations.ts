/**
 * The reading and annotation operations of the catalog (release-0.2 ticket 07), as functions over the Reader's data
 * seam (`ReaderOpDeps`, built by `createReaderOps`). Three groups:
 *
 * - the annotation writes: how a write outcome reads as the answer (the status, the new epoch, what to do next). The
 *   Copilot `reader` tool and `argelanderspace annotation ...` both call these, so the words and the data protection
 *   (a stale epoch writes nothing, a system error is never a mismatch, the access path alone archives) are one code;
 * - the reads of a whole Doc (`runReaderRead`) and of its pictures: the CLI form of the Copilot's reads. The Copilot
 *   fits a reading to the room left in its model's window and sends pictures as image parts; these have no window,
 *   so a reading is whole and a picture is returned as base64 in `data`;
 * - the text source read.
 */

import { createHash } from "node:crypto";
import {
  buildPdfReading,
  type CopilotOperation,
  PDF_IMAGE_LONG_EDGE,
  PDF_IMAGE_MAX_BYTES,
  type PdfAnnotationOperation,
  type ReaderWriteOperation,
} from "@argelanderspace/contracts";
import { sniffImage, TextAssetError } from "@argelanderspace/core";
import { pdfBatch, pdfVersion, readerBatch, readerVersion } from "./copilot-batching.js";
import type { ReaderOpDeps } from "./copilot-reader-tool.js";
import { renderSvgFigure, type SvgEngine } from "./svg-raster.js";

/** An answer and what the Copilot's operation record says of it (without `object`, which the caller knows). */
export interface WriteAnswer {
  payload: Record<string, unknown>;
  record: Partial<CopilotOperation>;
}

const REREAD = "read the Doc again (reader read) to see what is stored now";

/** A LaTeX or text Doc's annotation write: create_annotation, update_annotation, delete_annotation. */
export async function runReaderWrite(
  reader: ReaderOpDeps,
  op: ReaderWriteOperation
): Promise<WriteAnswer> {
  const outcome = await reader.write(op);
  const older = (n: number | undefined) =>
    n === undefined
      ? {}
      : {
          archivedOlder: n,
          archivedNote: `this call found the Doc's text replaced and archived ${n} annotation(s) of the older text (they are no longer current and cannot be read or written; tell the user)`,
        };
  switch (outcome.kind) {
    case "saved":
      return {
        record: { status: "ok", label: outcome.label, rev: outcome.epoch.annotationsRev },
        payload: {
          ok: true,
          status: "ok",
          ...(outcome.annotation ? { annotation: outcome.annotation } : {}),
          ...(outcome.deleted ? { deleted: outcome.deleted } : {}),
          ...(outcome.expanded
            ? {
                widened:
                  "the range touched the inside of a math, cite or xref mark and was widened to the whole mark, as selecting it in the Reader does; annotation.target holds what was saved",
              }
            : {}),
          epoch: outcome.epoch,
          observed:
            "saved through the page's own save; the user's Reader shows it at once. The new epoch.annotationsRev replaces the one you sent; an update or delete of an annotation needs its updated_at from a reading, or from annotation here",
          ...older(outcome.archived),
        },
      };
    case "unchanged":
      return {
        record: { status: "noop", label: outcome.label, rev: outcome.epoch.annotationsRev },
        payload: {
          ok: true,
          status: "noop",
          detail: "the body bytes are exactly what is stored; nothing was written",
          annotation: outcome.annotation,
          epoch: outcome.epoch,
          ...older(outcome.archived),
        },
      };
    case "conflict":
      return {
        record: { status: "conflict", rev: outcome.epoch.annotationsRev },
        payload: {
          ok: false,
          status: "conflict",
          reason: outcome.reason,
          current: outcome.epoch,
          ...(outcome.annotation ? { annotation: outcome.annotation } : {}),
          detail:
            outcome.reason === "document_changed"
              ? `the Doc's text is not the one your reading was of (it was replaced; annotations of the older text are no longer current). Nothing was written. ${REREAD}, then form a new request from that`
              : outcome.reason === "annotation_changed"
                ? `this annotation was changed after your reading (its body is not the one you saw; annotation shows it now). Nothing was written. ${REREAD}, decide again from what the user wrote, then form a new request with the updated_at of that reading; never reuse the old one`
                : `the annotations changed since your reading (the user or another call saved first). Nothing was written. ${REREAD}, then form a new request from that; do not resend with the new revision`,
          ...older(outcome.archived),
        },
      };
    case "no_annotation":
      return {
        record: { status: "not_found" },
        payload: {
          ok: false,
          status: "not_found",
          detail: `no annotation ${outcome.annotationId} in this epoch (it may have been deleted); nothing was written. ${REREAD}`,
          ...older(outcome.archived),
        },
      };
    case "invalid":
      return {
        record: { status: "invalid" },
        payload: {
          ok: false,
          status: "invalid",
          detail: `${outcome.detail}; nothing was written`,
          ...older(outcome.archived),
        },
      };
    case "not_found":
      return {
        record: { status: "not_found" },
        payload: { ok: false, status: "not_found", detail: "no such Doc" },
      };
    case "busy":
      return {
        record: { status: "rejected" },
        payload: {
          ok: false,
          status: "rejected",
          detail:
            "the Doc is being replaced or deleted right now; nothing was written. Try again when the job has finished",
        },
      };
    case "pdf":
      return {
        record: { status: "unsupported" },
        payload: {
          ok: false,
          status: "unsupported",
          detail:
            "this is a PDF Doc; create_annotation, update_annotation and delete_annotation are for LaTeX and text Docs. A PDF Doc's workbench annotations are written with create_pdf_annotation, update_pdf_annotation, delete_pdf_annotation, undo_pdf_annotation and redo_pdf_annotation (sha256 and rev from the PDF reading); nothing was written",
        },
      };
    case "error":
      return {
        record: { status: "error" },
        payload: {
          ok: false,
          status: "error",
          detail: outcome.detail,
          ...(outcome.archivedOlder ? { archivedOlder: true } : {}),
        },
      };
  }
}

/**
 * The PDF workbench annotation writes (and the Copilot's undo/redo, which the catalog does not carry). `scope` names
 * whose changes undo and redo may reach: the conversation that makes them; an operation of the catalog uses its own
 * scope, so it can neither undo a conversation's changes nor be undone by one.
 */
export async function runPdfWrite(
  reader: ReaderOpDeps,
  op: PdfAnnotationOperation,
  scope: { conversationId: string }
): Promise<WriteAnswer> {
  if (!reader.pdf?.write)
    return {
      record: { status: "unsupported" },
      payload: {
        ok: false,
        status: "unsupported",
        detail: "PDF annotation writes are not available in this host; nothing was written",
      },
    };
  const outcome = await reader.pdf.write(op, scope);
  switch (outcome.kind) {
    case "saved":
      return {
        record: { status: "ok", label: outcome.label, rev: outcome.epoch.annotationsRev },
        payload: {
          ok: true,
          status: "ok",
          ...(outcome.annotation ? { annotation: outcome.annotation } : {}),
          ...(outcome.deleted ? { deleted: outcome.deleted } : {}),
          ...(outcome.moved ? { [outcome.moved === "undo" ? "undone" : "redone"]: true } : {}),
          epoch: outcome.epoch,
          history: outcome.history,
          observed:
            "saved through the page's own save rules (the original's SHA-256 and the revision were checked in the same critical section); the open PDF Reader shows it at once. epoch.annotationsRev replaces the revision you sent. An update or delete of an annotation needs its updated_at from a reading, or from annotation here",
        },
      };
    case "unchanged":
      return {
        record: { status: "noop", label: outcome.label, rev: outcome.epoch.annotationsRev },
        payload: {
          ok: true,
          status: "noop",
          detail: "the annotation already has exactly this content; nothing was written",
          annotation: outcome.annotation,
          epoch: outcome.epoch,
        },
      };
    case "nothing":
      return {
        record: { status: "noop", rev: outcome.epoch.annotationsRev },
        payload: {
          ok: true,
          status: "noop",
          reason: outcome.reason,
          detail:
            outcome.reason === "history_ended"
              ? "the annotations were changed by someone else (the user or another call) after your last change, which ends the history, as it ends the panel's undo history; nothing was changed"
              : outcome.reason === "changed"
                ? "the stored annotations are not what your last change left, so they were not overwritten and the history ended; nothing was changed"
                : "there is nothing to undo or redo: only changes you made to this Doc through this tool can be undone, and the service keeps them only until it restarts; nothing was changed",
          epoch: outcome.epoch,
        },
      };
    case "conflict":
      return {
        record: {
          status: "conflict",
          ...(outcome.epoch.annotationsRev !== null ? { rev: outcome.epoch.annotationsRev } : {}),
        },
        payload: {
          ok: false,
          status: "conflict",
          reason: outcome.reason,
          current: outcome.epoch,
          ...(outcome.annotation ? { annotation: outcome.annotation } : {}),
          detail:
            outcome.reason === "document_changed"
              ? `the PDF is not the original your reading was of (document changed). Nothing was written. ${REREAD}, then form a new request from that`
              : outcome.reason === "annotation_changed"
                ? `this annotation was changed after your reading (annotation shows it now). Nothing was written. ${REREAD}, decide again from what is stored, then form a new request with the updated_at of that reading; never reuse the old one`
                : `the annotations changed since your reading (the user or another call saved first; current shows the revision). Nothing was written. ${REREAD}, then form a new request from that; do not resend with the new revision`,
        },
      };
    case "no_annotation":
      return {
        record: { status: "not_found" },
        payload: {
          ok: false,
          status: "not_found",
          detail: `no annotation ${outcome.annotationId} in this PDF (it may have been deleted); nothing was written. ${REREAD}`,
        },
      };
    case "invalid":
      return {
        record: { status: "invalid" },
        payload: {
          ok: false,
          status: "invalid",
          detail: `${outcome.detail}; nothing was written`,
        },
      };
    case "unsupported":
      return {
        record: { status: "unsupported" },
        payload: {
          ok: false,
          status: "unsupported",
          detail:
            "this Doc is not a PDF: the PDF annotation actions are for PDF Docs; a LaTeX or text Doc's annotations are written with create_annotation, update_annotation and delete_annotation; nothing was written",
        },
      };
    case "not_found":
      return {
        record: { status: "not_found" },
        payload: { ok: false, status: "not_found", detail: "no such PDF Doc" },
      };
    case "busy":
      return {
        record: { status: "rejected" },
        payload: {
          ok: false,
          status: "rejected",
          detail:
            "the Doc is being replaced or deleted right now; nothing was written. Try again when the job has finished",
        },
      };
    case "error":
      return {
        record: { status: "error" },
        payload: { ok: false, status: "error", detail: outcome.detail },
      };
  }
}

/** The scope of a catalog operation's PDF writes: its own, apart from every Copilot conversation. */
export const CATALOG_PDF_SCOPE = { conversationId: "operation-catalog" } as const;

// ---- Reads ------------------------------------------------------------------------------------------- //

type Payload = Record<string, unknown>;

/** The refusal of a PDF read or image, in the Copilot's words. */
function pdfRefusal(
  outcome: {
    kind: "not_found" | "busy" | "changed" | "resource" | "invalid" | "error";
    detail?: string;
  },
  nothing: "read" | "returned"
): Payload {
  switch (outcome.kind) {
    case "not_found":
      return { ok: false, status: "not_found", detail: "no such PDF Doc" };
    case "busy":
      return {
        ok: false,
        status: "rejected",
        detail: `the Doc is being replaced or deleted right now; nothing was ${nothing}. Try again when the job has finished`,
      };
    case "changed":
      return {
        ok: false,
        status: "conflict",
        detail:
          "the PDF is not the original your reading was of (document changed); nothing was returned. Read the Doc again (reader read) and use its sha256",
      };
    case "invalid":
      return {
        ok: false,
        status: "invalid",
        detail: `${outcome.detail ?? "invalid request"}; nothing was returned`,
      };
    case "resource":
      return {
        ok: false,
        status: "error",
        detail: `${outcome.detail ?? "the PDF engine is short of memory"}; try again later`,
      };
    default:
      return {
        ok: false,
        status: "error",
        detail: outcome.detail ?? "the PDF could not be read",
      };
  }
}

/** A continuation (`from` > 0) names the version of the parts already read; a document that changed is a conflict. */
function versionGate(
  from: number,
  expected: string | undefined,
  current: string,
  total: number,
  unit: string
): Payload | null {
  if (from === 0) return null;
  if (!expected)
    return {
      ok: false,
      status: "invalid",
      detail:
        "a continuation (from > 0) needs version: the batch.version of the part you are continuing; nothing was returned",
    };
  if (expected === current) return null;
  return {
    ok: false,
    status: "conflict",
    reason: "version_changed",
    detail: `the document changed since the parts you read (their version ${expected}, now ${current}); parts of two versions are never joined, so nothing was returned. Read it again from 0`,
    version: current,
    total,
    unit,
  };
}

/**
 * `reader read`: the whole Doc as stored right now (a LaTeX/text reading from the read-only background read, or a PDF's
 * verified pages), with the fingerprint (or SHA-256) and annotation revision the annotation writes are planned against.
 * There is no window to fit, so the reading is whole; `from` and `version` still select a later part when asked.
 */
export async function runReaderRead(
  reader: ReaderOpDeps,
  params: { docId: string; from?: number | undefined; version?: string | undefined }
): Promise<Payload> {
  const outcome = await reader.read(params.docId);
  if (outcome.kind === "not_found")
    return { ok: false, status: "not_found", detail: "no such Doc" };
  if (outcome.kind === "busy")
    return {
      ok: false,
      status: "rejected",
      detail:
        "the Doc is being replaced or deleted right now; nothing was read. Try again when the job has finished",
    };
  if (outcome.kind === "error") return { ok: false, status: "error", detail: outcome.detail };
  const from = params.from ?? 0;
  if (outcome.kind === "pdf") {
    if (!reader.pdf)
      return {
        ok: false,
        status: "unsupported",
        detail: "this is a PDF Doc and PDF material is not available in this host",
      };
    const material = await reader.pdf.read(params.docId);
    if (material.kind !== "ok") return pdfRefusal(material, "read");
    const reading = buildPdfReading(material.material, true);
    if (from > reading.pages.length || (from === reading.pages.length && from > 0))
      return {
        ok: false,
        status: "invalid",
        detail: `from ${from} is beyond the document: it has ${reading.pages.length} pages (zero-based 0..${reading.pages.length - 1}); nothing was returned`,
      };
    const gated = versionGate(
      from,
      params.version,
      pdfVersion(reading),
      reading.pages.length,
      "pages"
    );
    if (gated) return gated;
    const batched = pdfBatch(
      reading,
      from,
      Number.POSITIVE_INFINITY,
      "the PDF's pages as stored right now, from the verified original (zero-based pageIndex; text only where the page has a text layer). Pages in imageOnlyPages are readable only from their image (reader read-page-image)"
    );
    return batched.kind === "ok"
      ? (batched.payload as Payload)
      : { ok: false, status: "rejected", detail: batched.detail };
  }
  const total = outcome.reading.entries.length;
  if (from > total || (from === total && from > 0))
    return {
      ok: false,
      status: "invalid",
      detail: `from ${from} is beyond the document: it has ${total} entries (zero-based 0..${total - 1}); nothing was returned`,
    };
  const gated = versionGate(from, params.version, readerVersion(outcome.reading), total, "entries");
  if (gated) return gated;
  const batched = readerBatch(
    outcome.reading,
    from,
    Number.POSITIVE_INFINITY,
    "the Doc as stored right now (one coherent read); the user may change annotations afterwards, so read again before relying on them"
  );
  return batched.kind === "ok"
    ? (batched.payload as Payload)
    : { ok: false, status: "rejected", detail: batched.detail };
}

/** The hash-verified bytes of one picture of a LaTeX/text Doc, or the refusal. */
async function pictureBytes(
  reader: ReaderOpDeps,
  op: { docId: string; path: string; sha256: string }
): Promise<{ bytes: Buffer; sha256: string } | Payload> {
  if (!reader.asset)
    return {
      ok: false,
      status: "unsupported",
      detail: "document pictures are not available in this host",
    };
  const outcome = await reader.asset(op);
  switch (outcome.kind) {
    case "ok":
      return { bytes: outcome.bytes, sha256: outcome.sha256 };
    case "changed":
      return {
        ok: false,
        status: "conflict",
        detail:
          "the picture is not the file your reading listed (its sha256 differs); nothing was returned. Read the Doc again (reader read) and use the sha256 it lists",
      };
    case "not_found":
      return {
        ok: false,
        status: "not_found",
        detail:
          "no such Doc or no such picture in it (use the asset path from the reading); nothing was returned",
      };
    case "busy":
      return {
        ok: false,
        status: "rejected",
        detail:
          "the Doc is being replaced or deleted right now; nothing was returned. Try again when it has finished",
      };
    case "invalid":
      return { ok: false, status: "invalid", detail: `${outcome.detail}; nothing was returned` };
    default:
      return { ok: false, status: "error", detail: outcome.detail };
  }
}

const isBytes = (value: unknown): value is { bytes: Buffer; sha256: string } =>
  typeof value === "object" && value !== null && "bytes" in value;

/** `reader read-image`: PNG, JPEG or WebP, base64 in `data`. Nothing is converted. */
export async function runReadImage(
  reader: ReaderOpDeps,
  op: { docId: string; path: string; sha256: string }
): Promise<Payload> {
  const got = await pictureBytes(reader, op);
  if (!isBytes(got)) return got;
  if (got.bytes.length > PDF_IMAGE_MAX_BYTES)
    return {
      ok: false,
      status: "rejected",
      detail: `capacity: this image is ${got.bytes.length} bytes, more than the ${PDF_IMAGE_MAX_BYTES} bytes one image may be; nothing was returned`,
    };
  let sniffed: ReturnType<typeof sniffImage>;
  try {
    sniffed = sniffImage(got.bytes);
  } catch (error) {
    const code = error instanceof TextAssetError ? error.code : "";
    if (code === "too_large" || code === "too_many_pixels")
      return {
        ok: false,
        status: "rejected",
        detail: `capacity: ${error instanceof Error ? error.message : "this picture is too large"}; nothing was returned`,
      };
    const svg = /<svg[\s>]/i.test(got.bytes.subarray(0, 4096).toString("utf8"));
    return {
      ok: false,
      status: "unsupported",
      detail: svg
        ? "this picture is an SVG; reader read-svg-image renders it to a bounded PNG (nothing is stored)"
        : `this picture cannot be returned (${error instanceof Error ? error.message : "unknown format"}; PNG, JPEG and WebP only). Nothing was converted`,
    };
  }
  return {
    ok: true,
    status: "ok",
    observed: "the picture of the document as the Reader shows it (base64 in data)",
    image: {
      path: op.path,
      width: sniffed.width,
      height: sniffed.height,
      mediaType: sniffed.mediaType,
      byteLength: got.bytes.length,
    },
    sha256: got.sha256,
    data: got.bytes.toString("base64"),
  };
}

/** `reader read-svg-image`: an SVG figure drawn to a PNG of at most `longEdge` on its longer side; nothing is stored. */
export async function runReadSvgImage(
  reader: ReaderOpDeps,
  op: { docId: string; path: string; sha256: string; longEdge?: number | undefined },
  svgEngine?: SvgEngine | null
): Promise<Payload> {
  const got = await pictureBytes(reader, op);
  if (!isBytes(got)) return got;
  const rendered = await renderSvgFigure(
    got.bytes,
    op.longEdge ?? PDF_IMAGE_LONG_EDGE.default,
    svgEngine
  );
  switch (rendered.kind) {
    case "not_svg":
      return {
        ok: false,
        status: "invalid",
        detail:
          "this picture is not an SVG (use reader read-image for PNG, JPEG and WebP); nothing was returned",
      };
    case "too_large":
      return {
        ok: false,
        status: "rejected",
        detail: "capacity: this SVG is larger than 2 MiB; nothing was returned",
      };
    case "unsafe":
      return {
        ok: false,
        status: "rejected",
        detail: `this SVG was NOT rendered: ${rendered.reason}. Nothing was returned and nothing was changed`,
      };
    case "invalid":
      return { ok: false, status: "invalid", detail: `${rendered.detail}; nothing was returned` };
    case "unavailable":
      return {
        ok: false,
        status: "unsupported",
        detail:
          "the SVG renderer is not installed in this build, so SVG figures cannot be rendered; nothing was returned",
      };
    default:
      break;
  }
  if (rendered.png.length > PDF_IMAGE_MAX_BYTES)
    return {
      ok: false,
      status: "rejected",
      detail: `capacity: the rendered image is ${rendered.png.length} bytes, more than the ${PDF_IMAGE_MAX_BYTES} bytes one image may be; ask again with a smaller --long-edge. Nothing was returned`,
    };
  return {
    ok: true,
    status: "ok",
    observed: "the SVG figure drawn as a PNG (base64 in data); nothing was stored or changed",
    image: {
      path: op.path,
      width: rendered.width,
      height: rendered.height,
      mediaType: "image/png",
      byteLength: rendered.png.length,
      renderedFrom: "svg",
    },
    sha256: got.sha256,
    data: rendered.png.toString("base64"),
  };
}

/** `reader read-page-image`: one original page of a PDF Doc as a PNG, base64 in `data`. */
export async function runReadPageImage(
  reader: ReaderOpDeps,
  op: { docId: string; pageIndex: number; sha256: string; longEdge?: number | undefined }
): Promise<Payload> {
  if (!reader.pdf)
    return {
      ok: false,
      status: "unsupported",
      detail: "PDF page images are not available in this host",
    };
  const outcome = await reader.pdf.image({
    docId: op.docId,
    pageIndex: op.pageIndex,
    sha256: op.sha256,
    ...(op.longEdge ? { longEdge: op.longEdge } : {}),
  });
  if (outcome.kind !== "ok") return pdfRefusal(outcome, "returned");
  if (outcome.png.length > PDF_IMAGE_MAX_BYTES)
    return {
      ok: false,
      status: "rejected",
      detail: `capacity: this image is ${outcome.png.length} bytes, more than the ${PDF_IMAGE_MAX_BYTES} bytes one image may be; ask again with a smaller --long-edge. Nothing was returned`,
    };
  return {
    ok: true,
    status: "ok",
    observed: "the original page as a PNG (base64 in data)",
    page: {
      pageIndex: outcome.pageIndex,
      pageCount: outcome.pageCount,
      imageWidth: outcome.width,
      imageHeight: outcome.height,
      hasTextLayer: outcome.hasTextLayer,
    },
    sha256: outcome.contentSha256,
    data: outcome.png.toString("base64"),
  };
}

// ---- Text source -------------------------------------------------------------------------------------- //

/** What the text Doc service answers to a source read (`TextDocService.read`). */
export interface TextSourceReader {
  read(docId: string):
    | {
        ok: true;
        value: {
          doc_id: string;
          rev: number;
          markdown: string;
          assets: unknown;
          generated: boolean;
          published_source_rev: number | null;
          source_pdf?: unknown;
        };
      }
    | { ok: false; status: number; body: unknown };
}

/**
 * `text read-source`: the saved Markdown source with its rev and assets. A source is returned whole; `from` and
 * `version` select a later part of it when asked (the version is the rev and a hash of the text).
 */
export function runTextReadSource(
  text: TextSourceReader,
  params: { docId: string; from?: number | undefined; version?: string | undefined }
): Payload {
  const result = text.read(params.docId);
  if (!result.ok) {
    const detail =
      (result.body as { detail?: string } | null)?.detail ?? "the source could not be read";
    return result.status === 404
      ? { ok: false, status: "not_found", detail: `${detail}; nothing was returned` }
      : { ok: false, status: "error", detail: `${detail}; nothing was returned` };
  }
  const source = result.value;
  const version = `${source.rev}:${createHash("sha256").update(source.markdown).digest("hex").slice(0, 12)}`;
  const from = params.from ?? 0;
  const total = source.markdown.length;
  if (from > total || (from === total && from > 0))
    return {
      ok: false,
      status: "invalid",
      detail: `from ${from} is beyond the source: it has ${total} characters; nothing was returned`,
    };
  if (from > 0 && params.version !== version)
    return {
      ok: false,
      status: "conflict",
      reason: "version_changed",
      version,
      detail: params.version
        ? "the source changed since the parts you read (parts of two versions are never joined); read it again from 0"
        : "a continuation (from > 0) needs version: the version of the part you are continuing",
    };
  return {
    ok: true,
    status: "ok",
    observed: "the saved source as stored right now",
    docId: source.doc_id,
    rev: source.rev,
    version,
    generated: source.generated,
    publishedSourceRev: source.published_source_rev,
    ...(source.source_pdf ? { sourcePdf: source.source_pdf } : {}),
    assets: source.assets,
    markdown: source.markdown.slice(from),
    batch: { from, to: total, total, unit: "characters", status: "complete" },
  };
}
