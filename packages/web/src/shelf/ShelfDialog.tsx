import { SHELF_FORMAT, type ShelfAnnotationsResponse, type ShelfEntryResponse, type ShelfEntrySummary, type ShelfListRow, type ShelfTakeRequest, type ShelfTakeResult } from "@argelanderspace/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { deleteShelfEntry, fetchShelf, fetchShelfAnnotations, fetchShelfEntry, onShelfChanged, previewTake, type ShelfFailure, takeFromShelf } from "../api/shelf";
import { Icon } from "../lib/icons";
import type { LibraryRef } from "../library/types";
import { ActionButton, Badge, Dialog, InlineMessage } from "../ui";
import { AnnotationText, DocKindIcon, formatTime } from "./AddToShelf";
import { damageText, formatBytes, shelfFailureLines, type Translate } from "./format";
import { projectWorksMatching } from "./already-on-shelf";
import "./shelf.css";

/*
 * The Shelf dialog (shelf ticket 05; review Q1 plan A: the fourth item of the Library's import menu): the list with its
 * search on the left, the selected entry's summary on the right, and there the take flow and its result. Deleting an
 * entry asks in a small dialog of its own above this one (review Q5). The Shelf is only stored and taken here — no
 * reading, annotating or exploring (spec Q4).
 *
 * Ticket 06 opens it from outside on one entry's take step: `<ShelfDialog entryId={id} take … />`.
 */

export interface ShelfDialogProps {
  /** Select this entry when the list arrives. */
  entryId?: string;
  /** With `entryId`: go straight to its take step (the "already on the Shelf" hint, ticket 06). */
  take?: boolean;
  /** The project's Works, to mark the entries this project already has (same DOI / arXiv id). */
  works: readonly LibraryRef[];
  onClose: () => void;
  /** "View in Library" after a take: select the Work and show its Full text tab. */
  onViewWork: (workId: string) => void;
  /**
   * A take finished: `entryId` is the entry actually taken — any entry of the Shelf can be chosen here, so it need not
   * be the one the dialog opened on (the exploration marks its candidate only for one of its hits, ticket 06).
   */
  onTaken?: (result: ShelfTakeResult, entryId: string) => void;
}

type ListState = { state: "loading" } | { state: "error"; failure: ShelfFailure } | { state: "ok"; rows: ShelfListRow[] };
type Pane = { kind: "summary" } | { kind: "take" } | { kind: "result"; result: ShelfTakeResult };
type OkRow = Extract<ShelfListRow, { status: "ok" }>;

/**
 * The project Work that is this entry's paper, by the take's own rule (DOI, arXiv id, OpenAlex id). None when two or
 * more Works match: the take then refuses (`multiple_works`), so "it merges into it" would not be true.
 */
export function projectWorkFor(row: ShelfEntrySummary, works: readonly LibraryRef[]): LibraryRef | undefined {
  const found = projectWorksMatching(row.identity, works);
  return found.length === 1 ? found[0] : undefined;
}

function matches(row: ShelfListRow, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  const fields = row.status === "ok" ? [row.title, ...row.authors, row.identity.doi, row.identity.arxiv, row.identity.openalex, row.year == null ? null : String(row.year)] : row.status === "incompatible" ? [row.title, row.entryId] : [row.entryId];
  return fields.some((v) => typeof v === "string" && v.toLowerCase().includes(s));
}

const titleOf = (row: ShelfListRow, t: Translate) => (row.status === "ok" ? row.title : row.status === "incompatible" && row.title ? row.title : t("shelf.untitled", { id: row.entryId.slice(0, 8) }));
const firstAuthor = (authors: string[]) => authors[0] ?? "";

