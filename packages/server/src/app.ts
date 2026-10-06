/**
 * The Hono port of `server/app.py` (FastAPI): the REST endpoints with paths
 * and response shapes preserved verbatim (decision 15), the image route, CORS
 * for the Vite dev origin, the Origin-check CSRF guard on mutations, the
 * mtime+size paper cache, and static SPA hosting with API precedence.
 *
 * Intentional divergences from app.py (all flagged in the M4 memory note):
 * - `POST /api/library/upload` accepts a LaTeX source **zip** (not a PDF —
 *   the OCR path is archived on `ocr-features`): PK magic + a trial unpack
 *   gate the body, then the doc is ingested and attached to the work named by
 *   `?id/?doi/?arxiv` (async job by default, `?sync=1` keeps the legacy
 *   wait-for-it shape).
 * - `POST /api/library/refresh` keeps its synchronous summary response, but
 *   the rebuild runs inside the serial job runner (mutual exclusion with
 *   other library writes, decisions 13/16) — WS clients see it as a
 *   `refresh` job.
 * - The CSRF allowlist gains the server's own port (`localhost`/`127.0.0.1`)
 *   so same-origin SPA POSTs work on ports other than the hardcoded 8000.
 * - Malformed `?offline=` values answer `422 {"detail": string}` (FastAPI's
 *   validation body is a `detail` *array*; the string shape is kept uniform).
 * - The SPA fallback serves `index.html` for unknown non-API GET paths
 *   (Starlette's StaticFiles answered 404) — required for client-side routes.
 * - Stage 4 adds `GET`/`PUT /api/plans`: the plan page's whole-document
 *   read/replace against `<statusDir>/plans.json`, with the `rev` optimistic
 *   lock (mismatch → 409) and a `plan.changed` broadcast. Writes serialize on
 *   a dedicated planLock, never the library lock (they must not block each
 *   other).
 * - Stage 8 adds `GET`/`PUT /api/paper/:doc_id/annotations` (the reader's
 *   annotation store: fingerprint+rev double-checked PUT with 409×2, the
 *   `annotation.changed` broadcast, a dedicated annotationLock) and
 *   `DELETE /api/paper/:doc_id` (global physical delete + all-works doc_ids
 *   removal). The DocMutationRegistry (doc-mutations.ts) is the §8 lifecycle
 *   lock between document deletes and doc-writing jobs; upload/refresh pin
 *   their targets, DELETE busy-checks (409, never waits).
 */

import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import type {
  AnnotationsFile,
  DocDescription,
  DocReplaceImpact,
  Job,
  PdfSourceMaterial,
  RefreshResponse,
  WsServerMessage,
} from "@argelanderspace/contracts";
import {
  AnnotationsFileSchema,
  buildReaderReading,
  DocDescriptionSchema,
  type ManualWorkRequest,
  ManualWorkRequestSchema,
  ManuscriptSchema,
  PDF_IMAGE_LONG_EDGE,
  PDF_MAX_BYTES,
  PDF_RESOURCE_WARNING_BYTES,
  type PdfAnnotationOperation,
  PdfAnnotationsFileSchema,
  PdfPagesResponseSchema,
  PdfReadingPositionSchema,
  PlansFileSchema,
  TexDocIrSchema,
} from "@argelanderspace/contracts";
import {
  type AdsDiscoverySource,
  AnnotationsError,
  annotationsDocDir,
  appendDocIdNarrow,
  arxivAttachScenario,
  arxivDocId,
  attachArxivDoc,
  attachLatexZip,
  buildWriterExport,
  commitPdfAnnotationChange,
  DocumentAssetError,
  discoverLiterature,
  ensureCurrentAnnotationsWithDocument,
  findMatchingPdfDoc,
  findWork,
  healGraph,
  type IngestPipelines,
  type LibraryPaths,
  LibraryStore,
  libraryPayload,
  listManuscripts,
  loadCurrentGraph,
  loadManuscript,
  loadTemplates,
  type MetadataSources,
  manuscriptDir,
  normArxiv,
  PdfAnnotationConflictError,
  PdfAnnotationValidationError,
  PdfContentChangedError,
  PdfReadingPositionConflictError,
  patchWorkNarrow,
  publishPdfDoc,
  type RemovedDocWork,
  readAnnotationRisk,
  readDocumentAsset,
  readDocumentForReading,
  readManuscriptAsset,
  readPdfAnnotationsFile,
  readPdfMetadataIfPresent,
  readPdfReadingPosition,
  readVerifiedPdf,
  rebuild,
  removeDocFromWorksNarrow,
  restoreUnknownKeys,
  saveAnnotationsFile,
  savePdfAnnotationsFile,
  savePdfReadingPosition,
  uploadDocId,
  type WriterExportBundle,
  WriterExportError,
  workToRef,
  writeManuscriptAsset,
} from "@argelanderspace/core";
import {
  AdsDiscoveryError,
  ArxivPdfOnlyError,
  ensureWriterSandboxProbe,
  extractZip,
  getConfig,
  writerSandboxAvailable,
  ZipError,
  zipEntries,
} from "@argelanderspace/infra";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type ArxivFetchStage, appendArxivFetchLog } from "./arxiv-fetch-log.js";
import { CopilotHost } from "./copilot.js";
import { type AnnotationWrite, planAnnotationWrite } from "./copilot-reader-annotations.js";
import type {
  AssetImageOutcome,
  PdfImageOutcome,
  PdfReadOutcome,
  PdfWriteOutcome,
  ReaderOpDeps,
  ReaderReadOutcome,
  ReaderWriteOutcome,
} from "./copilot-reader-tool.js";
import { mountCopilotRoutes } from "./copilot-routes.js";
import { DocMutationRegistry } from "./doc-mutations.js";
import type { JobRunner } from "./jobs.js";
import {
  type AnnotationRisk,
  type ArxivSourcePlan,
  type ArxivStart,
  commitWorkPatch,
  type DocDeleteDescription,
  type DocDeleteOutcome,
  type LibraryOpDeps,
  type ManualImportResult,
  runManualImport,
} from "./library-actions.js";
import { AsyncLock } from "./lock.js";
import { PaperCache } from "./paper-cache.js";
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
  readPdfTextMaterial,
  readPdfTextMaterialCached,
  renderPdfPageImage,
  renderPdfRegionImage,
  resolvePdfTextTarget,
} from "./pdf-material.js";
import { probePdf } from "./pdfium-probe.js";
import { isLinkableDoc, readPlans, replacePlans } from "./plans-actions.js";
import { mountProviderRoutes } from "./provider-routes.js";
import { ProviderSettings } from "./providers.js";
import {
  mountTextDocRoutes,
  type PdfRegionOutcome,
  type TextDocDeps,
  TextDocService,
} from "./text-docs.js";
import {
  createManuscriptOp,
  deleteManuscriptOp,
  replaceManuscript,
  type WriterOpDeps,
} from "./writer-actions.js";
import {
  cancelNumberingCompile,
  getWriterNumbering,
  runWriterNumberingNow,
  WriterNumberingError,
} from "./writer-numbering.js";

// --------------------------------------------------------------------------- //
// Deps
// --------------------------------------------------------------------------- //

export interface AppDeps {
  paths: LibraryPaths;
  /** The plan page's status dir (holds `plans.json`); `statusDirFor(dataDir)`. */
  statusDir: string;
  /** Sources factory: `offline` toggles remote enrichment (Crossref/OpenAlex). */
  makeSources: (offline: boolean) => MetadataSources;
  /**
   * Stage 14 discovery source factory (the ADS discovery client). Optional:
   * when absent the discovery route answers 503 — production wires it in
   * server.ts; tests inject stubs.
   */
  makeDiscoverySource?: () => AdsDiscoverySource;
  /** The ingest pipelines (the upload endpoint consumes `ingestLatexZip`). */
  pipelines: IngestPipelines;
  /** External current arXiv PDF bytes; isolated tests replace only this network boundary. */
  fetchArxivPdf?: (arxivId: string) => Promise<Buffer>;
  /**
   * Stage 15 hidden toggle (D15): gate for the AUTOMATIC arXiv fetch on work
   * creation — the default reads `auto_ingest_arxiv` from config.toml fresh
   * at every submit (`false` disables auto only; manual triggers stay on).
   */
  autoIngestArxiv?: () => boolean;
  runner: JobRunner;
  /** WS sink; when absent, events are simply dropped (tests without a hub). */
  broadcast?: (msg: WsServerMessage) => void;
  /** Composition seam for the §8 delete↔job lifecycle lock (tests inject to
   *  drive the reverse-direction exclusion); default is a fresh registry. */
  docMutations?: DocMutationRegistry;
  /** Built SPA directory; served last (API routes take precedence). */
  webDist?: string | null;
  /** The server's own port — same-origin SPA POSTs carry it in `Origin`. */
  port?: number;
  /** Isolated settings storage/runtime in tests; production is initialized on first provider request. */
  providerSettings?: ProviderSettings;
  copilot?: CopilotHost;
  /** Test seam of the text Doc generator (runs between building a candidate and publishing it). */
  textDocHooks?: Pick<TextDocDeps, "beforePublish">;
  /** Longest the Copilot `library` tool waits for an acquisition job before answering `pending` (default ten minutes). */
  acquisitionWaitMs?: number;
}

// --------------------------------------------------------------------------- //
// Small parity helpers
// --------------------------------------------------------------------------- //

/** FastAPI's `HTTPException(status, msg)` body. */
function detail(msg: string, status: ContentfulStatusCode) {
  return { body: { detail: msg }, status };
}

/** Python `_paper_path` / `get_image` traversal guards. */
function badId(id: string): boolean {
  return id.includes("/") || id.includes("\\") || id.startsWith(".");
}

/**
 * Stage 14 discovery seed validation: bibcodes are identifiers, not ADS
 * query strings — capped length, no whitespace/quotes/control characters
 * (never present in real bibcodes; the infra layer additionally quotes and
 * escapes before embedding anything in a Solr query).
 */
function badDiscoveryBibcode(v: string): boolean {
  return (
    v.length === 0 ||
    v.length > 64 ||
    ![...v].every((ch) => {
      const code = ch.charCodeAt(0);
      return code > 0x20 && code !== 0x7f && ch !== '"' && ch !== "\\";
    })
  );
}

/** ADS discovery failure → HTTP status (stage plan §8.1). */
function discoveryErrorStatus(kind: AdsDiscoveryError["kind"]): 429 | 502 | 503 {
  switch (kind) {
    case "no-token":
    case "unauthorized":
      return 503; // explicit ADS unavailable; no fallback
    case "rate-limited":
      return 429; // Retry-After forwarded by the caller when present
    default:
      return 502; // upstream | invalid-response
  }
}

/**
 * Traversal guard for multi-segment image paths (img_path verbatim, e.g.
 * `assets/foo.jpg`): no empty / `.…` / `..` segments, no backslashes.
 */
function badImagePath(rel: string): boolean {
  if (rel.includes("\\")) return true;
  return rel.split("/").some((s) => s === "" || s === ".." || s.startsWith("."));
}

/**
 * FastAPI's `bool` query parsing (pydantic): the usual truthy/falsy spellings,
 * case-insensitive; anything else is a validation error (422).
 */
function parseBoolQuery(raw: string | undefined): boolean | null {
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on", "t", "y"].includes(v)) return true;
  if (["false", "0", "no", "off", "f", "n", ""].includes(v)) return false;
  return null;
}

/** Python `f"...{value!r}..."` for the simple ids that reach these messages. */
function pyRepr(s: string): string {
  return `'${s}'`;
}

/** Document images are data, never a page: no sniffing, and a script inside an SVG that is opened directly cannot run. */
const IMAGE_HARDENING = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
} as const;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
};

/** Vite emits content-hashed files under `assets/` (safe to cache forever);
 *  everything else — index.html above all — must revalidate so a fresh build
 *  is picked up on the next plain refresh (smoke round-2 stale-bundle guard). */
