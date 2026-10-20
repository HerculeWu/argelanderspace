/**
 * The server with no project open (desktop-app ticket 18; spec 「欢迎状态」): what the desktop host runs when it has no
 * project to enter — a first start, or the last project's folder is gone. It answers the page, the host interface
 * (host-routes.ts), the settings interface (settings.ts) and the page's own error reports (page-errors.ts: they go to
 * the user log only — user decision 2026-10-15), and every other endpoint with 409 `no_project`. It has
 * no project data directory and touches none: no job runner, no file watcher of project data, no Copilot, no Mail.
 * The browser form (`serve`) never runs it: there the project is the working directory.
 *
 * What is kept from `createServer`: the record of requests, the cross-origin guard, the configured appearance in the
 * page, the WebSocket (so that a change of config.toml reaches the page, as `settings.changed`), the settings file
 * watcher, and the global directories pinned for the server's life.
 */

import {
  NO_PROJECT_CODE,
  type SettingsValues,
  type StartupLocations,
} from "@argelanderspace/contracts";
import { type GlobalDirs, pinGlobalDirs } from "@argelanderspace/infra";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { mountWebDist } from "./app.js";
import { type HostBridge, mountHostRoutes } from "./host-routes.js";
import { applyLogLevel, type ServerLog, silentLog } from "./log.js";
import { mountPageErrorRoute, type PageErrorOptions } from "./page-errors.js";
import { createProtectedApp, listeningPort } from "./protected-app.js";
import { mountSettingsRoutes, readSettings, shownPath, startSettingsWatcher } from "./settings.js";
import { WsHub } from "./ws.js";

export interface NoProjectServerOptions {
  /** The desktop host the server runs under: the welcome state exists only there. */
  host: HostBridge;
  /** Default `0`. */
  port?: number;
  hostname?: string;
  webDist?: string | null;
  log?: ServerLog;
  configPath?: string;
  /**
   * The global data and cache directories for as long as this server runs (infra `pinGlobalDirs`), and the ones the
   * settings show as running. Required: the start hands in the ones it resolved (`serveStart`); the server reads no
   * config for them.
   */
  globalDirs: GlobalDirs;
  startup?: StartupLocations;
  settingsAtStart?: SettingsValues;
  heartbeatMs?: number;
  watchIntervalMs?: number;
  /** The rate window of the page-error reports (page-errors.ts); default a minute. */
  pageErrors?: Pick<PageErrorOptions, "windowMs">;
}

export interface NoProjectServer {
  app: Hono;
  hub: WsHub;
  server: ServerType;
  ready(): Promise<number>;
  close(): Promise<void>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function createNoProjectServer(opts: NoProjectServerOptions): NoProjectServer {
  const log = opts.log ?? silentLog;
  let hub: WsHub;
  const broadcast = (msg: Parameters<WsHub["broadcast"]>[0]) => hub.broadcast(msg);

  // The protected base (protected-app.ts): the same record of requests, cors and cross-site guard as createApp's.
  const { hono, routes: app } = createProtectedApp({ log, boundPort: () => listeningPort(server) });

  // What the page reports of its own errors: the user log only, the same route and limits as with a project open.
  let writePendingPageErrorCounts: () => void = () => {};
  mountPageErrorRoute(app, log, {
    ...opts.pageErrors,
    webDist: opts.webDist ?? null,
    atClose: (writePending) => {
      writePendingPageErrorCounts = writePending;
    },
  });

  const settingsAtStart = opts.settingsAtStart ?? readSettings(opts.configPath).values;
  mountSettingsRoutes(app, {
    startup: opts.startup ?? null,
    path: opts.configPath,
    atStart: settingsAtStart,
    running: () => {
      const dirs = opts.globalDirs;
      return {
        project_root: null,
        port: listeningPort(server) ?? null,
        data_dir: null,
        global_dir: shownPath(dirs.dataDir),
        global_cache_dir: shownPath(dirs.cacheDir),
        from_flag: [],
      };
    },
    written: () => {
      applyLogLevel(log, opts.configPath);
      broadcast({ type: "settings.changed", cause: "write", at: new Date().toISOString() });
    },
  });
  mountHostRoutes(app, opts.host);

  // Everything else of the API (and a Doc's images) is project data: there is none.
  const noProject = (c: import("hono").Context) =>
    c.json({ code: NO_PROJECT_CODE, detail: "no project is open" }, 409, NO_STORE);
  // Not guarded: a cross-site request learns only that no project is open, as it did before the base.
  app.all("/api/*", { exempt: "no project: answers 409 no_project to anyone" }, noProject);
  app.all("/images/*", { exempt: "no project: answers 409 no_project to anyone" }, noProject);

  mountWebDist(app, opts.webDist, opts.configPath);
  app.notFound((c) => c.json({ detail: "Not Found" }, 404));

  const port = opts.port ?? 0;
  const server = serve({ fetch: hono.fetch, port, hostname: opts.hostname ?? "127.0.0.1" });
  hub = new WsHub(server as import("node:http").Server, {
    heartbeatMs: opts.heartbeatMs,
    snapshot: () => [],
  });
  const releaseGlobalDirs = pinGlobalDirs(opts.globalDirs);
  const settingsWatcher = startSettingsWatcher({
    path: opts.configPath,
    intervalMs: opts.watchIntervalMs,
    onChange: () => {
      applyLogLevel(log, opts.configPath);
      broadcast({ type: "settings.changed", cause: "external", at: new Date().toISOString() });
    },
  });

  const ready = new Promise<number>((resolveReady, rejectReady) => {
    server.on("listening", () => resolveReady(listeningPort(server) ?? port));
    server.on("error", rejectReady);
  });

  return {
    app: hono,
    hub,
    server,
    ready: () => ready,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        settingsWatcher.stop();
        writePendingPageErrorCounts();
        releaseGlobalDirs();
        hub.close();
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}
