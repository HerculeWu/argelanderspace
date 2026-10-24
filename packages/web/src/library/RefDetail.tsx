import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type Job, LIBRARY_DETAIL_TABS, libraryRefBibtex } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";
import { type DocProvenance, fetchDocProvenance, patchRef } from "../api/library";
import { deletePaperDoc, fetchAnnotations } from "../api/annotations";
import i18n from "../i18n";
import { ActionButton, Badge, Dialog, InlineMessage, Tabs, TooltipBubble, useSingleTooltip } from "../ui";
import { cgKfmt } from "../graph/graphPhysics";
import { AbstractHtml } from "../lib/abstract";
import { WorkArgumentEntry } from "../argument/ArgumentEntry";
import { arxivAcquisitionDocId, uploadAcquisitionDocId } from "./acquisitionTargets";
import { MergeNoteList } from "./MergeNotes";
import { useTextDocCreation } from "./text-doc-creation";
import { useWorkShelf } from "../shelf/AddToShelf";
import { useLeaveQuestionOpen } from "../argelander/leave-dialog";
import type { GraphNode, LibraryRef } from "./types";
import {
  type AcquisitionFlow,
  type AcquisitionMethod,
  type DeleteCount,
  loadDeleteCount,
  reduceAcquisitionRisk,
  useWorkJobs,
} from "./work-jobs";

