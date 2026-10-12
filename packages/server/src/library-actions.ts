import { createHash } from "node:crypto";
import {
  type ArgumentGraphMergeNote,
  ArgumentGraphMergeNoteSchema,
  type CopilotOperation,
  type DocReplaceImpact,
  type Job,
  type LibraryImportWorks,
  type LibraryPayload,
  type LibraryReadJobs,
  type LibraryReadOperation,
  type LibraryRefSummary,
  type LibrarySetMainDoc,
  libraryImportRequest,
  libraryLinksAmong,
  libraryRefBibtex,
  libraryRefIdentityMatches,
  libraryRefMatches,
  type ManualWorkRequest,
  type ManualWorkResult,
  summarizeLibraryRef,
} from "@argelanderspace/contracts";
import {
  addManualBibcode,
  addManualBibText,
  addManualIdentifier,
  arxivFromDoi,
  type LibraryPaths,
  LibraryStore,
  type ManualAddOutcome,
  type ManualIdentifier,
  type MetadataSources,
  normDoi,
  patchWorkNarrow,
  type RemovedDocWork,
  type WorkPatchExpectation,
  type WorkPatchResult,
} from "@argelanderspace/core";
import { explicitArxivId, looksLikeArxiv } from "@argelanderspace/infra";
import type { AsyncLock } from "./lock.js";

/**
 * What the Copilot `library` tool shares with the Web UI: the library write lock, the narrow work patch and
 * the `library.changed` notification, plus the page's own payload reader (`GET /api/library`).
 */
export interface LibraryOpDeps {
  /** The acquisition dialog's seam (arXiv PDF / LaTeX source jobs); absent in hosts without a Library. */
  acquisition?: AcquisitionPort;
  /** The Doc delete dialog's seam (`DELETE /api/paper/:doc_id`); absent in hosts without a Library. */
  deletion?: DocDeletionPort;
  paths: LibraryPaths;
  libraryLock: AsyncLock;
  /** Broadcasts `library.changed{cause:"patch"}`, like the PATCH route. */
  onChanged: () => void;
  /** The same payload the Library page loads; the graph cache is healed under the lock when stale. */
  readPayload: () => Promise<LibraryPayload>;
  /**
   * The import menu's shared handler (`POST /api/library/works`): validation, resolution, dedupe, the library
   * lock, the `library.changed{add}` notification and the default arXiv PDF job all live behind it. Absent in
   * hosts without a Library (the tool then reports `unavailable`).
   */
  importWorks?: (
    req: ManualWorkRequest,
    options?: { bridge?: "merge" | "reject" }
  ) => Promise<ManualImportResult>;
}

export type LibraryOpOutcome =
  | {
      ok: true;
      status: "ok" | "noop";
      object: NonNullable<CopilotOperation["object"]>;
      label?: string;
      mainDocId: string | null;
      warnings?: string[];
    }
  | {
      ok: false;
      status: "conflict" | "not_found" | "rejected" | "error";
      detail: string;
      current?: { mainDocId: string | null; docIds: string[] };
    };

/**
 * The one write seam of the Library: the PATCH route and the tool both come here. The patch is applied to
 * the CURRENT file inside the library lock; `expected` is checked against that same re-read, so a change to
 * a field the caller relied on is a conflict and an unrelated change is simply kept.
 */
export async function commitWorkPatch(
  deps: LibraryOpDeps,
  workId: string,
  patch: Record<string, unknown>,
  expected?: WorkPatchExpectation
): Promise<WorkPatchResult> {
  const result = await deps.libraryLock.run(() =>
    patchWorkNarrow(deps.paths, workId, patch, expected)
  );
  if (result.status === "ok") deps.onChanged();
  return result;
}

