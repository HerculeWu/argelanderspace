/**
 * Library acquisition, upload and manual import (docs/library.md "上传、多 Doc 与主位", "arXiv PDF 获取与既有 LaTeX
 * 来源"; docs/contracts.md "本地 PDF Doc", "删除生命周期"): the arXiv PDF and LaTeX source jobs, the PDF and LaTeX zip
 * uploads (async and `?sync=1`), the manual import's default PDF jobs, and the library refresh.
 *
 * ONE instance, made by `createApp`, serves the routes and the Copilot `library` tool (`libraryOps.acquisition`,
 * `libraryOps.importWorks`). It receives, never makes, the app's one JobRunner, libraryLock, annotationLock and
 * DocMutationRegistry; `libraryChanged` is the app's `library.changed` notification. Every Doc-writing submit (arXiv
 * PDF/source, PDF upload, zip job, sync attach) is "check isDeleting/isBusy → pinWriter → runner.submit" with no
 * await in between; the refresh instead takes the whole-library `pinRefresh` (no isDeleting check) inside its try and
 * releases it in `finally`. The PDF upload's pins are released by
 * `onJobEvent` (the app's one `runner.onEvent` hook calls it first); the other jobs release theirs on `waitFor`. The
 * HTTP status mapping stays with the routes.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ArgumentGraphMergeNote,
  Job,
  LibraryRef,
  ManualWorkRequest,
  RefreshResponse,
} from "@argelanderspace/contracts";
import { PDF_MAX_BYTES, PDF_RESOURCE_WARNING_BYTES } from "@argelanderspace/contracts";
import {
  appendDocIdNarrow,
  arxivAttachScenario,
  arxivDocId,
  attachArxivDoc,
  attachLatexZip,
  describeArgumentGraphMerge,
  findMatchingPdfDoc,
  findWork,
  type IngestPipelines,
  type LibraryPaths,
  LibraryStore,
  type MetadataSources,
  normArxiv,
  patchWorkNarrow,
  publishPdfDoc,
  readAnnotationRisk,
  readPdfMetadataIfPresent,
  rebuild,
  relativeMergeNote,
  restoreUnknownKeys,
  uploadDocId,
  type Work,
} from "@argelanderspace/core";
import { ArxivPdfOnlyError, extractZip, f, ZipError } from "@argelanderspace/infra";
import { type ArxivFetchStage, appendArxivFetchLog } from "./arxiv-fetch-log.js";
import { badDocId } from "./doc-id.js";
import type { DocMutationRegistry } from "./doc-mutations.js";
import type { JobErrorCode, JobEventType, JobRunner } from "./jobs.js";
import {
  type AcquisitionPort,
  type AnnotationRisk,
  type ArxivSourcePlan,
  type ArxivStart,
  type ManualImportResult,
  runManualImport,
} from "./library-actions.js";
import type { AsyncLock } from "./lock.js";
import { type ServerLog, silentLog } from "./log.js";
import { jobIdField } from "./log-observers.js";
import { probePdf } from "./pdfium-probe.js";

export type LockedRebuild = (
  p: LibraryPaths,
  opts: { sources: MetadataSources }
) => Promise<RefreshResponse>;

export interface AcquisitionDeps {
  paths: LibraryPaths;
  /** The app's one serial job runner (received, never made here). */
  runner: JobRunner;
  /** The app's one libraryLock. */
  libraryLock: AsyncLock;
  /** The app's one annotationLock: the annotation-risk read runs under it. */
  annotationLock: AsyncLock;
  /** The app's one registry, shared with the Doc delete and the text Doc service. */
  docMutations: DocMutationRegistry;
  /** `library.changed{cause}`. */
  libraryChanged: (cause: "refresh" | "add" | "upload" | "ingest") => void;
  /** rebuild through the libraryLock (`createLockedRebuild`). */
  lockedRebuild: LockedRebuild;
  /** `argument-graph.changed` for a Work, right after a Work merge moved a graph (no waiting for the file poller). */
  argumentGraphChanged?: ((workId: string) => void) | undefined;
  pipelines: IngestPipelines;
  /**
   * The pipelines for one job: the same, except that a failed compile keeps its complete log beside that job's record
   * (compile-failure-log.ts). Absent (injected pipelines) → `pipelines`.
   */
  pipelinesForJob?: ((jobId: string) => IngestPipelines) | undefined;
  makeSources: (offline: boolean) => MetadataSources;
  /** External current arXiv PDF bytes; absent → the PDF job fails ("arXiv PDF source is unavailable"). */
  fetchArxivPdf?: ((arxivId: string) => Promise<Buffer>) | undefined;
  /** The hidden auto_ingest_arxiv gate, read fresh at every automatic submit. */
  autoIngestArxiv: () => boolean;
  /** The Works whose doc_ids hold this Doc (the PDF owner rule). */
  pdfOwners: (docId: string) => Work[];
  /** Longest the Copilot `library` tool waits for an acquisition job before answering `pending`. */
  acquisitionWaitMs?: number | undefined;
  /** The user-level log; absent → nothing is recorded. */
  log?: ServerLog | undefined;
}

