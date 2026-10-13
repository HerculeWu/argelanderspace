/**
 * Server entry: `createServer` (programmatic; the Hono app + node http server
 * + job runner + WS hub + external-write library/plans poller wired together)
 * and `startServer` (CLI-friendly: argv/config resolution, listen, log).
 *
 * Config resolution (decisions 3 + 23): `--data-dir` > config `data_dir`
 * (relative only) > `./literatures`; the port chain is `--port` > config
 * `port` > `DEFAULT_PORT`. No environment variable of the workbench's own
 * takes part. Web dist: `--web-dist` > the first existing of
 * `<this module>/web` (the bundled single-package layout, decision 22) and
 * `<cwd>/packages/web/dist` (the repo dev layout). The status dir (Stage 4)
 * has no flag: it always sits next to the effective data dir
 * (`statusDirFor`).
 *
 * The user-level log (log.ts): `createServer` records only into the `log` it is given, and by default into nothing;
 * `startServer` — the `serve` command, the one long-running process so far — opens this run's file in the log
 * directory, records the start, and closes the file when the server closes.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PORT } from "@argelanderspace/contracts";
import { type LibraryPaths, libraryPaths } from "@argelanderspace/core";
import {
  type AppConfig,
  type FetchImpl,
  f,
  fetchArxivPdf as fetchCurrentArxivPdf,
  getConfig,
  observedFetch,
  resolveGlobalDirs,
} from "@argelanderspace/infra";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { type AppDeps, createApp } from "./app.js";
import { appendArxivFetchLog } from "./arxiv-fetch-log.js";
import { ingestFailureLog } from "./compile-failure-log.js";
import { CopilotHost } from "./copilot.js";
import { realDiscoverySource, realPipelines, realSources, statusDirFor } from "./deps.js";
import { JobRunner } from "./jobs.js";
import { logServerStarted, openServeLog, type ServerLog, silentLog } from "./log.js";
import { externalObserver, jobIdField, jobLogger, logEnvironment } from "./log-observers.js";
import { sweepStagedAttachmentsIn } from "./mail-compose.js";
import { disposeMailSendServices } from "./mail-send.js";
import type { MailWatcher } from "./mail-watch.js";
import { createDefaultMailWatcher, type MailWatcherOverrides } from "./mail-watch-default.js";
import { ProviderSettings } from "./providers.js";
import { startWatcher } from "./watch.js";
import { WsHub } from "./ws.js";

export interface ServerOptions {
  dataDir: string;
  /** Global cache directory whose stale mail attachment staging is swept at start; unset = no sweep. */
  sweepMailStagingIn?: string;
  /** Default `DEFAULT_PORT`; `0` picks an ephemeral port (tests). */
  port?: number;
  /** Default `127.0.0.1` (uvicorn's convention for this local tool). */
  hostname?: string;
  /** Built SPA directory; `null` disables static hosting. */
  webDist?: string | null;
  /** Composition seam: stub the infra wiring (offline tests). */
  deps?: Partial<
    Pick<AppDeps, "makeSources" | "makeDiscoverySource" | "fetchArxivPdf" | "pipelines">
  >;
  /**
   * The HTTP implementation under the real sources, the arXiv e-print fetcher and the arXiv PDF download (offline
   * tests pass a stub and keep the real clients); default the global fetch. Ignored where `deps` replaces the
   * adapter itself.
   */
  fetchImpl?: FetchImpl;
  /** WS heartbeat interval; `0` disables (tests). */
  heartbeatMs?: number;
  /** The rate window of the page-error reports (page-errors.ts): a dependency-injection point like `heartbeatMs`. */
  pageErrors?: Pick<import("./page-errors.js").PageErrorOptions, "windowMs">;
  /** External-write poll interval (default 1500); tests inject ~50. */
  watchIntervalMs?: number;
  /** Explicit isolated credential/config store; ordinary servers initialize lazily. */
  providerSettings?: ProviderSettings;
  /**
   * Live Mail updates (ticket 08): one IMAP connection per account on INBOX. Off unless asked for,
   * so a test server never reads the real global mail accounts; `startServer` turns it on.
   */
  mailWatch?: false | true | MailWatcherOverrides;
  /** The user-level log (log.ts). Absent → nothing is recorded, and no log directory is resolved or made. */
  log?: ServerLog;
}

