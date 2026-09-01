/**
 * Server entry: `createServer` (programmatic; the Hono app + node http server
 * + job runner + WS hub + external-write library poller wired together) and
 * `startServer` (CLI-friendly: argv/env config resolution, listen, log).
 *
 * Config resolution (decisions 3 + 23): `--data-dir` >
 * `ARGELANDERSPACE_DATA_DIR` > config `data_dir` > `./literatures`; the port chain is
 * the same shape with default 8000 (uvicorn's convention). Web dist:
 * `--web-dist` > `ARGELANDERSPACE_WEB_DIST` > the first existing of
 * `<this module>/web` (the bundled single-package layout, decision 22) and
 * `<cwd>/packages/web/dist` (the repo dev layout).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type LibraryPaths, libraryPaths } from "@argelanderspace/core";
import { type AppConfig, getConfig } from "@argelanderspace/infra";
import type { ServerType } from "@hono/node-server";
import { serve } from "@hono/node-server";
import type { Hono } from "hono";
import { type AppDeps, createApp } from "./app.js";
import { realPipelines, realSources } from "./deps.js";
import { JobRunner } from "./jobs.js";
import { startLibraryWatcher } from "./watch.js";
import { WsHub } from "./ws.js";

export interface ServerOptions {
  dataDir: string;
  /** Default 8000; `0` picks an ephemeral port (tests). */
  port?: number;
  /** Default `127.0.0.1` (uvicorn's convention for this local tool). */
  hostname?: string;
  /** Built SPA directory; `null` disables static hosting. */
  webDist?: string | null;
  /** Composition seam: stub the infra wiring (offline tests). */
  deps?: Partial<Pick<AppDeps, "makeSources">>;
  /** WS heartbeat interval; `0` disables (tests). */
  heartbeatMs?: number;
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
  const paths = libraryPaths(opts.dataDir);
  const runner = new JobRunner({ dir: join(opts.dataDir, "jobs") });
  const port = opts.port ?? 8000;

  // hub is referenced by the broadcast closure before construction below;
  // it is only ever *called* after `new WsHub(...)` runs (request time).
  let hub: WsHub;
  const app = createApp({
    paths,
    makeSources: opts.deps?.makeSources ?? ((offline) => realSources(paths, offline)),
    pipelines: realPipelines(paths),
    runner,
    broadcast: (msg) => hub.broadcast(msg),
    webDist: opts.webDist,
    port,
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
  });

  // Agent/CLI writes mutate the library behind the server's back (Stage 3):
  // poll for them and rebroadcast as `library.changed` "external". The first
  // poll only establishes the baseline, and `hub` is assigned long before
  // any later poll can fire (the closure-timing argument of `broadcast`
  // above). The server's own writes re-trigger this too — accepted.
  const watcher = startLibraryWatcher({
    dataDir: opts.dataDir,
    onChange: () =>
      hub.broadcast({ type: "library.changed", cause: "external", at: new Date().toISOString() }),
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
        watcher.stop();
        hub.close();
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
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
  const srv = createServer({ dataDir: cfg.dataDir, port: cfg.port, webDist: cfg.webDist });
  const port = await srv.ready();
  console.log(`ArgelanderSpace server listening on http://127.0.0.1:${port}`);
  console.log(`  data dir: ${cfg.dataDir}`);
  console.log(`  web dist: ${cfg.webDist ?? "(none — API only)"}`);
  return srv;
}
