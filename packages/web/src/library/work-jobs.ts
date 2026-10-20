import { useCallback, useEffect, useReducer, useRef } from "react";
import { DOCUMENT_BUSY, isJobFormat, JOB_FORMAT, type Job, jobTarget } from "@argelanderspace/contracts";
import { acquireArxivPdf, attachArxiv, type StartResult, uploadLatexZip, uploadPdf } from "../api/library";
import { type FetchAnnotationsResult, fetchAnnotations } from "../api/annotations";
import { fetchPdfAnnotationCount } from "../api/pdf-annotations";
import { fetchTextDeleteImpact } from "../api/text-docs";
import { onJobEvent } from "../api/ws";
import i18n from "../i18n";
import { dismissMergeNotice, ingestMergeNotice, type MergeNotice, useMergeNotices } from "./merge-notices";

export type { MergeNotice };
export { jobMergeNotes } from "./merge-notices";

/*
 * The jobs a Work's full-text tab follows (ticket 48): the LaTeX zip upload, the local PDF upload, the arXiv source
 * fetch and the arXiv PDF acquisition. One WS subscription feeds every kind; each kind is a policy table read by one
 * pure reducer, so the four flows differ only where they always did (hello adoption, dismissal, error wording).
 */

export type { StartResult };

export const JOB_STATUS_PHASE: Record<Job["status"], number> = {
  queued: 0,
  running: 1,
  done: 2,
  failed: 2,
  interrupted: 2,
};

export function isJobSnapshotRegression(previous: Job | undefined, next: Job): boolean {
  return previous !== undefined && JOB_STATUS_PHASE[next.status] < JOB_STATUS_PHASE[previous.status];
}

const isActive = (job: Job): boolean => job.status === "queued" || job.status === "running";
const isFailure = (job: Job): boolean => job.status === "failed" || job.status === "interrupted";
const isTerminal = (job: Job): boolean => job.status === "done" || isFailure(job);

// ---- kinds ---------------------------------------------------------------- //

export interface WorkJobKind<Extra = undefined, Args extends unknown[] = []> {
  /** Which job frames belong to this kind (job kind + `payload.format`). */
  match(job: Job): boolean;
  /** Submit the job for a Work. Must call the API synchronously (no await before the request). */
  start(workId: string, ...args: Args): Promise<StartResult>;
  /** The error line for a failed/interrupted job of this kind. */
  failMessage(job: Job | null): string;
  /** The error line for a submission the server did not accept. */
  rejectMessage(status: number, detail: string): string;
  /** Kind-specific detail kept with a failure (arXiv source: the server's machine-readable `errorCode`). */
  extra?(job: Job): Extra;
  /** hello replay of an untracked failure: `once` per Work, or `every` one (the last wins). */
  adopt: "once" | "every";
  /** `none`: the error cannot be dismissed; `flag`: until the next failure; `per-job`: remembered per failed job id. */
  dismiss: "none" | "flag" | "per-job";
  /** Whether a finished job also clears a standing error line. */
  doneClearsError: boolean;
  /** Whether a POST whose job already failed (the WS frame beat the response) still counts as an accepted submit. */
  fastFailureAccepted: boolean;
  /** At most one submission in flight per Work, released by its answer or by the job's terminal frame. */
  oneSubmissionPerWork: boolean;
}

const zipFailMessage = (job: Job | null): string =>
  job?.error
    ? i18n.t("library.detail.upload.failed", { error: job.error })
    : i18n.t("library.detail.upload.failedGeneric");

const arxivFailMessage = (job: Job | null): string =>
  job?.error
    ? i18n.t("library.detail.arxiv.failed", { error: job.error })
    : i18n.t("library.detail.arxiv.failedGeneric");

/**
 * A busy document (DocMutationRegistry): the server's 409 with the literal detail "document busy". Other 409s (an
 * arXiv source the Work cannot take, a Work that changed, a job that could not be queued) are ordinary failures.
 */
const isDocumentBusy = (status: number, detail: string): boolean => status === 409 && detail === DOCUMENT_BUSY;

