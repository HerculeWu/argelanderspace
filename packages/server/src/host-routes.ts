/**
 * The host interface (desktop-app tickets 17 and 18; shapes and answers in contracts `host-api.ts`): the page learns
 * which form it runs in and, in the desktop app, asks for a native request or for a project of its recent list.
 *
 * Nothing of the page's reaches the shell. `requests/:kind` never reads the body, and the kind is one of a fixed list:
 * the line the desktop host writes to its shell is built only from what the host itself knows (desktop-host.ts).
 * `recent-projects/open` and `…/remove` read the body's `path` (`remove` from a body of at most
 * {@link RECENT_REQUEST_MAX_BYTES}, `open` from one of at most {@link SWITCH_REQUEST_MAX_BYTES}), and that path is only
 * ever compared, character for character, with the paths of the list: a path that is acted on is one the list holds,
 * never one the page made up. `open` and `switch/confirm` also read `acknowledged`, the ids of what the user saw would
 * be interrupted (desktop-app ticket 19); `switch/*` read the `id` of the folder the host
 * holds — the folder itself came from the shell, never from the page.
 */

import {
  HOST_APP,
  type HostCliStatus,
  type HostCliUnavailable,
  type HostCliUnavailableReason,
  type HostInfo,
  type HostPortFallback,
  type HostProjectState,
  type HostRecentProjects,
  type HostRequestKind,
  type HostSwitchAcknowledged,
  HostSwitchAcknowledgedSchema,
  type HostSwitchImpact,
  type HostSwitchJob,
  type HostSwitchTarget,
  isHostRequestKind,
  isJobFormat,
  type Job,
  jobTarget,
  SWITCH_ACK_MAX_ID_LENGTH,
  SWITCH_ACK_MAX_IDS,
  SWITCH_CONFIRMATION_CODE,
  type WsHostSwitchConfirmation,
} from "@argelanderspace/contracts";
import type { Context } from "hono";
import { readLimited } from "./page-errors.js";
import type { ProtectedRoutes } from "./protected-app.js";

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

/**
 * The command-line tool's launcher (desktop-app ticket 24; infra `cli-launcher.ts`). Each call throws a file system
 * error as it is (its `code` is all the answer carries).
 */
export interface HostCli {
  status(): HostCliStatus;
  /** `foreign`: a file without the app's mark has that name; nothing was written. */
  install(): { outcome: "installed" | "foreign"; status: HostCliStatus };
  /** `foreign`: a file without the app's mark has that name; nothing was removed. */
  uninstall(): { outcome: "removed" | "not_installed" | "foreign"; status: HostCliStatus };
}

/** What the desktop host gives the server it runs: present only in the desktop form. */
export interface HostBridge {
  /** The configured port was taken and this run listens on another one; null otherwise. */
  portFallback: HostPortFallback | null;
  /**
   * The native requests this host takes: every kind, but `open_skills_folder` only when it knows where the bundled
   * skills are (desktop-app ticket 24).
   */
  requests: readonly HostRequestKind[];
  /** Writes the request line; false once the host is shutting down (nothing is written then). */
  request(kind: HostRequestKind): boolean;
  /**
   * The command-line tool (desktop-app ticket 24); null when the host does not know its own Node and CLI, or does not
   * offer the tool (`cliUnavailable`).
   */
  cli: HostCli | null;
  /** Why the host does not offer the command-line tool (desktop-app ticket 26: `appimage`); absent otherwise. */
  cliUnavailable?: HostCliUnavailableReason;
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

/** A job as the switch prompt lists it: its kind and the Work and arXiv id its payload names. */
export function switchJobOf(job: Job): HostSwitchJob | null {
  if (job.status !== "queued" && job.status !== "running") return null;
  // An empty id is none; a format the page does not name (a LaTeX archive has none) is null.
  const target = jobTarget(job);
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    workId: target.workId || null,
    format: isJobFormat(target.format) ? target.format : null,
    arxivId: target.arxivId || null,
  };
}

/** A body that names a path or an id only (`recent-projects/remove`, `switch/cancel`) is at most this long. */
export const RECENT_REQUEST_MAX_BYTES = 16 * 1024;

/**
 * A body that also carries `acknowledged` (`recent-projects/open`, `switch/confirm`) is at most this long: room for a
 * path (or an id) as above and for the most ids `acknowledged` may hold, each written in the longest way JSON allows
 * (every character an escape of six bytes, plus its quotes and comma). Within the id limits a body is never refused as
 * too large; one past them is 400.
 */
export const SWITCH_REQUEST_MAX_BYTES =
  RECENT_REQUEST_MAX_BYTES + 3 * SWITCH_ACK_MAX_IDS * (SWITCH_ACK_MAX_ID_LENGTH * 6 + 3);

