/**
 * The host interface (desktop-app tickets 17 and 18; shapes and answers in contracts `host-api.ts`): the page learns
 * which form it runs in and, in the desktop app, asks for a native request or for a project of its recent list.
 *
 * Nothing of the page's reaches the shell. `requests/:kind` never reads the body, and the kind is one of a fixed list:
 * the line the desktop host writes to its shell is built only from what the host itself knows (desktop-host.ts).
 * `recent-projects/open` and `…/remove` read only the body's `path` (at most {@link RECENT_REQUEST_MAX_BYTES}), and
 * that path is only ever compared, character for character, with the paths of the list: a path that is acted on is
 * one the list holds, never one the page made up. `open` and `switch/confirm` also read `acknowledged`, the ids of
 * what the user saw would be interrupted (desktop-app ticket 19); `switch/*` read the `id` of the folder the host
 * holds — the folder itself came from the shell, never from the page.
 */

import {
  HOST_APP,
  HOST_REQUEST_KINDS,
  type HostInfo,
  type HostPortFallback,
  type HostProjectState,
  type HostRecentProjects,
  type HostRequestKind,
  type HostSwitchAcknowledged,
  type HostSwitchImpact,
  type HostSwitchJob,
  type HostSwitchTarget,
  isHostRequestKind,
  type Job,
  SWITCH_CONFIRMATION_CODE,
  type WsHostSwitchConfirmation,
} from "@argelanderspace/contracts";
import type { Context, Hono } from "hono";
import { readLimited } from "./page-errors.js";

type Guard = (origin: string | undefined) => { body: { detail: string }; status: 403 } | null;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** What a server with a project open gives its desktop host (desktop-app ticket 19): see {@link HostBridge.useWorkbench}. */
export interface HostWorkbench {
  /** What switching away now would interrupt: the runner's queued and running jobs, live Copilot runs, mail in its undo window. */
  impact(): HostSwitchImpact;
  /** Tells every page of this server. */
  broadcast(message: WsHostSwitchConfirmation): void;
}

/** A switch the user has not confirmed: where to, and what it would interrupt now. */
export interface SwitchConfirmation {
  confirm: { target: HostSwitchTarget; impact: HostSwitchImpact };
}

/** What became of confirming a held switch. */
export type SwitchConfirmOutcome =
  | "leaving"
  | "unknown_switch"
  | "folder_missing"
  | "shutting_down"
  | SwitchConfirmation;

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
    /**
     * Leave for this project of the list: the host stops and tells its shell the next project. With a project open,
     * only when `acknowledged` covers everything the switch would interrupt now (desktop-app ticket 19).
     */
    open(path: string, acknowledged: HostSwitchAcknowledged | null): RecentOpenOutcome;
    /** Removes it from the list; the list after. */
    remove(path: string): HostRecentProjects;
  };
  /** The folder the shell picked, held until the user confirms the switch (desktop-app ticket 19). */
  switching: {
    confirm(id: string, acknowledged: HostSwitchAcknowledged): SwitchConfirmOutcome;
    /** Ends the hold of this id (another id: nothing). */
    cancel(id: string): void;
  };
  /** The server of an open project hands its host what a switch would interrupt and its way to the pages. */
  useWorkbench(workbench: HostWorkbench): void;
}

/** What became of a request to open a recent project. */
export type RecentOpenOutcome =
  | "leaving"
  | "unknown_project"
  | "folder_missing"
  | "current_project"
  | "shutting_down"
  | SwitchConfirmation;

/** An upload job's `payload.format` the page names (a LaTeX archive has none). */
const JOB_FORMATS = ["pdf", "arxiv-pdf"] as const;

/** A job as the switch prompt lists it: its kind and the Work and arXiv id its payload names. */
export function switchJobOf(job: Job): HostSwitchJob | null {
  if (job.status !== "queued" && job.status !== "running") return null;
  const p =
    typeof job.payload === "object" && job.payload !== null && !Array.isArray(job.payload)
      ? (job.payload as Record<string, unknown>)
      : {};
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
  const format = (JOB_FORMATS as readonly unknown[]).includes(p.format)
    ? (p.format as HostSwitchJob["format"])
    : null;
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    workId: str(p.workId),
    format,
    arxivId: str(p.arxivId),
  };
}

/** At most this many ids in each list of `acknowledged`, each at most this long. */
const ACK_MAX_IDS = 1000;
const ACK_MAX_ID_LENGTH = 200;

/** A path in the body is at most this long (bytes of the whole body). */
export const RECENT_REQUEST_MAX_BYTES = 16 * 1024;

/** The body as an object, or why there is none (over the limit, not a JSON object). */
async function objectOfBody(
  c: Context
): Promise<Record<string, unknown> | "too_large" | "invalid"> {
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
    return body as Record<string, unknown>;
  } catch {
    return "invalid";
  }
}

