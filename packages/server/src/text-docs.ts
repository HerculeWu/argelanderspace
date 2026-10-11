/**
 * The text Doc's HTTP surface (copilot ticket 25): create under a Work, read/save the Markdown source, validate and
 * explicitly generate the reading version.
 *
 * Ordering and locks (one place so the contracts' data-protection rules stay readable):
 * - Source saves are SYNCHRONOUS critical sections on `textLock` that first refuse while the Doc is being deleted
 *   (`docMutations.isDeleting`); a synchronous check-and-write cannot interleave with the delete handler, so no
 *   registry pin is needed (a pin would make every autosave a "document busy" answer for the Reader).
 * - Generation reads and parses the saved source WITHOUT any lock (typing continues), then publishes inside
 *   `textLock` + `annotationLock` in one synchronous section that re-reads the source revision: a candidate made from
 *   an older source is refused (`stale`), never published. A writer pin keeps the Doc from being deleted meanwhile.
 * - Publishing is one atomic rename of `<docId>.json`. When the candidate would change the annotation-addressable
 *   content and the current annotations are not empty, the request is answered `confirmation_required` with the
 *   impact (annotation count, annotations revision, old/new fingerprint, source revisions) and NOTHING is written. The
 *   real user's click sends those values back as `confirm`; they are compared inside the same critical section as the
 *   write (`confirmation_changed` with the fresh values when anything moved). Nothing is held while the user decides:
 *   the pin and the generating mark are released with the answer. Annotations, a published text or a fingerprint that
 *   cannot be read or computed are system errors (500), never a mismatch and never confirmable. The generator never
 *   archives and never announces `annotation.changed`; only the annotations GET/PUT access path archives.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AddPdfImageRequestSchema,
  CreateTextDocRequestSchema,
  type DocDescription,
  GenerateTextDocRequestSchema,
  PutTextSourceRequestSchema,
  TEXT_ASSET_MAX_BYTES,
  TEXT_PDF_IMAGE_LONG_EDGE,
  type TextAssetAdded,
  type TextDiagnostic,
  type TextDocIr,
  type TextDocSource,
  type TextGenerationResult,
  type TextReplacementImpact,
  type TextSourceDto,
  type TextValidationResult,
  ValidateTextSourceRequestSchema,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import {
  addTextAsset,
  annotationsDocDir,
  createTextDoc,
  docContentFingerprint,
  isTextDoc,
  isTextDocId,
  type LibraryPaths,
  LibraryStore,
  PdfContentChangedError,
  parseTextSource,
  publishTextIr,
  readAnnotationRisk,
  readPdfMetadataIfPresent,
  readPublishedTextIr,
  readTextAsset,
  readTextSource,
  readVerifiedPdf,
  saveTextSource,
  TextAssetError,
  TextDocError,
} from "@argelanderspace/core";
import type { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { badDocId } from "./doc-id.js";
import type { DocMutationRegistry } from "./doc-mutations.js";
import { AsyncLock } from "./lock.js";

/** The longest Markdown source accepted in one save. */
export const TEXT_SOURCE_MAX_CHARS = 8 * 1024 * 1024;

export interface TextDocDeps {
  paths: LibraryPaths;
  libraryLock: AsyncLock;
  annotationLock: AsyncLock;
  docMutations: DocMutationRegistry;
  broadcast: (msg: WsServerMessage) => void;
  /** A Doc was added to the library file (the page reloads its Works). */
  libraryChanged: () => void;
  /**
   * The picture of a source PDF's page or region (copilot ticket 29): the ONE read of PDF page material (busy check,
   * unique owner, original verified against its immutable SHA-256 and the hash the caller names, the shared PDFium
   * queue). Absent in hosts without a PDF engine.
   */
  renderPdfRegion?: (request: {
    pdfDocId: string;
    expectedHash: string;
    pageIndex: number;
    region?: { x: number; y: number; width: number; height: number };
    longEdge: number;
  }) => Promise<PdfRegionOutcome>;
  /** Test seam: runs after the candidate is built and before the publish critical section. */
  beforePublish?: (docId: string) => Promise<void> | void;
}

export type ReplacementProbe =
  | { kind: "impact"; impact: TextReplacementImpact | null }
  | { kind: "changed" }
  | { kind: "error"; code: string; detail: string };

