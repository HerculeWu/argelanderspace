/**
 * The in-process runtime of the operation catalog (ADR 0015; release-0.2 tickets 01 and 06): what a CLI command uses
 * when no workbench takes the operation (detection and routing to a running workbench are ticket 02). It composes the
 * same `LibraryOpDeps` shape the server does, on its own library lock, with no notification sink. The Library payload
 * is read without writing anything: a stale graph cache is rebuilt in memory, not healed on disk.
 *
 * What a command that writes needs (the import pipeline, the arXiv job queue, the PDF upload) is built on first use, so
 * a read creates no job directory and no runner. Jobs that run in this process are waited for to their end: the
 * process is the only thing that could run them, so a command that returned earlier would leave a queued job nobody
 * runs (`docs/operation-catalog.md`, "Long tasks without a workbench"). That includes the automatic arXiv PDF job that
 * the import menu queues after a single identifier or bibcode import: it is queued by the same `auto_ingest_arxiv`
 * setting as on the workbench (user ruling 2026-10-29: the effect is the same), and the import waits for it to end.
 */

import { join } from "node:path";
import {
  buildGraph,
  type IngestPipelines,
  type LibraryPaths,
  LibraryStore,
  libraryPayload,
  loadCurrentGraph,
  type MetadataSources,
} from "@argelanderspace/core";
import { fetchArxivPdf } from "@argelanderspace/infra";
import { type Acquisition, createAcquisition, createLockedRebuild } from "./acquisition.js";
import { createAnnotationAccess } from "./annotations-access.js";
import { type ArgumentOpDeps, ArgumentUndoRegistry } from "./copilot-argument-tool.js";
import {
  type AdapterWiring,
  realAdsLibraries,
  realAdsSearch,
  realDiscoverySource,
  realPipelines,
  realSources,
} from "./deps.js";
import { DocMutationRegistry } from "./doc-mutations.js";
import { JobRunner, readJobRecords } from "./jobs.js";
import type { AcquisitionPort, JobTable, LibraryOpDeps } from "./library-actions.js";
import { AsyncLock } from "./lock.js";
import type { OperationRuntime } from "./operation-catalog.js";
import { createPdfAccess, worksOwningDoc } from "./pdf-access.js";
import { createReaderOps } from "./reader-ops-deps.js";
import { readSettings } from "./settings.js";
import { TextDocService } from "./text-docs.js";

/** The longest a timer can wait: "until the job ends" for a process that is the only one that can run it. */
const UNBOUNDED_WAIT_MS = 2_147_483_647;

/** Replacements for the real network and toolchain compositions, for tests; the CLI passes none. */
export interface LocalOperationSeams {
  makeSources?: (offline: boolean) => MetadataSources | Promise<MetadataSources>;
  pipelines?: IngestPipelines;
  fetchArxivPdf?: (arxivId: string) => Promise<Buffer>;
  /** The `auto_ingest_arxiv` gate; absent → the setting in the user's config file, read at each import like the workbench. */
  autoIngestArxiv?: () => boolean;
}

/**
 * `wiring` is the composition seam of the network clients (tests inject `fetchImpl` and `adsToken`); the CLI passes none,
 * so the ADS token is read from the credential store at each use and requests go out through the global `fetch`.
 */
