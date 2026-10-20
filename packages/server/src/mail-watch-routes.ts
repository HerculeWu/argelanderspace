import type { MailWatcher } from "./mail-watch.js";
import type { ProtectedRoutes } from "./protected-app.js";

/**
 * Live-update endpoints of Mail (ticket 08), kept apart from `mail-routes.ts`.
 *
 * `GET /api/mail/unread` returns the sidebar badge numbers (INBOX unread per
 * account plus the watch state). A successful account change under
 * `/api/mail/accounts` also nudges the watcher to reconcile at once, so a
 * newly added account starts being watched without waiting for the next tick.
 * Without a watcher (tests, API-only embeddings) the summary is simply empty.
 */
export function mountMailWatchRoutes(
  host: ProtectedRoutes,
  watcher: MailWatcher | undefined
): void {
  const nudge = async (
    c: { req: { method: string }; res: { ok: boolean } },
    next: () => Promise<void>
  ) => {
    await next();
    if (c.req.method !== "GET" && c.res.ok) watcher?.reconcile();
  };
  host.use("/api/mail/accounts", nudge);
  host.use("/api/mail/accounts/*", nudge);
  host.get("/api/mail/unread", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json(watcher?.summary() ?? { version: 1, accounts: [], total: 0 });
  });
}