export interface RunningServer {
  app: Hono;
  runner: JobRunner;
  hub: WsHub;
  server: ServerType;
  paths: LibraryPaths;
  /** Resolves with the bound port once listening (matters for port 0). */
  ready(): Promise<number>;
  close(): Promise<void>;
}

/** The port the server is listening on; undefined before it listens and after it closed. */
function boundPort(server: ServerType): number | undefined {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : undefined;
}

export function createServer(opts: ServerOptions): RunningServer {
  // Mail: drop week-old unsent attachment staging in this cache directory. Only when asked for
  // (startServer, the production entry): a default createServer never resolves the real global dirs.
  if (opts.sweepMailStagingIn) sweepStagedAttachmentsIn(opts.sweepMailStagingIn);
  const paths = libraryPaths(opts.dataDir);
  const statusDir = statusDirFor(opts.dataDir);
  const log = opts.log ?? silentLog;
  // What the adapters report of their external calls goes to this server's log; without a log there is no observer
  // and the adapters are composed exactly as the CLI composes them.
  const observer = externalObserver(log);
  const wiring = { observer, fetchImpl: opts.fetchImpl };
  const observeJobs = jobLogger(log);
  const jobsDir = join(opts.dataDir, "jobs");
  const runner = new JobRunner({
    dir: jobsDir,
    ...(observeJobs ? { observe: observeJobs } : {}),
    // Stage 15 (D12): a boot-interrupted arXiv fetch is a failure worth
    // iterating on too — it lands in the same plain-text JSONL log.
    onInterrupted: (job) => {
      if (job.kind !== "ingest") return;
      const p = (job.payload ?? {}) as { workId?: unknown; arxivId?: unknown };
      try {
        appendArxivFetchLog(opts.dataDir, {
          time: job.finishedAt ?? new Date().toISOString(),
          jobId: job.id,
          workId: typeof p.workId === "string" ? p.workId : null,
          arxivId: typeof p.arxivId === "string" ? p.arxivId : null,
          stage: "interrupted",
          error: "job interrupted by server restart (never re-run)",
        });
      } catch (logErr) {
        log.error("arxiv_fetch.log_append_failed", {
          job: jobIdField(job.id),
          error: f.error(logErr),
        });
      }
    },
  });
  const port = opts.port ?? DEFAULT_PORT;

  let mailWatcher: MailWatcher | undefined;

  // hub is referenced by the broadcast closure before construction below;
  // it is only ever *called* after `new WsHub(...)` runs (request time).
  let hub: WsHub;
  const providerSettings = opts.providerSettings ?? new ProviderSettings();
  const copilot = new CopilotHost(opts.dataDir, providerSettings, (event) => hub.broadcast(event));
  copilot.useLog(log);
  if (opts.mailWatch) {
    mailWatcher = createDefaultMailWatcher(
      (msg) => hub.broadcast(msg),
      opts.mailWatch === true ? {} : opts.mailWatch,
      log
    );
  }
  const app = createApp({
    paths,
    statusDir,
    makeSources: opts.deps?.makeSources ?? ((offline) => realSources(paths, offline, wiring)),
    makeDiscoverySource:
      opts.deps?.makeDiscoverySource ?? (() => realDiscoverySource(paths, wiring)),
    pipelines: opts.deps?.pipelines ?? realPipelines(paths, wiring),
    // The real pipelines keep a failed compile's complete latexmk log beside the job's record.
    ...(opts.deps?.pipelines === undefined
      ? {
          pipelinesForJob: (jobId: string) =>
            realPipelines(paths, { ...wiring, failureLog: ingestFailureLog(jobsDir, jobId, log) }),
        }
      : {}),
    fetchArxivPdf:
      opts.deps?.fetchArxivPdf ??
      ((arxivId) =>
        fetchCurrentArxivPdf(
          arxivId,
          observer === undefined && opts.fetchImpl === undefined
            ? {}
            : { fetchImpl: observedFetch(opts.fetchImpl ?? fetch, "arxiv", observer) }
        )),
    runner,
    broadcast: (msg) => hub.broadcast(msg),
    webDist: opts.webDist,
    // Read at request time: with port 0 the port is only known once the server listens.
    boundPort: () => boundPort(server),
    providerSettings,
    copilot,
    log,
    ...(opts.pageErrors ? { pageErrors: opts.pageErrors } : {}),
    ...(mailWatcher ? { mailWatch: mailWatcher } : {}),
  });

  const server = serve({
    fetch: app.fetch,
    port,
    hostname: opts.hostname ?? "127.0.0.1",
  });
  // `serve` without http2 options always returns a node http/1 Server;
  // ServerType's union just can't express that statically.
  hub = new WsHub(server as import("node:http").Server, {
    heartbeatMs: opts.heartbeatMs,
    snapshot: () => runner.list(),
    onViewSubscribed: (viewId) => copilot.viewConnected(viewId),
  });
  copilot.useViewDelivery((viewId, message) => hub.sendToView(viewId, message));
  mailWatcher?.start();

  // Agent/CLI writes mutate the library and plans.json behind the server's
  // back (Stage 3 / Stage 4): poll for them and rebroadcast as
  // `library.changed` / `plan.changed` "external". The first poll only
  // establishes the baseline, and `hub` is assigned long before any later
  // poll can fire (the closure-timing argument of `broadcast` above). The
  // server's own writes re-trigger this too — accepted.
  // Stage 8: the watcher's third fingerprint covers
  // `annotations/<doc>/current.json` per doc, rebroadcast as one
  // `annotation.changed` "external" per changed doc (it only notifies — the
  // archive-on-mismatch write stays on the REST access path, roadmap §4).
  const watcher = startWatcher({
    dataDir: opts.dataDir,
    statusDir,
    intervalMs: opts.watchIntervalMs,
    onLibraryChange: () =>
      hub.broadcast({ type: "library.changed", cause: "external", at: new Date().toISOString() }),
    onPlansChange: () => {
      hub.broadcast({ type: "plan.changed", cause: "external", at: new Date().toISOString() });
      void copilot.revalidate("plans").catch(() => {});
    },
    onAnnotationsChange: (docIds) => {
      const at = new Date().toISOString();
      for (const docId of docIds) {
        hub.broadcast({ type: "annotation.changed", doc_id: docId, cause: "external", at });
      }
    },
    // ADR 0009: a Work's argument-graph file changed on disk (the server's own
    // PUT re-arrives here as "external" too — the page's refetch is idempotent).
    onArgumentGraphChange: (workIds) => {
      const at = new Date().toISOString();
      for (const workId of workIds) {
        hub.broadcast({ type: "argument-graph.changed", cause: "external", work_id: workId, at });
      }
      // A CLI write or a hand edit may make a pending Copilot replace/clear card obsolete (click time stays the authority).
      void copilot.revalidate("argument").catch(() => {});
    },
    // Stage 10: writer manuscripts/templates re-broadcast as writer.changed;
    // a templates-dir change carries cause:"template" without an id. The
    // server's own writes re-arrive here too — idempotent refetch precedent.
    onWriterChange: ({ ids, templates }) => {
      const at = new Date().toISOString();
      for (const id of ids) {
        hub.broadcast({ type: "writer.changed", cause: "external", id, at });
      }
      // A hand edit may make a pending Copilot manuscript delete obsolete (click time stays the authority).
      void copilot.revalidate("writer").catch(() => {});
      if (templates) {
        hub.broadcast({ type: "writer.changed", cause: "template", at });
      }
    },
  });

  const ready = new Promise<number>((resolveReady, rejectReady) => {
    server.on("listening", () => resolveReady(boundPort(server) ?? port));
    server.on("error", rejectReady);
  });

  return {
    app,
    runner,
    hub,
    server,
    paths,
    ready: () => ready,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        // First, synchronously: no mail undo window may end into a send while the rest shuts down
        // (stopping Copilot runs can take a while). Pending sends become interrupted, back in Drafts.
        disposeMailSendServices();
        watcher.stop();
        hub.close();
        providerSettings.close();
        // Connections and timers of the mail watcher end before the server is reported closed.
        void Promise.all([mailWatcher?.stop(), copilot.close()]).then(
          () => server.close((err) => (err ? rejectClose(err) : resolveClose())),
          rejectClose
        );
      }),
  };
}