export type PdfRegionOutcome =
  | { kind: "ok"; png: Buffer; width: number; height: number }
  | { kind: "not_found" | "busy" | "changed" | "inconsistent" | "error" }
  | { kind: "invalid" | "resource"; detail: string };

/** A confirmation counts only when every bound value is exactly what the publish critical section sees now. */
function sameImpact(a: TextReplacementImpact, b: TextReplacementImpact): boolean {
  return (
    a.docId === b.docId &&
    a.sourceRev === b.sourceRev &&
    a.publishedSourceRev === b.publishedSourceRev &&
    a.annotations === b.annotations &&
    a.annotationsRev === b.annotationsRev &&
    a.oldFingerprint === b.oldFingerprint &&
    a.newFingerprint === b.newFingerprint
  );
}

export type TextFailure = { status: ContentfulStatusCode; body: Record<string, unknown> };
const fail = (
  status: ContentfulStatusCode,
  detail: string,
  extra: Record<string, unknown> = {}
): TextFailure => ({
  status,
  body: { detail, ...extra },
});

type Ok<T> = { ok: true; value: T; status?: ContentfulStatusCode; duplicate?: boolean };
type Result<T> = Ok<T> | ({ ok: false } & TextFailure);
const ok = <T>(value: T, status?: ContentfulStatusCode): Ok<T> => ({
  ok: true,
  value,
  ...(status ? { status } : {}),
});
const failed = (
  status: ContentfulStatusCode,
  detail: string,
  extra: Record<string, unknown> = {}
) => ({ ok: false, ...fail(status, detail, extra) }) as const;

/** The HTTP answer for each refusal of an image upload; the code is stable for the page and the agent. */
const ASSET_STATUS: Record<TextAssetError["code"], ContentfulStatusCode> = {
  bad_name: 400,
  empty: 400,
  too_large: 413,
  unsupported_type: 415,
  corrupt_image: 422,
  too_many_pixels: 422,
  too_many_assets: 409,
  unsafe: 500,
  write_failed: 500,
};

function errorFailure(error: unknown): TextFailure {
  if (error instanceof TextAssetError)
    return fail(ASSET_STATUS[error.code], error.message, { code: error.code });
  if (error instanceof TextDocError) {
    switch (error.code) {
      case "bad_id":
        return fail(400, "bad doc id");
      case "not_found":
      case "work_not_found":
        return fail(404, error.message);
      case "operation_mismatch":
      case "operation_gone":
        return fail(409, error.message);
      default:
        return fail(500, error.message);
    }
  }
  return fail(500, error instanceof Error ? error.message : "text document operation failed");
}

export class TextDocService {
  private readonly textLock = new AsyncLock();
  private readonly generating = new Set<string>();
  private readonly finished = new Map<string, TextGenerationResult>();

  constructor(private readonly deps: TextDocDeps) {}

  private get paths(): LibraryPaths {
    return this.deps.paths;
  }

  /** Whether this Doc is a text Doc (a source marker, not an id guess). */
  has(docId: string): boolean {
    return isTextDocId(docId) && isTextDoc(this.paths, docId);
  }

  private dto(source: TextDocSource): TextSourceDto {
    const ir = readPublishedTextIr(this.paths, source.doc_id);
    return {
      doc_id: source.doc_id,
      rev: source.rev,
      input_version: source.input_version,
      markdown: source.markdown,
      assets: source.assets,
      created_at: source.created_at,
      updated_at: source.updated_at,
      ...(source.source_pdf ? { source_pdf: source.source_pdf } : {}),
      generated: ir !== null,
      published_source_rev: ir ? ir.source.source_rev : null,
    };
  }

  /**
   * What the delete confirmation may say about annotations of a text Doc that was never generated: with no reading
   * text no annotation can be bound, so "0" is known only when `annotations/<id>` truly does not exist; if it does,
   * the count is unknown (never inferred as zero). A generated Doc is counted the ordinary way (`generated: true`).
   */
  draftAnnotationImpact(docId: string):
    | { generated: true }
    | {
        generated: false;
        annotations: { state: "known"; count: number } | { state: "unknown" };
      } {
    if (existsSync(join(this.paths.outputDir, docId, `${docId}.json`))) return { generated: true };
    return {
      generated: false,
      annotations: existsSync(annotationsDocDir(this.paths.dataDir, docId))
        ? { state: "unknown" }
        : { state: "known", count: 0 },
    };
  }