function Tag({ children }: { children: string }) {
  return <span className="tag mono">{children.replace(/^#/, "")}</span>;
}

const RESOLVED_LABEL: Record<string, string> = {
  ads: "NASA ADS",
  crossref: "Crossref",
  openalex: "OpenAlex",
};

const bibtexOf = libraryRefBibtex;

const TABS = LIBRARY_DETAIL_TABS;
export type DetailTab = (typeof TABS)[number];
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

const isJobActive = (job: Job | null): boolean => job?.status === "queued" || job?.status === "running";

/**
 * The Doc row's three-dots disclosure toggle. It must stay the immediate `<summary>` of its `<details>`, so the shared
 * Tooltip (which wraps its child in a span) cannot wrap it; the same tooltip markup and classes are rendered inside
 * the summary instead and shown on pointer hover and on keyboard focus, and dismissed on activation like the shared
 * Tooltip, so it never covers the opened action row.
 */
function DocActionsToggle({ label }: { label: string }) {
  const id = `tooltip-${useId().replace(/:/g, "")}`;
  const { open, reveal, dismiss } = useSingleTooltip();
  const summaryRef = useRef<HTMLElement>(null);
  return (
    <summary
      ref={summaryRef}
      data-ui="toggle-doc-actions"
      aria-label={label}
      aria-describedby={id}
      data-tooltip-open={open || undefined}
      onPointerEnter={reveal}
      onPointerLeave={dismiss}
      onPointerDown={dismiss}
      onClick={dismiss}
      onFocus={reveal}
      onBlur={dismiss}
      onKeyDown={(event) => { if (event.key === "Escape") dismiss(); }}
    >
      <Icon name="ellipsis" cls="ico-sm" />
      <TooltipBubble id={id} open={open} anchorRef={summaryRef}>{label}</TooltipBubble>
    </summary>
  );
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
  argumentGraph,
  tab: controlledTab,
  onTabChange,
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
  onBeforeDocDelete?: (docId: string) => boolean | Promise<boolean>;
  /**
   * Stage 14 (D1/D9): the "explore related papers" entry — enabled only with
   * a usable ADS bibcode AND a live backend (no demo/fixture exploration).
   */
  explore?: { bibcode: string | null; live: boolean; onExplore: (bibcode: string) => void };
  /** Ticket 04: the argument graph entry, beside the explore entry (works without a bibcode or a Doc). */
  argumentGraph?: { live: boolean; onOpen: (workId: string) => void };
  tab?: DetailTab;
  onTabChange?: (tab: DetailTab) => void;
}) {
  const { t } = useTranslation();
  // The tab may be driven from outside (the Library page publishes it and Copilot can switch it).
  const [ownTab, setOwnTab] = useState<DetailTab>("meta");
  const tab = controlledTab ?? ownTab;
  const setTab = onTabChange ?? setOwnTab;
  const [copyStatus, setCopyStatus] = useState<{
    target: "cite" | "bib";
    state: "copied" | "failed";
  } | null>(null);
  const copyStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyRequestId = useRef(0);
  const activeWorkId = useRef(r.id);
  activeWorkId.current = r.id;
  // The Work's acquisition jobs (LaTeX zip, PDF upload, arXiv source, arXiv PDF) and the Work session that drops
  // late responses after a switch; progress arrives over /ws (see work-jobs.ts).
  const jobs = useWorkJobs(r.id, { onReload });
  const workSession = jobs.session;
  const isCurrentWorkSession = workSession.isCurrent;
  const zipUpload = jobs.kinds("zip");
  const pdfUpload = jobs.kinds("pdf");
  const arxivSource = jobs.kinds("arxiv");
  const arxivPdf = jobs.kinds("arxivPdf");
  const uploadJob = zipUpload.job;
  const uploadErr = zipUpload.error?.message ?? null;
  const pdfUploadJob = pdfUpload.job;
  const pdfUploadError = pdfUpload.error?.message ?? null;
  const pdfUploadBusy = pdfUpload.submitting;
  // Stage 15: `arxivErrCode` carries the server's machine-readable failure class ("arxiv_pdf_only" → the bilingual
  // PDF-only guidance).
  const arxivJob = arxivSource.job;
  const arxivErr = arxivSource.error?.message ?? null;
  const arxivErrCode = arxivSource.error?.extra ?? null;
  const arxivPdfJob = arxivPdf.job;
  const arxivPdfError = arxivPdf.error?.message ?? null;
  const [settingMain, setSettingMain] = useState(false);
  const [mainErr, setMainErr] = useState<string | null>(null);
  // Text Doc creation (ticket 25): one in-flight request; the new Doc opens on its source editor (text-doc-creation.ts).
  const textDoc = useTextDocCreation(r.id, workSession, onOpenDoc);
  // The Shelf's parts of the detail (shelf ticket 05).
  const shelf = useWorkShelf(r);
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
  /** The leave guard's question about the open Doc is showing: the delete dialog is out of the way meanwhile. */
  const [leaveAsking, setLeaveAsking] = useState(false);
  // Also while ANY leave question is open: a question of ours superseded by another one (a browser Back) must not bring
  // this dialog back underneath the question that now carries the Back.
  const leaveQuestionOpen = useLeaveQuestionOpen();
  useEffect(() => () => { delRequestId.current += 1; }, []);
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
    setAcquisition((current) => reduceAcquisitionRisk(current, { type: "payload", versions, arxivTarget }));
  }, [arxivTarget, versionsKey]);

  // Any fresh payload for the same Work may reflect an in-place replacement
  // even when doc_ids is unchanged. A replacement risk snapshot is therefore
  // invalidated and fetched again instead of retaining prior consent.
  useEffect(() => {
    if (riskPayload.current === r) return;
    riskPayload.current = r;
    setAcquisition((current) => reduceAcquisitionRisk(current, { type: "refresh", versions }));
  }, [r, versionsKey]);

  useEffect(() => {
    const flow = acquisition;
    if (!flow || flow.method !== "upload" || flow.risk.state !== "resolving") return;
    let current = true;
    const workId = r.id;
    void uploadAcquisitionDocId(workId)
      .then((expectedDocId) => {
        if (!current) return;
        setAcquisition((latest) =>
          workSession.current().workId !== workId
            ? latest
            : reduceAcquisitionRisk(latest, { type: "target-resolved", flowId: flow.id, expectedDocId, versions })
        );
      })
      .catch(() => {
        if (!current) return;
        setAcquisition((latest) => reduceAcquisitionRisk(latest, { type: "target-failed", flowId: flow.id }));
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
      setAcquisition((latest) => reduceAcquisitionRisk(latest, { type: "annotations", flow, result }));
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

  // A known queued/running zip upload or arXiv source job targeting this Work
  // conservatively blocks a replacement. Once that job settles, take a fresh
  // annotation snapshot.
  useEffect(() => {
    setAcquisition((current) =>
      reduceAcquisitionRisk(current, {
        type: "jobs",
        uploadActive: isJobActive(uploadJob),
        arxivActive: isJobActive(arxivJob),
      })
    );
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

  // switching references drops the other ref's local state (the job state resets in useWorkJobs)
  useEffect(() => {
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
  }, [r.id]);

  const onSetMainDoc = async (docId: string) => {
    const session = workSession.current();
    setMainErr(null);
    setSettingMain(true);
    const ok = await patchRef(session.workId, { doc_id: docId });
    if (!isCurrentWorkSession(session)) return;
    setSettingMain(false);
    if (ok) onReload?.();
    else setMainErr(i18n.t("library.detail.files.setMainFailed"));
  };

  const onConfirmDelete = async (docId: string) => {
    if (delBusyRef.current) return;
    const requestId = ++delRequestId.current;
    // Deleting the open Doc asks the Doc views' leave guard, which may answer later with its own dialog. Two modal
    // dialogs must never be open at once (focus fights, and Enter/Escape would cancel one while the other stays), so
    // this delete dialog steps aside while the question is open. Only a "discard" for this same, still pending delete
    // goes on; "keep editing" brings the delete dialog back, and a Work change or unmount while asking voids it.
    const verdict = onBeforeDocDelete?.(docId);
    if (verdict === false) return;
    if (verdict !== undefined && verdict !== true) {
      delBusyRef.current = true;
      setLeaveAsking(true);
      let ok = false;
      try { ok = await verdict; } finally { delBusyRef.current = false; setLeaveAsking(false); }
      if (!ok || requestId !== delRequestId.current) return;
    }
    delBusyRef.current = true;
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
    const session = workSession.current();
    submittingAcquisitionFlows.current.add(flow.id);
    setAcquisition((current) =>
      current?.id === flow.id
        ? { ...current, busy: true, fileError: null, error: null }
        : current
    );
    const accepted =
      flow.method === "pdf"
        ? await arxivPdf.start()
        : flow.method === "arxiv"
          ? await arxivSource.start()
          : flow.method === "pdf-upload"
            ? await pdfUpload.start(flow.file as File)
            : await zipUpload.start(flow.file as File);
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

  useEffect(
    () => () => {
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
            {shelf.button}
            <ActionButton
              mode="icon"
              iconName="copy"
              variant="ghost"
              label={t("library.detail.copy.cite")}
              tooltip={t("library.detail.copy.cite")}
              data-ui="copy-cite-key"
              iconSize="small"
              onClick={() => void copyText("cite", r.cite)}
            />
            <ActionButton
              mode="icon"
              iconName="x"
              variant="ghost"
              label={t("common.close")}
              tooltip={t("common.close")}
              data-ui="close-work-detail"
              iconSize="small"
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
              if (mainDoc) {
                onOpenDoc(mainDoc);
                return;
              }
              setTab("files");
              // A running acquisition already reports in the Full text tab; otherwise open the dialog itself.
              if (uploadJob === null && arxivJob === null && arxivPdfJob === null && !pdfUploadBusy && pdfUploadJob === null) {
                openAcquisition();
              }
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
        {shelf.feedback}
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
              <ActionButton mode="icon" iconSize="small" iconName="copy" data-ui="copy-work-bibtex" variant="ghost" label={t("library.detail.copy.bib")} tooltip={t("library.detail.copy.bib")} onClick={() => void copyText("bib", bibtexOf(r))} />
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
                mode="text"
                data-ui="create-text-doc"
                variant="ghost"
                busy={textDoc.busy}
                busyLabel={t("library.detail.files.creatingText")}
                label={t("library.detail.files.createText")}
                tooltip={t("library.detail.files.createTextTip")}
                onClick={textDoc.create}
              >
                {t("library.detail.files.createText")}
              </ActionButton>
              <ActionButton
                mode="icon"
                iconSize="small"
                iconName="file-up"
                data-ui="gather-doc"
                variant="ghost"
                disabled={uploadJob !== null || arxivJob !== null || arxivPdfJob !== null || pdfUploadBusy || pdfUploadJob !== null}
                label={t(versions.length === 0 ? "library.detail.acquisition.openGet" : "library.detail.acquisition.openManage")}
                tooltip={t(versions.length === 0 ? "library.detail.acquisition.openGet" : "library.detail.acquisition.openManage")}
                onClick={() => openAcquisition()}
              />
            </div>
            {(jobs.mergeNotices.length > 0 || uploadJob || arxivJob || arxivPdfJob || uploadErr || arxivErr || arxivPdfError || mainErr || textDoc.error || pdfUploadJob || pdfUploadError || shelf.ingestPrompt) && (
              <div className="ref-task-messages" data-ui="acquisition-status">
                {shelf.ingestPrompt}
                {jobs.mergeNotices.map((notice) => (
                  <div key={notice.jobId} className="merge-note-bar" data-ui="task-graph-merges" data-ui-key={notice.jobId}>
                    <div className="merge-note-bar-head">
                      <strong>{t("library.graphMerge.title")}</strong>
                      <ActionButton mode="icon" iconSize="small" iconName="x" data-ui="dismiss-task-graph-merges" variant="ghost" label={t("library.graphMerge.dismiss")} tooltip={t("library.graphMerge.dismiss")} onClick={() => jobs.dismissMergeNotice(notice.jobId)} />
                    </div>
                    <MergeNoteList notes={notice.notes} uiId="task-graph-merge" />
                  </div>
                ))}
                {arxivPdfJob && (
                  <InlineMessage title={t(arxivPdfJob.status === "queued" ? "library.detail.jobs.queued" : "library.detail.arxivPdf.fetching")}>
                    {arxivPdfJob.status === "queued" ? t("library.detail.jobs.queueHelp") : arxivPdfJob.progress[arxivPdfJob.progress.length - 1]?.message ?? t("library.detail.arxivPdf.fetching")}
                  </InlineMessage>
                )}
                {arxivPdfError && (
                  <InlineMessage uiId="arxiv-pdf-error" tone="danger" title={t("library.detail.arxivPdf.failedTitle")}>
                    {!arxivPdf.dismissed && <ActionButton mode="icon" iconSize="small" iconName="x" data-ui="dismiss-arxiv-pdf-error" variant="ghost" label={t("library.detail.arxivPdf.dismiss")} tooltip={t("library.detail.arxivPdf.dismiss")} onClick={arxivPdf.dismiss} />}
                    <p>{arxivPdf.dismissed ? t("library.detail.arxivPdf.failedSummary") : arxivPdfError}</p>
                    <ActionButton mode="text" data-ui="retry-arxiv-pdf" variant="ghost" label={t("library.detail.arxivPdf.retry")} tooltip={t("library.detail.arxivPdf.retry")} onClick={() => openAcquisition("pdf")}>{t("library.detail.arxivPdf.retry")}</ActionButton>
                  </InlineMessage>
                )}
                {pdfUploadJob && (
                  <InlineMessage title={t(pdfUploadJob.status === "queued" ? "library.detail.jobs.queued" : "library.detail.pdfUpload.uploading")}>
                    {pdfUploadJob.status === "queued" ? t("library.detail.jobs.queueHelp") : pdfUploadJob.progress[pdfUploadJob.progress.length - 1]?.message ?? t("library.detail.pdfUpload.uploading")}
                  </InlineMessage>
                )}
                {pdfUploadError && (pdfUpload.dismissed ? (
                  <InlineMessage tone="danger" title={t("library.detail.pdfUpload.failedTitle")}>
                    <p>{t("library.detail.pdfUpload.failedSummary")}</p>
                    <ActionButton mode="text" data-ui="retry-pdf-upload" variant="ghost" label={t("library.detail.pdfUpload.retry")} tooltip={t("library.detail.pdfUpload.retry")} onClick={() => openAcquisition("pdf-upload")}>{t("library.detail.pdfUpload.retry")}</ActionButton>
                  </InlineMessage>
                ) : (
                  <InlineMessage tone="danger" title={t("library.detail.pdfUpload.failedTitle")}>
                    <ActionButton mode="icon" iconSize="small" iconName="x" data-ui="dismiss-pdf-upload-error" variant="ghost" label={t("library.detail.pdfUpload.dismiss")} tooltip={t("library.detail.pdfUpload.dismiss")} onClick={pdfUpload.dismiss} />
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
                    {!zipUpload.dismissed && <ActionButton mode="icon" iconSize="small" iconName="x" data-ui="dismiss-latex-upload-error" variant="ghost" label={t("library.detail.upload.dismiss")} tooltip={t("library.detail.upload.dismiss")} onClick={zipUpload.dismiss} />}
                    <p>{zipUpload.dismissed ? t("library.detail.upload.failedSummary") : uploadErr}</p>
                    {!zipUpload.dismissed && mainDoc && <p>{t("library.detail.jobs.existingDocumentLink")}</p>}
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
                    {!arxivSource.dismissed && <ActionButton mode="icon" iconSize="small" iconName="x" data-ui="dismiss-arxiv-source-error" variant="ghost" label={t("library.detail.arxiv.dismiss")} tooltip={t("library.detail.arxiv.dismiss")} onClick={arxivSource.dismiss} />}
                    <p>{arxivSource.dismissed ? t("library.detail.arxiv.failedSummary") : arxivErr}</p>
                    {!arxivSource.dismissed && arxivErrCode === "arxiv_pdf_only" && (
                      <p>{t("library.detail.arxiv.pdfOnlyHint")}</p>
                    )}
                    {!arxivSource.dismissed && mainDoc && <p>{t("library.detail.jobs.existingDocumentLink")}</p>}
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
                {textDoc.error && <InlineMessage uiId="create-text-doc-error" tone="danger" title={t("library.detail.files.createTextFailed")}>{textDoc.error}</InlineMessage>}
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
                      provenance === "text"
                        ? "library.detail.files.sourceText"
                        : provenance === "arxiv-pdf"
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
                        <details
                          className="ref-document-actions"
                          data-ui="doc-actions"
                          onKeyDown={(event) => {
                            // Esc closes the open row and hands the focus back to the toggle (ticket 33 follow-up).
                            if (event.key !== "Escape" || !event.currentTarget.open) return;
                            event.preventDefault();
                            event.currentTarget.open = false;
                            event.currentTarget.querySelector<HTMLElement>("summary")?.focus();
                          }}
                        >
                          <DocActionsToggle label={t("library.detail.files.actions")} />
                          <div className="ref-document-action-list" data-ui="doc-action-list">
                            <ActionButton mode="icon" iconSize="small" iconName="book-open" data-ui="open-doc" variant="ghost" label={t("library.detail.files.openDoc")} tooltip={t("library.detail.files.openDoc")} onClick={() => onOpenDoc(docId)} />
                            {!isMain && (
                              <ActionButton
                                mode="icon"
                                iconSize="small"
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
                                mode="icon"
                                iconName="refresh-cw"
                                variant="ghost"
                                data-ui="refresh-arxiv-source"
                                data-testid={isMain ? "arxiv-refetch-main" : `arxiv-refetch-${docId}`}
                                label={t("library.detail.files.refetchArxivTitle")}
                                tooltip={t("library.detail.files.refetchArxivTitle")}
                                disabled={arxivJob !== null}
                                onClick={() => openAcquisition("arxiv")}
                              />
                            )}
                            {docId === expectedUploadTarget && (
                              <ActionButton
                                mode="icon"
                                iconName="upload"
                                variant="ghost"
                                data-ui="replace-upload-source"
                                label={t("library.detail.files.replaceUpload")}
                                tooltip={t("library.detail.files.replaceUpload")}
                                disabled={uploadJob !== null}
                                onClick={() => openAcquisition("upload")}
                              />
                            )}
                            <ActionButton
                              mode="icon"
                              iconName="trash-2"
                              variant="ghost"
                              className="danger-text"
                              data-ui="delete-doc"
                              label={t("library.detail.files.deleteDoc")}
                              tooltip={t("library.detail.files.deleteDoc")}
                              onClick={() => {
                                setDelErr(null);
                                setDelDoc(docId);
                              }}
                            />
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
      {(explore || argumentGraph) && (
        <div className="detail-footer" data-ui="work-detail-footer">
          {explore && <ActionButton
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
          </ActionButton>}
          {explore && (!explore.live || !explore.bibcode) && (
            <div className="detail-footer-note">
              {!explore.live ? t("explore.demoOff") : t("explore.noBibcode")}
            </div>
          )}
          {argumentGraph && <WorkArgumentEntry workId={r.id} live={argumentGraph.live} onOpen={argumentGraph.onOpen} />}
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
      {delDoc && !leaveAsking && !leaveQuestionOpen && (
        <DeleteDocDialog
          docId={delDoc}
          pdf={docProvenance[delDoc] === "pdf"}
          text={docProvenance[delDoc] === "text"}
          busy={delBusy}
          error={delErr}
          onCancel={() => setDelDoc(null)}
          onConfirm={onConfirmDelete}
        />
      )}
      {shelf.dialog}
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
  text = false,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  docId: string;
  pdf: boolean;
  text?: boolean;
  busy: boolean;
  error: { kind: "busy" | "error"; detail: string } | null;
  onCancel: () => void;
  onConfirm: (docId: string) => void;
}) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const deleteLabel = t(busy ? "library.detail.deleteDoc.deleting" : "library.detail.deleteDoc.confirm");
  const [count, setCount] = useState<{ state: "loading" } | DeleteCount>({ state: "loading" });
  useEffect(() => {
    let current = true;
    setCount({ state: "loading" });
    void loadDeleteCount(docId, pdf ? "pdf" : text ? "text" : "other").then((result) => {
      if (current) setCount(result);
    });
    return () => {
      current = false;
    };
  }, [docId, pdf, text]);

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
          {t(pdf ? "library.detail.deleteDoc.pdfScope" : text ? "library.detail.deleteDoc.textScope" : "library.detail.deleteDoc.scope")}
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