// The API functions are referenced inside each start so a partially mocked api module still loads.
const zip: WorkJobKind<undefined, [File]> = {
  match: (job) => job.kind === "upload" && !isJobFormat(jobTarget(job).format),
  start: (workId, file) => uploadLatexZip(workId, file),
  failMessage: zipFailMessage,
  rejectMessage: (status, detail) => (isDocumentBusy(status, detail) ? i18n.t("library.detail.upload.busy") : zipFailMessage(null)),
  adopt: "once",
  dismiss: "none",
  doneClearsError: false,
  fastFailureAccepted: true,
  oneSubmissionPerWork: false,
};

const pdf: WorkJobKind<undefined, [File]> = {
  match: (job) => job.kind === "upload" && jobTarget(job).format === JOB_FORMAT.pdf,
  start: (workId, file) => uploadPdf(workId, file),
  failMessage: (job) => job?.error ?? i18n.t("library.detail.pdfUpload.failedGeneric"),
  rejectMessage: (status, detail) => (status === 409 ? i18n.t("library.detail.pdfUpload.busy") : detail),
  adopt: "once",
  dismiss: "flag",
  doneClearsError: true,
  fastFailureAccepted: false,
  oneSubmissionPerWork: true,
};

const arxiv: WorkJobKind<string | null> = {
  match: (job) => job.kind === "ingest",
  start: (workId) => attachArxiv(workId),
  failMessage: arxivFailMessage,
  rejectMessage: (status, detail) =>
    isDocumentBusy(status, detail) ? i18n.t("library.detail.arxiv.busy") : arxivFailMessage(null),
  extra: (job) => job.errorCode ?? null,
  adopt: "once",
  dismiss: "none",
  doneClearsError: false,
  fastFailureAccepted: true,
  oneSubmissionPerWork: false,
};

const arxivPdf: WorkJobKind = {
  match: (job) => job.kind === "upload" && jobTarget(job).format === JOB_FORMAT.arxivPdf,
  start: (workId) => acquireArxivPdf(workId),
  failMessage: (job) => job?.error ?? i18n.t("library.detail.arxivPdf.failedGeneric"),
  rejectMessage: (status, detail) =>
    i18n.t(isDocumentBusy(status, detail) ? "library.detail.arxivPdf.busy" : "library.detail.arxivPdf.submitFailed"),
  adopt: "every",
  dismiss: "per-job",
  doneClearsError: true,
  fastFailureAccepted: true,
  oneSubmissionPerWork: false,
};

export const WORK_JOB_KINDS = { zip, pdf, arxiv, arxivPdf };
export type WorkJobName = keyof typeof WORK_JOB_KINDS;
const WORK_JOB_NAMES = Object.keys(WORK_JOB_KINDS) as WorkJobName[];
type KindExtra<N extends WorkJobName> = (typeof WORK_JOB_KINDS)[N] extends WorkJobKind<infer E, infer _A> ? E : never;
type KindArgs<N extends WorkJobName> = (typeof WORK_JOB_KINDS)[N] extends WorkJobKind<infer _E, infer A> ? A : never;

// ---- the per-kind reducer --------------------------------------------------- //

export interface WorkJobError<Extra = unknown> {
  message: string;
  extra?: Extra;
  /** The failed job, or null when the submission itself was rejected. */
  jobId: string | null;
}

export interface WorkJobState<Extra = unknown> {
  /** The tracked queued/running job; null once a terminal state was handled. */
  job: Job | null;
  error: WorkJobError<Extra> | null;
  dismissed: boolean;
  /** `adopt: "once"`: a replayed failure was already adopted for this Work. */
  adopted: boolean;
  /** A local submission is in flight (for `oneSubmissionPerWork`, also one this Work started before a switch). */
  submitting: boolean;
  /** `dismiss: "per-job"`: failed job ids the user dismissed; kept across Work switches. */
  dismissedJobs: ReadonlySet<string>;
}

export type WorkJobAction =
  /** A WS frame for this Work and kind that is not a regressing snapshot. */
  | { type: "event"; job: Job }
  /**
   * Handle the tracked job's terminal state. It is a separate step after the render that showed it (as the terminal
   * effects always were): until then the settled job still occupies the slot, so another frame of the same batch
   * (a hello replay lists every job) is not adopted over it.
   */
  | { type: "settle" }
  | { type: "submit" }
  /** The POST answered 202; `seen` is the newest WS snapshot of that job, if one beat the answer. */
  | { type: "accepted"; job: Job; seen?: Job }
  | { type: "rejected"; status: number; detail: string }
  | { type: "dismiss" }
  /** The detail now shows another Work. */
  | { type: "reset"; submitting: boolean };

