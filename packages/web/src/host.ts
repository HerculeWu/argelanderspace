import type { HostInfo, HostRequestKind } from "@argelanderspace/contracts";
import { useSyncExternalStore } from "react";
import { askHost, fetchHostInfo } from "./api/host";

/**
 * The page's capability flag (desktop-app ticket 17): the desktop app or a browser, asked of the server once per page
 * (it does not change while the page lives — a new Project is a new host and a new page). Until the answer comes, and
 * when there is none, the page is in the browser form: a desktop-only control never shows where it cannot work.
 */

let info: HostInfo | null = null;
let asked: Promise<void> | null = null;
const listeners = new Set<() => void>();

function ask(): void {
  if (asked) return;
  asked = fetchHostInfo().then((answer) => {
    info = answer;
    for (const listener of listeners) listener();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ask();
  return () => listeners.delete(listener);
}

/** The server's answer, or null while it is not known (or there is none): treat null as the browser form. */
export function useHostInfo(): HostInfo | null {
  return useSyncExternalStore(subscribe, () => info, () => null);
}

/** In the desktop app: the native request, or null when this page cannot make it (the browser form). */
export function useHostRequest(kind: HostRequestKind): (() => Promise<boolean>) | null {
  const host = useHostInfo();
  return host !== null && host.mode === "desktop" && host.requests.includes(kind) ? () => askHost(kind) : null;
}

/** Tests only: forget the answer, so the next page asks again. */
export function resetHostInfoForTests(): void {
  info = null;
  asked = null;
}
