/**
 * Attach a user-supplied LaTeX source zip to a library work (Stage 3.1 MS2 —
 * the web-upload rebuild of the archived `attachPdf`, which lived here until
 * the PDF/OCR pipeline moved to the `ocr-features` branch).
 *
 * The escape hatch for papers whose source we can't fetch automatically: the
 * user zips the LaTeX project (e.g. the arXiv e-print or a publisher-supplied
 * source), the server spools it, and this module links the ingested doc to
 * the work. The archived attachPdf had two hazards this version welds shut
 * (roadmap Q9/Q10):
 *
 * 1. **Idempotent doc id** — `upload-<slug(work id, 44)>-<sha1(work id)[:6]>`:
 *    re-uploading the same work overwrites the same doc (the hash suffix
 *    keeps works whose 44-char slug prefixes collide distinct).
 * 2. **Identity welding** — the doc json is stamped with the work's own
 *    identity *before* the rebuild: `source.doi`/`source.arxiv_id` when the
 *    work has them (meta.title only backfilled); otherwise the work's title
 *    *overrides* `meta.title` so the seed's title-slug merge cannot miss and
 *    spawn a duplicate work. The doc id is additionally attached to
 *    `w.doc_ids` directly, and the post-rebuild store is validated to contain
 *    it — otherwise the attach throws (a "successful" upload that left the
 *    work without full text must surface as a failed job).
 *
 * Stage 7 MS3: the upload endpoint is open to EVERY work (no more `upload-`
 * prefix gating — that restriction was web-UI-only). The new doc is prepended
 * to `doc_ids`, i.e. it becomes the main doc (`doc_ids[0]`); older versions
 * stay listed for look-back. No physical delete, no archive.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LibraryRef, RefreshResponse } from "@argelanderspace/contracts";
import { patchWork, type RebuildOptions, rebuild } from "../library/build.js";
import { workToRef } from "../library/graph.js";
import type { MetadataSources } from "../library/sources.js";
import {
  type LibraryPaths,
  LibraryStore,
  normArxiv,
  normDoi,
  normTitle,
  slug,
  type Work,
} from "../library/store.js";
import type { IngestPipelines } from "./pipelines.js";

/** Python `repr` for the identify-a-work error message ('x' quoted, None). */
function pyRepr(v: string | null | undefined): string {
  return v === null || v === undefined ? "None" : `'${v}'`;
}

export function findWork(
  store: LibraryStore,
  query: {
    workId?: string | null;
    doi?: string | null;
    arxiv?: string | null;
    title?: string | null;
  }
): Work | undefined {
  if (query.workId) {
    const w = store.get(query.workId);
    if (w) return w;
  }
  const keys: string[] = [];
  const d = normDoi(query.doi);
  if (d) keys.push(`doi:${d}`);
  const a = normArxiv(query.arxiv);
  if (a) keys.push(`arxiv:${a}`);
  const w = store.match(...keys);
  if (w) return w;
  if (query.title) {
    const nt = normTitle(query.title);
    return store.works.find((x) => normTitle(x.title) === nt);
  }
  return undefined;
}

/**
 * The idempotent upload doc id: `upload-<slug(44)>-<hash6>` where the hash is
 * the first 6 hex chars of the *full* work id's sha1, so two works whose ids
 * share a 44-char slug prefix still get distinct docs.
 */
export function uploadDocId(workId: string): string {
  const hash = createHash("sha1").update(workId).digest("hex").slice(0, 6);
  return `upload-${slug(workId, 44)}-${hash}`;
}

/**
 * Weld the target work's identity onto the produced doc so the seed merge
 * links it back (see the module header). `via` records the provenance.
 */
export function stampSource(docJson: string, w: Work, via: string): void {
  const data = JSON.parse(readFileSync(docJson, "utf8")) as Record<string, unknown>;
  if (data.source === null || data.source === undefined) data.source = {};
  const src = data.source as Record<string, unknown>;
  if (w.doi) src.doi = w.doi;
  if (w.arxiv_id) src.arxiv_id = w.arxiv_id;
  src.acquired_via = via;
  if (data.meta === null || data.meta === undefined) data.meta = {};
  const meta = data.meta as Record<string, unknown>;
  if (!w.doi && !w.arxiv_id) {
    // No stable identifier: the title-slug merge is the only link, so the
    // work's title must win over whatever the source's own \title parsed to.
    if (w.title) meta.title = w.title;
  } else if (!meta.title && w.title) {
    meta.title = w.title;
  }
  writeFileSync(docJson, JSON.stringify(data, null, 2), "utf8");
}