export function initialWorkJobState<Extra = unknown>(): WorkJobState<Extra> {
  return {
    job: null,
    error: null,
    dismissed: false,
    adopted: false,
    submitting: false,
    dismissedJobs: new Set(),
  };
}

type Policy<Extra> = Pick<
  WorkJobKind<Extra, never[]>,
  "failMessage" | "rejectMessage" | "extra" | "adopt" | "dismiss" | "doneClearsError"
>;

/**
 * Write a job failure. `resetFlag` is false only for the fast failure seen at submit time, which (as before) leaves
 * a PDF upload's dismissal flag alone; every other failure shows the new error expanded.
 */
function writeFailure<E>(kind: Policy<E>, state: WorkJobState<E>, job: Job, resetFlag = true): WorkJobState<E> {
  const error: WorkJobError<E> = { message: kind.failMessage(job), jobId: job.id };
  if (kind.extra) error.extra = kind.extra(job);
  const dismissed =
    kind.dismiss === "per-job"
      ? state.dismissedJobs.has(job.id)
      : kind.dismiss === "flag" && resetFlag
        ? false
        : state.dismissed;
  return { ...state, error, dismissed };
}

export function reduceWorkJob<E>(kind: Policy<E>, state: WorkJobState<E>, action: WorkJobAction): WorkJobState<E> {
  switch (action.type) {
    case "event": {
      const { job } = action;
      if (state.job) return state.job.id === job.id ? { ...state, job } : state;
      if (isActive(job)) return { ...state, job };
      if (!isFailure(job)) return state;
      // An untracked terminal failure, typically a hello replay of the persisted job table (newest first).
      if (kind.adopt === "every") return writeFailure(kind, state, job);
      return state.adopted ? state : writeFailure(kind, { ...state, adopted: true }, job);
    }
    case "settle": {
      const { job } = state;
      if (!job || !isTerminal(job)) return state;
      if (isFailure(job)) return writeFailure(kind, { ...state, job: null }, job);
      return kind.doneClearsError ? { ...state, job: null, error: null, dismissed: false } : { ...state, job: null };
    }
    case "submit":
      return { ...state, submitting: true, error: null, dismissed: false };
    case "accepted": {
      const settled = { ...state, submitting: false };
      const { seen } = action;
      // The terminal frame beat the fetch response: surface it, don't resurrect the stale 202 body.
      if (seen && isFailure(seen)) return writeFailure(kind, settled, seen, false);
      if (seen?.status === "done") return settled; // the caller reloads the Library
      return { ...settled, job: seen ?? action.job }; // prefer the newer event snapshot
    }
    case "rejected":
      return {
        ...state,
        submitting: false,
        error: { message: kind.rejectMessage(action.status, action.detail), jobId: null },
        dismissed: kind.dismiss === "none" ? state.dismissed : false,
      };
    case "dismiss":
      if (kind.dismiss === "none") return state;
      if (kind.dismiss === "per-job" && state.error?.jobId) {
        return { ...state, dismissed: true, dismissedJobs: new Set(state.dismissedJobs).add(state.error.jobId) };
      }
      return { ...state, dismissed: true };
    case "reset":
      return {
        ...state,
        job: null,
        error: null,
        dismissed: false,
        adopted: false,
        submitting: action.submitting,
      };
  }
}

// ---- the hook --------------------------------------------------------------- //

export interface WorkSession {
  workId: string;
  generation: number;
}

export interface WorkJobHandle<Extra, Args extends unknown[]> {
  job: Job | null;
  error: { message: string; extra?: Extra } | null;
  submitting: boolean;
  dismissed: boolean;
  dismiss(): void;
  /** Submit for the current Work; resolves true when the server accepted the job (false for a stale answer). */
  start(...args: Args): Promise<boolean>;
}

