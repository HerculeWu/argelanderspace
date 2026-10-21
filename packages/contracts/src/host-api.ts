/**
 * The host interface (desktop-app ticket 17): what the page asks of the program it runs in.
 *
 * - `GET  /api/host`                  → {@link HostInfo}: the form the workbench is delivered in (the capability flag),
 *                                       the native requests the page may make, and whether the port fell back.
 * - `POST /api/host/requests/:kind`   → 202 `{ ok: true }`; the desktop host writes one request line to its shell
 *                                       (server `desktop-host.ts`). The request has no body: whatever the page sends
 *                                       is never read, so no path or address of the page's reaches the shell.
 *                                       404 `not_desktop` in the browser form, 404 `unknown_request` for a kind not
 *                                       in {@link HOST_REQUEST_KINDS}, 409 `shutting_down` while the host stops.
 *
 * Recently opened projects (desktop-app ticket 18), desktop form only (404 `not_desktop` in the browser):
 * - `GET  /api/host/recent-projects`         → {@link HostRecentProjects}.
 * - `POST /api/host/recent-projects/open`    `{path, acknowledged?}` → 202 `{ ok: true }`: the host leaves for that
 *                                       project (it stops and tells its shell the next project). Only a path of the
 *                                       list is taken: 404 `unknown_project` otherwise, 409 `folder_missing` when the
 *                                       folder is gone, 409 `current_project` for the project that is open, 409
 *                                       `shutting_down` while the host stops. With a project open (desktop-app ticket
 *                                       19) the switch would interrupt what {@link HostSwitchImpact} lists: unless
 *                                       `acknowledged` names every one of those, 409 {@link SWITCH_CONFIRMATION_CODE}
 *                                       with the `impact` as it is now, and nothing changes.
 * - `POST /api/host/recent-projects/remove`  `{path}` → 200 {@link HostRecentProjects}, the list without it (a path
 *                                       not in the list changes nothing); 500 `write_failed` when the list file
 *                                       cannot be written (the old list stays).
 *   `remove` reads only the body's `path`; `open` reads `path` and `acknowledged` ({@link HostSwitchAcknowledgedSchema}).
 *   The path is only compared with the list's paths, character for character. 400 `invalid_request` when the body is
 *   not a `{path}` with a non-empty string, or (`open`) when `acknowledged` is there but not lists of ids within
 *   {@link SWITCH_ACK_MAX_IDS} / {@link SWITCH_ACK_MAX_ID_LENGTH}. 413 `too_large` when the body is over the limit
 *   (server `RECENT_REQUEST_MAX_BYTES`, 16 KiB, for `remove`; `SWITCH_REQUEST_MAX_BYTES` for `open`, room for a path
 *   and the most ids `acknowledged` may hold; reading stops at the limit).
 *
 * Switching to a folder the shell picked while a project is open (desktop-app ticket 19): when nothing would be
 * interrupted the host leaves at once; otherwise it holds the folder and tells every page (WebSocket
 * {@link WsHostSwitchConfirmation}: an `id`, the folder, the impact) and waits for the user:
 * - `POST /api/host/switch/confirm`  `{id, acknowledged}` → 202 `{ ok: true }`, the host leaves; 404 `unknown_switch`
 *                                       when the id is not the one held (cancelled, replaced, or never), 409
 *                                       `folder_missing` when the folder has gone meanwhile (the hold ends), 409
 *                                       {@link SWITCH_CONFIRMATION_CODE} with the impact now when something new would be
 *                                       interrupted (the hold stays), 409 `shutting_down`. 400 `invalid_request` without
 *                                       an `id` or an `acknowledged`, or with one that is not lists of ids as above;
 *                                       413 `too_large` over `SWITCH_REQUEST_MAX_BYTES`.
 * - `POST /api/host/switch/cancel`   `{id}` → 200 `{ ok: true }`: the hold of that id ends (another id: nothing);
 *                                       nothing else changes. Also 200 while the host stops. 400 `invalid_request`
 *                                       without an `id`, 413 `too_large` over 16 KiB.
 *
 * The command-line tool (desktop-app ticket 24), desktop form only (404 `not_desktop` in the browser; 404
 * `cli_unavailable` from a host that does not know its own Node and CLI, or that does not offer the tool — then with a
 * `reason` of {@link HOST_CLI_UNAVAILABLE_REASONS}: `appimage`, run from an AppImage, desktop-app ticket 26). Neither
 * request reads a body:
 * - `GET  /api/host/cli`            → {@link HostCliStatus}: the launcher in the user's executable directory, whether that
 *                                     directory is on PATH, and the line the user would add (the app changes no PATH).
 * - `POST /api/host/cli/install`    → 200 {@link HostCliChange} `installed`; 409 `{code: "foreign", status}` when a file
 *                                     without the app's mark has that name (it is not overwritten); 500
 *                                     `{code: "write_failed", detail: <error code>}`.
 * - `POST /api/host/cli/uninstall`  → 200 {@link HostCliChange} `removed` / `not_installed`; 409 `{code: "foreign",
 *                                     status}` (only a file with the mark is removed); 500 `{code: "remove_failed", …}`.
 *   `GET` answers 500 `{code: "unreadable", detail}` when what is at the launcher's path cannot be looked at. A 500's
 *   `detail` is the error's code only (`EACCES`), never a path or a message.
 *
 * The tutorial's entry (in-app-tutorial ticket 25), desktop form only (404 `not_desktop` in the browser). None reads a
 * body: the folder comes from the shell's dialog or from `tutorial.json`, never from the page.
 * - `POST /api/host/tutorial/pick`      → 202 `{ ok: true }`: the host writes the existing `pick_folder` request line and
 *                                       takes the answer as the parent folder of the tutorial (or a tutorial folder
 *                                       itself): it makes `ArgelanderSpace-Tutorial` there and copies the bundled
 *                                       sample into it (or takes the marked folder that is there), binds the tutorial
 *                                       progress to it, records it among the recent projects and leaves for it.
 * - `POST /api/host/tutorial/continue`  → 202: leaves for the folder `tutorial.json` is bound to.
 * - `POST /api/host/tutorial/restart`   → 202: empties the bound folder (only a marked one), copies the sample again,
 *                                       clears the progress and leaves for it.
 *   409 {@link HOST_TUTORIAL_REFUSALS}: `no_sample` (this installation has no sample), `tutorial_missing` (`continue` /
 *   `restart`: no bound folder, or it is gone or has no marker), `current_project` (`continue`: the tutorial is the
 *   project open now), `tutorial_busy` (one of these is still under way), `shutting_down`. With a project open whose
 *   switch would interrupt work, the folder is made first and the switch is then held and announced as any picked
 *   folder (`host.switch-confirmation`). What fails after the 202 — the copy, the folder the shell answered — is
 *   announced to every page as {@link WsHostTutorialResult}; nothing is left for then.
 *
 * All are `no-store` and behind the same cross-origin guard as every other endpoint. `serve` (the browser form) has
 * no host: its answer is `mode: "browser"` with no requests, and the page hides the desktop-only controls.
 *
 * With no project open (the desktop host's welcome state, `project: "none"`) the server answers only the page, the
 * host interface, the settings interface, the tutorial progress (`/api/tutorial`, `tutorial.ts`) and the page's own
 * error reports (`POST /api/page-errors`, written to the user log only); every other endpoint answers 409
 * {@link NO_PROJECT_CODE}.
 */

