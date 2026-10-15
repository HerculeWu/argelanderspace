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
import {
  DEFAULT_PORT,
  type RunningFlagKey,
  type SettingsValues,
  type StartupLocations,
} from "@argelanderspace/contracts";
import { type LibraryPaths, libraryPaths } from "@argelanderspace/core";
import {
  type AppConfig,
  type CredentialStore,
  configFilePath,
  configOfReading,
  createAdsCredentialStore,
  currentToolchain,
  type FetchImpl,
  f,
  fetchArxivPdf as fetchCurrentArxivPdf,
  type GlobalDirs,
  getConfig,
  type KeychainProbe,
  logDirIn,
  observedFetch,
  pinGlobalDirs,
  readAdsToken,
  readConfigLeniently,
  resolveGlobalDirsLeniently,
  type SandboxViewOptions,
} from "@argelanderspace/infra";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { type AppDeps, createApp } from "./app.js";
import { appendArxivFetchLog } from "./arxiv-fetch-log.js";
import { ingestFailureLog, sweepIngestPartials } from "./compile-failure-log.js";
import { CopilotHost } from "./copilot.js";
import { realDiscoverySource, realPipelines, realSources, statusDirFor } from "./deps.js";
import type { HostBridge } from "./host-routes.js";
import { JobRunner } from "./jobs.js";
import {
  applyLogLevel,
  logServerStarted,
  openServeLog,
  type ServerLog,
  type ServerMode,
  silentLog,
} from "./log.js";
import {
  externalObserver,
  jobIdField,
  jobLogger,
  logEnvironment,
  observedCredentials,
} from "./log-observers.js";
import { sweepStagedAttachmentsIn } from "./mail-compose.js";
import { disposeMailSendServices } from "./mail-send.js";
import type { MailWatcher } from "./mail-watch.js";
import { createDefaultMailWatcher, type MailWatcherOverrides } from "./mail-watch-default.js";
import { createNoProjectServer, type NoProjectServer } from "./no-project.js";
import { ProviderSettings } from "./providers.js";
import {
  type ConfigProblem,
  configProblemLines,
  readSettings,
  startSettingsWatcher,
  startupLocations,
} from "./settings.js";
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
  /**
   * The config file the settings endpoints read and change and the server watches (settings.ts); default
   * `configFilePath()`.
   */
  configPath?: string;
  /**
   * The global data and cache directories for as long as this server runs (infra `pinGlobalDirs`): Mail, the
   * credential store and every other user of the global directories in this process get these, whatever config.toml
   * says later. `startServer` hands in the ones it resolved at the start; default: the lenient reading of the config
   * file when the server is created.
   */
  globalDirs?: GlobalDirs;
  /** Where `serve` keeps the process's data (settings.ts `startupLocations`), for `GET /api/settings`; default null. */
  startup?: StartupLocations;
  /** The values config.toml gave at the start (`serveStart`), for `restartPending`; default: the reading at creation. */
  settingsAtStart?: SettingsValues;
  /** The restart-only keys given on `serve`'s command line (`--port`, `--data-dir`), for `running.from_flag`. */
  settingsFromFlags?: readonly RunningFlagKey[];
  /**
   * The ADS token's credential store (desktop-app ticket 12): tests hand in one over a fake keychain. Default: the
   * `ads` purpose over the OS keychain. The settings endpoints write it and the sources read it at each composition.
   */
  adsCredentials?: CredentialStore;
  /** Where the ADS import looks for `~/.ads/dev_key`; default under the home directory (tests: a temporary file). */
  adsDevKeyPath?: (() => string) | undefined;
  /**
   * Whether the OS keychain can be used, for the environment check and the start record (desktop-app ticket 13): tests
   * hand in a fake. Default infra `probeKeychain`, which asks only the D-Bus daemon, never the keychain.
   */
  keychainProbe?: (() => Promise<KeychainProbe>) | undefined;
  /** Tests only: where the environment check looks for the Writer sandbox's latexmk (infra `sandbox-view.ts`). */
  sandboxView?: SandboxViewOptions | undefined;
  /** The user-level log directory the diagnostics show and bundle (app.ts `AppDeps.logDir`). */
  logDir?: string;
  /** The program's version, for the diagnostics' environment report. */
  version?: string;
  /** The desktop host this server runs under (desktop-app ticket 17, host-routes.ts); absent in the browser form. */
  host?: HostBridge;
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
  // One ADS credential store for the endpoints that save the token and the sources that use it (ticket 12).
  const adsCredentials = observedCredentials(
    opts.adsCredentials ?? createAdsCredentialStore(),
    log
  );
  // The sources take their keys from a lenient reading of config.toml at each use: a faulty file means "not set";
  // the ADS token from the credential store at each use, so a token saved or removed applies without a restart.
  const wiring = {
    observer,
    fetchImpl: opts.fetchImpl,
    config: () => readConfigLeniently(opts.configPath ?? configFilePath()),
    adsToken: () => readAdsToken(adsCredentials),
    // Where TeX is: looked up at each compile with the TeX directory the config file sets then (ticket 13).
    texToolchain: () => currentToolchain(opts.configPath ?? configFilePath()),
  };
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
  // A failed compile's log is collected in `<job id>.compile.log.partial` and renamed when the job has failed. One
  // left by a run that was killed holds lines of the source: the runner has just marked every unfinished job of this
  // directory interrupted (none is re-run), so whatever collecting file is here belongs to no running job.
  sweepIngestPartials(jobsDir);
  let writePendingPageErrorCounts: () => void = () => {};
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
    pageErrors: {
      ...opts.pageErrors,
      atClose: (writePending) => {
        writePendingPageErrorCounts = writePending;
      },
    },
    ...(mailWatcher ? { mailWatch: mailWatcher } : {}),
    configPath: opts.configPath,
    adsCredentials,
    adsDevKeyPath: opts.adsDevKeyPath,
    keychainProbe: opts.keychainProbe,
    sandboxView: opts.sandboxView,
    adsTestFetch:
      observer === undefined && opts.fetchImpl === undefined
        ? undefined
        : observedFetch(opts.fetchImpl ?? fetch, "ads", observer),
    startup: opts.startup ?? null,
    ...(opts.logDir === undefined ? {} : { logDir: opts.logDir }),
    ...(opts.version === undefined ? {} : { version: opts.version }),
    ...(opts.host === undefined ? {} : { host: opts.host }),
    ...(opts.settingsAtStart ? { settingsAtStart: opts.settingsAtStart } : {}),
    ...(opts.settingsFromFlags ? { settingsFromFlags: opts.settingsFromFlags } : {}),
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
  // The global directories are fixed for this server's life (released at close): a change of config.toml takes effect
  // at a restart, and a file broken meanwhile fails no request.
  const releaseGlobalDirs = pinGlobalDirs(
    opts.globalDirs ??
      resolveGlobalDirsLeniently(readConfigLeniently(opts.configPath ?? configFilePath())).dirs
  );
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

  // config.toml changed on disk (an editor's save, or this server's own write): every page reads the settings again.
  const settingsWatcher = startSettingsWatcher({
    path: opts.configPath,
    intervalMs: opts.watchIntervalMs,
    onChange: () => {
      // A hand edit of `log_level` takes effect at once too (desktop-app ticket 14).
      applyLogLevel(log, opts.configPath);
      hub.broadcast({ type: "settings.changed", cause: "external", at: new Date().toISOString() });
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
        // Dropped page-error reports whose count was waiting for its window to end are counted in the log now.
        writePendingPageErrorCounts();
        watcher.stop();
        settingsWatcher.stop();
        releaseGlobalDirs();
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
 * directory found next to the bundle / in the repo. `config` defaults to the strict `getConfig()` (a missing config
 * file is `{}`); `startServer` hands in its lenient reading of the file.
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

/**
 * What `serve` starts with (desktop-app ticket 10; hard contract, 「产品与执行边界」 item 2 as revised 2026-10-14):
 * the lenient reading of config.toml, once. A file that is not TOML, or cannot be read, gives every default; a faulty
 * key — `data_dir` written as an absolute path included — gives that key's default. Nothing is rewritten. The keys
 * that take effect at a restart (`data_dir`, `port`, `global_dir`, `global_cache_dir`) are fixed here for the whole
 * run; `problems` is what the terminal line and the start record name (never a value).
 */
export function serveStart(
  path: string = configFilePath(),
  argv: readonly string[] = []
): {
  config: AppConfig;
  globalDirs: GlobalDirs;
  problems: ConfigProblem[];
  startup: StartupLocations;
  values: SettingsValues;
} {
  // The server's reading already names a global directory this platform cannot use (settings.ts), so the page, the
  // terminal and the start record list the same problems.
  const reading = readSettings(path);
  const config = configOfReading(reading);
  const { dirs } = resolveGlobalDirsLeniently(config);
  const startup = startupLocations(reading, argValue(argv, "data-dir") !== undefined);
  return {
    config,
    globalDirs: dirs,
    problems: [...reading.problems],
    startup,
    values: reading.values,
  };
}

export interface StartOptions {
  /** The version of the program that is starting the server, for the start record. */
  version?: string;
  /** Tests only: the keychain probe of the start record (default infra `probeKeychain`). */
  keychainProbe?: () => Promise<KeychainProbe>;
  /**
   * The desktop host (desktop-app ticket 17, desktop-host.ts): the form is `desktop` in the start record and the
   * diagnostics, the page's native requests go to the bridge, the log file is the host's (`desktop`), and the three
   * start lines go to stderr — the host's stdout is its line protocol. Absent: `serve`, the browser form.
   */
  desktop?: {
    host: HostBridge;
    /** The port to listen on, chosen by the host (the configured one, or 0 when it is taken); not a command-line key. */
    listenPort: number;
    /** Called with the bound port once listening, before the start record is written. */
    onListening?: (port: number) => void;
  };
}

/** What a started server gives its caller, besides the server itself. */
export interface StartedExtras {
  environmentLogged: Promise<void>;
  port: number;
  logDir: string;
  log: ServerLog;
}

/**
 * Resolve config, create the server, wait for the listen, print the URL. This is the long-running process: it writes
 * the user-level log. It starts with a faulty config.toml too (`serveStart`): the faulty keys have their defaults,
 * and the terminal, the start record and the page say which.
 */
export async function startServer(
  argv: readonly string[] = process.argv.slice(2),
  start: StartOptions = {}
): Promise<RunningServer & StartedExtras> {
  return startWith(argv, start, (common, cfg) => ({
    srv: createServer({
      dataDir: cfg.dataDir,
      port: start.desktop?.listenPort ?? cfg.port,
      webDist: cfg.webDist,
      mailWatch: true,
      ...(start.desktop === undefined ? {} : { host: start.desktop.host }),
      log: common.log,
      logDir: common.logDir,
      ...(start.version === undefined ? {} : { version: start.version }),
      sweepMailStagingIn: common.globalDirs.cacheDir,
      globalDirs: common.globalDirs,
      startup: common.startup,
      settingsAtStart: common.values,
      settingsFromFlags: [
        ...(argValue(argv, "port") !== undefined ? (["port"] as const) : []),
        ...(argValue(argv, "data-dir") !== undefined ? (["data_dir"] as const) : []),
      ],
    }),
    project: { root: process.cwd(), dataDir: cfg.dataDir },
  }));
}

/**
 * The desktop host's server with no project open (desktop-app ticket 18, no-project.ts): the same start — the lenient
 * reading, the log file, the start record (without a project root or data directory), the environment record — but
 * the server answers only the page, the host and the settings interfaces and the page-error report. `--data-dir` and `--port` are not read.
 */
export async function startNoProjectServer(
  argv: readonly string[],
  start: StartOptions & { desktop: NonNullable<StartOptions["desktop"]> }
): Promise<NoProjectServer & StartedExtras> {
  return startWith(argv, start, (common, cfg) => ({
    srv: createNoProjectServer({
      host: start.desktop.host,
      port: start.desktop.listenPort,
      webDist: cfg.webDist,
      log: common.log,
      globalDirs: common.globalDirs,
      startup: common.startup,
      settingsAtStart: common.values,
    }),
    project: null,
  }));
}

interface StartCommon {
  log: ServerLog;
  logDir: string;
  globalDirs: GlobalDirs;
  startup: StartupLocations;
  values: SettingsValues;
}

async function startWith<S extends { ready(): Promise<number>; close(): Promise<void> }>(
  argv: readonly string[],
  start: StartOptions,
  create: (
    common: StartCommon,
    cfg: ResolvedConfig
  ) => { srv: S; project: { root: string; dataDir: string } | null }
): Promise<S & StartedExtras> {
  const { config, globalDirs, problems, startup, values } = serveStart(configFilePath(), argv);
  const cfg = resolveServerConfig(argv, process.cwd(), config);
  const mode: ServerMode = start.desktop === undefined ? "browser" : "desktop";
  // The log is in the global data directory this run uses, the one Mail and the credentials use too.
  const logDir = logDirIn(globalDirs.dataDir);
  const serveLog = openServeLog(config, logDir, mode === "desktop" ? "desktop" : "serve");
  // Whatever stops the start — the server cannot be created, the port cannot be bound — the log file is closed and
  // the process is no longer watched.
  let srv: S;
  let project: { root: string; dataDir: string } | null;
  let port: number;
  try {
    ({ srv, project } = create({ log: serveLog.log, logDir, globalDirs, startup, values }, cfg));
    port = await srv.ready();
    start.desktop?.onListening?.(port);
  } catch (error) {
    serveLog.close();
    throw error;
  }
  logServerStarted(serveLog.log, {
    version: start.version,
    mode,
    port,
    ...(start.desktop === undefined ? {} : { portFallback: start.desktop.host.portFallback }),
    projectRoot: project?.root ?? null,
    dataDir: project?.dataDir ?? null,
    webDist: cfg.webDist,
    configProblems: problems,
  });
  // The full lookup (TeX directory, PATH, usual places) and whether the keychain can be used — asked of the bus daemon
  // only, never of the keychain (desktop-app ticket 13). Not waited for: the keychain probe may take a few seconds (two
  // D-Bus calls of at most 3 s each), and the start does not wait for it — the record is written when it is done (and
  // not at all if the server closes first). `environmentLogged` resolves then.
  const environmentLogged = logEnvironment(serveLog.log, {
    toolchain: currentToolchain(configFilePath()),
    ...(start.keychainProbe ? { keychain: start.keychainProbe } : {}),
  });
  // These three lines are what `serve` prints to the terminal; the log does not replace them. The desktop host's
  // stdout is its line protocol, so there they go to stderr.
  const say = mode === "browser" ? console.log : console.error;
  say(`ArgelanderSpace server listening on http://127.0.0.1:${port}`);
  say(`  data dir: ${project === null ? "(no project open)" : project.dataDir}`);
  say(`  web dist: ${cfg.webDist ?? "(none — API only)"}`);
  // A faulty config.toml: named by key and category on the terminal too (never a value, never the parser's text).
  for (const line of configProblemLines(problems, { path: configFilePath(), startup })) {
    console.error(line);
  }
  const close = srv.close;
  return Object.assign(srv, {
    environmentLogged,
    port,
    logDir,
    log: serveLog.log,
    close: () => close().finally(() => serveLog.close()),
  });
}