  describe(docId: string): DocDescription {
    const source = readTextSource(this.paths, docId);
    const ir = readPublishedTextIr(this.paths, docId);
    return {
      doc_id: docId,
      format: "text",
      generated: ir !== null,
      source_rev: source.rev,
      published_source_rev: ir ? ir.source.source_rev : null,
      ...(ir?.title ? { title: ir.title } : {}),
      ...(source.source_pdf ? { source_pdf: source.source_pdf } : {}),
    };
  }

  // ---- create ---------------------------------------------------------------- //

  async create(
    body: unknown
  ): Promise<Result<{ description: DocDescription; source: TextSourceDto }>> {
    const parsed = CreateTextDocRequestSchema.safeParse(body);
    if (!parsed.success) return failed(400, "request body is not a valid text Doc request");
    const { workId, sourcePdfDocId, operationId } = parsed.data;
    try {
      const result = await this.deps.libraryLock.run(() => {
        let sourcePdf: { doc_id: string; sha256: string } | undefined;
        const work = LibraryStore.load(this.paths).get(workId);
        if (!work) return failed(404, `work '${workId}' not found`);
        if (sourcePdfDocId !== undefined) {
          // The source is a file relation to a PDF Doc of this Work: its original bytes are verified against the
          // fixed SHA-256, and a PDF Doc must belong to exactly one Work (anything else is a data error).
          if (!work.doc_ids.includes(sourcePdfDocId))
            return failed(400, "the source must be a PDF Doc of the same Work", {
              code: "bad_source_pdf",
            });
          try {
            const owners = LibraryStore.load(this.paths).works.filter((w) =>
              w.doc_ids.includes(sourcePdfDocId)
            );
            if (owners.length !== 1)
              return failed(500, "the source PDF has inconsistent Work ownership");
            const metadata = readPdfMetadataIfPresent(this.paths, sourcePdfDocId);
            if (!metadata)
              return failed(400, "the source must be a PDF Doc of the same Work", {
                code: "bad_source_pdf",
              });
            readVerifiedPdf(this.paths, sourcePdfDocId);
            sourcePdf = { doc_id: metadata.doc_id, sha256: metadata.sha256 };
          } catch (error) {
            return error instanceof PdfContentChangedError
              ? failed(409, "document changed")
              : failed(500, "the source PDF could not be verified");
          }
        }
        const made = createTextDoc(this.paths, {
          operationId,
          workId,
          ...(sourcePdf ? { sourcePdf } : {}),
        });
        return ok(made, made.created ? 201 : 200);
      });
      if (!result.ok) return result;
      // announced as soon as library.json changed, whatever is read back below
      if (result.value.libraryChanged) this.deps.libraryChanged();
      const made = result.value;
      if (made.created) {
        // a Doc that was just committed is answered from what was written; a read-back problem must not turn a
        // committed creation into a reported failure
        return ok(
          {
            description: {
              doc_id: made.docId,
              format: "text",
              generated: false,
              source_rev: made.source.rev,
              published_source_rev: null,
              ...(made.source.source_pdf ? { source_pdf: made.source.source_pdf } : {}),
            },
            source: {
              doc_id: made.docId,
              rev: made.source.rev,
              input_version: made.source.input_version,
              markdown: made.source.markdown,
              assets: made.source.assets,
              created_at: made.source.created_at,
              updated_at: made.source.updated_at,
              ...(made.source.source_pdf ? { source_pdf: made.source.source_pdf } : {}),
              generated: false,
              published_source_rev: null,
            },
          },
          201
        );
      }
      return ok({ description: this.describe(made.docId), source: this.dto(made.source) }, 200);
    } catch (error) {
      const f = errorFailure(error);
      return { ok: false, ...f };
    }
  }

  // ---- source ---------------------------------------------------------------- //

  read(docId: string): Result<TextSourceDto> {
    if (!isTextDocId(docId)) return failed(404, `paper '${docId}' not found`);
    try {
      return ok(this.dto(readTextSource(this.paths, docId)));
    } catch (error) {
      return { ok: false, ...errorFailure(error) };
    }
  }