export function createLocalOperationRuntime(
  paths: LibraryPaths,
  wiring: AdapterWiring = {},
  seams: LocalOperationSeams = {}
): OperationRuntime {
  const libraryLock = new AsyncLock();
  // The annotation and PDF access paths are the server's own modules, here on this process's locks (the only code that
  // reads or writes a Doc's annotations). The Doc mutation registry is shared with the acquisition below, so a Doc whose
  // job runs in this process is busy to them too; nothing is announced.
  const annotationLock = new AsyncLock();
  const docMutations = new DocMutationRegistry();
  const none = () => {};
  const annotationAccess = createAnnotationAccess({
    paths,
    lock: annotationLock,
    docMutations,
    onChanged: none,
  });
  const pdfAccess = createPdfAccess({
    paths,
    docMutations,
    lock: annotationLock,
    onChanged: none,
    readingPositionLock: new AsyncLock(),
    onReadingPositionChanged: none,
  });
  const jobsDir = join(paths.dataDir, "jobs");
  let built: Acquisition | undefined;
  let builtRunner: JobRunner | undefined;
  /** The import pipeline and the job queue, made when an operation first needs them. */
  const acquisition = (): Acquisition => {
    if (built) return built;
    const runner = new JobRunner({ dir: jobsDir, recover: false });
    const made = createAcquisition({
      paths,
      runner,
      libraryLock,
      annotationLock,
      docMutations,
      libraryChanged: () => {},
      lockedRebuild: createLockedRebuild(libraryLock),
      pipelines: seams.pipelines ?? realPipelines(paths, wiring),
      makeSources: seams.makeSources ?? ((offline) => realSources(paths, offline, wiring)),
      fetchArxivPdf:
        seams.fetchArxivPdf ??
        ((arxivId) =>
          fetchArxivPdf(
            arxivId,
            wiring.fetchImpl === undefined ? {} : { fetchImpl: wiring.fetchImpl }
          )),
      // The same switch as the workbench's; a job queued here is waited for by `importWorks` below.
      autoIngestArxiv:
        seams.autoIngestArxiv ?? (() => readSettings().values.auto_ingest_arxiv !== false),
      pdfOwners: (docId) => worksOwningDoc(paths, docId),
      acquisitionWaitMs: UNBOUNDED_WAIT_MS,
    });
    runner.onEvent = (type, job) => made.onJobEvent(type, job);
    built = made;
    builtRunner = runner;
    return made;
  };
  /** The job records are on disk at every transition, so reads never need the runner. */
  const jobs: JobTable = {
    list: () => readJobRecords(jobsDir),
    get: (id) => built?.jobs.get(id) ?? readJobRecords(jobsDir).find((job) => job.id === id),
    waitFor: (id) => acquisition().jobs.waitFor(id),
  };
  const port: AcquisitionPort = {
    startPdfUpload: (workId, bytes, filename) =>
      acquisition().startPdfUpload(workId, bytes, filename),
    startPdf: (workId) => acquisition().startPdf(workId),
    describeSource: (workId) => acquisition().describeSource(workId),
    startSource: (workId) => acquisition().startSource(workId),
    annotationRisk: (docId) => acquisition().annotationRisk(docId),
    jobs,
    waitMs: UNBOUNDED_WAIT_MS,
  };
  const library: LibraryOpDeps = {
    paths,
    libraryLock,
    onChanged: () => {},
    readPayload: async () =>
      libraryPayload(
        paths,
        loadCurrentGraph(paths) ?? buildGraph(LibraryStore.load(paths), paths.outputDir)
      ),
    importWorks: async (req, options) => {
      const made = acquisition();
      const known = new Set(builtRunner?.list().map((job) => job.id));
      const outcome = await made.importManualWorks(req, options);
      // The automatic arXiv PDF jobs this import queued: this process is the only one that can run them, so wait for
      // their end (the answer is the import's, exactly as on the workbench; the jobs' end is in `read-jobs`).
      const queued = (builtRunner?.list() ?? []).filter((job) => !known.has(job.id));
      await Promise.all(queued.map((job) => made.jobs.waitFor(job.id)));
      return outcome;
    },
    acquisition: port,
    adsLibraries: () => realAdsLibraries(wiring),
    adsSearch: () => realAdsSearch(wiring),
    discoverySource: () => realDiscoverySource(paths, wiring),
  };
  // Argument graphs (ticket 08): their own lock and no notice, like the library above. The undo memory lasts as long
  // as this one command, so `undo_delete` has nothing to undo here (it answers so).
  const argument: ArgumentOpDeps = {
    dataDir: paths.dataDir,
    lock: new AsyncLock(),
    onChanged: () => {},
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
  };
  return {
    library,
    argument,
    reader: createReaderOps({ paths, annotationAccess, pdfAccess, docMutations }),
    text: new TextDocService({
      paths,
      libraryLock,
      annotationLock,
      docMutations,
      broadcast: none,
      libraryChanged: none,
    }),
  };
}