/** The Files tab "set as main" button, as an operation. */
export async function applyLibraryOperation(
  deps: LibraryOpDeps,
  op: LibrarySetMainDoc
): Promise<LibraryOpOutcome> {
  let changed = false;
  let notified = true;
  const guarded: LibraryOpDeps = {
    ...deps,
    onChanged: () => {
      changed = true;
      try {
        deps.onChanged();
      } catch {
        notified = false;
      }
    },
  };
  let result: WorkPatchResult;
  try {
    result = await commitWorkPatch(
      guarded,
      op.refId,
      { doc_id: op.docId },
      { main_doc_id: op.expectedMainDocId }
    );
  } catch {
    // The file may or may not have changed (a failure between the two renames): never claim "unchanged".
    return {
      ok: false,
      status: "error",
      detail: "the library could not be saved; read it again to see whether anything changed",
    };
  }
  const object = { kind: "work" as const, id: op.refId };
  switch (result.status) {
    case "not_found":
      return { ok: false, status: "not_found", detail: "no such work" };
    case "conflict":
      return {
        ok: false,
        status: "conflict",
        detail: "the main Doc changed since you read it; read the work again, then decide",
        current: { mainDocId: result.current.main_doc_id, docIds: result.current.doc_ids },
      };
    case "noop":
      if (result.reason === "not_linked")
        return { ok: false, status: "rejected", detail: "that Doc is not attached to this work" };
      break;
    case "ok":
      break;
  }
  const work = LibraryStore.load(deps.paths).get(op.refId);
  return {
    ok: true,
    status: result.status === "ok" && changed ? "ok" : "noop",
    object,
    ...(work?.title ? { label: work.title } : {}),
    mainDocId: work?.doc_ids[0] ?? null,
    ...(notified ? {} : { warnings: ["change_notification_failed"] }),
  };
}

const DEFAULT_PAGE = 100;

export type LibraryReadOutcome =
  | {
      ok: true;
      total: number;
      matched: number;
      offset: number;
      returned: number;
      nextOffset: number | null;
      refs: LibraryRefSummary[];
      links?: [string, string][];
    }
  | { ok: true; ref: LibraryPayload["refs"][number]; bibtex: string }
  | { ok: false; status: "not_found" };

/** The Library page's own data, read through the page's own filter. Never the stored file itself. */
export async function readLibrary(
  deps: LibraryOpDeps,
  op: LibraryReadOperation
): Promise<LibraryReadOutcome> {
  const payload = await deps.readPayload();
  if (op.refId !== undefined) {
    const ref = payload.refs.find((candidate) => candidate.id === op.refId);
    return ref
      ? { ok: true, ref, bibtex: libraryRefBibtex(ref) }
      : { ok: false, status: "not_found" };
  }
  const matched = payload.refs.filter(
    (ref) =>
      libraryRefMatches(ref, op.query ?? "") || libraryRefIdentityMatches(ref, op.query ?? "")
  );
  const offset = op.offset ?? 0;
  const limit = op.limit ?? DEFAULT_PAGE;
  const slice = matched.slice(offset, offset + limit);
  const outcome: LibraryReadOutcome = {
    ok: true,
    total: payload.refs.length,
    matched: matched.length,
    offset,
    returned: slice.length,
    nextOffset: offset + slice.length < matched.length ? offset + slice.length : null,
    refs: slice.map(summarizeLibraryRef),
  };
  if (op.links)
    outcome.links = libraryLinksAmong(payload.graph, new Set(matched.map((ref) => ref.id)));
  return outcome;
}

// --------------------------------------------------------------------------- //
// Import (the Library page's import menu)
// --------------------------------------------------------------------------- //

/**
 * Identifier auto-detection for the `identifier` mode (Stage 13, smoke revision): arXiv input must be
 * EXPLICIT — the `arXiv:` prefix or an arxiv.org URL; a bare id like `2609.17036` is rejected with guidance.
 * A DOI / doi.org URL goes to the DOI path; an arXiv DataCite DOI routes to the arXiv work (never a
 * journal-DOI stub, mirroring the CLI's routeDoi semantics).
 */
