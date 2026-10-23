import { createWsBus } from "./ws-bus";

/**
 * The page's one WebSocket bus (one lazily-opened connection per page). `ws.ts` forwards its exports to it; a feature
 * module that must not depend on how a test stubs `ws.ts` (the Shelf, shelf ticket 05) subscribes here directly.
 */
function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

export const bus = createWsBus(() => new WebSocket(wsUrl()));
