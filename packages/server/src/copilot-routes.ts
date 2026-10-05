import {
  COPILOT_ATTACHMENT_MAX_BYTES,
  ConversationModelSchema,
  CopilotConfirmationDecisionSchema,
  CopilotIdSchema,
  CopilotMessageRequestSchema,
  CopilotResumeRequestSchema,
  CopilotUndoRequestSchema,
  CopilotViewActionResultSchema,
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
  const jsonLimit = bodyLimit({
    maxSize: 8 * 1024 * 1024,
    onError: (c) =>
      c.json({ code: "capacity", detail: "page context too large", retryable: false }, 413),
  });
  const fileLimit = bodyLimit({
    maxSize: COPILOT_ATTACHMENT_MAX_BYTES,
    onError: (c) =>
      c.json({ code: "capacity", detail: "attachment too large", retryable: false }, 413),
  });
  // Attachments are raw file bytes with their own (PDF upload) bound; everything else is small JSON.
  app.use("*", (c, next) =>
    c.req.method === "POST" && /\/conversations\/[^/]+\/attachments$/.test(c.req.path)
      ? fileLimit(c, next)
      : jsonLimit(c, next)
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
          : ["capabilities", "capacity", "invalid_input"].includes(code)
            ? 400
            : code === "unreadable"
              ? 500
              : 503;
    return c.json(
      { code, detail: `copilot: ${code}`, retryable: !["not_found", "capacity"].includes(code) },
      status
    );
  });
  app.get("/conversations", async (c) => c.json(await copilot.list()));
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
  app.post("/views/:id/action-results", async (c) => {
    const result = CopilotViewActionResultSchema.safeParse(await c.req.json().catch(() => null));
    if (!result.success || !CopilotIdSchema.safeParse(c.req.param("id")).success)
      return c.json({ code: "invalid_input" }, 400);
    if (!copilot.resolveViewAction(c.req.param("id"), result.data))
      return c.json({ code: "not_found", detail: "copilot: not_found", retryable: false }, 404);
    return c.json({ saved: true });
  });
  app.post("/conversations/:id/messages", async (c) => {
    const input = CopilotMessageRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "invalid_input" }, 400);
    return c.json(await copilot.send(c.req.param("id"), input.data), 202);
  });
  // A file the user chose: raw bytes, the display name in X-Filename. The id is what a message (and then a tool) names.
  app.post("/conversations/:id/attachments", async (c) => {
    let filename: string;
    try {
      filename = decodeURIComponent(c.req.header("x-filename") ?? "");
    } catch {
      return c.json({ code: "invalid_input" }, 400);
    }
    const bytes = Buffer.from(await c.req.arrayBuffer());
    return c.json(
      await copilot.addAttachment(
        c.req.param("id"),
        filename,
        c.req.header("content-type") ?? "application/octet-stream",
        bytes
      ),
      201
    );
  });
  app.delete("/conversations/:id/attachments/:attachmentId", async (c) => {
    await copilot.removeAttachment(c.req.param("id"), c.req.param("attachmentId"));
    return c.json({ removed: true });
  });
  app.post("/conversations/:id/stop", async (c) => c.json(await copilot.stop(c.req.param("id"))));
  app.post("/conversations/:id/resume", async (c) => {
    const input = CopilotResumeRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "invalid_input" }, 400);
    return c.json(await copilot.resume(c.req.param("id"), input.data), 202);
  });
  // Only the real UI answers; the body repeats the object and version the card showed (a stale click is refused).
  app.post("/confirmations/:id", async (c) => {
    const input = CopilotConfirmationDecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success || !CopilotIdSchema.safeParse(c.req.param("id")).success)
      return c.json({ code: "invalid_input" }, 400);
    return c.json(await copilot.decide(c.req.param("id"), input.data));
  });
  app.post("/conversations/:id/operations/:toolCallId/undo", async (c) => {
    const input = CopilotUndoRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ code: "invalid_input" }, 400);
    return c.json(
      await copilot.undo(c.req.param("id"), c.req.param("toolCallId"), input.data.viewId)
    );
  });
  host.route("/api/copilot", app);
}
