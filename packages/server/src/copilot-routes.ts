import {
  ConversationModelSchema,
  CopilotIdSchema,
  CopilotMessageRequestSchema,
  PageContextSchema,
} from "@argelanderspace/contracts";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CopilotError, type CopilotHost } from "./copilot.js";
import { ProviderSettingsError } from "./providers.js";

export function mountCopilotRoutes(
  host: Hono,
  copilot: CopilotHost,
  guard: (origin: string | undefined) => { body: { detail: string }; status: 403 } | null
): void {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.method !== "GET") {
      const denied = guard(c.req.header("Origin"));
      if (denied) return c.json(denied.body, denied.status);
    }
    await next();
  });
  app.use(
    "*",
    bodyLimit({
      maxSize: 8 * 1024 * 1024,
      onError: (c) =>
        c.json({ code: "capacity", detail: "page context too large", retryable: false }, 413),
    })
  );
  app.onError((error, c) => {
    const code =
      error instanceof CopilotError
        ? error.code
        : error instanceof ProviderSettingsError
          ? ["capabilities", "not_found"].includes(error.code)
            ? "capabilities"
            : "unavailable"
          : "storage";
    const status =
      code === "not_found"
        ? 404
        : ["busy", "stale"].includes(code)
          ? 409
          : ["capabilities", "capacity"].includes(code)
            ? 400
            : 503;
    return c.json(
      { code, detail: `copilot: ${code}`, retryable: !["not_found", "capacity"].includes(code) },
      status
    );
  });
  app.get("/conversations", async (c) =>
    c.json({ version: 1, conversations: await copilot.list() })
  );
  app.post("/conversations", async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (
      !raw ||
      typeof raw !== "object" ||
      !Object.hasOwn(raw, "model") ||
      Object.keys(raw).length !== 1
    )
      return c.json({ code: "invalid_input" }, 400);
    const model = raw.model === null ? null : ConversationModelSchema.safeParse(raw.model);
    if (model !== null && !model.success) return c.json({ code: "invalid_input" }, 400);
    return c.json(await copilot.create(model === null ? null : model.data), 201);
  });
  app.get("/conversations/:id", async (c) => c.json(await copilot.snapshot(c.req.param("id"))));
  app.put("/conversations/:id/model", async (c) => {
    const choice = ConversationModelSchema.safeParse(await c.req.json().catch(() => null));
    if (!choice.success) return c.json({ code: "invalid_input" }, 400);
    return c.json(await copilot.selectModel(c.req.param("id"), choice.data));
  });
  app.put("/views/:id", async (c) => {
    const view = PageContextSchema.safeParse(await c.req.json().catch(() => null));
    if (
      !view.success ||
      !CopilotIdSchema.safeParse(c.req.param("id")).success ||
      view.data.viewId !== c.req.param("id")
    )
      return c.json({ code: "invalid_input" }, 400);
    copilot.publish(view.data);
    return c.json({ saved: true });
  });
  app.post("/conversations/:id/messages", async (c) => {
    const input = CopilotMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "invalid_input" }, 400);
    return c.json(await copilot.send(c.req.param("id"), input.data), 202);
  });
  host.route("/api/copilot", app);
}
