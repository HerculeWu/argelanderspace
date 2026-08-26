/**
 * The Hono port of `server/app.py` (FastAPI): the 8 REST endpoints with paths
 * and response shapes preserved verbatim (decision 15), the image route, CORS
 * for the Vite dev origin, the Origin-check CSRF guard on mutations, the
 * mtime+size paper cache, and static SPA hosting with API precedence.
 *
 * Intentional divergences from app.py (all flagged in the M4 memory note):
 * - `POST /api/library/upload` is now async: `202 {"job": ...}` immediately;
 *   the PDF is spooled under `<dataDir>/jobs/spool/` and OCR runs as a serial
 *   job (WS `job.*` events carry the outcome). The old minutes-long
 *   synchronous wait stays available behind `?sync=1`.
 * - `POST /api/library/refresh` keeps its synchronous summary response, but
 *   the rebuild runs inside the serial job runner (mutual exclusion with
 *   upload ingest, decisions 13/16) — WS clients see it as a `refresh` job.
 * - The CSRF allowlist gains the server's own port (`localhost`/`127.0.0.1`)
 *   so same-origin SPA POSTs work on ports other than the hardcoded 8000.
 * - Malformed `?offline=` values answer `422 {"detail": string}` (FastAPI's
 *   validation body is a `detail` *array*; the string shape is kept uniform).
 * - The SPA fallback serves `index.html` for unknown non-API GET paths
 *   (Starlette's StaticFiles answered 404) — required for client-side routes.
 */

import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { RefreshResponse, WsServerMessage } from "@argelanderspace/contracts";
import {
  addNodeToLibrary,
  attachPdf,
  htmlAdapterInfos,
  type IngestPipelines,
  type LibraryPaths,
  libraryPayload,
  type MetadataSources,
  patchWork,
  rebuild,
} from "@argelanderspace/core";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JobRunner } from "./jobs.js";
import { AsyncLock } from "./lock.js";
import { PaperCache } from "./paper-cache.js";

// --------------------------------------------------------------------------- //
// Deps
// --------------------------------------------------------------------------- //

export interface AppDeps {
  paths: LibraryPaths;
  /** Sources factory: `offline` toggles remote enrichment (Crossref/OpenAlex). */
  makeSources: (offline: boolean) => MetadataSources;
  pipelines: IngestPipelines;
  runner: JobRunner;
  /** WS sink; when absent, events are simply dropped (tests without a hub). */
  broadcast?: (msg: WsServerMessage) => void;
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
  const broadcast = deps.broadcast ?? (() => {});
  // Job transitions flow to the same bus as library.changed (createServer's
  // hub is just another broadcast consumer).
  runner.onEvent = (type, job) => broadcast({ type, job });
  const libraryChanged = (cause: "refresh" | "patch" | "add" | "upload"): void => {
    broadcast({ type: "library.changed", cause, at: new Date().toISOString() });
  };
  /** rebuild through the lock + the planner's live HTML-adapter registry. */
  const lockedRebuild = (
    p: LibraryPaths,
    opts: { sources: MetadataSources }
  ): Promise<RefreshResponse> =>
    libraryLock.run(() => rebuild(p, { ...opts, htmlAdapters: htmlAdapterInfos() }));

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

  // ---- GET /api/paper/{doc_id} --------------------------------------------- //

