/**
 * The desktop host (desktop-app ticket 17; ADR 0010): the Node process the desktop shell looks after. It runs the
 * same server as `serve`, for one Project, and talks to the shell over a line protocol on its standard input and
 * output — one JSON object per line. The shell has no business logic; everything it needs to know is in these lines.
 *
 * Host → shell (stdout):
 *   - `ready`    once listening: `url`, `port`, `configuredPort`, `portFallback`, `portOccupant`, `project`.
 *   - `request`  a native request the page asked for (`kind`, one of contracts `HOST_REQUEST_KINDS`). What to open is
 *                filled in by the host from what it knows itself — its own address, the log directory, the config
 *                file — never from the page: the host interface does not read the request's body (host-routes.ts).
 *                `pick_folder` carries an `id` the shell answers with.
 *   - `stopping` / `stopped`  the graceful shutdown began / ended (`reason`: quit, input_closed, output_closed, signal,
 *                switch). On `switch` the `stopped` line carries `next`: the project folder the shell starts the next
 *                host for (`--project`), the way the host leaves a project for another (spec 「进程结构」).
 *   - `ready`'s `project` is null in the welcome state (desktop-app ticket 18).
 *   - `failed`   the server could not start; the process then exits with 1.
 *
 * Shell → host (stdin):
 *   - `{"type":"quit"}`                               shut down gracefully.
 *   - `{"type":"folder_picked","id":…,"path":…|null}` the answer to a `pick_folder` request (null: cancelled).
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

import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { basename, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_PORT,
  HOST_REQUEST_KINDS,
  type HostPortFallback,
  type HostPortOccupant,
  type HostProjectState,
  type HostRecentProjects,
  type HostRequestKind,
  isHostInfo,
} from "@argelanderspace/contracts";
import {
  configFilePath,
  f,
  type KeychainProbe,
  type LogField,
  RECENT_PROJECTS_FILE,
  RECENT_PROJECTS_PROBLEMS,
  readRecentProjects,
  recordRecentProject,
  removeRecentProject,
} from "@argelanderspace/infra";
import type { HostBridge, RecentOpenOutcome } from "./host-routes.js";
import type { ServerLog } from "./log.js";
import type { NoProjectServer } from "./no-project.js";
import {
  type RunningServer,
  type StartedExtras,
  serveStart,
  startNoProjectServer,
  startServer,
} from "./server.js";
import { shownPath } from "./settings.js";

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

/** Why a line from the shell was not acted on (recorded as `desktop.protocol_rejected`). */
const REJECT_REASONS = [
  "too_long",
  "not_json",
  "unknown_type",
  "bad_shape",
  "unknown_id",
  "unknown_event",
] as const;
type RejectReason = (typeof REJECT_REASONS)[number];

const YES_NO = ["yes", "no"] as const;
const SIGNALS = [
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGHUP",
  "SIGQUIT",
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGFPE",
  "SIGPIPE",
  "other",
] as const;

/** How one field of a shell event is written: by one of the log's field constructors. */
type ShellFieldKind = "id" | "num" | "ms" | readonly string[];
interface ShellEventSpec {
  /** The level; `warn` for `shell.host_exited` with `expected: "no"`. */
  level: "info" | "warn";
  fields: Readonly<Record<string, ShellFieldKind>>;
}

/**
 * The shell's events (spec 「日志」: its start, the host's starts and exits with their exit codes, the answers to its
 * native dialogs) and how each field is written. A field of another name, or of the wrong type, is not written.
 */
