import type { TutorialState, WsHostTutorialResult } from "@argelanderspace/contracts";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { askTutorial } from "../api/host";
import { fetchTutorial } from "../api/tutorial";
import { onHostSwitchConfirmation, onHostTutorialResult } from "../api/ws";
import { usePreferences } from "../argelander/preferences";
import { useHostAnswer } from "../host";
import { ActionButton, Button, Dialog, InlineMessage } from "../ui";
import { markTutorialEntry } from "./entry";
import { samePath } from "./progress";
import "../settings/settings.css";
import "./tutorial-entry.css";

/**
 * The tutorial's entry (in-app-tutorial ticket 25; spec §2 「入口」, §6 「重新开始」「旧版示例」): "Start / Resume
 * tutorial" and "Restart…" on the welcome page and the settings page, and the restart dialog the chapter rail's
 * "Restart…" opens too. The label follows `GET /api/tutorial`: a bound folder that is there and marked is resumed,
 * otherwise the tutorial starts (the host asks for a parent folder). Everything is carried out by the desktop host;
 * the page sends no path. A failure the host announces (`host.tutorial-result`) is shown where the entry is, and a
 * click tries again. In the browser form there are no buttons: the command (`argelanderspace tutorial`, and
 * `--reset` for a restart) is shown to copy.
 *
 * Before it asks the host to switch, an entry writes the one-time entry mark (`markTutorialEntry`), so the next page
 * shows the tutorial's card at once instead of only its capsule.
 */

/** The browser form's commands (data, not copy: the CLI's name and flag). */
export const TUTORIAL_COMMAND = "argelanderspace tutorial";
export const TUTORIAL_RESET_COMMAND = "argelanderspace tutorial --reset";

// The last failure the host announced: kept for the page's life, so that an entry mounted later (the settings page
// opened again) still shows it until the next click.
let lastFailure: WsHostTutorialResult | null = null;
const failureListeners = new Set<() => void>();
function setFailure(next: WsHostTutorialResult | null): void {
  lastFailure = next;
  for (const listener of failureListeners) listener();
}
const subscribeFailure = (listener: () => void) => {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
};
/** Tests only. */
export function resetTutorialEntryForTests(): void {
  lastFailure = null;
}

export interface TutorialEntryState {
  /** undefined: not known yet; null: no usable answer. */
  state: TutorialState | null | undefined;
  /** The desktop app (buttons) or the browser form (commands); undefined until the host answered. */
  desktop: boolean | undefined;
  /** The bound folder is there and marked: "Resume tutorial". */
  ready: boolean;
  /** This installation has no sample: starting and restarting are not possible. */
  sampleMissing: boolean;
  /** The bound folder was made from another sample than the one this installation has. */
  outdated: boolean;
  /** The host took a resume or a restart and is preparing the switch. */
  starting: boolean;
  failure: WsHostTutorialResult | null;
  start(): void;
  resume(): void;
  /** Asks the host to restart (after the dialog's confirmation); what came of the request. */
  restart(): Promise<"accepted" | "refused" | "failed">;
  reload(): Promise<void>;
}