function cacheControlFor(filePath: string, root: string): string {
  return relative(root, filePath).startsWith(`assets${sep}`)
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

// --------------------------------------------------------------------------- //
// The app
// --------------------------------------------------------------------------- //

export function createApp(deps: AppDeps): Hono {
  const { paths, runner } = deps;
  const outputDir = paths.outputDir;
  const paperCache = new PaperCache();
  /** Python `_WRITE_LOCK`: rebuild vs PATCH/POST refs (see lock.ts). */
  const libraryLock = new AsyncLock();
  /** Plans writes: separate from the library lock — the two never block each other. */
  const planLock = new AsyncLock();
  /** Annotations writes: their own lock too (roadmap §2 — 不与 libraryLock/planLock 互堵). */
  const annotationLock = new AsyncLock();
  /** Reading position is independently versioned user data. */
  const readingPositionLock = new AsyncLock();
  /** Writer manuscript writes: own lock (Stage 10; mirrors planLock). */
  const writerLock = new AsyncLock();
  /** The §8 delete↔job lifecycle lock (see doc-mutations.ts). */
  const docMutations = deps.docMutations ?? new DocMutationRegistry();
  const pdfPinsByJob = new Map<string, string[]>();
  const broadcast = deps.broadcast ?? (() => {});
  // Job transitions flow to the same bus as library.changed (createServer's
  // hub is just another broadcast consumer).
  runner.onEvent = (type, job) => {
    if (type === "job.done" || type === "job.failed") {
      const pinnedDocs = pdfPinsByJob.get(job.id);
      if (pinnedDocs) {
        for (const pinnedDoc of pinnedDocs) docMutations.unpinWriter(pinnedDoc);
        pdfPinsByJob.delete(job.id);
      }
    }
    broadcast({ type, job });
    // A Copilot operation that was left pending on this job shows its end.
    if (type === "job.done" || type === "job.failed") copilot.jobSettled(job.id);
  };
  const libraryChanged = (cause: "refresh" | "patch" | "add" | "upload" | "ingest"): void => {
    broadcast({ type: "library.changed", cause, at: new Date().toISOString() });
    // A pending Doc-replacement confirmation may no longer match what it showed (click time stays the authority).
    void copilot.revalidateDocConfirmations().catch(() => {});
  };
  const planChanged = (cause: "put" | "external"): void => {
    broadcast({ type: "plan.changed", cause, at: new Date().toISOString() });
  };
  /** Stage 10: `id` names the manuscript; template-dir changes omit it. */
  const writerChanged = (cause: "put" | "create" | "delete" | "numbering", id: string): void => {
    broadcast({ type: "writer.changed", cause, id, at: new Date().toISOString() });
    // A pending Copilot manuscript delete may no longer match its card (click time stays the authority).
    copilot.revalidateWriterConfirmations();
  };
  const writerDataDir = paths.dataDir;
  // The Copilot `writer` tool and these routes share one lock, rev check, save and writer.changed notification.
  // Find out (off the event loop) whether the OS sandbox for Writer compiles works; the gates read the cached answer.
  void ensureWriterSandboxProbe();
  const writerOps: WriterOpDeps = {
    dataDir: writerDataDir,
    writerLock,
    changed: writerChanged,
    cancelCompile: (id) => cancelNumberingCompile(id, writerDataDir),
    // The Render button's own compile, for the Copilot's render_manuscript (the refresh route calls the same function).
    render: (id) => runWriterNumberingNow(writerDataDir, id, { broadcast }),
    sandboxed: () => writerSandboxAvailable(),
    // The References tab's list: the saved works' cite keys, read fresh at each use.
    citeKeys: () => new Set(LibraryStore.load(paths).works.map((work) => workToRef(work).cite)),
  };
  const annotationChanged = (docId: string, cause: "put" | "invalidate"): void => {
    broadcast({ type: "annotation.changed", doc_id: docId, cause, at: new Date().toISOString() });
    void copilot.revalidateDocConfirmations().catch(() => {});
  };
  const pdfOwners = (docId: string) =>
    LibraryStore.load(paths).works.filter((work) => work.doc_ids.includes(docId));
  /**
   * The ONE way PDF page material is reached (the `/pdf/pages` routes and the Copilot's reader tool): content-busy
   * check, a unique owner, and the original read once and verified against its immutable SHA-256 (and against the
   * hash the caller expects, if it names one). The text and the image both come from the Buffer this returns.
   */
  type PdfSource =
    | {
        kind: "ok";
        metadata: NonNullable<ReturnType<typeof readPdfMetadataIfPresent>>;
        bytes: Buffer;
        title: string;
        annotations?: ReturnType<typeof readPdfAnnotationsFile>;
      }
    | { kind: "bad_id" | "busy" | "not_found" | "changed" | "inconsistent" | "error" };
  const pdfSource = (
    docId: string,
    options: { expectedHash?: string; annotations?: boolean } = {}
  ): PdfSource => {
    if (!docId.trim() || badId(docId)) return { kind: "bad_id" };
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
  /** AnnotationsError → the route's response (roadmap §3: not_found → 404,
   *  every other store failure → 500, never a silent reset). */
  const annotationsError = (err: AnnotationsError) =>
    detail(err.message, err.code === "not_found" ? 404 : 500);
  /**
   * The ONE commit of a LaTeX Doc's annotations: `PUT /api/paper/:doc_id/annotations` and the Copilot `reader` tool's
   * annotation writes both come here. One critical section on annotationLock: content-busy check, PDF refusal,
   * the idempotent ensure (which alone may archive and then announces `invalidate`), the fingerprint check, the
   * revision check, `build`, and the atomic save. Failures to compute the fingerprint or to read the stored file
   * throw `AnnotationsError` (a system error, never a mismatch) and leave the user's data as it was, except the
   * contract's intermediate state (code `new_current`: the old batch is safely archived, the new current is not
   * there yet). `build` gets the ensured epoch and returns the file to save (`next`; `preserveUnknown` keeps keys the
   * schema does not know, as the Copilot's narrow writes do and the page's whole-file PUT does not) or `skip` when
   * there is nothing to write. `archived` says how many annotations of older content this very access archived.
   */
  type AnnotationsEpoch = ReturnType<typeof ensureCurrentAnnotationsWithDocument>;
  type Archived = { archived?: number };
  type AnnotationsCommit<T = never> =
    | { kind: "busy" }
    | { kind: "pdf" }
    | ({ kind: "document_changed"; file: AnnotationsFile } & Archived)
    | ({ kind: "rev_mismatch"; rev: number } & Archived)
    | ({ kind: "saved"; file: AnnotationsFile } & Archived)
    | ({ kind: "skipped"; file: AnnotationsFile; value: T } & Archived);
  function commitAnnotations<T = never>(
    docId: string,
    expect: { fingerprint: string; rev: number },
    build: (
      epoch: AnnotationsEpoch
    ) => { next: AnnotationsFile; preserveUnknown?: boolean } | { skip: T }
  ): Promise<AnnotationsCommit<T>> {
    let saved = false;
    const outcome = annotationLock.run((): AnnotationsCommit<T> => {
      if (docMutations.isDocumentContentBusy(docId)) return { kind: "busy" };
      let pdf: unknown;
      try {
        pdf = readPdfMetadataIfPresent(paths, docId);
      } catch (err) {
        throw new DocMetadataError(err);
      }
      if (pdf) return { kind: "pdf" };
      const ensured = ensureCurrentAnnotationsWithDocument(paths.dataDir, docId);
      if (ensured.invalidated) annotationChanged(docId, "invalidate");
      const archived: Archived = ensured.invalidated
        ? { archived: ensured.archivedCount ?? 0 }
        : {};
      const current = ensured.file;
      if (expect.fingerprint !== current.content_fingerprint)
        return { kind: "document_changed", file: current, ...archived };
      if (expect.rev !== current.rev)
        return { kind: "rev_mismatch", rev: current.rev, ...archived };
      const built = build(ensured);
      if ("skip" in built)
        return { kind: "skipped", file: current, value: built.skip, ...archived };
      saveAnnotationsFile(paths.dataDir, docId, built.next, {
        bumpRev: true,
        ...(built.preserveUnknown ? { preserveUnknown: true } : {}),
      });
      saved = true;
      return { kind: "saved", file: { ...built.next, rev: built.next.rev + 1 }, ...archived };
    });
    return outcome.then((result) => {
      if (saved) annotationChanged(docId, "put");
      return result;
    });
  }
  /** rebuild through the lock. */
  const lockedRebuild = (
    p: LibraryPaths,
    opts: { sources: MetadataSources }
  ): Promise<RefreshResponse> =>
    libraryLock.run(async () => {
      // rebuild re-saves library.json with the typed model, which strips keys it does not know. Inside the same
      // lock, snapshot the raw file first and put those keys back afterwards (copilot ticket 15). library.bib is a
      // typed projection and is not touched; a Work whose id changed or that was merged cannot be matched.
      let before: unknown = null;
      try {
        before = existsSync(p.libraryJson) ? JSON.parse(readFileSync(p.libraryJson, "utf8")) : null;
      } catch {
        before = null; // an unreadable file is rebuild's own business
      }
      let result: RefreshResponse;
      try {
        result = await rebuild(p, opts);
      } catch (rebuildError) {
        // rebuild may fail AFTER it saved (a later step, for example the graph cache). If the file changed, the
        // keys it stripped still go back; the rebuild's own error is what gets reported.
        try {
          restoreUnknownKeys(p, before);
        } catch {
          /* the rebuild error below is the one that explains the failure */
        }
        throw rebuildError;
      }
      try {
        restoreUnknownKeys(p, before);
      } catch (error) {
        throw new Error(
          `the library was rebuilt but keys the application does not know could not be put back: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return result;
    });

  // app.py's `_ALLOWED_ORIGINS` + the server's own port (see header note).
  const allowedOrigins = new Set([
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
  ]);
  if (deps.port !== undefined && deps.port !== 8000) {
    allowedOrigins.add(`http://localhost:${deps.port}`);
    allowedOrigins.add(`http://127.0.0.1:${deps.port}`);
  }

  const app = new Hono();

  // Dev: the Vite dev server (localhost:5173) calls this API directly.
  // allowHeaders left empty → hono reflects the requested headers, matching
  // Starlette's `allow_headers=["*"]`.
  app.use(
    "*",
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      allowMethods: ["GET"],
    })
  );

  /** `_guard_csrf`: reject cross-site mutations; no-Origin local tools pass. */
  const guardCsrf = (
    origin: string | undefined
  ): { body: { detail: string }; status: 403 } | null =>
    origin !== undefined && !allowedOrigins.has(origin)
      ? { body: { detail: "cross-site request rejected" }, status: 403 }
      : null;

  const providerSettings = deps.providerSettings ?? new ProviderSettings();
  mountProviderRoutes(app, providerSettings, guardCsrf);
  const copilot = deps.copilot ?? new CopilotHost(paths.dataDir, providerSettings, broadcast);
  mountCopilotRoutes(app, copilot, guardCsrf);
  // Text Docs (ticket 25): create under a Work, source save, validate and explicit generate.
  const textDocs = new TextDocService({
    paths,
    libraryLock,
    annotationLock,
    docMutations,
    // A source save or a publication may end a pending replacement card bound to older values.
    broadcast: (message) => {
      broadcast(message);
      if (message.type === "text-source.changed" || message.type === "text-doc.published")
        void copilot.revalidateDocConfirmations().catch(() => {});
    },
    libraryChanged: () => libraryChanged("add"),
    // The source panel's "add image from the source PDF" and the tool's add_pdf_image: the same verified, queued read.
    renderPdfRegion: async (request): Promise<PdfRegionOutcome> => {
      const source = pdfSource(request.pdfDocId, { expectedHash: request.expectedHash });
      if (source.kind === "bad_id" || source.kind === "not_found") return { kind: "not_found" };
      if (source.kind === "busy" || source.kind === "changed") return { kind: source.kind };
      if (source.kind !== "ok")
        return { kind: source.kind === "inconsistent" ? "inconsistent" : "error" };
      try {
        const image = await renderPdfRegionImage(
          source.bytes,
          source.metadata.sha256,
          request.pageIndex,
          request.region,
          request.longEdge
        );
        return { kind: "ok", png: image.png, width: image.width, height: image.height };
      } catch (error) {
        const failure = pdfMaterialFailure(error);
        return failure.status === 400
          ? { kind: "invalid", detail: failure.detail }
          : failure.status === 409
            ? { kind: "changed" }
            : failure.status === 503
              ? { kind: "resource", detail: failure.detail }
              : { kind: "error" };
      }
    },
    ...(deps.textDocHooks ?? {}),
  });
  mountTextDocRoutes(app, textDocs, guardCsrf);
  // The Copilot `plan` tool shares the Plan lock, store and plan.changed notification with PUT.
  const currentGraph = () =>
    loadCurrentGraph(paths) ??
    libraryLock.run(async () => loadCurrentGraph(paths) ?? healGraph(paths));
  // The Copilot `library` tool shares the library lock, the narrow work patch and library.changed with
  // PATCH /api/library/refs, and reads the same payload as GET /api/library.
  const libraryOps: LibraryOpDeps = {
    paths,
    libraryLock,
    onChanged: () => libraryChanged("patch"),
    importWorks: (req, options) => importManualWorks(req, options),
    readPayload: async () => libraryPayload(paths, await currentGraph()),
    acquisition: {
      startPdf: (workId) => startArxivPdfAcquisition(workId),
      describeSource: (workId) => describeArxivSource(workId),
      startSource: (workId) => startArxivSource(workId),
      annotationRisk: (docId) => annotationRisk(docId),
      jobs: runner,
      ...(deps.acquisitionWaitMs !== undefined ? { waitMs: deps.acquisitionWaitMs } : {}),
    },
    deletion: {
      describe: (docId) => describeDocDelete(docId),
      delete: (docId, expect) => deleteDocGlobally(docId, expect),
    },
  };
  /** What a system error of the shared access path says; it names no path. Each code has its own, accurate, message. */
  const annotationsErrorDetail = (err: AnnotationsError): string => {
    switch (err.code) {
      case "corrupt_ir":
        return "the stored document is damaged or outdated and cannot be read; nothing was changed";
      case "corrupt_store":
        return "the saved annotations file is damaged; nothing was changed and nothing was read";
      case "fingerprint":
        return "an image or other asset the document declares is missing or unreadable, so the document cannot be verified; nothing was changed";
      case "archive":
        return "the annotations of older text could not be moved to the archive, so the saved annotations were left exactly as they were; nothing was changed";
      case "new_current":
        return "the annotations of older text were archived (they are no longer current), but the new, empty annotations file could not be created, so nothing of your request was written; the next access creates it";
      case "not_found":
        return "no such Doc";
    }
  };
  /** The Doc's metadata file could not be read (a corrupt PDF metadata file): a system error, nothing was changed. */
  class DocMetadataError extends Error {
    constructor(cause: unknown) {
      super("the Doc's metadata could not be read", { cause });
    }
  }
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
    if (!badId(op.docId) && op.docId.trim()) {
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
  const readerOps: ReaderOpDeps = {
    write: async (op): Promise<ReaderWriteOutcome> => {
      if (badId(op.docId) || !op.docId.trim()) return { kind: "not_found" };
      let plan: AnnotationWrite | undefined;
      try {
        const commit = await commitAnnotations<AnnotationWrite>(
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
                detail: annotationsErrorDetail(err),
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
      if (!docId.trim() || badId(docId) || docId.includes("\0")) return { kind: "not_found" };
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
        const source = pdfSource(docId, { annotations: true });
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
          const failure = pdfMaterialFailure(error);
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
      write: (op, scope) => writePdfAnnotation(op, scope),
      image: async (op): Promise<PdfImageOutcome> => {
        const source = pdfSource(op.docId, { ...(op.sha256 ? { expectedHash: op.sha256 } : {}) });
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
          const failure = pdfMaterialFailure(error);
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
    read: (docId) =>
      annotationLock.run((): ReaderReadOutcome => {
        if (badId(docId) || !docId.trim()) return { kind: "not_found" };
        if (docMutations.isDocumentContentBusy(docId)) return { kind: "busy" };
        try {
          if (readPdfMetadataIfPresent(paths, docId)) return { kind: "pdf" };
        } catch {
          return { kind: "error", detail: "the Doc's metadata could not be read" };
        }
        try {
          const { ir, file, assets, stale } = readDocumentForReading(paths.dataDir, docId);
          return { kind: "ok", reading: buildReaderReading({ ir, file, assets, stale }) };
        } catch (err) {
          if (!(err instanceof AnnotationsError)) throw err;
          // The message names no path: the user's data stays untouched, whatever the reason.
          if (err.code === "not_found") return { kind: "not_found" };
          return { kind: "error", detail: annotationsErrorDetail(err) };
        }
      }),
  };
  copilot.useWorkbench({
    library: libraryOps,
    reader: readerOps,
    text: textDocs,
    writer: writerOps,
    plans: {
      statusDir: deps.statusDir,
      planLock,
      onChanged: () => planChanged("put"),
      docExists: (docId) => isLinkableDoc(LibraryStore.load(paths).works, docId),
    },
  });

  // ---- GET /api/papers ----------------------------------------------------- //

  app.get("/api/papers", (c) => {
    const ids: string[] = [];
    let names: string[] = [];
    try {
      if (statSync(outputDir).isDirectory()) names = readdirSync(outputDir).sort();
    } catch {
      names = []; // not a directory (Python: `if OUTPUT_DIR.is_dir()`)
    }
    for (const name of names) {
      try {
        const dir = join(outputDir, name);
        // a text draft (source, no reading text yet) is a Doc too
        if (statSync(dir).isDirectory() && textDocs.has(name)) {
          ids.push(name);
        } else if (statSync(dir).isDirectory() && existsSync(join(dir, `${name}.json`))) {
          const metadata = readPdfMetadataIfPresent(paths, name);
          if (metadata && pdfOwners(name).length !== 1) continue;
          ids.push(name);
        }
      } catch {
        // unreadable entry: skip (Python `d.is_dir()` never raises)
      }
    }
    return c.json({ papers: ids });
  });

  // ---- GET /api/paper/{doc_id}/description ----------------------------------- //

  // A separate, non-authoritative type hint for reader dispatch. The stored
  // TexDocIr must validate; source is copied only from explicit metadata.
  app.get("/api/paper/:doc_id/description", (c) => {
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    const owners = pdfOwners(docId);
    if (textDocs.has(docId)) {
      try {
        return c.json(textDocs.describe(docId), 200, { "Cache-Control": "no-store" });
      } catch (error) {
        const e = detail(
          `text document ${pyRepr(docId)} is damaged: ${(error as Error).message}`,
          500
        );
        return c.json(e.body, e.status);
      }
    }
    const p = join(outputDir, docId, `${docId}.json`);
    if (!existsSync(p) || !statSync(p).isFile()) {
      const e =
        owners.length === 0
          ? detail(`paper ${pyRepr(docId)} not found`, 404)
          : detail(`registered document ${pyRepr(docId)} is missing its description`, 500);
      return c.json(e.body, e.status);
    }
    let pdfMetadata: ReturnType<typeof readPdfMetadataIfPresent>;
    try {
      pdfMetadata = readPdfMetadataIfPresent(paths, docId);
    } catch {
      const e =
        owners.length === 0
          ? detail(`paper ${pyRepr(docId)} not found`, 404)
          : detail(`PDF document ${pyRepr(docId)} has invalid metadata`, 500);
      return c.json(e.body, e.status);
    }
    if (pdfMetadata) {
      if (owners.length === 0) {
        const e = detail(`paper ${pyRepr(docId)} not found`, 404);
        return c.json(e.body, e.status);
      }
      if (owners.length !== 1) {
        const e = detail(`PDF document ${pyRepr(docId)} has inconsistent Work ownership`, 500);
        return c.json(e.body, e.status);
      }
      const owner = owners[0];
      if (!owner) {
        const e = detail(`PDF document ${pyRepr(docId)} has inconsistent Work ownership`, 500);
        return c.json(e.body, e.status);
      }
      const description: DocDescription = DocDescriptionSchema.parse({
        doc_id: docId,
        format: "pdf",
        acquired_via: pdfMetadata.acquired_via,
        ...(pdfMetadata.arxiv_id ? { arxiv_id: pdfMetadata.arxiv_id } : {}),
        acquired_at: pdfMetadata.acquired_at,
        owner_work_id: owner.id,
        work_title: owner.title,
        display_name: pdfMetadata.display_name,
        byte_length: pdfMetadata.byte_length,
        sha256: pdfMetadata.sha256,
        page_count: pdfMetadata.page_count,
        pages: pdfMetadata.pages,
      });
      return c.json(description, 200, { "Cache-Control": "no-store" });
    }
    const st = statSync(p, { bigint: true });
    const stored = paperCache.load(docId, p, { mtimeNs: st.mtimeNs, size: st.size }) as Record<
      string,
      unknown
    >;
    if (typeof stored.version !== "number") {
      const e = detail(`paper ${pyRepr(docId)} is a pre-migration document, re-ingest it`, 404);
      return c.json(e.body, e.status);
    }
    const result = TexDocIrSchema.safeParse(stored);
    if (!result.success || result.data.docId !== docId) {
      const e = detail(`paper ${pyRepr(docId)} has an invalid document description`, 500);
      return c.json(e.body, e.status);
    }
    const source = result.data.source;
    const acquired = source?.acquired_via;
    const description: DocDescription = DocDescriptionSchema.parse({
      doc_id: docId,
      format: "latex",
      ...(acquired === "arxiv_eprint" || acquired === "user_latex_zip"
        ? { acquired_via: acquired }
        : {}),
    });
    return c.json(description);
  });

  app.get("/api/paper/:doc_id/pdf/snapshot", (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    if (docMutations.isDocumentContentBusy(docId)) return c.json({ detail: "document busy" }, 409);
    const owners = pdfOwners(docId);
    if (owners.length === 0) {
      const e = detail(`paper ${pyRepr(docId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if (owners.length !== 1) {
      const e = detail(`PDF document ${pyRepr(docId)} has inconsistent Work ownership`, 500);
      return c.json(e.body, e.status);
    }
    try {
      const metadata = readPdfMetadataIfPresent(paths, docId);
      if (!metadata) throw new Error("PDF metadata missing");
      readVerifiedPdf(paths, docId);
      const annotations = readPdfAnnotationsFile(paths, docId);
      const reading_position = (() => {
        try {
          return { status: "ready" as const, file: readPdfReadingPosition(paths, docId) };
        } catch {
          return {
            status: "error" as const,
            detail: "PDF reading position could not be restored; the stored sidecar is preserved",
          };
        }
      })();
      return c.json({ metadata, annotations, reading_position }, 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      const changed = error instanceof PdfContentChangedError;
      const e = detail(
        changed ? "document changed" : `PDF document ${pyRepr(docId)} or its user data is invalid`,
        changed ? 409 : 500
      );
      return c.json(e.body, e.status);
    }
  });

  app.get("/api/paper/:doc_id/pdf/reading-position", (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) return c.json({ detail: "bad doc id" }, 400);
    if (docMutations.isDocumentContentBusy(docId)) return c.json({ detail: "document busy" }, 409);
    const owners = pdfOwners(docId);
    if (owners.length === 0) return c.json({ detail: `paper ${pyRepr(docId)} not found` }, 404);
    if (owners.length !== 1)
      return c.json({ detail: "PDF document has inconsistent Work ownership" }, 500);
    try {
      readVerifiedPdf(paths, docId);
      return c.json({ status: "ready", file: readPdfReadingPosition(paths, docId) }, 200, {
        "Cache-Control": "no-store",
      });
    } catch (error) {
      return c.json(
        {
          detail:
            error instanceof PdfContentChangedError
              ? "document changed"
              : "reading position unavailable",
        },
        error instanceof PdfContentChangedError ? 409 : 500
      );
    }
  });

  app.put("/api/paper/:doc_id/pdf/reading-position", async (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) return c.json({ detail: "bad doc id" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ detail: "invalid reading position JSON" }, 400);
    }
    const parsed = PdfReadingPositionSchema.safeParse(body);
    if (!parsed.success || parsed.data.doc_id !== docId)
      return c.json({ detail: "invalid reading position data" }, 400);
    const owners = pdfOwners(docId);
    if (owners.length === 0) return c.json({ detail: `paper ${pyRepr(docId)} not found` }, 404);
    if (owners.length !== 1)
      return c.json({ detail: "PDF document has inconsistent Work ownership" }, 500);
    try {
      const saved = await readingPositionLock.run(() => {
        if (docMutations.isDocumentContentBusy(docId)) throw new PdfAnnotationConflictError("busy");
        return savePdfReadingPosition(paths, docId, parsed.data, parsed.data.rev);
      });
      if (saved.rev !== parsed.data.rev)
        broadcast({
          type: "pdf-reading-position.changed",
          doc_id: docId,
          rev: saved.rev,
          at: new Date().toISOString(),
        });
      return c.json(saved, 200, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof PdfReadingPositionConflictError)
        return c.json({ detail: "reading position rev mismatch", rev: error.currentRev }, 409);
      if (error instanceof PdfAnnotationConflictError)
        return c.json({ detail: error.message }, 409);
      if (error instanceof PdfAnnotationValidationError)
        return c.json({ detail: error.message }, 400);
      if (error instanceof PdfContentChangedError)
        return c.json({ detail: "document changed" }, 409);
      return c.json({ detail: "reading position could not be saved" }, 500);
    }
  });

  app.get("/api/paper/:doc_id/pdf/annotations/count", (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    if (docMutations.isDocumentContentBusy(docId)) return c.json({ detail: "document busy" }, 409);
    const owners = pdfOwners(docId);
    if (owners.length === 0) {
      const e = detail(`paper ${pyRepr(docId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if (owners.length !== 1) {
      const e = detail(`PDF document ${pyRepr(docId)} has inconsistent Work ownership`, 500);
      return c.json(e.body, e.status);
    }
    try {
      readVerifiedPdf(paths, docId);
      const annotations = readPdfAnnotationsFile(paths, docId);
      return c.json({
        count: annotations.annotations.length,
        content_sha256: annotations.content_sha256,
      });
    } catch (error) {
      const changed = error instanceof PdfContentChangedError;
      const e = detail(
        changed ? "document changed" : "PDF annotations could not be counted",
        changed ? 409 : 500
      );
      return c.json(e.body, e.status);
    }
  });

  app.put("/api/paper/:doc_id/pdf/annotations", async (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      const e = detail("invalid PDF annotation JSON", 400);
      return c.json(e.body, e.status);
    }
    const owners = pdfOwners(docId);
    if (owners.length === 0) {
      const e = detail(`paper ${pyRepr(docId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if (owners.length !== 1) {
      const e = detail(`PDF document ${pyRepr(docId)} has inconsistent Work ownership`, 500);
      return c.json(e.body, e.status);
    }
    const candidate = PdfAnnotationsFileSchema.safeParse(body);
    if (!candidate.success) {
      const e = detail("invalid PDF annotation data", 400);
      return c.json(e.body, e.status);
    }
    try {
      const saved = await annotationLock.run(() =>
        savePdfAnnotationsFile(
          paths,
          docId,
          candidate.data.content_sha256,
          candidate.data.rev,
          candidate.data,
          (id) => docMutations.isDocumentContentBusy(id)
        )
      );
      if (saved.rev !== candidate.data.rev) annotationChanged(docId, "put");
      return c.json(saved);
    } catch (error) {
      if (error instanceof PdfAnnotationValidationError) {
        const e = detail(error.message, 400);
        return c.json(e.body, e.status);
      }
      if (error instanceof PdfAnnotationConflictError) {
        const status = error.conflict === "busy" ? 409 : 409;
        const payload =
          error.conflict === "rev"
            ? { detail: error.message, rev: readPdfAnnotationsFile(paths, docId).rev }
            : { detail: error.message };
        return c.json(payload, status);
      }
      const e = detail("PDF annotations could not be saved", 500);
      return c.json(e.body, e.status);
    }
  });

  /** A non-negative decimal integer query value (zero-based page/size), or null when it is anything else. */
  const queryInt = (value: string | undefined): number | null | undefined =>
    value === undefined ? undefined : /^\d{1,9}$/.test(value) ? Number(value) : null;
  /** The status a failed `pdfSource` answers on the PDF material routes. */
  const pdfSourceFailure = (docId: string, kind: Exclude<PdfSource["kind"], "ok">) => {
    switch (kind) {
      case "bad_id":
        return detail("bad doc id", 400);
      case "busy":
        return { body: { detail: "document busy" }, status: 409 as const };
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

  // Original-page material (copilot ticket 20). Page indexes are ZERO-BASED. The bytes are read once and verified
  // against the Doc's immutable SHA-256, then BOTH the text and the image come from them; a hash the caller names
  // that is not the Doc's is a 409, never answered from any cache.
  app.get("/api/paper/:doc_id/pdf/pages", async (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    const hash = c.req.query("hash");
    const first = queryInt(c.req.query("first"));
    const last = queryInt(c.req.query("last"));
    if (hash !== undefined && !/^[a-f0-9]{64}$/.test(hash))
      return c.json({ detail: "hash must be a lowercase SHA-256" }, 400);
    if (first === null || last === null)
      return c.json({ detail: "first and last must be zero-based page indexes" }, 400);
    const source = pdfSource(docId, { ...(hash ? { expectedHash: hash } : {}) });
    if (source.kind !== "ok") {
      const e = pdfSourceFailure(docId, source.kind);
      return c.json(e.body, e.status);
    }
    try {
      const material = await readPdfTextMaterial(source.bytes, source.metadata.sha256, {
        ...(first !== undefined ? { first } : {}),
        ...(last !== undefined ? { last } : {}),
      });
      return c.json(
        PdfPagesResponseSchema.parse({
          doc_id: docId,
          content_sha256: material.contentSha256,
          page_count: material.pageCount,
          range: { first: material.first, last: material.last },
          pages: material.pages,
          outline: material.outline,
          outlineTruncated: material.outlineTruncated,
          image: { type: "image/png", longEdge: PDF_IMAGE_LONG_EDGE },
        }),
        200,
        { "Cache-Control": "no-store" }
      );
    } catch (error) {
      const failure = pdfMaterialFailure(error);
      return c.json({ detail: failure.detail }, failure.status);
    }
  });

  app.get("/api/paper/:doc_id/pdf/pages/:page_index/image", async (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    const hash = c.req.query("hash");
    const pageIndex = queryInt(c.req.param("page_index"));
    const edge = queryInt(c.req.query("edge"));
    if (hash === undefined || !/^[a-f0-9]{64}$/.test(hash))
      return c.json({ detail: "hash must be the lowercase SHA-256 of the original" }, 400);
    if (pageIndex === null || pageIndex === undefined)
      return c.json({ detail: "page index must be a zero-based integer" }, 400);
    if (edge === null) return c.json({ detail: "edge must be an integer number of pixels" }, 400);
    const source = pdfSource(docId, { expectedHash: hash });
    if (source.kind !== "ok") {
      const e = pdfSourceFailure(docId, source.kind);
      return c.json(e.body, e.status);
    }
    try {
      const image = await renderPdfPageImage(
        source.bytes,
        source.metadata.sha256,
        pageIndex,
        edge ?? undefined
      );
      return new Response(image.png, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": String(image.png.length),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "X-PDF-Content-Sha256": image.contentSha256,
          "X-PDF-Page-Index": String(image.pageIndex),
          "X-PDF-Page-Count": String(image.pageCount),
          "X-PDF-Image-Width": String(image.width),
          "X-PDF-Image-Height": String(image.height),
          "X-PDF-Has-Text-Layer": String(image.hasTextLayer),
        },
      });
    } catch (error) {
      const failure = pdfMaterialFailure(error);
      return c.json({ detail: failure.detail }, failure.status);
    }
  });

  app.get("/api/paper/:doc_id/pdf", (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    if (docMutations.isDocumentContentBusy(docId)) return c.json({ detail: "document busy" }, 409);
    const owners = pdfOwners(docId);
    if (owners.length === 0) {
      const e = detail(`paper ${pyRepr(docId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if (owners.length !== 1) {
      const e = detail(`PDF document ${pyRepr(docId)} has inconsistent Work ownership`, 500);
      return c.json(e.body, e.status);
    }
    try {
      const metadata = readPdfMetadataIfPresent(paths, docId);
      if (!metadata) {
        const e = detail(`PDF document ${pyRepr(docId)} has invalid metadata`, 500);
        return c.json(e.body, e.status);
      }
      const bytes = readVerifiedPdf(paths, docId);
      const name = [...metadata.original_filename]
        .map((character) => {
          const code = character.charCodeAt(0);
          return code < 0x20 || code === 0x7f || code === 0x22 || code === 0x3b || code === 0x5c
            ? "_"
            : character;
        })
        .join("");
      return new Response(bytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Length": String(bytes.length),
          "Content-Disposition": `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      const changed = error instanceof PdfContentChangedError;
      const e = detail(
        changed ? "document changed" : `PDF document ${pyRepr(docId)} cannot be verified`,
        changed ? 409 : 500
      );
      return c.json(e.body, e.status);
    }
  });

  // ---- GET /api/paper/{doc_id}/ir -------------------------------------------- //

  // Stage 5 MS3a: the stored file IS the render IR — return it as-is (the
  // ---- GET /api/paper/{doc_id}/ir -------------------------------------------- //

  // The stored file IS the render IR — return it as-is (the PaperCache's
  // mtimeNs+size key tracks edits). A file without the `version` marker is a
  // pre-migration Document JSON (deleted in MS4b): 404, same trust level as
  // before.
  app.get("/api/paper/:doc_id/ir", (c) => {
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    const p = join(outputDir, docId, `${docId}.json`);
    if (!existsSync(p) || !statSync(p).isFile()) {
      const e = detail(`paper ${pyRepr(docId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if (readPdfMetadataIfPresent(paths, docId)) {
      const e = detail(`PDF document ${pyRepr(docId)} has no LaTeX IR`, 404);
      return c.json(e.body, e.status);
    }
    const st = statSync(p, { bigint: true });
    const doc = paperCache.load(docId, p, { mtimeNs: st.mtimeNs, size: st.size }) as Record<
      string,
      unknown
    >;
    if (typeof doc.version !== "number") {
      const e = detail(`paper ${pyRepr(docId)} is a pre-migration document, re-ingest it`, 404);
      return c.json(e.body, e.status);
    }
    return c.json(doc);
  });

  // ---- GET /api/paper/{doc_id}/annotations ---------------------------------- //

  // Stage 8 §4: the access path IS the invalidation trigger — every read runs
  // the idempotent `ensureCurrentAnnotations` first (a fingerprint mismatch
  // archives the old current and starts a new empty epoch; §3: the
  // `invalidate` broadcast is allowed only after that new current exists).
  app.get("/api/paper/:doc_id/annotations", async (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    try {
      return await annotationLock.run(() => {
        if (docMutations.isDocumentContentBusy(docId)) {
          return c.json({ detail: "document busy" }, 409);
        }
        if (readPdfMetadataIfPresent(paths, docId)) {
          return c.json({ detail: "PDF annotations use the PDF reader contract" }, 400);
        }
        const result = ensureCurrentAnnotationsWithDocument(paths.dataDir, docId);
        if (result.invalidated) annotationChanged(docId, "invalidate");
        return c.json(
          c.req.query("coherent") === "1"
            ? { version: 1 as const, ir: result.ir, file: result.file, assets: result.assets }
            : result.file
        );
      });
    } catch (err) {
      if (err instanceof AnnotationsError) {
        const e = annotationsError(err);
        return c.json(e.body, e.status);
      }
      throw err;
    }
  });

  // ---- PUT /api/paper/{doc_id}/annotations ---------------------------------- //

  // Whole-document replace with the §5 double check: the body must bind the
  // CURRENT content fingerprint (a mismatch means the document was replaced —
  // ensureCurrent has already archived the old epoch; 409 "document changed"
  // carries the fresh file so the client reloads) AND the current rev (the
  // plans-style optimistic lock; its 409 carries the current rev).
  // Fingerprint/corruption failures are 500, NEVER 409. The ensure + checks +
  // save are one critical section on annotationLock.
  app.put("/api/paper/:doc_id/annotations", async (c) => {
    c.header("Cache-Control", "no-store");
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = AnnotationsFileSchema.safeParse(body);
    if (!parsed.success) {
      const e = detail("request body is not a valid annotations document", 400);
      return c.json(e.body, e.status);
    }
    let outcome: AnnotationsCommit;
    try {
      outcome = await commitAnnotations(
        docId,
        { fingerprint: parsed.data.content_fingerprint, rev: parsed.data.rev },
        () => ({ next: parsed.data })
      );
    } catch (err) {
      if (err instanceof AnnotationsError) {
        const e = annotationsError(err);
        return c.json(e.body, e.status);
      }
      throw err;
    }
    if (outcome.kind === "busy") return c.json({ detail: "document busy" }, 409);
    if (outcome.kind === "pdf")
      return c.json({ detail: "PDF annotations use the PDF reader contract" }, 400);
    if (outcome.kind === "document_changed") {
      return c.json({ detail: "document changed", file: outcome.file }, 409);
    }
    if (outcome.kind === "rev_mismatch") {
      return c.json({ detail: "rev mismatch", rev: outcome.rev }, 409);
    }
    return c.json(outcome.file);
  });

  // ---- DELETE /api/paper/{doc_id} -------------------------------------------- //
  /**
   * The one global physical delete: `DELETE /api/paper/:doc_id` and the Copilot `library` tool's `delete_doc` (after the
   * real user's confirmation) both come here, with the same busy/404/400 answers. The library step is a NARROW write
   * (`removeDocFromWorksNarrow`: re-read raw library.json, drop the Doc from every Work's doc_ids, nothing else
   * changes, library.bib is untouched); it used to be a typed whole-library save that dropped unknown keys. The raw file
   * must parse BEFORE anything is removed, so an unreadable library.json refuses the delete instead of leaving a
   * half-deleted Doc. Not atomic: the files are removed first, so a failure of the library step (rare) leaves the Doc
   * gone from disk while library.json still lists it; the caller is told and a retry finishes the cleanup.
   */
  const holdersOf = (docId: string) =>
    LibraryStore.load(paths)
      .works.filter((work) => work.doc_ids.includes(docId))
      .map((work) => ({ id: work.id, title: work.title, docIds: [...work.doc_ids] }));
  /** What the lock-time check compares: which Works hold the Doc and their Doc lists (a main-Doc change included). */
  const holdersKey = (held: { id: string; docIds: string[] }[]) =>
    JSON.stringify(held.map(({ id, docIds }) => ({ id, docIds })));
  const deleteDocGlobally = async (
    docId: string,
    /** The Copilot tool passes what its confirmation showed; the page's own route has no such binding. */
    expect?: { holders: string }
  ): Promise<DocDeleteOutcome> => {
    if (!docId.trim() || badId(docId)) return { kind: "bad_id" };
    const docDir = join(outputDir, docId);
    if (!existsSync(docDir) || !statSync(docDir).isDirectory()) return { kind: "not_found" };
    if (!docMutations.tryBeginDelete(docId)) return { kind: "busy" };
    let works: RemovedDocWork[] = [];
    let changed = false;
    try {
      await libraryLock.run(() => {
        // The library file must be a readable object with a works array BEFORE anything is removed.
        if (existsSync(paths.libraryJson)) {
          const parsed: unknown = JSON.parse(readFileSync(paths.libraryJson, "utf8"));
          if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !Array.isArray((parsed as { works?: unknown }).works)
          )
            throw new Error("library.json is not a library file");
        }
        // The card was approved for these holders: if a library write got in first, nothing is deleted.
        if (expect && holdersKey(holdersOf(docId)) !== expect.holders) {
          changed = true;
          return;
        }
        rmSync(docDir, { recursive: true, force: true });
        rmSync(annotationsDocDir(paths.dataDir, docId), { recursive: true, force: true });
        works = removeDocFromWorksNarrow(paths, docId).works;
      });
    } catch (err) {
      return { kind: "failed", message: (err as Error).message };
    } finally {
      docMutations.endDelete(docId);
    }
    if (changed) return { kind: "changed" };
    libraryChanged("patch");
    return { kind: "deleted", works };
  };

  // Stage 8 §8: GLOBAL physical delete — `output/<doc>/` + `annotations/<doc>/`
  // (current + archive; missing dirs tolerated), then the doc is removed from
  // EVERY work's `doc_ids` (one doc can appear in several works via identity
  // merge; core `removeDocFromWorksNarrow` is the all-works traversal). "Doc exists"
  // here means the output DIRECTORY (not its JSON, unlike the IR route): a
  // retry after a mid-delete failure — which may already have unlinked the
  // JSON — must be able to finish the cleanup, and a hollow failed-ingest dir
  // is deletable too. A doc with no output dir at all 404s; its annotations,
  // if any, stay behind as orphans (roadmap 推后: no access guarantee, no
  // auto-cleanup). Ordering: busy-check before any mutation (a queued/running
  // upload of this doc — or any refresh — answers 409 "document busy", never
  // waits; the registry claim is atomic with the check); the physical delete
  // runs BEFORE the library update, so a mid-delete failure reports 500 with
  // library.json untouched; both run under libraryLock so no library write
  // can interleave. No rebuild/enrich is triggered.
  app.delete("/api/paper/:doc_id", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const docId = c.req.param("doc_id");
    const outcome = await deleteDocGlobally(docId);
    switch (outcome.kind) {
      case "bad_id": {
        const e = detail("bad doc id", 400);
        return c.json(e.body, e.status);
      }
      case "not_found": {
        const e = detail(`paper ${pyRepr(docId)} not found`, 404);
        return c.json(e.body, e.status);
      }
      case "busy": {
        const e = detail("document busy", 409);
        return c.json(e.body, e.status);
      }
      case "failed": {
        const e = detail(`delete failed: ${outcome.message}`, 500);
        return c.json(e.body, e.status);
      }
      default:
        return c.json({ ok: true });
    }
  });

  // ---- GET /api/library ------------------------------------------------------ //

  // ---- GET /api/library ------------------------------------------------------ //

  /**
   * The Library payload. The graph cache is version-gated (Stage 14 D7):
   * missing / corrupt / invalid / wrong-version files are stale and self-heal
   * lazily — under `libraryLock`, with a double-check inside the lock, a
   * fresh-store saved-only rebuild, and an atomic rewrite. Healing is
   * derived-cache maintenance, NOT a user-data mutation: no library.changed
   * broadcast. A heal failure is a hard 500 (D13: never the old suggested
   * graph, never an empty-graph fallback); a corrupt library.json fails out
   * of LibraryStore.load the same way.
   */
  app.get("/api/library", async (c) => {
    let graph: Awaited<ReturnType<typeof currentGraph>>;
    try {
      graph = await currentGraph();
    } catch (err) {
      const e = detail(`library graph rebuild failed: ${(err as Error).message}`, 500);
      return c.json(e.body, e.status);
    }
    return c.json(libraryPayload(paths, graph));
  });

  // ---- GET /api/library/discovery (Stage 14) ------------------------------- //

  /**
   * ADS literature discovery. A safe/idempotent read: no libraryLock, no
   * JobRunner, no library.json/graph.json writes, no mutation WS — the
   * LibraryStore load is a membership snapshot only. `no-store` because the
   * response carries current Library membership (libraryId).
   */
  app.get("/api/library/discovery", async (c) => {
    c.header("Cache-Control", "no-store");
    const bibcode = (c.req.query("bibcode") ?? "").trim();
    if (badDiscoveryBibcode(bibcode)) {
      const e = detail("missing or invalid bibcode query parameter", 400);
      return c.json(e.body, e.status);
    }
    const source = deps.makeDiscoverySource?.();
    if (!source) {
      const e = detail("ADS discovery is not configured on this server", 503);
      return c.json(e.body, e.status);
    }
    try {
      const store = LibraryStore.load(paths);
      const graph = await discoverLiterature(
        bibcode,
        { ads: source, store },
        { signal: c.req.raw.signal }
      );
      if (!graph) {
        const e = detail(`ADS has no record for bibcode: ${bibcode}`, 404);
        return c.json(e.body, e.status);
      }
      return c.json(graph);
    } catch (err) {
      if (err instanceof AdsDiscoveryError) {
        const status = discoveryErrorStatus(err.kind);
        if (status === 429 && err.retryAfter) c.header("Retry-After", err.retryAfter);
        const e = detail(err.message, status);
        return c.json(e.body, e.status);
      }
      throw err; // unexpected (incl. client abort) — Hono's 500 path
    }
  });

  // ---- GET /api/plans -------------------------------------------------------- //

  // The plan page's whole document (Stage 4): a missing plans.json reads as
  // the empty document (core loadPlans); a corrupt one surfaces as a 500 —
  // never a silent reset.
  app.get("/api/plans", (c) => c.json(readPlans(deps.statusDir)));

  // ---- Task-delete undo (shared with the Copilot tool and panel) --------------- //

  // The deletes the service can still undo (8-second window; today: the ones the Copilot made), so the Plan
  // page offers the same undo snackbar for them as for the user's own deletes.
  app.get("/api/plans/undo", (c) =>
    c.json({
      undoable: copilot.taskUndo.active().map((entry) => ({
        id: entry.id,
        planId: entry.planId,
        taskId: entry.taskId,
        title: entry.title,
        ...(entry.source
          ? { conversationId: entry.source.conversationId, toolCallId: entry.source.toolCallId }
          : {}),
        until: new Date(entry.until).toISOString(),
      })),
    })
  );
  // The same restore the Copilot's `undo_delete_task` runs: 200 restored (or already back), 409 expired or
  // conflict (nothing written), 404 nothing to undo.
  app.post("/api/plans/undo", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const body = (await c.req.json().catch(() => null)) as { id?: unknown } | null;
    if (!body || typeof body.id !== "string") {
      const e = detail("request body needs the undo id", 400);
      return c.json(e.body, e.status);
    }
    const outcome = await copilot.undoTaskDelete(body.id);
    if (outcome.ok) return c.json({ status: outcome.status, rev: outcome.rev });
    return c.json(
      { status: outcome.status, detail: outcome.detail },
      outcome.status === "not_found" ? 404 : 409
    );
  });

  // ---- PUT /api/plans -------------------------------------------------------- //

  // Whole-document replace with the persisted `rev` optimistic lock: the body
  // must carry the current rev, the save bumps it, and the updated document
  // (new rev) is returned. A mismatch answers 409 with the current rev so the
  // client can reload + rebase. The rev check and the save are one critical
  // section on planLock.
  app.put("/api/plans", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = PlansFileSchema.safeParse(body);
    if (!parsed.success) {
      const e = detail("request body is not a valid plans document", 400);
      return c.json(e.body, e.status);
    }
    const outcome = await replacePlans(deps.statusDir, planLock, parsed.data, () => {
      planChanged("put");
      // A delete the model asked for is bound to the plans version the user saw; this save may end it.
      copilot.revalidateConfirmations();
    });
    if ("conflictRev" in outcome) {
      return c.json({ detail: "rev mismatch", rev: outcome.conflictRev }, 409);
    }
    return c.json(outcome.saved);
  });

  // ===========================================================================
  // Writer (Stage 10 M2a) — manuscripts + templates + figure assets
  // ===========================================================================

  // Manuscripts live at `<dataDir>/manuscripts/m_<8hex>/manuscript.json`
  // (+ assets/), templates at `<dataDir>/templates/<id>.json` (core
  // writer/store.ts). Writes are serialized on writerLock (mirrors planLock;
  // it never blocks the other locks). The PUT optimistic lock mirrors the
  // plans PUT: body.rev must equal the stored rev; a mismatch answers 409
  // with the current rev AND the current document so the client can rebase.

  const MANUSCRIPT_ID = /^m_[0-9a-f]{8}$/;
  const badManuscriptId = (id: string) => !MANUSCRIPT_ID.test(id);

  // ---- GET /api/writer/templates ------------------------------------------ //

  // Built-ins + user files (same-id user file wins); broken user files come
  // back as warnings, never block (core loadTemplates).
  app.get("/api/writer/templates", (c) => c.json(loadTemplates(writerDataDir)));

  // ---- GET /api/writer/manuscripts ---------------------------------------- //

  // Summaries for the list page, updated_at desc; corrupt dirs are skipped
  // with warnings (one bad dir must not hide the list).
  app.get("/api/writer/manuscripts", (c) => c.json(listManuscripts(writerDataDir)));

  // ---- POST /api/writer/manuscripts ---------------------------------------- //

  // Create requires a known template (built-in or user file). 201 carries the
  // full fresh manuscript; `writer.changed` cause:"create".
  app.post("/api/writer/manuscripts", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const body: unknown = await c.req.json().catch(() => null);
    const rec =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;
    const template = rec?.template;
    const title = rec?.title;
    if (typeof template !== "string" || !template) {
      const e = detail("template required", 400);
      return c.json(e.body, e.status);
    }
    if (title !== undefined && typeof title !== "string") {
      const e = detail("title must be a string", 400);
      return c.json(e.body, e.status);
    }
    const created = await createManuscriptOp(writerOps, { template, title });
    if (!created.ok || !created.manuscript) {
      const e = detail(`unknown template ${pyRepr(template)}`, 400);
      return c.json(e.body, e.status);
    }
    return c.json(created.manuscript, 201);
  });

  // ---- GET /api/writer/manuscripts/:id -------------------------------------- //

  app.get("/api/writer/manuscripts/:id", (c) => {
    const id = c.req.param("id");
    if (badManuscriptId(id)) {
      const e = detail("bad manuscript id", 400);
      return c.json(e.body, e.status);
    }
    const doc = loadManuscript(writerDataDir, id);
    if (doc === null) {
      const e = detail(`manuscript ${pyRepr(id)} not found`, 404);
      return c.json(e.body, e.status);
    }
    return c.json(doc);
  });

  // ---- PUT /api/writer/manuscripts/:id --------------------------------------- //

  // Whole-document replace with the persisted rev optimistic lock (the plans
  // PUT's exact shape); the save bumps rev + updated_at.
  app.put("/api/writer/manuscripts/:id", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = c.req.param("id");
    if (badManuscriptId(id)) {
      const e = detail("bad manuscript id", 400);
      return c.json(e.body, e.status);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ManuscriptSchema.safeParse(body);
    if (!parsed.success) {
      const e = detail("request body is not a valid manuscript", 400);
      return c.json(e.body, e.status);
    }
    if (parsed.data.id !== id) {
      const e = detail("body id does not match the URL", 400);
      return c.json(e.body, e.status);
    }
    const outcome = await replaceManuscript(writerOps, id, parsed.data);
    if ("missing" in outcome) {
      const e = detail(`manuscript ${pyRepr(id)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if ("conflict" in outcome) {
      return c.json(
        { detail: "rev mismatch", rev: outcome.conflict.rev, current: outcome.conflict },
        409
      );
    }
    // I031 (Stage 12): saving never compiles. Rendering is explicit only
    // (Shift+Enter / Render → POST numbering/refresh).
    return c.json(outcome.saved);
  });

  // ---- GET/POST /api/writer/manuscripts/:id/numbering -------------------------- //

  // Stage 10 M3 (D14): compile-truth numbering for outline/crossref panels.
  // The GET is a pure read of the derived cache (never compiled on demand).
  app.get("/api/writer/manuscripts/:id/numbering", async (c) => {
    const id = c.req.param("id");
    if (badManuscriptId(id)) {
      const e = detail("bad manuscript id", 400);
      return c.json(e.body, e.status);
    }
    try {
      return c.json(await getWriterNumbering(writerDataDir, id));
    } catch (err) {
      if (err instanceof WriterNumberingError) {
        const e = detail(err.message, 404);
        return c.json(e.body, e.status);
      }
      throw err;
    }
  });

  // Manual refresh: bypass the debounce, run one compile now (single-flight).
  app.post("/api/writer/manuscripts/:id/numbering/refresh", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = c.req.param("id");
    if (badManuscriptId(id)) {
      const e = detail("bad manuscript id", 400);
      return c.json(e.body, e.status);
    }
    // A refresh the page makes while carrying out a Copilot view action (commit_cell) is marked by the page: without
    // the OS sandbox the Copilot never causes a compile, so the server refuses it here (the service, not the page,
    // decides). The user's own Render sends no marker and compiles as it always did.
    if (c.req.header("x-copilot-action") && !writerOps.sandboxed()) {
      const e = detail(
        "render not available for the Copilot: this machine has no OS sandbox for the Writer's TeX compile",
        403
      );
      return c.json(e.body, e.status);
    }
    try {
      return c.json(await runWriterNumberingNow(writerDataDir, id, { broadcast }));
    } catch (err) {
      if (err instanceof WriterNumberingError) {
        const e = detail(err.message, err.kind === "canceled" ? 409 : 404);
        return c.json(e.body, e.status);
      }
      throw err;
    }
  });

  // ---- DELETE /api/writer/manuscripts/:id ------------------------------------ //

  // Physical delete of the whole m_<id>/ directory (assets included).
  app.delete("/api/writer/manuscripts/:id", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = c.req.param("id");
    if (badManuscriptId(id)) {
      const e = detail("bad manuscript id", 400);
      return c.json(e.body, e.status);
    }
    const removed = await deleteManuscriptOp(writerOps, id);
    if (!removed.ok) {
      const e = detail(`manuscript ${pyRepr(id)} not found`, 404);
      return c.json(e.body, e.status);
    }
    return c.json({ ok: true });
  });

  // ---- POST /api/writer/manuscripts/:id/assets?filename= --------------------- //

  // Raw-body figure upload (the zip upload route's arrayBuffer pattern);
  // 20 MB cap; the extension allowlist + collision renaming live in the
  // store (writeManuscriptAsset). 201 carries the stored name.
  app.post("/api/writer/manuscripts/:id/assets", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = c.req.param("id");
    if (badManuscriptId(id)) {
      const e = detail("bad manuscript id", 400);
      return c.json(e.body, e.status);
    }
    const filename = c.req.query("filename");
    if (!filename) {
      const e = detail("filename query param required", 400);
      return c.json(e.body, e.status);
    }
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (data.length === 0) {
      const e = detail("request body is empty", 400);
      return c.json(e.body, e.status);
    }
    if (data.length > 20 * 1024 * 1024) {
      const e = detail("asset too large (max 20 MB)", 400);
      return c.json(e.body, e.status);
    }
    const outcome = await writerLock.run(
      (): { missing: true } | { name: string } | { bad: string } => {
        if (loadManuscript(writerDataDir, id) === null) return { missing: true };
        try {
          return { name: writeManuscriptAsset(writerDataDir, id, filename, data) };
        } catch (err) {
          return { bad: (err as Error).message };
        }
      }
    );
    if ("missing" in outcome) {
      const e = detail(`manuscript ${pyRepr(id)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if ("bad" in outcome) {
      const e = detail(outcome.bad, 400);
      return c.json(e.body, e.status);
    }
    // A pending Copilot delete card names the figure files it would delete: a new one ends it.
    copilot.revalidateWriterConfirmations();
    return c.json({ name: outcome.name }, 201);
  });

  // ---- GET /api/writer/manuscripts/:id/assets/:name -------------------------- //

  app.get("/api/writer/manuscripts/:id/assets/:name", (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    c.header("Cache-Control", "no-cache");
    if (badManuscriptId(id) || badId(name)) {
      const e = detail("bad asset path", 400);
      return c.json(e.body, e.status);
    }
    let bytes: Buffer | null;
    try {
      bytes = readManuscriptAsset(writerDataDir, id, name);
    } catch (err) {
      const e = detail((err as Error).message, 400); // rejected traversal name
      return c.json(e.body, e.status);
    }
    if (bytes === null) {
      const e = detail("asset not found", 404);
      return c.json(e.body, e.status);
    }
    return c.body(new Uint8Array(bytes), 200, { "Content-Type": mimeFor(name) });
  });

  // Materialized figures from the shared IR pipeline, separate from upload sources.
  app.get("/api/writer/manuscripts/:id/preview-assets/:name", async (c) => {
    const id = c.req.param("id"),
      name = c.req.param("name");
    if (badManuscriptId(id) || badId(name) || name.includes("\\") || name.includes("\0"))
      return c.json({ detail: "bad asset path" }, 400);
    if (!loadManuscript(writerDataDir, id)) return c.json({ detail: "manuscript not found" }, 404);
    const path = join(manuscriptDir(writerDataDir, id), "build", "assets", name);
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(path)) !== resolve(path))
        return c.json({ detail: "unsafe asset path" }, 400);
      c.header("Cache-Control", "no-cache");
      return c.body(new Uint8Array(await readFile(path)), 200, { "Content-Type": mimeFor(name) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT")
        return c.json({ detail: "asset not found" }, 404);
      throw err;
    }
  });

  // ---- GET /api/writer/manuscripts/:id/export --------------------------------- //

  // Stage 10 M3: server-assembled zip = manuscript.tex (single file) +
  // references.bib (cited-only, verbatim from library.bib) + referenced
  // figure assets under assets/. Stage 12: template dependencies (cls/sty/bst)
  // ship at the zip root so a local latexmk run is self-contained.
  // `X-Writer-Bib-Missing` carries the cited keys that had no library.bib
  // entry (percent-encoded JSON array).
  app.get("/api/writer/manuscripts/:id/export", async (c) => {
    const id = c.req.param("id");
    if (badManuscriptId(id)) {
      const e = detail("bad manuscript id", 400);
      return c.json(e.body, e.status);
    }
    let bundle: WriterExportBundle;
    try {
      bundle = buildWriterExport(writerDataDir, id);
    } catch (err) {
      if (err instanceof WriterExportError) {
        const e = detail(err.message, err.kind === "not-found" ? 404 : 400);
        return c.json(e.body, e.status);
      }
      throw err;
    }
    const preview = await getWriterNumbering(writerDataDir, id);
    if (preview.status !== "ok")
      bundle.warnings.push(
        preview.lastError ??
          "Source archive only: compilation has not been validated for this version."
      );
    const zip = zipEntries([
      { name: "manuscript.tex", data: bundle.tex },
      ...(bundle.warnings.length
        ? [{ name: "EXPORT-WARNINGS.txt", data: `${bundle.warnings.join("\n")}\n` }]
        : []),
      ...(bundle.bib !== null ? [{ name: "references.bib", data: bundle.bib }] : []),
      ...(await Promise.all(
        bundle.deps.map(async (d) => ({ name: d.name, data: await readFile(d.abs) }))
      )),
      ...(await Promise.all(
        bundle.assets.map(async (a) => ({
          name: `assets/${a.name}`,
          data: await readFile(a.abs),
        }))
      )),
    ]);
    const slug =
      bundle.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60) || "manuscript";
    return c.body(new Uint8Array(zip), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      "X-Writer-Bib-Missing": encodeURIComponent(JSON.stringify(bundle.bibMissing)),
      "X-Writer-Warnings": encodeURIComponent(JSON.stringify(bundle.warnings)),
    });
  });

  // ---- POST /api/library/works (Stage 13 manual creation) ----------------- //

  // ---- Stage 15: legacy manual arXiv LaTeX fetch --------------------------- //

  /** Hidden config gate: re-read config.toml before automatic PDF submission. */
  const autoIngestArxiv = deps.autoIngestArxiv ?? (() => getConfig().auto_ingest_arxiv !== false);
  const fetchArxivPdf = deps.fetchArxivPdf;
  const isPdfDoc = (docId: string): boolean => {
    let metadata: ReturnType<typeof readPdfMetadataIfPresent>;
    try {
      metadata = readPdfMetadataIfPresent(paths, docId);
    } catch {
      return false;
    }
    if (!metadata) return false;
    if (pdfOwners(docId).length !== 1) throw new Error("PDF Doc has inconsistent Work ownership");
    return true;
  };

  const appendArxivDocToPdfWork = (workId: string, docId: string): Promise<boolean> =>
    libraryLock.run(() => {
      const work = LibraryStore.load(paths).get(workId);
      if (!work || arxivAttachScenario(work, docId, isPdfDoc) !== "append") return false;
      return appendDocIdNarrow(paths, workId, docId) !== "not_found";
    });

  /**
   * The link step of an arXiv LaTeX attach, inside the library lock: re-read, re-check the scenario, and add only
   * this Doc (and, for a docless Work, make it main) with narrow writes. The minutes-long ingest ran outside the
   * lock; nothing written meanwhile (imports, main-Doc changes, unknown keys) is overwritten.
   */
  const linkArxivDoc = (workId: string, docId: string): Promise<boolean> =>
    libraryLock.run(() => {
      const work = LibraryStore.load(paths).get(workId);
      if (!work) return false;
      const scenario = arxivAttachScenario(work, docId, isPdfDoc);
      if (scenario === "skip") return false;
      if (scenario === "refresh") return true;
      if (appendDocIdNarrow(paths, workId, docId) === "not_found") return false;
      if (scenario === "attach") patchWorkNarrow(paths, workId, { doc_id: docId });
      return true;
    });

  /** Queue the legacy Stage 15 LaTeX source job for the explicit
   * /api/library/attach-arxiv endpoint. Automatic acquisition uses the separate
   * immutable PDF path below; this legacy D16 scenario never mutates PDF Docs.
   */
  const submitArxivFetch = (workId: string): Job | null => {
    const w = LibraryStore.load(paths).get(workId);
    if (!w) return null;
    const arxivId = normArxiv(w.arxiv_id);
    if (!arxivId) return null;
    const docId = arxivDocId(arxivId);
    if (arxivAttachScenario(w, docId, isPdfDoc) === "skip") return null;
    const dupe = runner
      .list()
      .find(
        (j) =>
          j.kind === "ingest" &&
          (j.status === "queued" || j.status === "running") &&
          (j.payload as { workId?: unknown } | undefined)?.workId === workId
      );
    if (dupe) return dupe;
    if (docMutations.isDeleting(docId)) return null; // busy; the endpoint pre-409s
    // The §8 writer pin spans submit → terminal state (upload precedent).
    docMutations.pinWriter(docId);
    // Failure-stage tracking for the arxiv-fetch.jsonl iteration log (D12).
    let stage: ArxivFetchStage = "download";
    let job: Job;
    try {
      job = runner.submit(
        "ingest",
        async (j, report) => {
          const track = (m: string): void => {
            if (m === "Rebuilding library") stage = "attach";
            else if (
              m.startsWith("Compiling") ||
              m.startsWith("Fusing") ||
              m.startsWith("Materializing")
            ) {
              stage = "compile";
            }
            report(m);
          };
          try {
            return await attachArxivDoc(workId, {
              paths,
              pipelines: deps.pipelines,
              sources: deps.makeSources(false),
              rebuild: lockedRebuild,
              // N1 (upload precedent): the main-doc re-assert must be mutually
              // exclusive with PATCH — the weld runs outside the lock.
              reassertMainDoc: (p, wid, d) =>
                libraryLock.run(() => patchWorkNarrow(p, wid, { doc_id: d }).status === "ok"),
              linkDoc: (_p, wid, did) => linkArxivDoc(wid, did),
              onProgress: track,
              isPdfDoc,
              appendArxivDocToPdfWork: (_p, wid, did) => appendArxivDocToPdfWork(wid, did),
            });
          } catch (e) {
            if (e instanceof ArxivPdfOnlyError) {
              stage = "extract";
              // Machine-readable class for the web UI's bilingual guidance.
              j.errorCode = "arxiv_pdf_only";
            }
            throw e;
          }
        },
        { workId, arxivId }
      );
    } catch (err) {
      // No job exists → no terminal hook will ever fire; release directly.
      docMutations.unpinWriter(docId);
      throw err;
    }
    // `library.changed` must follow `job.done` on the wire (upload
    // precedent); the pin releases with the terminal state, whichever it is.
    void runner.waitFor(job.id).then((j) => {
      docMutations.unpinWriter(docId);
      if (j.status === "done") {
        libraryChanged("ingest");
      } else if (j.status === "failed") {
        // D12: plain-text JSONL iteration log (readable in the packaged v1);
        // a logging failure must never mask the job's own outcome.
        try {
          appendArxivFetchLog(paths.dataDir, {
            time: j.finishedAt ?? new Date().toISOString(),
            jobId: j.id,
            workId,
            arxivId,
            stage,
            error: j.error ?? "unknown failure",
          });
        } catch (logErr) {
          console.error("arxiv-fetch log append failed:", logErr);
        }
      }
    });
    return job;
  };

  const registeredPdfDocIds = (workId: string): string[] => {
    const work = LibraryStore.load(paths).get(workId);
    if (!work) return [];
    return work.doc_ids.filter((docId) => {
      try {
        return readPdfMetadataIfPresent(paths, docId) !== null;
      } catch {
        // Do not auto-fetch around an unreadable registered Doc: its actual
        // format cannot safely be inferred from its id, title or old summary.
        return true;
      }
    });
  };

  /** Queue an independent immutable PDF acquisition from the current arXiv URL. */
  const submitArxivPdf = (workId: string, automatic: boolean): Job | null => {
    const work = LibraryStore.load(paths).get(workId);
    const arxivId = work ? normArxiv(work.arxiv_id) : null;
    if (!work || !arxivId) return null;
    if (automatic && registeredPdfDocIds(workId).length > 0) return null;
    const dupe = runner.list().find((job) => {
      const payload = job.payload as
        | { workId?: unknown; format?: unknown; automatic?: unknown }
        | undefined;
      return (
        job.kind === "upload" &&
        payload?.format === "arxiv-pdf" &&
        payload.workId === workId &&
        payload.automatic === automatic &&
        (job.status === "queued" || job.status === "running")
      );
    });
    if (dupe) return dupe;
    const docId = `pdf-${randomUUID()}`;
    if (docMutations.isDeleting(docId)) return null;
    docMutations.pinWriter(docId);
    let job: Job;
    try {
      job = runner.submit(
        "upload",
        async (_job, report) => {
          const latestWork = LibraryStore.load(paths).get(workId);
          if (!latestWork || normArxiv(latestWork.arxiv_id) !== arxivId)
            throw new Error("Work arXiv identity changed before PDF acquisition");
          if (automatic) {
            const existing = registeredPdfDocIds(workId);
            if (existing.length > 0) return { status: "skipped", docId: existing[0] };
          }
          if (!fetchArxivPdf) throw new Error("arXiv PDF source is unavailable");
          report("Fetching current arXiv PDF");
          const bytes = await fetchArxivPdf(arxivId);
          if (bytes.length === 0 || bytes.length > PDF_MAX_BYTES)
            throw new Error(`PDF size is outside the supported limit (${PDF_MAX_BYTES} bytes)`);
          report("Validating PDF");
          const probe = await probePdf(bytes);
          report("Publishing PDF Doc");
          return await libraryLock.run(() => {
            const current = LibraryStore.load(paths).get(workId);
            if (!current || normArxiv(current.arxiv_id) !== arxivId)
              throw new Error("Work arXiv identity changed before PDF publication");
            if (automatic) {
              const existing = registeredPdfDocIds(workId);
              if (existing.length > 0) return { status: "skipped", docId: existing[0] };
            }
            const metadata = publishPdfDoc(paths, {
              docId,
              workId,
              filename: `arxiv-${arxivId.replace(/[^A-Za-z0-9._-]+/g, "-")}.pdf`,
              bytes,
              pages: probe.pages,
              acquiredVia: "arxiv_pdf",
              arxivId,
              deduplicate: false,
            });
            return { status: "created", doc: metadata };
          });
        },
        { workId, docId, format: "arxiv-pdf", arxivId, automatic }
      );
    } catch (error) {
      docMutations.unpinWriter(docId);
      throw error;
    }
    void runner.waitFor(job.id).then((finished) => {
      docMutations.unpinWriter(docId);
      if (
        finished.status === "done" &&
        (finished.result as { status?: unknown } | null)?.status === "created"
      ) {
        libraryChanged("upload");
      }
    });
    return job;
  };

  // ---- shared starts: the acquisition dialog's submits (HTTP routes) and the Copilot `library` tool ---- //

  const reusedJob = (job: Job, before: Set<string>) => before.has(job.id);

  /** `POST /api/library/acquire-arxiv-pdf` minus the HTTP shape. Throws when the job could not be queued. */
  const startArxivPdfAcquisition = (workId: string): ArxivStart => {
    const work = LibraryStore.load(paths).get(workId);
    if (!work) return { kind: "not_found" };
    if (!normArxiv(work.arxiv_id)) return { kind: "no_arxiv" };
    const before = new Set(runner.list().map((job) => job.id));
    const job = submitArxivPdf(workId, false);
    if (!job) return { kind: "not_queued" };
    return { kind: "queued", job, reused: reusedJob(job, before) };
  };

  /** What `attach-arxiv` would do for this Work, decided with the endpoint's own checks. */
  const describeArxivSource = (workId: string): ArxivSourcePlan => {
    const w = LibraryStore.load(paths).get(workId);
    if (w === undefined) return { kind: "not_found" };
    const arxivId = normArxiv(w.arxiv_id);
    if (!arxivId) return { kind: "no_arxiv" };
    const docId = arxivDocId(arxivId);
    // Keep Scenario C for existing non-PDF content (especially a LaTeX zip). A PDF-only Work is the narrow
    // approved exception: its new LaTeX Doc is appended and cannot replace the user's current PDF main Doc.
    const scenario = arxivAttachScenario(w, docId, isPdfDoc);
    if (scenario === "skip") return { kind: "skip" };
    if (docMutations.isDeleting(docId)) return { kind: "busy" };
    return { kind: scenario, docId, title: w.title, docIds: [...w.doc_ids] };
  };

  /** `POST /api/library/attach-arxiv` minus the HTTP shape. Not gated by the hidden auto_ingest_arxiv config. */
  const startArxivSource = (workId: string): ArxivStart => {
    const plan = describeArxivSource(workId);
    if (
      plan.kind === "not_found" ||
      plan.kind === "no_arxiv" ||
      plan.kind === "skip" ||
      plan.kind === "busy"
    )
      return { kind: plan.kind };
    const before = new Set(runner.list().map((job) => job.id));
    const job = submitArxivFetch(workId);
    if (job === null) return { kind: "not_queued" };
    return { kind: "queued", job, reused: reusedJob(job, before) };
  };

  /**
   * What the acquisition dialog's annotation-risk step shows for a replacement target, computed WITHOUT writing
   * (no ensure/archive): a stale current file counts as 0 annotations and the next normal access archives it.
   */
  const annotationRisk = (docId: string): Promise<AnnotationRisk> =>
    annotationLock.run((): AnnotationRisk => {
      if (badId(docId) || !docId.trim()) return { state: "unknown" };
      if (docMutations.isDocumentContentBusy(docId)) return { state: "busy" };
      try {
        if (readPdfMetadataIfPresent(paths, docId)) return { state: "unknown" };
      } catch {
        return { state: "unknown" };
      }
      // Read only, like the CLI `annot`: archiving belongs to the GET/PUT annotations access path alone.
      return readAnnotationRisk(paths.dataDir, docId);
    });

  /**
   * What the delete dialog shows for a Doc, computed WITHOUT writing (no ensure, no archive, never the archive's
   * content): the Works that list it, the current annotation count (LaTeX: the same read-only read as the CLI `annot`,
   * a stale file counts 0 and the next normal access archives it; PDF: the verified sidecar) and the digest a
   * Copilot confirmation card is bound to. A count that cannot be read is `unknown`, never zero. A busy Doc (an
   * upload/refresh pins it, or it is being deleted) is `busy`: no card is worth showing, the delete would be refused.
   */
  const describeDocDelete = async (docId: string): Promise<DocDeleteDescription> => {
    if (!docId.trim() || badId(docId)) return { kind: "bad_id" };
    const docDir = join(outputDir, docId);
    if (!existsSync(docDir) || !statSync(docDir).isDirectory()) return { kind: "not_found" };
    if (docMutations.isBusy(docId) || docMutations.isDeleting(docId)) return { kind: "busy" };
    let held: { id: string; title: string; docIds: string[] }[];
    try {
      held = holdersOf(docId);
    } catch {
      return { kind: "error", detail: "the library could not be read" };
    }
    // The Files tab only offers Docs a Work lists; an orphan directory is not reachable from the page.
    if (held.length === 0) return { kind: "orphan" };
    return annotationLock.run((): DocDeleteDescription => {
      let format: "pdf" | "latex" | "text" = textDocs.has(docId) ? "text" : "latex";
      let impact: DocReplaceImpact = { annotations: "unknown" };
      let rev = 0;
      let bound: Record<string, unknown> = {};
      let pdf: ReturnType<typeof readPdfMetadataIfPresent> = null;
      let pdfUnreadable = false;
      try {
        pdf = readPdfMetadataIfPresent(paths, docId);
      } catch {
        pdfUnreadable = true;
      }
      if (pdf || (pdfUnreadable && existsSync(join(docDir, "original.pdf")))) format = "pdf";
      // A PDF Doc belongs to exactly one Work; anything else is an ownership error and the page counts it as unknown.
      if (pdf && held.length === 1) {
        try {
          readVerifiedPdf(paths, docId);
          const file = readPdfAnnotationsFile(paths, docId);
          impact = { annotations: "known", count: file.annotations.length };
          rev = file.rev;
          bound = { sha256: file.content_sha256 };
        } catch {
          impact = { annotations: "unknown" };
        }
      } else if (format === "text" && !existsSync(join(docDir, `${docId}.json`))) {
        // the same answer as the page's dialog (draftAnnotationImpact): zero only when no annotations dir exists
        const draft = textDocs.draftAnnotationImpact(docId);
        if (!draft.generated && draft.annotations.state === "known") {
          impact = { annotations: "known", count: draft.annotations.count };
          bound = { draft: true };
        }
      } else if (!pdf && !pdfUnreadable) {
        const risk = readAnnotationRisk(paths.dataDir, docId);
        if (risk.state === "known") {
          impact = { annotations: "known", count: risk.count };
          rev = risk.rev;
          bound = { stale: risk.stale, fingerprint: risk.fingerprint };
        }
      }
      const digest = createHash("sha256")
        .update(JSON.stringify({ docId, format, works: held, impact, rev, ...bound }))
        .digest("hex");
      return {
        kind: "ready",
        docId,
        format,
        works: held.map((work) => ({
          id: work.id,
          title: work.title,
          main: work.docIds[0] === docId,
          remaining: new Set(work.docIds.filter((d) => d !== docId)).size,
        })),
        impact,
        rev,
        digest,
        holders: holdersKey(held),
      };
    });
  };

  /**
   * The PDF upload's submit once the bytes are in hand (validated work, size and file name): same-Work identical
   * bytes reuse the Doc, DocMutationRegistry pins/busy rules, one serial durable job.
   */
  type UploadStart =
    | { kind: "queued"; job: Job; resourceWarning?: boolean }
    | { kind: "error"; status: number; detail: string };
  const startPdfUpload = (workId: string, bytes: Buffer, filename: string): UploadStart => {
    let existing: ReturnType<typeof findMatchingPdfDoc>;
    try {
      existing = findMatchingPdfDoc(
        paths,
        workId,
        bytes,
        (id) => docMutations.isBusy(id) || docMutations.isDeleting(id)
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "PDF identity check failed";
      return { kind: "error", status: message === "document busy" ? 409 : 500, detail: message };
    }
    const docId = existing?.doc_id ?? `pdf-${randomUUID()}`;
    if (docMutations.isBusy(docId) || docMutations.isDeleting(docId)) {
      return { kind: "error", status: 409, detail: "document busy" };
    }
    docMutations.pinWriter(docId);
    let job: Job;
    try {
      job = runner.submit(
        "upload",
        async (j, report) => {
          const spool = runner.spoolPath(j.id);
          try {
            report("Validating PDF");
            const uploadBytes = readFileSync(spool);
            if (uploadBytes.length !== bytes.length)
              throw new Error("PDF upload length changed before processing");
            const pinDuplicate = (duplicateId: string) => {
              if (duplicateId === docId) return;
              if (docMutations.isBusy(duplicateId) || docMutations.isDeleting(duplicateId))
                throw new Error("document busy");
              docMutations.pinWriter(duplicateId);
              const pins = pdfPinsByJob.get(j.id);
              if (!pins) {
                docMutations.unpinWriter(duplicateId);
                throw new Error("PDF upload lifecycle pin is missing");
              }
              pins.push(duplicateId);
            };
            const currentMatch = findMatchingPdfDoc(
              paths,
              workId,
              uploadBytes,
              (id) => id !== docId && (docMutations.isBusy(id) || docMutations.isDeleting(id))
            );
            if (currentMatch) {
              pinDuplicate(currentMatch.doc_id);
              return { status: "exists", doc: currentMatch };
            }
            const probe = await probePdf(uploadBytes);
            report("Publishing PDF Doc");
            const metadata = await libraryLock.run(() => {
              if (docMutations.isDeleting(docId)) throw new Error("document busy");
              const matching = findMatchingPdfDoc(
                paths,
                workId,
                uploadBytes,
                (id) => id !== docId && (docMutations.isBusy(id) || docMutations.isDeleting(id))
              );
              if (matching) {
                pinDuplicate(matching.doc_id);
                return matching;
              }
              return publishPdfDoc(paths, {
                docId,
                workId,
                filename,
                bytes: uploadBytes,
                pages: probe.pages,
              });
            });
            return { status: metadata.doc_id === docId ? "created" : "exists", doc: metadata };
          } finally {
            rmSync(spool, { force: true });
          }
        },
        { workId, docId, format: "pdf" }
      );
      pdfPinsByJob.set(job.id, [docId]);
    } catch (error) {
      docMutations.unpinWriter(docId);
      return {
        kind: "error",
        status: 500,
        detail: error instanceof Error ? error.message : "PDF upload could not be queued",
      };
    }
    void runner.waitFor(job.id).then((finished) => {
      if (
        finished.status === "done" &&
        (finished.result as { status?: unknown } | null)?.status === "created"
      ) {
        libraryChanged("upload");
      }
    });
    try {
      writeFileSync(runner.spoolPath(job.id), bytes);
    } catch (error) {
      // The durable job will fail on its missing spool and release the pin.
      return {
        kind: "error",
        status: 500,
        detail: error instanceof Error ? error.message : "PDF upload could not be stored",
      };
    }
    return { kind: "queued", job, resourceWarning: bytes.length >= PDF_RESOURCE_WARNING_BYTES };
  };

  /** Whether these bytes are a readable zip archive (the upload route's two-step gate). */
  const isReadableZip = (data: Uint8Array): boolean => {
    // Cheap gate first: every zip starts with a PK local-header/empty-archive magic.
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) return false;
    // …then prove it: a PK header alone says nothing about the rest. A valid zip with no LaTeX inside passes
    // here and fails later in the job (`findMainTex`), where the error reaches the detail panel.
    const probe = mkdtempSync(join(tmpdir(), "argelanderspace-upload-probe-"));
    try {
      extractZip(data, probe);
      return true;
    } catch (err) {
      if (!(err instanceof ZipError)) throw err; // fs trouble: not a 400
      return false;
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
  };
  type ZipQuery = { workId: string | null; doi: string | null; arxiv: string | null };
  const runAttachFor = (query: ZipQuery, zipPath: string, onProgress?: (message: string) => void) =>
    attachLatexZip(zipPath, query, {
      paths,
      pipelines: deps.pipelines,
      sources: deps.makeSources(false),
      rebuild: lockedRebuild,
      // The link runs inside the library lock with narrow writes (the ingest itself does not): nothing written
      // meanwhile (imports, edits, unknown keys) is overwritten.
      linkDoc: (_p, workId, docId, identity) => linkUploadDoc(workId, docId, identity),
      // N1: the main-doc re-assert must be mutually exclusive with PATCH.
      reassertMainDoc: (p, workId, docId) =>
        libraryLock.run(() => patchWorkNarrow(p, workId, { doc_id: docId }).status === "ok"),
      onProgress,
    });
  /** The zip upload's link step, inside the library lock: the same Work (identity unchanged), this Doc appended and main. */
  const linkUploadDoc = (
    workId: string,
    docId: string,
    identity: { doi: string | null; arxiv_id: string | null }
  ): Promise<boolean> =>
    libraryLock.run(() => {
      const work = LibraryStore.load(paths).get(workId);
      // The Work is the same one unless an identifier it HAD was changed; filling a blank (enrichment) is not a new identity.
      if (
        !work ||
        (identity.doi !== null && work.doi !== identity.doi) ||
        (identity.arxiv_id !== null && work.arxiv_id !== identity.arxiv_id)
      )
        return false;
      if (appendDocIdNarrow(paths, workId, docId) === "not_found") return false;
      patchWorkNarrow(paths, workId, { doc_id: docId }); // an upload reclaims the main slot
      return true;
    });
  /**
   * The zip upload's async submit: pin the Doc against DELETE, queue the durable job, spool the bytes.
   */
  const startZipJob = (
    query: ZipQuery,
    data: Uint8Array
  ): { kind: "queued"; job: Job } | { kind: "error"; status: number; detail: string } => {
    const targetWork = findWork(LibraryStore.load(paths), query);
    const uploadDoc = targetWork === undefined ? undefined : uploadDocId(targetWork.id);
    if (uploadDoc !== undefined && docMutations.isDeleting(uploadDoc))
      return { kind: "error", status: 409, detail: "document busy" };
    if (uploadDoc !== undefined) docMutations.pinWriter(uploadDoc);
    let job: Job;
    try {
      job = runner.submit(
        "upload",
        async (j, report) => {
          const zip = runner.spoolPath(j.id);
          try {
            const ref = await runAttachFor(query, zip, report);
            return { ref, docId: uploadDocId(ref.id) };
          } finally {
            rmSync(zip, { force: true });
          }
        },
        query
      );
    } catch (err) {
      // No job exists → no terminal hook will ever fire; release directly.
      if (uploadDoc !== undefined) docMutations.unpinWriter(uploadDoc);
      throw err;
    }
    // `library.changed` must follow `job.done` on the wire; the pin releases with the terminal state. The hook
    // is registered BEFORE the spool write: if that write throws, the queued job still fails on its missing spool
    // file and the hook releases the pin.
    void runner.waitFor(job.id).then((j) => {
      if (uploadDoc !== undefined) docMutations.unpinWriter(uploadDoc);
      if (j.status === "done" && (j.result as { status?: unknown } | null)?.status !== "skipped")
        libraryChanged("upload");
    });
    writeFileSync(runner.spoolPath(job.id), data);
    return { kind: "queued", job };
  };

  // The one import seam of the Library: the route below and the Copilot `library` tool both come here.
  // Automatic PDF is limited to the existing identifier/bibcode modes; bulk BibTeX never auto-queues.
  // Submission failure cannot undo the Work.
  const importManualWorks = async (
    req: ManualWorkRequest,
    options: { bridge?: "merge" | "reject" } = {}
  ): Promise<ManualImportResult> => {
    const outcome = await runManualImport(
      { paths, libraryLock, makeSources: () => deps.makeSources(false) },
      req,
      options
    );
    if (req.mode !== "bib" && autoIngestArxiv()) {
      for (const r of outcome.results) {
        if ((r.status === "created" || r.status === "exists") && r.ref !== undefined) {
          try {
            submitArxivPdf(r.ref.id, true);
          } catch (e) {
            console.error(`auto arXiv ingest submit failed for ${r.ref.id}:`, e);
          }
        }
      }
    }
    // A created Work or an updated existing one changes the file the page lists: one notification, like the page's reload.
    if (outcome.changed) libraryChanged("add");
    return outcome;
  };

  // Manual work creation (import menu). Per-entry outcomes ride in the 200
  // body (`results[].status`: created | exists | error); HTTP errors are
  // reserved for a malformed request / server failure. The whole batch runs
  // under libraryLock (single-user; the network seconds are the same trade
  // lockedRebuild makes). No full rebuild: in-place upsert + incremental
  // graph, then one libraryChanged broadcast.
  app.post("/api/library/works", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ManualWorkRequestSchema.safeParse(body);
    if (!parsed.success) {
      const e = detail("invalid request body (expected {mode: identifier|bibcode|bib, …})", 400);
      return c.json(e.body, e.status);
    }
    const { results } = await importManualWorks(parsed.data);
    return c.json({ results });
  });

  // ---- PATCH /api/library/refs --------------------------------------------- //

  app.patch("/api/library/refs", async (c) => {
    // work ids contain slashes/colons (e.g. "doi:10.1051/..."), so the id
    // rides in the body rather than the path.
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const body: unknown = await c.req.json().catch(() => null);
    const rec =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const workId = rec.id;
    if (typeof workId !== "string" || !workId) {
      const e = detail("id required", 400);
      return c.json(e.body, e.status);
    }
    const patch = Object.fromEntries(Object.entries(rec).filter(([k]) => k !== "id"));
    // Same narrow, field-preserving seam as the Copilot tool; this route sends no expectation.
    const ok = (await commitWorkPatch(libraryOps, workId, patch)).status === "ok";
    if (!ok) {
      const e = detail(`work ${pyRepr(workId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    return c.json({ ok: true });
  });

  // ---- POST /api/library/refresh?offline= ------------------------------------ //

  app.post("/api/library/refresh", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const offline = parseBoolQuery(c.req.query("offline"));
    if (offline === null) {
      const e = detail("invalid boolean value for query param 'offline'", 422);
      return c.json(e.body, e.status);
    }
    // The response shape is unchanged (the request still waits for the
    // summary), but the rebuild runs as a serial job: mutual exclusion with
    // upload OCR and progress over WS. Stage 8 §8: the pin makes DELETE
    // refuse to interleave (a rebuild re-derives every work's doc_ids — see
    // doc-mutations.ts). The pin is taken INSIDE the try: a throwing
    // `runner.submit` must not leak it (finally unpins either way).
    try {
      docMutations.pinRefresh();
      const job = runner.submit(
        "refresh",
        () => lockedRebuild(paths, { sources: deps.makeSources(offline) }),
        { offline }
      );
      const done = await runner.waitFor(job.id);
      if (done.status !== "done") {
        const e = detail(done.error ?? "refresh failed", 500);
        return c.json(e.body, e.status);
      }
      libraryChanged("refresh");
      return c.json(done.result as Record<string, unknown>);
    } finally {
      docMutations.unpinRefresh();
    }
  });

  // ---- POST /api/library/upload-pdf?id=<existing-work-id> -------------------- //

  // Raw PDF upload is a distinct path: the selected Work identity is never
  // inferred from filename or document metadata, and PDF bytes are immutable.
  app.post("/api/library/upload-pdf", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const workId = c.req.query("id");
    if (!workId) {
      const e = detail("id query param required", 400);
      return c.json(e.body, e.status);
    }
    try {
      if (!LibraryStore.load(paths).get(workId)) {
        const e = detail(`work ${pyRepr(workId)} not found`, 404);
        return c.json(e.body, e.status);
      }
    } catch {
      const e = detail("library could not be read", 500);
      return c.json(e.body, e.status);
    }
    const declaredLength = Number(c.req.header("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > PDF_MAX_BYTES) {
      const e = detail(`PDF exceeds the ${PDF_MAX_BYTES} byte limit`, 413);
      return c.json(e.body, e.status);
    }
    const stream = c.req.raw.body;
    if (!stream) {
      const e = detail("PDF upload body is empty", 400);
      return c.json(e.body, e.status);
    }
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > PDF_MAX_BYTES) {
          await reader.cancel();
          const e = detail(`PDF exceeds the ${PDF_MAX_BYTES} byte limit`, 413);
          return c.json(e.body, e.status);
        }
        chunks.push(value);
      }
    } catch {
      const e = detail("PDF upload could not be read", 400);
      return c.json(e.body, e.status);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    if (bytes.length === 0) {
      const e = detail("PDF upload body is empty", 400);
      return c.json(e.body, e.status);
    }
    let filename = c.req.header("x-filename") ?? "document.pdf";
    try {
      filename = decodeURIComponent(filename);
    } catch {
      const e = detail("invalid PDF filename", 400);
      return c.json(e.body, e.status);
    }
    filename = filename.split(/[\\/]/).pop() ?? "document.pdf";
    filename = [...filename]
      .map((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f ? "_" : character;
      })
      .join("");
    if (!filename || filename.length > 255) {
      const e = detail("invalid PDF filename", 400);
      return c.json(e.body, e.status);
    }

    const started = startPdfUpload(workId, bytes, filename);
    if (started.kind === "error") {
      const e = detail(started.detail, started.status as ContentfulStatusCode);
      return c.json(e.body, e.status);
    }
    return c.json({ job: started.job, resourceWarning: Boolean(started.resourceWarning) }, 202);
  });

  // ---- POST /api/library/upload?id=|doi=|arxiv= ------------------------------ //

  // Attach-only: the target work must already exist (attachLatexZip fails the
  // job / 404s otherwise — the endpoint never creates works). The payload is a
  // LaTeX source zip; tarballs/bare .tex stay with the CLI local ingest.
  app.post("/api/library/upload", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = c.req.query("id");
    const doi = c.req.query("doi");
    const arxiv = c.req.query("arxiv");
    if (!(id || doi || arxiv)) {
      const e = detail("id, doi, or arxiv query param required", 400);
      return c.json(e.body, e.status);
    }
    const data = new Uint8Array(await c.req.arrayBuffer());
    if (!isReadableZip(data)) {
      const e = detail("request body is not a zip", 400);
      return c.json(e.body, e.status);
    }
    const query = { workId: id ?? null, doi: doi ?? null, arxiv: arxiv ?? null };

    const syncRaw = c.req.query("sync");
    const sync = parseBoolQuery(syncRaw);
    if (sync === null) {
      const e = detail("invalid boolean value for query param 'sync'", 422);
      return c.json(e.body, e.status);
    }
    if (sync) {
      // Legacy behavior (app.py verbatim): the response waits for the ingest. The DELETE lifecycle pin is held
      // around the attach call, and a delete in flight refuses to start.
      const targetWork = findWork(LibraryStore.load(paths), query);
      const uploadDoc = targetWork === undefined ? undefined : uploadDocId(targetWork.id);
      if (uploadDoc !== undefined && docMutations.isDeleting(uploadDoc)) {
        const e = detail("document busy", 409);
        return c.json(e.body, e.status);
      }
      const tmp = join(
        tmpdir(),
        `argelanderspace-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`
      );
      if (uploadDoc !== undefined) docMutations.pinWriter(uploadDoc);
      try {
        writeFileSync(tmp, data);
        const ref = await runAttachFor(query, tmp);
        return c.json({ ref });
      } catch (e) {
        // Python: ValueError/FileNotFoundError → 404, anything else → 500.
        const msg = e instanceof Error ? e.message : String(e);
        const err = msg.startsWith("no matching work in the library")
          ? detail(msg, 404)
          : detail(`ingest failed: ${msg}`, 500);
        return c.json(err.body, err.status);
      } finally {
        if (uploadDoc !== undefined) docMutations.unpinWriter(uploadDoc);
        rmSync(tmp, { force: true });
      }
    }

    // Async (new default): spool the bytes, queue the ingest job, answer 202.
    const started = startZipJob(query, data);
    if (started.kind === "error") {
      const e = detail(started.detail, started.status as ContentfulStatusCode);
      return c.json(e.body, e.status);
    }
    return c.json({ job: started.job }, 202);
  });

  // ---- POST /api/library/acquire-arxiv-pdf?id=<workId> ----------------------- //

  app.post("/api/library/acquire-arxiv-pdf", (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const workId = c.req.query("id");
    if (!workId) return c.json(detail("id query param required", 400).body, 400);
    // As before: a library that cannot be loaded is the framework's own 500, outside the try below.
    const work = LibraryStore.load(paths).get(workId);
    if (!work) return c.json(detail(`work ${pyRepr(workId)} not found`, 404).body, 404);
    if (!normArxiv(work.arxiv_id))
      return c.json(detail(`work ${pyRepr(workId)} has no arXiv id`, 400).body, 400);
    try {
      // The same start the Copilot `library` tool calls (acquire_arxiv_pdf).
      const started = startArxivPdfAcquisition(workId);
      if (started.kind !== "queued")
        return c.json(detail("could not queue arXiv PDF acquisition", 409).body, 409);
      return c.json({ job: started.job }, 202);
    } catch (error) {
      return c.json(
        detail(
          error instanceof Error ? error.message : "arXiv PDF acquisition could not be queued",
          500
        ).body,
        500
      );
    }
  });

  // ---- POST /api/library/attach-arxiv?id=<workId> (Stage 15 LaTeX) ---------- //

  // Fetch the work's own arXiv e-print (the LATEST version, always fresh) and
  // attach it — or refresh the existing arXiv doc in place (D16 scenario
  // table). The manual entry point shares the auto trigger's queueing/attach
  // implementation (submitArxivFetch above); it is NOT gated by the hidden
  // auto_ingest_arxiv config (D15: an explicit user action).
  app.post("/api/library/attach-arxiv", (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const id = c.req.query("id");
    if (!id) {
      const e = detail("id query param required", 400);
      return c.json(e.body, e.status);
    }
    // The same start the Copilot `library` tool calls (attach_arxiv); every ordinary rejection is
    // decided there, null from the submit itself means a TOCTOU skip.
    const started = startArxivSource(id);
    if (started.kind === "not_found") {
      const e = detail(`work ${pyRepr(id)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if (started.kind === "no_arxiv") {
      const e = detail(`work ${pyRepr(id)} has no arXiv id`, 400);
      return c.json(e.body, e.status);
    }
    if (started.kind === "skip") {
      const e = detail(
        `work ${pyRepr(id)} already has a non-arXiv doc; delete it first if you want the arXiv version`,
        409
      );
      return c.json(e.body, e.status);
    }
    if (started.kind === "busy") {
      const e = detail("document busy", 409);
      return c.json(e.body, e.status);
    }
    if (started.kind !== "queued") {
      const e = detail("could not queue the arXiv fetch (work state changed)", 409);
      return c.json(e.body, e.status);
    }
    // A duplicate trigger answers 202 with the in-flight job (no stacking).
    return c.json({ job: started.job }, 202);
  });

  // Opt-in image reads share the manifest's concrete precheck and return ONLY
  // the buffer whose digest was compared. Entire read/check/send is synchronous.
  function verifiedImage(c: Context, docId: string, imgPath: string, expected: string) {
    c.header("Cache-Control", "no-store");
    if (!docId.trim() || badId(docId) || docId.includes("\0")) {
      return c.json({ detail: "bad doc id" }, 400);
    }
    if (!/^[0-9a-fA-F]{64}$/.test(expected)) {
      return c.json({ detail: "bad asset sha256" }, 400);
    }
    if (docMutations.isDocumentContentBusy(docId)) {
      return c.json({ detail: "document busy" }, 409);
    }
    try {
      const asset = readDocumentAsset(join(outputDir, docId), imgPath);
      if (asset.sha256 !== expected.toLowerCase()) {
        return c.json({ detail: "asset changed" }, 409);
      }
      return c.body(new Uint8Array(asset.bytes), 200, {
        "Content-Type": mimeFor(imgPath),
        ...IMAGE_HARDENING,
      });
    } catch (err) {
      if (err instanceof DocumentAssetError) {
        const status = err.code === "invalid" ? 400 : err.code === "missing" ? 404 : 500;
        return c.json({ detail: err.code === "missing" ? "image not found" : err.message }, status);
      }
      throw err;
    }
  }

  // ---- GET /images/{doc_id}/{filename} --------------------------------------- //

  app.get("/images/:doc_id/:filename", async (c) => {
    const docId = c.req.param("doc_id");
    const filename = c.req.param("filename");
    const expected = c.req.query("sha256");
    if (expected !== undefined) return verifiedImage(c, docId, filename, expected);
    if (badId(filename)) {
      const e = detail("bad filename", 400);
      return c.json(e.body, e.status);
    }
    if (badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    // LaTeX docs keep images under assets/. (The MinerU `mineru/images/`
    // branch left with the PDF pipeline — re-ingest old PDF docs to restore
    // their images.)
    const img = join(outputDir, docId, "assets", filename);
    if (existsSync(img) && statSync(img).isFile()) {
      return c.body(new Uint8Array(await readFile(img)), 200, {
        "Content-Type": mimeFor(filename),
        ...IMAGE_HARDENING,
      });
    }
    const e = detail("image not found", 404);
    return c.json(e.body, e.status);
  });

  // ---- GET /images/{doc_id}/{...subpath} ------------------------------------- //

  // img_path verbatim (Stage 3 / MS2a): values carry their subdirectory —
  // "assets/foo.jpg", doc-dir relative.
  app.get("/images/:doc_id/:filepath{.+}", async (c) => {
    const docId = c.req.param("doc_id");
    const rel = c.req.param("filepath");
    const expected = c.req.query("sha256");
    if (expected !== undefined) return verifiedImage(c, docId, rel, expected);
    if (badImagePath(rel)) {
      const e = detail("bad filename", 400);
      return c.json(e.body, e.status);
    }
    if (badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    const img = join(outputDir, docId, rel);
    if (existsSync(img) && statSync(img).isFile()) {
      return c.body(new Uint8Array(await readFile(img)), 200, {
        "Content-Type": mimeFor(rel),
        ...IMAGE_HARDENING,
      });
    }
    const e = detail("image not found", 404);
    return c.json(e.body, e.status);
  });

  // ---- SPA static hosting (last, so it never shadows the API) ---------------- //

  const webDist = deps.webDist && existsSync(deps.webDist) ? resolve(deps.webDist) : null;
  if (webDist !== null) {
    app.get("*", async (c) => {
      // Unknown API paths must 404 as JSON, not fall into the SPA.
      if (c.req.path.startsWith("/api/") || c.req.path.startsWith("/images/")) {
        const e = detail("Not Found", 404);
        return c.json(e.body, e.status);
      }
      const root = webDist;
      let rel: string;
      try {
        rel = normalize(decodeURIComponent(c.req.path)).replace(/^[/\\]+/, "");
      } catch {
        rel = ""; // malformed percent-encoding → SPA fallback
      }
      const candidate = resolve(join(root, rel));
      if (
        candidate.startsWith(root + sep) &&
        existsSync(candidate) &&
        statSync(candidate).isFile()
      ) {
        return c.body(new Uint8Array(await readFile(candidate)), 200, {
          "Content-Type": mimeFor(candidate),
          "Cache-Control": cacheControlFor(candidate, root),
        });
      }
      const index = join(root, "index.html");
      if (existsSync(index)) {
        return c.body(new Uint8Array(await readFile(index)), 200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-cache",
        });
      }
      const e = detail("Not Found", 404);
      return c.json(e.body, e.status);
    });
  }

  app.notFound((c) => {
    const e = detail("Not Found", 404);
    return c.json(e.body, e.status);
  });

  return app;
}
