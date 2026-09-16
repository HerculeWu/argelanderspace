/**
 * Stage 13 — the import menu's creation dialog: one identifier (DOI / arXiv),
 * one ADS bibcode, or a raw BibTeX batch. Per-entry outcomes are rendered
 * in place; single-entry modes close + open the work's detail on success,
 * the batch mode reports every entry and closes to the first created one.
 *
 * Server error strings are shown raw (server details are not translated,
 * Stage 9 scope); only status labels and chrome are localized.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createWorks } from "../api/library";
import { Icon } from "../lib/icons";
import type { LibraryRef, ManualWorkRequest, ManualWorkResult } from "./types";

export type ImportMode = "identifier" | "bibcode" | "bib";

function requestFor(mode: ImportMode, input: string): ManualWorkRequest | null {
  const v = input.trim();
  if (!v) return null;
  if (mode === "identifier") return { mode: "identifier", value: v };
  if (mode === "bibcode") return { mode: "bibcode", bibcode: v };
  return { mode: "bib", bib: input.trim() };
}

function ResultRow({ r }: { r: ManualWorkResult }) {
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
    <div className={`import-result ${r.status}`}>
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
}: {
  mode: ImportMode;
  onClose: () => void;
  /** A created/existing work to select + open (single modes: on submit;
   *  batch mode: the first created entry, on close). */
  onResolved: (ref: LibraryRef) => void;
}) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ManualWorkResult[] | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, busy]);

  const batch = mode === "bib";
  const submit = async () => {
    const req = requestFor(mode, input);
    if (!req || busy) return;
    setBusy(true);
    setFatal(null);
    const resp = await createWorks(req);
    setBusy(false);
    if (resp === null) {
      setFatal(t("library.importDialog.unreachable"));
      return;
    }
    const first = resp.results[0];
    if (!batch && first && first.status !== "error" && first.ref) {
      // single modes: success opens the work's detail immediately
      onResolved(first.ref);
      onClose();
      return;
    }
    setResults(resp.results);
  };

  const close = () => {
    if (busy) return;
    // batch: closing after a partial/complete import selects the first created
    const firstCreated = results?.find((r) => r.status === "created" && r.ref);
    if (firstCreated?.ref) onResolved(firstCreated.ref);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    // IME guard: an Enter that confirms a composition must not submit
    if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit();
  };

  return (
    <div className="plan-modal-overlay" onClick={close}>
      <div
        className="plan-modal"
        style={{ width: batch ? 560 : 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="plan-modal-head">
          <div className="plan-modal-titles">
            <div className="plan-modal-title">{t(`library.importDialog.${mode}Title`)}</div>
            <div className="plan-modal-sub">{t(`library.importDialog.${mode}Sub`)}</div>
          </div>
          <button className="btn icon ghost" onClick={close}>
            <Icon name="x" cls="ico-sm" />
          </button>
        </div>
        <div className="plan-modal-body">
          <div className="plan-field">
            <span className="plan-field-label">{t(`library.importDialog.${mode}Label`)}</span>
            {batch ? (
              <textarea
                className="plan-note-textarea mono"
                rows={9}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={t("library.importDialog.bibPlaceholder")}
              />
            ) : (
              <input
                className="plan-field-input"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t(`library.importDialog.${mode}Placeholder`)}
              />
            )}
          </div>
          {fatal && <div className="plan-modal-warning">{fatal}</div>}
          {results && (
            <div className="import-results">
              {results.map((r, i) => (
                <ResultRow key={r.key ?? i} r={r} />
              ))}
            </div>
          )}
        </div>
        <div className="plan-modal-foot">
          <button className="btn" onClick={close}>
            {t("library.importDialog.close")}
          </button>
          <button
            className="btn primary"
            disabled={busy || !input.trim()}
            onClick={() => void submit()}
          >
            <Icon name={busy ? "loader" : "plus"} cls={"ico-sm" + (busy ? " spin" : "")} />
            {busy
              ? t("library.importDialog.busy")
              : batch
                ? t("library.importDialog.submitMany")
                : t("library.importDialog.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
