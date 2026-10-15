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
 * - `POST /api/host/recent-projects/open`    `{path}` → 202 `{ ok: true }`: the host leaves for that project (it stops
 *                                       and tells its shell the next project). Only a path of the list is taken:
 *                                       404 `unknown_project` otherwise, 409 `folder_missing` when the folder is gone,
 *                                       409 `project_open` while a project is open (switching is ticket 19), 409
 *                                       `shutting_down` while the host stops.
 * - `POST /api/host/recent-projects/remove`  `{path}` → 200 {@link HostRecentProjects}, the list without it (a path
 *                                       not in the list changes nothing); 500 `write_failed` when the list file
 *                                       cannot be written (the old list stays).
 *   For both: only the body's `path` is read, and it is only compared with the list's paths, character for
 *   character. 400 `invalid_request` when the body is not a `{path}` with a non-empty string, 413 `too_large` when it
 *   is over 16 KiB (server `RECENT_REQUEST_MAX_BYTES`; reading stops at the limit).
 *
 * Both are `no-store` and behind the same cross-origin guard as every other endpoint. `serve` (the browser form) has
 * no host: its answer is `mode: "browser"` with no requests, and the page hides the desktop-only controls.
 *
 * With no project open (the desktop host's welcome state, `project: "none"`) the server answers only the page, the
 * host interface, the settings interface and the page's own error reports (`POST /api/page-errors`, written to the
 * user log only); every other endpoint answers 409 {@link NO_PROJECT_CODE}.
 */

/** The name every answer carries, so a program on the port can be told from the workbench. */
export const HOST_APP = "argelanderspace";

/** How the workbench is delivered. */
export const HOST_MODES = ["browser", "desktop"] as const;
export type HostMode = (typeof HOST_MODES)[number];

/** The native requests, a fixed list; none takes a path or an address from the page. */
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
        typeof p.missing === "boolean"
    ) &&
    (v.lastMissing === null || isShownPath(v.lastMissing))
  );
}
