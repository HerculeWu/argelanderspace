/**
 * HTTP routes of mail management and search (Mail ticket 06), mounted under
 * /api/mail by mail-routes.ts, which already applies no-store and the body
 * limit (the CSRF guard of the prefix comes first, where it is mounted: protected-app.ts). Each route answers only after the IMAP server did. Error bodies carry
 * a fixed text per code: server responses and mail content never reach them.
 * Failures that are not management failures (unknown account, missing
 * credential, ...) are rethrown to the parent's error handler.
 */

import {
  MailDeleteRequestSchema,
  MailFlagRequestSchema,
  MailMoveRequestSchema,
  MailSearchRequestSchema,
} from "@argelanderspace/contracts";
import type { Context, Hono } from "hono";
import { mailHttpStatus } from "./mail-failures.js";
import { MailManageError, type MailManageService } from "./mail-manage.js";

/** Only field NAMES from zod issues, never messages or values. */
function invalid(c: Context, issues: { path: PropertyKey[] }[]) {
  return c.json(
    {
      code: "invalid_input",
      detail: "invalid mail request",
      fields: [...new Set(issues.map((i) => i.path.map(String).join(".")))],
    },
    400
  );
}

export function mountMailManageRoutes(app: Hono, service: () => MailManageService): void {
  /** Run one operation; a management failure becomes its fixed-text error body. */
  const guarded = async (c: Context, run: () => Promise<unknown>) => {
    try {
      return c.json(await run());
    } catch (error) {
      if (!(error instanceof MailManageError)) throw error;
      return c.json(
        { code: error.code, detail: `mail request failed: ${error.code}` },
        mailHttpStatus(error.code)
      );
    }
  };
  const id = (c: Context) => c.req.param("id") ?? "";

  app.post("/accounts/:id/messages/flag", async (c) => {
    const body = MailFlagRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error?.issues ?? []);
    return guarded(c, () => service().flag(id(c), body.data));
  });
  app.post("/accounts/:id/messages/move", async (c) => {
    const body = MailMoveRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error?.issues ?? []);
    return guarded(c, () => service().move(id(c), body.data));
  });
  app.post("/accounts/:id/messages/delete", async (c) => {
    const body = MailDeleteRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error?.issues ?? []);
    return guarded(c, () => service().remove(id(c), body.data));
  });
  // POST: the criteria are user text that must not end up in URLs or access logs.
  app.post("/accounts/:id/messages/search", async (c) => {
    const body = MailSearchRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c, body.error?.issues ?? []);
    return guarded(c, () => service().search(id(c), body.data));
  });
}
