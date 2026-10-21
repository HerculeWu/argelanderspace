/**
 * The server's part of the user-level log (infra `log/`): its event catalog, the record of each request, and the
 * file `serve` writes. Privacy is the log module's business — every value below goes through one of its field
 * constructors — and this file only decides which events exist and when they are written.
 *
 * Recording a request changes nothing else about it: the answer is the one the app gives without a log, and an
 * error no route handled is still printed whole on the server's terminal by Hono's default handling (the terminal
 * is the user's own; only the log file is written to be handed on).
 *
 * Which requests count as failed:
 *   - status 500 and above: `request.failed` at level error, with the error that caused it when there is one;
 *   - status 400–499: `request.failed` at level warn — the server refused something the page or a tool asked for;
 *   - except a GET or HEAD answered 404, which is an ordinary answer to "is it there?" (a Doc that was deleted, a
 *     page asset, a source map): `request.completed` at level debug, like every answer below 400.
 *
 * A request is recorded by the pattern of the route that answered (`/api/paper/:doc_id`), never by its path: the
 * path carries what the user asked for. The pattern is written only if it is one the app registered.
 */

import { HOST_PORT_OCCUPANTS, type HostPortFallback } from "@argelanderspace/contracts";
import {
  type AppConfig,
  CONFIG_KEYS,
  configFileKeys,
  createLogger,
  discardSink,
  f,
  installProcessLogging,
  LOG_LEVELS,
  type LogEvent,
  type LogEventFields,
  type LogEventTable,
  type LogFile,
  type Logger,
  openLogFile,
  resolveLogDir,
} from "@argelanderspace/infra";
import type { Context, Hono } from "hono";
import { matchedRoutes } from "hono/route";
import {
  CONFIG_PROBLEM_ENTRIES,
  type ConfigProblem,
  configProblemEntry,
  readSettings,
} from "./settings.js";
import { SHELL_EVENTS, type ShellEvent, type ShellEventSpec } from "./shell-events.js";

/** The writer of each kind a shell event's field can have (shell-events.ts): an enum is a list of values. */
const SHELL_FIELD_WRITERS = { id: f.id, num: f.num, ms: f.ms } as const;
type ShellFieldWriter<K> = K extends keyof typeof SHELL_FIELD_WRITERS
  ? (typeof SHELL_FIELD_WRITERS)[K]
  : typeof f.oneOf;
type ShellLogEvents = {
  readonly [E in ShellEvent]: {
    readonly [N in keyof (typeof SHELL_EVENTS)[E]["fields"]]: ShellFieldWriter<
      (typeof SHELL_EVENTS)[E]["fields"][N]
    >;
  };
};
/** The shell's events with their fields, as the host's table (shell-events.ts) has them: not listed a second time. */
const SHELL_LOG_EVENTS = Object.fromEntries(
  Object.entries(SHELL_EVENTS).map(([event, spec]) => [
    event,
    Object.fromEntries(
      Object.entries(spec.fields as ShellEventSpec["fields"]).map(([name, kind]) => [
        name,
        typeof kind === "string" ? SHELL_FIELD_WRITERS[kind] : f.oneOf,
      ])
    ),
  ])
) as ShellLogEvents;

/**
 * The server's events, each with its fields and the constructor of `f` each is made by (architecture 「用户日志」 lists
 * them): a field an event does not list, or one made by another constructor, is a type error at the call. Every field
 * is optional to the types; which ones a record has is decided where it is written.
 */