export function detectIdentifier(value: string): ManualIdentifier | { error: string } | null {
  const explicit = explicitArxivId(value);
  if (explicit !== null) return { kind: "arxiv", arxiv: explicit };
  if (looksLikeArxiv(value)) {
    return {
      error: `bare arXiv id '${value.trim()}' is ambiguous — use the prefixed form arXiv:${value.trim()} (or an arxiv.org URL)`,
    };
  }
  const d = normDoi(value);
  if (d) {
    const ax = arxivFromDoi(d);
    if (ax !== null) return { kind: "arxiv", arxiv: ax };
    if (/^10\.\d{4,9}\/\S+$/.test(d)) return { kind: "doi", doi: d };
  }
  return null;
}

export interface ManualImportDeps {
  paths: LibraryPaths;
  libraryLock: AsyncLock;
  makeSources: () => MetadataSources;
}

/** What one import did, beyond the per-entry results the page shows. */
export interface ManualImportResult {
  /** Exactly the response body of `POST /api/library/works`. */
  results: ManualWorkResult[];
  /** The file changed: something was created, or an existing Work's stored object was updated. */
  changed: boolean;
  /** Ids of existing Works whose stored object was updated (blank fields filled, acquisition recomputed). */
  updated: string[];
  /** The record would have folded stored Works into one; the tool path refuses it and writes nothing. */
  rejected: boolean;
  /** What the folds did with an absorbed Work's argument graph (page path only; empty when none had one). */
  argumentGraphMerges?: ArgumentGraphMergeNote[];
}

/**
 * The locked part of `POST /api/library/works`: the whole batch runs under the library lock (single user;
 * the network seconds are the same trade lockedRebuild makes). Per-entry outcomes are results, never throws.
 * The writes are narrow (only the affected Works change in the file). The caller (the route or the tool,
 * through `LibraryOpDeps.importWorks`) adds the notification and the default PDF job.
 * `bridge: "reject"` (the tool) refuses an import that would fold or delete a stored Work.
 */
export async function runManualImport(
  deps: ManualImportDeps,
  req: ManualWorkRequest,
  options: { bridge?: "merge" | "reject" } = {}
): Promise<ManualImportResult> {
  const sources = deps.makeSources();
  const outcomes = await deps.libraryLock.run(async (): Promise<ManualAddOutcome[]> => {
    if (req.mode === "identifier") {
      const id = detectIdentifier(req.value);
      if (id === null) {
        return [
          {
            status: "error",
            error: `unrecognized identifier (expected a DOI, or an arXiv id as arXiv:<id>): ${req.value.slice(0, 120)}`,
          },
        ];
      }
      if ("error" in id) return [{ status: "error", error: id.error }];
      return [await addManualIdentifier(deps.paths, sources, id, options)];
    }
    if (req.mode === "bibcode") {
      return [await addManualBibcode(deps.paths, sources, req.bibcode, options)];
    }
    return addManualBibText(deps.paths, req.bib, options);
  });
  const results: ManualWorkResult[] = outcomes.map((o) => ({
    status: o.status,
    ...(o.ref !== undefined ? { ref: o.ref } : {}),
    ...(o.key !== undefined ? { key: o.key } : {}),
    ...(o.error !== undefined ? { error: o.error } : {}),
  }));
  const updated = outcomes
    .filter((o) => o.status === "exists" && o.changed === true && o.ref)
    .map((o) => (o.ref as { id: string }).id);
  return {
    results,
    changed: outcomes.some((o) => o.status === "created" || o.changed === true),
    updated,
    rejected: outcomes.some((o) => o.bridged !== undefined),
    argumentGraphMerges: outcomes.flatMap((o) => o.argumentGraphMerges ?? []),
  };
}

export type LibraryImportOutcome =
  | {
      ok: true;
      status: "ok" | "noop";
      mode: LibraryImportWorks["mode"];
      created: number;
      /** Entries the library already held. */
      existing: number;
      /** Ids of those existing Works that were nevertheless updated (blank fields filled, acquisition recomputed). */
      updated: string[];
      failed: number;
      results: ManualWorkResult[];
      object?: NonNullable<CopilotOperation["object"]>;
      label?: string;
      warnings?: string[];
    }
  | {
      ok: false;
      status: "error" | "rejected" | "unsupported" | "unknown";
      detail: string;
      results?: ManualWorkResult[];
    };