/** A non-empty string field of the body, or null. */
function textField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === "string" && value !== "" ? value : null;
}

/** `acknowledged`: absent → null; else three lists of ids, or "invalid". */
function acknowledgedOfBody(
  body: Record<string, unknown>
): HostSwitchAcknowledged | null | "invalid" {
  const raw = body.acknowledged;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return "invalid";
  const ids = (value: unknown): string[] | null =>
    Array.isArray(value) &&
    value.length <= ACK_MAX_IDS &&
    value.every((id) => typeof id === "string" && id.length <= ACK_MAX_ID_LENGTH)
      ? (value as string[])
      : null;
  const r = raw as Record<string, unknown>;
  const jobs = ids(r.jobs ?? []);
  const conversations = ids(r.conversations ?? []);
  const mail = ids(r.mail ?? []);
  return jobs === null || conversations === null || mail === null
    ? "invalid"
    : { jobs, conversations, mail };
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
    const body = await objectOfBody(c);
    if (body === "too_large") return tooLarge(c);
    const path = body === "invalid" ? null : textField(body, "path");
    const acknowledged = body === "invalid" ? "invalid" : acknowledgedOfBody(body);
    if (path === null || acknowledged === "invalid")
      return c.json({ code: "invalid_request", detail: "a path is required" }, 400, NO_STORE);
    const outcome = bridge.recent.open(path, acknowledged);
    if (typeof outcome === "object") return confirmationRequired(c, outcome);
    switch (outcome) {
      case "leaving":
        return c.json({ ok: true }, 202, NO_STORE);
      case "unknown_project":
        return c.json({ code: outcome, detail: "not a recent project" }, 404, NO_STORE);
      case "folder_missing":
        return c.json({ code: outcome, detail: "the folder is not there" }, 409, NO_STORE);
      case "current_project":
        return c.json({ code: outcome, detail: "this project is open" }, 409, NO_STORE);
      case "shutting_down":
        return c.json({ code: outcome, detail: "the host is stopping" }, 409, NO_STORE);
    }
  });

  app.post("/api/host/recent-projects/remove", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const body = await objectOfBody(c);
    if (body === "too_large") return tooLarge(c);
    const path = body === "invalid" ? null : textField(body, "path");
    if (path === null)
      return c.json({ code: "invalid_request", detail: "a path is required" }, 400, NO_STORE);
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

  // Switching to a folder the shell picked, held until the user confirms (desktop-app ticket 19).
  app.post("/api/host/switch/confirm", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const body = await objectOfBody(c);
    if (body === "too_large") return tooLarge(c);
    const id = body === "invalid" ? null : textField(body, "id");
    const acknowledged = body === "invalid" ? "invalid" : acknowledgedOfBody(body);
    if (id === null || acknowledged === "invalid" || acknowledged === null)
      return c.json(
        { code: "invalid_request", detail: "an id and what was acknowledged are required" },
        400,
        NO_STORE
      );
    const outcome = bridge.switching.confirm(id, acknowledged);
    if (typeof outcome === "object") return confirmationRequired(c, outcome);
    switch (outcome) {
      case "leaving":
        return c.json({ ok: true }, 202, NO_STORE);
      case "unknown_switch":
        return c.json({ code: outcome, detail: "no such switch is waiting" }, 404, NO_STORE);
      case "folder_missing":
        return c.json({ code: outcome, detail: "the folder is not there" }, 409, NO_STORE);
      case "shutting_down":
        return c.json({ code: outcome, detail: "the host is stopping" }, 409, NO_STORE);
    }
  });

  app.post("/api/host/switch/cancel", async (c) => {
    const rejected = guardCsrf(c.req.header("origin"));
    if (rejected) return c.json(rejected.body, rejected.status, NO_STORE);
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const body = await objectOfBody(c);
    if (body === "too_large") return tooLarge(c);
    const id = body === "invalid" ? null : textField(body, "id");
    if (id === null)
      return c.json({ code: "invalid_request", detail: "an id is required" }, 400, NO_STORE);
    bridge.switching.cancel(id);
    return c.json({ ok: true }, 200, NO_STORE);
  });
}

function tooLarge(c: Context) {
  return c.json({ code: "too_large", detail: "the request is too large" }, 413, NO_STORE);
}

/** The 409 of a switch the user has not confirmed (yet, or not all of what it would interrupt now). */
function confirmationRequired(c: Context, outcome: SwitchConfirmation) {
  return c.json(
    {
      code: SWITCH_CONFIRMATION_CODE,
      detail: "switching would interrupt work in progress",
      target: outcome.confirm.target,
      impact: outcome.confirm.impact,
    },
    409,
    NO_STORE
  );
}
