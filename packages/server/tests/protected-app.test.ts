/**
 * The protected Hono base (architecture-deepening ticket 01), through its interface: the one origin rule, the guard
 * enforced where a route is registered (writes guarded by default, reads by `guard: true`, sub-routers by prefix),
 * the headers of a refusal, what the user log records of it, and the guarded set of both apps read from what they
 * registered. No port is bound here: `app.request` and an injected `boundPort`.
 */

import { join } from "node:path";
import { libraryPaths } from "@argelanderspace/core";
import { createLogger } from "@argelanderspace/infra";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { afterEach, describe, expect, test } from "vitest";
import { createMemorySink } from "../../infra/tests/log-memory-sink.js";
import { createApp } from "../src/app.js";
import { statusDirFor } from "../src/deps.js";
import type { HostBridge } from "../src/host-routes.js";
import { JobRunner } from "../src/jobs.js";
import { SERVER_LOG_EVENTS, silentLog } from "../src/log.js";
import { createNoProjectServer, type NoProjectServer } from "../src/no-project.js";
import {
  createProtectedApp,
  guardedRoutes,
  listeningPort,
  originRule,
} from "../src/protected-app.js";
import { isolatedGlobalDirs, makeDataDir, stubPipelines, stubSources } from "./helpers.js";

const FOREIGN = "http://evil.example";
const DEV = "http://localhost:5173";
const REJECTED = { detail: "cross-site request rejected" };

function send(app: Hono, method: string, path: string, origin?: string, body?: string) {
  return app.request(path, {
    method,
    headers: origin === undefined ? {} : { Origin: origin },
    ...(body === undefined ? {} : { body }),
  });
}

describe("originRule", () => {
  test("no Origin, the dev origins, and the bound port's own origins pass; nothing else", () => {
    const rule = originRule(() => 4321);
    expect(rule.allows(undefined)).toBe(true);
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173"])
      expect(rule.allows(origin)).toBe(true);
    for (const origin of ["http://localhost:4321", "http://127.0.0.1:4321"])
      expect(rule.allows(origin)).toBe(true);
    for (const origin of [
      FOREIGN,
      "https://127.0.0.1:4321",
      "http://evil.example:4321",
      "http://127.0.0.1:4322",
      "http://localhost:1859",
      "null",
    ])
      expect([origin, rule.allows(origin)]).toEqual([origin, false]);
  });

  test("the port is read on every request; not bound, only the dev origins pass", () => {
    let port: number | undefined;
    const rule = originRule(() => port);
    expect(rule.allows("http://127.0.0.1:4321")).toBe(false);
    expect(rule.allows(DEV)).toBe(true);
    port = 4321;
    expect(rule.allows("http://127.0.0.1:4321")).toBe(true);
    port = undefined; // closed again
    expect(rule.allows("http://127.0.0.1:4321")).toBe(false);
  });

  test("listeningPort: the port of a listening address; undefined otherwise", () => {
    expect(
      listeningPort({ address: () => ({ address: "127.0.0.1", family: "IPv4", port: 7 }) })
    ).toBe(7);
    expect(listeningPort({ address: () => null })).toBeUndefined();
    expect(listeningPort({ address: () => "/tmp/pipe" })).toBeUndefined();
  });
});

