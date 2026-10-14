import { type HostInfo, type HostRequestKind, isHostInfo } from "@argelanderspace/contracts";
import { apiRequest } from "./request";

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
