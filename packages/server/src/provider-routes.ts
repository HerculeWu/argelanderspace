import { ProviderCredentialSchema, ProviderModelConfigSchema } from "@argelanderspace/contracts";
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
        : code === "capabilities" || code === "invalid_config" || code === "unsupported"
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
  host.route("/api/copilot/providers", app);
}