/**
 * The import menu's submit, as an operation. Same handler as the page (`importWorks`), same per-entry results.
 * Status `ok`: something was created or an existing Work's stored object was updated; `noop`: the file was
 * left as it was. A record that would fold stored Works into one is `rejected` and writes nothing (the page
 * still folds them; that is a known, separate behaviour).
 */
export async function applyLibraryImport(
  deps: LibraryOpDeps,
  op: LibraryImportWorks
): Promise<LibraryImportOutcome> {
  if (!deps.importWorks)
    return { ok: false, status: "unsupported", detail: "importing is not available in this host" };
  let outcome: ManualImportResult;
  try {
    outcome = await deps.importWorks(libraryImportRequest(op), { bridge: "reject" });
  } catch {
    // The batch may have saved some entries before failing: never claim "nothing changed".
    return {
      ok: false,
      status: "unknown",
      detail:
        "the import failed part-way and its outcome is not known; read the library with the identifier or title as query to see what was saved before deciding",
    };
  }
  const { results } = outcome;
  if (outcome.rejected)
    return {
      ok: false,
      status: "rejected",
      detail:
        "refused, nothing was written: the record would merge existing works into one (see the error in results). Ask the user to resolve them in the Library page.",
      results,
    };
  const created = results.filter((r) => r.status === "created").length;
  const existing = results.filter((r) => r.status === "exists").length;
  const failed = results.filter((r) => r.status === "error").length;
  if (created + existing === 0)
    return {
      ok: false,
      status: "error",
      detail: "nothing was imported; the library was not changed (see results)",
      results,
    };
  const first = results.find((r) => r.status === "created" && r.ref) ?? results.find((r) => r.ref);
  return {
    ok: true,
    status: outcome.changed ? "ok" : "noop",
    mode: op.mode,
    created,
    existing,
    updated: outcome.updated,
    failed,
    results,
    ...(first?.ref
      ? { object: { kind: "work" as const, id: first.ref.id }, label: first.ref.title }
      : {}),
    ...(failed > 0 ? { warnings: ["import_partial"] } : {}),
  };
}

// --------------------------------------------------------------------------- //
// Doc deletion (the Files tab's "delete document" dialog, `DELETE /api/paper/:doc_id`)
// --------------------------------------------------------------------------- //

/** A Work that holds the Doc, as the delete dialog's scope names them. */
export interface DocDeleteWork {
  id: string;
  title: string;
  /** The Doc is this Work's main Doc (`doc_ids[0]`). */
  main: boolean;
  /** How many Docs the Work keeps after the delete. */
  remaining: number;
}

/** What the confirmation card shows, read WITHOUT writing anything (no ensure/archive, no archive contents). */
export type DocDeleteDescription =
  | { kind: "not_found" | "bad_id" | "busy" | "orphan" }
  | { kind: "error"; detail: string }
  | {
      kind: "ready";
      docId: string;
      /** pdf: the original, metadata and workbench sidecars go; latex: the stored text, assets and annotations. */
      format: "pdf" | "latex" | "text";
      works: DocDeleteWork[];
      /** The current annotation count the dialog shows; unknown is never zero. */
      impact: DocReplaceImpact;
      /** The annotations revision the count was read at (0 when unknown). */
      rev: number;
      /** Everything the card is bound to: Works and their Doc lists, format, count, revision, content binding. */
      digest: string;
      /** Which Works hold the Doc and their Doc lists; the delete compares it again inside the library lock. */
      holders: string;
    };

/** How the shared global delete ended; the HTTP route and the tool map this to their own shapes. */
export type DocDeleteOutcome =
  | { kind: "deleted"; works: RemovedDocWork[] }
  | { kind: "bad_id" | "not_found" | "busy" | "changed" }
  | { kind: "failed"; message: string };

export interface DocDeletionPort {
  describe(docId: string): Promise<DocDeleteDescription>;
  /** The route's own handler: busy check and delete slot, physical delete, narrow library step, notification. */
  delete(docId: string, expect?: { holders: string }): Promise<DocDeleteOutcome>;
}