/** The zip upload's Work query (`?id=|doi=|arxiv=`). */
export type ZipQuery = { workId: string | null; doi: string | null; arxiv: string | null };

/** The PDF upload's submit: queued, or why not (busy → 409, failed → 500 at the route). */
export type PdfUploadStart =
  | { kind: "queued"; job: Job; resourceWarning?: boolean }
  | { kind: "busy" }
  | { kind: "failed"; detail: string };

/** The zip upload's async submit: queued, or busy (a delete of the upload Doc is in flight → 409 at the route). */
export type ZipJobStart = { kind: "queued"; job: Job } | { kind: "busy" };

/** The zip upload's `?sync=1` attach (busy → 409, no_work → 404, failed → 500 at the route). */
export type ZipSyncOutcome =
  | {
      kind: "attached";
      ref: Awaited<ReturnType<typeof attachLatexZip>>;
      /** Present only when a Work merge during the ingest met an argument graph (relative paths). */
      argument_graph_merges: ArgumentGraphMergeNote[];
    }
  | { kind: "busy" }
  | { kind: "no_work"; message: string }
  | {
      kind: "failed";
      message: string;
      /** Present when a Work merge had already moved graphs before the ingest failed (relative paths). */
      argument_graph_merges?: ArgumentGraphMergeNote[];
    };

/** The library refresh: the rebuild summary, or the failed job's error (500 at the route). */
export type RefreshOutcome =
  | { kind: "done"; summary: RefreshResponse }
  | { kind: "failed"; detail: string };

export interface Acquisition extends AcquisitionPort {
  startPdfUpload(workId: string, bytes: Buffer, filename: string): PdfUploadStart;
  startZipJob(query: ZipQuery, data: Uint8Array): ZipJobStart;
  attachZipSync(query: ZipQuery, data: Uint8Array): Promise<ZipSyncOutcome>;
  refreshLibrary(offline: boolean): Promise<RefreshOutcome>;
  importManualWorks(
    req: ManualWorkRequest,
    options?: { bridge?: "merge" | "reject" }
  ): Promise<ManualImportResult>;
  submitArxivPdf(workId: string, automatic: boolean): Job | null;
  /** The PDF upload's pin release; the app's one `runner.onEvent` hook calls it before anything else. */
  onJobEvent(type: JobEventType, job: Job): void;
}

/** The merge notes an error from a library save carries (core attaches them when the merge was already saved). */
function mergesOf(error: unknown): ArgumentGraphMergeNote[] {
  const notes = (error as { argumentGraphMerges?: unknown } | null)?.argumentGraphMerges;
  return Array.isArray(notes) ? (notes as ArgumentGraphMergeNote[]) : [];
}

const MERGE_OUTCOMES = ["moved", "kept_survivor", "transfer_failed"] as const;
const MERGE_ERRORS = ["absorbed_unreadable", "survivor_name_unusable", "write_failed"] as const;
const YES_NO = ["yes", "no"] as const;

/**
 * The log keeps every note, since a background task may discard its summary: what happened, and to which two Works.
 * Not where the files are — a graph file is named after its Work's id, which may be made from the Work's title.
 */
