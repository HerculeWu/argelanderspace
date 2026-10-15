/**
 * The server with no project open (desktop-app ticket 18; spec 「欢迎状态」): what the desktop host runs when it has no
 * project to enter — a first start, or the last project's folder is gone. It answers the page, the host interface
 * (host-routes.ts) and the settings interface (settings.ts), and every other endpoint with 409 `no_project`. It has
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
import {
  configFilePath,
  type GlobalDirs,
  pinGlobalDirs,
  readConfigLeniently,
  resolveGlobalDirsLeniently,
} from "@argelanderspace/infra";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mountWebDist } from "./app.js";
import { type HostBridge, mountHostRoutes } from "./host-routes.js";
import { applyLogLevel, logRequests, type ServerLog, silentLog } from "./log.js";
import { DEV_ORIGINS, ownOrigins } from "./origins.js";
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
  globalDirs?: GlobalDirs;
  startup?: StartupLocations;
  settingsAtStart?: SettingsValues;
  heartbeatMs?: number;
  watchIntervalMs?: number;
}

export interface NoProjectServer {
  app: Hono;
  hub: WsHub;
  server: ServerType;
  ready(): Promise<number>;
  close(): Promise<void>;
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function boundPort(server: ServerType): number | undefined {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : undefined;
}

export function createNoProjectServer(opts: NoProjectServerOptions): NoProjectServer {
  const log = opts.log ?? silentLog;
  let hub: WsHub;
  const broadcast = (msg: Parameters<WsHub["broadcast"]>[0]) => hub.broadcast(msg);

  const originAllowed = (origin: string): boolean => {
    if ((DEV_ORIGINS as readonly string[]).includes(origin)) return true;
    const port = boundPort(server);
    return port !== undefined && ownOrigins(port).includes(origin);
  };
  const guardCsrf = (
    origin: string | undefined
  ): { body: { detail: string }; status: 403 } | null =>
    origin !== undefined && !originAllowed(origin)
      ? { body: { detail: "cross-site request rejected" }, status: 403 }
      : null;

  const app = new Hono();
  logRequests(app, log);
  app.use("*", cors({ origin: [...DEV_ORIGINS], allowMethods: ["GET"] }));

  const settingsAtStart = opts.settingsAtStart ?? readSettings(opts.configPath).values;
  mountSettingsRoutes(app, guardCsrf, {
    startup: opts.startup ?? null,
    path: opts.configPath,
    atStart: settingsAtStart,
    running: () => {
      const dirs =
        opts.globalDirs ??
        resolveGlobalDirsLeniently(readConfigLeniently(opts.configPath ?? configFilePath())).dirs;
      return {
        project_root: null,
        port: boundPort(server) ?? null,
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
  mountHostRoutes(app, guardCsrf, opts.host);

  // Everything else of the API (and a Doc's images) is project data: there is none.
  const noProject = (c: import("hono").Context) =>
    c.json({ code: NO_PROJECT_CODE, detail: "no project is open" }, 409, NO_STORE);
  app.all("/api/*", noProject);
  app.all("/images/*", noProject);

  mountWebDist(app, opts.webDist, opts.configPath);
  app.notFound((c) => c.json({ detail: "Not Found" }, 404));

  const port = opts.port ?? 0;
  const server = serve({ fetch: app.fetch, port, hostname: opts.hostname ?? "127.0.0.1" });
  hub = new WsHub(server as import("node:http").Server, {
    heartbeatMs: opts.heartbeatMs,
    snapshot: () => [],
  });
  const releaseGlobalDirs = pinGlobalDirs(
    opts.globalDirs ??
      resolveGlobalDirsLeniently(readConfigLeniently(opts.configPath ?? configFilePath())).dirs
  );
  const settingsWatcher = startSettingsWatcher({
    path: opts.configPath,
    intervalMs: opts.watchIntervalMs,
    onChange: () => {
      applyLogLevel(log, opts.configPath);
      broadcast({ type: "settings.changed", cause: "external", at: new Date().toISOString() });
    },
  });

  const ready = new Promise<number>((resolveReady, rejectReady) => {
    server.on("listening", () => resolveReady(boundPort(server) ?? port));
    server.on("error", rejectReady);
  });

  return {
    app,
    hub,
    server,
    ready: () => ready,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        settingsWatcher.stop();
        releaseGlobalDirs();
        hub.close();
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}
