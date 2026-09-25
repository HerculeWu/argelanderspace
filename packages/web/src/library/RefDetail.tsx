import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Job } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";
import {
  acquireArxivPdf,
  attachArxiv,
  type DocProvenance,
  fetchDocProvenance,
  patchRef,
  uploadLatexZip,
  uploadPdf,
} from "../api/library";
import { deletePaperDoc, fetchAnnotations } from "../api/annotations";
import { fetchPdfAnnotationCount } from "../api/pdf-annotations";
import { onJobEvent } from "../api/ws";
import i18n from "../i18n";
import { ActionButton, Badge, Dialog, InlineMessage, Tabs } from "../ui";
import { cgKfmt } from "../graph/graphPhysics";
import { AbstractHtml } from "../lib/abstract";
import { arxivAcquisitionDocId, uploadAcquisitionDocId } from "./acquisitionTargets";
import type { GraphNode, LibraryRef } from "./types";

function Tag({ children }: { children: string }) {
  return <span className="tag mono">{children.replace(/^#/, "")}</span>;
}

const RESOLVED_LABEL: Record<string, string> = {
  ads: "NASA ADS",
  crossref: "Crossref",
  openalex: "OpenAlex",
};

function bibtexOf(r: LibraryRef): string {
  return (
    "@" +
    (r.type === "conf" ? "inproceedings" : "article") +
    "{" +
    r.cite +
    ",\n" +
    "  title   = {" +
    r.title +
    "},\n" +
    "  author  = {" +
    r.authors.replace(/ & /g, " and ").replace(/ et al\./, " and others") +
    "},\n" +
    "  journal = {" +
    r.venue +
    "},\n  year    = {" +
    r.year +
    "}\n}"
  );
}

const TABS = ["meta", "info", "bib", "notes", "files"] as const;
type DetailTab = (typeof TABS)[number];
type AcquisitionMethod = "pdf" | "arxiv" | "upload" | "pdf-upload";

type AcquisitionRisk =
  | { state: "new" }
  | { state: "resolving" }
  | { state: "loading" }
  | { state: "known"; count: number }
  | { state: "unknown" }
  | { state: "busy"; source: "annotations" | "job" }
  | { state: "missing" }
  | { state: "unavailable" };

interface AcquisitionFlow {
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

function acquisitionFileProblem(file: File | null, method: AcquisitionMethod): "required" | "zip" | "pdf" | "empty" | "tooLarge" | null {
  if (!file) return "required";
  if (file.size === 0) return "empty";
  if (method === "pdf-upload") {
    if (!file.name.toLowerCase().endsWith(".pdf")) return "pdf";
    if (file.size > 50 * 1024 * 1024) return "tooLarge";
  } else if (!file.name.toLowerCase().endsWith(".zip")) return "zip";
  return null;
}

function acquisitionFileError(problem: NonNullable<ReturnType<typeof acquisitionFileProblem>>): string {
  if (problem === "pdf") return i18n.t("library.detail.pdfUpload.extension");
  if (problem === "tooLarge") return i18n.t("library.detail.pdfUpload.tooLarge");
  if (problem === "empty") return i18n.t("library.detail.acquisition.fileEmpty");
  return i18n.t(problem === "zip" ? "library.detail.acquisition.fileInvalidZip" : "library.detail.acquisition.fileRequired");
}

// Tab labels resolve at render time; keys must stay in sync with TABS.
const TAB_LABEL_KEYS = {
  meta: "library.detail.tabs.meta",
  info: "library.detail.tabs.info",
  bib: "library.detail.tabs.bib",
  notes: "library.detail.tabs.notes",
  files: "library.detail.tabs.files",
} as const;

/** The job's target work id rides in `payload.workId` (server app.ts). */
function jobWorkId(job: Job): string | null {
  const p = job.payload;
  if (p === null || p === undefined || typeof p !== "object" || Array.isArray(p)) return null;
  const w = (p as Record<string, unknown>).workId;
  return typeof w === "string" && w !== "" ? w : null;
}

const JOB_STATUS_PHASE: Record<Job["status"], number> = {
  queued: 0,
  running: 1,
  done: 2,
  failed: 2,
  interrupted: 2,
};

function isJobSnapshotRegression(previous: Job | undefined, next: Job): boolean {
  return previous !== undefined && JOB_STATUS_PHASE[next.status] < JOB_STATUS_PHASE[previous.status];
}

export function RefDetail({
  r,
  node,
  onClose,
  onOpenDoc,
  onReload,
  onDocDeleted,
  onBeforeDocDelete,
  explore,
}: {
  r: LibraryRef;
  node: GraphNode | null;
  onClose: () => void;
  onOpenDoc: (docId?: string) => void;
  onReload?: () => void;
  /** Stage 8 §8: a doc was physically deleted; `remaining` is this work's
   *  doc_ids after the deletion (its [0] is the new main). The LibraryView
   *  wires this to the workspace's three-state transition. */
  onDocDeleted?: (docId: string, remaining: string[]) => void;
  onBeforeDocDelete?: (docId: string) => boolean;
  /**
   * Stage 14 (D1/D9): the "explore related papers" entry — enabled only with
   * a usable ADS bibcode AND a live backend (no demo/fixture exploration).
   */
  explore?: { bibcode: string | null; live: boolean; onExplore: (bibcode: string) => void };
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<DetailTab>("meta");
  const [copyStatus, setCopyStatus] = useState<{
    target: "cite" | "bib";
    state: "copied" | "failed";
  } | null>(null);
  const copyStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestId = useRef(0);
  const activeWorkId = useRef(r.id);
  activeWorkId.current = r.id;
  const workSession = useRef({ workId: r.id, generation: 0 });
  if (workSession.current.workId !== r.id) {
    workSession.current = {
      workId: r.id,
      generation: workSession.current.generation + 1,
    };
  }
  const isCurrentWorkSession = (session: { workId: string; generation: number }): boolean =>
    session.workId === workSession.current.workId &&
    session.generation === workSession.current.generation;
  // async upload (202 + job): progress arrives over /ws; `uploadJob` is the
  // queued/running job, null once a terminal state was handled. The ref mirror
  // lets the WS subscriber see the latest value; `seenJobs` remembers every
  // event snapshot so a job.* frame that beats the upload POST's fetch
  // response (fast failure) is never overwritten by the stale 202 body.
  const [uploadJob, setUploadJobState] = useState<Job | null>(null);
  const uploadJobRef = useRef<Job | null>(null);
  const seenJobs = useRef(new Map<string, Job>());
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  const [pdfUploadJob, setPdfUploadJobState] = useState<Job | null>(null);
  const pdfUploadJobRef = useRef<Job | null>(null);
  const pdfUploadSubmissions = useRef(new Set<string>());
  const setPdfUploadJob = (job: Job | null) => { pdfUploadJobRef.current = job; setPdfUploadJobState(job); };
  const [pdfUploadError, setPdfUploadError] = useState<string | null>(null);
  const [pdfUploadBusy, setPdfUploadBusy] = useState(false);
  const [pdfErrorDismissed, setPdfErrorDismissed] = useState(false);
  const adoptedPdfFailure = useRef(false);
  // Stage 15: this work's arXiv fetch job (kind "ingest", payload.workId) —
  // the same adoption/race rules as the upload job. `arxivErrCode` carries
  // the server's machine-readable failure class ("arxiv_pdf_only" → the
  // bilingual PDF-only guidance).
  const [arxivJob, setArxivJobState] = useState<Job | null>(null);
  const arxivJobRef = useRef<Job | null>(null);
  const [arxivErr, setArxivErr] = useState<string | null>(null);
  const [arxivErrCode, setArxivErrCode] = useState<string | null>(null);
  const [arxivPdfJob, setArxivPdfJob] = useState<Job | null>(null);
  const [arxivPdfError, setArxivPdfError] = useState<string | null>(null);
  const [arxivPdfErrorDismissed, setArxivPdfErrorDismissed] = useState(false);
  const [arxivPdfFailureJobId, setArxivPdfFailureJobId] = useState<string | null>(null);
  const dismissedArxivPdfFailures = useRef(new Set<string>());
  const arxivPdfJobRef = useRef<Job | null>(null);
  const [settingMain, setSettingMain] = useState(false);
  const [mainErr, setMainErr] = useState<string | null>(null);
  const [acquisition, setAcquisition] = useState<AcquisitionFlow | null>(null);
  const acquisitionFlowSequence = useRef(0);
  const submittingAcquisitionFlows = useRef(new Set<number>());
  const riskPayload = useRef(r);
  const [expectedUploadTarget, setExpectedUploadTarget] = useState<string | null>(null);
  const [docProvenance, setDocProvenance] = useState<
    Record<string, DocProvenance | "loading">
  >({});
  const provenanceGeneration = useRef(0);
  // Stage 8 §8 document delete: the doc id pending confirmation, plus the
  // in-flight DELETE state. A busy 409 keeps the dialog open with its message
  // (the ingest task ends on its own; the user retries).
  const [delDoc, setDelDoc] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const delBusyRef = useRef(false);
  const delRequestId = useRef(0);
  const [delErr, setDelErr] = useState<{ kind: "busy" | "error"; detail: string } | null>(null);
  const cited = node?.c ?? r.citedBy;

  // All reader docs of this work (Stage 7 MS3: parallel versions). The main
  // doc is the payload's doc_id (= doc_ids[0]); older versions stay listed.
  const versions = r.doc_ids ?? (r.doc_id ? [r.doc_id] : []);
  const mainDoc = r.doc_id ?? versions[0];
  const arxivTarget = arxivAcquisitionDocId(r.arxiv_id);
  const arxivAllowed = arxivTarget !== null;
  const arxivLatexUpdatesExisting = Boolean(mainDoc) && (!arxivTarget || versions.includes(arxivTarget));
  const arxivLatexAllowed =
    arxivTarget !== null &&
    (versions.length === 0 ||
      versions.includes(arxivTarget) ||
      versions.every((docId) => docProvenance[docId] === "pdf" || docProvenance[docId] === "arxiv-pdf"));
  const versionsKey = versions.join("\u0000");

  useEffect(() => {
    let current = true;
    setExpectedUploadTarget(null);
    void uploadAcquisitionDocId(r.id)
      .then((docId) => {
        if (current) setExpectedUploadTarget(docId);
      })
      .catch(() => {
        if (current) setExpectedUploadTarget(null);
      });
    return () => {
      current = false;
    };
  }, [r.id]);

  // If the current Work payload changes while a risk dialog is open, never
  // retain a count for a disappeared target or keep treating a newly-existing
  // target as a first addition.
  useEffect(() => {
    setAcquisition((current) => {
      if (!current) return current;
      if (current.targetDocId && !versions.includes(current.targetDocId)) {
        return {
          ...current,
          riskVersion: current.riskVersion + 1,
          risk: { state: "missing" },
        };
      }
      if (current.method === "arxiv") {
        const nextTarget = arxivTarget && versions.includes(arxivTarget) ? arxivTarget : null;
        if (nextTarget !== current.targetDocId) {
          return {
            ...current,
            riskVersion: current.riskVersion + 1,
            targetDocId: nextTarget,
            risk: versions.length === 0 ? { state: "new" } : { state: "unavailable" },
          };
        }
      } else if (current.method === "upload" && current.targetDocId === null && versions.length > 0) {
        return {
          ...current,
          riskVersion: current.riskVersion + 1,
          risk: { state: "unavailable" },
        };
      }
      return current;
    });
  }, [arxivTarget, versionsKey]);

  // Any fresh payload for the same Work may reflect an in-place replacement
  // even when doc_ids is unchanged. A replacement risk snapshot is therefore
  // invalidated and fetched again instead of retaining prior consent.
  useEffect(() => {
    if (riskPayload.current === r) return;
    riskPayload.current = r;
    setAcquisition((current) =>
      current?.targetDocId && versions.includes(current.targetDocId)
        ? {
            ...current,
            riskVersion: current.riskVersion + 1,
            risk: { state: "loading" },
          }
        : current
    );
  }, [r, versionsKey]);

  useEffect(() => {
    const flow = acquisition;
    if (!flow || flow.method !== "upload" || flow.risk.state !== "resolving") return;
    let current = true;
    const workId = r.id;
    void uploadAcquisitionDocId(workId)
      .then((expectedDocId) => {
        if (!current) return;
        setAcquisition((latest) => {
          if (
            !latest ||
            latest.id !== flow.id ||
            latest.method !== "upload" ||
            latest.risk.state !== "resolving" ||
            workSession.current.workId !== workId
          ) {
            return latest;
          }
          const targetDocId = versions.includes(expectedDocId) ? expectedDocId : null;
          return {
            ...latest,
            riskVersion: latest.riskVersion + 1,
            targetDocId,
            risk: targetDocId ? { state: "loading" } : { state: "new" },
          };
        });
      })
      .catch(() => {
        if (!current) return;
        setAcquisition((latest) =>
          latest?.id === flow.id &&
          latest.method === "upload" &&
          latest.risk.state === "resolving"
            ? {
                ...latest,
                riskVersion: latest.riskVersion + 1,
                risk: { state: "unavailable" },
              }
            : latest
        );
      });
    return () => {
      current = false;
    };
  }, [acquisition?.method, acquisition?.risk.state, r.id, versionsKey]);

  useEffect(() => {
    const flow = acquisition;
    if (!flow || flow.targetDocId === null || flow.risk.state !== "loading") return;
    let current = true;
    void fetchAnnotations(flow.targetDocId).then((result) => {
      if (!current) return;
      setAcquisition((latest) => {
        if (
          !latest ||
          latest.id !== flow.id ||
          latest.method !== flow.method ||
          latest.targetDocId !== flow.targetDocId ||
          latest.risk.state !== "loading"
        ) {
          return latest;
        }
        if (result.ok) {
          return {
            ...latest,
            risk: { state: "known", count: result.file.annotations.length },
          };
        }
        if (result.status === 409)
          return { ...latest, risk: { state: "busy", source: "annotations" } };
        if (result.missing) return { ...latest, risk: { state: "missing" } };
        return { ...latest, risk: { state: "unknown" } };
      });
    });
    return () => {
      current = false;
    };
  }, [
    acquisition?.id,
    acquisition?.method,
    acquisition?.targetDocId,
    acquisition?.risk.state,
    acquisition?.riskVersion,
  ]);

  // A known queued/running job targeting this Work conservatively blocks a
  // replacement. Once that job settles, take a fresh annotation snapshot.
  useEffect(() => {
    setAcquisition((current) => {
      if (!current?.targetDocId) return current;
      const job = current.method === "upload" ? uploadJob : arxivJob;
      const active = job?.status === "queued" || job?.status === "running";
      if (active && !(current.risk.state === "busy" && current.risk.source === "job")) {
        return {
          ...current,
          riskVersion: current.riskVersion + 1,
          risk: { state: "busy", source: "job" },
        };
      }
      if (!active && current.risk.state === "busy" && current.risk.source === "job") {
        return {
          ...current,
          riskVersion: current.riskVersion + 1,
          risk: { state: "loading" },
        };
      }
      return current;
    });
  }, [acquisition?.id, uploadJob, arxivJob]);

  // Provenance is presentation-only metadata from each Doc's explicit
  // acquired_via field. Bind every response to the Work + list generation so
  // a late IR request cannot label a different Work/Doc after navigation or
  // an in-place refresh. Reader content/annotations continue through their
  // existing coherent session and are never accepted here.
  useEffect(() => {
    const generation = ++provenanceGeneration.current;
    const controller = new AbortController();
    setDocProvenance(Object.fromEntries(versions.map((docId) => [docId, "loading"])));
    for (const docId of versions) {
      void fetchDocProvenance(docId, controller.signal).then((provenance) => {
        if (controller.signal.aborted || generation !== provenanceGeneration.current) return;
        setDocProvenance((current) =>
          docId in current ? { ...current, [docId]: provenance } : current
        );
      });
    }
    return () => {
      controller.abort();
    };
  }, [r, versionsKey]);

  const setUploadJob = useCallback((job: Job | null) => {
    uploadJobRef.current = job;
    setUploadJobState(job);
  }, []);

  const setArxivJob = useCallback((job: Job | null) => {
    arxivJobRef.current = job;
    setArxivJobState(job);
  }, []);

  // switching references drops the other ref's upload state
  useEffect(() => {
    setUploadJob(null);
    setUploadErr(null);
    setArxivJob(null);
    setArxivErr(null);
    setArxivErrCode(null);
    setMainErr(null);
    setSettingMain(false);
    acquisitionFlowSequence.current += 1;
    setAcquisition(null);
    copyRequestId.current += 1;
    if (copyStatusTimer.current !== null) {
      clearTimeout(copyStatusTimer.current);
      copyStatusTimer.current = null;
    }
    setCopyStatus(null);
    setDelDoc(null);
    setDelErr(null);
    delBusyRef.current = false;
    delRequestId.current += 1;
    setDelBusy(false);
  }, [r.id, setUploadJob, setArxivJob]);

  const onSetMainDoc = async (docId: string) => {
    const session = workSession.current;
    setMainErr(null);
    setSettingMain(true);
    const ok = await patchRef(session.workId, { doc_id: docId });
    if (!isCurrentWorkSession(session)) return;
    setSettingMain(false);
    if (ok) onReload?.();
    else setMainErr(i18n.t("library.detail.files.setMainFailed"));
  };

  const onConfirmDelete = async (docId: string) => {
    if (delBusyRef.current || (onBeforeDocDelete && !onBeforeDocDelete(docId))) return;
    delBusyRef.current = true;
    const requestId = ++delRequestId.current;
    setDelBusy(true);
    setDelErr(null);
    const res = await deletePaperDoc(docId);
    if (requestId !== delRequestId.current) return;
    delBusyRef.current = false;
    setDelBusy(false);
    if (res.ok) {
      setDelDoc(null);
      onDocDeleted?.(docId, versions.filter((d) => d !== docId));
      onReload?.();
    } else if (res.busy) {
      setDelErr({ kind: "busy", detail: i18n.t("library.detail.deleteDoc.busyHelp") });
    } else if (res.missing) {
      // already deleted elsewhere: the desired end state — close the dialog
      // and reload the library instead of showing an error
      setDelDoc(null);
      onReload?.();
    } else {
      setDelErr({ kind: "error", detail: res.detail });
    }
  };

  const failMsg = (job: Job | null): string =>
    job?.error
      ? i18n.t("library.detail.upload.failed", { error: job.error })
      : i18n.t("library.detail.upload.failedGeneric");

  const arxivFailMsg = (job: Job | null): string =>
    job?.error
      ? i18n.t("library.detail.arxiv.failed", { error: job.error })
      : i18n.t("library.detail.arxiv.failedGeneric");

  const queuePdfUpload = async (file: File): Promise<boolean> => {
    const session = workSession.current;
    if (pdfUploadSubmissions.current.has(session.workId)) return false;
    pdfUploadSubmissions.current.add(session.workId);
    setPdfUploadBusy(true);
    setPdfUploadError(null);
    setPdfErrorDismissed(false);
    try {
      const accepted = await uploadPdf(session.workId, file);
      if (!isCurrentWorkSession(session)) {
        if (!accepted.ok) pdfUploadSubmissions.current.delete(session.workId);
        return false;
      }
      setPdfUploadBusy(false);
      if (!accepted.ok) {
        pdfUploadSubmissions.current.delete(session.workId);
        setPdfUploadError(accepted.status === 409 ? i18n.t("library.detail.pdfUpload.busy") : accepted.detail);
        setPdfErrorDismissed(false);
        return false;
      }
      const seen = seenJobs.current.get(accepted.job.id);
      if (seen?.status === "failed" || seen?.status === "interrupted") {
        pdfUploadSubmissions.current.delete(session.workId);
        setPdfUploadError(seen.error ?? i18n.t("library.detail.pdfUpload.failedGeneric"));
        return false;
      } else if (seen?.status === "done") {
        pdfUploadSubmissions.current.delete(session.workId);
        onReload?.();
      } else {
        setPdfUploadJob(seen ?? accepted.job);
      }
      return true;
    } catch (error) {
      pdfUploadSubmissions.current.delete(session.workId);
      if (isCurrentWorkSession(session)) {
        setPdfUploadBusy(false);
        setPdfUploadError(error instanceof Error ? error.message : String(error));
      }
      return false;
    }
  };

  const queueUpload = async (file: File): Promise<boolean> => {
    const session = workSession.current;
    setUploadErr(null);
    const job = await uploadLatexZip(session.workId, file);
    if (!isCurrentWorkSession(session)) return false;
    if (!job) {
      setUploadErr(failMsg(null));
      return false;
    }
    const seen = seenJobs.current.get(job.id);
    if (!seen || seen.status === "queued" || seen.status === "running") {
      setUploadJob(seen ?? job); // prefer the newer event snapshot
    } else if (seen.status === "done") {
      onReload?.();
    } else {
      // terminal frame beat the fetch response: surface it, don't resurrect
      setUploadErr(failMsg(seen));
    }
    return true;
  };

  // Track this work's job.* events. ONE subscription routes by kind: the
  // upload job (kind "upload") and the Stage 15 arXiv fetch (kind "ingest")
  // share the hello-adoption and race rules. `hello` replays (reconnect /
  // refresh) adopt a queued/running job even without local state, so
  // tracking resumes; a replayed failed/interrupted job surfaces its
  // recorded error once (the failure probe: visible after F5).
  const adoptedFailure = useRef(false);
  const adoptedArxivFailure = useRef(false);
  useEffect(() => {
    adoptedFailure.current = false;
    adoptedArxivFailure.current = false;
    adoptedPdfFailure.current = false;
    setPdfUploadJob(null);
    setPdfUploadError(null);
    setPdfUploadBusy(pdfUploadSubmissions.current.has(r.id));
    arxivPdfJobRef.current = null;
    setArxivPdfJob(null);
    setArxivPdfError(null);
    setArxivPdfErrorDismissed(false);
    setArxivPdfFailureJobId(null);
  }, [r.id]);
  useEffect(
    () =>
      onJobEvent((job) => {
        const targetWorkId = jobWorkId(job);
        const isPdfUpload = job.kind === "upload" && (job.payload as { format?: unknown } | undefined)?.format === "pdf";
        if (isPdfUpload && targetWorkId && (job.status === "done" || job.status === "failed" || job.status === "interrupted")) {
          pdfUploadSubmissions.current.delete(targetWorkId);
        }
        if (targetWorkId !== r.id) return;
        const previous = seenJobs.current.get(job.id);
        if (isJobSnapshotRegression(previous, job)) return;
        seenJobs.current.set(job.id, job);
        const payloadFormat = (job.payload as { format?: unknown } | undefined)?.format;
        if (job.kind === "upload" && payloadFormat === "arxiv-pdf") {
          const currentPdfJob = arxivPdfJobRef.current;
          if (currentPdfJob && currentPdfJob.id === job.id) setArxivPdfJob(job);
          else if (!currentPdfJob && (job.status === "queued" || job.status === "running")) {
            arxivPdfJobRef.current = job;
            setArxivPdfJob(job);
          } else if (!currentPdfJob && (job.status === "failed" || job.status === "interrupted")) {
            setArxivPdfError(job.error ?? i18n.t("library.detail.arxivPdf.failedGeneric"));
            setArxivPdfFailureJobId(job.id);
            setArxivPdfErrorDismissed(dismissedArxivPdfFailures.current.has(job.id));
          }
        } else if (job.kind === "upload" && payloadFormat === "pdf") {
          const currentPdfJob = pdfUploadJobRef.current;
          if (currentPdfJob && job.id === currentPdfJob.id) setPdfUploadJob(job);
          else if (!currentPdfJob && (job.status === "queued" || job.status === "running")) setPdfUploadJob(job);
          else if (!currentPdfJob && (job.status === "failed" || job.status === "interrupted") && !adoptedPdfFailure.current) {
            adoptedPdfFailure.current = true;
            setPdfUploadError(job.error ?? i18n.t("library.detail.pdfUpload.failedGeneric"));
            setPdfErrorDismissed(false);
          }
        } else if (job.kind === "upload") {
          const cur = uploadJobRef.current;
          if (cur && job.id === cur.id) setUploadJob(job);
          else if (!cur && (job.status === "queued" || job.status === "running")) {
            setUploadJob(job);
          } else if (
            !cur &&
            (job.status === "failed" || job.status === "interrupted") &&
            !adoptedFailure.current
          ) {
            // untracked terminal failure (typically a hello replay of the
            // persisted job table, newest first): show the newest one, once
            adoptedFailure.current = true;
            setUploadErr(failMsg(job));
          }
        } else if (job.kind === "ingest") {
          const cur = arxivJobRef.current;
          if (cur && job.id === cur.id) setArxivJob(job);
          else if (!cur && (job.status === "queued" || job.status === "running")) {
            setArxivJob(job);
          } else if (
            !cur &&
            (job.status === "failed" || job.status === "interrupted") &&
            !adoptedArxivFailure.current
          ) {
            adoptedArxivFailure.current = true;
            setArxivErr(arxivFailMsg(job));
            setArxivErrCode(job.errorCode ?? null);
          }
        }
      }),
    [r.id, setUploadJob, setArxivJob]
  );

  useEffect(() => {
    if (!arxivPdfJob) return;
    if (arxivPdfJob.status === "done") {
      arxivPdfJobRef.current = null;
      setArxivPdfJob(null);
      setArxivPdfError(null);
      setArxivPdfErrorDismissed(false);
      setArxivPdfFailureJobId(null);
      onReload?.();
    } else if (arxivPdfJob.status === "failed" || arxivPdfJob.status === "interrupted") {
      arxivPdfJobRef.current = null;
      setArxivPdfJob(null);
      setArxivPdfError(arxivPdfJob.error ?? i18n.t("library.detail.arxivPdf.failedGeneric"));
      setArxivPdfFailureJobId(arxivPdfJob.id);
      setArxivPdfErrorDismissed(dismissedArxivPdfFailures.current.has(arxivPdfJob.id));
    }
  }, [arxivPdfJob, onReload]);

  // react to the terminal states (kept out of the subscriber, which must stay pure)
  useEffect(() => {
    if (!pdfUploadJob) return;
    if (pdfUploadJob.status === "done") {
      setPdfUploadJob(null);
      setPdfUploadError(null);
      onReload?.();
    } else if (pdfUploadJob.status === "failed" || pdfUploadJob.status === "interrupted") {
      setPdfUploadError(pdfUploadJob.error ?? i18n.t("library.detail.pdfUpload.failedGeneric"));
      setPdfErrorDismissed(false);
      setPdfUploadJob(null);
    }
  }, [pdfUploadJob, onReload, setPdfUploadJob]);

  useEffect(() => {
    if (!uploadJob) return;
    if (uploadJob.status === "done") {
      setUploadJob(null);
      onReload?.();
    } else if (uploadJob.status === "failed" || uploadJob.status === "interrupted") {
      setUploadJob(null);
      setUploadErr(failMsg(uploadJob));
    }
  }, [uploadJob, onReload, setUploadJob]);

  // ---- Stage 15: arXiv fetch job (kind "ingest") --------------------------- //

  // The clickable acquisition line / the per-doc refetch entry: queue the
  // fetch (202 → queued or in-flight job); a non-202 (409 scenario C,
  // offline demo, …) surfaces as the generic failure line.
  const onFetchArxivPdf = async (): Promise<boolean> => {
    const session = workSession.current;
    setArxivPdfError(null);
    setArxivPdfErrorDismissed(false);
    setArxivPdfFailureJobId(null);
    const job = await acquireArxivPdf(session.workId);
    if (!isCurrentWorkSession(session)) return false;
    if (!job) {
      setArxivPdfError(i18n.t("library.detail.arxivPdf.submitFailed"));
      return false;
    }
    const seen = seenJobs.current.get(job.id);
    if (!seen || seen.status === "queued" || seen.status === "running") {
      arxivPdfJobRef.current = seen ?? job;
      setArxivPdfJob(seen ?? job);
    } else if (seen.status === "done") {
      onReload?.();
    } else {
      setArxivPdfError(seen.error ?? i18n.t("library.detail.arxivPdf.failedGeneric"));
      setArxivPdfFailureJobId(seen.id);
      setArxivPdfErrorDismissed(dismissedArxivPdfFailures.current.has(seen.id));
    }
    return true;
  };

  const onFetchArxiv = async (): Promise<boolean> => {
    const session = workSession.current;
    setArxivErr(null);
    setArxivErrCode(null);
    const job = await attachArxiv(session.workId);
    if (!isCurrentWorkSession(session)) return false;
    if (!job) {
      setArxivErr(arxivFailMsg(null));
      return false;
    }
    const seen = seenJobs.current.get(job.id);
    if (!seen || seen.status === "queued" || seen.status === "running") {
      setArxivJob(seen ?? job); // prefer the newer event snapshot
    } else if (seen.status === "done") {
      onReload?.();
    } else {
      // terminal frame beat the fetch response: surface it, don't resurrect
      setArxivErr(arxivFailMsg(seen));
      setArxivErrCode(seen.errorCode ?? null);
    }
    return true;
  };

  const openAcquisition = (method?: AcquisitionMethod) => {
    const selected =
      method === "arxiv" && !arxivLatexAllowed
        ? (arxivAllowed ? "pdf" : "upload")
        : (method ?? (arxivAllowed ? "pdf" : "upload"));
    const targetDocId =
      selected === "arxiv" && arxivTarget && versions.includes(arxivTarget)
        ? arxivTarget
        : null;
    const id = ++acquisitionFlowSequence.current;
    setAcquisition({
      id,
      riskVersion: 0,
      method: selected,
      targetDocId,
      risk:
        selected === "upload" && versions.length > 0
          ? { state: "resolving" }
          : targetDocId
            ? { state: "loading" }
            : { state: "new" },
      file: null,
      fileError: null,
      pdfWarningAccepted: false,
      busy: false,
      error: null,
    });
  };

  const submitAcquisition = async () => {
    const flow = acquisition;
    if (
      !flow ||
      submittingAcquisitionFlows.current.has(flow.id) ||
      flow.busy ||
      flow.risk.state === "resolving" ||
      flow.risk.state === "loading" ||
      flow.risk.state === "busy" ||
      flow.risk.state === "missing" ||
      flow.risk.state === "unavailable"
    ) {
      return;
    }
    if (flow.method === "upload" || flow.method === "pdf-upload") {
      const problem = acquisitionFileProblem(flow.file, flow.method);
      if (problem) {
        setAcquisition((current) =>
          current?.id === flow.id
            ? {
                ...current,
                file: null,
                fileError: acquisitionFileError(problem),
              }
            : current
        );
        return;
      }
      if (flow.method === "pdf-upload" && flow.file!.size >= 25 * 1024 * 1024 && !flow.pdfWarningAccepted) return;
    }
    const session = workSession.current;
    submittingAcquisitionFlows.current.add(flow.id);
    setAcquisition((current) =>
      current?.id === flow.id
        ? { ...current, busy: true, fileError: null, error: null }
        : current
    );
    const accepted =
      flow.method === "pdf"
        ? await onFetchArxivPdf()
        : flow.method === "arxiv"
          ? await onFetchArxiv()
          : flow.method === "pdf-upload"
            ? await queuePdfUpload(flow.file as File)
            : await queueUpload(flow.file as File);
    submittingAcquisitionFlows.current.delete(flow.id);
    if (
      acquisitionFlowSequence.current !== flow.id ||
      !isCurrentWorkSession(session)
    ) {
      return;
    }
    if (accepted) {
      acquisitionFlowSequence.current += 1;
      setAcquisition(null);
    } else {
      setAcquisition((current) =>
        current?.id === flow.id
          ? {
              ...current,
              riskVersion: current.riskVersion + 1,
              risk: current.targetDocId ? { state: "loading" } : current.risk,
              busy: false,
              error: i18n.t("library.detail.acquisition.submitFailed"),
            }
          : current
      );
    }
  };

  // react to the terminal states (kept out of the subscriber, which must stay pure)
  useEffect(() => {
    if (!arxivJob) return;
    if (arxivJob.status === "done") {
      setArxivJob(null);
      onReload?.();
    } else if (arxivJob.status === "failed" || arxivJob.status === "interrupted") {
      setArxivJob(null);
      setArxivErr(arxivFailMsg(arxivJob));
      setArxivErrCode(arxivJob.errorCode ?? null);
    }
  }, [arxivJob, onReload, setArxivJob]);

  useEffect(
    () => () => {
      workSession.current = {
        workId: workSession.current.workId,
        generation: workSession.current.generation + 1,
      };
      copyRequestId.current += 1;
      if (copyStatusTimer.current !== null) {
        clearTimeout(copyStatusTimer.current);
        copyStatusTimer.current = null;
      }
    },
    []
  );

  const copyText = async (target: "cite" | "bib", text: string) => {
    const requestId = ++copyRequestId.current;
    const workId = r.id;
    if (copyStatusTimer.current !== null) {
      clearTimeout(copyStatusTimer.current);
      copyStatusTimer.current = null;
    }
    setCopyStatus(null);
    let state: "copied" | "failed";
    try {
      await navigator.clipboard.writeText(text);
      state = "copied";
    } catch {
      state = "failed";
    }
    if (requestId !== copyRequestId.current || workId !== activeWorkId.current) return;
    setCopyStatus({ target, state });
    copyStatusTimer.current = setTimeout(() => {
      if (requestId === copyRequestId.current && workId === activeWorkId.current) {
        setCopyStatus(null);
        copyStatusTimer.current = null;
      }
    }, 2400);
  };

  const copyStatusText = copyStatus
    ? t(
        copyStatus.state === "failed"
          ? "library.detail.copy.failed"
          : copyStatus.target === "cite"
            ? "library.detail.copy.citeCopied"
            : "library.detail.copy.bibCopied"
      )
    : null;

  return (
    <aside className="ref-detail reference-detail view-in" data-ui="work-detail" data-ui-key={r.id} aria-label={r.title}>
      <div className="ref-detail-scroll">
        <div className="ref-detail-head">
          <div className="ref-type-badge">
            {r.type === "conf" ? t("library.detail.typeConf") : t("library.detail.typeArticle")}
          </div>
          <div className="ref-detail-actions" data-ui="work-detail-actions">
            <ActionButton
              mode="icon"
              iconName="copy"
              variant="ghost"
              label={t("library.detail.copy.cite")}
              tooltip={t("library.detail.copy.cite")}
              data-ui="copy-cite-key"
              onClick={() => void copyText("cite", r.cite)}
            />
            <ActionButton
              mode="icon"
              iconName="x"
              variant="ghost"
              label={t("common.close")}
              tooltip={t("common.close")}
              data-ui="close-work-detail"
              onClick={onClose}
            />
          </div>
        </div>
        <h1 className="ref-detail-title serif">{r.title}</h1>
        <p className="ref-detail-auth">{r.authors}</p>
        <div className="ref-detail-meta">
          <span>{r.venue}</span>
          <span className="dotsep">·</span>
          <span className="mono">{r.year}</span>
          {cited != null && (
            <>
              <span className="dotsep">·</span>
              <span className="mono">{t("library.detail.citedBy", { count: cgKfmt(cited) })}</span>
            </>
          )}
        </div>
        <div className="ref-reading-action" data-ui="work-fulltext-action">
          <span className="ref-availability">
            <Icon name={mainDoc ? "check" : "file-text"} cls="ico-sm" />
            {t(mainDoc ? "library.detail.fullText.available" : "library.detail.fullText.missing")}
          </span>
          <ActionButton
            mode="text"
            data-ui="open-main-doc-or-acquisition"
            variant="primary"
            label={t(mainDoc ? "library.detail.fullText.read" : "library.detail.fullText.acquire")}
            tooltip={t(mainDoc ? "library.detail.fullText.read" : "library.detail.fullText.acquire")}
            onClick={() => {
              if (mainDoc) onOpenDoc(mainDoc);
              else setTab("files");
            }}
          >
            {t(mainDoc ? "library.detail.fullText.read" : "library.detail.fullText.acquire")}
          </ActionButton>
        </div>
        {copyStatusText && (
          <p
            data-ui="copy-feedback"
            className={"ref-copy-status" + (copyStatus?.state === "failed" ? " error" : "")}
            role={copyStatus?.state === "failed" ? "alert" : "status"}
          >
            {copyStatusText}
          </p>
        )}
        <Tabs
          ariaLabel={t("library.detail.tabs.label")}
          items={TABS.map((value) => ({ value, label: t(TAB_LABEL_KEYS[value]) }))}
          value={tab}
          onValueChange={setTab}
          className="ref-detail-tabs"
          panelClassName="ref-detail-body"
        >
        {tab === "meta" && (
          <div className="ref-meta-list" data-ui="work-metadata">
            <div className="rml-row">
              <span className="rml-k">{t("library.detail.meta.type")}</span>
              <span className="rml-v">{r.type === "conf" ? t("library.detail.typeConfFull") : t("library.detail.typeArticleFull")}</span>
            </div>
            <div className="rml-row">
              <span className="rml-k">{t("library.detail.meta.year")}</span>
              <span className="rml-v mono">{r.year}</span>
            </div>
            <div className="rml-row">
              <span className="rml-k">{t("library.detail.meta.venue")}</span>
              <span className="rml-v">{r.venue}</span>
            </div>
            {cited != null && (
              <div className="rml-row">
                <span className="rml-k">{t("library.detail.meta.citedBy")}</span>
                <span className="rml-v mono">{cited}</span>
              </div>
            )}
            {r.resolvedBy && RESOLVED_LABEL[r.resolvedBy] && (
              <div className="rml-row">
                <span className="rml-k">{t("library.detail.meta.citationSource")}</span>
                <span className="rml-v">{RESOLVED_LABEL[r.resolvedBy]}</span>
              </div>
            )}
            {r.doi && (
              <div className="rml-row">
                <span className="rml-k">DOI</span>
                <span className="rml-v mono">{r.doi}</span>
              </div>
            )}
            {r.arxiv_id && (
              <div className="rml-row">
                <span className="rml-k">arXiv</span>
                <span className="rml-v mono">{r.arxiv_id}</span>
              </div>
            )}
            <div className="rml-row">
              <span className="rml-k">{t("library.detail.meta.citeKey")}</span>
              <span className="rml-v mono">{r.cite}</span>
            </div>
            <div className="rml-row">
              <span className="rml-k">{t("library.detail.tabs.files")}</span>
              <span className="rml-v">{r.pdf || r.doc_id ? t("library.detail.meta.filesOpen") : t("library.detail.meta.filesNone")}</span>
            </div>
            {r.tags.length > 0 && (
              <div className="ref-tags" style={{ marginTop: 4 }}>
                {r.tags.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "info" && (
          <div className="ref-abstract" data-ui="work-abstract">
            {r.abstract ? (
              <AbstractHtml text={r.abstract} />
            ) : (
              <div className="placeholder-text ph-abstract">
                <span className="mono">{t("library.detail.abstractPlaceholder")}</span>
              </div>
            )}
            {r.tags.length > 0 && (
              <div className="ref-tags" style={{ marginTop: 4 }}>
                {r.tags.map((t) => (
                  <Tag key={t}>{t}</Tag>
                ))}
              </div>
            )}
          </div>
        )}
        {tab === "bib" && (
          <div className="bib-block" data-ui="work-bibtex">
            <div className="bib-toolbar">
              <ActionButton mode="icon" iconName="copy" data-ui="copy-work-bibtex" variant="ghost" label={t("library.detail.copy.bib")} tooltip={t("library.detail.copy.bib")} onClick={() => void copyText("bib", bibtexOf(r))} />
            </div>
            <pre className="mono">{bibtexOf(r)}</pre>
          </div>
        )}
        {tab === "notes" && (
          <div className="ref-notes" data-ui="work-notes">
            {r.note ? (
              <div className="ref-abstract ref-note">
                <p>{r.note}</p>
              </div>
            ) : (
              <div className="ref-note-empty">
                <Icon name="notebook-pen" cls="ico-sm" />
                <strong>{t("library.detail.notesEmpty")}</strong>
              </div>
            )}
            <p className="ref-note-help">{t("library.detail.notesEditingUnavailable")}</p>
          </div>
        )}
        {tab === "files" && (
          <div className="ref-files" data-ui="work-fulltext">
            <div className="ref-files-head">
              <h2>{t("library.detail.files.documents")}</h2>
              <ActionButton
                mode="icon"
                iconName="file-up"
                data-ui="gether-doc"
                variant="ghost"
                disabled={uploadJob !== null || arxivJob !== null || arxivPdfJob !== null || pdfUploadBusy || pdfUploadJob !== null}
                label={t(versions.length === 0 ? "library.detail.acquisition.openGet" : "library.detail.acquisition.openManage")}
                tooltip={t(versions.length === 0 ? "library.detail.acquisition.openGet" : "library.detail.acquisition.openManage")}
                onClick={() => openAcquisition()}
              />
            </div>
            {(uploadJob || arxivJob || arxivPdfJob || uploadErr || arxivErr || arxivPdfError || mainErr || pdfUploadJob || pdfUploadError) && (
              <div className="ref-task-messages" data-ui="acquisition-status">
                {arxivPdfJob && (
                  <InlineMessage title={t(arxivPdfJob.status === "queued" ? "library.detail.jobs.queued" : "library.detail.arxivPdf.fetching")}>
                    {arxivPdfJob.status === "queued" ? t("library.detail.jobs.queueHelp") : arxivPdfJob.progress[arxivPdfJob.progress.length - 1]?.message ?? t("library.detail.arxivPdf.fetching")}
                  </InlineMessage>
                )}
                {arxivPdfError && (
                  <InlineMessage uiId="arxiv-pdf-error" tone="danger" title={t("library.detail.arxivPdf.failedTitle")}>
                    {!arxivPdfErrorDismissed && <ActionButton mode="icon" iconName="x" data-ui="dismiss-arxiv-pdf-error" variant="ghost" label={t("library.detail.arxivPdf.dismiss")} tooltip={t("library.detail.arxivPdf.dismiss")} onClick={() => { if (arxivPdfFailureJobId) dismissedArxivPdfFailures.current.add(arxivPdfFailureJobId); setArxivPdfErrorDismissed(true); }} />}
                    <p>{arxivPdfErrorDismissed ? t("library.detail.arxivPdf.failedSummary") : arxivPdfError}</p>
                    <ActionButton mode="text" data-ui="retry-arxiv-pdf" variant="ghost" label={t("library.detail.arxivPdf.retry")} tooltip={t("library.detail.arxivPdf.retry")} onClick={() => openAcquisition("pdf")}>{t("library.detail.arxivPdf.retry")}</ActionButton>
                  </InlineMessage>
                )}
                {pdfUploadJob && (
                  <InlineMessage title={t(pdfUploadJob.status === "queued" ? "library.detail.jobs.queued" : "library.detail.pdfUpload.uploading")}>
                    {pdfUploadJob.status === "queued" ? t("library.detail.jobs.queueHelp") : pdfUploadJob.progress[pdfUploadJob.progress.length - 1]?.message ?? t("library.detail.pdfUpload.uploading")}
                  </InlineMessage>
                )}
                {pdfUploadError && (pdfErrorDismissed ? (
                  <InlineMessage tone="danger" title={t("library.detail.pdfUpload.failedTitle")}>
                    <p>{t("library.detail.pdfUpload.failedSummary")}</p>
                    <ActionButton mode="text" data-ui="retry-pdf-upload" variant="ghost" label={t("library.detail.pdfUpload.retry")} tooltip={t("library.detail.pdfUpload.retry")} onClick={() => openAcquisition("pdf-upload")}>{t("library.detail.pdfUpload.retry")}</ActionButton>
                  </InlineMessage>
                ) : (
                  <InlineMessage tone="danger" title={t("library.detail.pdfUpload.failedTitle")}>
                    <ActionButton mode="icon" iconName="x" data-ui="dismiss-pdf-upload-error" variant="ghost" label={t("library.detail.pdfUpload.dismiss")} tooltip={t("library.detail.pdfUpload.dismiss")} onClick={() => setPdfErrorDismissed(true)} />
                    <p>{pdfUploadError}</p>
                    <ActionButton mode="text" data-ui="retry-pdf-upload" variant="ghost" label={t("library.detail.pdfUpload.retry")} tooltip={t("library.detail.pdfUpload.retry")} onClick={() => openAcquisition("pdf-upload")}>{t("library.detail.pdfUpload.retry")}</ActionButton>
                  </InlineMessage>
                ))}
                {uploadJob && (
                  <InlineMessage
                    title={t(
                      uploadJob.status === "queued"
                        ? "library.detail.jobs.queued"
                        : "library.detail.jobs.uploading"
                    )}
                  >
                    {uploadJob.status === "queued"
                      ? t("library.detail.jobs.queueHelp")
                      : (uploadJob.progress[uploadJob.progress.length - 1]?.message ??
                        t("library.detail.upload.ingesting"))}
                  </InlineMessage>
                )}
                {arxivJob && (
                  <InlineMessage
                    title={t(
                      arxivJob.status === "queued"
                        ? "library.detail.jobs.queued"
                        : arxivLatexUpdatesExisting
                          ? "library.detail.jobs.updating"
                          : "library.detail.jobs.fetching"
                    )}
                  >
                    {arxivJob.status === "queued"
                      ? t("library.detail.jobs.queueHelp")
                      : (arxivJob.progress[arxivJob.progress.length - 1]?.message ??
                        t("library.detail.arxiv.ingesting"))}
                  </InlineMessage>
                )}
                {uploadErr && (
                  <InlineMessage uiId="latex-upload-error" tone="danger" title={t("library.detail.jobs.uploadFailed")}>
                    <p>{uploadErr}</p>
                    {mainDoc && <p>{t("library.detail.jobs.existingDocumentLink")}</p>}
                  </InlineMessage>
                )}
                {arxivErr && (
                  <InlineMessage
                    tone={arxivErrCode === "arxiv_pdf_only" ? "warning" : "danger"}
                    title={t(
                      arxivErrCode === "arxiv_pdf_only"
                        ? "library.detail.jobs.pdfOnly"
                        : arxivLatexUpdatesExisting
                          ? "library.detail.jobs.updateFailed"
                          : "library.detail.jobs.fetchFailed"
                    )}
                  >
                    <p>{arxivErr}</p>
                    {arxivErrCode === "arxiv_pdf_only" && (
                      <p>{t("library.detail.arxiv.pdfOnlyHint")}</p>
                    )}
                    {mainDoc && <p>{t("library.detail.jobs.existingDocumentLink")}</p>}
                    <ActionButton
                      mode="text"
                      variant="ghost"
                      data-testid="arxiv-retry" data-ui="retry-arxiv-source"
                      label={t(arxivErrCode === "arxiv_pdf_only" ? "library.detail.acquisition.methodUpload" : "library.detail.arxiv.retry")}
                      tooltip={t(arxivErrCode === "arxiv_pdf_only" ? "library.detail.acquisition.methodUpload" : "library.detail.arxiv.retry")}
                      onClick={() => openAcquisition(arxivErrCode === "arxiv_pdf_only" ? "upload" : "arxiv")}
                    >
                      {t(arxivErrCode === "arxiv_pdf_only" ? "library.detail.acquisition.methodUpload" : "library.detail.arxiv.retry")}
                    </ActionButton>
                  </InlineMessage>
                )}
                {mainErr && <InlineMessage uiId="set-main-doc-error" tone="danger">{mainErr}</InlineMessage>}
              </div>
            )}
            {versions.length === 0 && (
              <div className="ref-documents-empty" data-ui="work-documents-empty">
                <strong>{t("library.detail.files.empty")}</strong>
                <span>{t("library.detail.files.emptyHelp")}</span>
              </div>
            )}
            {versions.length > 0 && (
              <section className="ref-documents" data-ui="work-documents" aria-label={t("library.detail.files.documents")}>
                <h2>{t("library.detail.files.documents")}</h2>
                <div className="ref-document-list">
                  {versions.map((docId) => {
                    const provenance = docProvenance[docId] ?? "loading";
                    const isMain = docId === mainDoc;
                    const sourceLabel = t(
                      provenance === "arxiv-pdf"
                        ? "library.detail.files.sourceArxivPdf"
                        : provenance === "arxiv"
                          ? "library.detail.files.sourceArxiv"
                          : provenance === "upload"
                          ? "library.detail.files.sourceUpload"
                          : provenance === "pdf"
                            ? "library.detail.files.sourcePdf"
                            : provenance === "loading"
                            ? "library.detail.files.sourceLoading"
                            : "library.detail.files.sourceUnknown"
                    );
                    return (
                      <article className="ref-document" key={docId} data-ui="doc-item" data-ui-key={docId}>
                        <div className="ref-document-heading">
                          <Icon
                            name={provenance === "upload" || provenance === "pdf" || provenance === "arxiv-pdf" ? "file-up" : "file-text"}
                            cls="ico-sm"
                          />
                          <strong>{sourceLabel}</strong>
                          <Badge tone={isMain ? "accent" : "neutral"}>
                            {t(
                              isMain
                                ? "library.detail.files.mainBadge"
                                : "library.detail.files.additionalBadge"
                            )}
                          </Badge>
                        </div>
                        <code className="ref-document-id">{docId}</code>
                        <details className="ref-document-actions" data-ui="doc-actions">
                          <summary data-ui="toggle-doc-actions">
                            <Icon name="ellipsis" cls="ico-sm" />
                            {t("library.detail.files.actions")}
                          </summary>
                          <div className="ref-document-action-list" data-ui="doc-action-list">
                            <ActionButton mode="icon" iconName="book-open" data-ui="open-doc" variant="ghost" label={t("library.detail.files.openDoc")} tooltip={t("library.detail.files.openDoc")} onClick={() => onOpenDoc(docId)} />
                            {!isMain && (
                              <ActionButton
                                mode="icon"
                                iconName="check"
                                data-ui="set-main-doc"
                                variant="ghost"
                                label={t("library.detail.files.setMainTitle")}
                                tooltip={t("library.detail.files.setMainTitle")}
                                disabled={settingMain}
                                onClick={() => void onSetMainDoc(docId)}
                              />
                            )}
                            {docId === arxivTarget && (
                              <ActionButton
                                mode="text"
                                variant="ghost"
                                data-ui="refresh-arxiv-source"
                                data-testid={isMain ? "arxiv-refetch-main" : `arxiv-refetch-${docId}`}
                                label={t("library.detail.files.refetchArxivTitle")}
                                tooltip={t("library.detail.files.refetchArxivTitle")}
                                disabled={arxivJob !== null}
                                onClick={() => openAcquisition("arxiv")}
                              >
                                {t("library.detail.files.refetchArxivTitle")}
                              </ActionButton>
                            )}
                            {docId === expectedUploadTarget && (
                              <ActionButton
                                mode="text"
                                variant="ghost"
                                data-ui="replace-upload-source"
                                label={t("library.detail.files.replaceUpload")}
                                tooltip={t("library.detail.files.replaceUpload")}
                                disabled={uploadJob !== null}
                                onClick={() => openAcquisition("upload")}
                              >
                                {t("library.detail.files.replaceUpload")}
                              </ActionButton>
                            )}
                            <ActionButton
                              mode="text"
                              variant="ghost"
                              className="danger-text"
                              data-ui="delete-doc"
                              label={t("library.detail.files.deleteDoc")}
                              tooltip={t("library.detail.files.deleteDoc")}
                              onClick={() => {
                                setDelErr(null);
                                setDelDoc(docId);
                              }}
                            >
                              {t("library.detail.files.deleteDoc")}
                            </ActionButton>
                          </div>
                        </details>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        )}
        </Tabs>
      </div>
      {explore && (
        <div className="detail-footer" data-ui="work-detail-footer">
          <ActionButton
            unstyled
            mode="text"
            className="btn primary large"
            data-testid="explore-paper" data-ui="explore-from-work"
            label={t("explore.entry")}
            tooltip={!explore.live ? t("explore.demoOff") : !explore.bibcode ? t("explore.noBibcode") : t("explore.entry")}
            disabled={!explore.bibcode || !explore.live}
            onClick={() => explore.bibcode && explore.onExplore(explore.bibcode)}
          >
            {t("explore.entry")}
          </ActionButton>
          {(!explore.live || !explore.bibcode) && (
            <div className="detail-footer-note">
              {!explore.live ? t("explore.demoOff") : t("explore.noBibcode")}
            </div>
          )}
        </div>
      )}
      {acquisition && (
        <AcquisitionDialog
          flow={acquisition}
          arxivId={r.arxiv_id}
          arxivAllowed={arxivAllowed}
          arxivLatexAllowed={arxivLatexAllowed}
          onMethodChange={(method) => {
            if (acquisition.busy) return;
            const id = ++acquisitionFlowSequence.current;
            setAcquisition((current) => {
              if (!current || current.busy) return current;
              const targetDocId =
                method === "arxiv" && arxivTarget && versions.includes(arxivTarget)
                  ? arxivTarget
                  : null;
              return {
                ...current,
                id,
                riskVersion: 0,
                method,
                targetDocId,
                risk:
                  method === "upload" && versions.length > 0
                    ? { state: "resolving" }
                    : targetDocId
                      ? { state: "loading" }
                      : { state: "new" },
                file: null,
                fileError: null,
                pdfWarningAccepted: false,
                error: null,
              };
            });
          }}
          onPdfWarningChange={(accepted) => setAcquisition((current) => current && !current.busy ? { ...current, pdfWarningAccepted: accepted } : current)}
          onFileChange={(file) =>
            setAcquisition((current) => {
              if (!current || current.busy) return current;
              const problem = acquisitionFileProblem(file, current.method);
              return {
                ...current,
                file: problem ? null : file,
                fileError: problem && problem !== "required" ? acquisitionFileError(problem) : null,
                pdfWarningAccepted: false,
                error: null,
              };
            })
          }
          onCancel={() => {
            acquisitionFlowSequence.current += 1;
            setAcquisition(null);
          }}
          onSubmit={() => void submitAcquisition()}
        />
      )}
      {delDoc && (
        <DeleteDocDialog
          docId={delDoc}
          pdf={docProvenance[delDoc] === "pdf"}
          busy={delBusy}
          error={delErr}
          onCancel={() => setDelDoc(null)}
          onConfirm={onConfirmDelete}
        />
      )}
    </aside>
  );
}

function AcquisitionDialog({
  flow,
  arxivId,
  arxivAllowed,
  arxivLatexAllowed,
  onMethodChange,
  onFileChange,
  onPdfWarningChange,
  onCancel,
  onSubmit,
}: {
  flow: AcquisitionFlow;
  arxivId: string | undefined;
  arxivAllowed: boolean;
  arxivLatexAllowed: boolean;
  onMethodChange: (method: AcquisitionMethod) => void;
  onFileChange: (file: File | null) => void;
  onPdfWarningChange: (accepted: boolean) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const submitLabel = t(
    flow.busy
      ? "library.detail.acquisition.submitting"
      : flow.targetDocId
        ? "library.detail.acquisition.confirmUpdate"
        : flow.method === "upload"
          ? "library.detail.acquisition.startUpload"
          : flow.method === "pdf-upload"
            ? "library.detail.pdfUpload.start"
          : flow.method === "pdf"
            ? "library.detail.acquisition.startPdf"
            : "library.detail.acquisition.startArxiv"
  );
  return (
    <Dialog
      uiId="fulltext-acquisition-dialog"
      title={t("library.detail.acquisition.getTitle")}
      closeLabel={t("common.close")}
      busy={flow.busy}
      initialFocusRef={cancelRef}
      onClose={onCancel}
      footer={
        <>
          <ActionButton mode="text" ref={cancelRef} data-ui="cancel-fulltext-acquisition" label={t("common.cancel")} tooltip={t("common.cancel")} disabled={flow.busy} onClick={onCancel}>
            {t("common.cancel")}
          </ActionButton>
          <ActionButton
            mode="text"
            variant="primary"
            busy={flow.busy}
            busyLabel={submitLabel}
            label={submitLabel}
            tooltip={submitLabel}
            data-ui="submit-fulltext-acquisition"
            disabled={
              (flow.method === "pdf-upload" && (flow.file === null || (flow.file.size >= 25 * 1024 * 1024 && !flow.pdfWarningAccepted))) ||
              (flow.method === "pdf" && !arxivAllowed) ||
              (flow.method === "arxiv" && !arxivLatexAllowed) ||
              flow.risk.state === "resolving" ||
              flow.risk.state === "loading" ||
              flow.risk.state === "busy" ||
              flow.risk.state === "missing" ||
              flow.risk.state === "unavailable"
            }
            onClick={onSubmit}
          >
            {t(
              flow.targetDocId
                ? "library.detail.acquisition.confirmUpdate"
                : flow.method === "upload"
                  ? "library.detail.acquisition.startUpload"
                  : flow.method === "pdf-upload"
                    ? "library.detail.pdfUpload.start"
                  : flow.method === "pdf"
                    ? "library.detail.acquisition.startPdf"
                    : "library.detail.acquisition.startArxiv"
            )}
          </ActionButton>
        </>
      }
    >
      <fieldset className="ref-acquisition-methods" data-ui="fulltext-acquisition-methods">
        <legend>{t("library.detail.acquisition.methodLabel")}</legend>
        <label>
          <input
            type="radio"
            name="acquisition-method"
            value="pdf" data-ui="acquire-arxiv-pdf"
            checked={flow.method === "pdf"}
            disabled={!arxivAllowed || flow.busy}
            onChange={() => onMethodChange("pdf")}
          />
          <span>
            <strong>{t("library.detail.acquisition.methodPdf")}</strong>
            <small>{arxivId ? `arXiv:${arxivId}` : t("library.detail.acquisition.noArxiv")}</small>
          </span>
        </label>
        <label>
          <input type="radio" name="acquisition-method" value="arxiv" data-ui="acquire-arxiv-latex" checked={flow.method === "arxiv"} disabled={!arxivLatexAllowed || flow.busy} onChange={() => onMethodChange("arxiv")} />
          <span><strong>{t("library.detail.acquisition.methodArxivLatex")}</strong><small>{arxivId ? arxivLatexAllowed ? `arXiv:${arxivId}` : t("library.detail.acquisition.arxivBlocked") : t("library.detail.acquisition.noArxiv")}</small></span>
        </label>
        <label>
          <input type="radio" name="acquisition-method" value="pdf-upload" data-ui="upload-pdf" checked={flow.method === "pdf-upload"} disabled={flow.busy} onChange={() => onMethodChange("pdf-upload")} />
          <span><strong>{t("library.detail.pdfUpload.method")}</strong><small>{t("library.detail.pdfUpload.methodHelp")}</small></span>
        </label>
        <label>
          <input
            type="radio"
            name="acquisition-method"
            value="upload" data-ui="upload-latex-source"
            checked={flow.method === "upload"}
            disabled={flow.busy}
            onChange={() => onMethodChange("upload")}
          />
          <span>
            <strong>{t("library.detail.acquisition.methodUpload")}</strong>
            <small>{t("library.detail.acquisition.uploadRequirement")}</small>
          </span>
        </label>
      </fieldset>
      {flow.targetDocId && (
        <div className="ref-acquisition-target">
          <strong>{t("library.detail.acquisition.targetLabel")}</strong>
          <code>{flow.targetDocId}</code>
        </div>
      )}
      {flow.risk.state === "resolving" && (
        <InlineMessage>{t("library.detail.acquisition.targetLoading")}</InlineMessage>
      )}
      {flow.risk.state === "loading" && (
        <InlineMessage>{t("library.detail.acquisition.riskLoading")}</InlineMessage>
      )}
      {flow.risk.state === "known" && flow.risk.count > 0 && (
        <InlineMessage
          tone="warning"
          title={t("library.detail.acquisition.riskTitle")}
        >
          {t("library.detail.acquisition.riskKnown", { count: flow.risk.count })}
        </InlineMessage>
      )}
      {flow.risk.state === "known" && flow.risk.count === 0 && (
        <InlineMessage tone="warning">
          {t("library.detail.acquisition.riskZero")}
        </InlineMessage>
      )}
      {flow.risk.state === "unknown" && (
        <InlineMessage
          tone="warning"
          title={t("library.detail.acquisition.riskTitle")}
        >
          {t("library.detail.acquisition.riskUnknown")}
        </InlineMessage>
      )}
      {flow.risk.state === "busy" && (
        <InlineMessage tone="warning" title={t("library.detail.acquisition.riskBusyTitle")}>
          {t("library.detail.acquisition.riskBusy")}
        </InlineMessage>
      )}
      {flow.risk.state === "missing" && (
        <InlineMessage tone="danger" title={t("library.detail.acquisition.riskMissingTitle")}>
          {t("library.detail.acquisition.riskMissing")}
        </InlineMessage>
      )}
      {flow.risk.state === "unavailable" && (
        <InlineMessage tone="danger" title={t("library.detail.acquisition.targetUnavailableTitle")}>
          {t("library.detail.acquisition.targetUnavailable")}
        </InlineMessage>
      )}
      {(flow.method === "upload" || flow.method === "pdf-upload") && (
        <div className="ref-acquisition-file">
          <label htmlFor="acquisition-file">
            {t(flow.method === "pdf-upload" ? "library.detail.pdfUpload.choose" : "library.detail.acquisition.fileLabel")}
          </label>
          <input
            id="acquisition-file"
            data-ui={flow.method === "pdf-upload" ? "pdf-upload-file" : "latex-source-file"}
            type="file"
            accept={flow.method === "pdf-upload" ? "application/pdf,.pdf" : ".zip"}
            disabled={flow.busy}
            aria-describedby={
              flow.fileError
                ? "acquisition-file-help acquisition-file-error"
                : "acquisition-file-help"
            }
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = "";
              onFileChange(file);
            }}
          />
          {flow.file && <code>{flow.file.name}</code>}
          <p id="acquisition-file-help">{t(flow.method === "pdf-upload" ? "library.detail.pdfUpload.methodHelp" : "library.detail.acquisition.fileHelp")}</p>
          {flow.fileError && (
            <p id="acquisition-file-error" className="ref-acquisition-error" role="alert">
              {flow.fileError}
            </p>
          )}
          {flow.method === "pdf-upload" && flow.file && flow.file.size >= 25 * 1024 * 1024 && (
            <InlineMessage uiId="pdf-resource-warning" tone="warning" title={t("library.detail.pdfUpload.resourceWarning")}>
              <p>{t("library.detail.pdfUpload.resourceWarningDetail", { filename: flow.file.name, size: (flow.file.size / (1024 * 1024)).toFixed(1) })}</p>
              <label htmlFor="confirm-pdf-resource-warning"><input id="confirm-pdf-resource-warning" data-ui="confirm-pdf-resource-warning" type="checkbox" checked={flow.pdfWarningAccepted} disabled={flow.busy} onChange={(event) => onPdfWarningChange(event.target.checked)} />{t("library.detail.pdfUpload.continue")}</label>
            </InlineMessage>
          )}
        </div>
      )}
      {flow.error && <InlineMessage tone="danger">{flow.error}</InlineMessage>}
    </Dialog>
  );
}

/**
 * Stage 8 §8 delete confirmation. The annotation count N is fetched when the
 * dialog opens (the annotations file is the doc's own, independent of the
 * library); a failed count fetch degrades to an "unknown count" wording
 * instead of blocking the deletion. The server answer 409 "document busy"
 * means a queued/running ingest pins the doc — the dialog stays open with
 * the retry hint.
 */
function DeleteDocDialog({
  docId,
  pdf,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  docId: string;
  pdf: boolean;
  busy: boolean;
  error: { kind: "busy" | "error"; detail: string } | null;
  onCancel: () => void;
  onConfirm: (docId: string) => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteLabel = t(busy ? "library.detail.deleteDoc.deleting" : "library.detail.deleteDoc.confirm");
  const [count, setCount] = useState<
    { state: "loading" } | { state: "known"; value: number } | { state: "unknown" }
  >({ state: "loading" });
  useEffect(() => {
    let current = true;
    setCount({ state: "loading" });
    const loadCount = pdf
      ? fetchPdfAnnotationCount(docId).then((result) => result.ok ? { ok: true as const, count: result.count } : { ok: false as const })
      : fetchAnnotations(docId).then((result) => result.ok ? { ok: true as const, count: result.file.annotations.length } : { ok: false as const });
    void loadCount.then((result) => {
      if (!current) return;
      setCount(result.ok ? { state: "known", value: result.count } : { state: "unknown" });
    });
    return () => {
      current = false;
    };
  }, [docId, pdf]);

  return (
    <Dialog
      uiId="delete-doc-dialog"
      title={t("library.detail.deleteDoc.title")}
      description={t("library.detail.deleteDoc.risk")}
      closeLabel={t("common.close")}
      busy={busy}
      initialFocusRef={cancelRef}
      onClose={onCancel}
      footer={
        <>
          <ActionButton mode="text" ref={cancelRef} data-ui="cancel-delete-doc" label={t("common.cancel")} tooltip={t("common.cancel")} disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </ActionButton>
          <ActionButton
            mode="text"
            variant="danger"
            busy={busy}
            disabled={count.state === "loading"}
            busyLabel={deleteLabel}
            label={deleteLabel}
            tooltip={deleteLabel}
            data-ui="confirm-delete-doc"
            onClick={() => onConfirm(docId)}
          >
            {t("library.detail.deleteDoc.confirm")}
          </ActionButton>
        </>
      }
    >
      <div className="ui-delete-doc" data-ui="delete-doc-risk">
        <div className="ui-delete-doc-identity">
          <strong>{t("library.detail.deleteDoc.objectLabel")}</strong>
          <code>{docId}</code>
        </div>
        <InlineMessage tone="warning" title={t("library.detail.deleteDoc.scopeTitle")}>
          {t(pdf ? "library.detail.deleteDoc.pdfScope" : "library.detail.deleteDoc.scope")}
        </InlineMessage>
        <p className="ui-delete-doc-count" role="status">
          {count.state === "loading"
            ? t("library.detail.deleteDoc.countLoading")
            : count.state === "known"
              ? t("library.detail.deleteDoc.count", { count: count.value })
              : t("library.detail.deleteDoc.countUnknown")}
        </p>
        {error && (
          <InlineMessage
            tone={error.kind === "busy" ? "warning" : "danger"}
            title={t(
              error.kind === "busy"
                ? "library.detail.deleteDoc.busyTitle"
                : "library.detail.deleteDoc.errorTitle"
            )}
          >
            {error.detail}
          </InlineMessage>
        )}
      </div>
    </Dialog>
  );
}
