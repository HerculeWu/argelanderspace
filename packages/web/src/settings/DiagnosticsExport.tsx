import { DIAGNOSTICS_CLIENT_MAX_LENGTH, DIAGNOSTICS_COMPILE_LOGS_MAX_FILES, type DiagnosticsInfo } from "@argelanderspace/contracts";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { chooseSaveTarget, exportDiagnostics, fetchDiagnostics, saveBundle, suggestedBundleName, writeBundle } from "../api/diagnostics";
import { useHostInfo } from "../host";
import { Icon } from "../lib/icons";
import { Button, Dialog, InlineMessage } from "../ui";

/**
 * The "Export diagnostics" dialog (desktop-app ticket 14), as in the approved prototype: what the bundle holds, one
 * box for the compile-failure logs — not ticked, and saying that they quote the paper's or manuscript's source — and
 * Export. Ticked, the dialog lists the files that will go in and their size together. With no compile-failure log in
 * the project the box cannot be ticked and says so; until the list has come, the box waits. The request names the
 * files listed, and the bundle holds those (as far as they are still there) — never one the user was not shown.
 *
 * Saving (user decision 2026-10-14): where the browser has the system's save window (`showSaveFilePicker`), Export
 * opens it first — in the click itself, before the bundle is asked for, since the window may only open from a click —
 * and the bundle is written to the file chosen; cancelling it asks for nothing and leaves the dialog as it was.
 * Elsewhere the bundle goes to the browser's downloads. Nothing is uploaded.
 */

