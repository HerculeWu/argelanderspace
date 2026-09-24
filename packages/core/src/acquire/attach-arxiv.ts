/**
 * Stage 15: attach (or refresh) the arXiv LaTeX source of a library work —
 * the automatic counterpart of {@link attachLatexZip} (`upload.ts`), whose
 * weld/rebuild/re-assert discipline this module mirrors (D3: "handle it
 * exactly like the manual upload chain").
 *
 * Differences from the upload path, all user-decided:
 *
 * - **Scenario table (D16)** — `arxivAttachScenario`: the work has no doc →
 *   `attach` (the new doc becomes main); the work already lists the same
 *   arXiv LaTeX doc → `refresh` (the latest e-print overwrites that LaTeX Doc
 *   in place, preserving order/main); a PDF-only Work → `append` a distinct
 *   LaTeX Doc without changing its PDF main; other non-PDF docs (including a
 *   user LaTeX zip) → `skip`, preserving the prior Scenario C rule. The server
 *   evaluates at submit and the job re-evaluates before linking.
 * - **Always fresh (D16)** — the pipeline port `ingestArxivEprint` never
 *   reads the stale on-disk e-print cache and re-extracts from scratch.
 * - **acquired_via = "arxiv_eprint"** — distinct from the upload's
 *   `"user_latex_zip"` so logs/forensics tell the two provenances apart
 *   (D10: arXiv-source failures are the high-priority ones to iterate on).
 *
 * The annotation contract is untouched: overwriting the doc JSON in place
 * changes the content fingerprint, and the existing three-state fingerprint
 * rules (keep on match, archive on mismatch, never touch on error) apply on
 * the next annotations access.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { LibraryRef, RefreshResponse } from "@argelanderspace/contracts";
import { patchWork, type RebuildOptions, rebuild } from "../library/build.js";
import { workToRef } from "../library/graph.js";
import type { MetadataSources } from "../library/sources.js";
import { type LibraryPaths, LibraryStore, normArxiv, type Work } from "../library/store.js";
import type { IngestPipelines } from "./pipelines.js";
import { stampSource } from "./upload.js";

/** The arXiv auto-ingest provenance stamped into the doc's `source` block. */
export const ARXIV_ATTACH_VIA = "arxiv_eprint";

/**
 * The doc id for a work's arXiv full text: `arxiv-<sanitized id>` on the
 * UNVERSIONED id (`work.arxiv_id` never carries `vN`), so attach and later
 * refreshes map to the same doc. Mirrors infra `docIdFor(arxiv, null)` — the
 * rule is re-stated here because core cannot import infra; an infra-side
 * parity test pins the agreement.
 */
export function arxivDocId(arxivId: string): string {
  const safe = arxivId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-._]+|[-._]+$/g, "");
  return `arxiv-${safe}`;
}

/** The three outcomes of the Stage 15 trigger scenario table (D16). */
export type ArxivAttachScenario = "attach" | "append" | "refresh" | "skip";

/**
 * Which scenario applies to *w* for its own arXiv LaTeX doc id. Existing ID
 * refreshes, a docless Work attaches as main, an all-PDF Work appends, and
 * unrelated non-PDF content keeps the legacy skip behavior.
 */
export function arxivAttachScenario(
  w: Work,
  docId: string,
  isPdfDoc: (docId: string) => boolean = () => false
): ArxivAttachScenario {
  if (w.doc_ids.includes(docId)) return "refresh";
  if (w.doc_ids.length === 0) return "attach";
  return w.doc_ids.every(isPdfDoc) ? "append" : "skip";
}

async function appendToPdfOnlyWork(
  paths: LibraryPaths,
  workId: string,
  docId: string,
  isPdfDoc: (docId: string) => boolean
): Promise<boolean> {
  const store = LibraryStore.load(paths);
  const work = store.get(workId);
  if (!work || arxivAttachScenario(work, docId, isPdfDoc) !== "append") return false;
  work.doc_ids = [...work.doc_ids, docId];
  store.save(paths);
  return true;
}

export interface ArxivAttachResult {
  status: "attached" | "appended" | "refreshed" | "skipped";
  docId: string;
  /** The post-attach work ref; null when skipped. */
  ref: LibraryRef | null;
}