function logMerges(log: ServerLog, notes: readonly ArgumentGraphMergeNote[]): void {
  for (const note of notes) {
    log.warn("library.argument_graph_merged", {
      outcome: f.oneOf(MERGE_OUTCOMES, note.outcome),
      absorbed: f.workId(note.absorbed_id),
      survivor: f.workId(note.survivor_id),
      ...(note.error === undefined ? {} : { reason: f.oneOf(MERGE_ERRORS, note.error) }),
      ...(note.survivor_unreadable === undefined
        ? {}
        : { survivor_unreadable: f.oneOf(YES_NO, note.survivor_unreadable ? "yes" : "no") }),
      ...(note.absorbed_file_left === undefined
        ? {}
        : { absorbed_file_left: f.oneOf(YES_NO, note.absorbed_file_left ? "yes" : "no") }),
    });
  }
}

/** A library import that failed after its Work merge was saved; the notes are for the page (relative paths). */
export class ImportAfterMergeError extends Error {
  constructor(
    readonly notes: ArgumentGraphMergeNote[],
    cause: unknown
  ) {
    super(
      "the import failed after the Work merge was saved. " +
        `${notes.map((n) => describeArgumentGraphMerge(n)).join(" ")}`
    );
    this.name = "ImportAfterMergeError";
    this.cause = cause;
  }
}

/** rebuild through the lock. */
export function createLockedRebuild(
  libraryLock: AsyncLock,
  log: ServerLog = silentLog
): LockedRebuild {
  return (p, opts) =>
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
        logMerges(log, mergesOf(rebuildError));
        throw rebuildError;
      }
      // The merge notes of this rebuild (ticket 06). A job that discards its summary has them from the collector
      // below; the server log keeps them either way.
      const merges = result.argument_graph_merges ?? [];
      logMerges(log, merges);
      try {
        restoreUnknownKeys(p, before);
      } catch (error) {
        // The rebuild itself (and with it the Work merge and its graph moves) is saved: say so, with the notes.
        const failure = new Error(
          `the library was rebuilt but keys the application does not know could not be put back: ${error instanceof Error ? error.message : String(error)}${
            merges.length > 0
              ? ` (${merges.map((n) => describeArgumentGraphMerge(relativeMergeNote(p.dataDir, n))).join(" ")})`
              : ""
          }`
        );
        (
          failure as Error & { argumentGraphMerges?: ArgumentGraphMergeNote[] }
        ).argumentGraphMerges = merges;
        throw failure;
      }
      return result;
    });
}

/** Whether these bytes are a readable zip archive (the upload route's two-step gate). */
export function isReadableZip(data: Uint8Array): boolean {
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
}