// --------------------------------------------------------------------------- //
// CLI-friendly config + start
// --------------------------------------------------------------------------- //

export interface ResolvedConfig {
  dataDir: string;
  port: number;
  webDist: string | null;
}

function argValue(argv: readonly string[], name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === flag) return argv[i + 1];
    if (a?.startsWith(`${flag}=`)) return a.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * flag > config file (decision 23) > default, for the data dir and the port; the web dist is the flag or the
 * directory found next to the bundle / in the repo. `config` is injectable for tests; production callers leave it
 * to `getConfig()` (a missing config file is `{}`).
 */
export function resolveServerConfig(
  argv: readonly string[] = [],
  cwd: string = process.cwd(),
  config: AppConfig = getConfig()
): ResolvedConfig {
  const dataDir = resolve(argValue(argv, "data-dir") ?? config.data_dir ?? "./literatures");
  const portRaw = argValue(argv, "port");
  const port = portRaw === undefined ? (config.port ?? DEFAULT_PORT) : Number.parseInt(portRaw, 10);
  const webRaw = argValue(argv, "web-dist");
  let webDist: string | null;
  if (webRaw !== undefined) {
    webDist = resolve(webRaw);
  } else {
    // The bundled single package ships the SPA at <bundle>/web (import.meta
    // of every module is the one bundle file); the repo dev layout builds it
    // at <cwd>/packages/web/dist.
    const candidates = [
      fileURLToPath(new URL("./web", import.meta.url)),
      join(cwd, "packages", "web", "dist"),
    ];
    webDist = candidates.find((p) => existsSync(p)) ?? null;
  }
  return { dataDir, port: Number.isNaN(port) ? DEFAULT_PORT : port, webDist };
}

