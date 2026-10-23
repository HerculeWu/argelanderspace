import type { Annotation, DocDescription, PdfAnnotation, ShelfAddCandidateDoc, ShelfAddResponse, ShelfDocKind, ShelfReplaceImpact } from "@argelanderspace/contracts";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchArgumentGraph } from "../api/argument-graph";
import { fetchDocDescription } from "../api/doc";
import { addToShelf, fetchAddCandidates, fetchPdfAnnotationsForShelf, lookupShelf, onShelfChanged, previewAddToShelf, refusalParts, type ShelfFailure } from "../api/shelf";
import { Icon } from "../lib/icons";
import type { LibraryRef } from "../library/types";
import { ActionButton, Badge, Dialog, InlineMessage } from "../ui";
import { useShelfAvailable } from "./availability";
import { formatBytes, shelfFailureLines, type Translate } from "./format";
import { dismissIngestPrompt, useIngestPrompt } from "./ingest-prompt";
import "./shelf.css";

/*
 * Adding a Work to the Shelf (shelf ticket 05; spec Q3, Q7, Q14, Q16, Q18; prototype AddDialog). The bibliography always
 * goes; Docs are chosen one by one (all by default; checking a text Doc checks its source PDF too); annotations one by
 * one (none by default); the argument graph and the note are off by default. When the Shelf has the same paper
 * (DOI, arXiv, OpenAlex) the add is a whole replacement, confirmed on its own card first. Every refusal keeps the
 * dialog open and says which part could not be read and what that did (contracts "Shelf" section).
 */

type DocInfo = { docId: string; description: DocDescription | null; kind: ShelfDocKind | null; bytes: number | null };
type ListedAnnotation = { id: string; kind: string; where: string; snippet: string; body: string };
type AnnotationsState =
  | { state: "loading" }
  | { state: "ok"; list: ListedAnnotation[] }
  | { state: "error" }
  | { state: "none" }
  | { state: "stale" }
  | { state: "busy" };

const docKind = (info: DocInfo): "latex" | "pdf" | "text" | "unknown" => info.kind ?? "unknown";

function latexAnnotationRow(a: Annotation, t: Translate): ListedAnnotation {
  const target = a.target;
  if (target.type === "document") return { id: a.id, kind: t("shelf.annKind.document"), where: "", snippet: "", body: a.body };
  if (target.type === "text") return { id: a.id, kind: t("shelf.annKind.text"), where: "", snippet: target.quote, body: a.body };
  const snap = target.snapshot;
  const snippet = snap.heading ?? snap.text ?? snap.caption ?? snap.latex ?? snap.body ?? "";
  return { id: a.id, kind: t(`shelf.structureKind.${target.kind}`), where: snap.number ?? "", snippet, body: a.body };
}

function pdfAnnotationRow(a: PdfAnnotation, t: Translate): ListedAnnotation {
  const text = a.kind === "highlight" || a.kind === "underline" || a.kind === "strikeout" ? a.target : null;
  const page = a.kind === "rectangle" || a.kind === "page_comment" ? a.page_index : text ? text.fragments[0]?.page_index : undefined;
  return {
    id: a.id,
    kind: t(`shelf.pdfKind.${a.kind}`),
    where: page === undefined ? "" : t("shelf.page", { n: page + 1 }),
    snippet: text ? text.quote : "",
    body: a.body,
  };
}

/** The add button's label: says so when the Shelf already holds this paper (a replacement). */
export function AddToShelfButton({ work, onOpen }: { work: LibraryRef; onOpen: () => void }) {
  const { t } = useTranslation();
  const onShelf = useOnShelf(work);
  const label = t(onShelf ? "shelf.add.buttonReplace" : "shelf.add.button");
  // Dazzle `inbox-arrow-down` (user's choice, shelf ticket 05), from icons.json by this data-ui.
  return <ActionButton mode="icon" iconName="inbox-arrow-down" variant="ghost" iconSize="small" data-ui="add-work-to-shelf" label={label} tooltip={label} onClick={onOpen} />;
}

/**
 * Whether the Shelf holds this Work's paper now: `GET /api/shelf/lookup` by its DOI / arXiv / OpenAlex id (a read;
 * the Work detail never sends a request that could write), refreshed on `shelf.changed`. A Work with none of them is
 * never the same paper as an entry.
 */