/** Bytes as the page shows sizes: `812 B`, `14.2 KB`, `3.4 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Phase =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; name: string; bytes: number; saved: "picker" | "download" }
  | { kind: "failed"; picked: boolean };

export function DiagnosticsExportDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  // The desktop app's downloads open its own save window (desktop-app ticket 21), not a browser's downloads.
  const desktop = useHostInfo()?.mode === "desktop";
  const [info, setInfo] = useState<DiagnosticsInfo | null | "loading">("loading");
  const [include, setInclude] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const cancel = useRef<HTMLButtonElement>(null);
  const done = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    fetchDiagnostics(ac.signal).then(setInfo, () => {});
    return () => ac.abort();
  }, []);

  const logs = info !== null && info !== "loading" ? info.compileLogs : [];
  const included = logs.filter((log) => log.included);
  const left = logs.length - included.length;
  const loading = info === "loading";
  const none = !loading && included.length === 0;
  const busy = phase.kind === "busy";
  const finished = phase.kind === "done";

  const run = async () => {
    const ticked = include && !none && !loading;
    setPhase({ kind: "busy" });
    // A place chosen in the save window may already hold an empty file when the export then fails.
    let picked = false;
    try {
      // First, in the click itself: where to save (the system's save window, when there is one).
      const target = await chooseSaveTarget(suggestedBundleName(), t("settings.diagnostics.zipType"));
      if (target === null) {
        // Cancelled: nothing was asked for, nothing is said.
        setPhase({ kind: "idle" });
        return;
      }
      picked = target.kind === "picker";
      const bundle = await exportDiagnostics({
        includeCompileLogs: ticked,
        ...(ticked ? { compileLogs: included.map((log) => log.name) } : {}),
        client: navigator.userAgent.slice(0, DIAGNOSTICS_CLIENT_MAX_LENGTH),
      });
      if (target.kind === "picker") {
        await writeBundle(target.handle, bundle);
        setPhase({ kind: "done", name: target.handle.name, bytes: bundle.blob.size, saved: "picker" });
      } else {
        saveBundle(bundle);
        setPhase({ kind: "done", name: bundle.name, bytes: bundle.blob.size, saved: "download" });
      }
    } catch {
      setPhase({ kind: "failed", picked });
    }
  };

  // After the export: the keyboard goes to "Done", or back to "Cancel" when it failed or the save window was cancelled.
  useEffect(() => {
    if (phase.kind === "done") done.current?.focus();
    else if (phase.kind === "failed" || phase.kind === "idle") cancel.current?.focus();
  }, [phase.kind]);

  return (
    <Dialog
      title={t("settings.diagnostics.exportTitle")}
      uiId="export-diagnostics"
      closeLabel={t("common.close")}
      onClose={onClose}
      busy={busy}
      initialFocusRef={cancel as React.RefObject<HTMLElement>}
      footer={
        finished ? (
          <Button ref={done} appearance="primary" data-ui="export-diagnostics-done" onClick={onClose}>{t("settings.diagnostics.done")}</Button>
        ) : (
          <>
            <Button ref={cancel} data-ui="export-diagnostics-cancel" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
            <Button appearance="primary" data-ui="export-diagnostics-run" busy={busy} busyLabel={<><Icon name="loader-circle" cls="ico-sm spin" />{t("settings.diagnostics.exporting")}</>} onClick={() => void run()}>
              {t("settings.diagnostics.exportRun")}
            </Button>
          </>
        )
      }
    >
      <p>{t("settings.diagnostics.exportBody")}</p>
      <label className={"st-check" + (none ? " disabled" : "")} data-ui="export-include-compile-label">
        <input
          type="checkbox"
          data-ui="export-include-compile"
          checked={include && !none}
          disabled={loading || none || busy || finished}
          onChange={(e) => setInclude(e.target.checked)}
        />
        <span>{t("settings.diagnostics.exportCompile")}</span>
      </label>
      {info === null && (
        <p className="st-export-note" data-ui="export-compile-unknown">{t("settings.diagnostics.compileUnknown")}</p>
      )}
      {info !== null && info !== "loading" && none && (
        <p className="st-export-note" data-ui="export-no-compile-logs">
          {logs.length === 0 ? t("settings.diagnostics.noCompileLogs") : t("settings.diagnostics.compileAllTooLarge")}
        </p>
      )}
      {include && !none && (
        <div className="st-export-files" data-ui="export-compile-list">
          <p className="st-export-note">
            {t("settings.diagnostics.compileListTitle", {
              count: included.length,
              size: formatBytes(included.reduce((sum, log) => sum + log.bytes, 0)),
            })}
          </p>
          <ul>
            {included.map((log) => (
              <li key={log.name} data-ui="export-compile-file" data-ui-key={log.name}>
                <code className="st-path">{log.name.replace(/^compile-failures\//, "")}</code>
                <span className="st-export-size">{formatBytes(log.bytes)}</span>
              </li>
            ))}
          </ul>
          {left > 0 && (
            <p className="st-export-note" data-ui="export-compile-over-limit">
              {t("settings.diagnostics.compileOverLimit", {
                count: left,
                limit: formatBytes(info !== null && info !== "loading" ? info.compileLogsLimitBytes : 0),
                files: DIAGNOSTICS_COMPILE_LOGS_MAX_FILES,
              })}
            </p>
          )}
        </div>
      )}
      {phase.kind === "done" && (
        <InlineMessage tone="info" uiId="export-diagnostics-result">
          {phase.saved === "picker"
            ? t("settings.diagnostics.exportSaved", { name: phase.name, size: formatBytes(phase.bytes) })
            : `${t("settings.diagnostics.exportDone", { name: phase.name, size: formatBytes(phase.bytes) })} ${t(desktop ? "settings.diagnostics.exportDoneNoteDesktop" : "settings.diagnostics.exportDoneNote")}`}
        </InlineMessage>
      )}
      {phase.kind === "failed" && (
        <InlineMessage tone="danger" uiId="export-diagnostics-failed">
          {phase.picked ? `${t("settings.diagnostics.exportFailed")} ${t("settings.diagnostics.exportFailedPicked")}` : t("settings.diagnostics.exportFailed")}
        </InlineMessage>
      )}
    </Dialog>
  );
}
