/**
 * The protected Hono base (architecture-deepening ticket 01): the one step that starts the app of a server — the app
 * of an open project (`createApp`) and the one with no project open (`createNoProjectServer`) — and the only place
 * that knows which origins a browser page may call this server from.
 *
 * It holds:
 * - the origin rule, shared by the REST guard and the `/ws` upgrade (`ws.ts`): the Vite dev server's origins, plus
 *   the page this server serves on the port it is bound to — read again for every request, so `--port 0` and a
 *   closed listener are both right; a request without an Origin (a local tool) passes;
 * - the record of requests first (`logRequests`, before every route), then `cors` (a preflight is answered by it and
 *   never reaches the guard);
 * - the cross-site guard, enforced where a route is registered: through {@link ProtectedRoutes} a write method is
 *   guarded unless its registration says why not (`exempt`), a read is unguarded unless it says `guard: true`, an
 *   `all` must say which, and a sub-router is mounted with its prefix guarded for every method but GET.
 *
 * A guarded route gets the guard as its first handler, so a refusal is recorded (`request.failed`) with that route's
 * own pattern, and a guarded prefix records its `<prefix>/*` — never a global `*`.
 */

import type { AddressInfo } from "node:net";
import type { Context, Env, Handler, MiddlewareHandler, NotFoundHandler } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logRequests, type ServerLog } from "./log.js";

/** The Vite dev server (`packages/web/vite.config.ts`), which proxies to this server and may call it directly. */
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;

/** The origins of the page a server bound to `port` on this machine serves. */
function ownOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/** Which origins may send a guarded request or open the WebSocket. */
export interface OriginRule {
  /** No Origin (a local tool) passes; so do the dev origins and, while the server is bound, its own. */
  allows(origin: string | undefined): boolean;
}

/** The one origin rule; `boundPort` is asked on every call (undefined: not listening, only the dev origins pass). */
export function originRule(boundPort: () => number | undefined): OriginRule {
  return {
    allows(origin) {
      if (origin === undefined) return true;
      if ((DEV_ORIGINS as readonly string[]).includes(origin)) return true;
      const port = boundPort();
      return port !== undefined && ownOrigins(port).includes(origin);
    },
  };
}

/** The port a server is listening on; undefined before it listens and after it closed. */
export function listeningPort(server: {
  address(): AddressInfo | string | null;
}): number | undefined {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : undefined;
}

const REJECTED = { detail: "cross-site request rejected" } as const;
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** Every guard handler this module made, and what it guards (for {@link guardedRoutes}). */
const guards = new WeakMap<object, "route" | "non-GET">();

/** A write route: guarded unless `exempt` says why not. `noStore`: the refusal carries `Cache-Control: no-store`. */
export type WriteOptions =
  | { exempt: string; noStore?: never }
  | { exempt?: never; noStore?: boolean };
/** A read route: unguarded unless `guard: true`. */
export type ReadOptions = { guard?: true; noStore?: boolean };
/** An every-method route must say whether it is guarded. */
export type AllOptions = { exempt: string } | { guard: true; noStore?: boolean };
/** A sub-router: its prefix guarded for every method but GET (HEAD included), or exempt with a reason. */
export type MountOptions = { guard: "non-GET"; noStore?: boolean } | { exempt: string };

type RouteHandler<P extends string> = Handler<Env, P>;

/**
 * How the modules of a server register routes; see the module comment for the defaults. The options, when given, come
 * before the handler: `routes.put(path, { noStore: true }, async (c) => …)`.
 */
export interface ProtectedRoutes {
  get<P extends string>(path: P, handler: RouteHandler<P>): void;
  get<P extends string>(path: P, options: ReadOptions, handler: RouteHandler<P>): void;
  post<P extends string>(path: P, handler: RouteHandler<P>): void;
  post<P extends string>(path: P, options: WriteOptions, handler: RouteHandler<P>): void;
  put<P extends string>(path: P, handler: RouteHandler<P>): void;
  put<P extends string>(path: P, options: WriteOptions, handler: RouteHandler<P>): void;
  patch<P extends string>(path: P, handler: RouteHandler<P>): void;
  patch<P extends string>(path: P, options: WriteOptions, handler: RouteHandler<P>): void;
  delete<P extends string>(path: P, handler: RouteHandler<P>): void;
  delete<P extends string>(path: P, options: WriteOptions, handler: RouteHandler<P>): void;
  all<P extends string>(path: P, options: AllOptions, handler: RouteHandler<P>): void;
  /** Mounts `sub` at `prefix` (Hono's `route`), the guard of `options` registered before any of its middleware. */
  mount(prefix: string, sub: Hono, options: MountOptions): void;
  /** A middleware that is not a route (it guards nothing and is guarded by nothing). */
  use(path: string, middleware: MiddlewareHandler): void;
  notFound(handler: NotFoundHandler): void;
  /** The same registrar, with every refusal of the routes registered through it carrying `Cache-Control: no-store`. */
  withDefaults(defaults: { noStore: boolean }): ProtectedRoutes;
}

