/**
 * Stage 13 — the import menu's creation dialog: one identifier (DOI / arXiv),
 * one ADS bibcode, or a raw BibTeX batch. Per-entry outcomes are rendered
 * in place; single-entry modes close + open the work's detail on success,
 * the batch mode reports every entry and closes to the first created one.
 *
 * Server error strings are shown raw (server details are not translated,
 * Stage 9 scope); only status labels and chrome are localized.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type ArgumentGraphMergeNote, libraryImportRequest } from "@argelanderspace/contracts";
import { createWorks } from "../api/library";
import { Icon } from "../lib/icons";
import { findOnShelf, identifierIds, projectHas, type ShelfHit, ShelfHint, shelfTakeTarget } from "../shelf/already-on-shelf";
import { ActionButton } from "../ui";
import { MergeNoteList } from "./MergeNotes";
import type { LibraryRef, ManualWorkRequest, ManualWorkResult } from "./types";

export type ImportMode = "identifier" | "bibcode" | "bib";

function requestFor(mode: ImportMode, input: string): ManualWorkRequest | null {
  const v = input.trim();
  if (!v) return null;
  // the same request the Copilot import_works action builds from the same text
  return libraryImportRequest({ mode, text: input });
}

function ResultRow({ r, index }: { r: ManualWorkResult; index: number }) {
  const { t } = useTranslation();
  const icon =
    r.status === "created" ? "check-circle-2" : r.status === "exists" ? "info" : "x-circle";
  const label =
    r.status === "created"
      ? t("library.importDialog.created")
      : r.status === "exists"
        ? t("library.importDialog.exists")
        : t("library.importDialog.failed");
  return (
    <div className={`import-result ${r.status}`} data-ui="import-result" data-ui-key={index}>
      <Icon name={icon} cls="ico-sm" />
      <span className="import-result-body">
        <span className="import-result-title">
          {r.ref ? r.ref.title : (r.key ?? "")}
          <span className="import-result-status mono">{label}</span>
        </span>
        {r.key && r.ref && <span className="import-result-key mono">{r.key}</span>}
        {r.error && <span className="import-result-err">{r.error}</span>}
      </span>
    </div>
  );
}

export function ImportDialog({
  mode,
  onClose,
  onResolved,
  works = [],
  onTakeFromShelf,
}: {
  mode: ImportMode;
  onClose: () => void;
  /** A created/existing work to select + open (single modes: on submit;
   *  batch mode: the first created entry, on close). */
  onResolved: (ref: LibraryRef) => void;
  /** The project's Works: an identifier the project already has is not looked up on the Shelf. */
  works?: readonly LibraryRef[];
  /** "Take from Shelf…" in the already-on-Shelf hint (shelf ticket 06; identifier mode only). Absent: no hint. */
  onTakeFromShelf?: (target: { entryId: string; take: boolean }) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ManualWorkResult[] | null>(null);
  const [merges, setMerges] = useState<ArgumentGraphMergeNote[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  // The already-on-Shelf hint (shelf ticket 06): asked only after a submit, never while typing (review Q6).
  const checkShelf = mode === "identifier" && onTakeFromShelf !== undefined;
  const [hits, setHits] = useState<ShelfHit[] | null>(null);
  const lookup = useRef<AbortController | null>(null);
  useEffect(() => () => lookup.current?.abort(), []);
  const inputRef = useRef(input);
  inputRef.current = input;

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, busy]);

  const batch = mode === "bib";
  /** `asUsual`: the hint was declined (or is up and Enter was pressed): add without asking the Shelf again. */
  const submit = async (asUsual = hits !== null) => {
    const req = requestFor(mode, input);
    if (!req || busy) return;
    setBusy(true);
    setFatal(null);
    const ids = checkShelf && !asUsual ? identifierIds(input) : null;
    if (ids && !projectHas(ids, works)) {
      const controller = new AbortController();
      lookup.current = controller;
      let found: ShelfHit[] | null;
      try {
        found = await findOnShelf(ids, controller.signal);
      } catch {
        return; // aborted: the dialog is gone
      }
      // The identifier was edited while the Shelf was asked: this answer is about another paper. Nothing is shown or
      // created; the person submits the new input when ready.
      if (inputRef.current !== input) {
        setBusy(false);
        return;
      }
      // Not known (the Shelf could not be asked): the add goes ahead as usual, without a word about the Shelf.
      if (found && found.length > 0) {
        setBusy(false);
        setHits(found);
        return;
      }
    }
    setHits(null);
    const resp = await createWorks(req);
    setBusy(false);
    if (resp === null) {
      setFatal(t("library.importDialog.unreachable"));
      return;
    }
    const first = resp.results[0];
    const notes = resp.argument_graph_merges ?? [];
    if (resp.failed_after_merge === true) setFatal(t("library.graphMerge.partial"));
    // A merge that met an argument graph must be read, so the dialog stays open and shows it.
    if (!batch && first && first.status !== "error" && first.ref && notes.length === 0) {
      // single modes: success opens the work's detail immediately
      onResolved(first.ref);
      onClose();
      return;
    }
    setResults(resp.results);
    setMerges(notes);
  };

  const close = () => {
    if (busy) return;
    // batch: closing after a partial/complete import selects the first created
    const firstCreated = results?.find((r) => r.status === "created" && r.ref);
    if (firstCreated?.ref) onResolved(firstCreated.ref);
    else if (!batch && merges.length > 0) {
      // single mode would have opened the Work right away; the merge note delayed it to here
      const open = results?.find((r) => r.status !== "error" && r.ref);
      if (open?.ref) onResolved(open.ref);
    }
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME guard: an Enter that confirms a composition must not submit
    if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
  };

  return (
    <div className="plan-modal-overlay" data-ui="dialog-overlay" onClick={close}>
      <div
        className="plan-modal"
        data-ui="import-dialog" data-ui-key={mode}
        style={{ width: batch ? 560 : 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="plan-modal-head">
          <div className="plan-modal-titles">
            <div className="plan-modal-title">{t(`library.importDialog.${mode}Title`)}</div>
            <div className="plan-modal-sub">{t(`library.importDialog.${mode}Sub`)}</div>
          </div>
          <ActionButton unstyled mode="icon" iconSize="small" iconName="x" className="btn icon ghost" data-ui="close-import" label={t("common.close")} tooltip={t("common.close")} onClick={close} />
        </div>
        <div className="plan-modal-body">
          <div className="plan-field">
            <span className="plan-field-label">{t(`library.importDialog.${mode}Label`)}</span>
            {batch ? (
              <textarea
                data-ui="import-input"
                className="plan-note-textarea mono"
                rows={9}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t("library.importDialog.bibPlaceholder")}
              />
            ) : (
              <input
                data-ui="import-input"
                className="plan-field-input"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  setHits(null);
                }}
                onKeyDown={onKeyDown}
                placeholder={t(`library.importDialog.${mode}Placeholder`)}
              />
            )}
          </div>
          {fatal && <div className="plan-modal-warning" data-ui="import-error">{fatal}</div>}
          {hits && <ShelfHint hits={hits} />}
          {results && (
            <div className="import-results" data-ui="import-results">
              {results.map((r, i) => (
                <ResultRow key={r.key ?? i} r={r} index={i} />
              ))}
              <MergeNoteList notes={merges} uiId="import-graph-merge" />
            </div>
          )}
        </div>
        <div className="plan-modal-foot">
          <ActionButton unstyled mode="text" className="btn" data-ui="cancel-import" label={t("library.importDialog.close")} tooltip={t("library.importDialog.close")} onClick={close}>
            {t("library.importDialog.close")}
          </ActionButton>
          {hits && onTakeFromShelf ? (
            <>
              <ActionButton unstyled mode="text" className="btn" data-ui="import-as-usual" label={t("shelf.hint.createAsUsual")} tooltip={t("shelf.hint.createAsUsual")} busy={busy} disabled={busy} onClick={() => void submit(true)}>
                {t("shelf.hint.createAsUsual")}
              </ActionButton>
              <ActionButton unstyled mode="text" className="btn primary" data-ui="take-from-shelf-instead" label={t("shelf.hint.take")} tooltip={t("shelf.hint.take")} disabled={busy} onClick={() => onTakeFromShelf(shelfTakeTarget(hits))}>
                {t("shelf.hint.take")}
              </ActionButton>
            </>
          ) : (
          <ActionButton
            unstyled
            mode="text"
            className="btn primary"
            data-ui="submit-import"
            label={t(busy ? "library.importDialog.busy" : batch ? "library.importDialog.submitMany" : "library.importDialog.submit")}
            tooltip={t(busy ? "library.importDialog.busy" : batch ? "library.importDialog.submitMany" : "library.importDialog.submit")}
            busy={busy}
            disabled={!input.trim()}
            onClick={() => void submit()}
          >
            {t(busy ? "library.importDialog.busy" : batch ? "library.importDialog.submitMany" : "library.importDialog.submit")}
          </ActionButton>
          )}
        </div>
      </div>
    </div>
  );
}
