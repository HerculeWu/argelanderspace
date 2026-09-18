import { type ChangeEvent, type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Job } from "@argelanderspace/contracts";
import { Icon } from "../lib/icons";
import { attachArxiv, patchRef, uploadLatexZip } from "../api/library";
import { deletePaperDoc, fetchAnnotations } from "../api/annotations";
import { onJobEvent } from "../api/ws";
import i18n from "../i18n";
import { Modal } from "../plan/atoms";
import { cgKfmt } from "../graph/graphPhysics";
import { AbstractHtml } from "../lib/abstract";
import type { GraphNode, LibraryRef } from "./types";

function Tag({ children }: { children: string }) {
  return <span className="tag mono">{children.replace(/^#/, "")}</span>;
}

const RESOLVED_LABEL: Record<string, string> = {
  ads: "NASA ADS",
  crossref: "Crossref",
  openalex: "OpenAlex",
};

// Tone colors for the source pill.
const PILL_GREEN = "oklch(0.74 0.13 158)", PILL_AMBER = "oklch(0.80 0.13 78)", PILL_BLUE = "oklch(0.70 0.12 235)";

function pillStyle(color: string): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "1px 7px",
    borderRadius: 999,
    fontSize: 11,
    lineHeight: "16px",
    color,
    border: `1px solid color-mix(in oklch, ${color} 45%, transparent)`,
    background: `color-mix(in oklch, ${color} 12%, transparent)`,
  };
}

// Where the full text CAME FROM (a fact), with a tone color. Stage 15 (D17):
// the acquisition-advertising states (ready / blocked / unknown — e.g. a
// publisher-HTML "available" label) are gone from the UI; the pill only
// reports `ingested from` or `needs upload`, and the arXiv-available state is
// a clickable action in the files tab instead. Returns null for the removed
// states.
function sourceBadge(r: LibraryRef): { text: string; color: string } | null {
  const lbl = r.sourceLabel || "";
  if (r.doc_id || r.pdf)
    return {
      text: lbl
        ? i18n.t("library.detail.source.ingestedFrom", { label: lbl })
        : i18n.t("library.detail.source.ingested"),
      color: PILL_GREEN,
    };
  if (r.needs_upload) return { text: i18n.t("library.detail.source.needsUpload"), color: PILL_AMBER };
  return null;
}

function SourcePill({ r }: { r: LibraryRef }) {
  const b = sourceBadge(r);
  if (b === null) return null;
  return (
    <span className="src-pill mono" style={pillStyle(b.color)}>
      {b.text}
    </span>
  );
}

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

