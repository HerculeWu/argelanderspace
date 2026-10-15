import {
  type HostInfo,
  type HostRecentProjects,
  type HostRequestKind,
  type HostSwitchAcknowledged,
  type HostSwitchImpact,
  type HostSwitchTarget,
  isHostInfo,
  isHostRecentProjects,
  isHostSwitchImpact,
  isHostSwitchTarget,
  SWITCH_CONFIRMATION_CODE,
} from "@argelanderspace/contracts";
import { apiRequest, HttpError } from "./request";

/**
 * The host interface (desktop-app ticket 17): which form the page runs in, and — in the desktop app — the native
 * requests. A request sends no body: what to open is the host's business, never the page's.
 */

/** The server's answer; null when it gave no usable one (an older server, or none at all): the browser form then. */
export async function fetchHostInfo(): Promise<HostInfo | null> {
  try {
    const body = await apiRequest<unknown>("/api/host", { cache: "no-store" });
    return isHostInfo(body) ? body : null;
  } catch {
    return null;
  }
}

/** Asks the desktop host for a native request; false when it was not taken (no host, or it is stopping). */
export async function askHost(kind: HostRequestKind): Promise<boolean> {
  try {
    await apiRequest<unknown>(`/api/host/requests/${kind}`, { method: "POST" });
    return true;
  } catch {
    return false;
  }
}

/** The recently opened projects (desktop-app ticket 18); null when there is no usable answer. */
export async function fetchRecentProjects(): Promise<HostRecentProjects | null> {
  try {
    const body = await apiRequest<unknown>("/api/host/recent-projects", { cache: "no-store" });
    return isHostRecentProjects(body) ? body : null;
  } catch {
    return null;
  }
}

/** A switch that would interrupt work: where to, and what it would interrupt now (desktop-app ticket 19). */
export interface SwitchConfirm {
  confirm: { target: HostSwitchTarget; impact: HostSwitchImpact };
}

/** What became of opening a recent project: the host leaves for it, the user must confirm first, or why not. */
export type RecentOpenResult = "leaving" | "unknown_project" | "folder_missing" | "current_project" | "failed" | SwitchConfirm;

/** The 409 `confirmation_required` of a switch, read off its body; null for any other failure. */
function confirmationOf(error: unknown): SwitchConfirm | null {
  if (!(error instanceof HttpError) || error.code !== SWITCH_CONFIRMATION_CODE) return null;
  const body = error.body as { target?: unknown; impact?: unknown } | null;
  return body !== null && isHostSwitchTarget(body.target) && isHostSwitchImpact(body.impact)
    ? { confirm: { target: body.target, impact: body.impact } }
    : null;
}

/**
 * Asks the host to leave for a project of the recent list. With a project open, `acknowledged` names what the user
 * confirmed would be interrupted; the server checks it against what would be interrupted at that moment.
 */
export async function openRecentProject(path: string, acknowledged?: HostSwitchAcknowledged): Promise<RecentOpenResult> {
  try {
    await apiRequest<unknown>("/api/host/recent-projects/open", {
      method: "POST",
      json: acknowledged === undefined ? { path } : { path, acknowledged },
    });
    return "leaving";
  } catch (error) {
    const confirm = confirmationOf(error);
    if (confirm !== null) return confirm;
    const code = error instanceof HttpError ? error.code : "";
    return code === "unknown_project" || code === "folder_missing" || code === "current_project" ? code : "failed";
  }
}

/** What became of confirming the switch to a folder the host holds. */
export type SwitchConfirmResult = "leaving" | "unknown_switch" | "folder_missing" | "failed" | SwitchConfirm;

/** Confirms the switch to the folder the host holds under `id`. */
export async function confirmSwitch(id: string, acknowledged: HostSwitchAcknowledged): Promise<SwitchConfirmResult> {
  try {
    await apiRequest<unknown>("/api/host/switch/confirm", { method: "POST", json: { id, acknowledged } });
    return "leaving";
  } catch (error) {
    const confirm = confirmationOf(error);
    if (confirm !== null) return confirm;
    const code = error instanceof HttpError ? error.code : "";
    return code === "unknown_switch" || code === "folder_missing" ? code : "failed";
  }
}

/** Ends the host's hold of a picked folder; nothing else changes. A failure changes nothing either. */
export async function cancelSwitch(id: string): Promise<void> {
  try {
    await apiRequest<unknown>("/api/host/switch/cancel", { method: "POST", json: { id } });
  } catch {
    /* the hold is replaced by the next pick or ends with the host */
  }
}

/** Removes a project from the recent list; the list after, or null when that failed. */
export async function removeRecentProject(path: string): Promise<HostRecentProjects | null> {
  try {
    const body = await apiRequest<unknown>("/api/host/recent-projects/remove", { method: "POST", json: { path } });
    return isHostRecentProjects(body) ? body : null;
  } catch {
    return null;
  }
}
