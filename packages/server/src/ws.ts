/**
 * The `/ws` WebSocket hub (decision 14: full-duplex WS, not SSE — the duplex
 * half is reserved for Stage-2 agent interaction; today all frames are
 * server → client JSON).
 *
 * Every client receives, in order: a `hello` snapshot of the job table on
 * connect, then every job transition (`job.created|progress|done|failed`
 * carrying the full job record), `library.changed`, and `plan.changed`
 * (Stage 4) as they happen.
 * Heartbeat is protocol-level ping/pong: the server pings every
 * `heartbeatMs` and terminates clients that miss a pong.
 */

import type { Server } from "node:http";
import type { Job, WsServerMessage } from "@argelanderspace/contracts";
import { WebSocket, WebSocketServer } from "ws";

export interface WsHubOptions {
  /** Upgrade path (default `/ws`); any other upgrade request is refused. */
  path?: string;
  /** Ping interval in ms (default 30s); `0` disables (tests). */
  heartbeatMs?: number;
  /** The `hello` snapshot payload (the runner's job table). */
  snapshot?: () => Job[];
}

export class WsHub {
  private readonly wss = new WebSocketServer({ noServer: true });
  private readonly timer: NodeJS.Timeout | null = null;

  constructor(server: Server, opts: WsHubOptions = {}) {
    const path = opts.path ?? "/ws";
    server.on("upgrade", (req, socket, head) => {
      let pathname: string | null = null;
      try {
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        pathname = null;
      }
      if (pathname !== path) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
    this.wss.on("connection", (ws: WebSocket) => {
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      if (opts.snapshot) {
        ws.send(JSON.stringify({ type: "hello", jobs: opts.snapshot() }));
      }
    });
    const heartbeatMs = opts.heartbeatMs ?? 30_000;
    if (heartbeatMs > 0) {
      this.timer = setInterval(() => {
        for (const ws of this.wss.clients) {
          if (alive.get(ws) === false) {
            ws.terminate();
            continue;
          }
          alive.set(ws, false);
          ws.ping();
        }
      }, heartbeatMs);
      this.timer.unref();
    }
  }

  /** JSON-serialize once, send to every open client. */
  broadcast(msg: WsServerMessage): void {
    const data = JSON.stringify(msg);
    for (const ws of this.wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }
}

/** Per-socket liveness for the heartbeat (avoids an expansion cast). */
const alive = new WeakMap<WebSocket, boolean>();