export interface WorkJobs {
  kinds<N extends WorkJobName>(name: N): WorkJobHandle<KindExtra<N>, KindArgs<N>>;
  /** Dismissible notices of tasks started here whose rebuild moved or left behind an argument graph. */
  mergeNotices: readonly MergeNotice[];
  dismissMergeNotice(jobId: string): void;
  /** Newest WS snapshot per job id for this Work (shared by every kind and the submit paths). */
  seen: ReadonlyMap<string, Job>;
  /** The Work session; a response whose session is no longer current is dropped. */
  session: { current(): WorkSession; isCurrent(session: WorkSession): boolean };
}

type JobsState = Record<WorkJobName, WorkJobState>;
type JobsAction =
  | (Exclude<WorkJobAction, { type: "reset" }> & { name: WorkJobName })
  | { type: "reset"; submitting: Record<WorkJobName, boolean> };

function reduceJobs(state: JobsState, action: JobsAction): JobsState {
  if (action.type === "reset") {
    const next = { ...state };
    for (const name of WORK_JOB_NAMES) {
      next[name] = reduceWorkJob(WORK_JOB_KINDS[name] as Policy<unknown>, state[name], {
        type: "reset",
        submitting: action.submitting[name],
      });
    }
    return next;
  }
  const { name, ...kindAction } = action;
  const next = reduceWorkJob(WORK_JOB_KINDS[name] as Policy<unknown>, state[name], kindAction as WorkJobAction);
  return next === state[name] ? state : { ...state, [name]: next };
}

function initialJobs(): JobsState {
  return Object.fromEntries(WORK_JOB_NAMES.map((name) => [name, initialWorkJobState()])) as JobsState;
}

/**
 * Track this Work's jobs. ONE `onJobEvent` subscription routes by kind; `hello` replays (reconnect / refresh) adopt a
 * queued/running job even without local state, so tracking resumes after F5.
 */
