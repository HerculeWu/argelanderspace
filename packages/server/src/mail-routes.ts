import {
  MAIL_PAGE_DEFAULT,
  MAIL_PRESETS,
  MailAccountCreateSchema,
  MailAccountTestSchema,
  MailAccountUpdateSchema,
  MailOpenRequestSchema,
  type MailPresetsResponse,
  type MailReadFailureCode,
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
import { MailAccountService, MailServiceError } from "./mail-accounts.js";
import { MailCache } from "./mail-cache.js";
import { type MailComposeServices, mountMailComposeRoutes } from "./mail-compose-routes.js";
import { MailReadError, MailReadService } from "./mail-read.js";

/** Production wiring of the reading service over the real global directories. */
export function createDefaultMailReadService(): MailReadService {
  return new MailReadService({
    accounts: createMailAccountStore(),
    credentials: createCredentialStore(),
    mailbox: createNodeMailMailbox(),
    cache: new MailCache(() => resolveGlobalDirs().cacheDir),
  });
}

const READ_STATUS: Record<MailReadFailureCode, 400 | 404 | 409 | 413 | 500 | 502> = {
  auth_failed: 502,
  host_not_found: 502,
  connection_refused: 502,
  timeout: 502,
  tls_failed: 502,
  starttls_unsupported: 502,
  protocol_error: 502,
  unknown: 502,
  folder_not_found: 404,
  message_not_found: 404,
  message_changed: 409,
  too_large: 413,
  credential_missing: 409,
  account_not_found: 404,
  invalid_input: 400,
  storage: 500,
};

const SAFE_INLINE_IMAGE = /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i;
const asciiName = (name: string) => name.replace(/[^\x20-\x7e]|["\\]/g, "_") || "attachment";

/** Production wiring over the real global directories, built on first use. */
export function createDefaultMailAccountService(): MailAccountService {
  return new MailAccountService({
    store: createMailAccountStore(),
    credentials: createCredentialStore(),
    protocol: createNodeMailProtocol(),
    cacheDir: () => resolveGlobalDirs().cacheDir,
  });
}

const STATUS = {
  invalid_input: 400,
  not_found: 404,
  rev_mismatch: 409,
  duplicate_address: 409,
  connection_failed: 422,
  keychain_unavailable: 422,
  credential_store_failed: 500,
} as const;

const DETAIL = {
  invalid_input: "invalid mail account input",
  not_found: "mail account not found",
  rev_mismatch: "mail accounts changed elsewhere; reload and retry",
  duplicate_address: "an account with this address already exists",
  connection_failed: "login test failed; nothing was saved",
  keychain_unavailable:
    "the OS keychain is unavailable; resend with fileFallbackConsent to store the password in a restricted file",
  credential_store_failed: "the credential could not be stored or removed",
} as const;

/** Only field NAMES from zod issues, never messages or values (a password could be among them). */
function invalid(issues: { path: PropertyKey[] }[]) {
  return {
    code: "invalid_input",
    detail: DETAIL.invalid_input,
    fields: [...new Set(issues.map((i) => i.path.map(String).join(".")))],
  };
}

export function mountMailRoutes(
  host: Hono,
  injected: MailAccountService | undefined,
  guardCsrf: (origin: string | undefined) => { body: { detail: string }; status: 403 } | null,
  injectedRead?: MailReadService,
  injectedCompose?: MailComposeServices
): void {
  // Writing and sending (ticket 07) has its own router, registered first so that its larger upload limit applies.
  mountMailComposeRoutes(host, injectedCompose, guardCsrf);
  let service = injected;
  const get = () => (service ??= createDefaultMailAccountService());
  let reader = injectedRead;
  const read = () => (reader ??= createDefaultMailReadService());
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET") {
      const blocked = guardCsrf(c.req.header("Origin"));
      if (blocked) return c.json(blocked.body, blocked.status);
    }
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
        READ_STATUS[error.code]
      );
    }
    if (error instanceof MailServiceError) {
      return c.json(
        { code: error.code, detail: DETAIL[error.code], ...error.extra },
        STATUS[error.code]
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
    if (!v || v.length > 1024 || [...v].some((ch) => ch.charCodeAt(0) < 32))
      throw new MailReadError("invalid_input");
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
  host.route("/api/mail", app);
}