export const SHELL_EVENTS = {
  "shell.started": { level: "info", fields: { version: "id", webview: "id" } },
  "shell.host_started": { level: "info", fields: { pid: "num", attempt: "num" } },
  "shell.host_exited": {
    level: "info",
    fields: { exit_code: "num", signal: SIGNALS, expected: YES_NO, duration_ms: "ms" },
  },
  "shell.dialog_answered": {
    level: "info",
    fields: {
      dialog: ["host_crashed"],
      choice: ["restart", "show_log_folder", "quit", "closed"],
    },
  },
  "shell.request_failed": { level: "warn", fields: { request: HOST_REQUEST_KINDS, code: "id" } },
} as const satisfies Record<string, ShellEventSpec>;
type ShellEvent = keyof typeof SHELL_EVENTS;

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
    }
  | { type: "request"; kind: "pick_folder"; id: string }
  | { type: "request"; kind: "open_in_browser"; url: string }
  | { type: "request"; kind: "open_devtools" }
  | { type: "request"; kind: "open_log_folder"; path: string }
  | { type: "request"; kind: "open_config_file"; path: string }
  | { type: "request"; kind: "open_skills_folder" }
  | { type: "stopping"; reason: HostStopReason }
  | { type: "stopped"; next?: string }
  | { type: "failed"; stage: "start" };

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
  own: { port: number; logDir: string; configPath: string },
  pickId: () => string
): HostOutLine {
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
      // Where the skills that ship with the app are is decided with their packaging (desktop-app ticket 24).
      return { type: "request", kind };
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
const LEAVE_SOURCES = ["picked", "recent"] as const;
/** Why a picked path is not left for (the path itself is never written). */
const PICK_REJECT_REASONS = ["not_a_folder"] as const;

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
  const configuredPort = atStart.config.port ?? DEFAULT_PORT;

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
      })),
      lastMissing:
        lastMissing !== null && projects.some((entry) => entry.path === lastMissing)
          ? shownPath(lastMissing)
          : null,
    };
  }

  /** The page opens a project of the list: only in the welcome state, only a path of the list, only a folder. */
  function openRecent(path: string): RecentOpenOutcome {
    if (stopping !== null) return "shutting_down";
    if (project === "open") return "project_open";
    const { projects } = readRecentProjects(recentFile);
    if (!projects.some((entry) => entry.path === path)) return "unknown_project";
    if (!isFolder(path)) return "folder_missing";
    return leave(path, "recent") ? "leaving" : "shutting_down";
  }

  // Bound once the server listens; a request before that (there can be none: nothing listens) is refused.
  let own: { port: number; logDir: string; log: ServerLog } | null = null;
  const pending = new Set<string>();
  const bridge: HostBridge = {
    get portFallback() {
      return portFallback;
    },
    project,
    recent: {
      list: () => recentList(),
      open: (path) => openRecent(path),
      remove: (path) => {
        try {
          removeRecentProject(recentFile, path);
        } catch (error) {
          own?.log.warn("recent_projects.write_failed", { error: f.error(error) });
          throw error;
        }
        return recentList();
      },
    },
    request(kind) {
      if (stopping !== null || own === null) return false;
      own.log.info("desktop.request", { kind: f.oneOf(HOST_REQUEST_KINDS, kind) });
      write(
        requestLine(kind, { ...own, configPath }, () => {
          const id = randomUUID();
          pending.add(id);
          return id;
        })
      );
      return true;
    },
  };

  const argv = options.webDist === undefined ? [] : ["--web-dist", options.webDist];
  let server: DesktopHost["server"];
  try {
    const start = {
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.keychainProbe ? { keychainProbe: options.keychainProbe } : {}),
      desktop: {
        host: bridge,
        listenPort,
        // Before the start record is written, so that it says whether the port fell back.
        onListening: (port: number) => {
          if (occupant !== null)
            portFallback = { configured: configuredPort, actual: port, occupant };
        },
      },
    };
    server =
      project === "open" ? await startServer(argv, start) : await startNoProjectServer(argv, start);
  } catch (error) {
    write({ type: "failed", stage: "start" });
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
  const stop = (reason: HostStopReason = "quit"): Promise<HostStopReason> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      log.info("desktop.stopping", { reason: f.oneOf(HOST_STOP_REASONS, reason) });
      write({ type: "stopping", reason });
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

  /** Leaves for another project: recorded, then the host stops and tells its shell (`stopped`'s `next`). */
  function leave(openedAs: string, source: (typeof LEAVE_SOURCES)[number]): boolean {
    if (stopping !== null) return false;
    const path = canonical(openedAs);
    record(path, openedAs);
    log.info("desktop.leaving", { source: f.oneOf(LEAVE_SOURCES, source) });
    next = path;
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
        // The welcome state leaves for the folder; with a project open, switching is ticket 19.
        if (path !== null && project === "none") {
          if (isFolder(path)) leave(path, "picked");
          else
            log.warn("desktop.pick_rejected", {
              reason: f.oneOf(PICK_REJECT_REASONS, "not_a_folder"),
            });
        }
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
        const fields = shellFields(spec, m.fields) as Record<string, LogField>;
        const unexpected =
          event === "shell.host_exited" &&
          typeof m.fields === "object" &&
          m.fields !== null &&
          (m.fields as Record<string, unknown>).expected === "no";
        if (spec.level === "warn" || unexpected) log.warn(event as ShellEvent, fields);
        else log.info(event as ShellEvent, fields);
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
  });
  input.resume();

  return { server, project, stopped, stop };
}