export interface ProtectedApp {
  /** The Hono app itself: for serving it and for `app.request` in tests; the route modules get `routes`. */
  hono: Hono;
  routes: ProtectedRoutes;
}

export interface ProtectedAppOptions {
  log: ServerLog;
  /** The port the server is listening on now; undefined when it is not (or the app has no server). */
  boundPort: () => number | undefined;
}

export function createProtectedApp(options: ProtectedAppOptions): ProtectedApp {
  const rule = originRule(options.boundPort);
  const hono = new Hono();
  // First, so that it sees every request: the record of failed requests (the answers themselves are not changed).
  logRequests(hono, options.log);
  // Dev: the Vite dev server (localhost:5173) calls this API directly. allowHeaders left empty → hono reflects the
  // requested headers. A preflight (OPTIONS) is answered here and never reaches a guard.
  hono.use("*", cors({ origin: [...DEV_ORIGINS], allowMethods: ["GET"] }));

  const reject = (c: Context, noStore: boolean) =>
    noStore ? c.json(REJECTED, 403, NO_STORE) : c.json(REJECTED, 403);
  const routeGuard = (noStore: boolean): MiddlewareHandler => {
    const guard: MiddlewareHandler = async (c, next) => {
      if (!rule.allows(c.req.header("origin"))) return reject(c, noStore);
      await next();
    };
    guards.set(guard, "route");
    return guard;
  };
  const prefixGuard = (noStore: boolean): MiddlewareHandler => {
    const guard: MiddlewareHandler = async (c, next) => {
      if (c.req.method !== "GET" && !rule.allows(c.req.header("origin"))) return reject(c, noStore);
      await next();
    };
    guards.set(guard, "non-GET");
    return guard;
  };
  const guarded = { true: routeGuard(true), false: routeGuard(false) };

  const on = (method: string, path: string, handlers: Array<Handler | MiddlewareHandler>) =>
    (
      hono.on as (
        method: string,
        path: string,
        ...handlers: Array<Handler | MiddlewareHandler>
      ) => Hono
    )(method, path, ...handlers);

  // `(path, handler)` or `(path, options, handler)`.
  const split = <O extends object>(
    second: O | Handler,
    third: Handler | undefined
  ): [Partial<O> & { exempt?: string; guard?: unknown; noStore?: boolean }, Handler] =>
    typeof second === "function" ? [{}, second] : [second, third as Handler];

  /** An exemption names its reason; an empty one is a mistake in the code, caught when the app is built. */
  const exempt = (opts: { exempt?: string }, path: string): boolean => {
    if (opts.exempt === undefined) return false;
    if (opts.exempt.trim() === "") throw new TypeError(`the exemption of ${path} gives no reason`);
    return true;
  };

  const registrar = (defaults: { noStore: boolean }): ProtectedRoutes => {
    const noStoreOf = (opts: { noStore?: boolean }) => opts.noStore ?? defaults.noStore;
    const write =
      (method: string) =>
      (path: string, second: WriteOptions | Handler, third?: Handler): void => {
        const [opts, handler] = split<WriteOptions>(second, third);
        if (exempt(opts, path)) on(method, path, [handler]);
        else on(method, path, [guarded[`${noStoreOf(opts)}`], handler]);
      };
    return {
      get(path: string, second: ReadOptions | Handler, third?: Handler) {
        const [opts, handler] = split<ReadOptions>(second, third);
        if (opts.guard) on("GET", path, [guarded[`${noStoreOf(opts)}`], handler]);
        else on("GET", path, [handler]);
      },
      post: write("POST"),
      put: write("PUT"),
      patch: write("PATCH"),
      delete: write("DELETE"),
      all(path: string, opts: AllOptions, handler: Handler) {
        if ("guard" in opts) on("ALL", path, [guarded[`${noStoreOf(opts)}`], handler]);
        else if (exempt(opts, path)) on("ALL", path, [handler]);
      },
      mount(prefix, sub, opts) {
        if ("guard" in opts) hono.use(`${prefix}/*`, prefixGuard(noStoreOf(opts)));
        else exempt(opts, prefix);
        hono.route(prefix, sub);
      },
      use(path, middleware) {
        hono.use(path, middleware);
      },
      notFound(handler) {
        hono.notFound(handler);
      },
      withDefaults: (next) => registrar(next),
    } as ProtectedRoutes;
  };

  return { hono, routes: registrar({ noStore: false }) };
}

/**
 * The guarded (method, pattern) pairs of an app made by {@link createProtectedApp}, in registration order, read from
 * what was registered: a guarded route as its own method, a guarded prefix as `non-GET` with its `<prefix>/*`.
 */
export function guardedRoutes(hono: Hono): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const route of hono.routes) {
    const kind = guards.get(route.handler);
    if (kind === "route") out.push([route.method, route.path]);
    else if (kind === "non-GET") out.push(["non-GET", route.path]);
  }
  return out;
}