  async save(docId: string, body: unknown): Promise<Result<TextSourceDto>> {
    const parsed = PutTextSourceRequestSchema.safeParse(body);
    if (!parsed.success) return failed(400, "request body is not a valid text source");
    if (parsed.data.markdown.length > TEXT_SOURCE_MAX_CHARS)
      return failed(413, "the text source is too large");
    if (!isTextDocId(docId)) return failed(404, `paper '${docId}' not found`);
    try {
      const outcome = await this.textLock.run(() => {
        // synchronous from here to the write: a delete that started first is refused, one that starts later removes it
        if (this.deps.docMutations.isDeleting(docId)) return failed(409, "document busy");
        const saved = saveTextSource(this.paths, docId, parsed.data);
        if (saved.kind === "conflict")
          return failed(409, "rev mismatch", {
            rev: saved.source.rev,
            source: this.dto(saved.source),
          });
        return ok(saved.source);
      });
      if (!outcome.ok) return outcome;
      this.deps.broadcast({
        type: "text-source.changed",
        doc_id: docId,
        rev: outcome.value.rev,
        at: new Date().toISOString(),
      });
      return ok(this.dto(outcome.value));
    } catch (error) {
      return { ok: false, ...errorFailure(error) };
    }
  }

  // ---- image assets (ticket 27) --------------------------------------------------- //

  /**
   * Add one image to the source: bytes are judged by content, written under a NEW controlled name (never over an
   * existing file) and entered in the asset list in the same critical section as the revision bump. Like a save it
   * refuses while the Doc is being deleted; it never touches the reading text or annotations.
   */
  async addAsset(
    docId: string,
    input: { expectedRev: number; filename?: string; bytes: Buffer }
  ): Promise<Result<TextAssetAdded>> {
    if (!isTextDocId(docId)) return failed(404, `paper '${docId}' not found`);
    if (input.bytes.length > TEXT_ASSET_MAX_BYTES)
      return failed(413, "the image is too large", { code: "too_large" });
    try {
      const outcome = await this.textLock.run(() => {
        if (this.deps.docMutations.isDeleting(docId)) return failed(409, "document busy");
        const added = addTextAsset(this.paths, docId, {
          expectedRev: input.expectedRev,
          bytes: input.bytes,
          ...(input.filename !== undefined ? { filename: input.filename } : {}),
        });
        if (added.kind === "conflict")
          return failed(409, "rev mismatch", {
            rev: added.source.rev,
            source: this.dto(added.source),
          });
        return ok(added);
      });
      if (!outcome.ok) return outcome;
      const added = outcome.value;
      if (added.kind === "added")
        this.deps.broadcast({
          type: "text-source.changed",
          doc_id: docId,
          rev: added.source.rev,
          at: new Date().toISOString(),
        });
      return ok(
        {
          source: this.dto(added.source),
          asset: added.asset,
          reused: added.kind === "reused",
          restored: added.restored,
        },
        added.kind === "added" ? 201 : 200
      );
    } catch (error) {
      return { ok: false, ...errorFailure(error) };
    }
  }