export function createAcquisition(deps: AcquisitionDeps): Acquisition {
  const log = deps.log ?? silentLog;
  const {
    paths,
    runner,
    libraryLock,
    annotationLock,
    docMutations,
    libraryChanged,
    autoIngestArxiv,
    pdfOwners,
  } = deps;
  /** A merge that moved a graph changed the survivor's and the absorbed Work's graph; say so now. */
  const announceMerges = (notes: readonly ArgumentGraphMergeNote[]): void => {
    if (deps.argumentGraphChanged === undefined) return;
    const ids = new Set<string>();
    for (const n of notes)
      if (n.outcome === "moved") {
        ids.add(n.survivor_id);
        ids.add(n.absorbed_id);
      }
    for (const id of ids) {
      try {
        deps.argumentGraphChanged(id);
      } catch (e) {
        log.error("argument_graph.broadcast_failed", { work: f.workId(id), error: f.error(e) });
      }
    }
  };
  /** Every rebuild of this module announces the graph moves it made, whether it succeeded or failed afterwards. */
  const lockedRebuild: LockedRebuild = async (p, opts) => {
    try {
      const out = await deps.lockedRebuild(p, opts);
      announceMerges(out.argument_graph_merges ?? []);
      return out;
    } catch (error) {
      announceMerges(mergesOf(error));
      throw error;
    }
  };
  const fetchArxivPdf = deps.fetchArxivPdf;
  /** PDF upload job → the Docs it pinned (its own, plus a duplicate found at run time); released by onJobEvent. */
  const pdfPinsByJob = new Map<string, string[]>();

  const onJobEvent = (type: JobEventType, job: Job): void => {
    if (type === "job.done" || type === "job.failed") {
      const pinnedDocs = pdfPinsByJob.get(job.id);
      if (pinnedDocs) {
        for (const pinnedDoc of pinnedDocs) docMutations.unpinWriter(pinnedDoc);
        pdfPinsByJob.delete(job.id);
      }
    }
  };

  // ---- Stage 15: legacy manual arXiv LaTeX fetch --------------------------- //

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
  /** Notes for the page: locations relative to the data directory, never an absolute path. */
  const relNotes = (notes: readonly ArgumentGraphMergeNote[]): ArgumentGraphMergeNote[] =>
    notes.map((n) => relativeMergeNote(paths.dataDir, n));
  /**
   * A rebuild for one task that remembers the argument-graph notes of its rebuilds (ticket 06), so the task can
   * put them in its result: a background task has no other way to tell the page that a Work merge moved a graph.
   */
  const collectingRebuild = (): { rebuild: LockedRebuild; notes: ArgumentGraphMergeNote[] } => {
    const notes: ArgumentGraphMergeNote[] = [];
    const rebuild: LockedRebuild = async (p, opts) => {
      try {
        const out = await lockedRebuild(p, opts);
        notes.push(...(out.argument_graph_merges ?? []));
        return out;
      } catch (error) {
        notes.push(...mergesOf(error));
        throw error;
      }
    };
    return { rebuild, notes };
  };
  /** The task result with the notes under `argument_graph_merges`, only when there are some. */
  const withMerges = <T extends object>(result: T, notes: readonly ArgumentGraphMergeNote[]): T =>
    notes.length > 0 ? { ...result, argument_graph_merges: relNotes(notes) } : result;

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
          const collected = collectingRebuild();
          try {
            const attached = await attachArxivDoc(workId, {
              paths,
              pipelines: deps.pipelinesForJob?.(j.id) ?? deps.pipelines,
              sources: deps.makeSources(false),
              rebuild: collected.rebuild,
              // N1 (upload precedent): the main-doc re-assert must be mutually
              // exclusive with PATCH — the weld runs outside the lock.
              reassertMainDoc: (p, wid, d) =>
                libraryLock.run(() => patchWorkNarrow(p, wid, { doc_id: d }).status === "ok"),
              linkDoc: (_p, wid, did) => linkArxivDoc(wid, did),
              onProgress: track,
              isPdfDoc,
              appendArxivDocToPdfWork: (_p, wid, did) => appendArxivDocToPdfWork(wid, did),
            });
            return withMerges(attached, collected.notes);
          } catch (e) {
            // A rebuild that already merged Works and moved graphs before a later step failed: the failed job
            // keeps the notes in its result so the page can still show them.
            if (collected.notes.length > 0) j.result = withMerges({}, collected.notes);
            if (e instanceof ArxivPdfOnlyError) {
              stage = "extract";
              // Machine-readable class for the web UI's bilingual guidance.
              j.errorCode = "arxiv_pdf_only" satisfies JobErrorCode;
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
          log.error("arxiv_fetch.log_append_failed", {
            job: jobIdField(j.id),
            error: f.error(logErr),
          });
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
      if (badDocId(docId) || !docId.trim()) return { state: "unknown" };
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
   * The PDF upload's submit once the bytes are in hand (validated work, size and file name): same-Work identical
   * bytes reuse the Doc, DocMutationRegistry pins/busy rules, one serial durable job.
   */
  const startPdfUpload = (workId: string, bytes: Buffer, filename: string): PdfUploadStart => {
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
      return message === "document busy" ? { kind: "busy" } : { kind: "failed", detail: message };
    }
    const docId = existing?.doc_id ?? `pdf-${randomUUID()}`;
    if (docMutations.isBusy(docId) || docMutations.isDeleting(docId)) {
      return { kind: "busy" };
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
        kind: "failed",
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
        kind: "failed",
        detail: error instanceof Error ? error.message : "PDF upload could not be stored",
      };
    }
    return { kind: "queued", job, resourceWarning: bytes.length >= PDF_RESOURCE_WARNING_BYTES };
  };

  const runAttachFor = async (
    query: ZipQuery,
    zipPath: string,
    onProgress?: (message: string) => void,
    onFailureNotes?: (notes: readonly ArgumentGraphMergeNote[]) => void,
    /** The job this runs in; the synchronous upload has none (and so keeps no compile failure log). */
    jobId?: string
  ): Promise<{ ref: LibraryRef; argument_graph_merges: ArgumentGraphMergeNote[] }> => {
    const collected = collectingRebuild();
    let ref: LibraryRef;
    try {
      ref = await attachZip(zipPath, query, collected, onProgress, jobId);
    } catch (error) {
      onFailureNotes?.(collected.notes);
      throw error;
    }
    return { ref, argument_graph_merges: relNotes(collected.notes) };
  };
  const attachZip = async (
    zipPath: string,
    query: ZipQuery,
    collected: ReturnType<typeof collectingRebuild>,
    onProgress?: (message: string) => void,
    jobId?: string
  ): Promise<LibraryRef> => {
    const ref = await attachLatexZip(zipPath, query, {
      paths,
      pipelines:
        (jobId === undefined ? undefined : deps.pipelinesForJob?.(jobId)) ?? deps.pipelines,
      sources: deps.makeSources(false),
      rebuild: collected.rebuild,
      // The link runs inside the library lock with narrow writes (the ingest itself does not): nothing written
      // meanwhile (imports, edits, unknown keys) is overwritten.
      linkDoc: (_p, workId, docId, identity) => linkUploadDoc(workId, docId, identity),
      // N1: the main-doc re-assert must be mutually exclusive with PATCH.
      reassertMainDoc: (p, workId, docId) =>
        libraryLock.run(() => patchWorkNarrow(p, workId, { doc_id: docId }).status === "ok"),
      onProgress,
    });
    return ref;
  };
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
  const startZipJob = (query: ZipQuery, data: Uint8Array): ZipJobStart => {
    const targetWork = findWork(LibraryStore.load(paths), query);
    const uploadDoc = targetWork === undefined ? undefined : uploadDocId(targetWork.id);
    if (uploadDoc !== undefined && docMutations.isDeleting(uploadDoc)) return { kind: "busy" };
    if (uploadDoc !== undefined) docMutations.pinWriter(uploadDoc);
    let job: Job;
    try {
      job = runner.submit(
        "upload",
        async (j, report) => {
          const zip = runner.spoolPath(j.id);
          try {
            const { ref, argument_graph_merges } = await runAttachFor(
              query,
              zip,
              report,
              (notes) => {
                // failed after merging Works: the failed job keeps the notes (see the arXiv fetch above)
                if (notes.length > 0) j.result = withMerges({}, notes);
              },
              j.id
            );
            return {
              ref,
              docId: uploadDocId(ref.id),
              ...(argument_graph_merges.length > 0 ? { argument_graph_merges } : {}),
            };
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

  /**
   * The zip upload's `?sync=1` branch. Legacy behavior (app.py verbatim): the response waits for the ingest. The
   * DELETE lifecycle pin is held around the attach call, and a delete in flight refuses to start.
   */
  const attachZipSync = async (query: ZipQuery, data: Uint8Array): Promise<ZipSyncOutcome> => {
    const targetWork = findWork(LibraryStore.load(paths), query);
    const uploadDoc = targetWork === undefined ? undefined : uploadDocId(targetWork.id);
    if (uploadDoc !== undefined && docMutations.isDeleting(uploadDoc)) {
      return { kind: "busy" };
    }
    const tmp = join(
      tmpdir(),
      `argelanderspace-upload-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`
    );
    if (uploadDoc !== undefined) docMutations.pinWriter(uploadDoc);
    let failedNotes: readonly ArgumentGraphMergeNote[] = [];
    try {
      writeFileSync(tmp, data);
      const { ref, argument_graph_merges } = await runAttachFor(query, tmp, undefined, (notes) => {
        failedNotes = notes;
      });
      return { kind: "attached", ref, argument_graph_merges };
    } catch (e) {
      // Python: ValueError/FileNotFoundError → 404, anything else → 500.
      const msg = e instanceof Error ? e.message : String(e);
      return msg.startsWith("no matching work in the library")
        ? { kind: "no_work", message: msg }
        : {
            kind: "failed",
            message: msg,
            ...(failedNotes.length > 0 ? { argument_graph_merges: relNotes(failedNotes) } : {}),
          };
    } finally {
      if (uploadDoc !== undefined) docMutations.unpinWriter(uploadDoc);
      rmSync(tmp, { force: true });
    }
  };

  /**
   * `POST /api/library/refresh` minus the HTTP shape: the request still waits for the summary, but the rebuild
   * runs as a serial job: mutual exclusion with upload OCR and progress over WS. Stage 8 §8: the pin makes DELETE
   * refuse to interleave (a rebuild re-derives every work's doc_ids — see doc-mutations.ts). The pin is taken
   * INSIDE the try: a throwing `runner.submit` must not leak it (finally unpins either way).
   */
  const refreshLibrary = async (offline: boolean): Promise<RefreshOutcome> => {
    try {
      docMutations.pinRefresh();
      const job = runner.submit(
        "refresh",
        async (j) => {
          try {
            const out = await lockedRebuild(paths, { sources: deps.makeSources(offline) });
            // the task record (jobs/<id>.json, job.done, hello) must never hold an absolute path either
            return out.argument_graph_merges === undefined
              ? out
              : { ...out, argument_graph_merges: relNotes(out.argument_graph_merges) };
          } catch (error) {
            // failed after the Work merge was saved: the failed job keeps the notes
            const notes = mergesOf(error);
            if (notes.length > 0) j.result = withMerges({}, notes);
            throw error;
          }
        },
        { offline }
      );
      const done = await runner.waitFor(job.id);
      if (done.status !== "done") {
        return { kind: "failed", detail: done.error ?? "refresh failed" };
      }
      libraryChanged("refresh");
      const summary = done.result as RefreshResponse;
      return {
        kind: "done",
        summary,
      };
    } finally {
      docMutations.unpinRefresh();
    }
  };

  // The one import seam of the Library: the route and the Copilot `library` tool both come here.
  // Automatic PDF is limited to the existing identifier/bibcode modes; bulk BibTeX never auto-queues.
  // Submission failure cannot undo the Work.
  const importManualWorks = async (
    req: ManualWorkRequest,
    options: { bridge?: "merge" | "reject" } = {}
  ): Promise<ManualImportResult> => {
    let outcome: ManualImportResult;
    try {
      outcome = await runManualImport(
        { paths, libraryLock, makeSources: () => deps.makeSources(false) },
        req,
        options
      );
    } catch (error) {
      // library.json already holds the merge (only a later file failed): the page must hear what the graphs did.
      const notes = mergesOf(error);
      if (notes.length === 0) throw error;
      logMerges(log, notes);
      announceMerges(notes);
      libraryChanged("add");
      throw new ImportAfterMergeError(relNotes(notes), error);
    }
    if (outcome.argumentGraphMerges !== undefined && outcome.argumentGraphMerges.length > 0) {
      announceMerges(outcome.argumentGraphMerges);
      outcome = { ...outcome, argumentGraphMerges: relNotes(outcome.argumentGraphMerges) };
    }
    if (req.mode !== "bib" && autoIngestArxiv()) {
      for (const r of outcome.results) {
        if ((r.status === "created" || r.status === "exists") && r.ref !== undefined) {
          try {
            submitArxivPdf(r.ref.id, true);
          } catch (e) {
            log.error("arxiv_ingest.auto_submit_failed", {
              work: f.workId(r.ref.id),
              error: f.error(e),
            });
          }
        }
      }
    }
    // A created Work or an updated existing one changes the file the page lists: one notification, like the page's reload.
    if (outcome.changed) libraryChanged("add");
    return outcome;
  };

  return {
    startPdf: (workId) => startArxivPdfAcquisition(workId),
    describeSource: (workId) => describeArxivSource(workId),
    startSource: (workId) => startArxivSource(workId),
    annotationRisk: (docId) => annotationRisk(docId),
    jobs: runner,
    ...(deps.acquisitionWaitMs !== undefined ? { waitMs: deps.acquisitionWaitMs } : {}),
    startPdfUpload,
    startZipJob,
    attachZipSync,
    refreshLibrary,
    importManualWorks,
    submitArxivPdf,
    onJobEvent,
  };
}
