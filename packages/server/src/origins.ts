/**
 * The origins a browser page may call this server from with a mutation or a WebSocket upgrade: the Vite dev server,
 * and the page the server itself serves on the port it is bound to. Shared by the REST CSRF guard (`app.ts`) and
 * the WebSocket upgrade check (`ws.ts`).
 */

/** The Vite dev server (`packages/web/vite.config.ts`), which proxies to this server and may call it directly. */
export const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;

/** The origins of the page a server bound to `port` on this machine serves. */
export function ownOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}