export const SERVER_LOG_EVENTS = {
  "server.started": {
    version: f.id,
    mode: f.oneOf,
    port: f.num,
    port_fallback: f.oneOf,
    port_configured: f.num,
    port_occupant: f.oneOf,
    project: f.oneOf,
    project_root: f.path,
    data_dir: f.path,
    web_dist: f.path,
    config_keys: f.someOf,
    config_unknown_keys: f.num,
    config_problems: f.someOf,
    log_level: f.oneOf,
    pid: f.num,
    node: f.id,
    platform: f.id,
    arch: f.id,
  },
  "request.failed": {
    method: f.oneOf,
    route: f.oneOf,
    status: f.num,
    duration_ms: f.ms,
    code: f.id,
    error: f.error,
  },
  "request.completed": { method: f.oneOf, route: f.oneOf, status: f.num, duration_ms: f.ms },
  "process.uncaught_exception": { error: f.error },
  "process.unhandled_rejection": { error: f.error },
  // What used to be printed to the console by the server:
  "library.argument_graph_merged": {
    outcome: f.oneOf,
    absorbed: f.workId,
    survivor: f.workId,
    reason: f.oneOf,
    survivor_unreadable: f.oneOf,
    absorbed_file_left: f.oneOf,
  },
  "argument_graph.broadcast_failed": { work: f.workId, error: f.error },
  "arxiv_fetch.log_append_failed": { job: f.id, error: f.error },
  "arxiv_ingest.auto_submit_failed": { work: f.workId, error: f.error },
  "copilot.observation_not_recordable": {},
  "copilot.mail_accounts_unreadable": {},
  // Desktop-app ticket 07 (log-observers.ts, and the call sites named there):
  "server.environment": {
    tools_found: f.someOf,
    tools_missing: f.someOf,
    tools_from_tex_dir: f.someOf,
    tools_from_common: f.someOf,
    tex_dir: f.oneOf,
    keychain: f.oneOf,
    keychain_reason: f.oneOf,
  },
  "job.created": { job: f.id, kind: f.oneOf, work: f.workId, doc: f.docId },
  "job.started": { job: f.id, kind: f.oneOf, queued_ms: f.ms },
  "job.progress": { job: f.id, kind: f.oneOf, step: f.num, stage: f.oneOf },
  "job.done": { job: f.id, kind: f.oneOf, duration_ms: f.ms },
  "job.failed": {
    job: f.id,
    kind: f.oneOf,
    stage: f.oneOf,
    category: f.oneOf,
    error_code: f.oneOf,
    duration_ms: f.ms,
    error: f.error,
  },
  "job.interrupted": { job: f.id, kind: f.oneOf, stage: f.oneOf },
  "external_program.exited": {
    program: f.oneOf,
    sandboxed: f.oneOf,
    exit_code: f.num,
    signal: f.oneOf,
    timed_out: f.oneOf,
    duration_ms: f.ms,
  },
  "external_program.not_started": {
    program: f.oneOf,
    sandboxed: f.oneOf,
    code: f.oneOf,
    duration_ms: f.ms,
  },
  "external_service.answered": { service: f.oneOf, host: f.url, status: f.num, duration_ms: f.ms },
  "external_service.no_answer": {
    service: f.oneOf,
    host: f.url,
    reason: f.oneOf,
    duration_ms: f.ms,
  },
  "mail.remote_call": {
    protocol: f.oneOf,
    call: f.oneOf,
    provider: f.oneOf,
    outcome: f.oneOf,
    code: f.oneOf,
    duration_ms: f.ms,
  },
  "mail_watch.state_changed": { account: f.id, state: f.oneOf, previous: f.oneOf },
  "mail_watch.connection_ended": {
    account: f.id,
    code: f.oneOf,
    temporary_refusal: f.oneOf,
    connected_ms: f.ms,
  },
  "credentials.keychain_state": { state: f.oneOf },
  "copilot.run_started": { conversation: f.id, run: f.id },
  "copilot.run_finished": {
    conversation: f.id,
    run: f.id,
    status: f.oneOf,
    code: f.oneOf,
    duration_ms: f.ms,
  },
  "copilot.tool_called": {
    conversation: f.id,
    run: f.id,
    tool: f.oneOf,
    result: f.oneOf,
    duration_ms: f.ms,
    exit_code: f.num,
  },
  // Desktop-app ticket 08 (compile-failure-log.ts, page-errors.ts):
  "tex.compile_failed": {
    source: f.oneOf,
    job: f.id,
    manuscript: f.id,
    kind: f.oneOf,
    engine: f.oneOf,
    exit_code: f.num,
    timed_out: f.oneOf,
    missing_tex_files: f.ids,
    missing_other_files: f.someOf,
    // `jobs/<job id>.compile.log` for an ingest, a fixed value for a Writer render.
    log_file: [f.id, f.oneOf],
  },
  "page.error": { kind: f.oneOf, pane: f.oneOf, error: f.error },
  "page.errors_dropped": { reason: f.oneOf, count: f.num, recorded_this_launch: f.num },
  // Desktop-app ticket 14 (diagnostics.ts): a diagnostics bundle was asked for; `compile_logs` yes / no only.
  "diagnostics.exported": { compile_logs: f.oneOf },
  // Desktop-app ticket 17 (desktop-host.ts): the desktop host's own records, and the shell's events it is handed.
  "desktop.request": { kind: f.oneOf, source: f.oneOf },
  "desktop.folder_picked": { outcome: f.oneOf },
  "desktop.protocol_rejected": { reason: f.oneOf },
  "desktop.stopping": { reason: f.oneOf },
  "desktop.stop_timed_out": { ms: f.ms },
  // Desktop-app ticket 18: the welcome state, the project the host leaves for, and the recent-projects file.
  "desktop.no_project": { reason: f.oneOf },
  "desktop.leaving": { source: f.oneOf },
  "desktop.pick_rejected": { reason: f.oneOf },
  "recent_projects.unreadable": { reason: f.oneOf },
  "recent_projects.write_failed": { error: f.error },
  // Desktop-app ticket 19: a switch that would interrupt work waits for the user (counts only), or was cancelled.
  "desktop.switch_asked": { source: f.oneOf, jobs: f.num, conversations: f.num, mail: f.num },
  "desktop.switch_cancelled": {},
  // Desktop-app ticket 24: the command-line tool's launcher installed or removed (action and outcome only, no path).
  "desktop.cli_launcher": { action: f.oneOf, outcome: f.oneOf, error: f.error },
  // In-app-tutorial ticket 25 (desktop-tutorial.ts): a tutorial entry taken or failed (action and category, no path).
  "desktop.tutorial_entered": { action: f.oneOf, outcome: f.oneOf },
  "desktop.tutorial_failed": { action: f.oneOf, reason: f.oneOf },
  // In-app-tutorial ticket 18 (tutorial-routes.ts): `tutorial.json` could not be used (reason only), or not written.
  "tutorial.unreadable": { reason: f.oneOf },
  "tutorial.write_failed": { error: f.error },
  // Desktop-app tickets 20 and 21: the shell's own events, from its table.
  ...SHELL_LOG_EVENTS,
} as const satisfies LogEventTable;

