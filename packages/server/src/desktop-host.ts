/**
 * The desktop host (desktop-app ticket 17; ADR 0010): the Node process the desktop shell looks after. It runs the
 * same server as `serve`, for one Project, and talks to the shell over a line protocol on its standard input and
 * output — one JSON object per line. The shell has no business logic; everything it needs to know is in these lines.
 *
 * Host → shell (stdout):
 *   - `ready`    once listening: `url`, `port`, `configuredPort`, `portFallback`, `portOccupant`, `project`.
 *   - `request`  a native request the page asked for (`kind`, one of contracts `HOST_REQUEST_KINDS`). What to open is
 *                filled in by the host from what it knows itself — its own address, the log directory, the config
 *                file, the bundled skills (desktop-app ticket 24) — never from the page: the host interface does not
 *                read the request's body (host-routes.ts).
 *                `pick_folder` carries an `id` the shell answers with.
 *   - `stopping` / `stopped`  the graceful shutdown began / ended (`reason`: quit, input_closed, output_closed, signal,
 *                switch). On `switch` the `stopped` line carries `next`: the project folder the shell starts the next
 *                host for (`--project`), the way the host leaves a project for another (spec 「进程结构」).
 *   - `ready`'s `project` is null in the welcome state (desktop-app ticket 18).
 *   - `failed`   the server could not start; the process then exits with 1.
 *   - `menu`     after `ready`, and again whenever it changes (desktop-app ticket 21): what the shell's menu shows —
 *                the language config.toml names now and the recent projects ({@link HOST_MENU_RECENT_MAX} at most,
 *                not the open one), each with a label and an id only this host can turn back into its folder.
 *
 * Shell → host (stdin):
 *   - `{"type":"quit"}`                               shut down gracefully.
 *   - `{"type":"folder_picked","id":…,"path":…|null}` the answer to a `pick_folder` request (null: cancelled).
 *   - `{"type":"menu","item":…}`                       a menu item (desktop-app ticket 21): `pick_folder`,
 *     `open_in_browser`, `open_devtools` are carried out as the page's request of that kind; `open_recent` with the
 *     `id` of the last `menu` line as opening that recent project (with a project open, held for the user's
 *     confirmation when the switch would interrupt work, as a picked folder is).
 *   - `{"type":"shell_event","event":…,"fields":{…}}` one of the shell's own events, written into the host's log by
 *     the same rules as every other record: the event must be in {@link SHELL_EVENTS} and each field is put through
 *     the field constructor its catalog entry names; anything else is not written. An event name outside that table —
 *     the server's own record names included — is not written either: the host records the fixed
 *     `desktop.protocol_rejected` with reason `unknown_event` instead, without the name.
 *   The end of stdin (the shell exited or was killed) is a quit too, so the host never outlives its shell.
 *
 * Which project (desktop-app ticket 18): the one given (`--project`, the CLI has changed into it), or — with
 * `fromRecent` — the most recently opened one when its folder is still there; otherwise none, and the host runs the
 * server of the welcome state (no-project.ts), which answers only the page, the host and the settings interfaces and the page-error report.
 * Every project the host opens is recorded first in the recently opened projects (infra `recent-projects.ts`, global
 * data). In the welcome state a picked folder (`folder_picked`) or a recent project the page opens is left for at
 * once: recorded, then the host stops with reason `switch` and the folder as `next`.
 *
 * With a project open (desktop-app ticket 19) the same, unless the switch would interrupt work in progress — the
 * server's queued or running jobs, a live Copilot run, mail in its undo window (`HostWorkbench.impact`, asked at the
 * moment of each request, never remembered from an earlier one). Then a recent project is refused with the impact
 * (409 `confirmation_required`) until the page sends back the ids the user confirmed, covering all that the switch
 * would interrupt now; a picked folder is held and announced to the pages (`host.switch-confirmation`), and left for
 * only on a confirmation that covers the impact as it is then. The current project itself is not switched to.
 *
 * Port: the configured one (config.toml `port`, default 1859), which the CLI's links point to. When it is taken the
 * host listens on a free port instead and says so in the ready line and to the page (`GET /api/host`), after asking the
 * port whether it is another ArgelanderSpace server or some other program.
 *
 * Shutdown: the server's own graceful close (server.ts `createServer().close()`): first, synchronously, every mail send
 * still in its undo window is marked interrupted and stays in Drafts; then the watchers, the WebSocket hub, Copilot
 * and the listening socket. The port is free when `stopped` is written. When the shell is gone (the end of the input,
 * a broken output) nobody is left to end a shutdown that hangs, so the host gives itself a limit ({@link
 * HOST_STOP_DEADLINE_MS}, `stopDeadline`): past it, it records `desktop.stop_timed_out` and the entry exits the
 * process. The mail undo window was closed by then — that is the close's first, synchronous step. On a quit line or a
 * signal the shell is there, and ending a shutdown that takes too long is its job.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { basename, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_UI_LANGUAGE,
  EMPTY_SWITCH_IMPACT,
  HOST_REQUEST_KINDS,
  type HostCliUnavailableReason,
  type HostPortFallback,
  type HostPortOccupant,
  type HostProjectState,
  type HostRecentProjects,
  type HostRequestKind,
  type HostSwitchAcknowledged,
  type HostSwitchImpact,
  type HostSwitchTarget,
  isHostInfo,
  type WsHostSwitchConfirmation,
  type WsHostTutorialResult,
  type SETTINGS_UI_LANGUAGES,
  switchAcknowledged,
} from "@argelanderspace/contracts";
import {
  CLI_COMMAND,
  type CliLauncherTarget,
  cliLauncherStatus,
  configFilePath,
  f,
  installCliLauncher,
  type KeychainProbe,
  type LogField,
  type LogLevel,
  logDirIn,
  portOf,
  RECENT_PROJECTS_FILE,
  RECENT_PROJECTS_PROBLEMS,
  readConfigLeniently,
  readRecentProjects,
  recordRecentProject,
  removeRecentProject,
  TUTORIAL_PROGRESS_FILE,
  type TutorialCopyOptions,
  uninstallCliLauncher,
} from "@argelanderspace/infra";
import { createTutorialEntry } from "./desktop-tutorial.js";
import type {
  HostBridge,
  HostCli,
  HostWorkbench,
  RecentOpenOutcome,
  SwitchConfirmation,
  SwitchConfirmOutcome,
} from "./host-routes.js";
import type { ServerLog, ServerLogFields } from "./log.js";
import type { NoProjectServer } from "./no-project.js";
import {
  type RunningServer,
  type StartedExtras,
  serveStart,
  startNoProjectServer,
  startServer,
} from "./server.js";
import { shownPath, startSettingsWatcher } from "./settings.js";
import { SHELL_EVENTS, type ShellEvent, type ShellEventSpec } from "./shell-events.js";

/** A line longer than this (bytes, without its newline) is dropped whole. */
export const HOST_LINE_MAX_BYTES = 64 * 1024;
/** How long the host waits for whatever holds the configured port to answer `GET /api/host`. */
export const PORT_PROBE_TIMEOUT_MS = 1500;

