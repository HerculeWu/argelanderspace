import {
  type HostInfo,
  type HostRecentProjects,
  type HostRequestKind,
  isHostInfo,
  isHostRecentProjects,
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

/** What became of opening a recent project: the host leaves for it, or why not (the server's code). */
export type RecentOpenResult = "leaving" | "unknown_project" | "folder_missing" | "failed";

/** Asks the host to leave for a project of the recent list. */
export async function openRecentProject(path: string): Promise<RecentOpenResult> {
  try {
    await apiRequest<unknown>("/api/host/recent-projects/open", { method: "POST", json: { path } });
    return "leaving";
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "";
    return code === "unknown_project" || code === "folder_missing" ? code : "failed";
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
