/**
 * REST routes of writing and sending mail (Mail ticket 07), mounted at /api/mail/compose (before the
 * main mail router, so its 64 KiB body limit does not apply to uploads). Error bodies carry a fixed
 * code and fixed text only: never recipients, subjects, bodies, file names or server text.
 */

import {
  MAIL_ACCOUNT_ID_PATTERN,
  MAIL_ATTACHMENT_MAX_BYTES,
  MAIL_SEND_ID_PATTERN,
  MAIL_STAGED_ID_PATTERN,
  MailComposeDraftSchema,
  MailComposeInitRequestSchema,
  MailSendRequestSchema,
} from "@argelanderspace/contracts";
import {
  createCredentialStore,
  createMailAccountStore,
  createNodeMailMailbox,
  createNodeMailOutgoing,
  resolveGlobalDirs,
} from "@argelanderspace/infra";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type ServerLog, silentLog } from "./log.js";
import { observedCredentials, observedMail } from "./log-observers.js";
import { MailComposeError, MailComposeService } from "./mail-compose.js";
import { mailHttpStatus } from "./mail-failures.js";
import { MailOutbox } from "./mail-outbox.js";
import { MailSendService } from "./mail-send.js";
import type { ProtectedRoutes } from "./protected-app.js";

export interface MailComposeServices {
  compose: MailComposeService;
  send: MailSendService;
}

/** Production wiring over the real global directories. */
export function createDefaultMailComposeServices(log: ServerLog = silentLog): MailComposeServices {
  const cacheDir = () => resolveGlobalDirs().cacheDir;
  const outgoing = observedMail(createNodeMailOutgoing(), log);
  const compose = new MailComposeService({
    accounts: createMailAccountStore(),
    credentials: observedCredentials(createCredentialStore(), log),
    mailbox: observedMail(createNodeMailMailbox(), log),
    outgoing,
    cacheDir,
  });
  return {
    compose,
    send: new MailSendService({
      compose,
      outgoing,
      outbox: new MailOutbox(cacheDir),
      registerForShutdown: true,
    }),
  };
}

export function mountMailComposeRoutes(
  host: ProtectedRoutes,
  injected: MailComposeServices | undefined,
  log: ServerLog = silentLog
): () => MailComposeServices {
  let services = injected;
  const svc = () => (services ??= createDefaultMailComposeServices(log));
  const app = new Hono();
  // Every method but GET is guarded where this router is mounted (protected-app.ts), before anything below.
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  const tooLarge = (c: import("hono").Context) =>
    c.json({ code: "invalid_input", detail: "mail request too large" }, 413);
  const jsonLimit = bodyLimit({ maxSize: 8 * 1024 * 1024, onError: tooLarge });
  const uploadLimit = bodyLimit({ maxSize: MAIL_ATTACHMENT_MAX_BYTES + 1024, onError: tooLarge });
  app.onError((error, c) => {
    if (error instanceof MailComposeError)
      return c.json(
        { code: error.code, detail: `mail request failed: ${error.code}` },
        mailHttpStatus(error.code)
      );
    return c.json({ code: "storage", detail: "mail storage failed" }, 500);
  });

  const accountId = (v: string | undefined) => {
    if (!v || !MAIL_ACCOUNT_ID_PATTERN.test(v)) throw new MailComposeError("invalid_input");
    return v;
  };
  const sendId = (v: string | undefined) => {
    if (!v || !MAIL_SEND_ID_PATTERN.test(v)) throw new MailComposeError("invalid_input");
    return v;
  };
  const invalid = (c: import("hono").Context) =>
    c.json({ code: "invalid_input", detail: "invalid mail request" }, 400);

  // ---- attachments --------------------------------------------------------------
  app.post("/accounts/:id/attachments", uploadLimit, async (c) => {
    const id = accountId(c.req.param("id"));
    let filename = "attachment";
    try {
      filename = decodeURIComponent(c.req.header("X-Mail-Filename") ?? "") || "attachment";
    } catch {
      /* keep the default */
    }
    const body = new Uint8Array(await c.req.arrayBuffer());
    const staged = svc().compose.stage(id, filename, c.req.header("Content-Type") ?? "", body);
    return c.json(staged, 201);
  });
  app.delete("/accounts/:id/attachments/:att", (c) => {
    const att = c.req.param("att");
    if (!MAIL_STAGED_ID_PATTERN.test(att)) return invalid(c);
    svc().compose.deleteStaged(accountId(c.req.param("id")), [att]);
    return c.json({ ok: true });
  });

  // ---- initial content for reply / forward / editing a draft --------------------------
  app.post("/accounts/:id/init", jsonLimit, async (c) => {
    const body = MailComposeInitRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    return c.json(await svc().compose.init(accountId(c.req.param("id")), body.data));
  });

  // ---- drafts ------------------------------------------------------------------------
  app.put("/accounts/:id/draft", jsonLimit, async (c) => {
    const body = MailComposeDraftSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    return c.json(await svc().compose.saveDraft(accountId(c.req.param("id")), body.data));
  });
  app.post("/accounts/:id/draft/discard", jsonLimit, async (c) => {
    const body = MailComposeDraftSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    await svc().compose.discardDraft(
      accountId(c.req.param("id")),
      body.data.messageId,
      body.data.attachments
    );
    return c.json({ ok: true });
  });

  // ---- sending -------------------------------------------------------------------------
  app.post("/accounts/:id/send", jsonLimit, async (c) => {
    const body = MailSendRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return invalid(c);
    return c.json(
      await svc().send.start(accountId(c.req.param("id")), { ...body.data, origin: "mail" }),
      202
    );
  });
  app.get("/accounts/:id/sends/:sendId", (c) =>
    c.json(svc().send.status(accountId(c.req.param("id")), sendId(c.req.param("sendId"))))
  );
  app.post("/accounts/:id/sends/:sendId/undo", (c) =>
    c.json(svc().send.cancel(accountId(c.req.param("id")), sendId(c.req.param("sendId"))))
  );
  app.delete("/accounts/:id/sends/:sendId", (c) => {
    svc().send.dismiss(accountId(c.req.param("id")), sendId(c.req.param("sendId")));
    return c.json({ ok: true });
  });
  app.get("/outbox", (c) => c.json({ sends: svc().send.list() }));

  host.mount("/api/mail/compose", app, { guard: "non-GET", noStore: true });
  return svc;
}