export type ServerLogEvent = LogEvent<typeof SERVER_LOG_EVENTS>;
export type ServerLog = Logger<typeof SERVER_LOG_EVENTS>;
/** The fields an event of the server takes (several events: those of any one of them), for a record built in parts. */
export type ServerLogFields<E extends ServerLogEvent> = LogEventFields<typeof SERVER_LOG_EVENTS, E>;

/**
 * A list of enum values for a record, written out in code and checked against the type its values come from: a
 * value that is not of the type, and a value of the type that the list leaves out, are both type errors. So a
 * value added to the source type cannot be forgotten here and end up written as `<invalid-enum>`.
 *
 *   const CALLS = allOf<keyof Protocol>()(["open", "close"]);
 */
export function allOf<T extends string>() {
  return <const A extends readonly T[]>(list: A & ([T] extends [A[number]] ? unknown : never)): A =>
    list;
}

/** The log of a server nobody gave one: records go nowhere (every test server, unless it asks). */
export const silentLog: ServerLog = createLogger({ events: SERVER_LOG_EVENTS, sink: discardSink });

/**
 * Sets the level of a server's log to what config.toml says now (`log_level`; its default `info` when the file does not
 * set it or sets it wrong): called after the settings page changed the file and when the file watcher finds it changed,
 * so a new level takes effect from the next record, without a restart (desktop-app ticket 14). The silent log of a test
 * server is shared and left alone. Never throws.
 */