export const HOST_STOP_REASONS = [
  "quit",
  "input_closed",
  "output_closed",
  "signal",
  "switch",
] as const;
export type HostStopReason = (typeof HOST_STOP_REASONS)[number];

/** How long a shutdown with the shell gone (input closed, output broken) may take before the host gives up on it. */
export const HOST_STOP_DEADLINE_MS = 10_000;
/** The stop reasons that mean the shell is gone, so the host itself must make sure it ends. */
const SHELL_GONE: ReadonlySet<HostStopReason> = new Set(["input_closed", "output_closed"]);

/** The native requests the shell's menu may ask for (desktop-app ticket 21); a recent project is `open_recent`. */
export const MENU_REQUESTS = ["pick_folder", "open_in_browser", "open_devtools"] as const;
/** At most this many recent projects in the shell's menu (the settings page and the welcome page list them all). */
export const HOST_MENU_RECENT_MAX = 10;
/**
 * A recent project's label in the shell's menu is at most this many characters: a longer one keeps its start (the
 * folder's name) and its end (the end of the path) around "…". Far under the shell's own limit (1024 bytes, beyond
 * which it leaves that entry out).
 */
export const HOST_MENU_LABEL_MAX = 120;

/** `label` at most {@link HOST_MENU_LABEL_MAX} characters, its start and end kept around "…". */
function menuLabel(label: string): string {
  const chars = Array.from(label);
  if (chars.length <= HOST_MENU_LABEL_MAX) return label;
  const head = Math.floor((HOST_MENU_LABEL_MAX - 1) / 3);
  const tail = HOST_MENU_LABEL_MAX - 1 - head;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}
/** Where a native request came from, as `desktop.request` records it. */
const REQUEST_SOURCES = ["page", "menu"] as const;
/** The command-line tool's record (desktop-app ticket 24): what was asked and what came of it, never a path. */
const CLI_ACTIONS = ["install", "uninstall"] as const;
const CLI_OUTCOMES = ["installed", "foreign", "removed", "not_installed", "failed"] as const;

/** One recent project in the shell's menu: what it shows, and the id it sends back. No path: the label is to read. */
export interface HostMenuRecent {
  id: string;
  label: string;
  /** False when the folder is not there now: shown, not openable. */
  enabled: boolean;
}

/** Why a line from the shell was not acted on (recorded as `desktop.protocol_rejected`). */
export const REJECT_REASONS = [
  "too_long",
  "not_json",
  "unknown_type",
  "bad_shape",
  "unknown_id",
  "unknown_event",
] as const;
type RejectReason = (typeof REJECT_REASONS)[number];

export type HostOutLine =
  | {
      type: "ready";
      url: string;
      port: number;
      configuredPort: number;
      portFallback: boolean;
      portOccupant: HostPortOccupant | null;
      /** Null in the welcome state (no project open). */
      project: string | null;
      /**
       * The user log directory (desktop-app ticket 20): where the shell writes its own events while no host runs, and
       * what its crash dialog's "show the log folder" opens.
       */
      logDir: string;
      /** The language config.toml names when the host starts, for the shell's native dialogs. */
      language: (typeof SETTINGS_UI_LANGUAGES)[number];
      /**
       * The user log's level when the host is ready: the shell writes its own file (no host running) by it. A level
       * changed later reaches the shell with the next host.
       */
      logLevel: LogLevel;
    }
  | { type: "request"; kind: "pick_folder"; id: string }
  | { type: "request"; kind: "open_in_browser"; url: string }
  | { type: "request"; kind: "open_devtools" }
  | { type: "request"; kind: "open_log_folder"; path: string }
  | { type: "request"; kind: "open_config_file"; path: string }
  /** The skills that ship with the app (desktop-app ticket 24): only from a host that knows where they are. */
  | { type: "request"; kind: "open_skills_folder"; path: string }
  /** What the shell's menu shows (desktop-app ticket 21): written after `ready` and whenever it changes. */
  | {
      type: "menu";
      language: (typeof SETTINGS_UI_LANGUAGES)[number];
      recent: HostMenuRecent[];
    }
  | { type: "stopping"; reason: HostStopReason }
  | { type: "stopped"; next?: string }
  /**
   * The host did not get to serve: `start`, the server could not start; `project`, the folder given with `--project`
   * is not there or not a folder (the CLI entry, {@link projectUnavailableLine}) — the shell starts a host without
   * `--project` then, which goes to the welcome state. Either way the process exits with 1 after it.
   */
  | { type: "failed"; stage: "start" | "project"; logDir: string };