/** The body as an object, or why there is none (over the limit, not a JSON object). */
async function objectOfBody(
  c: Context,
  limit: number
): Promise<Record<string, unknown> | "too_large" | "invalid"> {
  let bytes: Uint8Array | null;
  try {
    bytes = await readLimited(c, limit);
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

/** `acknowledged`: absent → null; else three lists of ids within the limits (a list left out is empty), or "invalid". */
function acknowledgedOfBody(
  body: Record<string, unknown>
): HostSwitchAcknowledged | null | "invalid" {
  const raw = body.acknowledged;
  if (raw === undefined || raw === null) return null;
  const parsed = HostSwitchAcknowledgedSchema.safeParse(raw);
  return parsed.success ? parsed.data : "invalid";
}

/** The 400 of a request whose `acknowledged` is not lists of ids within the limits. */
const ACK_INVALID_DETAIL = `acknowledged must be lists of ids (at most ${SWITCH_ACK_MAX_IDS} each, each at most ${SWITCH_ACK_MAX_ID_LENGTH} characters)`;

function invalidRequest(c: Context, detail: string) {
  return c.json({ code: "invalid_request", detail }, 400, NO_STORE);
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
        requests: [...bridge.requests],
        portFallback: bridge.portFallback === null ? null : { ...bridge.portFallback },
        project: bridge.project,
      };
}

export function mountHostRoutes(routes: ProtectedRoutes, bridge: HostBridge | undefined): void {
  const app = routes.withDefaults({ noStore: true });
  app.get("/api/host", { guard: true }, (c) => {
    return c.json(hostInfo(bridge), 200, NO_STORE);
  });

  // The body is never read: a path or an address the page puts there goes nowhere.
  app.post("/api/host/requests/:kind", (c) => {
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const kind = c.req.param("kind");
    if (!isHostRequestKind(kind) || !bridge.requests.includes(kind))
      return c.json({ code: "unknown_request", detail: "unknown request" }, 404, NO_STORE);
    if (!bridge.request(kind))
      return c.json({ code: "shutting_down", detail: "the host is stopping" }, 409, NO_STORE);
    return c.json({ ok: true }, 202, NO_STORE);
  });

  // The command-line tool (desktop-app ticket 24). No body is read: what is installed where is the host's business.
  const withCli = (
    c: Context,
    act: (cli: HostCli) => Response,
    failure: "unreadable" | "write_failed" | "remove_failed"
  ) => {
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    if (bridge.cli === null) {
      const body: HostCliUnavailable =
        bridge.cliUnavailable === undefined
          ? { code: "cli_unavailable", detail: "this host does not know its command-line tool" }
          : {
              code: "cli_unavailable",
              detail: "this host does not offer the command-line tool",
              reason: bridge.cliUnavailable,
            };
      return c.json(body, 404, NO_STORE);
    }
    try {
      return act(bridge.cli);
    } catch (error) {
      // The error's code only: no path, no message.
      const code = (error as NodeJS.ErrnoException | null)?.code;
      const detail = typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "UNKNOWN";
      return c.json({ code: failure, detail }, 500, NO_STORE);
    }
  };
  app.get("/api/host/cli", { guard: true }, (c) =>
    withCli(c, (cli) => c.json(cli.status(), 200, NO_STORE), "unreadable")
  );
  app.post("/api/host/cli/install", (c) =>
    withCli(
      c,
      (cli) => {
        const { outcome, status } = cli.install();
        return outcome === "foreign"
          ? c.json({ code: "foreign", detail: "another file has that name", status }, 409, NO_STORE)
          : c.json({ outcome, status }, 200, NO_STORE);
      },
      "write_failed"
    )
  );
  app.post("/api/host/cli/uninstall", (c) =>
    withCli(
      c,
      (cli) => {
        const { outcome, status } = cli.uninstall();
        return outcome === "foreign"
          ? c.json({ code: "foreign", detail: "another file has that name", status }, 409, NO_STORE)
          : c.json({ outcome, status }, 200, NO_STORE);
      },
      "remove_failed"
    )
  );

  // Recently opened projects (desktop-app ticket 18). The path of a request is only ever compared with the list's.
  app.get("/api/host/recent-projects", { guard: true }, (c) => {
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    return c.json(bridge.recent.list(), 200, NO_STORE);
  });

  app.post("/api/host/recent-projects/open", async (c) => {
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const body = await objectOfBody(c, SWITCH_REQUEST_MAX_BYTES);
    if (body === "too_large") return tooLarge(c);
    const path = body === "invalid" ? null : textField(body, "path");
    if (body === "invalid" || path === null) return invalidRequest(c, "a path is required");
    const acknowledged = acknowledgedOfBody(body);
    if (acknowledged === "invalid") return invalidRequest(c, ACK_INVALID_DETAIL);
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
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const body = await objectOfBody(c, RECENT_REQUEST_MAX_BYTES);
    if (body === "too_large") return tooLarge(c);
    const path = body === "invalid" ? null : textField(body, "path");
    if (path === null) return invalidRequest(c, "a path is required");
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
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const body = await objectOfBody(c, SWITCH_REQUEST_MAX_BYTES);
    if (body === "too_large") return tooLarge(c);
    const id = body === "invalid" ? null : textField(body, "id");
    if (body === "invalid" || id === null) return invalidRequest(c, "an id is required");
    const acknowledged = acknowledgedOfBody(body);
    if (acknowledged === "invalid") return invalidRequest(c, ACK_INVALID_DETAIL);
    if (acknowledged === null) return invalidRequest(c, "what was acknowledged is required");
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
    if (bridge === undefined)
      return c.json({ code: "not_desktop", detail: "no desktop host" }, 404, NO_STORE);
    const body = await objectOfBody(c, RECENT_REQUEST_MAX_BYTES);
    if (body === "too_large") return tooLarge(c);
    const id = body === "invalid" ? null : textField(body, "id");
    if (id === null) return invalidRequest(c, "an id is required");
    // Also while the host stops: ending a hold changes nothing else.
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
