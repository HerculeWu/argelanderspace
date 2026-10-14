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
 * - The CSRF allowlist is the Vite dev origin plus the port the server is
 *   actually bound to (`localhost`/`127.0.0.1`), looked up per request, so
 *   same-origin SPA POSTs work on any port, an ephemeral one included.
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
 *   `annotation.changed` broadcast, a dedicated annotationLock; the access
 *   path itself is annotations-access.ts) and
 *   `DELETE /api/paper/:doc_id` (global physical delete + all-works doc_ids
 *   removal). The DocMutationRegistry (doc-mutations.ts) is the §8 lifecycle
 *   lock between document deletes and doc-writing jobs; upload/refresh pin
 *   their targets, DELETE busy-checks (409, never waits).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import type {
  DocDescription,
  PdfSourceMaterial,
  WsServerMessage,
} from "@argelanderspace/contracts";
import {
  AnnotationsFileSchema,
  ARGUMENT_GRAPH_UNREADABLE_PREFIX,
  ArgumentGraphSchema,
  buildReaderReading,
  DocDescriptionSchema,
  ManualWorkRequestSchema,
  ManuscriptSchema,
  PDF_IMAGE_LONG_EDGE,
  PDF_MAX_BYTES,
  PdfAnnotationsFileSchema,
  PdfPagesResponseSchema,
  PdfReadingPositionSchema,
  PlansFileSchema,
  TexDocIrSchema,
} from "@argelanderspace/contracts";
import {
  type AdsDiscoverySource,
  AnnotationsError,
  ArgumentGraphFileError,
  buildWriterExport,
  DocumentAssetError,
  discoverLiterature,
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
  readDocumentAsset,
  readManuscriptAsset,
  readPdfAnnotationsFile,
  readPdfMetadataIfPresent,
  readPdfReadingPosition,
  readVerifiedPdf,
  savePdfAnnotationsFile,
  savePdfReadingPosition,
  type WriterExportBundle,
  WriterExportError,
  workToRef,
  writeManuscriptAsset,
} from "@argelanderspace/core";
import {
  AdsDiscoveryError,
  type CredentialStore,
  configFilePath,
  createAdsCredentialStore,
  ensureWriterSandboxProbe,
  type FetchImpl,
  pinnedGlobalDirs,
  readConfigLeniently,
  resolveGlobalDirsLeniently,
  type TexCompileFailure,
  writerSandboxAvailable,
  zipEntries,
} from "@argelanderspace/infra";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createAcquisition,
  createLockedRebuild,
  ImportAfterMergeError,
  isReadableZip,
} from "./acquisition.js";
import { mountAdsCredentialRoutes } from "./ads-credential.js";
import {
  type AnnotationsCommit,
  type AnnotationsRead,
  createAnnotationAccess,
  DocMetadataError,
} from "./annotations-access.js";
import { readArgumentGraph, writeArgumentGraph } from "./argument-graph-actions.js";
import { logWriterCompileFailure } from "./compile-failure-log.js";
import { CopilotHost } from "./copilot.js";
import { ArgumentUndoRegistry } from "./copilot-argument-tool.js";
import { type AnnotationWrite, planAnnotationWrite } from "./copilot-reader-annotations.js";
import type {
  AssetImageOutcome,
  PdfImageOutcome,
  PdfReadOutcome,
  ReaderOpDeps,
  ReaderReadOutcome,
  ReaderWriteOutcome,
} from "./copilot-reader-tool.js";
import { mountCopilotRoutes } from "./copilot-routes.js";
import { createDocDeletion } from "./doc-delete.js";
import { badDocId, badFileName } from "./doc-id.js";
import { DocMutationRegistry } from "./doc-mutations.js";
import type { JobRunner } from "./jobs.js";
import { commitWorkPatch, type LibraryOpDeps } from "./library-actions.js";
import { AsyncLock } from "./lock.js";
import { logRequests, type ServerLog, silentLog } from "./log.js";
import { externalObserver, jobLogger, observedCredentials } from "./log-observers.js";
import type { MailAccountService } from "./mail-accounts.js";
import type { MailComposeServices } from "./mail-compose-routes.js";
import type { MailManageService } from "./mail-manage.js";
import type { MailReadService } from "./mail-read.js";
import { mountMailRoutes } from "./mail-routes.js";
import type { MailWatcher } from "./mail-watch.js";
import { mountMailWatchRoutes } from "./mail-watch-routes.js";
import { DEV_ORIGINS, ownOrigins } from "./origins.js";
import { mountPageErrorRoute, type PageErrorOptions } from "./page-errors.js";
import { PaperCache } from "./paper-cache.js";
import { createPdfAccess } from "./pdf-access.js";
import {
  readPdfTextMaterial,
  readPdfTextMaterialCached,
  renderPdfPageImage,
  renderPdfRegionImage,
} from "./pdf-material.js";
import { isLinkableDoc, readPlans, replacePlans } from "./plans-actions.js";
import { mountProviderRoutes } from "./provider-routes.js";
import { ProviderSettings } from "./providers.js";
import { mountSettingsRoutes, readSettings, shownPath, withAppearance } from "./settings.js";
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
  /** May be asynchronous: the real one reads the ADS token from the credential store at each composition. */
  makeSources: (offline: boolean) => MetadataSources | Promise<MetadataSources>;
  /**
   * Stage 14 discovery source factory (the ADS discovery client). Optional:
   * when absent the discovery route answers 503 — production wires it in
   * server.ts; tests inject stubs.
   */
  makeDiscoverySource?: () => AdsDiscoverySource | Promise<AdsDiscoverySource>;
  /** The ingest pipelines (the upload endpoint consumes `ingestLatexZip`). */
  pipelines: IngestPipelines;
  /** The rate window of the page-error reports (page-errors.ts); a test shortens it. Default a minute. */
  pageErrors?: PageErrorOptions | undefined;
  /** The pipelines for one job (acquisition.ts `pipelinesForJob`); absent → `pipelines`. */
  pipelinesForJob?: ((jobId: string) => IngestPipelines) | undefined;
  /** External current arXiv PDF bytes; isolated tests replace only this network boundary. */
  fetchArxivPdf?: (arxivId: string) => Promise<Buffer>;
  /**
   * Stage 15 toggle (D15; on the settings page since desktop-app ticket 11): gate for the AUTOMATIC arXiv fetch on work
   * creation — the default reads `auto_ingest_arxiv` from config.toml fresh
   * at every submit (`false` disables auto only; manual triggers stay on).
   * The reading is the lenient one (desktop-app ticket 10): a config file that
   * was broken while the server runs leaves the default (on) and fails no
   * request.
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
  /**
   * The port the server is bound to — same-origin SPA POSTs carry it in `Origin`. A function because an ephemeral
   * port (`0`) is only known once the server listens; undefined (no server, or not listening) allows the dev
   * origins only.
   */
  boundPort?: () => number | undefined;
  /** Isolated settings storage/runtime in tests; production is initialized on first provider request. */
  providerSettings?: ProviderSettings;
  /** Mail accounts (global data); tests inject isolated stores, production builds it on first request. */
  mailAccounts?: MailAccountService;
  /** Mail reading (ticket 05); production builds it over the real global directories on first use. */
  mailRead?: MailReadService;
  /** Mail management and server-side search (ticket 06); production builds it on first use. */
  mailManage?: MailManageService;
  /** Live INBOX watcher (ticket 08); `startServer` wires it, tests inject or omit it. */
  mailWatch?: MailWatcher;
  /** Writing and sending mail (ticket 07); production builds it over the real global directories on first use. */
  mailCompose?: MailComposeServices;
  copilot?: CopilotHost;
  /** Test seam of the text Doc generator (runs between building a candidate and publishing it). */
  textDocHooks?: Pick<TextDocDeps, "beforePublish">;
  /** Longest the Copilot `library` tool waits for an acquisition job before answering `pending` (default ten minutes). */
  acquisitionWaitMs?: number;
  /** The user-level log (see log.ts). Absent → nothing is recorded; only `serve` hands one in. */
  log?: ServerLog;
  /** The config file the settings endpoints read and change (settings.ts); default `configFilePath()`. */
  configPath?: string | undefined;
  /**
   * The ADS token's credential store (desktop-app ticket 12), the one the sources read the token from: `createServer`
   * hands in the same store to both. Default: the `ads` purpose over the OS keychain, wrapped for the log.
   */
  adsCredentials?: CredentialStore | undefined;
  /** The HTTP implementation of the ADS token test (ads-credential.ts); default the global fetch. */
  adsTestFetch?: FetchImpl | undefined;
  /** Where `serve` keeps the process's data, fixed at its start (settings.ts `startupLocations`); default null. */
  startup?: import("@argelanderspace/contracts").StartupLocations | null;
  /**
   * The values config.toml gave when this process started (`serve`'s reading); a restart-only key changed since is
   * reported as pending a restart. Default: the reading when the app is made.
   */
  settingsAtStart?: import("@argelanderspace/contracts").SettingsValues;
  /** The restart-only keys `serve` was given on its command line (`--port`, `--data-dir`); default none. */
  settingsFromFlags?: readonly import("@argelanderspace/contracts").RunningFlagKey[];
}

