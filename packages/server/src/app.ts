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

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import type {
  AnnotationsFile,
  Job,
  RefreshResponse,
  WsServerMessage,
} from "@argelanderspace/contracts";
import { AnnotationsFileSchema, PlansFileSchema } from "@argelanderspace/contracts";
import {
  AnnotationsError,
  addNodeToLibrary,
  annotationsDocDir,
  attachLatexZip,
  DocumentAssetError,
  ensureCurrentAnnotationsWithDocument,
  findWork,
  type IngestPipelines,
  type LibraryPaths,
  LibraryStore,
  libraryPayload,
  loadPlans,
  type MetadataSources,
  patchWork,
  readDocumentAsset,
  rebuild,
  removeDocFromWorks,
  saveAnnotationsFile,
  savePlans,
  uploadDocId,
} from "@argelanderspace/core";
import { extractZip, ZipError } from "@argelanderspace/infra";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { DocMutationRegistry } from "./doc-mutations.js";
import type { JobRunner } from "./jobs.js";
import { AsyncLock } from "./lock.js";
import { PaperCache } from "./paper-cache.js";

// --------------------------------------------------------------------------- //
// Deps
// --------------------------------------------------------------------------- //

export interface AppDeps {
  paths: LibraryPaths;
  /** The plan page's status dir (holds `plans.json`); `statusDirFor(dataDir)`. */
  statusDir: string;
  /** Sources factory: `offline` toggles remote enrichment (Crossref/OpenAlex). */
  makeSources: (offline: boolean) => MetadataSources;
  /** The ingest pipelines (the upload endpoint consumes `ingestLatexZip`). */
  pipelines: IngestPipelines;
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
  /** The §8 delete↔job lifecycle lock (see doc-mutations.ts). */
  const docMutations = deps.docMutations ?? new DocMutationRegistry();
  const broadcast = deps.broadcast ?? (() => {});
  // Job transitions flow to the same bus as library.changed (createServer's
  // hub is just another broadcast consumer).
  runner.onEvent = (type, job) => broadcast({ type, job });
  const libraryChanged = (cause: "refresh" | "patch" | "add" | "upload"): void => {
    broadcast({ type: "library.changed", cause, at: new Date().toISOString() });
  };
  const planChanged = (cause: "put" | "external"): void => {
    broadcast({ type: "plan.changed", cause, at: new Date().toISOString() });
  };
  const annotationChanged = (docId: string, cause: "put" | "invalidate"): void => {
    broadcast({ type: "annotation.changed", doc_id: docId, cause, at: new Date().toISOString() });
  };
  /** AnnotationsError → the route's response (roadmap §3: not_found → 404,
   *  every other store failure → 500, never a silent reset). */
  const annotationsError = (err: AnnotationsError) =>
    detail(err.message, err.code === "not_found" ? 404 : 500);
  /** rebuild through the lock. */
  const lockedRebuild = (
    p: LibraryPaths,
    opts: { sources: MetadataSources }
  ): Promise<RefreshResponse> => libraryLock.run(() => rebuild(p, opts));

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
        if (statSync(dir).isDirectory() && existsSync(join(dir, `${name}.json`))) {
          ids.push(name);
        }
      } catch {
        // unreadable entry: skip (Python `d.is_dir()` never raises)
      }
    }
    return c.json({ papers: ids });
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
    type PutOutcome =
      | { busy: true }
      | { documentChanged: AnnotationsFile }
      | { conflictRev: number }
      | { saved: AnnotationsFile };
    let outcome: PutOutcome;
    try {
      outcome = await annotationLock.run(() => {
        if (docMutations.isDocumentContentBusy(docId)) return { busy: true as const };
        const ensured = ensureCurrentAnnotationsWithDocument(paths.dataDir, docId);
        if (ensured.invalidated) annotationChanged(docId, "invalidate");
        const current = ensured.file;
        if (parsed.data.content_fingerprint !== current.content_fingerprint) {
          return { documentChanged: current };
        }
        if (parsed.data.rev !== current.rev) return { conflictRev: current.rev };
        saveAnnotationsFile(paths.dataDir, docId, parsed.data, { bumpRev: true });
        return { saved: { ...parsed.data, rev: parsed.data.rev + 1 } };
      });
    } catch (err) {
      if (err instanceof AnnotationsError) {
        const e = annotationsError(err);
        return c.json(e.body, e.status);
      }
      throw err;
    }
    if ("busy" in outcome) return c.json({ detail: "document busy" }, 409);
    if ("documentChanged" in outcome) {
      return c.json({ detail: "document changed", file: outcome.documentChanged }, 409);
    }
    if ("conflictRev" in outcome) {
      return c.json({ detail: "rev mismatch", rev: outcome.conflictRev }, 409);
    }
    annotationChanged(docId, "put");
    return c.json(outcome.saved);
  });

  // ---- DELETE /api/paper/{doc_id} -------------------------------------------- //

  // Stage 8 §8: GLOBAL physical delete — `output/<doc>/` + `annotations/<doc>/`
  // (current + archive; missing dirs tolerated), then the doc is removed from
  // EVERY work's `doc_ids` (one doc can appear in several works via identity
  // merge; core `removeDocFromWorks` is the all-works traversal). "Doc exists"
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
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    const docDir = join(outputDir, docId);
    if (!existsSync(docDir) || !statSync(docDir).isDirectory()) {
      const e = detail(`paper ${pyRepr(docId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    if (!docMutations.tryBeginDelete(docId)) {
      const e = detail("document busy", 409);
      return c.json(e.body, e.status);
    }
    try {
      await libraryLock.run(() => {
        rmSync(docDir, { recursive: true, force: true });
        rmSync(annotationsDocDir(paths.dataDir, docId), { recursive: true, force: true });
        removeDocFromWorks(paths, docId);
      });
    } catch (err) {
      const e = detail(`delete failed: ${(err as Error).message}`, 500);
      return c.json(e.body, e.status);
    } finally {
      docMutations.endDelete(docId);
    }
    libraryChanged("patch");
    return c.json({ ok: true });
  });

  // ---- GET /api/library ------------------------------------------------------ //

  app.get("/api/library", (c) => c.json(libraryPayload(paths)));

  // ---- GET /api/plans -------------------------------------------------------- //

  // The plan page's whole document (Stage 4): a missing plans.json reads as
  // the empty document (core loadPlans); a corrupt one surfaces as a 500 —
  // never a silent reset.
  app.get("/api/plans", (c) => c.json(loadPlans(deps.statusDir)));

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
    const outcome = await planLock.run(() => {
      const current = loadPlans(deps.statusDir);
      if (parsed.data.rev !== current.rev) return { conflictRev: current.rev } as const;
      savePlans(deps.statusDir, parsed.data, { bumpRev: true });
      return { saved: { ...parsed.data, rev: parsed.data.rev + 1 } } as const;
    });
    if ("conflictRev" in outcome) {
      return c.json({ detail: "rev mismatch", rev: outcome.conflictRev }, 409);
    }
    planChanged("put");
    return c.json(outcome.saved);
  });

  // ---- POST /api/library/refs ---------------------------------------------- //

  app.post("/api/library/refs", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status);
    const body: unknown = await c.req.json().catch(() => null);
    const nodeId =
      body !== null && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).nodeId
        : undefined;
    if (typeof nodeId !== "string" || !nodeId) {
      const e = detail("nodeId required", 400);
      return c.json(e.body, e.status);
    }
    const ref = await libraryLock.run(() => addNodeToLibrary(paths, nodeId));
    if (ref === null) {
      const e = detail(`graph node ${pyRepr(nodeId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    libraryChanged("add");
    return c.json({ ref });
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
    const ok = await libraryLock.run(() => patchWork(paths, workId, patch));
    if (!ok) {
      const e = detail(`work ${pyRepr(workId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    libraryChanged("patch");
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
    // Cheap gate first: every zip starts with a PK local-header/empty-archive
    // magic (the old `%PDF` check's counterpart).
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
      const e = detail("request body is not a zip", 400);
      return c.json(e.body, e.status);
    }
    // …then prove it: a PK header alone says nothing about the rest. A valid
    // zip with no LaTeX inside passes here and fails later in the job
    // (`findMainTex`), where the error reaches the detail panel.
    const probe = mkdtempSync(join(tmpdir(), "argelanderspace-upload-probe-"));
    try {
      extractZip(data, probe);
    } catch (err) {
      if (!(err instanceof ZipError)) throw err; // fs trouble: not a 400
      const e = detail("request body is not a zip", 400);
      return c.json(e.body, e.status);
    } finally {
      rmSync(probe, { recursive: true, force: true });
    }
    const query = { workId: id ?? null, doi: doi ?? null, arxiv: arxiv ?? null };
    const runAttach = (zipPath: string, onProgress?: (message: string) => void) =>
      attachLatexZip(zipPath, query, {
        paths,
        pipelines: deps.pipelines,
        sources: deps.makeSources(false),
        rebuild: lockedRebuild,
        // N1: the main-doc re-assert must be mutually exclusive with PATCH —
        // attach's own weld runs outside the lock and can be clobbered.
        reassertMainDoc: (p, workId, docId) =>
          libraryLock.run(() => patchWork(p, workId, { doc_id: docId })),
        onProgress,
      });

    const syncRaw = c.req.query("sync");
    const sync = parseBoolQuery(syncRaw);
    if (sync === null) {
      const e = detail("invalid boolean value for query param 'sync'", 422);
      return c.json(e.body, e.status);
    }
    // Stage 8 §8 lifecycle lock (doc-mutations.ts): pin the upload's doc for
    // the request's/job's whole lifetime so DELETE refuses to interleave, and
    // refuse to start while a DELETE of that doc is in flight (the reverse
    // direction). The doc id is computable NOW — uploadDocId is a pure
    // function of the resolved work id. An unresolvable work pins nothing:
    // the attach fails later exactly as before.
    const targetWork = findWork(LibraryStore.load(paths), query);
    const uploadDoc = targetWork === undefined ? undefined : uploadDocId(targetWork.id);
    if (uploadDoc !== undefined && docMutations.isDeleting(uploadDoc)) {
      const e = detail("document busy", 409);
      return c.json(e.body, e.status);
    }
    if (sync) {
      // Legacy behavior (app.py verbatim): the response waits for the ingest.
      const tmp = join(
        tmpdir(),
        `argelanderspace-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`
      );
      if (uploadDoc !== undefined) docMutations.pinWriter(uploadDoc);
      try {
        writeFileSync(tmp, data);
        const ref = await runAttach(tmp);
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
    // The runner's `report` rides attachLatexZip's onProgress straight through,
    // so every stage transition lands in job.progress (WS job.progress).
    // The §8 writer pin is held from submit until the job's terminal state, so
    // a queued job already busy-blocks DELETE (it may write the doc).
    if (uploadDoc !== undefined) docMutations.pinWriter(uploadDoc);
    let job: Job;
    try {
      job = runner.submit(
        "upload",
        async (j, report) => {
          const zip = runner.spoolPath(j.id);
          try {
            const ref = await runAttach(zip, report);
            return { ref };
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
    // `library.changed` must follow `job.done` on the wire (runner emits
    // done before resolving waiters); the writer pin releases with the
    // terminal state, whichever it is. The hook is registered BEFORE the
    // spool write on purpose: if that write throws, the request 500s but the
    // queued job still runs, fails on its missing spool file, and this hook
    // releases the pin — the failed job is the honest record of the 500, so
    // no explicit cancel/unpin here (which would also double-release).
    void runner.waitFor(job.id).then((j) => {
      if (uploadDoc !== undefined) docMutations.unpinWriter(uploadDoc);
      if (j.status === "done") libraryChanged("upload");
    });
    // Synchronous spool write: guaranteed to land before the serial chain
    // (a microtask) can start the handler.
    writeFileSync(runner.spoolPath(job.id), data);
    return c.json({ job }, 202);
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
      return c.body(new Uint8Array(asset.bytes), 200, { "Content-Type": mimeFor(imgPath) });
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