export interface StartOptions {
  /** The version of the program that is starting the server, for the start record. */
  version?: string;
}

/**
 * Resolve config, create the server, wait for the listen, print the URL. This is the long-running process: it writes
 * the user-level log (a bad config.toml is reported before any log is opened, as before).
 */
export async function startServer(
  argv: readonly string[] = process.argv.slice(2),
  start: StartOptions = {}
): Promise<RunningServer> {
  const config = getConfig();
  const cfg = resolveServerConfig(argv, process.cwd(), config);
  const serveLog = openServeLog(config);
  let sweepMailStagingIn: string | undefined;
  try {
    sweepMailStagingIn = resolveGlobalDirs().cacheDir;
  } catch {
    /* an unresolvable global directory is reported when Mail is used, not here */
  }
  // Whatever stops the start — the server cannot be created, the port cannot be bound — the log file is closed and
  // the process is no longer watched.
  let srv: RunningServer;
  let port: number;
  try {
    srv = createServer({
      dataDir: cfg.dataDir,
      port: cfg.port,
      webDist: cfg.webDist,
      mailWatch: true,
      log: serveLog.log,
      ...(sweepMailStagingIn ? { sweepMailStagingIn } : {}),
    });
    port = await srv.ready();
  } catch (error) {
    serveLog.close();
    throw error;
  }
  logServerStarted(serveLog.log, {
    version: start.version,
    mode: "browser",
    port,
    projectRoot: process.cwd(),
    dataDir: cfg.dataDir,
    webDist: cfg.webDist,
  });
  logEnvironment(serveLog.log);
  // These three lines are what `serve` prints to the terminal; the log does not replace them.
  console.log(`ArgelanderSpace server listening on http://127.0.0.1:${port}`);
  console.log(`  data dir: ${cfg.dataDir}`);
  console.log(`  web dist: ${cfg.webDist ?? "(none — API only)"}`);
  const close = srv.close;
  return { ...srv, close: () => close().finally(() => serveLog.close()) };
}