/**
 * Fetch the latest arXiv e-print of *workId*'s `arxiv_id`, compile it, and
 * link the produced doc to the work per the scenario table. Throws on
 * download/extract/compile/attach failure (the job surfaces `error`); a
 * mid-flight switch to scenario C returns `skipped` instead (D4).
 */
export async function attachArxivDoc(
  workId: string,
  deps: {
    paths: LibraryPaths;
    pipelines: IngestPipelines;
    sources: MetadataSources;
    /** See {@link attachLatexZip} — the server injects the lock-wrapped one. */
    rebuild?: (paths: LibraryPaths, opts: RebuildOptions) => Promise<RefreshResponse>;
    /** See {@link attachLatexZip}; only consulted on the `attach` path. */
    reassertMainDoc?: (paths: LibraryPaths, workId: string, docId: string) => Promise<boolean>;
    /** Coarse progress sink: fetch → ingest → rebuild (the job's `report`). */
    onProgress?: (message: string) => void;
    /** Append a new LaTeX Doc only while this Work remains PDF-only. */
    appendArxivDocToPdfWork?: (
      paths: LibraryPaths,
      workId: string,
      docId: string
    ) => Promise<boolean>;
    /** Explicit PDF metadata predicate for the narrow PDF-only coexistence case. */
    isPdfDoc?: (docId: string) => boolean;
  }
): Promise<ArxivAttachResult> {
  const store = LibraryStore.load(deps.paths);
  const w = store.get(workId);
  if (w === undefined) {
    throw new Error(`no such work in the library: '${workId}'`);
  }
  const arxivId = normArxiv(w.arxiv_id);
  if (!arxivId) {
    throw new Error(`work '${workId}' has no arXiv id`);
  }
  const docId = arxivDocId(arxivId);
  const isPdfDoc = deps.isPdfDoc ?? (() => false);
  const scenario = arxivAttachScenario(w, docId, isPdfDoc);
  if (scenario === "skip") {
    // Execution-time re-check (D4): the work gained another doc (e.g. a user
    // upload) while the job queued — a no-op success, not a failure.
    return { status: "skipped", docId, ref: null };
  }

  deps.onProgress?.("Fetching latest arXiv e-print");
  await deps.pipelines.ingestArxivEprint(arxivId, {
    outRoot: deps.paths.outputDir,
    docId,
    onProgress: deps.onProgress,
  });
  const docJson = join(deps.paths.outputDir, docId, `${docId}.json`);
  if (!existsSync(docJson)) {
    throw new Error(`ingested doc JSON missing: ${docJson}`);
  }
  stampSource(docJson, w, ARXIV_ATTACH_VIA);

  if (scenario === "attach") {
    // With no existing Docs, this source becomes main.
    w.doc_ids = [docId, ...w.doc_ids.filter((d) => d !== docId)];
    store.save(deps.paths);
  } else if (scenario === "append") {
    const linked = deps.appendArxivDocToPdfWork
      ? await deps.appendArxivDocToPdfWork(deps.paths, w.id, docId)
      : await appendToPdfOnlyWork(deps.paths, w.id, docId, isPdfDoc);
    if (!linked) return { status: "skipped", docId, ref: null };
  }

  deps.onProgress?.("Rebuilding library");
  await (deps.rebuild ?? rebuild)(deps.paths, { sources: deps.sources });

  if (scenario === "attach") {
    // Same race-window repair as the upload: the weld above runs outside the
    // writer lock, so a concurrent PATCH could have clobbered the main slot.
    const attached = LibraryStore.load(deps.paths).get(w.id);
    if (attached?.doc_ids.includes(docId)) {
      const reassert =
        deps.reassertMainDoc ??
        (async (p: LibraryPaths, wid: string, d: string) => patchWork(p, wid, { doc_id: d }));
      await reassert(deps.paths, attached.id, docId);
    }
  }

  const w2 = LibraryStore.load(deps.paths).get(w.id);
  if (w2 === undefined || !w2.doc_ids.includes(docId)) {
    throw new Error(`arXiv doc ${docId} did not attach to work '${w.id}'`);
  }
  return {
    status: scenario === "attach" ? "attached" : scenario === "append" ? "appended" : "refreshed",
    docId,
    ref: workToRef(w2),
  };
}