  /**
   * Add one picture rendered from a PDF Doc of the same Work (the source PDF unless another is named): a page, or a
   * region of it in fractions of the visible page. The original is read through the shared verified, queued PDFium
   * path and must be the one the caller looked at (`sha256`); the picture then goes through `addAsset`, the very path
   * of an upload (magic bytes, bounded size, a NEW controlled name, expected source revision, one critical section
   * with the revision bump). Nothing is written to the PDF and neither the page nor the region is stored.
   */
  async addPdfImage(docId: string, body: unknown): Promise<Result<TextAssetAdded>> {
    const parsed = AddPdfImageRequestSchema.safeParse(body);
    if (!parsed.success)
      return failed(400, "request body is not a valid source PDF image request", {
        code: "invalid_request",
      });
    if (!isTextDocId(docId)) return failed(404, `paper '${docId}' not found`);
    const render = this.deps.renderPdfRegion;
    if (!render) return failed(503, "PDF page images are not available", { code: "unavailable" });
    const request = parsed.data;
    let pdfDocId: string;
    try {
      const source = readTextSource(this.paths, docId);
      const wanted = request.pdfDocId ?? source.source_pdf?.doc_id;
      if (!wanted)
        return failed(400, "this text has no source PDF; name a PDF of the same Work", {
          code: "bad_source_pdf",
        });
      pdfDocId = wanted;
      // a PDF Doc of a Work that also lists this text Doc (a file relation only; nothing about it is stored)
      const works = LibraryStore.load(this.paths).works;
      if (!works.some((w) => w.doc_ids.includes(docId) && w.doc_ids.includes(wanted)))
        return failed(400, "the picture must come from a PDF Doc of the same Work", {
          code: "bad_source_pdf",
        });
      const metadata = readPdfMetadataIfPresent(this.paths, wanted);
      if (!metadata)
        return failed(400, "the picture must come from a PDF Doc of the same Work", {
          code: "bad_source_pdf",
        });
      // the relation recorded at creation pins the original: a different one is a changed document
      if (source.source_pdf?.doc_id === wanted && source.source_pdf.sha256 !== metadata.sha256)
        return failed(409, "document changed", { code: "document_changed" });
    } catch (error) {
      return { ok: false, ...errorFailure(error) };
    }
    // A picture over the asset limit is rendered again smaller (a busy 9 MP page can encode to more than 20 MiB) before it
    // is refused; every attempt is the same verified, queued read.
    let longEdge = request.longEdge ?? TEXT_PDF_IMAGE_LONG_EDGE.default;
    let rendered = await render({
      pdfDocId,
      expectedHash: request.sha256,
      pageIndex: request.pageIndex,
      ...(request.region ? { region: request.region } : {}),
      longEdge,
    });
    for (
      let attempt = 0;
      attempt < 4 && rendered.kind === "ok" && rendered.png.length > TEXT_ASSET_MAX_BYTES;
      attempt++
    ) {
      longEdge = Math.floor(longEdge * 0.7);
      if (longEdge < TEXT_PDF_IMAGE_LONG_EDGE.min) break;
      rendered = await render({
        pdfDocId,
        expectedHash: request.sha256,
        pageIndex: request.pageIndex,
        ...(request.region ? { region: request.region } : {}),
        longEdge,
      });
    }
    switch (rendered.kind) {
      case "ok":
        break;
      case "not_found":
        return failed(404, "no such PDF Doc");
      case "busy":
        return failed(409, "document busy");
      case "changed":
        return failed(409, "document changed", { code: "document_changed" });
      case "invalid":
        return failed(400, rendered.detail, { code: "invalid_request" });
      case "resource":
        return failed(503, rendered.detail, { code: "resource" });
      default:
        return failed(500, "the PDF page could not be rendered", { code: "render_failed" });
    }
    if (rendered.png.length > TEXT_ASSET_MAX_BYTES)
      return failed(413, "the picture is larger than 20 MiB even at a small size", {
        code: "too_large",
      });
    // a neutral stem: the page and the region are only parameters of this call, never part of what is stored
    return this.addAsset(docId, {
      expectedRev: request.expectedRev,
      filename: "pdf-image.png",
      bytes: rendered.png,
    });
  }

  // ---- validate (no side effects) ---------------------------------------------- //

  validate(docId: string, body: unknown): Result<TextValidationResult> {
    const parsed = ValidateTextSourceRequestSchema.safeParse(body);
    if (!parsed.success) return failed(400, "request body is not a valid validation request");
    if (!isTextDocId(docId)) return failed(404, `paper '${docId}' not found`);
    try {
      const source = readTextSource(this.paths, docId);
      if (source.rev !== parsed.data.sourceRev)
        return failed(409, "source revision changed", { rev: source.rev });
      const parsedText = parseTextSource(source.markdown, {
        docId,
        sourceRev: source.rev,
        assets: source.assets,
      });
      return ok({
        sourceRev: source.rev,
        valid: parsedText.ir !== null,
        diagnostics: parsedText.diagnostics,
        stats: parsedText.stats,
      });
    } catch (error) {
      return { ok: false, ...errorFailure(error) };
    }
  }

  // ---- generate ---------------------------------------------------------------- //