import { z } from "zod";
import { JobFormatSchema } from "./job-payload.js";
import { JobKindSchema } from "./job-status.js";

/** The name every answer carries, so a program on the port can be told from the workbench. */
export const HOST_APP = "argelanderspace";

/** How the workbench is delivered. */
export const HOST_MODES = ["browser", "desktop"] as const;
export type HostMode = (typeof HOST_MODES)[number];

/**
 * The native requests, a fixed list; none takes a path or an address from the page. `open_skills_folder` (desktop-app
 * ticket 24) is offered only by a host that knows where the bundled skills are.
 */
export const HOST_REQUEST_KINDS = [
  "pick_folder",
  "open_in_browser",
  "open_devtools",
  "open_log_folder",
  "open_config_file",
  "open_skills_folder",
] as const;
export type HostRequestKind = (typeof HOST_REQUEST_KINDS)[number];

export function isHostRequestKind(value: unknown): value is HostRequestKind {
  return typeof value === "string" && (HOST_REQUEST_KINDS as readonly string[]).includes(value);
}

/** What held the configured port when the desktop host started. */
export const HOST_PORT_OCCUPANTS = ["argelanderspace", "other"] as const;
export type HostPortOccupant = (typeof HOST_PORT_OCCUPANTS)[number];

/** The configured port was taken: this run listens on another one, so the CLI's links (to the configured port) fail. */
export interface HostPortFallback {
  /** The port config.toml gives (or the default). */
  configured: number;
  /** The port this run listens on. */
  actual: number;
  /** Another ArgelanderSpace server answered on the configured port, or something else holds it. */
  occupant: HostPortOccupant;
}