export function applyLogLevel(log: ServerLog, configPath?: string): void {
  if (log === silentLog) return;
  try {
    const level = readSettings(configPath).values.log_level;
    if (typeof level === "string" && (LOG_LEVELS as readonly string[]).includes(level))
      log.setLevel(level as (typeof LOG_LEVELS)[number]);
  } catch {
    /* the level stays as it was */
  }
}

/** How the workbench is delivered: `serve` (the browser) or the desktop host (desktop-host.ts). */
export const SERVER_MODES = ["browser", "desktop"] as const;
export type ServerMode = (typeof SERVER_MODES)[number];

const YES_NO = ["yes", "no"] as const;

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * The `code` of a JSON error answer (`{code, detail}`), without reading the answer: the object a route hands to
 * `c.json` is looked at as it goes by. Reading the body of a Response — even of a copy — can change how it is sent
 * (a streamed body that has been read through goes out with a length instead of in chunks, and only once all of it
 * is there), so the body is never read.
 *
 * The Response `c.json` returns is not always the object that is sent (Hono rebuilds it when a sub-app's error
 * handler answered), so the code is taken from the last `c.json` call of the request and counts only when the
 * answer that is sent has the status that call gave and a JSON content type. An answer made any other way
 * (`new Response`, `Response.json`) is recorded without a code.
 */
function watchJsonCode(c: Context): (sent: Response) => string | undefined {
  let last: { status: number; code: string | undefined } | undefined;
  const json = c.json as (...args: unknown[]) => Response;
  c.json = ((...args: unknown[]) => {
    const response = json(...args);
    try {
      const code = (args[0] as { code?: unknown } | null | undefined)?.code;
      last = { status: response.status, code: typeof code === "string" ? code : undefined };
    } catch {
      last = undefined; // an object that cannot be looked at has no code to record
    }
    return response;
  }) as typeof c.json;
  return (sent) =>
    last !== undefined &&
    last.status === sent.status &&
    sent.headers.get("Content-Type")?.includes("application/json")
      ? last.code
      : undefined;
}

/**
 * Records every request this app answers. Call it before any route is registered. It installs no error handler:
 * an Error a route throws is answered (and printed) by Hono's default one, which leaves it on the context for the
 * record below; a server without a log gets nothing installed at all.
 */
export function logRequests(app: Hono, log: ServerLog): void {
  let patterns: readonly string[] | undefined;
  const routeOf = (c: Context): string => {
    // The pattern of the innermost route that ran for this request: the handler's, or the middleware's (`*`,
    // `/api/mail/*`) when no handler matched.
    return matchedRoutes(c).at(c.req.routeIndex)?.path ?? "";
  };

  // A server without a log (every test server that does not ask for one) does none of the work below.
  if (log !== silentLog)
    app.use("*", async (c, next) => {
      const started = performance.now();
      let codeOf: (sent: Response) => string | undefined = () => undefined;
      try {
        codeOf = watchJsonCode(c);
      } catch {
        /* the request is recorded without a code */
      }
      try {
        await next();
      } catch (thrown) {
        // Only something that is not an Error gets here (Hono hands every Error to `onError`): it goes on to the
        // HTTP layer, which answers for it, so there is no status to record yet.
        try {
          patterns ??= [...new Set(app.routes.map((route) => route.path))];
          log.error("request.failed", {
            method: f.oneOf(METHODS, c.req.method),
            route: f.oneOf(patterns, routeOf(c)),
            duration_ms: f.ms(performance.now() - started),
            error: f.error(thrown),
          });
        } catch {
          /* as below */
        }
        throw thrown;
      }
      try {
        const status = c.res.status;
        const method = c.req.method;
        const failed =
          status >= 500 || (status >= 400 && !(status === 404 && /^(GET|HEAD)$/.test(method)));
        if (!failed && log.level() !== "debug") return;
        // Registered patterns are text written in this codebase; anything else would be written as invalid.
        patterns ??= [...new Set(app.routes.map((route) => route.path))];
        const fields = {
          method: f.oneOf(METHODS, method),
          route: f.oneOf(patterns, routeOf(c)),
          status: f.num(status),
          duration_ms: f.ms(performance.now() - started),
        };
        if (!failed) {
          log.debug("request.completed", fields);
          return;
        }
        const code = codeOf(c.res);
        const record = {
          ...fields,
          ...(code === undefined ? {} : { code: f.id(code) }),
          ...(c.error === undefined ? {} : { error: f.error(c.error) }),
        };
        if (status >= 500) log.error("request.failed", record);
        else log.warn("request.failed", record);
      } catch {
        /* recording a request never changes its answer */
      }
    });
}