  /**
   * What replacing the reading text would put at risk RIGHT NOW for this source revision, without writing anything
   * (the click-time check of a confirmation card, copilot ticket 29). It runs the very code of `generate` up to the
   * point where it would publish, and takes neither the writer pin nor the one-generation mark: it is read-only, so
   * it can never make a user's own Generate or Delete meet "busy", and overlapping probes cannot disturb each other.
   * `impact: null`: nothing is at risk. `changed`: the source moved, the Doc is gone or being deleted, or the text now
   * has errors (a bound value really is different). `error`: a system error (annotations, the reading text, a
   * fingerprint or an asset cannot be read or computed): reported as what it is, never as a change.
   */
  async probeReplacement(docId: string, sourceRev: number): Promise<ReplacementProbe> {
    if (!isTextDocId(docId)) return { kind: "changed" };
    let seen: { impact: TextReplacementImpact | null } | undefined;
    let outcome: Result<TextGenerationResult>;
    try {
      outcome = await this.generateUnlocked(docId, sourceRev, "probe", undefined, (impact) => {
        seen = { impact };
      });
    } catch (error) {
      // DELETE takes neither the text nor the annotation lock, so a Doc can vanish mid-read: that is a change
      if (
        (error instanceof TextDocError && error.code === "not_found") ||
        !existsSync(join(this.paths.outputDir, docId))
      )
        return { kind: "changed" };
      return { kind: "error", code: "read_failed", detail: (error as Error).message };
    }
    if (seen) return { kind: "impact", impact: seen.impact };
    if (!outcome.ok) {
      const code = (outcome.body as { code?: string }).code;
      if (outcome.status >= 500 && existsSync(join(this.paths.outputDir, docId)))
        return {
          kind: "error",
          code: code ?? "error",
          detail: String(
            (outcome.body as { detail?: string }).detail ?? "the Doc could not be read"
          ),
        };
    }
    return { kind: "changed" };
  }

  async generate(docId: string, body: unknown): Promise<Result<TextGenerationResult>> {
    const parsed = GenerateTextDocRequestSchema.safeParse(body);
    if (!parsed.success) return failed(400, "request body is not a valid generation request");
    if (!isTextDocId(docId)) return failed(404, `paper '${docId}' not found`);
    // a repeat of the same operation at the same source revision is answered with what it did; a new revision is new work
    const memo = this.finished.get(`${docId}:${parsed.data.operationId}:${parsed.data.sourceRev}`);
    if (memo) return { ...ok(memo), duplicate: true };
    const { docMutations } = this.deps;
    // one generation per Doc, and never beside a delete: the pin also stops a delete from starting
    if (docMutations.isDeleting(docId) || this.generating.has(docId))
      return failed(409, "document busy");
    this.generating.add(docId);
    docMutations.pinWriter(docId);
    try {
      return await this.generateUnlocked(
        docId,
        parsed.data.sourceRev,
        parsed.data.operationId,
        parsed.data.confirm
      );
    } catch (error) {
      return { ok: false, ...errorFailure(error) };
    } finally {
      docMutations.unpinWriter(docId);
      this.generating.delete(docId);
    }
  }

