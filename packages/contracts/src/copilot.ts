import { z } from "zod";
import { type CopilotOperation, CopilotOperationSchema, PlanViewActionSchema } from "./plan-ops.js";
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
/** Resume carries no text: the host writes the request from what the record proves. */
export const CopilotResumeRequestSchema = CopilotMessageRequestSchema.omit({ text: true });
export type CopilotResumeRequest = z.infer<typeof CopilotResumeRequestSchema>;

export const EventCursorSchema = z
  .object({ instanceId: CopilotIdSchema, seq: z.number().int().nonnegative() })
  .strict();
export type EventCursor = z.infer<typeof EventCursorSchema>;
export const CopilotRunSchema = z
  .object({
    id: CopilotIdSchema,
    // `stopping` is Stop accepted but the SDK not settled; `stopped` is the user's own Stop;
    // `interrupted` is a service exit/restart. Neither is an error.
    status: z.enum(["running", "stopping", "completed", "failed", "stopped", "interrupted"]),
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
  /** A host-written resume request after Stop/failure/restart; shown as a marker, not as user text. */
  kind?: "resume";
  /** Steering accepted while the run is working, not yet read by the model. */
  pending?: boolean;
  /** Operations this assistant message requested, with their committed outcomes. */
  operations?: CopilotOperation[];
  context?: {
    contextId: string;
    view: string;
    status: PageContext["status"];
    revision: number;
    objects: { id: string; rev: number; name?: string }[];
  };
}
/** A record that cannot be read is reported by itself; it never hides the readable conversations. */
export interface CopilotConversationList {
  version: 1;
  conversations: Conversation[];
  unreadable: { id: string; code: string }[];
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
/** Targeted at exactly one browser view (never broadcast to other tabs). */
export const WsCopilotViewActionSchema = z
  .object({
    type: z.literal("copilot.view-action"),
    viewId: CopilotIdSchema,
    actionId: z.string().uuid(),
    action: PlanViewActionSchema,
  })
  .strict();
export type WsCopilotViewAction = z.infer<typeof WsCopilotViewActionSchema>;

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
    kind: z.literal("resume").optional(),
    messageId: CopilotIdSchema,
    text: z.string().min(1),
    context: PageContextSchema,
  })
  .strict();
export type CopilotPrompt = z.infer<typeof CopilotPromptSchema>;
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

export type CopilotContextReference = z.infer<typeof CopilotContextReferenceSchema>;
export const CopilotObservationSchema = z
  .object({ version: z.literal(1), taskContextId: CopilotIdSchema, page: PageContextSchema })
  .strict();

/**
 * Durable record of a business write: `begin` is persisted before the write runs, `done` after it has a
 * result. A `begin` without `done` means the outcome is unknown (never proof the write did not happen).
 */
export const OPERATION_JOURNAL_TYPE = "argelander.operation.v1";
export const OperationJournalSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["begin", "done"]),
    operationId: z.string().min(1).max(200),
    toolCallId: z.string().min(1),
    runId: CopilotIdSchema,
    action: z.string(),
    hash: z.string(),
    object: z
      .object({ planId: z.string().optional(), taskId: z.string().optional() })
      .strict()
      .optional(),
    baseRev: z.number().int().nonnegative().optional(),
    result: z
      .object({ payload: z.record(z.string(), z.unknown()), operation: CopilotOperationSchema })
      .strict()
      .optional(),
  })
  .strict();
export type OperationJournal = z.infer<typeof OperationJournalSchema>;

/**
 * A steering message the service accepted (HTTP 202) while a run was working. It is saved before the
 * acceptance is returned, so a crash or a later failure cannot lose the user's words. It stays "queued"
 * until a user message with the same messageId exists in the history; a later run hands it to the model.
 */
export const STEER_QUEUE_TYPE = "argelander.steer.v1";
export const QueuedSteerSchema = z
  .object({
    version: z.literal(1),
    clientMessageId: CopilotIdSchema,
    messageId: CopilotIdSchema,
    runId: CopilotIdSchema,
    envelope: z.string().min(1),
    reference: CopilotContextReferenceSchema,
  })
  .strict();
export type QueuedSteer = z.infer<typeof QueuedSteerSchema>;