describe("createProtectedApp", () => {
  function base(port: number | null = 4321) {
    const sink = createMemorySink();
    const log = createLogger({ events: SERVER_LOG_EVENTS, sink, level: "debug" });
    const { hono, routes } = createProtectedApp({ log, boundPort: () => port ?? undefined });
    const failed = () => sink.records().filter((r) => r.event === "request.failed");
    return { hono, routes, failed };
  }
  const ok = (c: { json: (v: unknown) => Response }) => c.json({ ok: true });

  test("a write registered without options is guarded: 403 {detail} for a foreign origin, no Cache-Control", async () => {
    const { hono, routes } = base();
    for (const method of ["post", "put", "patch", "delete"] as const) routes[method]("/w", ok);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const refused = await send(hono, method, "/w", FOREIGN);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual(REJECTED);
      expect(refused.headers.get("Cache-Control")).toBeNull();
      expect((await send(hono, method, "/w", DEV)).status).toBe(200);
      expect((await send(hono, method, "/w", "http://127.0.0.1:4321")).status).toBe(200);
      expect((await send(hono, method, "/w")).status).toBe(200); // no Origin: a local tool
    }
  });

  test("an app not bound to a port lets the dev origins through only", async () => {
    const { hono, routes } = base(null);
    routes.put("/w", ok);
    expect((await send(hono, "PUT", "/w", "http://127.0.0.1:4321")).status).toBe(403);
    expect((await send(hono, "PUT", "/w", "http://localhost:1859")).status).toBe(403);
    expect((await send(hono, "PUT", "/w", DEV)).status).toBe(200);
  });

  test("noStore, per route and as the default of a registrar, adds Cache-Control: no-store to the refusal", async () => {
    const { hono, routes } = base();
    routes.put("/one", { noStore: true }, ok);
    routes.withDefaults({ noStore: true }).post("/group", ok);
    routes.post("/plain", ok);
    for (const path of ["/one", "/group"]) {
      const refused = await send(hono, path === "/one" ? "PUT" : "POST", path, FOREIGN);
      expect([path, refused.status, refused.headers.get("Cache-Control")]).toEqual([
        path,
        403,
        "no-store",
      ]);
      expect(await refused.json()).toEqual(REJECTED);
    }
    expect((await send(hono, "POST", "/plain", FOREIGN)).headers.get("Cache-Control")).toBeNull();
  });

  test("an exempt write and a read without guard are not guarded; a read with guard: true is, HEAD too", async () => {
    const { hono, routes } = base();
    routes.put("/exempt", { exempt: "test: answers the same to anyone" }, ok);
    routes.get("/open", ok);
    routes.withDefaults({ noStore: true }).get("/closed", { guard: true }, ok);
    expect((await send(hono, "PUT", "/exempt", FOREIGN)).status).toBe(200);
    expect((await send(hono, "GET", "/open", FOREIGN)).status).toBe(200);
    for (const method of ["GET", "HEAD"]) {
      const refused = await send(hono, method, "/closed", FOREIGN);
      expect([method, refused.status, refused.headers.get("Cache-Control")]).toEqual([
        method,
        403,
        "no-store",
      ]);
    }
    expect((await send(hono, "GET", "/closed", DEV)).status).toBe(200);
  });

  test("all must say which: exempt answers anyone, guard: true refuses a foreign origin for every method", async () => {
    const { hono, routes } = base();
    routes.all("/free/*", { exempt: "test" }, ok);
    routes.all("/kept/*", { guard: true }, ok);
    expect((await send(hono, "POST", "/free/x", FOREIGN)).status).toBe(200);
    for (const method of ["GET", "POST"])
      expect((await send(hono, method, "/kept/x", FOREIGN)).status).toBe(403);
  });

  test("a mounted sub-router: every method but GET refused under the prefix, before its bodyLimit and onError", async () => {
    const { hono, routes } = base();
    const sub = new Hono();
    sub.use("*", bodyLimit({ maxSize: 4, onError: (c) => c.json({ detail: "too large" }, 413) }));
    sub.onError((_e, c) => c.json({ detail: "sub error" }, 500));
    sub.get("/x", ok);
    sub.post("/x", ok);
    sub.post("/boom", () => {
      throw new Error("boom");
    });
    routes.mount("/sub", sub, { guard: "non-GET", noStore: true });
    expect((await send(hono, "GET", "/sub/x", FOREIGN)).status).toBe(200);
    for (const [method, path] of [
      ["HEAD", "/sub/x"],
      ["POST", "/sub/x"],
      ["POST", "/sub/not-registered"],
      ["PUT", "/sub"],
      ["POST", "/sub/boom"],
    ] as const) {
      const refused = await send(
        hono,
        method,
        path,
        FOREIGN,
        method === "HEAD" ? undefined : "too long"
      );
      expect([method, path, refused.status, refused.headers.get("Cache-Control")]).toEqual([
        method,
        path,
        403,
        "no-store",
      ]);
    }
    expect((await send(hono, "POST", "/sub/x", DEV, "too long")).status).toBe(413);
    expect((await send(hono, "POST", "/sub/boom", DEV)).status).toBe(500);
  });

  test("an exemption without a reason is refused when the app is built", () => {
    const { routes } = base();
    expect(() => routes.post("/x", { exempt: " " }, ok)).toThrow(TypeError);
    expect(() => routes.all("/y/*", { exempt: "" }, ok)).toThrow(TypeError);
    expect(() => routes.mount("/z", new Hono(), { exempt: "" })).toThrow(TypeError);
  });

  test("a CORS preflight is answered by cors, never by the guard", async () => {
    const { hono, routes } = base();
    routes.put("/w", ok);
    for (const origin of [DEV, FOREIGN]) {
      const preflight = await hono.request("/w", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "PUT" },
      });
      expect([origin, preflight.status]).toEqual([origin, 204]);
    }
  });

  test("the user log records a refusal as request.failed with the route's pattern, a prefix's with <prefix>/*", async () => {
    const { hono, routes, failed } = base();
    routes.put("/api/things/:id", ok);
    routes.get("/api/thing", { guard: true }, ok);
    const sub = new Hono();
    sub.post("/x", ok);
    routes.mount("/api/sub", sub, { guard: "non-GET" });
    await send(hono, "PUT", "/api/things/7", FOREIGN);
    await send(hono, "HEAD", "/api/thing", FOREIGN);
    await send(hono, "POST", "/api/sub/nowhere", FOREIGN);
    expect(
      failed().map(({ method, route, status, level }) => ({ level, method, route, status }))
    ).toEqual([
      { level: "warn", method: "PUT", route: "/api/things/:id", status: 403 },
      { level: "warn", method: "HEAD", route: "/api/thing", status: 403 },
      { level: "warn", method: "POST", route: "/api/sub/*", status: 403 },
    ]);
  });

  test("without a log nothing is installed but cors", () => {
    const { hono } = createProtectedApp({ log: silentLog, boundPort: () => undefined });
    expect(hono.routes.map((r) => `${r.method} ${r.path}`)).toEqual(["ALL /*"]);
  });

  test("guardedRoutes lists what was registered guarded, in order", () => {
    const { hono, routes } = base();
    routes.get("/r", ok);
    routes.get("/g", { guard: true }, ok);
    routes.post("/w", ok);
    routes.post("/x", { exempt: "test" }, ok);
    routes.all("/a/*", { exempt: "test" }, ok);
    routes.mount("/m", new Hono().post("/y", ok), { guard: "non-GET" });
    routes.mount("/n", new Hono().post("/z", ok), { exempt: "test" });
    expect(guardedRoutes(hono)).toEqual([
      ["GET", "/g"],
      ["POST", "/w"],
      ["non-GET", "/m/*"],
    ]);
  });
});