export type DocDeleteResult =
  | {
      ok: true;
      status: "ok";
      docId: string;
      object: NonNullable<CopilotOperation["object"]>;
      label: string;
      /** Every Work that held the Doc, with the Docs it keeps (`remaining[0]` is its main Doc now). */
      works: { id: string; title: string; remaining: string[] }[];
      detail: string;
    }
  | {
      ok: false;
      status: "not_found" | "rejected" | "error" | "expired";
      detail: string;
    };

/**
 * The delete dialog's confirm, once the real user approved: the same global delete as the route. A Doc that is gone
 * by now is `not_found` (the page closes its dialog silently; the tool does not claim a delete it did not do).
 */
export async function applyDocDelete(
  deps: LibraryOpDeps,
  docId: string,
  expect?: { holders: string }
): Promise<DocDeleteResult> {
  const port = deps.deletion;
  if (!port)
    return {
      ok: false,
      status: "error",
      detail: "deleting documents is not available in this host",
    };
  const outcome = await port.delete(docId, expect);
  switch (outcome.kind) {
    case "bad_id":
      return {
        ok: false,
        status: "rejected",
        detail: "that is not a valid Doc id; nothing was deleted",
      };
    case "not_found":
      return {
        ok: false,
        status: "not_found",
        detail: "no such Doc (it may already have been deleted); nothing was deleted by this call",
      };
    case "changed":
      return {
        ok: false,
        status: "expired",
        detail:
          "the works that list the Doc (or their Doc lists, for example the main Doc) changed after the user confirmed; nothing was deleted. Read again and ask only if it is still wanted",
      };
    case "busy":
      return {
        ok: false,
        status: "rejected",
        detail:
          "the document is busy (an upload or refresh is writing it, or it is already being deleted); nothing was deleted. Try again when the task finishes",
      };
    case "failed":
      return {
        ok: false,
        status: "error",
        detail: `the delete failed part-way (${outcome.message}). Files of the document may already be gone while the library still lists it; read the work and the library before deciding, and tell the user`,
      };
    case "deleted":
      return {
        ok: true,
        status: "ok",
        docId,
        object: { kind: "doc", id: docId },
        label: docId,
        works: outcome.works.map(({ id, title, remaining }) => ({ id, title, remaining })),
        detail:
          outcome.works.length === 0
            ? "the document was deleted; no Work listed it"
            : "the document and its annotations (current and archived) were permanently deleted and it was removed from every Work that listed it; each Work's remaining first Doc is its main Doc",
      };
  }
}

// --------------------------------------------------------------------------- //
// Acquisition (the Files tab's acquisition dialog) and the JobRunner status lines
// --------------------------------------------------------------------------- //

/** How a start request ended; the HTTP routes and the tool map this to their own shapes. */
export type ArxivStart =
  | { kind: "queued"; job: Job; reused: boolean }
  | { kind: "not_found" | "no_arxiv" | "skip" | "busy" | "not_queued" };

/** What "get LaTeX source from arXiv" would do for a Work, decided with the endpoint's own checks. */
export interface ArxivSourceTarget {
  /** attach: docless Work; append: PDF-only Work gets a new LaTeX Doc; refresh: the arXiv Doc is replaced in place. */
  kind: "attach" | "append" | "refresh";
  docId: string;
  title: string;
  docIds: string[];
}
export type ArxivSourcePlan =
  | { kind: "not_found" | "no_arxiv" | "skip" | "busy" }
  | ArxivSourceTarget;

/** The dialog's annotation-risk step for a replacement target. */
export type AnnotationRisk =
  | { state: "known"; count: number; rev: number; stale: boolean; fingerprint: string | null }
  | { state: "unknown" | "busy" | "missing" };

/** The existing JobRunner, seen by the tool through its public reads only (it never occupies a slot). */
export interface JobTable {
  list(): Job[];
  get(id: string): Job | undefined;
  waitFor(id: string): Promise<Job>;
}