function useOnShelf(work: LibraryRef): boolean {
  const [onShelf, setOnShelf] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => onShelfChanged(() => setTick((n) => n + 1), () => setTick((n) => n + 1)), []);
  const { doi, arxiv_id: arxiv, openalex_id: openalex } = work;
  useEffect(() => {
    const controller = new AbortController();
    setOnShelf(false);
    lookupShelf({ doi, arxiv, openalex }, controller.signal)
      ?.then((answer) => {
        if (!controller.signal.aborted) setOnShelf(answer.ok && answer.value.entries.length > 0);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [doi, arxiv, openalex, tick]);
  return onShelf;
}

export interface AddedNotice {
  workId: string;
  text: string;
}

/**
 * The Work detail's Shelf parts: the head button, the dialog, the result line under the title and the ingest reminder
 * for the Full text tab. All null in the tutorial Project (and until that is known).
 */
export function useWorkShelf(work: LibraryRef): { button: ReactNode; dialog: ReactNode; feedback: ReactNode; ingestPrompt: ReactNode } {
  const { t } = useTranslation();
  const available = useShelfAvailable();
  const [open, setOpen] = useState(false);
  const [fromPrompt, setFromPrompt] = useState(false);
  const [notice, setNotice] = useState<AddedNotice | null>(null);
  const prompted = useIngestPrompt(work.id);
  useEffect(() => {
    setOpen(false);
    setNotice(null);
  }, [work.id]);
  if (!available) return { button: null, dialog: null, feedback: null, ingestPrompt: null };
  const openDialog = (viaPrompt: boolean) => {
    setNotice(null);
    setFromPrompt(viaPrompt);
    setOpen(true);
  };
  return {
    button: <AddToShelfButton work={work} onOpen={() => openDialog(false)} />,
    dialog: open ? (
      <AddToShelfDialog
        key={work.id}
        work={work}
        onClose={() => setOpen(false)}
        onAdded={(result) => {
          setOpen(false);
          if (fromPrompt) dismissIngestPrompt(work.id);
          setNotice({ workId: work.id, text: addedText(result, t) });
        }}
      />
    ) : null,
    feedback:
      notice && notice.workId === work.id ? (
        <p data-ui="add-to-shelf-feedback" className="ref-copy-status" role="status">
          {notice.text}
        </p>
      ) : null,
    ingestPrompt: prompted ? (
      <InlineMessage uiId="ingest-add-to-shelf-prompt" title={t("shelf.ingest.title")}>
        <span className="shelf-dismiss">
          <ActionButton mode="icon" iconName="x" data-ui="dismiss-ingest-shelf-prompt" variant="ghost" label={t("shelf.ingest.dismiss")} tooltip={t("shelf.ingest.dismiss")} onClick={() => dismissIngestPrompt(work.id)} />
        </span>
        <p>{t("shelf.ingest.body")}</p>
        <ActionButton mode="text" variant="ghost" data-ui="ingest-open-add-to-shelf" label={t("shelf.ingest.open")} tooltip={t("shelf.ingest.open")} onClick={() => openDialog(true)}>
          {t("shelf.ingest.open")}
        </ActionButton>
      </InlineMessage>
    ) : null,
  };
}

function addedText(result: ShelfAddResponse, t: Translate): string {
  const docs = result.carried.docs.length;
  const annotations = result.carried.docs.reduce((n, d) => n + d.annotations, 0);
  const parts = [t(result.replaced.length > 0 ? "shelf.add.replacedOk" : "shelf.add.addedOk", { docs, annotations })];
  const notCarried = result.notCarried.reduce((n, d) => n + d.annotationIds.length, 0);
  if (notCarried > 0) parts.push(t("shelf.add.notCarried", { count: notCarried }));
  if (result.archived.length > 0) parts.push(t("shelf.add.archivedOnTheWay", { docs: result.archived.map((a) => a.docId).join(", ") }));
  return parts.join(" ");
}

export function AddToShelfDialog({ work, onClose, onAdded }: { work: LibraryRef; onClose: () => void; onAdded: (result: ShelfAddResponse) => void }) {
  const { t } = useTranslation();
  const docIds = work.doc_ids ?? (work.doc_id ? [work.doc_id] : []);
  const mainDoc = work.doc_id ?? docIds[0] ?? null;
  const [descriptions, setDescriptions] = useState<Record<string, DocDescription | null>>({});
  const [candidates, setCandidates] = useState<Record<string, ShelfAddCandidateDoc>>({});
  const [annotations, setAnnotations] = useState<Record<string, AnnotationsState>>({});
  const [graphCount, setGraphCount] = useState<number | null>(null);
  const [impact, setImpact] = useState<ShelfReplaceImpact | null | undefined>(undefined);
  const [chosenDocs, setChosenDocs] = useState<string[]>(docIds);
  const [chosenAnns, setChosenAnns] = useState<Record<string, string[]>>({});
  const [graph, setGraph] = useState(false);
  const [note, setNote] = useState(false);
  const [linked, setLinked] = useState<string | null>(null);
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string[] | null>(null);
  const [changedNote, setChangedNote] = useState<string | null>(null);
  const busyRef = useRef(false);
  const backRef = useRef<HTMLButtonElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const docKey = docIds.join("\u0000");
  // The replacement card is the same dialog with other content (one modal, one focus return): its safe action, Back,
  // takes the focus when it shows; going back to the form puts it on the form's submit button, inside the dialog.
  const shownStep = useRef(step);
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    (step === "confirm" ? backRef : submitRef).current?.focus();
  }, [step]);

  // The Work's Docs changed while the dialog is open (a Doc deleted or added): the list and what is sent follow — a
  // Doc that went is no longer chosen, a new one is chosen like the others were by default.
  const knownDocs = useRef(docIds);
  useEffect(() => {
    const before = knownDocs.current;
    knownDocs.current = docIds;
    setChosenDocs((c) => docIds.filter((d) => c.includes(d) || !before.includes(d)));
  }, [docKey]);

  // What the dialog shows is read when it opens, read only: the Work's Docs with their size and current annotations
  // (the Shelf's add-candidates read: the annotations access path's peek, never its ensure, so nothing is archived
  // just because the dialog opened), a text Doc's source PDF, the argument graph's size, and whether the Shelf
  // already has this paper. A PDF Doc's annotations come from its snapshot (which never archives either).
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void previewAddToShelf({ workId: work.id, docs: [], argumentGraph: false, note: false }).then((answer) => {
      if (!signal.aborted) setImpact(answer.ok ? answer.value.impact : null);
    });
    void fetchArgumentGraph(work.id, signal)
      .then((load) => {
        if (!signal.aborted) setGraphCount(load.kind === "ok" ? load.graph.arguments.length : 0);
      })
      .catch(() => undefined);
    for (const docId of docIds) {
      setAnnotations((s) => (s[docId] ? s : { ...s, [docId]: { state: "loading" } }));
      if (docId.startsWith("text-"))
        void fetchDocDescription(docId, signal).then((result) => {
          if (!signal.aborted) setDescriptions((d) => ({ ...d, [docId]: result.ok ? result.description : null }));
        });
    }
    void fetchAddCandidates(work.id, signal)
      .then(async (answer) => {
        if (signal.aborted) return;
        if (!answer.ok) {
          setAnnotations(Object.fromEntries(docIds.map((d) => [d, { state: "error" }])));
          return;
        }
        setCandidates(Object.fromEntries(answer.value.docs.map((d) => [d.docId, d])));
        for (const d of answer.value.docs) {
          const a = d.annotations;
          if (a.state === "pdf") {
            const list = await fetchPdfAnnotationsForShelf(d.docId, signal).catch(() => null);
            if (signal.aborted) return;
            setAnnotations((s) => ({ ...s, [d.docId]: list ? { state: "ok", list: list.map((x) => pdfAnnotationRow(x, t)) } : { state: "error" } }));
            continue;
          }
          const next: AnnotationsState =
            a.state === "current"
              ? { state: "ok", list: (a.list as Annotation[]).map((x) => latexAnnotationRow(x, t)) }
              : a.state === "stale"
                ? { state: "stale" }
                : a.state === "none"
                  ? { state: "none" }
                  : a.state === "busy"
                    ? { state: "busy" }
                    : { state: "error" };
          setAnnotations((s) => ({ ...s, [d.docId]: next }));
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [work.id, docKey]);

  const docs: DocInfo[] = docIds.map((docId) => ({ docId, description: descriptions[docId] ?? null, kind: candidates[docId]?.kind ?? null, bytes: candidates[docId]?.bytes ?? null }));
  const sourcePdfOf = (info: DocInfo): string | null => (info.description?.format === "text" ? (info.description.source_pdf?.doc_id ?? null) : null);
  const toggleDoc = (docId: string, on: boolean) => {
    setError(null);
    if (on) {
      const info = docs.find((d) => d.docId === docId);
      const pdf = info ? sourcePdfOf(info) : null;
      const withPdf = pdf && docIds.includes(pdf) && !chosenDocs.includes(pdf) ? pdf : null;
      setChosenDocs((c) => [...c, docId, ...(withPdf ? [withPdf] : [])]);
      setLinked(withPdf);
    } else {
      setChosenDocs((c) => c.filter((d) => d !== docId));
      setChosenAnns((a) => ({ ...a, [docId]: [] }));
      if (linked === docId) setLinked(null);
    }
  };
  const toggleAnn = (docId: string, id: string, on: boolean) => {
    setError(null);
    setChosenAnns((a) => {
      const list = a[docId] ?? [];
      return { ...a, [docId]: on ? [...list, id] : list.filter((x) => x !== id) };
    });
  };
  const annCount = Object.entries(chosenAnns).reduce((n, [docId, list]) => n + (chosenDocs.includes(docId) ? list.length : 0), 0);
  const carryGraph = graph && (graphCount ?? 0) > 0;
  const carryNote = note && !!work.note;
  const yes = (on: boolean) => t(on ? "shelf.yes" : "shelf.no");

  const run = useCallback(
    async (confirm?: ShelfReplaceImpact) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      setChangedNote(null);
      const ordered = docIds.filter((d) => chosenDocs.includes(d));
      const answer = await addToShelf({
        workId: work.id,
        docs: ordered.map((docId) => ({ docId, annotationIds: chosenAnns[docId] ?? [] })),
        argumentGraph: carryGraph,
        note: carryNote,
        ...(confirm ? { confirm } : {}),
      });
      busyRef.current = false;
      setBusy(false);
      if (answer.ok) {
        onAdded(answer.value);
        return;
      }
      handleRefusal(answer);
    },
    [docIds, chosenDocs, chosenAnns, carryGraph, carryNote, work.id, onAdded]
  );

  const handleRefusal = (f: ShelfFailure) => {
    const parts = refusalParts(f);
    // Asked (again) for a confirmation after the annotations were read: what the access path archived on the way is
    // said too, with the server's sentence (contracts "Shelf" section, local revision one).
    const archivedLines =
      parts.archived.length > 0
        ? [t("shelf.add.archivedOnTheWay", { docs: parts.archived.map((a) => (a.count === null ? a.docId : `${a.docId} (${a.count})`)).join(", ") }), ...(f.detail ? [f.detail] : [])]
        : [];
    if (f.code === "confirmation_required" && parts.impact) {
      setImpact(parts.impact);
      setStep("confirm");
      setChangedNote(archivedLines.length > 0 ? archivedLines.join(" ") : null);
      return;
    }
    if (f.code === "confirmation_changed") {
      setImpact(parts.impact);
      if (parts.impact) {
        setStep("confirm");
        setChangedNote([t("shelf.add.confirmationChanged"), ...archivedLines].join(" "));
      } else {
        setStep("form");
        setChangedNote([t("shelf.add.confirmationGone"), ...archivedLines].join(" "));
      }
      return;
    }
    setError(shelfFailureLines(f, t, "add"));
  };

  const submit = () => {
    if (impact && step === "form") {
      setStep("confirm");
      return;
    }
    void run(step === "confirm" && impact ? impact : undefined);
  };

  const failBox = error && (
    <InlineMessage tone="danger" uiId="add-to-shelf-error" title={t("shelf.add.failTitle")}>
      {error.map((line, i) => (
        <p key={i}>{line}</p>
      ))}
    </InlineMessage>
  );

  if (step === "confirm" && impact) {
    const newDocs = docIds.filter((d) => chosenDocs.includes(d));
    return (
      <Dialog
        uiId="replace-shelf-entry-dialog"
        title={t("shelf.replace.title")}
        description={work.title}
        closeLabel={t("common.close")}
        busy={busy}
        initialFocusRef={backRef}
        onClose={onClose}
        width={560}
        footer={
          <>
            <ActionButton mode="text" ref={backRef} data-ui="back-to-add-to-shelf" label={t("shelf.back")} tooltip={t("shelf.back")} disabled={busy} onClick={() => { setStep("form"); setError(null); }}>
              {t("shelf.back")}
            </ActionButton>
            <ActionButton mode="text" variant="danger" data-ui="confirm-replace-shelf-entry" busy={busy} busyLabel={t("shelf.replace.busy")} label={t("shelf.replace.confirm")} tooltip={t("shelf.replace.confirm")} onClick={submit}>
              {t("shelf.replace.confirm")}
            </ActionButton>
          </>
        }
      >
        <div className="shelf-stack" data-ui="replace-shelf-entry-risk">
          {changedNote && <InlineMessage tone="warning" uiId="replace-shelf-entry-changed">{changedNote}</InlineMessage>}
          <p className="shelf-lead">{t("shelf.replace.lead")}</p>
          <div className="shelf-compare">
            <div className="shelf-compare-col" data-ui="replace-old">
              <span className="shelf-k">{t("shelf.replace.old")}</span>
              {impact.entries.map((e) => (
                <div key={e.entryId} className="shelf-compare-entry" data-ui="replace-old-entry" data-ui-key={e.entryId}>
                  <strong>{t("shelf.replace.summary", { docs: e.docs.length, annotations: e.annotations, graph: yes(e.argumentGraph), note: yes(e.note) })}</strong>
                  <span className="shelf-dim mono">
                    {formatBytes(e.docs.reduce((n, d) => n + d.bytes, 0))} · {t("shelf.addedFrom", { at: formatTime(e.addedAt), from: e.sourceProject })}
                  </span>
                  <ul className="shelf-mini-list">
                    {e.docs.map((d) => (
                      <li key={d.docId}>
                        <DocKindIcon kind={d.kind} />
                        <code>{d.docId}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <Icon name="arrow-right" cls="ico-sm shelf-compare-arrow" />
            <div className="shelf-compare-col" data-ui="replace-new">
              <span className="shelf-k">{t("shelf.replace.new")}</span>
              <strong>{t("shelf.replace.summary", { docs: newDocs.length, annotations: annCount, graph: yes(carryGraph), note: yes(carryNote) })}</strong>
              <ul className="shelf-mini-list">
                {newDocs.map((d) => (
                  <li key={d}>
                    <DocKindIcon kind={docKind(docs.find((x) => x.docId === d) ?? { docId: d, description: null, kind: null, bytes: null })} />
                    <code>{d}</code>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <InlineMessage tone="warning" title={t("shelf.replace.riskTitle")}>
            {t("shelf.replace.risk")}
          </InlineMessage>
          {failBox}
        </div>
      </Dialog>
    );
  }

  const annDocs = docs.filter((d) => annotations[d.docId]?.state !== "none");
  const chosenSizes = docs.filter((d) => chosenDocs.includes(d.docId)).map((d) => d.bytes);
  const chosenBytes = chosenSizes.some((b) => b === null) ? null : chosenSizes.reduce<number>((n, b) => n + (b ?? 0), 0);
  const submitLabel = t(impact ? "shelf.add.submitReplace" : "shelf.add.submit");
  const first = impact?.entries[0];
  return (
    <Dialog
      uiId="add-to-shelf-dialog"
      title={t("shelf.add.title")}
      description={t("shelf.add.description")}
      closeLabel={t("common.close")}
      busy={busy}
      onClose={onClose}
      width={600}
      footer={
        <>
          <span className="shelf-foot-summary" data-ui="add-to-shelf-summary">
            {t("shelf.add.willAdd", { docs: chosenDocs.length, annotations: annCount, graph: yes(carryGraph), note: yes(carryNote) })}
            {chosenBytes !== null && ` · ${t("shelf.add.about", { size: formatBytes(chosenBytes) })}`}
          </span>
          <ActionButton mode="text" data-ui="cancel-add-to-shelf" label={t("common.cancel")} tooltip={t("common.cancel")} disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </ActionButton>
          <ActionButton mode="text" variant="primary" ref={submitRef} data-ui="submit-add-to-shelf" busy={busy} busyLabel={t("shelf.add.busy")} disabled={impact === undefined} label={submitLabel} tooltip={submitLabel} onClick={submit}>
            {submitLabel}
          </ActionButton>
        </>
      }
    >
      <div className="shelf-stack">
        {failBox}
        {changedNote && <InlineMessage tone="warning" uiId="add-to-shelf-changed">{changedNote}</InlineMessage>}
        {first && (
          <InlineMessage uiId="already-on-shelf" title={t("shelf.add.alreadyTitle")}>
            {t("shelf.add.alreadyBody", { at: formatTime(first.addedAt), from: first.sourceProject })}
          </InlineMessage>
        )}
        {!work.doi && !work.arxiv_id && !work.openalex_id && impact === null && (
          <InlineMessage uiId="no-identity" title={t("shelf.add.noIdTitle")}>
            {t("shelf.add.noIdBody")}
          </InlineMessage>
        )}

        <section className="shelf-sec" data-ui="add-to-shelf-bib">
          <h3 className="shelf-sec-h">
            {t("shelf.add.bib")}
            <span>{t("shelf.add.bibAlways")}</span>
          </h3>
          <div className="shelf-bib">
            <strong className="serif">{work.title}</strong>
            <span>{[work.authors, work.venue, work.year].filter(Boolean).join(" · ")}</span>
            {(work.doi || work.arxiv_id) && <span className="mono shelf-dim">{[work.doi && `DOI ${work.doi}`, work.arxiv_id && `arXiv ${work.arxiv_id}`].filter(Boolean).join(" · ")}</span>}
          </div>
        </section>

        <section className="shelf-sec" data-ui="add-to-shelf-docs">
          <h3 className="shelf-sec-h">
            {t("shelf.add.docs")}
            <span className="mono">
              {chosenDocs.length}/{docIds.length}
            </span>
          </h3>
          {docIds.length === 0 && <p className="shelf-dim">{t("shelf.add.noDocs")}</p>}
          {docs.map((d) => {
            const pdf = sourcePdfOf(d);
            const missing = pdf !== null && !docIds.includes(pdf);
            const draft = d.description?.format === "text" && !d.description.generated;
            return (
              <label key={d.docId} className="shelf-check-row" data-ui="add-to-shelf-doc" data-ui-key={d.docId}>
                <input type="checkbox" checked={chosenDocs.includes(d.docId)} disabled={busy} onChange={(e) => toggleDoc(d.docId, e.target.checked)} />
                <span className="shelf-row-main">
                  <span className="shelf-row-title">
                    <DocKindIcon kind={docKind(d)} />
                    <strong>{t(`shelf.kind.${docKind(d)}`)}</strong>
                    <Badge tone={d.docId === mainDoc ? "accent" : "neutral"}>{t(d.docId === mainDoc ? "shelf.main" : "shelf.additional")}</Badge>
                  </span>
                  <span className="shelf-row-meta">
                    <code>{d.docId}</code>
                    {d.bytes !== null && <span className="mono">{formatBytes(d.bytes)}</span>}
                    {pdf && !missing && <span>{t("shelf.add.fromPdf", { pdf })}</span>}
                    {missing && (
                      <span className="shelf-warn" data-ui="add-to-shelf-source-pdf-missing">
                        <Icon name="triangle-alert" cls="ico-sm" />
                        {t("shelf.add.sourcePdfMissing")}
                      </span>
                    )}
                    {draft && <span>{t("shelf.add.draft")}</span>}
                  </span>
                </span>
              </label>
            );
          })}
          {linked && (
            <p className="shelf-note" role="status" data-ui="linked-source-pdf">
              <Icon name="link" cls="ico-sm" />
              {t("shelf.add.linkedPdf", { pdf: linked })}
            </p>
          )}
        </section>

        <section className="shelf-sec" data-ui="add-to-shelf-annotations">
          <h3 className="shelf-sec-h">
            {t("shelf.add.annotations")}
            <span>{t("shelf.add.annotationsDefault")}</span>
            <span className="mono shelf-push">{annCount}</span>
          </h3>
          {annDocs.length === 0 && <p className="shelf-dim">{t("shelf.add.noAnnotations")}</p>}
          {annDocs.map((d) => {
            const state = annotations[d.docId] ?? { state: "loading" };
            const on = chosenDocs.includes(d.docId);
            const list = state.state === "ok" ? state.list : [];
            const chosen = chosenAnns[d.docId] ?? [];
            if (state.state === "ok" && list.length === 0) return null;
            return (
              <div key={d.docId} className={"shelf-ann-group" + (on ? "" : " off")} data-ui="add-to-shelf-annotation-group" data-ui-key={d.docId}>
                <div className="shelf-ann-group-h">
                  <DocKindIcon kind={docKind(d)} />
                  <code>{d.docId}</code>
                  {state.state === "ok" && <span className="shelf-dim">· {list.length}</span>}
                  {state.state === "ok" &&
                    (on ? (
                      <span className="shelf-push shelf-group-actions">
                        <ActionButton mode="text" unstyled className="shelf-link" data-ui="select-all-annotations" data-ui-key={d.docId} label={t("shelf.add.selectAll")} tooltip={t("shelf.add.selectAll")} disabled={busy} onClick={() => setChosenAnns((a) => ({ ...a, [d.docId]: list.map((x) => x.id) }))}>
                          {t("shelf.add.selectAll")}
                        </ActionButton>
                        <ActionButton mode="text" unstyled className="shelf-link" data-ui="clear-annotations" data-ui-key={d.docId} label={t("shelf.add.clearAll")} tooltip={t("shelf.add.clearAll")} disabled={busy} onClick={() => setChosenAnns((a) => ({ ...a, [d.docId]: [] }))}>
                          {t("shelf.add.clearAll")}
                        </ActionButton>
                      </span>
                    ) : (
                      <span className="shelf-push shelf-dim">{t("shelf.add.annotationsOfUnchecked")}</span>
                    ))}
                </div>
                {state.state === "loading" && <p className="shelf-dim shelf-pad-s">{t("shelf.add.annotationsLoading")}</p>}
                {state.state === "error" && (
                  <p className="shelf-warn shelf-pad-s" data-ui="add-to-shelf-annotations-unreadable">
                    {t("shelf.add.annotationsUnreadable")}
                  </p>
                )}
                {state.state === "stale" && (
                  <p className="shelf-warn-text shelf-pad-s" data-ui="add-to-shelf-annotations-stale">
                    {t("shelf.add.annotationsStale")}
                  </p>
                )}
                {state.state === "busy" && (
                  <p className="shelf-warn-text shelf-pad-s" data-ui="add-to-shelf-annotations-busy">
                    {t("shelf.add.annotationsBusy")}
                  </p>
                )}
                {list.map((a) => (
                  <label key={a.id} className="shelf-check-row shelf-ann" data-ui="add-to-shelf-annotation" data-ui-key={a.id}>
                    <input type="checkbox" checked={on && chosen.includes(a.id)} disabled={!on || busy} onChange={(e) => toggleAnn(d.docId, a.id, e.target.checked)} />
                    <AnnotationText a={a} />
                  </label>
                ))}
              </div>
            );
          })}
        </section>

        <section className="shelf-sec" data-ui="add-to-shelf-more">
          <h3 className="shelf-sec-h">
            {t("shelf.add.more")}
            <span>{t("shelf.add.moreDefault")}</span>
          </h3>
          <label className="shelf-check-row" data-ui="add-to-shelf-argument-graph">
            <input type="checkbox" checked={graph} disabled={!graphCount || busy} onChange={(e) => { setGraph(e.target.checked); setError(null); }} />
            <span className="shelf-row-main">
              <strong>{t("shelf.graph")}</strong>
              <span className="shelf-dim">{graphCount ? t("shelf.add.arguments", { count: graphCount }) : t("shelf.add.noGraph")}</span>
            </span>
          </label>
          <label className="shelf-check-row" data-ui="add-to-shelf-note">
            <input type="checkbox" checked={note} disabled={!work.note || busy} onChange={(e) => { setNote(e.target.checked); setError(null); }} />
            <span className="shelf-row-main">
              <strong>{t("shelf.note")}</strong>
              <span className="shelf-dim shelf-clamp">{work.note || t("shelf.add.noNote")}</span>
            </span>
          </label>
          <p className="shelf-dim shelf-small">{t("shelf.add.notIncluded")}</p>
        </section>
      </div>
    </Dialog>
  );
}

export function AnnotationText({ a, extra }: { a: { kind: string; where: string; snippet: string; body: string }; extra?: ReactNode }) {
  return (
    <span className="shelf-row-main">
      <span className="shelf-row-meta">
        <Badge>{a.kind}</Badge>
        {a.where && <span className="mono">{a.where}</span>}
        {extra}
      </span>
      {a.snippet && <span className="shelf-excerpt">“{a.snippet}”</span>}
      {a.body && <span className="shelf-ann-body">{a.body}</span>}
    </span>
  );
}

export function DocKindIcon({ kind }: { kind: string }) {
  return <Icon name={kind === "pdf" ? "file-up" : "file-text"} cls="ico-sm" />;
}

/** An ISO time as the page shows it (local, minutes). */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
