/**
 * Shutdown with connections that hold the server open (desktop-app ticket 31): a browser's pre-connected socket is
 * not an idle keep-alive connection, so Node's `server.close()` waits on it forever. The close must still finish
 * promptly, after the graceful steps ahead of it, for the project server and for the no-project (welcome) server.
 */

import { rmSync } from "node:fs";
import { createServer as createHttpServer, request, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HostBridge } from "../src/host-routes.js";
import { closeHttpServer } from "../src/http-close.js";
import { createNoProjectServer } from "../src/no-project.js";
import { createServer } from "../src/server.js";
import { isolatedGlobalDirs, makeDataDir, stubSources } from "./helpers.js";

const sockets: Socket[] = [];
const servers: Server[] = [];
let dataDir = "";

afterEach(() => {
  vi.useRealTimers();
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    s.close();
  }
  if (dataDir !== "") rmSync(dirname(dataDir), { recursive: true, force: true });
  dataDir = "";
});

async function idleSocket(port: number): Promise<{ ended: Promise<void> }> {
  const idle = connect(port, "127.0.0.1");
  sockets.push(idle);
  await new Promise<void>((r) => idle.once("connect", () => r()));
  return { ended: new Promise<void>((r) => idle.once("close", () => r())) };
}

async function closesWithin(close: Promise<void>, ms: number): Promise<string> {
  return Promise.race([
    close.then(() => "closed"),
    new Promise<string>((r) => setTimeout(() => r("hung"), ms)),
  ]);
}

describe("close() with connections that hold the server open", () => {
  test("the project server: a socket that never sent a request does not hold the close", async () => {
    dataDir = makeDataDir();
    const srv = createServer({
      globalDirs: isolatedGlobalDirs(),
      dataDir,
      port: 0,
      heartbeatMs: 0,
      webDist: null,
      deps: { makeSources: () => stubSources() },
      watchIntervalMs: 50,
    });
    const idle = await idleSocket(await srv.ready());
    expect(await closesWithin(srv.close(), 4000)).toBe("closed");
    await idle.ended;
  }, 10_000);

  test("the no-project server: a socket that never sent a request does not hold the close", async () => {
    const srv = createNoProjectServer({
      host: { usePages: () => {} } as unknown as HostBridge,
      globalDirs: isolatedGlobalDirs(),
      heartbeatMs: 0,
      webDist: null,
    });
    const idle = await idleSocket(await srv.ready());
    expect(await closesWithin(srv.close(), 4000)).toBe("closed");
    await idle.ended;
  }, 10_000);
});

async function listen(
  handler: Parameters<typeof createHttpServer>[1]
): Promise<{ server: Server; port: number }> {
  const server = createHttpServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  return { server, port: typeof addr === "object" && addr !== null ? addr.port : 0 };
}

function get(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    request({ port, host: "127.0.0.1", path: "/", agent: false }, (res) => {
      let body = "";
      res.on("data", (d) => {
        body += d;
      });
      res.on("end", () => resolve(body));
      res.on("error", reject);
    })
      .on("error", reject)
      .end();
  });
}

describe("closeHttpServer", () => {
  test("a request that finishes within the grace is answered, not cut off", async () => {
    const { server, port } = await listen((_req, res) => {
      setTimeout(() => res.end("done"), 200);
    });
    const answer = get(port);
    await new Promise((r) => setTimeout(r, 50)); // the request is in flight
    await closeHttpServer(server, 3000);
    expect(await answer).toBe("done");
  });

  test("a request still running past the grace is cut off", async () => {
    const { server, port } = await listen(() => {
      /* never answers */
    });
    const answer = get(port).then(
      () => "answered",
      () => "cut"
    );
    await new Promise((r) => setTimeout(r, 50));
    await closeHttpServer(server, 100);
    expect(await answer).toBe("cut");
  });

  test("the cutoff timer is cleared once the close finished", async () => {
    const { server } = await listen((_req, res) => res.end("ok"));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await closeHttpServer(server, 2000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
