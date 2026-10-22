/**
 * Closing the node http server on shutdown (desktop-app ticket 31), shared by the project server and the no-project
 * (welcome-state) server.
 *
 * `server.close()` stops listening and then waits for every connection to end, but Node only closes keep-alive
 * connections that are idle after a request: a socket that has not sent one yet (a browser's pre-connected socket)
 * would hold the shutdown. Idle connections go at once; a request still in flight gets {@link CLOSE_GRACE_MS}, then
 * the rest are cut, so the port and the process are released in bounded time.
 */

import type { Server } from "node:http";

/** How long a request still in flight may finish after the server stopped listening, before its connection is cut. */
export const CLOSE_GRACE_MS = 2000;

/** `serve` without http2 options returns a node http/1 Server; `ServerType`'s union cannot say so statically. */
export function closeHttpServer(server: object, graceMs: number = CLOSE_GRACE_MS): Promise<void> {
  const http1 = server as Server;
  return new Promise((resolve, reject) => {
    const cutoff: NodeJS.Timeout = setTimeout(() => http1.closeAllConnections(), graceMs);
    cutoff.unref();
    http1.close((err) => {
      clearTimeout(cutoff);
      if (err) reject(err);
      else resolve();
    });
    http1.closeIdleConnections();
  });
}