/** Unpack + ingest *zipPath* and link the doc to the matching work. */
export async function attachLatexZip(
  zipPath: string,
  query: {
    workId?: string | null;
    doi?: string | null;
    arxiv?: string | null;
    title?: string | null;
  },
  deps: {
    paths: LibraryPaths;
    pipelines: IngestPipelines;
    sources: MetadataSources;
    /**
     * Composition seam (defaults to the real {@link rebuild}): the server
     * injects a lock-wrapped rebuild so the relink load→save stays mutually
     * exclusive with `patchWork` (Python's `_WRITE_LOCK`), without holding
     * that lock across the ingest itself.
     */
    rebuild?: (paths: LibraryPaths, opts: RebuildOptions) => Promise<RefreshResponse>;
    /**
     * Re-assert the uploaded doc's main-doc slot AFTER the rebuild, inside the
     * caller's writer lock (Stage 7 MS3 review N1). The weld below runs
     * OUTSIDE that lock — the ingest must not hold it — so a concurrent PATCH
     * can clobber it, in which case the seed merge re-attaches the doc at the
     * TAIL of `doc_ids`. This hook's move-to-front (idempotent) repairs the
     * order with no race window. The server injects a `libraryLock`-wrapped
     * patchWork; the default is the plain patchWork (single-writer callers).
     */
    reassertMainDoc?: (paths: LibraryPaths, workId: string, docId: string) => Promise<boolean>;
    /** Coarse progress sink: unpack → ingest → rebuild (the job's `report`). */
    onProgress?: (message: string) => void;
  }
): Promise<LibraryRef> {
  if (!existsSync(zipPath) || !statSync(zipPath).isFile()) {
    throw new Error(zipPath); // FileNotFoundError(zip_path)
  }

  const store = LibraryStore.load(deps.paths);
  const w = findWork(store, query);
  if (w === undefined) {
    throw new Error(
      `no matching work in the library (id=${pyRepr(query.workId)} doi=${pyRepr(query.doi)} arxiv=${pyRepr(query.arxiv)})`
    );
  }

  const docId = uploadDocId(w.id);
  deps.onProgress?.("Unpacking LaTeX source zip");
  await deps.pipelines.ingestLatexZip(zipPath, {
    outRoot: deps.paths.outputDir,
    docId,
    onProgress: deps.onProgress,
  });
  stampSource(join(deps.paths.outputDir, docId, `${docId}.json`), w, "user_latex_zip");

  // Weld the link directly: the seed merge below then only *confirms* it.
  // Stage 7 MS3 (re-upload for every work): the uploaded doc becomes the MAIN
  // doc — doc_ids[0] is the main-doc pointer — while older docs (e.g. the
  // arXiv-ingested one) stay in the list for look-back. The move-to-front also
  // covers re-uploads after the user switched the main doc back: an upload
  // always reclaims the main slot. The order survives the rebuild because the
  // seed merge keeps the stored order and only appends new docs (mergeInto:
  // dst first), so no extra "sticky main" marker is needed.
  w.doc_ids = [docId, ...w.doc_ids.filter((d) => d !== docId)];
  store.save(deps.paths);

  deps.onProgress?.("Rebuilding library");
  await (deps.rebuild ?? rebuild)(deps.paths, { sources: deps.sources }); // relink + refresh graph

  // Re-assert the main slot through the writer lock (see the dep's doc): the
  // weld above is outside that lock, so a clobbered weld would leave the
  // upload doc at the tail. Idempotent — a no-op on the fast path.
  const attached = findWork(LibraryStore.load(deps.paths), {
    workId: w.id,
    doi: w.doi,
    arxiv: w.arxiv_id,
  });
  if (attached?.doc_ids.includes(docId)) {
    const reassert =
      deps.reassertMainDoc ??
      (async (p: LibraryPaths, workId: string, d: string) => patchWork(p, workId, { doc_id: d }));
    await reassert(deps.paths, attached.id, docId);
  }

  const store2 = LibraryStore.load(deps.paths);
  const w2 = findWork(store2, { workId: w.id, doi: w.doi, arxiv: w.arxiv_id });
  if (w2 === undefined || !w2.doc_ids.includes(docId)) {
    throw new Error(`uploaded doc ${docId} did not attach to work ${pyRepr(w.id)}`);
  }
  return workToRef(w2);
}