/** Whether a project is open: `none` is the desktop host's welcome state (never the browser form). */
export const HOST_PROJECT_STATES = ["open", "none"] as const;
export type HostProjectState = (typeof HOST_PROJECT_STATES)[number];

/** The `code` of every business endpoint's answer (409) while no project is open. */
export const NO_PROJECT_CODE = "no_project";

/** The `code` of a switch the user has not yet confirmed: the 409's body carries the {@link HostSwitchImpact}. */
export const SWITCH_CONFIRMATION_CODE = "confirmation_required";

export interface HostInfo {
  version: 1;
  app: typeof HOST_APP;
  mode: HostMode;
  /** The native requests the page may make: all of them in the desktop form, none in the browser. */
  requests: HostRequestKind[];
  /** Null unless the desktop host had to listen on another port than the configured one. */
  portFallback: HostPortFallback | null;
  /** `none`: no project is open and the page shows the welcome page. Always `open` in the browser form. */
  project: HostProjectState;
}

/** A path of the machine that runs the server, and as the page shows it (the home directory written as `~`). */
export interface HostShownPath {
  path: string;
  display: string;
}

/** One recently opened project, as the welcome page lists it. */
export interface HostRecentProject extends HostShownPath {
  /** The folder's own name (the last part of the path). */
  name: string;
  /** When it was last opened, an ISO time. */
  openedAt: string;
  /** The folder is not there (or is not a folder) now: it cannot be opened, only removed from the list. */
  missing: boolean;
  /** The project that is open now (desktop-app ticket 19); never in the welcome state. */
  current: boolean;
}

/** `GET /api/host/recent-projects`. */
export interface HostRecentProjects {
  version: 1;
  /** Most recent first. */
  projects: HostRecentProject[];
  /**
   * The last project, when the host started in the welcome state because its folder was gone — while it is still in
   * the list; null otherwise.
   */
  lastMissing: HostShownPath | null;
}

/** The body of `POST /api/host/recent-projects/open` and `…/remove`: a path exactly as the list gives it. */
export interface HostRecentProjectRequest {
  path: string;
}

const isPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65535;

function isPortFallback(value: unknown): value is HostPortFallback {
  const v = value as Partial<HostPortFallback> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    isPort(v.configured) &&
    isPort(v.actual) &&
    (HOST_PORT_OCCUPANTS as readonly unknown[]).includes(v.occupant)
  );
}