export function useWorkJobs(workId: string, options: { onReload?: () => void } = {}): WorkJobs {
  const { onReload } = options;
  const session = useRef<WorkSession>({ workId, generation: 0 });
  if (session.current.workId !== workId) {
    session.current = { workId, generation: session.current.generation + 1 };
  }
  const seen = useRef(new Map<string, Job>());
  // Work ids with a submission in flight, per kind that allows one per Work (any Work, not only the shown one).
  const submissions = useRef(
    Object.fromEntries(WORK_JOB_NAMES.map((name) => [name, new Set<string>()])) as Record<WorkJobName, Set<string>>
  );
  const [state, dispatch] = useReducer(reduceJobs, undefined, initialJobs);
  // Merge notes come from the finished task records (module-level store, see merge-notices.ts), not from this hook.
  const allNotices = useMergeNotices();

  // Switching Works drops the other Work's job state; a PDF submission this Work still has in flight stays busy.
  useEffect(() => {
    const submitting = Object.fromEntries(
      WORK_JOB_NAMES.map((name) => [name, submissions.current[name].has(workId)])
    ) as Record<WorkJobName, boolean>;
    dispatch({ type: "reset", submitting });
  }, [workId]);

  useEffect(
    () =>
      onJobEvent((job) => {
        const targetWorkId = jobTarget(job).workId || null;
        if (targetWorkId && isTerminal(job)) {
          for (const name of WORK_JOB_NAMES) {
            if (WORK_JOB_KINDS[name].oneSubmissionPerWork && WORK_JOB_KINDS[name].match(job)) {
              submissions.current[name].delete(targetWorkId);
            }
          }
        }
        ingestMergeNotice(job);
        if (targetWorkId !== workId) return;
        const previous = seen.current.get(job.id);
        if (isJobSnapshotRegression(previous, job)) return;
        seen.current.set(job.id, job);
        const name = WORK_JOB_NAMES.find((candidate) => WORK_JOB_KINDS[candidate].match(job));
        if (name) dispatch({ type: "event", name, job });
      }),
    [workId]
  );

  // React to the terminal states (kept out of the subscriber, which must stay pure): one effect for every kind.
  useEffect(() => {
    for (const name of WORK_JOB_NAMES) {
      const { job } = state[name];
      if (!job || !isTerminal(job)) continue;
      dispatch({ type: "settle", name });
      if (job.status === "done") onReload?.();
    }
  }, [state, onReload]);

  useEffect(
    () => () => {
      session.current = { workId: session.current.workId, generation: session.current.generation + 1 };
    },
    []
  );

  const isCurrent = useCallback(
    (s: WorkSession): boolean =>
      s.workId === session.current.workId && s.generation === session.current.generation,
    []
  );

  const start = useCallback(
    async (name: WorkJobName, args: unknown[]): Promise<boolean> => {
      const kind = WORK_JOB_KINDS[name] as WorkJobKind<unknown, unknown[]>;
      const s = session.current;
      const guard = kind.oneSubmissionPerWork ? submissions.current[name] : null;
      if (guard?.has(s.workId)) return false;
      guard?.add(s.workId);
      dispatch({ type: "submit", name });
      let result: StartResult;
      try {
        result = await kind.start(s.workId, ...args);
      } catch (error) {
        result = { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
      }
      if (!isCurrent(s)) {
        if (!result.ok) guard?.delete(s.workId);
        return false;
      }
      if (!result.ok) {
        guard?.delete(s.workId);
        dispatch({ type: "rejected", name, status: result.status, detail: result.detail });
        return false;
      }
      const seenJob = seen.current.get(result.job.id);
      const failedFast = seenJob !== undefined && isFailure(seenJob);
      if (failedFast || seenJob?.status === "done") guard?.delete(s.workId);
      dispatch({ type: "accepted", name, job: result.job, seen: seenJob });
      if (seenJob?.status === "done") onReload?.();
      return !(failedFast && !kind.fastFailureAccepted);
    },
    [isCurrent, onReload]
  );

  const kinds = <N extends WorkJobName>(name: N): WorkJobHandle<KindExtra<N>, KindArgs<N>> => {
    const kindState = state[name];
    return {
      job: kindState.job,
      error: kindState.error && {
        message: kindState.error.message,
        ...("extra" in kindState.error ? { extra: kindState.error.extra as KindExtra<N> } : {}),
      },
      submitting: kindState.submitting,
      dismissed: kindState.dismissed,
      dismiss: () => dispatch({ type: "dismiss", name }),
      start: (...args: KindArgs<N>) => start(name, args),
    };
  };

  return {
    kinds,
    mergeNotices: allNotices.filter((n) => n.workId === workId),
    dismissMergeNotice,
    seen: seen.current,
    session: { current: () => session.current, isCurrent },
  };
}

// ---- acquisition dialog risk ------------------------------------------------- //

export type AcquisitionMethod = "pdf" | "arxiv" | "upload" | "pdf-upload";

export type AcquisitionRisk =
  | { state: "new" }
  | { state: "resolving" }
  | { state: "loading" }
  | { state: "known"; count: number }
  | { state: "unknown" }
  | { state: "busy"; source: "annotations" | "job" }
  | { state: "missing" }
  | { state: "unavailable" };

export interface AcquisitionFlow {
  id: number;
  riskVersion: number;
  method: AcquisitionMethod;
  targetDocId: string | null;
  risk: AcquisitionRisk;
  file: File | null;
  fileError: string | null;
  pdfWarningAccepted: boolean;
  busy: boolean;
  error: string | null;
}

export type AcquisitionRiskEvent =
  /** The Work's Doc list or arXiv target changed while the dialog is open. */
  | { type: "payload"; versions: readonly string[]; arxivTarget: string | null }
  /** A fresh payload for the same Work (a replacement may have happened in place). */
  | { type: "refresh"; versions: readonly string[] }
  /** The upload target Doc id for the Work was derived. */
  | { type: "target-resolved"; flowId: number; expectedDocId: string; versions: readonly string[] }
  | { type: "target-failed"; flowId: number }
  /** The replacement target's annotation read answered for the flow that asked. */
  | {
      type: "annotations";
      flow: Pick<AcquisitionFlow, "id" | "method" | "targetDocId">;
      result: FetchAnnotationsResult;
    }
  /** Whether the zip upload / arXiv source job of this Work is queued or running. */
  | { type: "jobs"; uploadActive: boolean; arxivActive: boolean };

export function reduceAcquisitionRisk(
  flow: AcquisitionFlow | null,
  event: AcquisitionRiskEvent
): AcquisitionFlow | null {
  if (!flow) return flow;
  switch (event.type) {
    case "payload": {
      // Never retain a count for a disappeared target or keep treating a newly-existing target as a first addition.
      const { versions, arxivTarget } = event;
      if (flow.targetDocId && !versions.includes(flow.targetDocId)) {
        return { ...flow, riskVersion: flow.riskVersion + 1, risk: { state: "missing" } };
      }
      if (flow.method === "arxiv") {
        const nextTarget = arxivTarget && versions.includes(arxivTarget) ? arxivTarget : null;
        if (nextTarget !== flow.targetDocId) {
          return {
            ...flow,
            riskVersion: flow.riskVersion + 1,
            targetDocId: nextTarget,
            risk: versions.length === 0 ? { state: "new" } : { state: "unavailable" },
          };
        }
      } else if (flow.method === "upload" && flow.targetDocId === null && versions.length > 0) {
        return { ...flow, riskVersion: flow.riskVersion + 1, risk: { state: "unavailable" } };
      }
      return flow;
    }
    case "refresh":
      return flow.targetDocId && event.versions.includes(flow.targetDocId)
        ? { ...flow, riskVersion: flow.riskVersion + 1, risk: { state: "loading" } }
        : flow;
    case "target-resolved": {
      if (flow.id !== event.flowId || flow.method !== "upload" || flow.risk.state !== "resolving") return flow;
      const targetDocId = event.versions.includes(event.expectedDocId) ? event.expectedDocId : null;
      return {
        ...flow,
        riskVersion: flow.riskVersion + 1,
        targetDocId,
        risk: targetDocId ? { state: "loading" } : { state: "new" },
      };
    }
    case "target-failed":
      return flow.id === event.flowId && flow.method === "upload" && flow.risk.state === "resolving"
        ? { ...flow, riskVersion: flow.riskVersion + 1, risk: { state: "unavailable" } }
        : flow;
    case "annotations": {
      const asked = event.flow;
      if (
        flow.id !== asked.id ||
        flow.method !== asked.method ||
        flow.targetDocId !== asked.targetDocId ||
        flow.risk.state !== "loading"
      ) {
        return flow;
      }
      const { result } = event;
      if (result.ok) return { ...flow, risk: { state: "known", count: result.file.annotations.length } };
      if (result.status === 409) return { ...flow, risk: { state: "busy", source: "annotations" } };
      if (result.missing) return { ...flow, risk: { state: "missing" } };
      return { ...flow, risk: { state: "unknown" } };
    }
    case "jobs": {
      // A known queued/running job targeting this Work conservatively blocks a replacement. Once that job settles,
      // take a fresh annotation snapshot.
      if (!flow.targetDocId) return flow;
      const active = flow.method === "upload" ? event.uploadActive : event.arxivActive;
      if (active && !(flow.risk.state === "busy" && flow.risk.source === "job")) {
        return { ...flow, riskVersion: flow.riskVersion + 1, risk: { state: "busy", source: "job" } };
      }
      if (!active && flow.risk.state === "busy" && flow.risk.source === "job") {
        return { ...flow, riskVersion: flow.riskVersion + 1, risk: { state: "loading" } };
      }
      return flow;
    }
  }
}

// ---- Doc delete count ------------------------------------------------------- //

export type DeleteCount = { state: "known"; value: number } | { state: "unknown" };

/**
 * The annotation count the delete dialog states. A count that cannot be read is unknown, never 0. A text Doc that was
 * never generated has no reading text to count annotations against: the server says whether that is a known zero or
 * unknown (the same answer the Copilot's confirmation card gets).
 */
export async function loadDeleteCount(docId: string, kind: "pdf" | "text" | "other"): Promise<DeleteCount> {
  const unknown: DeleteCount = { state: "unknown" };
  const countAnnotations = async (): Promise<DeleteCount> => {
    const result = await fetchAnnotations(docId);
    return result.ok ? { state: "known", value: result.file.annotations.length } : unknown;
  };
  if (kind === "pdf") {
    const result = await fetchPdfAnnotationCount(docId);
    return result.ok ? { state: "known", value: result.count } : unknown;
  }
  if (kind === "text") {
    const impact = await fetchTextDeleteImpact(docId);
    if (!impact.ok) return unknown;
    if (impact.generated) return countAnnotations();
    return impact.annotations.state === "known" ? { state: "known", value: impact.annotations.count } : unknown;
  }
  return countAnnotations();
}