  private async generateUnlocked(
    docId: string,
    sourceRev: number,
    operationId: string,
    confirm?: TextReplacementImpact,
    /** Probe: report the impact found inside the critical section and stop before anything could be written. */
    probe?: (impact: TextReplacementImpact | null) => void
  ): Promise<Result<TextGenerationResult>> {
    const source = readTextSource(this.paths, docId);
    if (source.rev !== sourceRev)
      return failed(409, "source revision changed", { code: "stale", rev: source.rev });
    const fallbackTitle = LibraryStore.load(this.paths).works.find((w) =>
      w.doc_ids.includes(docId)
    )?.title;
    const result = parseTextSource(source.markdown, {
      docId,
      sourceRev: source.rev,
      assets: source.assets,
      ...(fallbackTitle ? { fallbackTitle } : {}),
    });
    if (!result.ir) {
      return failed(422, "the text has errors; nothing was generated", {
        code: "diagnostics",
        diagnostics: result.diagnostics,
        stats: result.stats,
      });
    }
    const candidate: TextDocIr = result.ir;
    const docDir = join(this.paths.outputDir, docId);
    // The generation is bound to the assets' real bytes: every image the text uses must still be the registered one.
    // A missing, changed or unsafe file is a system error that stops the generation (nothing is published).
    try {
      const used = new Set<string>();
      const walk = (sections: TextDocIr["sections"]): void => {
        for (const sec of sections) {
          for (const b of sec.blocks) if (b.type === "figure" && b.imgPath) used.add(b.imgPath);
          walk(sec.children);
        }
      };
      walk(candidate.sections);
      for (const name of used) {
        const asset = source.assets.find((a) => a.name === name);
        if (!asset) throw new Error(`asset ${name} is not registered`);
        readTextAsset(this.paths, docId, asset);
      }
    } catch (error) {
      return failed(
        500,
        `an image of the text cannot be read or no longer matches its registered content; nothing was generated (${(error as Error).message})`,
        { code: "asset_unreadable" }
      );
    }
    let candidateFingerprint: string;
    try {
      candidateFingerprint = docContentFingerprint(candidate, { docDir });
    } catch (error) {
      return failed(
        500,
        `the content fingerprint cannot be computed; nothing was generated (${(error as Error).message})`,
        { code: "fingerprint_failed" }
      );
    }
    await this.deps.beforePublish?.(docId);

    const outcome = await this.textLock.run(() =>
      this.deps.annotationLock.run((): Result<TextGenerationResult> => {
        if (this.deps.docMutations.isDeleting(docId)) return failed(409, "document busy");
        if (!existsSync(docDir) || !statSync(docDir).isDirectory())
          return failed(404, "document not found");
        const latest = readTextSource(this.paths, docId);
        if (latest.rev !== source.rev)
          return failed(
            409,
            "source changed while generating; the older result was not published",
            {
              code: "stale",
              rev: latest.rev,
            }
          );
        // What this replacement puts at risk: decided here, inside the same sections as the write.
        let published: TextDocIr | null;
        try {
          published = readPublishedTextIr(this.paths, docId);
        } catch (error) {
          return failed(
            500,
            `the existing reading text cannot be read; nothing was replaced (${(error as Error).message})`,
            {
              code: "reading_unreadable",
            }
          );
        }
        let impact: TextReplacementImpact | null = null;
        if (published) {
          let currentFingerprint: string;
          try {
            currentFingerprint = docContentFingerprint(published, { docDir });
          } catch (error) {
            return failed(
              500,
              `the current content fingerprint cannot be computed; nothing was replaced (${(error as Error).message})`,
              {
                code: "fingerprint_failed",
              }
            );
          }
          if (currentFingerprint !== candidateFingerprint) {
            const risk = readAnnotationRisk(this.paths.dataDir, docId);
            if (risk.state !== "known")
              return failed(
                500,
                "the Doc's annotations cannot be read; nothing was replaced and no annotation was touched",
                { code: "annotations_unreadable" }
              );
            if (risk.count > 0) {
              // Replacing this reading text puts `risk.count` annotations into the archive (the annotations access
              // path does that afterwards, never this generator). That needs the real user's confirmation of exactly
              // these values; anything else answers with the values as they are now and writes nothing.
              impact = {
                docId,
                sourceRev: source.rev,
                publishedSourceRev: published.source.source_rev,
                annotations: risk.count,
                annotationsRev: risk.rev,
                oldFingerprint: currentFingerprint,
                newFingerprint: candidateFingerprint,
              };
            }
          }
        }
        if (probe) {
          probe(impact);
          return failed(409, "probe", { code: "probe" });
        }
        if (impact && !confirm)
          return failed(
            409,
            "this generation replaces reading text that has annotations; they would be archived. Confirm to publish it",
            { code: "confirmation_required", impact }
          );
        // A confirmation is only good for exactly what the user was shown: if ANY bound value moved, or nothing is at
        // risk any more, it is refused (the fresh impact is attached when there still is one).
        if (confirm && (!impact || !sameImpact(confirm, impact)))
          return failed(
            409,
            "the situation changed since the confirmation was asked; nothing was published",
            { code: "confirmation_changed", ...(impact ? { impact } : {}) }
          );
        try {
          publishTextIr(this.paths, docId, candidate);
        } catch (error) {
          return failed(
            500,
            `the reading text could not be written; the previous version is kept (${(error as Error).message})`,
            {
              code: "publish_failed",
            }
          );
        }
        return ok({
          publishedSourceRev: source.rev,
          fingerprint: candidateFingerprint,
          replacedAnnotations: impact ? impact.annotations : 0,
          diagnostics: result.diagnostics as TextDiagnostic[],
          stats: result.stats,
        });
      })
    );
    if (!outcome.ok) return outcome;
    this.finished.set(`${docId}:${operationId}:${source.rev}`, outcome.value);
    if (this.finished.size > 200) {
      const oldest = this.finished.keys().next().value;
      if (oldest !== undefined) this.finished.delete(oldest);
    }
    this.deps.broadcast({
      type: "text-doc.published",
      doc_id: docId,
      published_source_rev: outcome.value.publishedSourceRev,
      at: new Date().toISOString(),
    });
    return outcome;
  }
}