// --------------------------------------------------------------------------- //
// The guarded set of both apps (frozen 2026-10-20 from the code before ticket 01, see the ticket's Comments; the two
// PDF PUTs joined it by user decision 1)
// --------------------------------------------------------------------------- //

const HOST_GUARDED: Array<[string, string]> = [
  ["GET", "/api/host"],
  ["POST", "/api/host/requests/:kind"],
  ["GET", "/api/host/cli"],
  ["POST", "/api/host/cli/install"],
  ["POST", "/api/host/cli/uninstall"],
  ["GET", "/api/host/recent-projects"],
  ["POST", "/api/host/recent-projects/open"],
  ["POST", "/api/host/recent-projects/remove"],
  ["POST", "/api/host/switch/confirm"],
  ["POST", "/api/host/switch/cancel"],
];
/** The tutorial progress (in-app-tutorial ticket 18): the GET carries a local path, so it is guarded too. */
const TUTORIAL_GUARDED: Array<[string, string]> = [
  ["GET", "/api/tutorial"],
  ["PUT", "/api/tutorial"],
];

const CREATE_APP_GUARDED: Array<[string, string]> = [
  ["POST", "/api/page-errors"],
  ["PUT", "/api/settings/:key"],
  ["PUT", "/api/credentials/ads"],
  ["DELETE", "/api/credentials/ads"],
  ["POST", "/api/credentials/ads/test"],
  ["POST", "/api/credentials/ads/import"],
  ["GET", "/api/environment"],
  ...HOST_GUARDED,
  ...TUTORIAL_GUARDED,
  ["GET", "/api/diagnostics"],
  ["POST", "/api/diagnostics/export"],
  ["non-GET", "/api/copilot/providers/*"],
  ["non-GET", "/api/mail/compose/*"],
  ["non-GET", "/api/mail/*"],
  ["non-GET", "/api/copilot/*"],
  ["POST", "/api/library/text-docs"],
  ["PUT", "/api/paper/:doc_id/source"],
  ["POST", "/api/paper/:doc_id/source/assets"],
  ["POST", "/api/paper/:doc_id/source/assets/from-pdf"],
  ["POST", "/api/paper/:doc_id/source/validate"],
  ["POST", "/api/paper/:doc_id/source/generate"],
  ["PUT", "/api/paper/:doc_id/pdf/reading-position"], // user decision 1 (2026-10-20)
  ["PUT", "/api/paper/:doc_id/pdf/annotations"], // user decision 1 (2026-10-20)
  ["PUT", "/api/paper/:doc_id/annotations"],
  ["DELETE", "/api/paper/:doc_id"],
  ["POST", "/api/plans/undo"],
  ["PUT", "/api/plans"],
  ["PUT", "/api/works/:workId/argument-graph"],
  ["POST", "/api/writer/manuscripts"],
  ["PUT", "/api/writer/manuscripts/:id"],
  ["POST", "/api/writer/manuscripts/:id/numbering/refresh"],
  ["DELETE", "/api/writer/manuscripts/:id"],
  ["POST", "/api/writer/manuscripts/:id/assets"],
  ["POST", "/api/library/works"],
  ["PATCH", "/api/library/refs"],
  ["POST", "/api/library/refresh"],
  ["POST", "/api/library/upload-pdf"],
  ["POST", "/api/library/upload"],
  ["POST", "/api/library/acquire-arxiv-pdf"],
  ["POST", "/api/library/attach-arxiv"],
];