export interface ServeLog {
  log: ServerLog;
  /** The file this run writes; its path is null when no file could be opened. */
  file: LogFile;
  /** Stops watching the process and closes the file. */
  close(): void;
}

/**
 * The log of a `serve` process: a new file in the user-level log directory, at the level config.toml asks for, and
 * a record of whatever ends the process. Never throws — a log that cannot be opened is a log that stays empty.
 */
export function openServeLog(
  config: AppConfig,
  dir?: string,
  kind: "serve" | "desktop" = "serve"
): ServeLog {
  let file: LogFile;
  try {
    // `serve` hands in the log directory of the global directories it fixed at its start (server.ts `serveStart`).
    // The desktop host's file is named for it (`…-desktop-<pid>.jsonl`), in the same directory.
    file = openLogFile({ dir: dir ?? resolveLogDir({ config }), process: kind });
  } catch {
    // The global data directory could not be resolved (a relative `global_dir`); Mail reports that when it is used.
    file = { path: null, write() {}, close() {} };
  }
  const log = createLogger({
    events: SERVER_LOG_EVENTS,
    sink: file,
    ...(config.log_level === undefined ? {} : { level: config.log_level }),
  });
  const unwatch = installProcessLogging(log, {
    uncaughtException: "process.uncaught_exception",
    unhandledRejection: "process.unhandled_rejection",
  });
  return {
    log,
    file,
    close() {
      unwatch();
      file.close();
    },
  };
}

/** The start record: what is running and where, and which config keys the file has — never a value of one. */
export function logServerStarted(
  log: ServerLog,
  info: {
    version: string | undefined;
    mode: ServerMode;
    port: number;
    /** Null: the desktop host started with no project open (desktop-app ticket 18). */
    projectRoot: string | null;
    dataDir: string | null;
    webDist: string | null;
    /** What is wrong with config.toml (server.ts `serveStart`): by key and category, never a value. */
    configProblems?: readonly ConfigProblem[];
    /** The desktop host only: whether the configured port was taken (null: it was not). */
    portFallback?: HostPortFallback | null;
  }
): void {
  let keys: ReturnType<typeof configFileKeys> = { known: [], unknown: 0 };
  try {
    keys = configFileKeys();
  } catch {
    /* the start is recorded without them */
  }
  log.info("server.started", {
    ...(info.version === undefined ? {} : { version: f.id(info.version) }),
    mode: f.oneOf(SERVER_MODES, info.mode),
    port: f.num(info.port),
    ...(info.portFallback === undefined
      ? {}
      : {
          port_fallback: f.oneOf(YES_NO, info.portFallback === null ? "no" : "yes"),
          ...(info.portFallback === null
            ? {}
            : {
                port_configured: f.num(info.portFallback.configured),
                port_occupant: f.oneOf(HOST_PORT_OCCUPANTS, info.portFallback.occupant),
              }),
        }),
    ...(info.projectRoot === null || info.dataDir === null
      ? { project: f.oneOf(["none"], "none") }
      : { project_root: f.path(info.projectRoot), data_dir: f.path(info.dataDir) }),
    ...(info.webDist === null ? {} : { web_dist: f.path(info.webDist) }),
    config_keys: f.someOf(CONFIG_KEYS, keys.known),
    config_unknown_keys: f.num(keys.unknown),
    config_problems: f.someOf(
      CONFIG_PROBLEM_ENTRIES,
      (info.configProblems ?? []).map(configProblemEntry)
    ),
    log_level: f.oneOf(LOG_LEVELS, log.level()),
    pid: f.num(process.pid),
    node: f.id(process.version),
    platform: f.id(process.platform),
    arch: f.id(process.arch),
  });
}