/** The entry's state and actions; `root` is the open project's folder (null on the welcome page). */
export function useTutorialEntry(root: string | null, opts: { reloadPage?: () => void } = {}): TutorialEntryState {
  const P = usePreferences();
  const { t } = useTranslation();
  const host = useHostAnswer();
  const [state, setState] = useState<TutorialState | null | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const failure = useSyncExternalStore(subscribeFailure, () => lastFailure, () => lastFailure);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  const reload = useCallback(async () => {
    const next = await fetchTutorial().catch(() => null);
    if (alive.current) setState(next);
  }, []);
  useEffect(() => void reload(), [reload]);

  useEffect(() => {
    const offResult = onHostTutorialResult((message) => {
      setFailure(message);
      setStarting(false);
      void reload();
    });
    // The host made the folder and now asks whether the switch may interrupt work: the prompt takes over; a cancel
    // leaves the folder bound, so the label becomes "Resume tutorial".
    const offSwitch = onHostSwitchConfirmation(() => {
      setStarting(false);
      void reload();
    });
    return () => {
      offResult();
      offSwitch();
    };
  }, [reload]);

  const ready = state?.project?.state === "ready";
  const bundled = state?.sample.bundled ?? null;
  const sampleMissing = state !== undefined && state !== null && bundled === null;
  const outdated = ready && bundled !== null && state?.sample.project !== bundled;
  const isOpen = ready && root !== null && samePath(state?.project?.path, root);

  const refused = (result: string) => {
    if (result === "failed") P.notify(t("settings.host.requestFailed"));
    else void reload();
  };

  return {
    state,
    desktop: host === undefined ? undefined : host?.mode === "desktop",
    ready,
    sampleMissing,
    outdated,
    starting,
    failure,
    reload,
    start() {
      setFailure(null);
      markTutorialEntry();
      void askTutorial("pick").then((result) => {
        if (alive.current && result !== "accepted") refused(result);
      });
    },
    resume() {
      setFailure(null);
      markTutorialEntry();
      // Already in the tutorial project: the next page load takes the mark and shows the card.
      if (isOpen) {
        (opts.reloadPage ?? (() => window.location.reload()))();
        return;
      }
      setStarting(true);
      void askTutorial("continue").then((result) => {
        if (!alive.current || result === "accepted") return;
        setStarting(false);
        refused(result);
      });
    },
    async restart() {
      setFailure(null);
      markTutorialEntry();
      const result = await askTutorial("restart");
      if (result === "accepted") return "accepted";
      if (alive.current) void reload();
      return result === "failed" ? "failed" : "refused";
    },
  };
}

/** The danger message of a failure the host announced. */
export function TutorialFailure({ failure }: { failure: WsHostTutorialResult }) {
  const { t } = useTranslation();
  return (
    <InlineMessage tone="danger" uiId="tutorial-entry-failed">
      <span data-state={failure.reason}>{t(`tutorial.entry.failed.${failure.reason}`, { path: failure.path.display })}</span>
    </InlineMessage>
  );
}

/** The buttons: "Start / Resume tutorial", the note when there is no sample, "Restart…" beside it. */
export function TutorialEntryButtons({ entry, ui, onRestart }: { entry: TutorialEntryState; ui: "welcome" | "settings"; onRestart: () => void }) {
  const { t } = useTranslation();
  const known = entry.state !== undefined;
  const canStart = !entry.ready && !entry.sampleMissing;
  return (
    <div className="tut-entry" data-ui="tutorial-entry" data-state={entry.ready ? "resume" : entry.sampleMissing ? "no-sample" : "start"}>
      <Button
        appearance="secondary"
        data-ui={`${ui}-start-tutorial`}
        disabled={!known || entry.starting || (!entry.ready && !canStart)}
        busy={entry.starting}
        onClick={() => (entry.ready ? entry.resume() : entry.start())}
      >
        {entry.ready ? t("tutorial.entry.resume") : t("tutorial.entry.start")}
      </Button>
      {entry.ready && (
        <Button appearance="quiet" className="tut-entry-restart" data-ui={`${ui}-restart-tutorial`} disabled={entry.sampleMissing || entry.starting} onClick={onRestart}>
          {t("tutorial.entry.restart")}
        </Button>
      )}
      {entry.sampleMissing && <span className="tut-entry-note" data-ui="tutorial-sample-missing">{t("tutorial.entry.sampleMissing")}</span>}
      {entry.starting && <span className="tut-entry-note" data-ui="tutorial-entry-starting" role="status">{t("tutorial.entry.starting")}</span>}
    </div>
  );
}