export function isHostInfo(value: unknown): value is HostInfo {
  const v = value as Partial<HostInfo> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    v.app === HOST_APP &&
    (HOST_MODES as readonly unknown[]).includes(v.mode) &&
    Array.isArray(v.requests) &&
    v.requests.every(isHostRequestKind) &&
    (v.portFallback === null || isPortFallback(v.portFallback)) &&
    (HOST_PROJECT_STATES as readonly unknown[]).includes(v.project)
  );
}

const isShownPath = (v: unknown): v is HostShownPath =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as HostShownPath).path === "string" &&
  typeof (v as HostShownPath).display === "string";

export function isHostRecentProjects(value: unknown): value is HostRecentProjects {
  const v = value as Partial<HostRecentProjects> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    Array.isArray(v.projects) &&
    v.projects.every(
      (p) =>
        isShownPath(p) &&
        typeof p.name === "string" &&
        typeof p.openedAt === "string" &&
        typeof p.missing === "boolean" &&
        typeof p.current === "boolean"
    ) &&
    (v.lastMissing === null || isShownPath(v.lastMissing))
  );
}

// ---- switching projects (desktop-app ticket 19) ---------------------------------------------------------------- //
// One source for each shape: the zod schemas below; the types are inferred from them and the guards are their
// `safeParse` (the server's 409, the page's reading of it, and the WebSocket message share them).

/** A job of the runner that is running or waiting to run: switching ends it (the next start of this project marks it interrupted). */
export const HostSwitchJobSchema = z.object({
  id: z.string(),
  kind: JobKindSchema,
  status: z.enum(["queued", "running"]),
  /** The Work it is for, when the job says. */
  workId: z.string().nullable(),
  /** What an `upload` job takes in: an uploaded PDF, an arXiv PDF; null for a LaTeX archive and the other kinds. */
  format: JobFormatSchema.nullable(),
  /** The arXiv id, for the jobs that fetch from arXiv. */
  arxivId: z.string().nullable(),
});
export type HostSwitchJob = z.infer<typeof HostSwitchJobSchema>;

/** A Copilot conversation whose run is working or waiting for the user: switching stops it (it can be resumed). */
export const HostSwitchConversationSchema = z.object({ id: z.string(), title: z.string() });
export type HostSwitchConversation = z.infer<typeof HostSwitchConversationSchema>;

/**
 * A mail send of this process still in its undo window: switching interrupts it — it stays in Drafts, unsent. Only
 * what the prompt shows: no account, no address.
 */
export const HostSwitchMailSchema = z.object({
  sendId: z.string(),
  subject: z.string(),
  /** When the window ends (milliseconds since the epoch). */
  endsAt: z.number(),
});
export type HostSwitchMail = z.infer<typeof HostSwitchMailSchema>;

/** What switching away from the open project now would interrupt, as the server knows it. */
export const HostSwitchImpactSchema = z.object({
  jobs: z.array(HostSwitchJobSchema),
  conversations: z.array(HostSwitchConversationSchema),
  mail: z.array(HostSwitchMailSchema),
});
export type HostSwitchImpact = z.infer<typeof HostSwitchImpactSchema>;

/** Where a switch goes, as the page shows it: the path, as shown, and the folder's own name. */
export const HostSwitchTargetSchema = z.object({
  path: z.string(),
  display: z.string(),
  name: z.string(),
});
export type HostSwitchTarget = z.infer<typeof HostSwitchTargetSchema>;

/**
 * At most this many ids in each list of `acknowledged`, each at most this long. Every id the server hands out fits:
 * a job's is `<kind>-<uuid>`, a conversation's a uuid, a send's a uuid.
 */
export const SWITCH_ACK_MAX_IDS = 1000;
export const SWITCH_ACK_MAX_ID_LENGTH = 64;

const ackIds = z.array(z.string().max(SWITCH_ACK_MAX_ID_LENGTH)).max(SWITCH_ACK_MAX_IDS);