/** Mount the text Doc routes. `guardCsrf` is the app's same-origin check for mutations. */
export function mountTextDocRoutes(
  app: Hono,
  service: TextDocService,
  guardCsrf: (origin: string | undefined) => { body: { detail: string }; status: 403 } | null
): void {
  const answer = <T>(c: import("hono").Context, result: Result<T>) =>
    result.ok
      ? c.json(result.value as never, result.status ?? 200, { "Cache-Control": "no-store" })
      : c.json(result.body as never, result.status, { "Cache-Control": "no-store" });
  const idOf = (c: import("hono").Context): string | null => {
    const id = c.req.param("doc_id") ?? "";
    return !id.trim() || badDocId(id) ? null : id;
  };

  app.post("/api/library/text-docs", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const body: unknown = await c.req.json().catch(() => null);
    return answer(c, await service.create(body));
  });
  app.get("/api/paper/:doc_id/source/delete-impact", (c) => {
    const id = idOf(c);
    if (!id) return c.json({ detail: "bad doc id" }, 400);
    if (!service.has(id)) return c.json({ detail: `paper '${id}' not found` }, 404);
    return c.json(service.draftAnnotationImpact(id), 200, { "Cache-Control": "no-store" });
  });
  app.get("/api/paper/:doc_id/source", (c) => {
    const id = idOf(c);
    if (!id) return c.json({ detail: "bad doc id" }, 400);
    return answer(c, service.read(id));
  });
  app.put("/api/paper/:doc_id/source", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = idOf(c);
    if (!id) return c.json({ detail: "bad doc id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    return answer(c, await service.save(id, body));
  });
  app.post("/api/paper/:doc_id/source/assets", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = idOf(c);
    if (!id) return c.json({ detail: "bad doc id" }, 400);
    const expectedRev = Number(c.req.query("expectedRev"));
    if (!Number.isInteger(expectedRev) || expectedRev < 0)
      return c.json({ detail: "expectedRev must be a non-negative integer" }, 400);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > TEXT_ASSET_MAX_BYTES)
      return c.json({ detail: "the image is too large", code: "too_large" }, 413);
    const bytes = await readBounded(c.req.raw, TEXT_ASSET_MAX_BYTES);
    if (bytes === null) return c.json({ detail: "the image is too large", code: "too_large" }, 413);
    const filename = c.req.query("filename");
    return answer(
      c,
      await service.addAsset(id, {
        expectedRev,
        bytes,
        ...(filename !== undefined ? { filename } : {}),
      })
    );
  });
  app.post("/api/paper/:doc_id/source/assets/from-pdf", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = idOf(c);
    if (!id) return c.json({ detail: "bad doc id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    return answer(c, await service.addPdfImage(id, body));
  });
  app.post("/api/paper/:doc_id/source/validate", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = idOf(c);
    if (!id) return c.json({ detail: "bad doc id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    return answer(c, service.validate(id, body));
  });
  app.post("/api/paper/:doc_id/source/generate", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = idOf(c);
    if (!id) return c.json({ detail: "bad doc id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    return answer(c, await service.generate(id, body));
  });
}

/** The request body, read in chunks and abandoned as soon as it passes `max` bytes (nothing larger is buffered). */
async function readBounded(request: Request, max: number): Promise<Buffer | null> {
  const body = request.body;
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
