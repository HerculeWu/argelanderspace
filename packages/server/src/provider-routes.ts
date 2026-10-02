import {
  ProviderCredentialSchema,
  ProviderLoginAnswerSchema,
  ProviderModelConfigSchema,
} from "@argelanderspace/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ProviderSettings, ProviderSettingsError } from "./providers.js";

export function mountProviderRoutes(
  host: Hono,
  injected: ProviderSettings | undefined,
  guardCsrf: (origin: string | undefined) => { body: { detail: string }; status: 403 } | null
): void {
  let settings = injected;
  const get = () => (settings ??= new ProviderSettings());
  const app = new Hono();
  const prefix = "";
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET") {
      const blocked = guardCsrf(c.req.header("Origin"));
      if (blocked) return c.json(blocked.body, blocked.status);
    }
    await next();
  });
  app.onError((error, c) => {
    const code = error instanceof ProviderSettingsError ? error.code : "storage";
    return c.json(
      { code, detail: `provider settings: ${code}`, retryable: true },
      code === "not_found"
        ? 404
        : code === "busy" || code === "stale"
          ? 409
          : ["capabilities", "invalid_config", "unsupported", "invalid_input"].includes(code)
            ? 400
            : 503
    );
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 128 * 1024,
      onError: (c) => c.json({ code: "invalid_input", detail: "provider request too large" }, 413),
    })
  );
  app.get("/", async (c) => c.json({ version: 1, providers: await get().list() }));
  app.put(`${prefix}/:id/credential`, async (c) => {
    const body = ProviderCredentialSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ code: "invalid_credential", detail: "invalid credential input" }, 400);
    return c.json({
      saved: true,
      provider: await get().credential(c.req.param("id"), body.data.key),
    });
  });
  app.delete(`${prefix}/:id/credential`, async (c) =>
    c.json({ saved: true, provider: await get().credential(c.req.param("id"), null) })
  );
  app.put(`${prefix}/:id/config`, async (c) => {
    const body = ProviderModelConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ code: "invalid_config", detail: "invalid model configuration" }, 400);
    return c.json({ saved: true, provider: await get().configure(c.req.param("id"), body.data) });
  });
  app.post(`${prefix}/:id/test`, async (c) => {
    const body = ProviderModelConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ code: "invalid_config", detail: "invalid model configuration" }, 400);
    return c.json(await get().test(c.req.param("id"), body.data, c.req.raw.signal));
  });
  // Login: secrets (pasted authorization code) only travel body -> SDK, never into any DTO.
  app.post(`${prefix}/:id/login`, async (c) =>
    c.json({ login: await get().startLogin(c.req.param("id")) }, 201)
  );
  app.get(`${prefix}/:id/login/:loginId`, async (c) =>
    c.json({ login: await get().getLogin(c.req.param("id"), c.req.param("loginId")) })
  );
  app.delete(`${prefix}/:id/login/:loginId`, async (c) =>
    c.json({ login: await get().cancelLogin(c.req.param("id"), c.req.param("loginId")) })
  );
  app.post(`${prefix}/:id/login/:loginId/response`, async (c) => {
    const body = ProviderLoginAnswerSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ code: "invalid_input", detail: "invalid login response" }, 400);
    return c.json({
      login: await get().answerLogin(
        c.req.param("id"),
        c.req.param("loginId"),
        body.data.challengeId,
        body.data.value
      ),
    });
  });
  app.post(`${prefix}/:id/logout`, async (c) =>
    c.json({ saved: true, provider: await get().logout(c.req.param("id")) })
  );
  host.route("/api/copilot/providers", app);
}