export function ShelfDialog({ entryId, take, works, onClose, onViewWork, onTaken }: ShelfDialogProps) {
  const { t } = useTranslation();
  const [list, setList] = useState<ListState>({ state: "loading" });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(entryId ?? null);
  const [pane, setPane] = useState<Pane>({ kind: "summary" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteFor, setDeleteFor] = useState<ShelfListRow | null>(null);
  const wanted = useRef<{ entryId?: string; take?: boolean } | null>(entryId ? { entryId, take } : null);
  const seq = useRef(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const load = useCallback(async () => {
    const n = ++seq.current;
    const answer = await fetchShelf();
    if (n !== seq.current) return;
    if (!answer.ok) {
      setList({ state: "error", failure: answer });
      return;
    }
    const rows = answer.value.entries;
    setList({ state: "ok", rows });
    const want = wanted.current;
    wanted.current = null;
    const id = want?.entryId ?? selectedRef.current;
    const keep = id !== null && id !== undefined && rows.some((r) => r.entryId === id);
    if (want?.entryId && !keep) setNotice(t("shelf.browse.entryGone"));
    // The entry on screen went (deleted or replaced elsewhere): back to a summary, never a take or result step that
    // silently becomes another paper's.
    if (!keep) setPane({ kind: "summary" });
    setSelected(keep ? id : (rows[0]?.entryId ?? null));
    if (want?.take && want.entryId && rows.some((r) => r.entryId === want.entryId && r.status === "ok")) setPane({ kind: "take" });
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);
  // Another change through this server (an add, a replacement, a delete) or a reconnect: read the list again. A take
  // or result step stays on its entry (its own request answers `changed` when the entry was replaced).
  useEffect(() => onShelfChanged(() => void load(), () => void load()), [load]);

  const rows = list.state === "ok" ? list.rows : [];
  const shown = rows.filter((r) => matches(r, query));
  const totalBytes = rows.reduce((n, r) => n + r.bytes, 0);
  const row = rows.find((r) => r.entryId === selected) ?? null;
  const locked = pane.kind !== "summary";

  return (
    <>
      <Dialog uiId="shelf-dialog" title={t("shelf.title")} description={t("shelf.description")} closeLabel={t("common.close")} busy={busy} onClose={onClose} width={860}>
        <div className="shelf-browser" data-ui="shelf-browser">
          <div className="shelf-list" data-ui="shelf-list">
            <div className="lib-search shelf-search">
              <Icon name="search" cls="ico-sm" />
              <input data-ui="search-shelf" value={query} disabled={list.state !== "ok"} onChange={(e) => setQuery(e.target.value)} placeholder={t("shelf.browse.search")} aria-label={t("shelf.browse.search")} />
            </div>
            <div className="shelf-count mono" data-ui="shelf-count">
              {list.state === "ok" ? t("shelf.browse.count", { count: rows.length, size: formatBytes(totalBytes) }) : " "}
            </div>
            {notice && (
              <p className="ref-copy-status shelf-notice" role="status" data-ui="shelf-notice">
                {notice}
              </p>
            )}
            <div className="shelf-rows">
              {list.state === "loading" && (
                <div className="shelf-center" data-ui="shelf-loading">
                  <div className="cg-spinner" />
                  <span>{t("shelf.browse.loading")}</span>
                </div>
              )}
              {list.state === "error" && (
                <div className="shelf-pad">
                  <InlineMessage tone="danger" uiId="shelf-read-error" title={t("shelf.browse.errorTitle")}>
                    {shelfFailureLines(list.failure, t, "read").map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                    <ActionButton mode="text" variant="ghost" data-ui="retry-shelf" label={t("common.retry")} tooltip={t("common.retry")} onClick={() => { setList({ state: "loading" }); void load(); }}>
                      {t("common.retry")}
                    </ActionButton>
                  </InlineMessage>
                </div>
              )}
              {list.state === "ok" && rows.length === 0 && (
                <div className="ref-documents-empty shelf-pad" data-ui="shelf-empty">
                  <strong>{t("shelf.browse.empty")}</strong>
                  <span>{t("shelf.browse.emptyHelp")}</span>
                </div>
              )}
              {list.state === "ok" && rows.length > 0 && shown.length === 0 && <div className="side-reflist-empty mono" data-ui="shelf-no-match">{t("shelf.browse.noMatch")}</div>}
              {shown.map((r) => (
                <EntryRow key={r.entryId} row={r} works={works} selected={r.entryId === selected} disabled={locked && r.entryId !== selected} onSelect={() => { setNotice(null); setSelected(r.entryId); setPane({ kind: "summary" }); }} />
              ))}
            </div>
          </div>
          <div className="shelf-detail" data-ui="shelf-detail">
            {!row ? (
              <div className="shelf-center shelf-dim">{list.state === "ok" && rows.length > 0 ? t("shelf.browse.select") : ""}</div>
            ) : pane.kind === "take" && row.status === "ok" ? (
              <TakePane key={`${row.entryId}:${row.rev}`} row={row} onBusy={setBusy} onBack={() => setPane({ kind: "summary" })} onDone={(result) => {
                setPane({ kind: "result", result });
                onTaken?.(result, row.entryId);
              }} onStale={() => void load()} />
            ) : pane.kind === "result" ? (
              <ResultPane row={row} result={pane.result} onDone={() => setPane({ kind: "summary" })} onView={() => onViewWork(pane.result.work.id)} />
            ) : (
              <Summary key={`${row.entryId}:${row.rev}`} row={row} works={works} onTake={() => setPane({ kind: "take" })} onDelete={() => setDeleteFor(row)} />
            )}
          </div>
        </div>
      </Dialog>
      {deleteFor && (
        <DeleteEntryDialog
          row={deleteFor}
          onCancel={() => setDeleteFor(null)}
          onDeleted={() => {
            setNotice(t("shelf.delete.done", { title: titleOf(deleteFor, t) }));
            setDeleteFor(null);
            setSelected(null);
            setPane({ kind: "summary" });
            void load();
          }}
          onStale={() => void load()}
        />
      )}
    </>
  );
}

function EntryRow({ row, works, selected, disabled, onSelect }: { row: ShelfListRow; works: readonly LibraryRef[]; selected: boolean; disabled: boolean; onSelect: () => void }) {
  const { t } = useTranslation();
  const here = row.status === "ok" ? projectWorkFor(row, works) : undefined;
  return (
    <button type="button" className={"side-ref shelf-entry" + (selected ? " sel" : "") + (row.status === "ok" ? "" : " shelf-incompat")} data-ui="shelf-entry" data-ui-key={row.entryId} aria-current={selected || undefined} disabled={disabled} onClick={onSelect}>
      <span className="side-ref-body">
        <span className="side-ref-title">{titleOf(row, t)}</span>
        {row.status === "ok" && (
          <span className="side-ref-meta mono">
            {[firstAuthor(row.authors), row.year].filter((v) => v !== null && v !== "").join(" · ")}
          </span>
        )}
        <span className="shelf-badges">
          {row.status === "incompatible" && (
            <span className="shelf-badge-warn" data-ui="shelf-entry-needs-update">
              <Icon name="triangle-alert" cls="ico-sm" />
              {t("shelf.needsUpdate")}
            </span>
          )}
          {row.status === "damaged" && (
            <span className="shelf-badge-warn" data-ui="shelf-entry-damaged">
              <Icon name="triangle-alert" cls="ico-sm" />
              {t("shelf.damaged")}
            </span>
          )}
          {row.status === "unreadable" && (
            <span className="shelf-badge-warn" data-ui="shelf-entry-unreadable">
              <Icon name="triangle-alert" cls="ico-sm" />
              {t("shelf.unreadable")}
            </span>
          )}
          {row.status === "ok" && (
            <>
              <Badge>{t("shelf.docCount", { count: row.docs.length })}</Badge>
              {row.annotations > 0 && <Badge>{t("shelf.annCount", { count: row.annotations })}</Badge>}
              {row.argumentGraph && <Badge>{t("shelf.graph")}</Badge>}
              {row.note && <Badge>{t("shelf.note")}</Badge>}
              {here && <Badge tone="accent">{t("shelf.inProject")}</Badge>}
            </>
          )}
          {row.status !== "unreadable" && <span className="shelf-size mono">{formatBytes(row.bytes)}</span>}
        </span>
      </span>
    </button>
  );
}

function Summary({ row, works, onTake, onDelete }: { row: ShelfListRow; works: readonly LibraryRef[]; onTake: () => void; onDelete: () => void }) {
  const { t } = useTranslation();
  const [entry, setEntry] = useState<ShelfEntryResponse | null>(null);
  useEffect(() => {
    if (row.status !== "ok") return;
    const controller = new AbortController();
    void fetchShelfEntry(row.entryId, controller.signal)
      .then((answer) => {
        if (answer.ok) setEntry(answer.value);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [row]);
  const ok = row.status === "ok";
  const here = ok ? projectWorkFor(row, works) : undefined;
  const venue = entry?.status === "ok" && typeof entry.bibliography.venue === "string" ? entry.bibliography.venue : null;
  return (
    <div className="shelf-pane" data-ui="shelf-entry-summary" data-ui-key={row.entryId}>
      <div className="shelf-pane-scroll">
        {row.status === "incompatible" && (
          <InlineMessage tone="warning" uiId="shelf-entry-needs-update-note" title={t("shelf.needsUpdate")}>
            {t("shelf.browse.needsUpdateBody", { format: String(row.format), current: SHELF_FORMAT })}
          </InlineMessage>
        )}
        {row.status === "damaged" && (
          <InlineMessage tone="danger" uiId="shelf-entry-damaged-note" title={t("shelf.damaged")}>
            {t("shelf.browse.damagedBody", { problem: damageText(row.problem, t) })}
          </InlineMessage>
        )}
        {row.status === "unreadable" && (
          <InlineMessage tone="warning" uiId="shelf-entry-unreadable-note" title={t("shelf.unreadable")}>
            {t("shelf.browse.unreadableBody", { code: row.code })}
          </InlineMessage>
        )}
        <h2 className="ref-detail-title serif shelf-title">{titleOf(row, t)}</h2>
        {ok && (
          <>
            <p className="ref-detail-auth">{row.authors.join(", ")}</p>
            <div className="ref-detail-meta">
              {venue && (
                <>
                  <span>{venue}</span>
                  <span className="dotsep">·</span>
                </>
              )}
              <span className="mono">{row.year ?? ""}</span>
            </div>
            {here && (
              <InlineMessage uiId="shelf-entry-in-project">{t("shelf.browse.inProjectHint", { cite: here.cite })}</InlineMessage>
            )}
            <div className="ref-meta-list shelf-meta">
              {row.identity.doi && <MetaRow k="DOI" v={row.identity.doi} mono />}
              {row.identity.arxiv && <MetaRow k="arXiv" v={row.identity.arxiv} mono />}
              {row.identity.openalex && <MetaRow k="OpenAlex" v={row.identity.openalex} mono />}
              <div className="rml-row">
                <span className="rml-k">{t("shelf.docs")}</span>
                <span className="rml-v">
                  <ul className="shelf-mini-list" data-ui="shelf-entry-docs">
                    {row.docs.map((d, i) => (
                      <li key={d.docId}>
                        <DocKindIcon kind={d.kind} />
                        <span>{t(`shelf.kind.${d.kind}`)}</span>
                        <code>{d.docId}</code>
                        <span className="shelf-dim mono">
                          {formatBytes(d.bytes)}
                          {d.annotations ? ` · ${t("shelf.annCount", { count: d.annotations })}` : ""}
                        </span>
                        {i === 0 && <Badge tone="accent">{t("shelf.main")}</Badge>}
                      </li>
                    ))}
                  </ul>
                </span>
              </div>
              <MetaRow k={t("shelf.annotations")} v={String(row.annotations)} />
              <MetaRow k={t("shelf.graph")} v={t(row.argumentGraph ? "shelf.yes" : "shelf.no")} />
              <MetaRow k={t("shelf.note")} v={t(row.note ? "shelf.yes" : "shelf.no")} />
              <MetaRow k={t("shelf.size")} v={formatBytes(row.bytes)} mono />
              <MetaRow k={t("shelf.added")} v={t("shelf.addedFrom", { at: formatTime(row.addedAt), from: row.source.project })} mono />
            </div>
          </>
        )}
        {!ok && (
          <div className="ref-meta-list shelf-meta">
            <MetaRow k={t("shelf.entryId")} v={row.entryId} mono />
            {row.status !== "unreadable" && <MetaRow k={t("shelf.size")} v={formatBytes(row.bytes)} mono />}
          </div>
        )}
      </div>
      <div className="shelf-pane-bar">
        <ActionButton mode="text" appearance="quiet" tone="danger" data-ui="delete-shelf-entry" label={t("shelf.delete.open")} tooltip={t("shelf.delete.open")} onClick={onDelete}>
          <Icon name="trash-2" cls="ico-sm" />
          {t("shelf.delete.button")}
        </ActionButton>
        <span className="shelf-push" />
        <ActionButton mode="text" variant="primary" data-ui="take-shelf-entry" disabled={!ok} label={t("shelf.take.open")} tooltip={ok ? t("shelf.take.open") : t("shelf.take.notTakeable")} onClick={onTake}>
          {t("shelf.take.open")}
        </ActionButton>
      </div>
    </div>
  );
}

function MetaRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="rml-row">
      <span className="rml-k">{k}</span>
      <span className={"rml-v" + (mono ? " mono" : "")}>{v}</span>
    </div>
  );
}

type Excluded = Record<string, string[]>;

function TakePane({ row, onBusy, onBack, onDone, onStale }: { row: OkRow; onBusy: (b: boolean) => void; onBack: () => void; onDone: (result: ShelfTakeResult) => void; onStale: () => void }) {
  const { t } = useTranslation();
  const [annotations, setAnnotations] = useState<ShelfAnnotationsResponse | null | "error">(row.annotations > 0 ? null : { entryId: row.entryId, rev: row.rev, docs: [] });
  const [excluded, setExcluded] = useState<Excluded>({});
  const [graph, setGraph] = useState(row.argumentGraph);
  const [note, setNote] = useState(row.note);
  const [base, setBase] = useState<{
    argumentGraph: ShelfTakeResult["argumentGraph"] | null;
    note: ShelfTakeResult["note"] | null;
    skipped: ShelfTakeResult["docs"]["skipped"];
    work: ShelfTakeResult["work"];
  } | null>(null);
  const [plan, setPlan] = useState<{ result: ShelfTakeResult; digest: string } | null>(null);
  const [planError, setPlanError] = useState<string[] | null>(null);
  const [error, setError] = useState<string[] | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const previewSeq = useRef(0);
  const setBusy = (b: boolean) => {
    busyRef.current = b;
    setBusyState(b);
    onBusy(b);
  };

  useEffect(() => {
    if (row.annotations === 0) return;
    const controller = new AbortController();
    void fetchShelfAnnotations(row.entryId, row.rev, controller.signal)
      .then((answer) => setAnnotations(answer.ok ? answer.value : "error"))
      .catch(() => undefined);
    return () => controller.abort();
  }, [row]);

  const request = useMemo<ShelfTakeRequest>(() => {
    const excludeAnnotations = Object.fromEntries(Object.entries(excluded).filter(([, ids]) => ids.length > 0));
    return { rev: row.rev, argumentGraph: graph, note, ...(Object.keys(excludeAnnotations).length > 0 ? { excludeAnnotations } : {}) };
  }, [row.rev, excluded, graph, note]);

  // The plan is worked out by the server for what is chosen now (read only); the take sends its digest, so what is
  // taken is what this pane showed.
  const staleRef = useRef(onStale);
  staleRef.current = onStale;
  useEffect(() => {
    const n = ++previewSeq.current;
    // Until the plan for what is chosen now arrives, there is none to take (the Take button waits for it).
    setPlan(null);
    void previewTake(row.entryId, request).then((answer) => {
      if (n !== previewSeq.current) return;
      if (answer.ok) {
        setPlan({ result: answer.value.plan, digest: answer.value.planDigest });
        setPlanError(null);
        learn(answer.value.plan);
      } else {
        setPlanError(shelfFailureLines(answer, t, "read"));
        // As for the take itself: an entry replaced or gone has a newer list to show (and its message says so).
        if (["changed", "not_found", "incompatible", "damaged"].includes(answer.code)) staleRef.current();
      }
    });
  }, [row.entryId, request, t]);

  // What the project does with the graph and the note, as the latest plan that was asked about them says (a plan for
  // an unchosen graph or note says `not_chosen` and leaves the last answer standing).
  const learn = (p: ShelfTakeResult) =>
    setBase((b) => ({
      argumentGraph: p.argumentGraph !== "not_chosen" ? p.argumentGraph : (b?.argumentGraph ?? null),
      note: p.note !== "not_chosen" ? p.note : (b?.note ?? null),
      skipped: p.docs.skipped,
      work: p.work,
    }));
  const skipped = new Map((plan?.result.docs.skipped ?? base?.skipped ?? []).map((s) => [s.docId, s]));
  const keepLocalGraph = base?.argumentGraph === "kept_local";
  const noteKept = base?.note === "kept_local";
  const noteExisting = base?.note === "existing_work";
  const work = plan?.result.work ?? base?.work;

  const run = async () => {
    if (busyRef.current || !plan) return;
    setBusy(true);
    setError(null);
    setChanged(false);
    const answer = await takeFromShelf(row.entryId, { ...request, planDigest: plan.digest });
    setBusy(false);
    if (answer.ok) {
      onDone(answer.value);
      return;
    }
    if (answer.code === "plan_changed" && answer.body.plan && typeof answer.body.planDigest === "string") {
      const fresh = answer.body.plan as ShelfTakeResult;
      setPlan({ result: fresh, digest: answer.body.planDigest });
      learn(fresh);
      setChanged(true);
      return;
    }
    // The entry was replaced, deleted, or turned out unusable: the list is read again (as the failure line says).
    if (["changed", "not_found", "incompatible", "damaged"].includes(answer.code)) onStale();
    setError(shelfFailureLines(answer, t, "take"));
  };

  const toggleAnn = (docId: string, id: string, take: boolean) =>
    setExcluded((e) => {
      const list = e[docId] ?? [];
      return { ...e, [docId]: take ? list.filter((x) => x !== id) : [...list, id] };
    });
  const docsWithAnns = annotations && annotations !== "error" ? annotations.docs.filter((d) => d.annotations.length > 0) : [];
  const total = docsWithAnns.reduce((n, d) => n + d.annotations.length, 0);
  const takenCount = docsWithAnns.reduce((n, d) => (skipped.has(d.docId) ? n : n + d.annotations.filter((a) => !(excluded[d.docId] ?? []).includes(a.id)).length), 0);

  return (
    <div className="shelf-pane" data-ui="take-from-shelf" data-ui-key={row.entryId}>
      <div className="shelf-pane-scroll shelf-stack">
        <div>
          <div className="shelf-k">{t("shelf.take.title")}</div>
          <h2 className="shelf-pane-title serif">{row.title}</h2>
        </div>
        {error && (
          <InlineMessage tone="danger" uiId="take-from-shelf-error" title={t("shelf.take.failTitle")}>
            {error.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </InlineMessage>
        )}
        {changed && <InlineMessage tone="warning" uiId="take-plan-changed">{t("shelf.take.planChanged")}</InlineMessage>}
        {planError && (
          <InlineMessage tone="danger" uiId="take-preview-error" title={t("shelf.take.previewFailed")}>
            {planError.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </InlineMessage>
        )}
        <section className="shelf-sec" data-ui="take-target">
          <h3 className="shelf-sec-h">{t("shelf.take.target")}</h3>
          {!work ? (
            <p className="shelf-p shelf-dim">{t("shelf.take.planning")}</p>
          ) : (
            <p className="shelf-p">{work.created ? t("shelf.take.newWork", { cite: work.citeKey ?? "—" }) : t("shelf.take.mergeWork", { title: work.title, cite: work.citeKey ?? "—" })}</p>
          )}
          {plan && !plan.result.work.created && plan.result.mainDoc.changed && <p className="shelf-p shelf-dim">{t("shelf.take.mainBecomes", { doc: plan.result.mainDoc.after ?? "" })}</p>}
        </section>
        <section className="shelf-sec" data-ui="take-docs">
          <h3 className="shelf-sec-h">
            {t("shelf.docs")}
            <span>{t("shelf.take.docsAll")}</span>
          </h3>
          {row.docs.map((d) => {
            const skip = skipped.get(d.docId);
            return (
              <div key={d.docId} className={"shelf-check-row shelf-static" + (skip ? " skipped" : "")} data-ui="take-doc" data-ui-key={d.docId}>
                <span className="shelf-row-mark">
                  <Icon name={skip ? "skip-forward" : "check"} cls="ico-sm" />
                </span>
                <span className="shelf-row-main">
                  <span className="shelf-row-title">
                    <DocKindIcon kind={d.kind} />
                    <strong>{t(`shelf.kind.${d.kind}`)}</strong>
                    <code>{d.docId}</code>
                    <span className="mono shelf-dim">{formatBytes(d.bytes)}</span>
                  </span>
                  {skip && (
                    <span className="shelf-warn-text" data-ui="take-doc-skipped">
                      {skip.reason === "seed_conflict"
                        ? t(skip.wouldJoin ? "shelf.take.skip.seed_conflict_work" : "shelf.take.skip.seed_conflict_new", { work: skip.wouldJoin ?? "" })
                        : t(`shelf.take.skip.${skip.reason}`)}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
        </section>
        <section className="shelf-sec" data-ui="take-annotations">
          <h3 className="shelf-sec-h">
            {t("shelf.annotations")}
            <span>{t("shelf.take.annotationsDefault")}</span>
            <span className="mono shelf-push">
              {takenCount}/{total}
            </span>
          </h3>
          {annotations === null && <p className="shelf-dim">{t("shelf.add.annotationsLoading")}</p>}
          {annotations === "error" && (
            <p className="shelf-warn" data-ui="take-annotations-unreadable">
              {t("shelf.take.annotationsUnreadable")}
            </p>
          )}
          {annotations && annotations !== "error" && total === 0 && <p className="shelf-dim">{t("shelf.take.noAnnotations")}</p>}
          {docsWithAnns.map((d) => {
            const skip = skipped.has(d.docId);
            return (
              <div key={d.docId} className={"shelf-ann-group" + (skip ? " off" : "")} data-ui="take-annotation-group" data-ui-key={d.docId}>
                <div className="shelf-ann-group-h">
                  <DocKindIcon kind={d.kind} />
                  <code>{d.docId}</code>
                  <span className="shelf-dim">· {d.annotations.length}</span>
                </div>
                {d.annotations.map((a) => {
                  const where = [a.location.sectionPath, a.location.number, a.location.pageIndex == null ? null : t("shelf.page", { n: a.location.pageIndex + 1 })].filter(Boolean).join(" · ");
                  const kind = d.kind === "pdf" ? t(`shelf.pdfKind.${a.kind as "highlight"}`, { defaultValue: a.kind }) : a.kind === "document" ? t("shelf.annKind.document") : a.kind === "text" ? t("shelf.annKind.text") : t(`shelf.structureKind.${a.kind as "section"}`, { defaultValue: a.kind });
                  return (
                    <label key={a.id} className={"shelf-check-row shelf-ann" + (skip ? " off" : "")} data-ui="take-annotation" data-ui-key={a.id}>
                      <input type="checkbox" checked={!skip && !(excluded[d.docId] ?? []).includes(a.id)} disabled={skip || busy} onChange={(e) => toggleAnn(d.docId, a.id, e.target.checked)} />
                      <AnnotationText a={{ kind, where, snippet: a.snippet, body: a.body }} extra={skip ? <span className="shelf-warn-text">{t("shelf.take.annotationSkipped")}</span> : null} />
                    </label>
                  );
                })}
              </div>
            );
          })}
        </section>
        <section className="shelf-sec" data-ui="take-more">
          <h3 className="shelf-sec-h">{t("shelf.add.more")}</h3>
          <label className="shelf-check-row" data-ui="take-argument-graph">
            <input type="checkbox" checked={graph && !keepLocalGraph} disabled={!row.argumentGraph || keepLocalGraph || busy} onChange={(e) => setGraph(e.target.checked)} />
            <span className="shelf-row-main">
              <strong>{t("shelf.graph")}</strong>
              <span className="shelf-dim">{row.argumentGraph ? t("shelf.take.graphCarried") : t("shelf.add.noGraph")}</span>
              {keepLocalGraph && (
                <span className="shelf-warn-text" data-ui="take-keep-local-graph">
                  {t("shelf.take.keepLocalGraph")}
                </span>
              )}
            </span>
          </label>
          <label className="shelf-check-row" data-ui="take-note">
            <input type="checkbox" checked={note} disabled={!row.note || busy} onChange={(e) => setNote(e.target.checked)} />
            <span className="shelf-row-main">
              <strong>{t("shelf.note")}</strong>
              <span className="shelf-dim">{row.note ? t("shelf.take.noteCarried") : t("shelf.add.noNote")}</span>
              {note && (noteKept || noteExisting) && (
                <span className="shelf-warn-text" data-ui="take-note-not-written">
                  {t(noteKept ? "shelf.take.noteKeptLocal" : "shelf.take.noteExistingWork")}
                </span>
              )}
            </span>
          </label>
        </section>
      </div>
      <div className="shelf-pane-bar">
        <ActionButton mode="text" data-ui="back-to-shelf" label={t("shelf.back")} tooltip={t("shelf.back")} disabled={busy} onClick={onBack}>
          {t("shelf.back")}
        </ActionButton>
        <span className="shelf-push" />
        <ActionButton mode="text" variant="primary" data-ui="submit-take-from-shelf" busy={busy} busyLabel={t("shelf.take.busy")} disabled={!plan} label={t("shelf.take.submit")} tooltip={t("shelf.take.submit")} onClick={() => void run()}>
          {t("shelf.take.submit")}
        </ActionButton>
      </div>
    </div>
  );
}

function resultLines(res: ShelfTakeResult, t: Translate): { text: string; warn?: boolean }[] {
  const cite = res.work.citeKey ?? res.work.id;
  const lines: { text: string; warn?: boolean }[] = [
    { text: res.work.created ? t("shelf.result.newWork", { cite }) : res.work.filled.length ? t("shelf.result.merged", { cite, fields: res.work.filled.join(", ") }) : t("shelf.result.mergedNoFill", { cite }) },
    { text: res.docs.taken.length ? t("shelf.result.docs", { list: res.docs.taken.map((d) => d.docId).join(", ") }) : t("shelf.result.noDocs") },
  ];
  if (res.docs.skipped.length) lines.push({ text: t("shelf.result.skipped", { list: res.docs.skipped.map((d) => d.docId).join(", ") }), warn: true });
  if (!res.work.created && res.mainDoc.changed && res.mainDoc.after) lines.push({ text: t("shelf.result.main", { doc: res.mainDoc.after }) });
  lines.push({ text: t("shelf.result.annotations", { count: res.docs.taken.reduce((n, d) => n + d.annotations, 0) }) });
  lines.push({ text: t(res.argumentGraph === "written" ? "shelf.result.graphWritten" : res.argumentGraph === "kept_local" ? "shelf.result.graphKept" : "shelf.result.graphNone") });
  if (res.note === "written") lines.push({ text: t("shelf.result.noteWritten") });
  if (res.note === "kept_local") lines.push({ text: t("shelf.result.noteKept") });
  if (res.note === "existing_work") lines.push({ text: t("shelf.result.noteExisting") });
  return lines;
}

function ResultPane({ row, result, onDone, onView }: { row: ShelfListRow; result: ShelfTakeResult; onDone: () => void; onView: () => void }) {
  const { t } = useTranslation();
  const viewRef = useRef<HTMLButtonElement>(null);
  useEffect(() => viewRef.current?.focus(), []);
  return (
    <div className="shelf-pane" data-ui="take-from-shelf-result" data-ui-key={row.entryId}>
      <div className="shelf-pane-scroll shelf-stack">
        <div>
          <div className="shelf-k">{t("shelf.take.title")}</div>
          <h2 className="shelf-pane-title serif">{titleOf(row, t)}</h2>
        </div>
        <InlineMessage uiId="take-result" title={t("shelf.result.title")}>
          <ul className="shelf-result-list">
            {resultLines(result, t).map((l, i) => (
              <li key={i} className={l.warn ? "shelf-warn-text" : ""}>
                {l.text}
              </li>
            ))}
          </ul>
        </InlineMessage>
      </div>
      <div className="shelf-pane-bar">
        <ActionButton mode="text" data-ui="close-take-result" label={t("shelf.result.done")} tooltip={t("shelf.result.done")} onClick={onDone}>
          {t("shelf.result.done")}
        </ActionButton>
        <span className="shelf-push" />
        <ActionButton mode="text" variant="primary" ref={viewRef} data-ui="view-taken-work" label={t("shelf.result.view")} tooltip={t("shelf.result.view")} onClick={onView}>
          {t("shelf.result.view")}
        </ActionButton>
      </div>
    </div>
  );
}

function DeleteEntryDialog({ row, onCancel, onDeleted, onStale }: { row: ShelfListRow; onCancel: () => void; onDeleted: () => void; onStale: () => void }) {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string[] | null>(null);
  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const answer = await deleteShelfEntry(row.entryId, row.rev);
    busyRef.current = false;
    setBusy(false);
    if (answer.ok) {
      onDeleted();
      return;
    }
    if (answer.code === "rev_mismatch" || answer.code === "not_found") onStale();
    setError(shelfFailureLines(answer, t, "delete"));
  };
  const ok = row.status === "ok";
  const ids = ok ? [row.identity.doi && `DOI ${row.identity.doi}`, row.identity.arxiv && `arXiv ${row.identity.arxiv}`].filter(Boolean).join(" · ") : "";
  return (
    <Dialog
      uiId="delete-shelf-entry-dialog"
      title={t("shelf.delete.title")}
      closeLabel={t("common.close")}
      busy={busy}
      initialFocusRef={cancelRef}
      onClose={onCancel}
      width={440}
      footer={
        <>
          <ActionButton mode="text" ref={cancelRef} data-ui="cancel-delete-shelf-entry" label={t("common.cancel")} tooltip={t("common.cancel")} disabled={busy} onClick={onCancel}>
            {t("common.cancel")}
          </ActionButton>
          <ActionButton mode="text" variant="danger" data-ui="confirm-delete-shelf-entry" busy={busy} busyLabel={t("shelf.delete.busy")} label={t("shelf.delete.confirm")} tooltip={t("shelf.delete.confirm")} onClick={() => void run()}>
            {t("shelf.delete.confirm")}
          </ActionButton>
        </>
      }
    >
      <div className="shelf-stack ui-delete-doc">
        <div className="ui-delete-doc-identity shelf-delete-identity" data-ui="delete-shelf-entry-identity">
          <strong>{t("shelf.delete.object")}</strong>
          <span className="serif">{titleOf(row, t)}</span>
          <code>{ids || row.entryId}</code>
        </div>
        <InlineMessage tone="warning" title={t("shelf.delete.scopeTitle")}>
          {ok
            ? t("shelf.delete.scope", { docs: row.docs.length, annotations: row.annotations, extra: [row.argumentGraph ? t("shelf.delete.withGraph") : "", row.note ? t("shelf.delete.withNote") : ""].join("") })
            : t("shelf.delete.scopeUnknown")}
        </InlineMessage>
        <p className="ui-delete-doc-count">{t("shelf.delete.irreversible")}</p>
        {error && (
          <InlineMessage tone="danger" uiId="delete-shelf-entry-error" title={t("shelf.delete.failTitle")}>
            {error.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
          </InlineMessage>
        )}
      </div>
    </Dialog>
  );
}
