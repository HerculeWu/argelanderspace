/**
 * Server entry: `createServer` (programmatic; the Hono app + node http server
 * + job runner + WS hub + external-write library/plans poller wired together)
 * and `startServer` (CLI-friendly: argv/env config resolution, listen, log).
 *
 * Config resolution (decisions 3 + 23): `--data-dir` >
 * `ARGELANDERSPACE_DATA_DIR` > config `data_dir` > `./literatures`; the port chain is
 * the same shape with default 8000 (uvicorn's convention). Web dist:
 * `--web-dist` > `ARGELANDERSPACE_WEB_DIST` > the first existing of
 * `<this module>/web` (the bundled single-package layout, decision 22) and
 * `<cwd>/packages/web/dist` (the repo dev layout). The status dir (Stage 4)
 * has no flag: it always sits next to the effective data dir
 * (`statusDirFor`).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type LibraryPaths, libraryPaths } from "@argelanderspace/core";
import {
  type AppConfig,
  fetchArxivPdf as fetchCurrentArxivPdf,
  getConfig,
  resolveGlobalDirs,
} from "@argelanderspace/infra";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { type AppDeps, createApp } from "./app.js";
import { appendArxivFetchLog } from "./arxiv-fetch-log.js";
import { CopilotHost } from "./copilot.js";
import { realDiscoverySource, realPipelines, realSources, statusDirFor } from "./deps.js";
import { JobRunner } from "./jobs.js";
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
  /** Default 8000; `0` picks an ephemeral port (tests). */
  port?: number;
  /** Default `127.0.0.1` (uvicorn's convention for this local tool). */
  hostname?: string;
  /** Built SPA directory; `null` disables static hosting. */
  webDist?: string | null;
  /** Composition seam: stub the infra wiring (offline tests). */
  deps?: Partial<
    Pick<AppDeps, "makeSources" | "makeDiscoverySource" | "fetchArxivPdf" | "pipelines">
  >;
  /** WS heartbeat interval; `0` disables (tests). */
  heartbeatMs?: number;
  /** External-write poll interval (default 1500); tests inject ~50. */
  watchIntervalMs?: number;
  /** Explicit isolated credential/config store; ordinary servers initialize lazily. */
  providerSettings?: ProviderSettings;
  /**
   * Live Mail updates (ticket 08): one IMAP connection per account on INBOX. Off unless asked for,
   * so a test server never reads the real global mail accounts; `startServer` turns it on.
   */
  mailWatch?: false | true | MailWatcherOverrides;
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

export function createServer(opts: ServerOptions): RunningServer {
  // Mail: drop week-old unsent attachment staging in this cache directory. Only when asked for
  // (startServer, the production entry): a default createServer never resolves the real global dirs.
  if (opts.sweepMailStagingIn) sweepStagedAttachmentsIn(opts.sweepMailStagingIn);
  const paths = libraryPaths(opts.dataDir);
  const statusDir = statusDirFor(opts.dataDir);
  const runner = new JobRunner({
    dir: join(opts.dataDir, "jobs"),
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
        console.error("arxiv-fetch log append failed:", logErr);
      }
    },
  });
  const port = opts.port ?? 8000;

  let mailWatcher: MailWatcher | undefined;

  // hub is referenced by the broadcast closure before construction below;
  // it is only ever *called* after `new WsHub(...)` runs (request time).
  let hub: WsHub;
  const providerSettings = opts.providerSettings ?? new ProviderSettings();
  const copilot = new CopilotHost(opts.dataDir, providerSettings, (event) => hub.broadcast(event));
  if (opts.mailWatch) {
    mailWatcher = createDefaultMailWatcher(
      (msg) => hub.broadcast(msg),
      opts.mailWatch === true ? {} : opts.mailWatch
    );
  }
  const app = createApp({
    paths,
    statusDir,
    makeSources: opts.deps?.makeSources ?? ((offline) => realSources(paths, offline)),
    makeDiscoverySource: opts.deps?.makeDiscoverySource ?? (() => realDiscoverySource(paths)),
    pipelines: opts.deps?.pipelines ?? realPipelines(paths),
    fetchArxivPdf: opts.deps?.fetchArxivPdf ?? ((arxivId) => fetchCurrentArxivPdf(arxivId)),
    runner,
    broadcast: (msg) => hub.broadcast(msg),
    webDist: opts.webDist,
    port,
    providerSettings,
    copilot,
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
      copilot.revalidateConfirmations();
    },
    onAnnotationsChange: (docIds) => {
      const at = new Date().toISOString();
      for (const docId of docIds) {
        hub.broadcast({ type: "annotation.changed", doc_id: docId, cause: "external", at });
      }
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
      copilot.revalidateWriterConfirmations();
      if (templates) {
        hub.broadcast({ type: "writer.changed", cause: "template", at });
      }
    },
  });

  const ready = new Promise<number>((resolveReady, rejectReady) => {
    server.on("listening", () => {
      const addr = server.address();
      resolveReady(typeof addr === "object" && addr !== null ? addr.port : port);
    });
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
 * flag > env > config file (decision 23) > ./literatures; same pattern for port and
 * web-dist. `config` is injectable for tests; production callers leave it to
 * `getConfig()` (a missing config file is `{}`).
 */
export function resolveServerConfig(
  argv: readonly string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  config: AppConfig = getConfig()
): ResolvedConfig {
  const dataDir = resolve(
    argValue(argv, "data-dir") ?? env.ARGELANDERSPACE_DATA_DIR ?? config.data_dir ?? "./literatures"
  );
  const portRaw = argValue(argv, "port") ?? env.ARGELANDERSPACE_PORT;
  const port = portRaw === undefined ? (config.port ?? 8000) : Number.parseInt(portRaw, 10);
  const webRaw = argValue(argv, "web-dist") ?? env.ARGELANDERSPACE_WEB_DIST;
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
  return { dataDir, port: Number.isNaN(port) ? 8000 : port, webDist };
}

/** Resolve config, create the server, wait for the listen, log the URL. */
export async function startServer(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<RunningServer> {
  const cfg = resolveServerConfig(argv, env);
  let sweepMailStagingIn: string | undefined;
  try {
    sweepMailStagingIn = resolveGlobalDirs().cacheDir;
  } catch {
    /* an unresolvable global directory is reported when Mail is used, not here */
  }
  const srv = createServer({
    dataDir: cfg.dataDir,
    port: cfg.port,
    webDist: cfg.webDist,
    mailWatch: true,
    ...(sweepMailStagingIn ? { sweepMailStagingIn } : {}),
  });
  const port = await srv.ready();
  console.log(`ArgelanderSpace server listening on http://127.0.0.1:${port}`);
  console.log(`  data dir: ${cfg.dataDir}`);
  console.log(`  web dist: ${cfg.webDist ?? "(none — API only)"}`);
  return srv;
}
