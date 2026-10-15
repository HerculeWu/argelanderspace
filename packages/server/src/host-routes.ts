/**
 * The host interface (desktop-app tickets 17 and 18; shapes and answers in contracts `host-api.ts`): the page learns
 * which form it runs in and, in the desktop app, asks for a native request or for a project of its recent list.
 *
 * Nothing of the page's reaches the shell. `requests/:kind` never reads the body, and the kind is one of a fixed list:
 * the line the desktop host writes to its shell is built only from what the host itself knows (desktop-host.ts).
 * `recent-projects/open` and `…/remove` read only the body's `path` (at most {@link RECENT_REQUEST_MAX_BYTES}), and
 * that path is only ever compared, character for character, with the paths of the list: a path that is acted on is
 * one the list holds, never one the page made up.
 */

import {
  HOST_APP,
  HOST_REQUEST_KINDS,
  type HostInfo,
  type HostPortFallback,
  type HostProjectState,
  type HostRecentProjects,
  type HostRequestKind,
  isHostRequestKind,
} from "@argelanderspace/contracts";
import type { Context, Hono } from "hono";
import { readLimited } from "./page-errors.js";

type Guard = (origin: string | undefined) => { body: { detail: string }; status: 403 } | null;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** What the desktop host gives the server it runs: present only in the desktop form. */
export interface HostBridge {
  /** The configured port was taken and this run listens on another one; null otherwise. */
  portFallback: HostPortFallback | null;
  /** Writes the request line; false once the host is shutting down (nothing is written then). */
  request(kind: HostRequestKind): boolean;
  /** Whether a project is open; `none`: the welcome state (desktop-app ticket 18). */
  project: HostProjectState;
  /** The recently opened projects (desktop-app ticket 18, desktop-host.ts). */
  recent: {
    list(): HostRecentProjects;
    /** Leave for this project of the list: the host stops and tells its shell the next project. */
    open(path: string): RecentOpenOutcome;
    /** Removes it from the list; the list after. */
    remove(path: string): HostRecentProjects;
  };
}

/** What became of a request to open a recent project. */
export type RecentOpenOutcome =
  | "leaving"
  | "unknown_project"
  | "folder_missing"
  | "project_open"
  | "shutting_down";

/** A path in the body is at most this long (bytes of the whole body). */
export const RECENT_REQUEST_MAX_BYTES = 16 * 1024;

/** Read off the body: its `path`, or why there is none (over the limit, or not a `{path}` body). */
type PathOfBody = { path: string } | "too_large" | "invalid";

async function pathOfBody(c: Context): Promise<PathOfBody> {
  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(c, RECENT_REQUEST_MAX_BYTES);
  } catch {
    return "invalid";
  }
  if (bytes === null) return "too_large";
  try {
    const body = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return "invalid";
    const path = (body as Record<string, unknown>).path;
    return typeof path === "string" && path !== "" ? { path } : "invalid";
  } catch {
    return "invalid";
  }
}

/** The answer of `GET /api/host` for a server with this bridge (none: the browser form). */
export function hostInfo(bridge: HostBridge | undefined): HostInfo {
  return bridge === undefined
    ? {
        version: 1,
        app: HOST_APP,
        mode: "browser",
        requests: [],
        portFallback: null,
        project: "open",
      }
    : {
        version: 1,
        app: HOST_APP,
        mode: "desktop",
        requests: [...HOST_REQUEST_KINDS],
        portFallback: bridge.portFallback === null ? null : { ...bridge.portFallback },
        project: bridge.project,
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

  // Recently opened projects (desktop-app ticket 18). The path of a request is only ever compared with the list's.
  app.get("/api/host/recent-projects", (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    return c.json(bridge.recent.list(), 200, NO_STORE);
  });

  app.post("/api/host/recent-projects/open", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const read = await pathOfBody(c);
    if (read === "too_large")
      return c.json({ code: "too_large", detail: "the request is too large" }, 413, NO_STORE);
    if (read === "invalid")
      return c.json({ code: "invalid_request", detail: "a path is required" }, 400, NO_STORE);
    const { path } = read;
    const outcome = bridge.recent.open(path);
    switch (outcome) {
      case "leaving":
        return c.json({ ok: true }, 202, NO_STORE);
      case "unknown_project":
        return c.json({ code: outcome, detail: "not a recent project" }, 404, NO_STORE);
      case "folder_missing":
        return c.json({ code: outcome, detail: "the folder is not there" }, 409, NO_STORE);
      case "project_open":
        return c.json({ code: outcome, detail: "a project is open" }, 409, NO_STORE);
      case "shutting_down":
        return c.json({ code: outcome, detail: "the host is stopping" }, 409, NO_STORE);
    }
  });

  app.post("/api/host/recent-projects/remove", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const read = await pathOfBody(c);
    if (read === "too_large")
      return c.json({ code: "too_large", detail: "the request is too large" }, 413, NO_STORE);
    if (read === "invalid")
      return c.json({ code: "invalid_request", detail: "a path is required" }, 400, NO_STORE);
    const { path } = read;
    try {
      return c.json(bridge.recent.remove(path), 200, NO_STORE);
    } catch {
      return c.json(
        { code: "write_failed", detail: "the list could not be written" },
        500,
        NO_STORE
      );
    }
  });
}