/** What the user saw and confirmed: the ids of the impact's items (a list left out is empty). */
export const HostSwitchAcknowledgedSchema = z.object({
  jobs: ackIds.default([]),
  conversations: ackIds.default([]),
  mail: ackIds.default([]),
});
export type HostSwitchAcknowledged = z.infer<typeof HostSwitchAcknowledgedSchema>;

export const EMPTY_SWITCH_IMPACT: HostSwitchImpact = Object.freeze({
  jobs: [],
  conversations: [],
  mail: [],
}) as HostSwitchImpact;

export function isSwitchImpactEmpty(impact: HostSwitchImpact): boolean {
  return impact.jobs.length === 0 && impact.conversations.length === 0 && impact.mail.length === 0;
}

/** The ids of an impact, to send back as what the user confirmed. */
export function acknowledgedOf(impact: HostSwitchImpact): HostSwitchAcknowledged {
  return {
    jobs: impact.jobs.map((j) => j.id),
    conversations: impact.conversations.map((c) => c.id),
    mail: impact.mail.map((m) => m.sendId),
  };
}

/**
 * Whether the user confirmed everything the switch would interrupt now: every item of `impact` is among the ones
 * `acknowledged` names. Items that ended since (a job done, a mail sent) do not matter; a new one does.
 */
export function switchAcknowledged(
  impact: HostSwitchImpact,
  acknowledged: HostSwitchAcknowledged | null
): boolean {
  if (isSwitchImpactEmpty(impact)) return true;
  if (acknowledged === null) return false;
  const has = (list: string[], id: string) => list.includes(id);
  return (
    impact.jobs.every((j) => has(acknowledged.jobs, j.id)) &&
    impact.conversations.every((c) => has(acknowledged.conversations, c.id)) &&
    impact.mail.every((m) => has(acknowledged.mail, m.sendId))
  );
}

export function isHostSwitchImpact(value: unknown): value is HostSwitchImpact {
  return HostSwitchImpactSchema.safeParse(value).success;
}

export function isHostSwitchTarget(value: unknown): value is HostSwitchTarget {
  return HostSwitchTargetSchema.safeParse(value).success;
}

/**
 * Sent to every page when the host holds a folder the shell picked, because switching to it would interrupt what
 * `impact` lists: the page asks the user, then confirms (`POST /api/host/switch/confirm`) or cancels.
 */
export const WsHostSwitchConfirmationSchema = z.object({
  type: z.literal("host.switch-confirmation"),
  id: z.string(),
  target: HostSwitchTargetSchema,
  impact: HostSwitchImpactSchema,
});
export type WsHostSwitchConfirmation = z.infer<typeof WsHostSwitchConfirmationSchema>;

/** The page's check of a `host.switch-confirmation` message before it shows anything of it. */
export function isWsHostSwitchConfirmation(value: unknown): value is WsHostSwitchConfirmation {
  return WsHostSwitchConfirmationSchema.safeParse(value).success;
}

// ---- the tutorial's entry (in-app-tutorial ticket 25) ------------------------------------------------------------ //

/**
 * Why the tutorial did not start, announced to the pages after the request was taken: `target_conflict` — the parent
 * folder already holds an `ArgelanderSpace-Tutorial` that is not empty and is not a tutorial folder; `copy_failed` —
 * the sample could not be copied (permissions, a full disk; what was written is removed again); `not_a_folder` — what
 * the dialog answered is not a folder; `shutting_down` — the workbench is closing.
 */
export const HOST_TUTORIAL_FAILURES = [
  "target_conflict",
  "copy_failed",
  "not_a_folder",
  "shutting_down",
] as const;
export type HostTutorialFailure = (typeof HOST_TUTORIAL_FAILURES)[number];

/** The 409 codes of the tutorial's endpoints (the request was not taken). */
export const HOST_TUTORIAL_REFUSALS = [
  "no_sample",
  "tutorial_missing",
  "current_project",
  "tutorial_busy",
  "shutting_down",
] as const;
export type HostTutorialRefusal = (typeof HOST_TUTORIAL_REFUSALS)[number];