  app.get("/api/paper/:doc_id", (c) => {
    const docId = c.req.param("doc_id");
    // `:doc_id` never matches an empty segment; trim() catches whitespace-only.
    if (!docId.trim() || badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    const p = join(outputDir, docId, `${docId}.json`);
    if (!existsSync(p) || !statSync(p).isFile()) {
      const e = detail(`paper ${pyRepr(docId)} not found`, 404);
      return c.json(e.body, e.status);
    }
    // bigint stats: `mtimeNs` only exists on the bigint view.
    const st = statSync(p, { bigint: true });
    const doc = paperCache.load(docId, p, { mtimeNs: st.mtimeNs, size: st.size });
    return c.json(doc as Record<string, unknown>);
  });

  // ---- GET /api/library ------------------------------------------------------ //

  app.get("/api/library", (c) => c.json(libraryPayload(paths)));

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
    // upload OCR and progress over WS.
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
  });

  // ---- POST /api/library/upload?id=|doi=|arxiv= ------------------------------ //

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
    const data = Buffer.from(await c.req.arrayBuffer());
    // Python `data[:5].startswith(b"%PDF")`: the first four bytes decide.
    if (data.length < 4 || data.subarray(0, 4).toString("latin1") !== "%PDF") {
      const e = detail("request body is not a PDF", 400);
      return c.json(e.body, e.status);
    }
    const query = { workId: id ?? null, doi: doi ?? null, arxiv: arxiv ?? null };
    const runOcr = (pdfPath: string) =>
      attachPdf(pdfPath, query, {
        paths,
        pipelines: deps.pipelines,
        sources: deps.makeSources(false),
        rebuild: lockedRebuild,
      });

    const syncRaw = c.req.query("sync");
    const sync = parseBoolQuery(syncRaw);
    if (sync === null) {
      const e = detail("invalid boolean value for query param 'sync'", 422);
      return c.json(e.body, e.status);
    }
    if (sync) {
      // Legacy behavior (app.py verbatim): the response waits for the OCR.
      const tmp = join(
        tmpdir(),
        `argelanderspace-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`
      );
      try {
        writeFileSync(tmp, data);
        const ref = await runOcr(tmp);
        return c.json({ ref });
      } catch (e) {
        // Python: ValueError/FileNotFoundError → 404, anything else → 500.
        const msg = e instanceof Error ? e.message : String(e);
        const err = msg.startsWith("no matching work in the library")
          ? detail(msg, 404)
          : detail(`ingest failed: ${msg}`, 500);
        return c.json(err.body, err.status);
      } finally {
        rmSync(tmp, { force: true });
      }
    }

    // Async (new default): spool the bytes, queue the OCR job, answer 202.
    const job = runner.submit(
      "upload",
      async (j, report) => {
        const pdf = runner.spoolPath(j.id);
        try {
          report("MinerU OCR");
          const ref = await runOcr(pdf);
          return { ref };
        } finally {
          rmSync(pdf, { force: true });
        }
      },
      query
    );
    // Synchronous spool write: guaranteed to land before the serial chain
    // (a microtask) can start the handler.
    writeFileSync(runner.spoolPath(job.id), data);
    // `library.changed` must follow `job.done` on the wire (runner emits
    // done before resolving waiters).
    void runner.waitFor(job.id).then((j) => {
      if (j.status === "done") libraryChanged("upload");
    });
    return c.json({ job }, 202);
  });

  // ---- GET /images/{doc_id}/{filename} --------------------------------------- //

  app.get("/images/:doc_id/:filename", async (c) => {
    const docId = c.req.param("doc_id");
    const filename = c.req.param("filename");
    if (badId(filename)) {
      const e = detail("bad filename", 400);
      return c.json(e.body, e.status);
    }
    if (badId(docId)) {
      const e = detail("bad doc id", 400);
      return c.json(e.body, e.status);
    }
    // PDF docs keep images under mineru/images/; HTML docs under assets/.
    for (const sub of ["mineru/images", "assets"]) {
      const img = join(outputDir, docId, sub, filename);
      if (existsSync(img) && statSync(img).isFile()) {
        return c.body(new Uint8Array(await readFile(img)), 200, {
          "Content-Type": mimeFor(filename),
        });
      }
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
        });
      }
      const index = join(root, "index.html");
      if (existsSync(index)) {
        return c.body(new Uint8Array(await readFile(index)), 200, {
          "Content-Type": "text/html; charset=utf-8",
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
