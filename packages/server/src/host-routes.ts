/**
 * The host interface (desktop-app ticket 17; shapes in contracts `host-api.ts`): the page learns which form it runs in
 * and, in the desktop app, asks for a native request. The request carries nothing of the page's: the route never
 * reads the body, and the kind is one of a fixed list — the line the desktop host writes to its shell is built only
 * from what the host itself knows (desktop-host.ts).
 */

import {
  HOST_APP,
  HOST_REQUEST_KINDS,
  type HostInfo,
  type HostPortFallback,
  type HostRequestKind,
  isHostRequestKind,
} from "@argelanderspace/contracts";
import type { Hono } from "hono";

type Guard = (origin: string | undefined) => { body: { detail: string }; status: 403 } | null;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** What the desktop host gives the server it runs: present only in the desktop form. */
export interface HostBridge {
  /** The configured port was taken and this run listens on another one; null otherwise. */
  portFallback: HostPortFallback | null;
  /** Writes the request line; false once the host is shutting down (nothing is written then). */
  request(kind: HostRequestKind): boolean;
}

/** The answer of `GET /api/host` for a server with this bridge (none: the browser form). */
export function hostInfo(bridge: HostBridge | undefined): HostInfo {
  return bridge === undefined
    ? { version: 1, app: HOST_APP, mode: "browser", requests: [], portFallback: null }
    : {
        version: 1,
        app: HOST_APP,
        mode: "desktop",
        requests: [...HOST_REQUEST_KINDS],
        portFallback: bridge.portFallback === null ? null : { ...bridge.portFallback },
      };
}

export function mountHostRoutes(app: Hono, guardCsrf: Guard, bridge: HostBridge | undefined): void {
  app.get("/api/host", (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    return c.json(hostInfo(bridge), 200, NO_STORE);
  });

  // The body is never read: a path or an address the page puts there goes nowhere.
  app.post("/api/host/requests/:kind", (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const kind = c.req.param("kind");
    if (!isHostRequestKind(kind))
      return c.json({ code: "unknown_request", detail: "unknown request" }, 404, NO_STORE);
    if (!bridge.request(kind))
      return c.json({ code: "shutting_down", detail: "the host is stopping" }, 409, NO_STORE);
    return c.json({ ok: true }, 202, NO_STORE);
  });
}
