/**
 * Attach a user-supplied PDF to a library work (bibgraph/acquire/upload.py).
 *
 * The escape hatch for papers we can't fetch automatically — bot-walled
 * publishers (IOP/APS) or scans we have no open source for. The user provides the
 * PDF (from their browser / institutional access); we OCR it via MinerU and link
 * it to the work like any other reader rendering, stamping the work's DOI / arXiv
 * id on the produced doc so the library picks it up.
 *
 * Port notes (bug-for-bug):
 * - The MinerU OCR call inside `attach_pdf` is the M2/M3
 *   {@link IngestPipelines.ingestPdf} port; `rebuild` is the ported
 *   `library/build.ts` orchestration with injected {@link MetadataSources}.
 * - Python raises `FileNotFoundError` / `ValueError`; the port raises `Error`
 *   with the same messages (Python `repr` quotes preserved).
 */

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LibraryRef, RefreshResponse } from "@argelanderspace/contracts";
import { type RebuildOptions, rebuild } from "../library/build.js";
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
import { stampSource } from "./fetch-pdf.js";
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

/** OCR *pdfPath* and link it to the matching work. Returns the work's ref. */
export async function attachPdf(
  pdfPath: string,
  query: {
    workId?: string | null;
    doi?: string | null;
    arxiv?: string | null;
    title?: string | null;
    /** null → auto-detect text layer */
    forceOcr?: boolean | null;
  },
  deps: {
    paths: LibraryPaths;
    pipelines: IngestPipelines;
    sources: MetadataSources;
    /**
     * Composition seam (defaults to the real {@link rebuild}): the M4 server
     * injects a lock-wrapped rebuild so the relink load→save stays mutually
     * exclusive with `patchWork`/`addNodeToLibrary` (Python's `_WRITE_LOCK`),
     * without holding that lock across the OCR itself.
     */
    rebuild?: (paths: LibraryPaths, opts: RebuildOptions) => Promise<RefreshResponse>;
    /** Coarse progress sink (Stage 3 / MS3): the upload job's `report`. */
    onProgress?: (message: string) => void;
  }
): Promise<LibraryRef | Record<string, unknown>> {
  if (!existsSync(pdfPath) || !statSync(pdfPath).isFile()) {
    throw new Error(pdfPath); // FileNotFoundError(pdf_path)
  }

  const store = LibraryStore.load(deps.paths);
  const w = findWork(store, query);
  if (w === undefined) {
    throw new Error(
      `no matching work in the library (id=${pyRepr(query.workId)} doi=${pyRepr(query.doi)} arxiv=${pyRepr(query.arxiv)})`
    );
  }

  const docId = `upload-${slug(w.id)}`;
  const outDir = join(deps.paths.outputDir, docId);
  mkdirSync(outDir, { recursive: true });
  const dest = join(outDir, `${docId}.pdf`);
  if (resolve(pdfPath) !== resolve(dest)) {
    copyFileSync(pdfPath, dest);
  }

  deps.onProgress?.("Ingesting PDF (MinerU OCR)");
  await deps.pipelines.ingestPdf(dest, {
    outDir,
    isOcr: query.forceOcr ?? null,
    onProgress: deps.onProgress,
  });
  stampSource(join(outDir, `${docId}.json`), w, "user_pdf");

  deps.onProgress?.("Rebuilding library");
  await (deps.rebuild ?? rebuild)(deps.paths, { sources: deps.sources }); // relink doc_ids + refresh graph
  const store2 = LibraryStore.load(deps.paths);
  const w2 = findWork(store2, { workId: w.id, doi: w.doi, arxiv: w.arxiv_id });
  return w2 ? workToRef(w2) : { id: w.id, doc_id: docId };
}
