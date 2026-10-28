/**
 * Confirmation cards raised by an external agent through the CLI (release-0.2 ticket 04; ADR 0015 "confirmation";
 * `docs/operation-catalog.md` "Confirmation cards from the CLI").
 *
 * A cataloged operation with `confirm: "card"` that arrives over the workbench's operation route waits for a real
 * user. Its card belongs to no Copilot conversation: the server keeps these requests in one queue and the page shows
 * them in its own place (approved prototype `.scratch/release-0.2/prototype/03-cli-confirmation/`, variant A).
 * The card itself is the Copilot card of the same action, so the page draws it with the card kinds Copilot uses and
 * asks the same page guards before an approval.
 *
 * The page reads the queue with `GET /api/external-requests` and is told to read it again by the
 * `external-requests.changed` frame; both are ephemeral (a restart of the workbench drops every request, and the CLI
 * is told it was interrupted).
 */
import { z } from "zod";
import { CopilotConfirmationSchema } from "./copilot.js";

export const EXTERNAL_REQUESTS_PATH = "/api/external-requests";

/** Who asked, as the CLI reported it: shown verbatim, never trusted (a CLI cannot prove which agent runs it). */
export const ExternalRequestClientSchema = z
  .object({
    pid: z.number().int().nonnegative(),
    /** The full command line the CLI was started with. */
    commandLine: z.string().max(4000),
  })
  .strict();
export type ExternalRequestClient = z.infer<typeof ExternalRequestClientSchema>;

export const ExternalRequestSchema = z
  .object({
    id: z.string().uuid(),
    /**
     * `pending`: the CLI waits for the user. `withdrawn`: the CLI left (Ctrl-C or a lost connection), nothing was or
     * will be done; the card stays shown until the user closes it (the first of the queue) or goes by itself (the others).
     */
    state: z.enum(["pending", "withdrawn"]),
    /** ISO-8601 time the request reached the workbench. */
    receivedAt: z.string(),
    client: ExternalRequestClientSchema.nullable(),
    /** The Copilot card of the action (its `id` is this request's id; `runId` and `toolCallId` are fillers). */
    card: CopilotConfirmationSchema,
  })
  .strict();
export type ExternalRequest = z.infer<typeof ExternalRequestSchema>;

export const ExternalRequestListSchema = z
  .object({ requests: z.array(ExternalRequestSchema) })
  .strict();
export type ExternalRequestList = z.infer<typeof ExternalRequestListSchema>;

/** `POST /api/external-requests/:id/decision`. */
export const ExternalRequestDecisionSchema = z
  .object({ decision: z.enum(["approve", "deny"]) })
  .strict();
export type ExternalRequestDecision = z.infer<typeof ExternalRequestDecisionSchema>;

/**
 * The decision's answer. `approved` waits until the operation finished and carries its result (the operation's own
 * result object, e.g. a Doc delete's `works`, which the page needs to move off the deleted Doc); `denied` means the CLI
 * received `denied`.
 */
export const ExternalRequestDecisionResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("approved"), result: z.unknown() }).strict(),
  z.object({ state: z.literal("denied") }).strict(),
]);
export type ExternalRequestDecisionResult = z.infer<typeof ExternalRequestDecisionResultSchema>;

/** The queue changed (a request arrived, was decided or withdrawn, or was closed); the frame carries nothing else. */
export const WsExternalRequestsChangedSchema = z
  .object({
    type: z.literal("external-requests.changed"),
    /** ISO-8601 timestamp. */
    at: z.string(),
  })
  .strict();
export type WsExternalRequestsChanged = z.infer<typeof WsExternalRequestsChangedSchema>;