/** What is said below the buttons: the older-sample warning beside "Resume tutorial", and a failure. */
export function TutorialEntryMessages({ entry, hideFailure = false }: { entry: TutorialEntryState; hideFailure?: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      {entry.outdated && <InlineMessage tone="warning" uiId="tutorial-outdated-sample">{t("tutorial.entry.outdatedSample")}</InlineMessage>}
      {entry.failure && !hideFailure && <TutorialFailure failure={entry.failure} />}
    </>
  );
}

/** A command with its copy button; the copy's outcome is said beside it. */
export function TutorialCommand({ command, ui }: { command: string; ui: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState<"ok" | "refused" | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied("ok");
    } catch {
      setCopied("refused");
    }
  };
  return (
    <div className="st-codeline">
      <code data-ui={ui}>{command}</code>
      <ActionButton mode="icon" iconName="copy" iconSize="small" data-ui={`copy-${ui}`} label={t("tutorial.ui.copy")} tooltip={t("tutorial.ui.copy")} onClick={() => void copy()} />
      {copied === "ok" && <span className="tut-entry-note" role="status">{t("tutorial.ui.copied")}</span>}
      {copied === "refused" && <span className="tut-entry-note" role="alert" data-ui="tutorial-command-copy-failed">{t("tutorial.ui.copyFailed")}</span>}
    </div>
  );
}

/**
 * "Restart…" asked: in the desktop app the confirmation (it names the folder and what is deleted; the safe action has
 * the focus; while the host takes the request nothing closes it; a failure stays in it to retry or cancel); in the
 * browser the command to run in a terminal.
 */
export function TutorialRestartDialog({ entry, path, desktop, onClose }: { entry: TutorialEntryState; path: string; desktop: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const safe = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  /** The host took the request: a failure it announces from now on is this restart's. */
  const [asked, setAsked] = useState(false);
  /** The request itself got no answer. */
  const [unanswered, setUnanswered] = useState(false);
  const announced = asked ? entry.failure : null;
  useEffect(() => {
    if (announced !== null) setBusy(false);
  }, [announced]);
  // The host asks first whether the switch may interrupt work: that prompt takes over.
  useEffect(() => onHostSwitchConfirmation(() => onClose()), [onClose]);

  if (!desktop)
    return (
      <Dialog title={t("tutorial.ui.restartBrowser.title")} uiId="restart-tutorial-browser" closeLabel={t("common.close")} onClose={onClose} initialFocusRef={safe}
        footer={<Button ref={safe} data-ui="restart-tutorial-close" onClick={onClose}>{t("common.close")}</Button>}>
        <p>{t("tutorial.ui.restartBrowser.body")}</p>
        <TutorialCommand command={TUTORIAL_RESET_COMMAND} ui="tutorial-reset-command" />
      </Dialog>
    );

  const confirm = async () => {
    setBusy(true);
    setUnanswered(false);
    setAsked(false);
    const result = await entry.restart();
    // Taken: the dialog stays busy until the host has switched and the page is replaced, or a failure is announced.
    if (result === "accepted") {
      setAsked(true);
      return;
    }
    setBusy(false);
    if (result === "refused") onClose();
    else setUnanswered(true);
  };
  return (
    <Dialog title={t("tutorial.ui.restartDialog.title")} uiId="restart-tutorial" closeLabel={t("common.cancel")} onClose={onClose} busy={busy} initialFocusRef={safe}
      footer={<>
        <Button ref={safe} data-ui="restart-tutorial-cancel" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
        <Button appearance="primary" tone="danger" data-ui="restart-tutorial-confirm" busy={busy} disabled={busy} onClick={() => void confirm()}>{t("tutorial.ui.restartDialog.confirm")}</Button>
      </>}>
      <p>{t("tutorial.ui.restartDialog.body", { path })}</p>
      {announced && <TutorialFailure failure={announced} />}
      {unanswered && <InlineMessage tone="danger" uiId="restart-tutorial-failed">{t("settings.host.requestFailed")}</InlineMessage>}
    </Dialog>
  );
}
