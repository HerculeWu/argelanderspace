import {
  type CopilotProvider,
  ProviderCredentialSchema,
  ProviderLoginAnswerSchema,
  ProviderModelConfigSchema,
} from "@argelanderspace/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ProtectedRoutes } from "./protected-app.js";
import { ProviderSettings, ProviderSettingsError } from "./providers.js";

export function mountProviderRoutes(
  host: ProtectedRoutes,
  injected: ProviderSettings | undefined,
  /** Called once per request: the judge of whether a new Copilot conversation on a model has room (the Copilot service's measure, its system occupancy read once for the request). Without it models carry no `fits`. */
  fits?: () => (model: { maxTokens: number; contextWindow: number }) => boolean
): void {
  let settings = injected;
  const get = () => (settings ??= new ProviderSettings());
  const app = new Hono();
  const prefix = "";
  const fitted = (provider: CopilotProvider): CopilotProvider =>
    fittedAll([provider])[0] ?? provider;
  const fittedAll = (providers: CopilotProvider[]): CopilotProvider[] => {
    const judge = fits?.();
    return judge
      ? providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({ ...model, fits: judge(model) })),
        }))
      : providers;
  };
  // Every method but GET is guarded where this router is mounted (protected-app.ts), before anything below.
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
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
  app.get("/", async (c) => c.json({ version: 1, providers: fittedAll(await get().list()) }));
  app.put(`${prefix}/:id/credential`, async (c) => {
    const body = ProviderCredentialSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ code: "invalid_credential", detail: "invalid credential input" }, 400);
    return c.json({
      saved: true,
      provider: fitted(await get().credential(c.req.param("id"), body.data.key)),
    });
  });
  app.delete(`${prefix}/:id/credential`, async (c) =>
    c.json({ saved: true, provider: fitted(await get().credential(c.req.param("id"), null)) })
  );
  app.put(`${prefix}/:id/config`, async (c) => {
    const body = ProviderModelConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json({ code: "invalid_config", detail: "invalid model configuration" }, 400);
    return c.json({
      saved: true,
      provider: fitted(await get().configure(c.req.param("id"), body.data)),
    });
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
    c.json({ saved: true, provider: fitted(await get().logout(c.req.param("id"))) })
  );
  host.mount("/api/copilot/providers", app, { guard: "non-GET", noStore: true });
}
