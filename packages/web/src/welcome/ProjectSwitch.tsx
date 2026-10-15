import {
  acknowledgedOf,
  type HostRecentProject,
  type HostSwitchImpact,
  type HostSwitchJob,
  type HostSwitchTarget,
} from "@argelanderspace/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { cancelSwitch, confirmSwitch, openRecentProject, type SwitchConfirm } from "../api/host";
import { onHostSwitchConfirmation } from "../api/ws";
import { Button, Dialog, InlineMessage } from "../ui";
import "../settings/settings.css";

/**
 * Switching projects with one open (desktop-app ticket 19; approved prototype, ticket 03: the confirmation before a
 * switch). When nothing would be interrupted the host leaves at once; otherwise the page asks first: the dialog says
 * which project opens, the tasks the switch interrupts (the server's queued and running jobs, live Copilot runs) and
 * the mail still in its undo window (it stays in Drafts, unsent). Cancel changes nothing. "Switch anyway" sends back
 * the ids the user saw; the server checks them against what would be interrupted at that moment, and when something
 * new came up the dialog shows the new list and asks again.
 *
 * Two ways in: a recent project the page opens (the server answers 409 with the impact), and a folder the shell
 * picked (the server holds it and tells every page, `host.switch-confirmation`). One prompt at a time; the latest wins.
 */

type Prompt =
  | { kind: "recent"; path: string; target: HostSwitchTarget; impact: HostSwitchImpact }
  | { kind: "picked"; id: string; target: HostSwitchTarget; impact: HostSwitchImpact };

interface SwitchState {
  prompt: Prompt | null;
  /** The host accepted a switch: it is stopping, and the shell starts the next host with a new page. */
  leaving: boolean;
}