export interface DesktopHostOptions {
  /** The shell's lines (the process's stdin). */
  input: Readable;
  /** Where the lines to the shell go (the process's stdout). */
  output: Writable;
  /** The program's version, for the start record and the diagnostics. */
  version?: string;
  /** The built page (`--web-dist`); default the one next to the bundle, or the repository's. */
  webDist?: string;
  /** SIGTERM / SIGINT shut down gracefully too (the CLI entry turns this on). */
  signals?: boolean;
  /** The answer to a `pick_folder` request: an absolute path, or null when the user cancelled. */
  onFolderPicked?: (path: string | null) => void;
  /**
   * Choose the project from the recently opened ones (desktop-app ticket 18; the CLI entry without `--project`): the
   * most recent, when its folder is still there — the host changes into it — else none (the welcome state). Absent:
   * the project is the current directory.
   */
  fromRecent?: boolean;
  /**
   * The limit on a shutdown begun because the shell is gone (`input_closed`, `output_closed`): `onExpired` is called
   * once `ms` (default {@link HOST_STOP_DEADLINE_MS}) have passed without the server having closed — the CLI entry
   * exits the process there. Absent: no limit (a host run inside another process, as in tests).
   */
  stopDeadline?: { ms?: number; onExpired: () => void };
  /** Tests only: the keychain probe of the start record. */
  keychainProbe?: () => Promise<KeychainProbe>;
  /** How often config.toml is looked at for a new language of the menu (ms; default the settings watcher's). */
  menuWatchIntervalMs?: number;
  /**
   * The skills that ship with the app (desktop-app ticket 24; the CLI entry finds them next to its own bundle, infra
   * `bundledSkillsDir`): what `open_skills_folder` opens. Absent: the request is not offered.
   */
  skillsDir?: string;
  /**
   * The tutorial sample that ships with the app (in-app-tutorial ticket 18; the CLI entry finds it next to its own
   * bundle, infra `bundledTutorialDir`): whose marker `GET /api/tutorial` reads. Absent: the installation has none.
   */
  tutorialSampleDir?: string;
  /** Tests only: the copy of the tutorial sample (in-app-tutorial ticket 25; default infra's). */
  tutorialCopy?: (sample: string, into: string, opts: TutorialCopyOptions) => Promise<void>;
  /**
   * The app's own Node and CLI entry, which the command-line tool's launcher runs (desktop-app ticket 24; the CLI entry
   * gives its `process.execPath` and its bundle). Absent: the host interface answers that the tool is unavailable.
   */
  cliLauncher?: CliLauncherTarget;
  /**
   * Why the host does not offer the command-line tool although it knows its Node and CLI (desktop-app ticket 26; the
   * CLI entry finds it, infra `cliLauncherUnavailable`): `appimage`. The endpoints then answer 404 `cli_unavailable`
   * with this reason, and `cliLauncher` is not used.
   */
  cliUnavailable?: HostCliUnavailableReason;
}

export interface DesktopHost {
  /** The server, once ready, with the port it listens on and its log directory (no project: the welcome server). */
  server: (RunningServer | NoProjectServer) & StartedExtras;
  /** Whether a project is open. */
  project: HostProjectState;
  /** Resolves with why the host stopped, once the server has closed and `stopped` was written. */
  stopped: Promise<HostStopReason>;
  /** Starts the graceful shutdown (as a `quit` line does). */
  stop(reason?: HostStopReason): Promise<HostStopReason>;
}

/**
 * The line the CLI entry writes before it exits with 1 when the folder given with `--project` is not there or not a
 * folder (desktop-app ticket 20): the shell tells this apart from a crash and starts a host without `--project`, which
 * goes to the welcome state — the folder may have gone between a switch's `stopped` and the next host's start.
 */
export function projectUnavailableLine(): Extract<HostOutLine, { type: "failed" }> {
  return {
    type: "failed",
    stage: "project",
    logDir: logDirIn(serveStart(configFilePath()).globalDirs.dataDir),
  };
}

/** Whether nothing listens on the port at 127.0.0.1, the address the server binds (any failure to bind: taken). */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolveFree) => {
    const probe = createNetServer();
    probe.unref();
    probe.once("error", () => resolveFree(false));
    probe.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      probe.close(() => resolveFree(true));
    });
  });
}

