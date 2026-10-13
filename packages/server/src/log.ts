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

import {
  type AppConfig,
  CONFIG_KEYS,
  configFileKeys,
  createLogger,
  discardSink,
  f,
  installProcessLogging,
  LOG_LEVELS,
  type LogFile,
  type Logger,
  openLogFile,
  resolveLogDir,
} from "@argelanderspace/infra";
import type { Context, Hono } from "hono";
import { matchedRoutes } from "hono/route";

export const SERVER_LOG_EVENTS = [
  "server.started",
  "request.failed",
  "request.completed",
  "process.uncaught_exception",
  "process.unhandled_rejection",
  // What used to be printed to the console by the server:
  "library.argument_graph_merged",
  "argument_graph.broadcast_failed",
  "arxiv_fetch.log_append_failed",
  "arxiv_ingest.auto_submit_failed",
  "copilot.observation_not_recordable",
  "copilot.mail_accounts_unreadable",
  // Desktop-app ticket 07 (log-observers.ts, and the call sites named there):
  "server.environment",
  "job.created",
  "job.started",
  "job.progress",
  "job.done",
  "job.failed",
  "job.interrupted",
  "external_program.exited",
  "external_program.not_started",
  "external_service.answered",
  "external_service.no_answer",
  "mail.remote_call",
  "mail_watch.state_changed",
  "mail_watch.connection_ended",
  "credentials.keychain_state",
  "copilot.run_started",
  "copilot.run_finished",
  "copilot.tool_called",
] as const;

export type ServerLogEvent = (typeof SERVER_LOG_EVENTS)[number];
export type ServerLog = Logger<ServerLogEvent>;

/** The log of a server nobody gave one: records go nowhere (every test server, unless it asks). */
export const silentLog: ServerLog = createLogger({ events: SERVER_LOG_EVENTS, sink: discardSink });

/** How the workbench is delivered; only `serve` (the browser) exists so far. */
export const SERVER_MODES = ["browser", "desktop"] as const;
export type ServerMode = (typeof SERVER_MODES)[number];

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
export function openServeLog(config: AppConfig): ServeLog {
  let file: LogFile;
  try {
    file = openLogFile({ dir: resolveLogDir({ config }), process: "serve" });
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
    projectRoot: string;
    dataDir: string;
    webDist: string | null;
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
    project_root: f.path(info.projectRoot),
    data_dir: f.path(info.dataDir),
    ...(info.webDist === null ? {} : { web_dist: f.path(info.webDist) }),
    config_keys: f.someOf(CONFIG_KEYS, keys.known),
    config_unknown_keys: f.num(keys.unknown),
    log_level: f.oneOf(LOG_LEVELS, log.level()),
    pid: f.num(process.pid),
    node: f.id(process.version),
    platform: f.id(process.platform),
    arch: f.id(process.arch),
  });
}