export interface AcquisitionPort {
  startPdf(workId: string): ArxivStart;
  describeSource(workId: string): ArxivSourcePlan;
  startSource(workId: string): ArxivStart;
  annotationRisk(docId: string): Promise<AnnotationRisk>;
  jobs: JobTable;
  /** Longest the tool waits for its job before answering `pending` (default ten minutes). */
  waitMs?: number;
}

/** One job as the acquisition status lines show it. */
export interface JobView {
  id: string;
  kind: Job["kind"];
  /** arxiv-pdf | pdf | undefined (LaTeX attach or refresh). */
  format?: string;
  status: Job["status"];
  workId: string | null;
  createdAt: string;
  finishedAt: string | null;
  /** The newest progress message, as the status line shows it. */
  progress: string | null;
  error: string | null;
  errorCode?: string;
  /** The Doc the finished job created or refreshed. */
  docId?: string;
  /**
   * What the job's library rebuild did with argument graphs when it merged Works (ticket 06); present only then.
   * Locations are relative to the data directory. Tell the user: a graph moved to another Work, or one is left
   * on disk unshown.
   */
  argumentGraphMerges?: ArgumentGraphMergeNote[];
}

const payloadOf = (job: Job): { workId?: string; format?: string } =>
  job.payload !== null && typeof job.payload === "object" && !Array.isArray(job.payload)
    ? (job.payload as { workId?: string; format?: string })
    : {};

/** The Doc a finished job produced, from its result (arXiv PDF: `doc`, LaTeX attach: `docId`, zip: `ref`). */
function jobDocId(job: Job): string | undefined {
  const result = job.result as Record<string, unknown> | null;
  if (!result || typeof result !== "object") return undefined;
  const doc = result.doc as { doc_id?: unknown } | undefined;
  if (doc && typeof doc.doc_id === "string") return doc.doc_id;
  if (typeof result.docId === "string") return result.docId;
  return undefined;
}

