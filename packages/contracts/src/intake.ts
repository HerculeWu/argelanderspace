/**
 * Project intake, the entry's one server fact (project-intake ticket 06): whether the Project root holds the intake
 * checklist. Only existence is reported; the file's content is never read by the server (the agent and the user own
 * it, `docs/contracts.md` 「项目迁入」). A file the server could not look at is `unknown`, which is not `absent`.
 */
import { z } from "zod";

/** The checklist's name in the Project root (outside the data directory). */
export const INTAKE_CHECKLIST_FILE = "argelanderspace-intake.md";

export const IntakeChecklistStateSchema = z.enum(["present", "absent", "unknown"]);
export type IntakeChecklistState = z.infer<typeof IntakeChecklistStateSchema>;

/** `GET /api/intake`. */
export const IntakeStateSchema = z.strictObject({ checklist: IntakeChecklistStateSchema });
export type IntakeState = z.infer<typeof IntakeStateSchema>;

/**
 * Sent when the checklist appeared, disappeared, or became (un)readable, found by the server's poll (an agent or the
 * user writes the file behind the server's back). The page reads `/api/intake` again; the message carries no state.
 */
export const WsIntakeChangedSchema = z.object({
  type: z.literal("intake.changed"),
  /** ISO-8601 timestamp. */
  at: z.string(),
});
export type WsIntakeChanged = z.infer<typeof WsIntakeChangedSchema>;
