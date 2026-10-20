import {
  isMailFolderPath,
  MAIL_PAGE_DEFAULT,
  MAIL_PRESETS,
  MailAccountCreateSchema,
  MailAccountTestSchema,
  MailAccountUpdateSchema,
  MailOpenRequestSchema,
  type MailPresetsResponse,
} from "@argelanderspace/contracts";
import {
  createCredentialStore,
  createMailAccountStore,
  createNodeMailMailbox,
  createNodeMailProtocol,
  resolveGlobalDirs,
} from "@argelanderspace/infra";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type ServerLog, silentLog } from "./log.js";
import { observedCredentials, observedMail } from "./log-observers.js";
import { MailAccountService, MailServiceError } from "./mail-accounts.js";
import { MailCache } from "./mail-cache.js";
import { type MailComposeServices, mountMailComposeRoutes } from "./mail-compose-routes.js";
import type { MailOpDeps } from "./mail-copilot.js";
import { mailAccountDetail, mailHttpStatus } from "./mail-failures.js";
import { createDefaultMailManageService, type MailManageService } from "./mail-manage.js";
import { mountMailManageRoutes } from "./mail-manage-routes.js";
import { MailReadError, MailReadService } from "./mail-read.js";
import type { ProtectedRoutes } from "./protected-app.js";

/** Production wiring of the reading service over the real global directories. */
export function createDefaultMailReadService(log: ServerLog = silentLog): MailReadService {
  return new MailReadService({
    accounts: createMailAccountStore(),
    credentials: observedCredentials(createCredentialStore(), log),
    mailbox: observedMail(createNodeMailMailbox(), log),
    cache: new MailCache(() => resolveGlobalDirs().cacheDir),
  });
}

const SAFE_INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment";

/** Production wiring over the real global directories, built on first use. */
export function createDefaultMailAccountService(log: ServerLog = silentLog): MailAccountService {
  return new MailAccountService({
    store: createMailAccountStore(),
    credentials: observedCredentials(createCredentialStore(), log),
    protocol: observedMail(createNodeMailProtocol(), log),
    cacheDir: () => resolveGlobalDirs().cacheDir,
  });
}

/** Only field NAMES from zod issues, never messages or values (a password could be among them). */
function invalid(issues: { path: PropertyKey[] }[]) {
  return {
    code: "invalid_input",
    detail: mailAccountDetail("invalid_input"),
    fields: [...new Set(issues.map((i) => i.path.map(String).join(".")))],
  };
}

