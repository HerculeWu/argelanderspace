import { z } from "zod";
import {
  type LibraryContextSummary,
  LibraryContextSummarySchema,
  LibraryPageSchema,
  LibraryViewActionSchema,
} from "./library-ops.js";
import { type CopilotOperation, CopilotOperationSchema, PlanViewActionSchema } from "./plan-ops.js";
import { PlanSchema, TaskSchema } from "./plans.js";
import { ThinkingLevelSchema } from "./providers.js";
import { WorkspaceSnapshotSchema, WorkspaceViewActionSchema } from "./workspace-ops.js";

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
    /** The Library page (copilot ticket 13); optional so older views and headless callers stay valid. */
    library: LibraryPageSchema.nullable().optional(),
    /** Layout and appearance of the Shell; optional so older views and headless callers stay valid. */
    workspace: WorkspaceSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // Only data the page really loaded counts as complete: the Library's built-in example data does not.
    const covered =
      (value.view === "plan" && value.plan !== null) ||
      (value.view === "library" && value.library?.source === "live");
    if ((value.status === "complete") !== covered)
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
    // `waiting-for-user` is a run held at a human confirmation; Stop and steering still work there.
    status: z.enum([
      "running",
      "waiting-for-user",
      "stopping",
      "completed",
      "failed",
      "stopped",
      "interrupted",
    ]),
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
    library?: LibraryContextSummary;
  };
}
/** A record that cannot be read is reported by itself; it never hides the readable conversations. */
export interface CopilotConversationList {
  version: 1;
  conversations: Conversation[];
  unreadable: { id: string; code: string }[];
}
/**
 * A delete the model asked for and the user has not yet confirmed. Bound to this object and this
 * PlansFile.rev: any change to either makes it expire. The id is never shown to the model.
 */
export const CopilotConfirmationSchema = z
  .object({
    id: CopilotIdSchema,
    runId: CopilotIdSchema,
    toolCallId: z.string().min(1),
    // Only a whole Plan waits for the user; a Task delete is immediate with the six-second undo.
    action: z.literal("delete_plan"),
    object: z
      .object({ kind: z.literal("plan"), id: z.string().min(1), planId: z.string().min(1) })
      .strict(),
    /** Verbatim plan name or task title. */
    label: z.string(),
    /** The plan's name (the task's parent for a task delete). */
    planName: z.string(),
    /** What the delete takes with it. For a task: 1 task, 1 unfinished unless done. */
    impact: z
      .object({ tasks: z.number().int().nonnegative(), openTasks: z.number().int().nonnegative() })
      .strict(),
    baseRev: z.number().int().nonnegative(),
    /** Hash of the plan's stored content when it was shown; any later change expires the card. */
    objectDigest: z.string().min(1),
  })
  .strict();
export type CopilotConfirmation = z.infer<typeof CopilotConfirmationSchema>;

/** The real UI's decision. It repeats what the card showed so a click can only bind to that version. */
export const CopilotConfirmationDecisionSchema = z
  .object({
    decision: z.enum(["approve", "decline"]),
    viewId: CopilotIdSchema,
    action: z.literal("delete_plan"),
    objectId: z.string().min(1),
    baseRev: z.number().int().nonnegative(),
  })
  .strict();
export type CopilotConfirmationDecision = z.infer<typeof CopilotConfirmationDecisionSchema>;

/** Undo of a confirmed task delete, from a real view. */
export const CopilotUndoRequestSchema = z.object({ viewId: CopilotIdSchema }).strict();

/** Durable record of a confirmation: requested before the card exists, resolved before anything runs. */
export const OPERATION_CONFIRMATION_TYPE = "argelander.confirmation.v1";
export const OperationConfirmationSchema = z
  .object({
    version: z.literal(1),
    phase: z.enum(["requested", "resolved"]),
    confirmationId: CopilotIdSchema,
    runId: CopilotIdSchema,
    toolCallId: z.string().min(1),
    action: z.literal("delete_plan"),
    planId: z.string().min(1),
    baseRev: z.number().int().nonnegative(),
    outcome: z.enum(["approved", "declined", "expired"]).optional(),
  })
  .strict();
export type OperationConfirmation = z.infer<typeof OperationConfirmationSchema>;

export interface ConversationSnapshot {
  version: 1;
  conversation: Conversation;
  messages: CopilotMessage[];
  /** Confirmations the user can act on now (this service instance only; a restart revives none). */
  confirmations: CopilotConfirmation[];
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
    action: z.union([PlanViewActionSchema, WorkspaceViewActionSchema, LibraryViewActionSchema]),
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
        /** What the Library page carried (copilot ticket 13); absent for other pages. */
        library: LibraryContextSummarySchema.optional(),
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
      .object({
        planId: z.string().optional(),
        taskId: z.string().optional(),
        workId: z.string().optional(),
      })
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

/** Everything a bound browser view can be asked to do: Plan page navigation or Shell layout/appearance. */
export type CopilotViewAction = WsCopilotViewAction["action"];
