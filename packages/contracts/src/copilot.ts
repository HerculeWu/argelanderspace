import { z } from "zod";
import { PlanSchema, TaskSchema } from "./plans.js";
import { ThinkingLevelSchema } from "./providers.js";

export const CopilotIdSchema = z.string().uuid();
export const ConversationModelSchema = z
  .object({
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    thinking: ThinkingLevelSchema.nullable(),
  })
  .strict();
export type ConversationModel = z.infer<typeof ConversationModelSchema>;

export const PlanPageSchema = z
  .object({
    rev: z.number().int().nonnegative(),
    mode: z.enum(["list", "board", "focus", "timeline"]),
    selectedPlanId: z.string().nullable(),
    plans: z.array(PlanSchema),
    groups: z.array(z.object({ key: z.string(), taskIds: z.array(z.string()) }).strict()),
    detail: z.object({ planId: z.string(), task: TaskSchema }).strict().nullable(),
    saveState: z.enum(["saved", "pending", "error"]),
    ui: z
      .object({
        completedExpanded: z.boolean(),
        readingPosition: z
          .object({
            region: z.string(),
            top: z.number().nonnegative(),
            left: z.number().nonnegative(),
          })
          .nullable(),
        selectedText: z.string().nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PlanPage = z.infer<typeof PlanPageSchema>;

export const PageContextSchema = z
  .object({
    version: z.literal(1),
    viewId: CopilotIdSchema,
    revision: z.number().int().nonnegative(),
    paneId: z.number().int().positive(),
    view: z.string().min(1).max(100),
    otherPanes: z
      .array(z.object({ paneId: z.number().int().positive(), view: z.string() }).strict())
      .max(2),
    status: z.enum(["complete", "unavailable", "error"]),
    plan: PlanPageSchema.nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.status === "complete") !== (value.view === "plan" && value.plan !== null))
      ctx.addIssue({ code: "custom", message: "invalid page coverage" });
  });
export type PageContext = z.infer<typeof PageContextSchema>;
export const CopilotMessageRequestSchema = z
  .object({
    clientMessageId: CopilotIdSchema,
    text: z
      .string()
      .min(1)
      .max(100_000)
      .refine((text) => !!text.trim()),
    viewId: CopilotIdSchema,
    contextRevision: z.number().int().nonnegative(),
  })
  .strict();
export type CopilotMessageRequest = z.infer<typeof CopilotMessageRequestSchema>;

export const EventCursorSchema = z
  .object({ instanceId: CopilotIdSchema, seq: z.number().int().nonnegative() })
  .strict();
export type EventCursor = z.infer<typeof EventCursorSchema>;
export const CopilotRunSchema = z
  .object({
    id: CopilotIdSchema,
    status: z.enum(["running", "completed", "failed", "interrupted"]),
    error: z.string().nullable(),
  })
  .strict();
export type CopilotRun = z.infer<typeof CopilotRunSchema>;
export const ConversationSchema = z
  .object({
    version: z.literal(1),
    id: CopilotIdSchema,
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    model: ConversationModelSchema.nullable(),
    sessionId: CopilotIdSchema,
    run: CopilotRunSchema.nullable(),
  })
  .strict();
export type Conversation = z.infer<typeof ConversationSchema>;
export interface CopilotMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  context?: {
    contextId: string;
    view: string;
    status: PageContext["status"];
    revision: number;
    objects: { id: string; rev: number; name?: string }[];
  };
}
export interface ConversationSnapshot {
  version: 1;
  conversation: Conversation;
  messages: CopilotMessage[];
  stream: string;
  eventCursor: EventCursor;
}
export const WsCopilotEventSchema = z
  .object({
    type: z.literal("copilot.event"),
    conversationId: CopilotIdSchema,
    runId: CopilotIdSchema.nullable(),
    eventCursor: EventCursorSchema,
    kind: z.enum(["stream", "changed"]),
    text: z.string().optional(),
  })
  .strict();
export type WsCopilotEvent = z.infer<typeof WsCopilotEventSchema>;
export const CopilotSubscriptionSchema = z
  .object({
    type: z.enum(["copilot.subscribe", "copilot.unsubscribe"]),
    conversationId: CopilotIdSchema,
    viewId: CopilotIdSchema,
  })
  .strict();
export const WsCopilotSubscribedSchema = z
  .object({
    type: z.literal("copilot.subscribed"),
    conversationId: CopilotIdSchema,
    viewId: CopilotIdSchema,
  })
  .strict();

export const CopilotPromptSchema = z
  .object({
    version: z.literal(1),
    messageId: CopilotIdSchema,
    text: z.string().min(1),
    context: PageContextSchema,
  })
  .strict();
export const CopilotContextReferenceSchema = z
  .object({
    clientMessageId: CopilotIdSchema,
    messageId: CopilotIdSchema,
    runId: CopilotIdSchema,
    context: z
      .object({
        contextId: CopilotIdSchema,
        view: z.string().min(1),
        status: z.enum(["complete", "unavailable", "error"]),
        revision: z.number().int().nonnegative(),
        objects: z.array(
          z.object({ id: z.string().min(1), rev: z.number().int().nonnegative() }).strict()
        ),
      })
      .strict(),
  })
  .strict();

export const CopilotObservationSchema = z
  .object({ version: z.literal(1), taskContextId: CopilotIdSchema, page: PageContextSchema })
  .strict();