const NO_PROJECT_GUARDED: Array<[string, string]> = [
  ["POST", "/api/page-errors"],
  ["PUT", "/api/settings/:key"],
  ...HOST_GUARDED,
  ...TUTORIAL_GUARDED,
];

function projectApp() {
  const dataDir = makeDataDir();
  return createApp({
    paths: libraryPaths(dataDir),
    statusDir: statusDirFor(dataDir),
    makeSources: () => stubSources(),
    pipelines: stubPipelines(),
    runner: new JobRunner({ dir: join(dataDir, "jobs") }),
    broadcast: () => {},
    webDist: null,
  });
}

const noProjectServers: NoProjectServer[] = [];
afterEach(async () => {
  for (const srv of noProjectServers.splice(0)) await srv.close();
});

async function noProjectApp(): Promise<Hono> {
  const srv = createNoProjectServer({
    host: {} as HostBridge,
    globalDirs: isolatedGlobalDirs(),
    heartbeatMs: 0,
    webDist: null,
  });
  noProjectServers.push(srv);
  await srv.ready();
  return srv.app;
}

describe("the guarded set of each app", () => {
  test("createApp: as frozen, plus the two PDF PUTs", () => {
    expect(guardedRoutes(projectApp())).toEqual(CREATE_APP_GUARDED);
  });

  test("the no-project server: page errors, settings, the host and the tutorial; its /api/* and /images/* answer anyone", async () => {
    const app = await noProjectApp();
    expect(guardedRoutes(app)).toEqual(NO_PROJECT_GUARDED);
    const fallback = await send(app, "POST", "/api/library/works", FOREIGN, "{}");
    expect(fallback.status).toBe(409);
    expect(((await fallback.json()) as { code?: string }).code).toBe("no_project");
  });

  test("both apps refuse a cross-site write through the base", async () => {
    for (const app of [projectApp(), await noProjectApp()]) {
      const refused = await send(app, "PUT", "/api/settings/ui.theme", FOREIGN, "{}");
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual(REJECTED);
    }
  });

  test("the guard comes first: a cross-site oversized page-error report is 403, not 413", async () => {
    const refused = await send(
      projectApp(),
      "POST",
      "/api/page-errors",
      FOREIGN,
      "x".repeat(64 * 1024)
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(REJECTED);
  });

  test("the guard comes first: in the browser form a cross-site host request is 403, not 404 not_desktop", async () => {
    const refused = await send(projectApp(), "POST", "/api/host/requests/open_log_folder", FOREIGN);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual(REJECTED);
  });

  test("the two PDF PUTs now refuse a cross-site write, with Cache-Control: no-store", async () => {
    const app = projectApp();
    for (const path of [
      "/api/paper/demo/pdf/reading-position",
      "/api/paper/demo/pdf/annotations",
    ]) {
      const refused = await send(app, "PUT", path, FOREIGN, "{}");
      expect([path, refused.status, refused.headers.get("Cache-Control")]).toEqual([
        path,
        403,
        "no-store",
      ]);
      expect(await refused.json()).toEqual(REJECTED);
    }
  });
});
