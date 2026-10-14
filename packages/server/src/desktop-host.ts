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
 *   - `stopping` / `stopped`  the graceful shutdown began / ended (`reason`: quit, input_closed, output_closed, signal).
 *   - `failed`   the server could not start; the process then exits with 1.
 *
 * Shell → host (stdin):
 *   - `{"type":"quit"}`                               shut down gracefully.
 *   - `{"type":"folder_picked","id":…,"path":…|null}` the answer to a `pick_folder` request (null: cancelled).
 *   - `{"type":"shell_event","event":…,"fields":{…}}` one of the shell's own events, written into the host's log by
 *     the same rules as every other record: the event must be in {@link SHELL_EVENTS} and each field is put through
 *     the field constructor its catalog entry names; anything else is not written.
 *   The end of stdin (the shell exited or was killed) is a quit too, so the host never outlives its shell.
 *
 * Port: the configured one (config.toml `port`, default 1859), which the CLI's links point to. When it is taken the
 * host listens on a free port instead and says so in the ready line and to the page (`GET /api/host`), after asking the
 * port whether it is another ArgelanderSpace server or some other program.
 *
 * Shutdown: the server's own graceful close (server.ts `createServer().close()`): first, synchronously, every mail send
 * still in its undo window is marked interrupted and stays in Drafts; then the watchers, the WebSocket hub, Copilot
 * and the listening socket. The port is free when `stopped` is written.
 */

import { randomUUID } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  DEFAULT_PORT,
  HOST_REQUEST_KINDS,
  type HostPortFallback,
  type HostPortOccupant,
  type HostRequestKind,
  isHostInfo,
} from "@argelanderspace/contracts";
import { configFilePath, f, type KeychainProbe, type LogField } from "@argelanderspace/infra";
import type { HostBridge } from "./host-routes.js";
import type { ServerLog } from "./log.js";
import { type RunningServer, serveStart, startServer } from "./server.js";

/** A line longer than this (bytes, without its newline) is dropped whole. */
export const HOST_LINE_MAX_BYTES = 64 * 1024;
/** How long the host waits for whatever holds the configured port to answer `GET /api/host`. */
export const PORT_PROBE_TIMEOUT_MS = 1500;

export const HOST_STOP_REASONS = ["quit", "input_closed", "output_closed", "signal"] as const;
export type HostStopReason = (typeof HOST_STOP_REASONS)[number];

/** Why a line from the shell was not acted on (recorded as `desktop.protocol_rejected`). */
const REJECT_REASONS = ["too_long", "not_json", "unknown_type", "bad_shape", "unknown_id"] as const;
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
      project: string;
    }
  | { type: "request"; kind: "pick_folder"; id: string }
  | { type: "request"; kind: "open_in_browser"; url: string }
  | { type: "request"; kind: "open_devtools" }
  | { type: "request"; kind: "open_log_folder"; path: string }
  | { type: "request"; kind: "open_config_file"; path: string }
  | { type: "request"; kind: "open_skills_folder" }
  | { type: "stopping"; reason: HostStopReason }
  | { type: "stopped" }
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
  /** The answer to a `pick_folder` request: an absolute path, or null when the user cancelled (ticket 18 uses it). */
  onFolderPicked?: (path: string | null) => void;
  /** Tests only: the keychain probe of the start record. */
  keychainProbe?: () => Promise<KeychainProbe>;
}

export interface DesktopHost {
  /** The server, once ready, with the port it listens on and its log directory. */
  server: RunningServer & { port: number; logDir: string };
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
  const configuredPort = serveStart(configPath).config.port ?? DEFAULT_PORT;
  let portFallback: HostPortFallback | null = null;
  let listenPort = configuredPort;
  let occupant: HostPortOccupant | null = null;
  if (configuredPort !== 0 && !(await portIsFree(configuredPort))) {
    occupant = await portOccupant(configuredPort);
    listenPort = 0;
  }

  // Bound once the server listens; a request before that (there can be none: nothing listens) is refused.
  let own: { port: number; logDir: string; log: ServerLog } | null = null;
  const pending = new Set<string>();
  const bridge: HostBridge = {
    get portFallback() {
      return portFallback;
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
  let server: Awaited<ReturnType<typeof startServer>>;
  try {
    server = await startServer(argv, {
      ...(options.version === undefined ? {} : { version: options.version }),
      ...(options.keychainProbe ? { keychainProbe: options.keychainProbe } : {}),
      desktop: {
        host: bridge,
        listenPort,
        // Before the start record is written, so that it says whether the port fell back.
        onListening: (port) => {
          if (occupant !== null)
            portFallback = { configured: configuredPort, actual: port, occupant };
        },
      },
    });
  } catch (error) {
    write({ type: "failed", stage: "start" });
    throw error;
  }
  const log = server.log;
  own = { port: server.port, logDir: server.logDir, log };

  let resolveStopped!: (reason: HostStopReason) => void;
  const stopped = new Promise<HostStopReason>((r) => {
    resolveStopped = r;
  });
  const onSignal = () => void stop("signal");
  const stop = (reason: HostStopReason = "quit"): Promise<HostStopReason> => {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      log.info("desktop.stopping", { reason: f.oneOf(HOST_STOP_REASONS, reason) });
      write({ type: "stopping", reason });
      try {
        await server.close();
      } catch {
        /* the socket was already closed; the port is free either way */
      }
      if (options.signals) {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
      input.off("data", onData);
      write({ type: "stopped" });
      resolveStopped(reason);
      return reason;
    })();
    return stopping;
  };

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
        return;
      }
      case "shell_event": {
        const event = m.event;
        if (typeof event !== "string") {
          reject("bad_shape");
          return;
        }
        if (!Object.hasOwn(SHELL_EVENTS, event)) {
          // Not in the catalog: the logger writes its fixed rejection record, without the name or any field.
          log.info(event as never);
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
  input.once("error", () => void stop("input_closed"));
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
    project: process.cwd(),
  });
  input.resume();

  return { server, stopped, stop };
}