/** The argument-graph notes a finished job carried in its result (parsed, so a foreign shape is dropped). */
function jobMerges(job: Job): ArgumentGraphMergeNote[] {
  if (job.status !== "done") return [];
  const raw = (job.result as { argument_graph_merges?: unknown } | null)?.argument_graph_merges;
  const parsed = ArgumentGraphMergeNoteSchema.array().safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function jobView(job: Job): JobView {
  const payload = payloadOf(job);
  const docId = job.status === "done" ? jobDocId(job) : undefined;
  const merges = jobMerges(job);
  return {
    id: job.id,
    kind: job.kind,
    ...(typeof payload.format === "string" ? { format: payload.format } : {}),
    status: job.status,
    workId: typeof payload.workId === "string" ? payload.workId : null,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    progress: job.progress.at(-1)?.message ?? null,
    error: job.error,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(docId ? { docId } : {}),
    ...(merges.length > 0 ? { argumentGraphMerges: merges } : {}),
  };
}

export type ReadJobsOutcome =
  | { ok: true; jobs: JobView[]; total: number }
  | { ok: false; status: "unsupported"; detail: string };

/** The acquisition status lines: the JobRunner's own table (newest first), optionally one work's jobs. */
export function readJobs(deps: LibraryOpDeps, op: LibraryReadJobs): ReadJobsOutcome {
  if (!deps.acquisition)
    return { ok: false, status: "unsupported", detail: "jobs are not available in this host" };
  const all = deps.acquisition.jobs
    .list()
    .filter((job) => (op.refId === undefined ? true : payloadOf(job).workId === op.refId))
    // Refresh jobs belong to no work; the status lines of a Work only show its own acquisitions.
    .filter((job) => op.refId !== undefined || job.kind !== "refresh");
  return { ok: true, total: all.length, jobs: all.slice(0, op.limit ?? 10).map(jobView) };
}

export type AcquireOutcome =
  | {
      ok: true;
      status: "ok" | "noop" | "pending";
      job: JobView;
      docId?: string;
      /** A job for this Work and format was already queued or running: its result, not a second job. */
      reused?: boolean;
      object: NonNullable<CopilotOperation["object"]>;
      label?: string;
      detail?: string;
    }
  | {
      ok: false;
      status: "not_found" | "rejected" | "error" | "unknown" | "unsupported";
      detail: string;
      job?: JobView;
    };

const DEFAULT_WAIT_MS = 600_000;
const STOP_POLL_MS = 200;

/**
 * Wait for a job the caller submitted: for its terminal state, until the host stops admitting work (Stop,
 * shutdown) or until the bound. The wait is a promise on the runner's waiters, never a job of its own, so the
 * serial queue is not held; releasing it does not cancel the job, which finishes by itself.
 */
async function awaitJob(
  port: AcquisitionPort,
  job: Job,
  admitting: () => boolean
): Promise<{ job: Job; finished: boolean }> {
  const limit = port.waitMs ?? DEFAULT_WAIT_MS;
  let poll: NodeJS.Timeout | undefined;
  let bound: NodeJS.Timeout | undefined;
  const released = new Promise<"released">((resolve) => {
    poll = setInterval(() => {
      if (!admitting()) resolve("released");
    }, STOP_POLL_MS);
    bound = setTimeout(() => resolve("released"), limit);
  });
  try {
    const outcome = await Promise.race([port.jobs.waitFor(job.id), released]);
    if (outcome === "released") return { job: port.jobs.get(job.id) ?? job, finished: false };
    return { job: outcome, finished: true };
  } finally {
    clearInterval(poll);
    clearTimeout(bound);
  }
}

/** What a submitted job came to, in the words the dialog's status line would use. */
async function settleAcquisition(
  port: AcquisitionPort,
  started: Job,
  reused: boolean,
  work: { id: string; title?: string },
  admitting: () => boolean
): Promise<AcquireOutcome> {
  const object = { kind: "work" as const, id: work.id };
  const { job, finished } = await awaitJob(port, started, admitting);
  const view = jobView(job);
  if (!finished || job.status === "queued" || job.status === "running")
    return {
      ok: true,
      status: "pending",
      job: view,
      reused,
      object,
      ...(work.title ? { label: work.title } : {}),
      detail:
        "the job was submitted and had not finished when this call ended; it continues by itself. Its outcome is in read_jobs with this job id; do not submit it again",
    };
  if (job.status !== "done")
    return {
      ok: false,
      status: "error",
      job: view,
      detail: `the job ${job.status}${job.error ? `: ${job.error}` : ""}. A failed job can leave part of its work: an arXiv LaTeX attach may already have linked the Doc when the later index rebuild failed, and a PDF whose link failed leaves an unlinked bundle in the output folder. Read the work (and read_jobs) to see what is there before deciding`,
    };
  const result = job.result as { status?: unknown } | null;
  if (result && result.status === "skipped")
    return {
      ok: false,
      status: "rejected",
      job: view,
      detail: "the Work changed while the job waited, so nothing was added",
    };
  return {
    ok: true,
    // Identical bytes already on this Work: the existing Doc is returned, nothing was created.
    status: result && result.status === "exists" ? "noop" : "ok",
    job: view,
    ...(view.docId ? { docId: view.docId } : {}),
    reused,
    object,
    ...(work.title ? { label: work.title } : {}),
  };
}

const startFailure = (
  kind: Exclude<ArxivStart["kind"], "queued">,
  what: "pdf" | "source"
): AcquireOutcome => {
  switch (kind) {
    case "not_found":
      return { ok: false, status: "not_found", detail: "no such work" };
    case "no_arxiv":
      return { ok: false, status: "rejected", detail: "this work has no arXiv id" };
    case "skip":
      return {
        ok: false,
        status: "rejected",
        detail:
          "this work already has a non-arXiv document (for example a LaTeX zip); the user has to delete it first if the arXiv version is wanted",
      };
    case "busy":
      return {
        ok: false,
        status: "rejected",
        detail: "the target document is being deleted; try again after it finishes",
      };
    default:
      return {
        ok: false,
        status: "rejected",
        detail:
          what === "pdf"
            ? "the arXiv PDF acquisition could not be queued"
            : "the arXiv fetch could not be queued (the work changed)",
      };
  }
};

export interface AcquireContext {
  /** False once the host stopped admitting work: no job is started, and a running wait is released. */
  admitting: () => boolean;
  /** Called once with the job id as soon as the job exists (recorded in the journal). */
  onSubmitted?: (jobId: string) => void;
}

/** The dialog's "fetch PDF from arXiv" submit: the shared start, then the job's own outcome. */
export async function applyAcquireArxivPdf(
  deps: LibraryOpDeps,
  refId: string,
  context: AcquireContext
): Promise<AcquireOutcome> {
  const port = deps.acquisition;
  if (!port)
    return {
      ok: false,
      status: "unsupported",
      detail: "acquisition is not available in this host",
    };
  let started: ArxivStart;
  try {
    started = port.startPdf(refId);
  } catch {
    return {
      ok: false,
      status: "unknown",
      detail:
        "the job could not be queued cleanly; read_jobs for this work shows whether one exists",
    };
  }
  if (started.kind !== "queued") return startFailure(started.kind, "pdf");
  context.onSubmitted?.(started.job.id);
  const title = LibraryStore.load(deps.paths).get(refId)?.title;
  return settleAcquisition(
    port,
    started.job,
    started.reused,
    { id: refId, title },
    context.admitting
  );
}

export type RefreshPreparation =
  | {
      ok: true;
      docId: string;
      title: string;
      impact: DocReplaceImpact;
      rev: number;
      digest: string;
    }
  | { ok: false; status: "rejected" | "not_found"; detail: string };

/** The replacement target, its annotation risk and the digest a confirmation is bound to. */
export async function prepareArxivRefresh(
  deps: LibraryOpDeps,
  refId: string,
  plan: Pick<ArxivSourceTarget, "docId" | "title" | "docIds">,
  /** More the confirmation is bound to (for example the sha256 of the file that would replace the Doc). */
  binding: Record<string, unknown> = {}
): Promise<RefreshPreparation> {
  const port = deps.acquisition as AcquisitionPort;
  const risk = await port.annotationRisk(plan.docId);
  if (risk.state === "busy")
    return {
      ok: false,
      status: "rejected",
      detail:
        "the document is busy (a task is writing or deleting it), so its annotations cannot be checked safely and the refresh cannot be submitted now; try again when the task finishes",
    };
  if (risk.state === "missing")
    return {
      ok: false,
      status: "rejected",
      detail: "the document to refresh no longer exists; read the work again",
    };
  const impact: DocReplaceImpact =
    risk.state === "known"
      ? { annotations: "known", count: risk.count }
      : { annotations: "unknown" };
  const rev = risk.state === "known" ? risk.rev : 0;
  // The Doc's own content fingerprint is part of the binding: a page refresh that replaced it ends the card.
  const bound = risk.state === "known" ? { stale: risk.stale, fingerprint: risk.fingerprint } : {};
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        refId,
        docId: plan.docId,
        impact,
        rev,
        docIds: plan.docIds,
        ...bound,
        ...binding,
      })
    )
    .digest("hex");
  return { ok: true, docId: plan.docId, title: plan.title, impact, rev, digest };
}

/** The dialog's "get LaTeX source from arXiv" submit once any needed confirmation is given. */
export async function applyAttachArxiv(
  deps: LibraryOpDeps,
  refId: string,
  context: AcquireContext
): Promise<AcquireOutcome> {
  const port = deps.acquisition;
  if (!port)
    return {
      ok: false,
      status: "unsupported",
      detail: "acquisition is not available in this host",
    };
  let started: ArxivStart;
  try {
    started = port.startSource(refId);
  } catch {
    return {
      ok: false,
      status: "unknown",
      detail:
        "the job could not be queued cleanly; read_jobs for this work shows whether one exists",
    };
  }
  if (started.kind !== "queued") return startFailure(started.kind, "source");
  context.onSubmitted?.(started.job.id);
  const title = LibraryStore.load(deps.paths).get(refId)?.title;
  return settleAcquisition(
    port,
    started.job,
    started.reused,
    { id: refId, title },
    context.admitting
  );
}