/** The tutorial's three entries. */
export const HOST_TUTORIAL_ACTIONS = ["pick", "continue", "restart"] as const;
export type HostTutorialAction = (typeof HOST_TUTORIAL_ACTIONS)[number];

const ShownPathSchema = z.object({ path: z.string(), display: z.string() });

/** Sent to every page when a tutorial entry the host took failed: why, and the folder it was about. */
export const WsHostTutorialResultSchema = z.object({
  type: z.literal("host.tutorial-result"),
  reason: z.enum(HOST_TUTORIAL_FAILURES),
  path: ShownPathSchema,
});
export type WsHostTutorialResult = z.infer<typeof WsHostTutorialResultSchema>;

/** The page's check of a `host.tutorial-result` message before it shows anything of it. */
export function isWsHostTutorialResult(value: unknown): value is WsHostTutorialResult {
  return WsHostTutorialResultSchema.safeParse(value).success;
}

// ---- the command-line tool (desktop-app ticket 24) ------------------------------------------------------------- //

/**
 * `not_installed`: nothing at the launcher's path. `installed`: the app's launcher, running this app. `outdated`: the
 * app's launcher (it has the mark) for another place of the app — moved since, or another copy; installing points it
 * here. `foreign`: a file (or link, or folder) without the app's mark: never overwritten or removed.
 */
export const HOST_CLI_STATES = ["not_installed", "installed", "outdated", "foreign"] as const;
export type HostCliState = (typeof HOST_CLI_STATES)[number];

/** `GET /api/host/cli`. */
export interface HostCliStatus {
  version: 1;
  /** The command's name: the npm package's (`argelanderspace`). */
  command: string;
  state: HostCliState;
  /** The launcher's path (`~/.local/bin/argelanderspace`, `…\argelanderspace.cmd` on Windows). */
  file: HostShownPath;
  /** The user's executable directory it is in. */
  dir: HostShownPath;
  /** Whether that directory is on PATH, as the app's own environment has it. */
  inPath: boolean;
  /** What the user would add themself: a shell line (`posix`), or the directory for the user PATH (`windows`). */
  pathLine: string;
  platform: "posix" | "windows";
}

/**
 * Why a desktop host does not offer the command-line tool (desktop-app ticket 26): `appimage` — it runs from an
 * AppImage, whose folder is a temporary mount that is gone once the app closes, so a launcher would stop working; the
 * deb and the npm package offer it.
 */
export const HOST_CLI_UNAVAILABLE_REASONS = ["appimage"] as const;
export type HostCliUnavailableReason = (typeof HOST_CLI_UNAVAILABLE_REASONS)[number];

/** The 404 body of the command-line tool's endpoints from a host without the tool. */
export interface HostCliUnavailable {
  code: "cli_unavailable";
  detail: string;
  /** Absent when the host simply does not know its own Node and CLI. */
  reason?: HostCliUnavailableReason;
}

export function isHostCliUnavailableReason(value: unknown): value is HostCliUnavailableReason {
  return (HOST_CLI_UNAVAILABLE_REASONS as readonly unknown[]).includes(value);
}

/** The answer of `POST /api/host/cli/install` and `…/uninstall`. */
export interface HostCliChange {
  outcome: "installed" | "removed" | "not_installed";
  status: HostCliStatus;
}

export function isHostCliStatus(value: unknown): value is HostCliStatus {
  const v = value as Partial<HostCliStatus> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    v.version === 1 &&
    typeof v.command === "string" &&
    (HOST_CLI_STATES as readonly unknown[]).includes(v.state) &&
    isShownPath(v.file) &&
    isShownPath(v.dir) &&
    typeof v.inPath === "boolean" &&
    typeof v.pathLine === "string" &&
    (v.platform === "posix" || v.platform === "windows")
  );
}