let state: SwitchState = { prompt: null, leaving: false };
const listeners = new Set<() => void>();
function set(next: Partial<SwitchState>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useProjectSwitch(): SwitchState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** Tests only: no prompt, not leaving. */
export function resetProjectSwitchForTests(): void {
  state = { prompt: null, leaving: false };
}

/** What became of opening a recent project from the page: left for, asked about, or why not. */
export type OpenFromListResult = "leaving" | "asked" | "unknown_project" | "folder_missing" | "current_project" | "failed";

/** Opens a recent project with a project open: leaves at once, or puts the confirmation in front of the user. */
export async function openFromList(project: HostRecentProject): Promise<OpenFromListResult> {
  const result = await openRecentProject(project.path);
  if (typeof result === "object") {
    set({ prompt: { kind: "recent", path: project.path, ...result.confirm } });
    return "asked";
  }
  if (result === "leaving") set({ leaving: true, prompt: null });
  return result;
}

const JOB_LABEL = {
  ingest: "projectSwitch.jobIngest",
  refresh: "projectSwitch.jobRefresh",
} as const;

function jobKey(job: HostSwitchJob) {
  if (job.kind !== "upload") return JOB_LABEL[job.kind];
  if (job.format === "arxiv-pdf") return "projectSwitch.jobArxivPdf" as const;
  if (job.format === "pdf") return "projectSwitch.jobPdf" as const;
  return "projectSwitch.jobUpload" as const;
}

/** The seconds left of a mail's undo window, read again every second while the dialog is open. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

/** The dialog itself (approved prototype `switch-project`): the target, then what is interrupted; Cancel has the focus. */
export function SwitchProjectDialog({ target, impact, busy, changed, failed, onCancel, onConfirm }: {
  target: HostSwitchTarget;
  impact: HostSwitchImpact;
  busy: boolean;
  /** The server found more to interrupt than the user had seen. */
  changed: boolean;
  failed: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  const safe = useRef<HTMLButtonElement>(null);
  const now = useNow(impact.mail.length > 0);
  const tasks = impact.jobs.length + impact.conversations.length;
  const queued = impact.jobs.some((job) => job.status === "queued");
  return (
    <Dialog title={t("projectSwitch.title", { name: target.name })} uiId="switch-project" closeLabel={t("projectSwitch.close")} onClose={onCancel} busy={busy} initialFocusRef={safe}
      footer={<>
        <Button ref={safe} data-ui="switch-project-cancel" disabled={busy} onClick={onCancel}>{t("projectSwitch.cancel")}</Button>
        <Button appearance="primary" tone="danger" data-ui="switch-project-confirm" busy={busy} disabled={busy} onClick={onConfirm}>{t("projectSwitch.confirm")}</Button>
      </>}>
      <div className="st-switch-stack">
        <p>{t("projectSwitch.target", { path: target.display })}</p>
        {changed && <InlineMessage tone="warning" uiId="switch-project-changed">{t("projectSwitch.changed")}</InlineMessage>}
        {tasks > 0 && (
          <div data-ui="switch-busy-tasks">
            <p>{t(queued ? "projectSwitch.tasksQueued" : "projectSwitch.tasks", { count: tasks })}</p>
            <ul className="st-switch-list">
              {impact.jobs.map((job) => {
                const subject = job.arxivId ?? job.workId;
                const parts = [t(jobKey(job)), ...(subject ? [subject] : []), ...(job.status === "queued" ? [t("projectSwitch.jobQueued")] : [])];
                return <li key={job.id} data-ui="switch-busy-job" data-ui-key={job.id}>{parts.join(" · ")}</li>;
              })}
              {impact.conversations.map((c) => (
                <li key={c.id} data-ui="switch-busy-conversation" data-ui-key={c.id}>{t("projectSwitch.conversation", { title: c.title.trim() || t("projectSwitch.untitled") })}</li>
              ))}
            </ul>
          </div>
        )}
        {impact.mail.length > 0 && (
          <div data-ui="switch-busy-mail">
            <p>{t("projectSwitch.mail", { count: impact.mail.length })}</p>
            <ul className="st-switch-list">
              {impact.mail.map((m) => {
                const seconds = Math.ceil((m.endsAt - now) / 1000);
                const subject = m.subject.trim() || t("projectSwitch.noSubject");
                return (
                  <li key={m.sendId} data-ui="switch-busy-mail-item" data-ui-key={m.sendId}>
                    {seconds > 0 ? t("projectSwitch.mailLeft", { subject, seconds }) : t("projectSwitch.mailEnding", { subject })}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {failed && <InlineMessage tone="danger" uiId="switch-project-failed">{t("projectSwitch.failed")}</InlineMessage>}
      </div>
    </Dialog>
  );
}

/**
 * The confirmation before a switch, for the whole workbench (mounted once in the shell): the prompt a recent project
 * or a picked folder put up. `notify` shows a passing notice (the settings notices).
 */
export function ProjectSwitchPrompt({ notify }: { notify: (text: string) => void }) {
  const { t } = useTranslation();
  const { prompt, leaving } = useProjectSwitch();
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  const [failed, setFailed] = useState(false);

  // A folder the shell picked, held by the host: the newest one replaces whatever was being asked.
  useEffect(() => {
    try {
      return onHostSwitchConfirmation((msg) => {
        if (state.leaving) return;
        setChanged(false);
        setFailed(false);
        set({ prompt: { kind: "picked", id: msg.id, target: msg.target, impact: msg.impact } });
      });
    } catch {
      /* no live channel: a picked folder that needs a confirmation is not switched to, and nothing changes */
      return undefined;
    }
  }, []);

  if (prompt === null) return null;

  const close = () => {
    setChanged(false);
    setFailed(false);
    set({ prompt: null });
  };
  const cancel = () => {
    // Cancel changes nothing: the host only stops holding the folder.
    if (prompt.kind === "picked") void cancelSwitch(prompt.id);
    close();
  };
  const confirm = async () => {
    const current = prompt;
    setBusy(true);
    setFailed(false);
    const acknowledged = acknowledgedOf(current.impact);
    const result = current.kind === "recent" ? await openRecentProject(current.path, acknowledged) : await confirmSwitch(current.id, acknowledged);
    // Another prompt replaced this one meanwhile: its answer is not this dialog's business.
    if (state.prompt !== current) return setBusy(false);
    if (result === "leaving") {
      // The host is stopping; the dialog stays, busy, until the shell brings the next project's page.
      set({ leaving: true });
      return;
    }
    setBusy(false);
    if (typeof result === "object") {
      setChanged(true);
      set({ prompt: { ...current, ...(result as SwitchConfirm).confirm } });
    } else if (result === "folder_missing") {
      close();
      notify(t("welcome.nowMissing"));
    } else if (result === "unknown_switch") {
      close();
      notify(t("projectSwitch.gone"));
    } else setFailed(true);
  };
  return (
    <SwitchProjectDialog target={prompt.target} impact={prompt.impact} busy={busy || leaving} changed={changed} failed={failed} onCancel={cancel} onConfirm={() => void confirm()} />
  );
}
