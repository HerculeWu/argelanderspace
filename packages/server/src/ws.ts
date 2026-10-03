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
import {
  CopilotSubscriptionSchema,
  type Job,
  type WsCopilotViewAction,
  type WsServerMessage,
} from "@argelanderspace/contracts";
import { WebSocket, WebSocketServer } from "ws";

export interface WsHubOptions {
  /** Upgrade path (default `/ws`); any other upgrade request is refused. */
  path?: string;
  /** Ping interval in ms (default 30s); `0` disables (tests). */
  heartbeatMs?: number;
  /** The `hello` snapshot payload (the runner's job table). */
  snapshot?: () => Job[];
  /** A socket registered a Copilot view id: lets the host deliver view actions that waited for it. */
  onViewSubscribed?: (viewId: string) => void;
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
      if (req.headers.origin !== undefined) {
        const address = server.address();
        const port = address && typeof address === "object" ? address.port : 8000;
        const origins = new Set([
          "http://localhost:5173",
          "http://127.0.0.1:5173",
          `http://localhost:${port}`,
          `http://127.0.0.1:${port}`,
        ]);
        if (!origins.has(req.headers.origin)) {
          socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
    this.wss.on("connection", (ws: WebSocket) => {
      subscriptions.set(ws, new Set());
      viewIds.set(ws, new Map());
      alive.set(ws, true);
      ws.on("pong", () => alive.set(ws, true));
      if (opts.snapshot) {
        ws.send(JSON.stringify({ type: "hello", jobs: opts.snapshot() }));
      }
      ws.on("message", (bytes) => {
        if (
          (Array.isArray(bytes)
            ? bytes.reduce((sum, part) => sum + part.length, 0)
            : bytes.byteLength) > 2048
        )
          return;
        let raw: unknown;
        try {
          raw = JSON.parse(bytes.toString());
        } catch {
          return;
        }
        const parsed = CopilotSubscriptionSchema.safeParse(raw);
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === "copilot.subscribe") {
          subscriptions.get(ws)?.add(message.conversationId);
          viewIds.get(ws)?.set(message.conversationId, message.viewId);
          ws.send(
            JSON.stringify({
              type: "copilot.subscribed",
              conversationId: message.conversationId,
              viewId: message.viewId,
            })
          );
          opts.onViewSubscribed?.(message.viewId);
        } else {
          subscriptions.get(ws)?.delete(message.conversationId);
          viewIds.get(ws)?.delete(message.conversationId);
        }
      });
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
      if (msg.type === "copilot.event" && !subscriptions.get(ws)?.has(msg.conversationId)) continue;
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  /**
   * Deliver a targeted view action to the sockets that registered exactly this view id.
   * Returns whether any socket received it; never broadcasts to other views.
   */
  sendToView(viewId: string, msg: WsCopilotViewAction): boolean {
    const data = JSON.stringify(msg);
    let delivered = false;
    for (const ws of this.wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (![...(viewIds.get(ws)?.values() ?? [])].includes(viewId)) continue;
      ws.send(data);
      delivered = true;
    }
    return delivered;
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
const subscriptions = new WeakMap<WebSocket, Set<string>>();
/** conversationId → the view id this socket registered for it. */
const viewIds = new WeakMap<WebSocket, Map<string, string>>();