/** What answers on a taken port: another ArgelanderSpace server (its `GET /api/host`), or something else. */
export async function portOccupant(
  port: number,
  timeoutMs: number = PORT_PROBE_TIMEOUT_MS
): Promise<HostPortOccupant> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/host`, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) return "other";
    // At most a small answer is read: whatever holds the port is not ours to trust.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16 * 1024) {
        await reader.cancel();
        return "other";
      }
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return isHostInfo(JSON.parse(text)) ? "argelanderspace" : "other";
  } catch {
    return "other";
  }
}

/** The request line for a kind: everything in it is the host's own (its address, its log directory, its config file). */
function requestLine(
  kind: HostRequestKind,
  own: { port: number; logDir: string; configPath: string; skillsDir: string | null },
  pickId: () => string
): HostOutLine | null {
  switch (kind) {
    case "pick_folder":
      return { type: "request", kind, id: pickId() };
    case "open_in_browser":
      return { type: "request", kind, url: `http://127.0.0.1:${own.port}/` };
    case "open_devtools":
      return { type: "request", kind };
    case "open_log_folder":
      return { type: "request", kind, path: own.logDir };
    case "open_config_file":
      return { type: "request", kind, path: own.configPath };
    case "open_skills_folder":
      // Offered only when the host knows the folder (`bridge.requests`); never a path of the page's.
      return own.skillsDir === null ? null : { type: "request", kind, path: own.skillsDir };
  }
}

/** Whether the path is a folder now (anything that cannot be looked at counts as not). */
function isFolder(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** The path with its symbolic links resolved, as the ready line gives the project; the path itself if that fails. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const WELCOME_REASONS = ["no_recent", "last_missing"] as const;
const LEAVE_SOURCES = ["picked", "recent", "tutorial"] as const;
/** Why a picked path is not left for (the path itself is never written). */
const PICK_REJECT_REASONS = ["not_a_folder", "current_project", "shutting_down"] as const;

/** The fields of a shell event, each through the constructor its catalog entry names; others are counted as dropped. */
function shellFields(spec: ShellEventSpec, raw: unknown): Record<string, LogField | unknown> {
  const out: Record<string, LogField | unknown> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    const kind = Object.hasOwn(spec.fields, name) ? spec.fields[name] : undefined;
    // Not a `LogField`: the logger drops it and counts it (`dropped_fields`), and never writes the value.
    if (kind === undefined) out[name] = null;
    else if (kind === "id") out[name] = typeof value === "string" ? f.id(value) : null;
    else if (kind === "num") out[name] = typeof value === "number" ? f.num(value) : null;
    else if (kind === "ms") out[name] = typeof value === "number" ? f.ms(value) : null;
    else out[name] = typeof value === "string" ? f.oneOf(kind, value) : null;
  }
  return out;
}

/**
 * Starts the server for the Project in the current directory (the CLI entry has changed into it) and serves the line
 * protocol until a quit, the end of the input, a signal or a broken output. Rejects when the server cannot start
 * (after writing `failed`).
 */