export function RefDetail({
  r,
  node,
  onClose,
  onOpenDoc,
  onReload,
  onDocDeleted,
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
  /**
   * Stage 14 (D1/D9): the "explore related papers" entry — enabled only with
   * a usable ADS bibcode AND a live backend (no demo/fixture exploration).
   */
  explore?: { bibcode: string | null; live: boolean; onExplore: (bibcode: string) => void };
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState("meta");
  const [copied, setCopied] = useState(false);
  // async upload (202 + job): progress arrives over /ws; `uploadJob` is the
  // queued/running job, null once a terminal state was handled. The ref mirror
  // lets the WS subscriber see the latest value; `seenJobs` remembers every
  // event snapshot so a job.* frame that beats the upload POST's fetch
  // response (fast failure) is never overwritten by the stale 202 body.
  const [uploadJob, setUploadJobState] = useState<Job | null>(null);
  const uploadJobRef = useRef<Job | null>(null);
  const seenJobs = useRef(new Map<string, Job>());
  const [uploadErr, setUploadErr] = useState<string | null>(null);
  // Stage 15: this work's arXiv fetch job (kind "ingest", payload.workId) —
  // the same adoption/race rules as the upload job. `arxivErrCode` carries
  // the server's machine-readable failure class ("arxiv_pdf_only" → the
  // bilingual PDF-only guidance).
  const [arxivJob, setArxivJobState] = useState<Job | null>(null);
  const arxivJobRef = useRef<Job | null>(null);
  const [arxivErr, setArxivErr] = useState<string | null>(null);
  const [arxivErrCode, setArxivErrCode] = useState<string | null>(null);
  const [settingMain, setSettingMain] = useState(false);
  const [mainErr, setMainErr] = useState<string | null>(null);
  // Stage 8 §8 document delete: the doc id pending confirmation, plus the
  // in-flight DELETE state. A busy 409 keeps the dialog open with its message
  // (the ingest task ends on its own; the user retries).
  const [delDoc, setDelDoc] = useState<string | null>(null);
  const [delBusy, setDelBusy] = useState(false);
  const [delErr, setDelErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cited = node?.c ?? r.citedBy;

  // All reader docs of this work (Stage 7 MS3: parallel versions). The main
  // doc is the payload's doc_id (= doc_ids[0]); older versions stay listed.
  const versions = r.doc_ids ?? (r.doc_id ? [r.doc_id] : []);
  const mainDoc = r.doc_id ?? versions[0];
  const extraVersions = versions.filter((d) => d !== mainDoc);
  const hasUploadDoc = versions.some((d) => d.startsWith("upload-"));
  // Stage 15 (D7/D17): the docless source row carries the CLICKABLE arXiv
  // action when the work has an arXiv id, else the factual pill (needs
  // upload) — or nothing at all when neither applies (acquisition ads gone).
  const doclessBadge = mainDoc === undefined ? sourceBadge(r) : null;

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
    setDelDoc(null);
    setDelErr(null);
    setDelBusy(false);
  }, [r.id, setUploadJob, setArxivJob]);

  const onSetMainDoc = async (docId: string) => {
    setMainErr(null);
    setSettingMain(true);
    const ok = await patchRef(r.id, { doc_id: docId });
    setSettingMain(false);
    if (ok) onReload?.();
    else setMainErr(i18n.t("library.detail.files.setMainFailed"));
  };

  const onConfirmDelete = async (docId: string) => {
    setDelBusy(true);
    setDelErr(null);
    const res = await deletePaperDoc(docId);
    setDelBusy(false);
    if (res.ok) {
      setDelDoc(null);
      onDocDeleted?.(docId, versions.filter((d) => d !== docId));
      onReload?.();
    } else if (res.busy) {
      setDelErr(i18n.t("library.detail.deleteDoc.busy"));
    } else if (res.missing) {
      // already deleted elsewhere: the desired end state — close the dialog
      // and reload the library instead of showing an error
      setDelDoc(null);
      onReload?.();
    } else {
      setDelErr(res.detail);
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

  const onPickFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setUploadErr(null);
    const job = await uploadLatexZip(r.id, file);
    if (!job) {
      setUploadErr(failMsg(null));
      return;
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
  }, [r.id]);
  useEffect(
    () =>
      onJobEvent((job) => {
        if (jobWorkId(job) !== r.id) return;
        seenJobs.current.set(job.id, job);
        if (job.kind === "upload") {
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

  // react to the terminal states (kept out of the subscriber, which must stay pure)
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
  const onFetchArxiv = async () => {
    setArxivErr(null);
    setArxivErrCode(null);
    const job = await attachArxiv(r.id);
    if (!job) {
      setArxivErr(arxivFailMsg(null));
      return;
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

  const copyBib = async () => {
    try {
      await navigator.clipboard.writeText(bibtexOf(r));
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be blocked */
    }
  };

  return (
    <div className="ref-detail view-in">
      <div className="ref-detail-scroll">
      <div className="ref-detail-head">
        <div className="ref-type-badge">{r.type === "conf" ? t("library.detail.typeConf") : t("library.detail.typeArticle")}</div>
        <div className="ref-detail-actions">
          <button className="btn icon ghost" title={t("library.detail.openInDoc")} onClick={() => onOpenDoc(r.doc_id)}>
            <Icon name="file-text" cls="ico-sm" />
          </button>
          <button className="btn icon ghost" title={r.star ? t("library.detail.starred") : t("library.detail.star")}>
            <Icon name="star" cls="ico-sm" />
          </button>
          <button className="btn icon ghost" onClick={onClose}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
      </div>
      <div className="ref-detail-title serif">{r.title}</div>
      <div className="ref-detail-auth">{r.authors}</div>
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
      <div className="ref-detail-meta" style={{ marginTop: 6, gap: 8, flexWrap: "wrap" }}>
        <SourcePill r={r} />
        {r.resolvedBy && RESOLVED_LABEL[r.resolvedBy] && (
          <span className="mono" style={{ fontSize: 11, opacity: 0.65 }}>
            {t("library.detail.resolvedBy", { source: RESOLVED_LABEL[r.resolvedBy] })}
          </span>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".zip"
        style={{ display: "none" }}
        onChange={onPickFile}
      />
      <div className="ref-detail-tabs">
        {TABS.map((k) => (
          <button key={k} className={"rdt" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>
            {t(TAB_LABEL_KEYS[k])}
          </button>
        ))}
      </div>
      <div className="ref-detail-body">
        {tab === "meta" && (
          <div className="ref-meta-list">
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
          <div className="ref-abstract">
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
          <div className="bib-block">
            <button className="bib-copy" onClick={copyBib}>
              <Icon name={copied ? "check" : "copy"} cls="ico-sm" />
              {copied ? t("common.copied") : t("common.copy")}
            </button>
            <pre className="mono">{bibtexOf(r)}</pre>
          </div>
        )}
        {tab === "notes" &&
          (r.note ? (
            <div className="ref-abstract ref-note">
              <p>{r.note}</p>
            </div>
          ) : (
            <div className="placeholder-text ph-note">
              <span className="mono">{t("library.detail.notesEmpty")}</span>
            </div>
          ))}
        {tab === "files" && (
          <div className="ref-files">
            {mainDoc && (
              <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                <button
                  className="ref-file"
                  style={{ flex: 1 }}
                  title={t("library.detail.files.openMain")}
                  onClick={() => onOpenDoc(mainDoc)}
                >
                  <Icon name="file-text" cls="ico-sm" />
                  <span className="mono">{r.cite}</span>
                  <span className="ref-file-ok">
                    {extraVersions.length > 0 ? t("library.detail.files.mainBadge") : t("library.detail.source.ingested")}
                  </span>
                  <Icon name="arrow-up-right" cls="ico-sm" />
                </button>
                {mainDoc.startsWith("arxiv-") && (
                  <button
                    className="btn"
                    data-testid="arxiv-refetch-main"
                    disabled={arxivJob !== null}
                    title={t("library.detail.files.refetchArxivTitle")}
                    onClick={() => void onFetchArxiv()}
                  >
                    {t("library.detail.files.refetchArxiv")}
                  </button>
                )}
                <button
                  className="btn icon"
                  title={t("library.detail.files.deleteDoc")}
                  onClick={() => {
                    setDelErr(null);
                    setDelDoc(mainDoc);
                  }}
                >
                  <Icon name="trash-2" cls="ico-sm" />
                </button>
              </div>
            )}
            {extraVersions.map((d) => (
              <div key={d} style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
                <button
                  className="ref-file"
                  style={{ flex: 1 }}
                  title={t("library.detail.files.openOld")}
                  onClick={() => onOpenDoc(d)}
                >
                  <Icon name="file-text" cls="ico-sm" />
                  <span className="mono">{d}</span>
                  <Icon name="arrow-up-right" cls="ico-sm" />
                </button>
                <button
                  className="btn"
                  disabled={settingMain}
                  title={t("library.detail.files.setMainTitle")}
                  onClick={() => onSetMainDoc(d)}
                >
                  {t("library.detail.files.setMain")}
                </button>
                {d.startsWith("arxiv-") && (
                  <button
                    className="btn"
                    data-testid={`arxiv-refetch-${d}`}
                    disabled={arxivJob !== null}
                    title={t("library.detail.files.refetchArxivTitle")}
                    onClick={() => void onFetchArxiv()}
                  >
                    {t("library.detail.files.refetchArxiv")}
                  </button>
                )}
                <button
                  className="btn icon"
                  title={t("library.detail.files.deleteDoc")}
                  onClick={() => {
                    setDelErr(null);
                    setDelDoc(d);
                  }}
                >
                  <Icon name="trash-2" cls="ico-sm" />
                </button>
              </div>
            ))}
            {mainErr && (
              <div className="mono" style={{ fontSize: 11, color: "oklch(0.70 0.16 25)" }}>
                {mainErr}
              </div>
            )}
            {!mainDoc && (r.arxiv_id || doclessBadge) && (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="mono" style={{ fontSize: 11, opacity: 0.65 }}>{t("library.detail.files.sourceLabel")}</span>
                {r.arxiv_id ? (
                  // Stage 15 (D11): the acquirable arXiv source is a CLICKABLE
                  // pill — the existing pill style, not a button — queueing
                  // the fetch job; progress unfolds right below.
                  <span
                    className="src-pill mono"
                    data-testid="arxiv-fetch"
                    onClick={arxivJob === null ? () => void onFetchArxiv() : undefined}
                    style={{
                      ...pillStyle(PILL_BLUE),
                      cursor: arxivJob === null ? "pointer" : "default",
                      opacity: arxivJob === null ? 1 : 0.6,
                    }}
                  >
                    {t("library.detail.source.readyArxiv")}
                  </span>
                ) : (
                  <SourcePill r={r} />
                )}
              </div>
            )}
            {(arxivJob !== null || arxivErr !== null) && (
              <div
                className="mono"
                style={{ fontSize: 11, lineHeight: 1.5, display: "flex", flexDirection: "column", gap: 4 }}
              >
                {arxivJob && (
                  <span style={{ opacity: 0.75, display: "inline-flex", alignItems: "center", gap: 4 }}>
                    <Icon name="loader" cls="ico-sm spin" />
                    {arxivJob.status === "queued"
                      ? t("library.detail.arxiv.queued")
                      : (arxivJob.progress[arxivJob.progress.length - 1]?.message ??
                        t("library.detail.arxiv.ingesting"))}
                  </span>
                )}
                {arxivErr && (
                  <>
                    <span style={{ color: "oklch(0.70 0.16 25)" }}>{arxivErr}</span>
                    {arxivErrCode === "arxiv_pdf_only" && (
                      <span style={{ opacity: 0.75 }}>{t("library.detail.arxiv.pdfOnlyHint")}</span>
                    )}
                    <span
                      data-testid="arxiv-retry"
                      onClick={() => void onFetchArxiv()}
                      style={{ cursor: "pointer", textDecoration: "underline", opacity: 0.8, width: "fit-content" }}
                    >
                      {t("library.detail.arxiv.retry")}
                    </span>
                  </>
                )}
              </div>
            )}
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                ...(mainDoc ? { marginTop: 8 } : {}),
              }}
            >
              <button
                className="btn"
                disabled={uploadJob !== null}
                onClick={() => fileInput.current?.click()}
                style={{ justifyContent: "center" }}
              >
                {uploadJob ? (
                  <>
                    <Icon name="loader" cls="ico-sm spin" />
                    {uploadJob.status === "queued"
                      ? t("library.detail.upload.queued")
                      : (uploadJob.progress[uploadJob.progress.length - 1]?.message ??
                        t("library.detail.upload.ingesting"))}
                  </>
                ) : (
                  <>
                    <Icon name="file-up" cls="ico-sm" />
                    {hasUploadDoc
                      ? t("library.detail.upload.reupload")
                      : mainDoc
                        ? t("library.detail.upload.newVersion")
                        : t("library.detail.upload.initial")}
                  </>
                )}
              </button>
              <div className="mono" style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5 }}>
                {hasUploadDoc
                  ? t("library.detail.upload.hintReupload")
                  : mainDoc
                    ? t("library.detail.upload.hintNewVersion")
                    : r.needs_upload
                      ? t("library.detail.upload.hintNeedsUpload")
                      : t("library.detail.upload.hintDefault")}
              </div>
              {uploadErr && (
                <div className="mono" style={{ fontSize: 11, color: "oklch(0.70 0.16 25)" }}>
                  {uploadErr}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      </div>
      {explore && (
        <div className="detail-footer">
          <button
            className="btn primary large"
            data-testid="explore-paper"
            disabled={!explore.bibcode || !explore.live}
            title={
              !explore.live
                ? t("explore.demoOff")
                : !explore.bibcode
                  ? t("explore.noBibcode")
                  : t("explore.entry")
            }
            onClick={() => explore.bibcode && explore.onExplore(explore.bibcode)}
          >
            <Icon name="compass" cls="ico-sm" />
            {t("explore.entry")}
          </button>
          {(!explore.live || !explore.bibcode) && (
            <div className="detail-footer-note">
              {!explore.live ? t("explore.demoOff") : t("explore.noBibcode")}
            </div>
          )}
        </div>
      )}
      {delDoc && (
        <DeleteDocDialog
          docId={delDoc}
          busy={delBusy}
          error={delErr}
          onCancel={() => setDelDoc(null)}
          onConfirm={onConfirmDelete}
        />
      )}
    </div>
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
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  docId: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (docId: string) => void;
}) {
  const { t } = useTranslation();
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    setCount(null);
    void fetchAnnotations(docId).then((r) => {
      if (alive) setCount(r.ok ? r.file.annotations.length : null);
    });
    return () => {
      alive = false;
    };
  }, [docId]);

  return (
    <Modal
      title={t("library.detail.deleteDoc.title")}
      sub={docId}
      width={420}
      onClose={onCancel}
      footer={
        <>
          <button className="btn" onClick={onCancel}>
            {t("common.cancel")}
          </button>
          <button className="btn plan-danger" disabled={busy} onClick={() => onConfirm(docId)}>
            {busy ? t("library.detail.deleteDoc.deleting") : t("library.detail.deleteDoc.confirm")}
          </button>
        </>
      }
    >
      <div className="plan-modal-warning">
        {count === null
          ? t("library.detail.deleteDoc.warningUnknown")
          : t("library.detail.deleteDoc.warningCount", { count })}
      </div>
      {error && (
        <div className="mono" style={{ fontSize: 12, color: "oklch(0.70 0.16 25)" }}>
          {error}
        </div>
      )}
    </Modal>
  );
}