// --------------------------------------------------------------------------- //
// Small parity helpers
// --------------------------------------------------------------------------- //

/** FastAPI's `HTTPException(status, msg)` body. */
function detail(msg: string, status: ContentfulStatusCode) {
  return { body: { detail: msg }, status };
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
  const log = deps.log ?? silentLog;
  // What the Writer's compile reports of the programs it runs (undefined without a log), and the record of job
  // transitions for a runner that was built without one (createServer builds its runner with it).
  const observer = externalObserver(log);
  runner.observe ??= jobLogger(log);
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
  /** Argument-graph writes: own lock too (ADR 0009; mirrors planLock). */
  const argumentGraphLock = new AsyncLock();
  /** Writer manuscript writes: own lock (Stage 10; mirrors planLock). */
  const writerLock = new AsyncLock();
  /** The §8 delete↔job lifecycle lock (see doc-mutations.ts). */
  const docMutations = deps.docMutations ?? new DocMutationRegistry();
  const broadcast = deps.broadcast ?? (() => {});
  // Job transitions flow to the same bus as library.changed (createServer's
  // hub is just another broadcast consumer). The app's ONE hook: the PDF upload's pin release first
  // (acquisition.ts), then the bus, then the Copilot.
  runner.onEvent = (type, job) => {
    acquisition.onJobEvent(type, job);
    broadcast({ type, job });
    // A Copilot operation that was left pending on this job shows its end.
    if (type === "job.done" || type === "job.failed") copilot.jobSettled(job.id);
  };
  const libraryChanged = (cause: "refresh" | "patch" | "add" | "upload" | "ingest"): void => {
    broadcast({ type: "library.changed", cause, at: new Date().toISOString() });
    // A pending Doc-replacement confirmation may no longer match what it showed (click time stays the authority).
    void copilot.revalidate("doc").catch(() => {});
  };
  const planChanged = (cause: "put" | "external"): void => {
    broadcast({ type: "plan.changed", cause, at: new Date().toISOString() });
  };
  const argumentGraphChanged = (workId: string, cause: "put" | "external" = "put"): void => {
    broadcast({
      type: "argument-graph.changed",
      cause,
      work_id: workId,
      at: new Date().toISOString(),
    });
    // A pending Copilot replace/clear card may no longer match the graph it showed (click time stays the authority).
    void copilot.revalidate("argument").catch(() => {});
  };
  /** Stage 10: `id` names the manuscript; template-dir changes omit it. */
  const writerChanged = (cause: "put" | "create" | "delete" | "numbering", id: string): void => {
    broadcast({ type: "writer.changed", cause, id, at: new Date().toISOString() });
    // A pending Copilot manuscript delete may no longer match its card (click time stays the authority).
    void copilot.revalidate("writer").catch(() => {});
  };
  const writerDataDir = paths.dataDir;
  // The Copilot `writer` tool and these routes share one lock, rev check, save and writer.changed notification.
  // Find out (off the event loop) whether the OS sandbox for Writer compiles works; the gates read the cached answer.
  void ensureWriterSandboxProbe(observer);
  // A failed render keeps its complete latexmk log in the manuscript's build directory; this is its log record.
  const writerCompileFailed = (id: string, failure: TexCompileFailure): void =>
    logWriterCompileFailure(log, id, failure);
  const writerOps: WriterOpDeps = {
    dataDir: writerDataDir,
    writerLock,
    changed: writerChanged,
    cancelCompile: (id) => cancelNumberingCompile(id, writerDataDir),
    // The Render button's own compile, for the Copilot's render_manuscript (the refresh route calls the same function).
    render: (id) =>
      runWriterNumberingNow(writerDataDir, id, {
        broadcast,
        onCompileFailure: writerCompileFailed,
        ...(observer ? { observer } : {}),
      }),
    sandboxed: () => writerSandboxAvailable(observer),
    // The References tab's list: the saved works' cite keys, read fresh at each use.
    citeKeys: () => new Set(LibraryStore.load(paths).works.map((work) => workToRef(work).cite)),
  };
  const annotationChanged = (docId: string, cause: "put" | "invalidate"): void => {
    broadcast({ type: "annotation.changed", doc_id: docId, cause, at: new Date().toISOString() });
    void copilot.revalidate("doc").catch(() => {});
  };
  /**
   * The archive authority (see annotations-access.ts): GET/PUT annotations and the Copilot `reader` tool's annotation
   * reads and writes share this one instance, on the one annotationLock.
   */
  const annotationAccess = createAnnotationAccess({
    paths,
    lock: annotationLock,
    docMutations,
    onChanged: annotationChanged,
  });
  /**
   * The PDF access path (see pdf-access.ts): the PDF routes, the papers and description routes, the text Docs' PDF
   * region render, the Copilot `reader` tool's PDF read/image/write and the acquisition's arXiv description share this
   * one instance, on the one annotationLock and DocMutationRegistry.
   */
  const pdfAccess = createPdfAccess({
    paths,
    docMutations,
    lock: annotationLock,
    onChanged: annotationChanged,
  });
  // Mutations may come from the Vite dev server or from the page this server itself serves.
  const originAllowed = (origin: string): boolean => {
    if ((DEV_ORIGINS as readonly string[]).includes(origin)) return true;
    const port = deps.boundPort?.();
    return port !== undefined && ownOrigins(port).includes(origin);
  };

  const app = new Hono();
  // First, so that it sees every request: the record of failed requests (the answers themselves are not changed).
  logRequests(app, log);

  // Dev: the Vite dev server (localhost:5173) calls this API directly.
  // allowHeaders left empty → hono reflects the requested headers, matching
  // Starlette's `allow_headers=["*"]`.
  app.use(
    "*",
    cors({
      origin: [...DEV_ORIGINS],
      allowMethods: ["GET"],
    })
  );

  /** `_guard_csrf`: reject cross-site mutations; no-Origin local tools pass. */
  const guardCsrf = (
    origin: string | undefined
  ): { body: { detail: string }; status: 403 } | null =>
    origin !== undefined && !originAllowed(origin)
      ? { body: { detail: "cross-site request rejected" }, status: 403 }
      : null;

  // What the page reports of its own errors (page-errors.ts): checked field by field, limited in number.
  mountPageErrorRoute(app, log, guardCsrf, { ...deps.pageErrors, webDist: deps.webDist });

  // Settings (settings.ts): the page reads them and changes one key of config.toml at a time; a change that rewrote
  // the file is told to every page at once (the file watcher of `createServer` finds it too, a moment later).
  // What the process actually uses for the restart-only keys: its own data directory, the port it listens on, and the
  // global directories pinned for its life (or, for an app made without a server, as the file gives them now).
  const settingsAtStart = deps.settingsAtStart ?? readSettings(deps.configPath).values;
  const projectRoot = process.cwd();
  mountSettingsRoutes(app, guardCsrf, {
    startup: deps.startup ?? null,
    path: deps.configPath,
    atStart: settingsAtStart,
    running: () => {
      const dirs =
        pinnedGlobalDirs() ??
        resolveGlobalDirsLeniently(readConfigLeniently(deps.configPath ?? configFilePath())).dirs;
      return {
        project_root: shownPath(projectRoot),
        port: deps.boundPort?.() ?? null,
        data_dir: shownPath(deps.paths.dataDir),
        global_dir: shownPath(dirs.dataDir),
        global_cache_dir: shownPath(dirs.cacheDir),
        from_flag: [...(deps.settingsFromFlags ?? [])],
      };
    },
    written: () =>
      broadcast({ type: "settings.changed", cause: "write", at: new Date().toISOString() }),
  });

  // The ADS token (ads-credential.ts): kept in the credential store, never in config.toml; no answer carries it.
  mountAdsCredentialRoutes(app, guardCsrf, {
    store: deps.adsCredentials ?? observedCredentials(createAdsCredentialStore(), log),
    fetchImpl: deps.adsTestFetch,
  });

  const providerSettings = deps.providerSettings ?? new ProviderSettings();
  mountProviderRoutes(app, providerSettings, guardCsrf);
  mountMailWatchRoutes(app, deps.mailWatch);
  const mailOps = mountMailRoutes(
    app,
    deps.mailAccounts,
    guardCsrf,
    deps.mailRead,
    deps.mailManage,
    deps.mailCompose,
    log
  );
  const copilot = deps.copilot ?? new CopilotHost(paths.dataDir, providerSettings, broadcast);
  // A host built here records where this app records; one handed in was given its log by whoever built it.
  if (deps.copilot === undefined) copilot.useLog(log);
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
        void copilot.revalidate("doc").catch(() => {});
    },
    libraryChanged: () => libraryChanged("add"),
    // The source panel's "add image from the source PDF" and the tool's add_pdf_image: the same verified, queued read.
    renderPdfRegion: async (request): Promise<PdfRegionOutcome> => {
      const source = pdfAccess.source(request.pdfDocId, { expectedHash: request.expectedHash });
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
        const failure = pdfAccess.materialFailure(error);
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
  /**
   * The Doc global delete (see doc-delete.ts): DELETE /api/paper/:doc_id and the Copilot `library` tool's
   * delete_doc share this one instance, on the app's libraryLock, annotationLock and DocMutationRegistry.
   */
  const docDeletion = createDocDeletion({
    paths,
    outputDir,
    libraryLock,
    annotationLock,
    docMutations,
    text: textDocs,
    onDeleted: () => libraryChanged("patch"),
  });
  /**
   * Library acquisition, upload and manual import (see acquisition.ts): the upload/refresh/import/arXiv routes and the
   * Copilot `library` tool (`acquisition`, `importWorks`) share this one instance, on the app's runner, libraryLock,
   * annotationLock and DocMutationRegistry.
   */
  const acquisition = createAcquisition({
    paths,
    runner,
    libraryLock,
    annotationLock,
    docMutations,
    libraryChanged,
    // not a PUT: a Work merge moved the file; a pending Copilot card on either Work is rechecked like after a PUT
    argumentGraphChanged: (workId) => argumentGraphChanged(workId, "external"),
    lockedRebuild: createLockedRebuild(libraryLock, log),
    pipelines: deps.pipelines,
    pipelinesForJob: deps.pipelinesForJob,
    makeSources: deps.makeSources,
    fetchArxivPdf: deps.fetchArxivPdf,
    /** Hidden config gate: re-read config.toml before automatic PDF submission. */
    autoIngestArxiv:
      deps.autoIngestArxiv ??
      (() => readSettings(deps.configPath).values.auto_ingest_arxiv !== false),
    pdfOwners: pdfAccess.owners,
    acquisitionWaitMs: deps.acquisitionWaitMs,
    log,
  });
  // The Copilot `library` tool shares the library lock, the narrow work patch and library.changed with
  // PATCH /api/library/refs, and reads the same payload as GET /api/library.
  const libraryOps: LibraryOpDeps = {
    paths,
    libraryLock,
    onChanged: () => libraryChanged("patch"),
    importWorks: (req, options) => acquisition.importManualWorks(req, options),
    readPayload: async () => libraryPayload(paths, await currentGraph()),
    acquisition,
    deletion: docDeletion,
  };
  const readerOps: ReaderOpDeps = {
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
  copilot.useWorkbench({
    library: libraryOps,
    reader: readerOps,
    text: textDocs,
    writer: writerOps,
    mail: mailOps,
    // The argument graph tool (ticket 09): the page's PUT writes through the same store, lock, Work check and broadcast.
    argument: {
      dataDir: paths.dataDir,
      lock: argumentGraphLock,
      onChanged: argumentGraphChanged,
      work: (workId) => {
        try {
          const found = LibraryStore.load(paths).get(workId);
          return found
            ? { id: found.id, title: found.title, docIds: [...(found.doc_ids ?? [])] }
            : null;
        } catch {
          return "error";
        }
      },
      undo: new ArgumentUndoRegistry(),
    },
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
          if (metadata && pdfAccess.owners(name).length !== 1) continue;
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
    if (!docId.trim() || badDocId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    const owners = pdfAccess.owners(docId);
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
    if (!docId.trim() || badDocId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    if (docMutations.isDocumentContentBusy(docId)) return c.json({ detail: "document busy" }, 409);
    const owners = pdfAccess.owners(docId);
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
    if (!docId.trim() || badDocId(docId)) return c.json({ detail: "bad doc id" }, 400);
    if (docMutations.isDocumentContentBusy(docId)) return c.json({ detail: "document busy" }, 409);
    const owners = pdfAccess.owners(docId);
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
    if (!docId.trim() || badDocId(docId)) return c.json({ detail: "bad doc id" }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ detail: "invalid reading position JSON" }, 400);
    }
    const parsed = PdfReadingPositionSchema.safeParse(body);
    if (!parsed.success || parsed.data.doc_id !== docId)
      return c.json({ detail: "invalid reading position data" }, 400);
    const owners = pdfAccess.owners(docId);
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
    if (!docId.trim() || badDocId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    if (docMutations.isDocumentContentBusy(docId)) return c.json({ detail: "document busy" }, 409);
    const owners = pdfAccess.owners(docId);
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
    if (!docId.trim() || badDocId(docId)) {
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
    const owners = pdfAccess.owners(docId);
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
    const source = pdfAccess.source(docId, { ...(hash ? { expectedHash: hash } : {}) });
    if (source.kind !== "ok") {
      const e = pdfAccess.sourceFailure(docId, source.kind);
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
      const failure = pdfAccess.materialFailure(error);
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
    const source = pdfAccess.source(docId, { expectedHash: hash });
    if (source.kind !== "ok") {
      const e = pdfAccess.sourceFailure(docId, source.kind);
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
      const failure = pdfAccess.materialFailure(error);
      return c.json({ detail: failure.detail }, failure.status);
    }
  });

  app.get("/api/paper/:doc_id/pdf", (c) => {
    c.header("Cache-Control", "no-store");
    const docId = c.req.param("doc_id");
    if (!docId.trim() || badDocId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    if (docMutations.isDocumentContentBusy(docId)) return c.json({ detail: "document busy" }, 409);
    const owners = pdfAccess.owners(docId);
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
    if (!docId.trim() || badDocId(docId)) {
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
    if (!docId.trim() || badDocId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    let read: AnnotationsRead;
    try {
      read = await annotationAccess.read(docId);
    } catch (err) {
      if (err instanceof AnnotationsError) {
        const failure = annotationAccess.describeError(err);
        const e = detail(failure.detail, failure.status);
        return c.json(e.body, e.status);
      }
      throw err;
    }
    if (read.kind === "busy") return c.json({ detail: "document busy" }, 409);
    if (read.kind === "pdf")
      return c.json({ detail: "PDF annotations use the PDF reader contract" }, 400);
    const result = read.epoch;
    return c.json(
      c.req.query("coherent") === "1"
        ? { version: 1 as const, ir: result.ir, file: result.file, assets: result.assets }
        : result.file
    );
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
    if (!docId.trim() || badDocId(docId)) {
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
      outcome = await annotationAccess.commit(
        docId,
        { fingerprint: parsed.data.content_fingerprint, rev: parsed.data.rev },
        () => ({ next: parsed.data })
      );
    } catch (err) {
      if (err instanceof AnnotationsError) {
        const failure = annotationAccess.describeError(err);
        const e = detail(failure.detail, failure.status);
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
  // The one global physical delete (see doc-delete.ts), shared with the Copilot `library` tool's `delete_doc`; this
  // route maps its outcome to 400/404/409/500 and never passes a holders binding.
  app.delete("/api/paper/:doc_id", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const docId = c.req.param("doc_id");
    const outcome = await docDeletion.delete(docId);
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
    const source = await deps.makeDiscoverySource?.();
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
      void copilot.revalidate("plans").catch(() => {});
    });
    if ("conflictRev" in outcome) {
      return c.json({ detail: "rev mismatch", rev: outcome.conflictRev }, 409);
    }
    return c.json(outcome.saved);
  });

  // ---- GET/PUT /api/works/:workId/argument-graph ---------------------------- //

  // The Work's argument graph (ADR 0009). `:workId` is the URL-encoded Work id
  // (it holds `:` and `/`). GET: unknown Work 404; a Work without a graph reads
  // as the empty graph at rev 0 (not 404). PUT: whole-graph replace with the
  // persisted rev lock (mismatch → 409 with the current rev, nothing written);
  // schema/structure failures 400 with the issue list. An unreadable graph file
  // (corrupt JSON, schema-invalid, future version) is a 500 and is never
  // overwritten. Writes serialize on argumentGraphLock.
  const knownWork = (workId: string): boolean | "error" => {
    try {
      return LibraryStore.load(paths).get(workId) !== undefined;
    } catch {
      return "error";
    }
  };
  // Fixed wording: the store's messages carry absolute data-dir paths, which
  // must not reach the client.
  const argumentGraphFailure = (err: unknown) => {
    if (err instanceof ArgumentGraphFileError) {
      if (err.kind === "unsafe_id")
        return detail("work id cannot be used for an argument graph", 400);
      return detail(`${ARGUMENT_GRAPH_UNREADABLE_PREFIX} (${err.kind})`, 500);
    }
    return detail("argument graph could not be accessed", 500);
  };

  app.get("/api/works/:workId/argument-graph", (c) => {
    c.header("Cache-Control", "no-store");
    const workId = c.req.param("workId");
    const known = knownWork(workId);
    if (known === "error") {
      const e = detail("library could not be read", 500);
      return c.json(e.body, e.status);
    }
    if (!known) {
      const e = detail(`work ${pyRepr(workId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    try {
      return c.json(readArgumentGraph(paths.dataDir, workId));
    } catch (err) {
      const e = argumentGraphFailure(err);
      return c.json(e.body, e.status);
    }
  });

  app.put("/api/works/:workId/argument-graph", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const workId = c.req.param("workId");
    const known = knownWork(workId);
    if (known === "error") {
      const e = detail("library could not be read", 500);
      return c.json(e.body, e.status);
    }
    if (!known) {
      const e = detail(`work ${pyRepr(workId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = ArgumentGraphSchema.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 20)
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      const e = detail(`request body is not a valid argument graph: ${issues}`, 400);
      return c.json(e.body, e.status);
    }
    if (parsed.data.work_id !== workId) {
      const e = detail("body work_id does not match the URL", 400);
      return c.json(e.body, e.status);
    }
    try {
      const outcome = await writeArgumentGraph(
        paths.dataDir,
        argumentGraphLock,
        parsed.data,
        () => argumentGraphChanged(workId),
        () => knownWork(workId) // again, inside the lock: a Work merge may have removed it while the body was read
      );
      if ("gone" in outcome) {
        const e = detail(`work ${pyRepr(workId)} not found`, 404);
        return c.json(e.body, e.status);
      }
      if ("libraryUnreadable" in outcome) {
        const e = detail("library could not be read", 500);
        return c.json(e.body, e.status);
      }
      if ("conflictRev" in outcome) {
        return c.json({ detail: "rev mismatch", rev: outcome.conflictRev }, 409);
      }
      return c.json(outcome.saved);
    } catch (err) {
      const e = argumentGraphFailure(err);
      return c.json(e.body, e.status);
    }
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
      return c.json(
        await runWriterNumberingNow(writerDataDir, id, {
          broadcast,
          onCompileFailure: writerCompileFailed,
          ...(observer ? { observer } : {}),
        })
      );
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
    void copilot.revalidate("writer").catch(() => {});
    return c.json({ name: outcome.name }, 201);
  });

  // ---- GET /api/writer/manuscripts/:id/assets/:name -------------------------- //

  app.get("/api/writer/manuscripts/:id/assets/:name", (c) => {
    const id = c.req.param("id");
    const name = c.req.param("name");
    c.header("Cache-Control", "no-cache");
    if (badManuscriptId(id) || badFileName(name)) {
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
    if (badManuscriptId(id) || badFileName(name) || name.includes("\\") || name.includes("\0"))
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
    let imported: Awaited<ReturnType<typeof acquisition.importManualWorks>>;
    try {
      imported = await acquisition.importManualWorks(parsed.data);
    } catch (error) {
      // The merge is saved but a later step failed: a fixed message and the notes (relative paths), no raw error.
      if (error instanceof ImportAfterMergeError)
        return c.json({ detail: error.message, argument_graph_merges: error.notes }, 500);
      throw error;
    }
    const { results, argumentGraphMerges = [] } = imported;
    // `argument_graph_merges` rides along only when a fold met an argument graph (ticket 06).
    return c.json(
      argumentGraphMerges.length > 0
        ? { results, argument_graph_merges: argumentGraphMerges }
        : { results }
    );
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
    // The response shape is unchanged (the request still waits for the summary); the serial refresh job and its
    // DELETE pin live in acquisition.ts. A throwing submit stays the framework's 500.
    const refreshed = await acquisition.refreshLibrary(offline);
    if (refreshed.kind === "failed") {
      const e = detail(refreshed.detail, 500);
      return c.json(e.body, e.status);
    }
    return c.json(refreshed.summary as unknown as Record<string, unknown>);
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

    const started = acquisition.startPdfUpload(workId, bytes, filename);
    if (started.kind === "busy") {
      const e = detail("document busy", 409);
      return c.json(e.body, e.status);
    }
    if (started.kind === "failed") {
      const e = detail(started.detail, 500);
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
      // Legacy behavior (app.py verbatim): the response waits for the ingest (acquisition.ts attachZipSync).
      const attached = await acquisition.attachZipSync(query, data);
      if (attached.kind === "busy") {
        const e = detail("document busy", 409);
        return c.json(e.body, e.status);
      }
      // Python: ValueError/FileNotFoundError → 404, anything else → 500.
      if (attached.kind === "no_work") {
        const e = detail(attached.message, 404);
        return c.json(e.body, e.status);
      }
      if (attached.kind === "failed") {
        const e = detail(`ingest failed: ${attached.message}`, 500);
        return c.json(
          attached.argument_graph_merges !== undefined
            ? { ...e.body, argument_graph_merges: attached.argument_graph_merges }
            : e.body,
          e.status
        );
      }
      return c.json(
        attached.argument_graph_merges.length > 0
          ? { ref: attached.ref, argument_graph_merges: attached.argument_graph_merges }
          : { ref: attached.ref }
      );
    }

    // Async (new default): spool the bytes, queue the ingest job, answer 202.
    const started = acquisition.startZipJob(query, data);
    if (started.kind === "busy") {
      const e = detail("document busy", 409);
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
      const started = acquisition.startPdf(workId);
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
  // implementation (acquisition.ts submitArxivFetch); it is NOT gated by the
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
    const started = acquisition.startSource(id);
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
    if (!docId.trim() || badDocId(docId) || docId.includes("\0")) {
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
    if (badFileName(filename)) {
      const e = detail("bad filename", 400);
      return c.json(e.body, e.status);
    }
    if (badDocId(docId)) {
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
    if (badDocId(docId)) {
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
      const index = join(root, "index.html");
      // The page itself carries the configured appearance, so its first paint has the right theme (settings.ts).
      const page = async () =>
        c.body(
          withAppearance(await readFile(index, "utf-8"), readSettings(deps.configPath).values),
          200,
          { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }
        );
      if (candidate === index && existsSync(index) && statSync(index).isFile()) return page();
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
      if (existsSync(index)) return page();
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