export async function runDesktopHost(options: DesktopHostOptions): Promise<DesktopHost> {
  const { input, output } = options;
  let stopping: Promise<HostStopReason> | null = null;
  let outputBroken = false;
  const write = (line: HostOutLine): void => {
    if (outputBroken) return;
    try {
      output.write(`${JSON.stringify(line)}\n`);
    } catch {
      outputBroken = true;
    }
  };

  // The port: the configured one when it is free, else one the system picks (and whose the configured one is).
  const configPath = configFilePath();
  const atStart = serveStart(configPath);
  const configuredPort = portOf(atStart.config);

  // The project: the current directory, or the most recent one when its folder is still there, or none.
  const recentFile = join(atStart.globalDirs.dataDir, RECENT_PROJECTS_FILE);
  const recentAtStart = readRecentProjects(recentFile);
  let project: HostProjectState = "open";
  let welcome: (typeof WELCOME_REASONS)[number] | null = null;
  let lastMissing: string | null = null;
  if (options.fromRecent) {
    const last = recentAtStart.projects[0];
    let entered = false;
    if (last !== undefined && isFolder(last.path)) {
      try {
        process.chdir(last.path);
        entered = true;
      } catch {
        /* cannot go in: as if it were gone */
      }
    }
    if (!entered) {
      project = "none";
      welcome = last === undefined ? "no_recent" : "last_missing";
      lastMissing = last?.path ?? null;
    }
  }
  let portFallback: HostPortFallback | null = null;
  let listenPort = configuredPort;
  let occupant: HostPortOccupant | null = null;
  if (configuredPort !== 0 && !(await portIsFree(configuredPort))) {
    occupant = await portOccupant(configuredPort);
    listenPort = 0;
  }

  /** The list as the page shows it, read now; whether each folder is there is looked at now too. */
  function recentList(): HostRecentProjects {
    const { projects } = readRecentProjects(recentFile);
    return {
      version: 1,
      projects: projects.map((entry) => ({
        ...shownPath(entry.path),
        name: basename(entry.path) || entry.path,
        openedAt: entry.openedAt,
        missing: !isFolder(entry.path),
        current: isCurrent(entry.path),
      })),
      lastMissing:
        lastMissing !== null && projects.some((entry) => entry.path === lastMissing)
          ? shownPath(lastMissing)
          : null,
    };
  }

  // What a switch would interrupt: handed over by the server of an open project (none in the welcome state).
  let workbench: HostWorkbench | null = null;
  const impactNow = (): HostSwitchImpact => workbench?.impact() ?? EMPTY_SWITCH_IMPACT;
  /**
   * The folder the shell picked while a switch would interrupt work, waiting for the user's confirmation. A tutorial
   * entry (in-app-tutorial ticket 25) may add what to do once the server has closed (`afterClose`) and what to undo
   * when the switch is given up (`onDrop`).
   */
  let held: {
    id: string;
    path: string;
    source: (typeof LEAVE_SOURCES)[number];
    afterClose?: () => void;
    onDrop?: () => void;
  } | null = null;
  /** Ends the hold (and gives up what it carried), or replaces it. */
  function setHeld(next: typeof held): void {
    const before = held;
    held = next;
    if (before !== null && before !== next) before.onDrop?.();
  }
  /** Tells the pages of the server: given by the server of an open project, or by the welcome state's. */
  let pages: ((message: WsHostSwitchConfirmation | WsHostTutorialResult) => void) | null = null;

  /** Where a switch goes, as the page shows it. */
  function targetOf(path: string): HostSwitchTarget {
    const real = canonical(path);
    return { ...shownPath(real), name: basename(real) || real };
  }
  /** Whether the folder is the project open now (the host's working directory is its real path). */
  const isCurrent = (path: string): boolean =>
    project === "open" && canonical(path) === process.cwd();

  /**
   * Whether the switch may go ahead now: nothing would be interrupted, or the user confirmed all of it. Otherwise the
   * confirmation the page must ask for, with the impact as it is now.
   */
  function mayLeave(
    path: string,
    acknowledged: HostSwitchAcknowledged | null,
    source: (typeof LEAVE_SOURCES)[number]
  ): SwitchConfirmation | null {
    if (project !== "open") return null;
    const impact = impactNow();
    if (switchAcknowledged(impact, acknowledged)) return null;
    own?.log.info("desktop.switch_asked", {
      source: f.oneOf(LEAVE_SOURCES, source),
      jobs: f.num(impact.jobs.length),
      conversations: f.num(impact.conversations.length),
      mail: f.num(impact.mail.length),
    });
    return { confirm: { target: targetOf(path), impact } };
  }

  /**
   * The page opens a project of the list: only a path of the list, only a folder, not the open project; with a project
   * open, only once the user confirmed what the switch would interrupt.
   */
  function openRecent(
    path: string,
    acknowledged: HostSwitchAcknowledged | null
  ): RecentOpenOutcome {
    if (stopping !== null) return "shutting_down";
    const { projects } = readRecentProjects(recentFile);
    if (!projects.some((entry) => entry.path === path)) return "unknown_project";
    if (!isFolder(path)) return "folder_missing";
    if (isCurrent(path)) return "current_project";
    const ask = mayLeave(path, acknowledged, "recent");
    if (ask !== null) return ask;
    setHeld(null);
    return leave(path, "recent") ? "leaving" : "shutting_down";
  }

  /** The user confirmed the switch to the held folder. */
  function confirmHeld(id: string, acknowledged: HostSwitchAcknowledged): SwitchConfirmOutcome {
    if (stopping !== null) return "shutting_down";
    if (held === null || held.id !== id) return "unknown_switch";
    if (!isFolder(held.path)) {
      setHeld(null);
      return "folder_missing";
    }
    const ask = mayLeave(held.path, acknowledged, held.source);
    if (ask !== null) return ask;
    const { path, source, afterClose } = held;
    held = null;
    return leave(path, source, afterClose) ? "leaving" : "shutting_down";
  }

  /**
   * A folder the shell picked (or a recent project its menu opened, `source: recent`) with a project open: left for,
   * held for the user's confirmation, or refused.
   */
  function pickedWithProject(
    path: string,
    source: (typeof LEAVE_SOURCES)[number] = "picked"
  ): void {
    // The host is stopping (the answer came in during the close): nothing is held or announced, and it is not left for.
    if (stopping !== null) {
      own?.log.info("desktop.pick_rejected", {
        reason: f.oneOf(PICK_REJECT_REASONS, "shutting_down"),
      });
      return;
    }
    if (!isFolder(path)) {
      own?.log.warn("desktop.pick_rejected", {
        reason: f.oneOf(PICK_REJECT_REASONS, "not_a_folder"),
      });
      return;
    }
    if (isCurrent(path)) {
      own?.log.info("desktop.pick_rejected", {
        reason: f.oneOf(PICK_REJECT_REASONS, "current_project"),
      });
      return;
    }
    holdOrLeave(path, source, {});
  }

  /**
   * Leaves for the folder now when nothing would be interrupted (or no project is open); otherwise holds it and asks
   * the pages to confirm (`host.switch-confirmation`). A newer hold replaces an older one still waiting: confirming the
   * older id then finds nothing.
   */
  function holdOrLeave(
    path: string,
    source: (typeof LEAVE_SOURCES)[number],
    extra: { afterClose?: () => void; onDrop?: () => void }
  ): void {
    const ask = mayLeave(path, null, source);
    if (ask === null) {
      setHeld(null);
      leave(path, source, extra.afterClose);
      return;
    }
    const id = randomUUID();
    setHeld({ id, path, source, ...extra });
    pages?.({
      type: "host.switch-confirmation",
      id,
      target: ask.confirm.target,
      impact: ask.confirm.impact,
    });
  }

  // Bound once the server listens; a request before that (there can be none: nothing listens) is refused.
  let own: { port: number; logDir: string; log: ServerLog } | null = null;
  const pending = new Set<string>();
  /** The id of the last `pick_folder` line written. */
  let lastPickId: string | null = null;
  /** Run once the server has closed, before `stopped` (a restart of the open tutorial project). */
  let afterClose: (() => void) | null = null;
  // The tutorial's entry (in-app-tutorial ticket 25): desktop-tutorial.ts.
  const tutorial = createTutorialEntry({
    sampleDir: options.tutorialSampleDir ?? null,
    progressFile: join(atStart.globalDirs.dataDir, TUTORIAL_PROGRESS_FILE),
    appVersion: options.version ?? "unknown",
    log: () => own?.log ?? null,
    stopping: () => stopping !== null,
    isCurrent: (path) => isCurrent(path),
    canonical,
    shownPath,
    requestPick: () => (request("pick_folder", "page") ? lastPickId : null),
    record: (path) => record(path),
    go: (path, extra) => {
      if (project === "open") holdOrLeave(path, "tutorial", extra);
      else leave(path, "tutorial", extra.afterClose);
    },
    broadcast: (message) => pages?.(message),
    ...(options.tutorialCopy === undefined ? {} : { copy: options.tutorialCopy }),
  });
  const bridge: HostBridge = {
    get portFallback() {
      return portFallback;
    },
    project,
    recent: {
      list: () => recentList(),
      open: (path, acknowledged) => openRecent(path, acknowledged),
      remove: (path) => {
        try {
          removeRecentProject(recentFile, path);
        } catch (error) {
          own?.log.warn("recent_projects.write_failed", { error: f.error(error) });
          throw error;
        }
        writeMenu();
        return recentList();
      },
    },
    switching: {
      confirm: (id, acknowledged) => confirmHeld(id, acknowledged),
      cancel: (id) => {
        if (held?.id !== id) return;
        setHeld(null);
        own?.log.info("desktop.switch_cancelled", {});
      },
    },
    useWorkbench(given) {
      workbench = given;
      pages = (message) => given.broadcast(message);
    },
    usePages(broadcast) {
      pages = broadcast;
    },
    tutorial: {
      pick: () => tutorial.pick(),
      continue: () => tutorial.continue(),
      restart: () => tutorial.restart(),
    },
    requests: HOST_REQUEST_KINDS.filter(
      (kind) => kind !== "open_skills_folder" || options.skillsDir !== undefined
    ),
    request: (kind) => request(kind, "page"),
    cli:
      options.cliLauncher === undefined || options.cliUnavailable !== undefined
        ? null
        : cliOf(options.cliLauncher),
    ...(options.cliUnavailable === undefined ? {} : { cliUnavailable: options.cliUnavailable }),
  };

  /** The command-line tool (desktop-app ticket 24): infra `cli-launcher.ts`, each change recorded by its outcome. */
  function cliOf(target: CliLauncherTarget): HostCli {
    const shown = (status: ReturnType<typeof cliLauncherStatus>) => ({
      version: 1 as const,
      command: CLI_COMMAND,
      state: status.state,
      file: shownPath(status.file),
      dir: shownPath(status.dir),
      inPath: status.inPath,
      pathLine: status.pathLine,
      platform: status.platform,
    });
    const status = () => shown(cliLauncherStatus(target));
    const recorded = <T extends { outcome: string }>(
      action: "install" | "uninstall",
      act: () => T
    ): T => {
      try {
        const result = act();
        own?.log.info("desktop.cli_launcher", {
          action: f.oneOf(CLI_ACTIONS, action),
          outcome: f.oneOf(CLI_OUTCOMES, result.outcome),
        });
        return result;
      } catch (error) {
        own?.log.warn("desktop.cli_launcher", {
          action: f.oneOf(CLI_ACTIONS, action),
          outcome: f.oneOf(CLI_OUTCOMES, "failed"),
          error: f.error(error, { omitSystemPath: true }),
        });
        throw error;
      }
    };
    return {
      status,
      install: () =>
        recorded("install", () => {
          const { outcome } = installCliLauncher(target);
          return { outcome, status: status() };
        }),
      uninstall: () =>
        recorded("uninstall", () => {
          const { outcome } = uninstallCliLauncher();
          return { outcome, status: status() };
        }),
    };
  }

  /** Writes the request line of a native request the page or the shell's menu asked for; false once stopping. */
  function request(kind: HostRequestKind, source: (typeof REQUEST_SOURCES)[number]): boolean {
    if (stopping !== null || own === null) return false;
    const line = requestLine(
      kind,
      { ...own, configPath, skillsDir: options.skillsDir ?? null },
      () => {
        const id = randomUUID();
        pending.add(id);
        lastPickId = id;
        return id;
      }
    );
    // A kind this host does not offer (the route answers 404 before it gets here).
    if (line === null) return false;
    own.log.info("desktop.request", {
      kind: f.oneOf(HOST_REQUEST_KINDS, kind),
      source: f.oneOf(REQUEST_SOURCES, source),
    });
    write(line);
    return true;
  }

  // The shell's menu (desktop-app ticket 21): the folders behind the ids of the last `menu` line, and what it showed.
  let menuFolders = new Map<string, string>();
  let menuShown = "";
  let menuGeneration = 0;
  // Each host's ids are its own: an id of another host's menu (a click on a menu not yet replaced) names nothing here.
  const menuIdPrefix = randomBytes(4).toString("hex");
  /** Writes the `menu` line when what it would show differs from the last one written. */
  function writeMenu(): void {
    if (stopping !== null || own === null) return;
    const language = readConfigLeniently(configPath).ui?.language ?? DEFAULT_UI_LANGUAGE;
    const entries = readRecentProjects(recentFile)
      .projects.filter((entry) => !isCurrent(entry.path))
      .slice(0, HOST_MENU_RECENT_MAX)
      .map((entry) => ({
        path: entry.path,
        label: menuLabel(
          `${basename(entry.path) || entry.path} — ${shownPath(entry.path).display}`
        ),
        enabled: isFolder(entry.path),
      }));
    const shown = JSON.stringify([language, entries.map(({ label, enabled }) => [label, enabled])]);
    if (shown === menuShown) return;
    menuShown = shown;
    menuGeneration += 1;
    menuFolders = new Map();
    const recent = entries.map(({ path, label, enabled }, index) => {
      const id = `m${menuIdPrefix}-${menuGeneration}-${index}`;
      menuFolders.set(id, path);
      return { id, label, enabled };
    });
    write({ type: "menu", language, recent });
  }

  /** A recent project the shell's menu opened: as the page opening it, or as a picked folder with a project open. */
  function openFromMenu(path: string): void {
    if (stopping !== null) return;
    if (!isFolder(path)) {
      // Gone since the menu was written: the menu shows it as not there now.
      writeMenu();
      return;
    }
    if (project === "open") pickedWithProject(path, "recent");
    else leave(path, "recent");
  }

  const argv = options.webDist === undefined ? [] : ["--web-dist", options.webDist];
  let server: DesktopHost["server"];
  try {
    const start = {
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.keychainProbe ? { keychainProbe: options.keychainProbe } : {}),
      ...(options.skillsDir === undefined ? {} : { skillsDir: options.skillsDir }),
      ...(options.tutorialSampleDir === undefined
        ? {}
        : { tutorialSampleDir: options.tutorialSampleDir }),
      desktop: {
        host: bridge,
        listenPort,
        // Before the start record is written, so that it says whether the port fell back.
        onListening: (port: number) => {
          if (occupant !== null)
            portFallback = { configured: configuredPort, actual: port, occupant };
        },
        // The start uses this reading instead of a second one. Only for an absolute path: a relative one (a relative
        // `XDG_CONFIG_HOME`) names another file once the host has changed into the Project, and that file is the
        // one the start reads, as before. The host's argv has no `--data-dir`, so the start locations are the same.
        ...(isAbsolute(configPath) ? { atStart } : {}),
      },
    };
    server =
      project === "open" ? await startServer(argv, start) : await startNoProjectServer(argv, start);
  } catch (error) {
    write({
      type: "failed",
      stage: "start",
      logDir: logDirIn(atStart.globalDirs.dataDir),
    });
    throw error;
  }
  const log = server.log;
  own = { port: server.port, logDir: server.logDir, log };
  if (recentAtStart.problem !== null)
    log.warn("recent_projects.unreadable", {
      reason: f.oneOf(RECENT_PROJECTS_PROBLEMS, recentAtStart.problem),
    });
  if (welcome !== null)
    log.info("desktop.no_project", { reason: f.oneOf(WELCOME_REASONS, welcome) });
  // The project is open: it goes first in the recent list (an unreadable list is written anew here).
  // Entered by the list's spelling of the folder, a link say: that entry is replaced by the real path.
  else record(process.cwd(), options.fromRecent ? recentAtStart.projects[0]?.path : undefined);

  let resolveStopped!: (reason: HostStopReason) => void;
  const stopped = new Promise<HostStopReason>((r) => {
    resolveStopped = r;
  });
  const onSignal = () => void stop("signal");
  let next: string | null = null;
  // A new language in config.toml reaches the menu while the host runs (its file watcher, as the pages' own).
  const menuWatcher = startSettingsWatcher({
    path: configPath,
    ...(options.menuWatchIntervalMs === undefined
      ? {}
      : { intervalMs: options.menuWatchIntervalMs }),
    onChange: () => writeMenu(),
  });
  const stop = (reason: HostStopReason = "quit"): Promise<HostStopReason> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      log.info("desktop.stopping", { reason: f.oneOf(HOST_STOP_REASONS, reason) });
      write({ type: "stopping", reason });
      // A tutorial entry under way ends; the pages hear why while they still listen.
      tutorial.onStopping();
      let deadline: NodeJS.Timeout | undefined;
      const limit = options.stopDeadline;
      if (limit !== undefined && SHELL_GONE.has(reason)) {
        const ms = limit.ms ?? HOST_STOP_DEADLINE_MS;
        deadline = setTimeout(() => {
          log.warn("desktop.stop_timed_out", { ms: f.ms(ms) });
          limit.onExpired();
        }, ms);
        // What keeps the close from finishing keeps the process alive; the limit itself does not.
        deadline.unref();
      }
      try {
        await server.close();
      } catch {
        /* the socket was already closed; the port is free either way */
      } finally {
        clearTimeout(deadline);
      }
      // A copy that was stopped has removed what it wrote; a switch still held is given up.
      await tutorial.settled();
      setHeld(null);
      if (afterClose !== null) {
        try {
          afterClose();
        } catch {
          /* it records its own failure */
        }
      }
      menuWatcher.stop();
      if (options.signals) {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
      input.off("data", onData);
      write(next === null ? { type: "stopped" } : { type: "stopped", next });
      resolveStopped(reason);
      return reason;
    })();
    return stopping;
  };

  /** Puts the project first in the recent list; a failure to write is recorded and changes nothing else. */
  function record(path: string, openedAs?: string): void {
    try {
      recordRecentProject(
        recentFile,
        path,
        new Date(),
        openedAs === undefined || openedAs === path ? {} : { replacing: openedAs }
      );
    } catch (error) {
      log.warn("recent_projects.write_failed", { error: f.error(error) });
    }
  }

  /**
   * Leaves for another project: recorded, then the host stops and tells its shell (`stopped`'s `next`). `then` runs
   * once the server has closed, before `stopped` (in-app-tutorial ticket 25: the restart of the open tutorial project).
   */
  function leave(
    openedAs: string,
    source: (typeof LEAVE_SOURCES)[number],
    then?: () => void
  ): boolean {
    if (stopping !== null) return false;
    const path = canonical(openedAs);
    record(path, openedAs);
    log.info("desktop.leaving", { source: f.oneOf(LEAVE_SOURCES, source) });
    next = path;
    afterClose = then ?? null;
    void stop("switch");
    return true;
  }

  const reject = (reason: RejectReason): void => {
    log.warn("desktop.protocol_rejected", { reason: f.oneOf(REJECT_REASONS, reason) });
  };

  const handle = (text: string): void => {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      reject("not_json");
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      reject("bad_shape");
      return;
    }
    const m = message as Record<string, unknown>;
    switch (m.type) {
      case "quit":
        void stop("quit");
        return;
      case "folder_picked": {
        const path = m.path;
        if (
          typeof m.id !== "string" ||
          !(path === null || (typeof path === "string" && isAbsolute(path)))
        ) {
          reject("bad_shape");
          return;
        }
        if (!pending.delete(m.id)) {
          reject("unknown_id");
          return;
        }
        log.info("desktop.folder_picked", {
          outcome: f.oneOf(["picked", "cancelled"], path === null ? "cancelled" : "picked"),
        });
        options.onFolderPicked?.(path);
        // The tutorial's pick (in-app-tutorial ticket 25): the folder is the parent of the tutorial, not a project.
        if (tutorial.picked(m.id, path)) return;
        if (path === null) return;
        // The welcome state leaves for the folder; with a project open, only once nothing would be interrupted or the
        // user confirmed it (desktop-app ticket 19).
        if (project === "open") pickedWithProject(path);
        else if (isFolder(path)) leave(path, "picked");
        else
          log.warn("desktop.pick_rejected", {
            reason: f.oneOf(PICK_REJECT_REASONS, "not_a_folder"),
          });
        return;
      }
      case "menu": {
        const item = m.item;
        if (typeof item === "string" && (MENU_REQUESTS as readonly string[]).includes(item)) {
          request(item as (typeof MENU_REQUESTS)[number], "menu");
          return;
        }
        if (item === "open_recent" && typeof m.id === "string") {
          const path = menuFolders.get(m.id);
          if (path === undefined) reject("unknown_id");
          else openFromMenu(path);
          return;
        }
        reject("bad_shape");
        return;
      }
      case "shell_event": {
        const event = m.event;
        if (typeof event !== "string") {
          reject("bad_shape");
          return;
        }
        if (!Object.hasOwn(SHELL_EVENTS, event)) {
          // Not the shell's: not written under its name — not even a name the logger knows, such as the server's own
          // records. One fixed rejection, without the name or any field.
          reject("unknown_event");
          return;
        }
        const spec: ShellEventSpec = SHELL_EVENTS[event as ShellEvent];
        // Checked one by one at run time (`shellFields`); to the types, the fields of whichever shell event this is.
        const fields = shellFields(spec, m.fields) as ServerLogFields<ShellEvent>;
        const warnWhen = spec.warnWhen;
        const warns =
          warnWhen !== undefined &&
          typeof m.fields === "object" &&
          m.fields !== null &&
          (m.fields as Record<string, unknown>)[warnWhen.field] === warnWhen.value;
        if (spec.level === "warn" || warns)
          log.warn<ShellEvent, typeof fields>(event as ShellEvent, fields);
        else log.info<ShellEvent, typeof fields>(event as ShellEvent, fields);
        return;
      }
      default:
        reject("unknown_type");
    }
  };

  // Lines: split on "\n" (a trailing "\r" is dropped); one that grows past the limit is skipped up to its end.
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let skipping = false;
  function onData(chunk: Buffer | string): void {
    let data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    for (;;) {
      const nl = data.indexOf(0x0a);
      if (nl === -1) {
        if (!skipping) {
          buffered.push(data);
          bufferedBytes += data.byteLength;
          if (bufferedBytes > HOST_LINE_MAX_BYTES) {
            buffered = [];
            bufferedBytes = 0;
            skipping = true;
            reject("too_long");
          }
        }
        return;
      }
      const head = data.subarray(0, nl);
      data = data.subarray(nl + 1);
      if (skipping) {
        skipping = false;
        continue;
      }
      const line = Buffer.concat([...buffered, head]);
      buffered = [];
      bufferedBytes = 0;
      if (line.byteLength > HOST_LINE_MAX_BYTES) {
        reject("too_long");
        continue;
      }
      const text = line.toString("utf8").replace(/\r$/, "");
      if (text.trim() !== "") handle(text);
    }
  }
  input.on("data", onData);
  input.once("end", () => void stop("input_closed"));
  input.once("close", () => void stop("input_closed"));
  // Every error, not only the first: a second one with no listener would be thrown as an uncaught exception.
  input.on("error", () => void stop("input_closed"));
  output.on("error", () => {
    outputBroken = true;
    void stop("output_closed");
  });
  if (options.signals) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }

  write({
    type: "ready",
    url: `http://127.0.0.1:${server.port}/`,
    port: server.port,
    configuredPort,
    portFallback: occupant !== null,
    portOccupant: occupant,
    project: project === "open" ? process.cwd() : null,
    logDir: server.logDir,
    language: atStart.config.ui?.language ?? DEFAULT_UI_LANGUAGE,
    logLevel: log.level(),
  });
  writeMenu();
  input.resume();

  return { server, project, stopped, stop };
}