export function mountMailRoutes(
  host: ProtectedRoutes,
  injected: MailAccountService | undefined,
  injectedRead?: MailReadService,
  injectedManage?: MailManageService,
  injectedCompose?: MailComposeServices,
  /** The user-level log the services built HERE record their mail-server calls in; injected services bring their own. */
  log: ServerLog = silentLog
): MailOpDeps {
  // Writing and sending (ticket 07) has its own router, registered first so that its larger upload limit applies.
  const compose = mountMailComposeRoutes(host, injectedCompose, log);
  let service = injected;
  const get = () => (service ??= createDefaultMailAccountService(log));
  let reader = injectedRead;
  const read = () => (reader ??= createDefaultMailReadService(log));
  let manager = injectedManage;
  const manage = () => (manager ??= createDefaultMailManageService(read(), log));
  const app = new Hono();
  // Every method but GET is guarded where this router is mounted (protected-app.ts), before anything below.
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => c.json({ code: "invalid_input", detail: "mail request too large" }, 413),
    })
  );
  app.onError((error, c) => {
    if (error instanceof MailReadError) {
      // Fixed text per code; server responses and mail content never reach an error body.
      return c.json(
        { code: error.code, detail: `mail request failed: ${error.code}` },
        mailHttpStatus(error.code)
      );
    }
    if (error instanceof MailServiceError) {
      return c.json(
        { code: error.code, detail: mailAccountDetail(error.code), ...error.extra },
        mailHttpStatus(error.code)
      );
    }
    // Anything else (unreadable store, bad global dir config, ...): fixed text, no error message.
    return c.json({ code: "storage", detail: "mail account storage failed" }, 500);
  });

  app.get("/presets", (c) => {
    const body: MailPresetsResponse = {
      version: 1,
      presets: Object.values(MAIL_PRESETS).map((p) => ({
        id: p.id,
        imap: p.imap,
        smtp: p.smtp,
        appPassword: p.appPassword,
      })),
    };
    return c.json(body);
  });
  app.get("/accounts", (c) => c.json(get().list()));
  app.post("/accounts/test", async (c) => {
    const body = MailAccountTestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await get().test(body.data));
  });
  app.post("/accounts", async (c) => {
    const body = MailAccountCreateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await get().create(body.data), 201);
  });
  app.put("/accounts/:id", async (c) => {
    const body = MailAccountUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await get().update(c.req.param("id"), body.data));
  });
  app.delete("/accounts/:id", async (c) => {
    const rev = Number(c.req.query("rev"));
    if (!Number.isInteger(rev) || rev < 0) return c.json(invalid([{ path: ["rev"] }]), 400);
    return c.json(await get().remove(c.req.param("id"), rev));
  });

  // ---- reading (ticket 05) --------------------------------------------------
  const folderParam = (v: string | undefined) => {
    if (!v || !isMailFolderPath(v)) throw new MailReadError("invalid_input");
    return v;
  };
  const intParam = (v: string | undefined, min: number, required: boolean) => {
    if (v === undefined || v === "") {
      if (required) throw new MailReadError("invalid_input");
      return undefined;
    }
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < min) throw new MailReadError("invalid_input");
    return n;
  };
  app.get("/accounts/:id/folders", async (c) => c.json(await read().folders(c.req.param("id"))));
  app.get("/accounts/:id/messages", async (c) => {
    const folder = folderParam(c.req.query("folder"));
    const before = intParam(c.req.query("before"), 1, false);
    const limit = intParam(c.req.query("limit"), 1, false) ?? MAIL_PAGE_DEFAULT;
    return c.json(await read().headers(c.req.param("id"), folder, before, limit));
  });
  // POST because opening a message sets \Seen on the server (a state change).
  app.post("/accounts/:id/messages/open", async (c) => {
    const body = MailOpenRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(invalid(body.error.issues), 400);
    return c.json(await read().open(c.req.param("id"), body.data));
  });
  app.get("/accounts/:id/attachment", async (c) => {
    const folder = folderParam(c.req.query("folder"));
    const uid = intParam(c.req.query("uid"), 1, true) as number;
    const part = intParam(c.req.query("part"), 0, true) as number;
    const uidValidity = intParam(c.req.query("uidValidity"), 0, false);
    const a = await read().attachment(c.req.param("id"), { folder, uid, uidValidity, part });
    // Mail content is hostile: never let the browser interpret it. Only a few raster
    // image types are served as images (for cid: references); everything else downloads.
    const inlineImage = c.req.query("inline") === "1" && SAFE_INLINE_IMAGE.test(a.contentType);
    c.header(
      "Content-Type",
      inlineImage ? a.contentType.toLowerCase() : "application/octet-stream"
    );
    c.header(
      "Content-Disposition",
      `${inlineImage ? "inline" : "attachment"}; filename="${asciiName(a.filename)}"; filename*=UTF-8''${encodeURIComponent(a.filename || "attachment").replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`
    );
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "sandbox; default-src 'none'");
    c.header("Content-Length", String(a.content.byteLength));
    return c.body(a.content as unknown as ArrayBuffer);
  });
  // ---- managing and searching (ticket 06) ----------------------------------
  mountMailManageRoutes(app, manage);
  host.mount("/api/mail", app, { guard: "non-GET", noStore: true });
  // The Copilot's mail tool (ticket 09) uses these very services, so there is one send path and one cache.
  return { accounts: get, read, manage, services: compose };
}
