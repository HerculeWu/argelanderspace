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
 * Both are `no-store` and behind the same cross-origin guard as every other endpoint. `serve` (the browser form) has
 * no host: its answer is `mode: "browser"` with no requests, and the page hides the desktop-only controls.
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

export interface HostInfo {
  version: 1;
  app: typeof HOST_APP;
  mode: HostMode;
  /** The native requests the page may make: all of them in the desktop form, none in the browser. */
  requests: HostRequestKind[];
  /** Null unless the desktop host had to listen on another port than the configured one. */
  portFallback: HostPortFallback | null;
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
    (v.portFallback === null || isPortFallback(v.portFallback))
  );
}
