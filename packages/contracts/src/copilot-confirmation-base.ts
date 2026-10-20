import { z } from "zod";

/**
 * The fields every confirmation card has (the cards of copilot.ts and of copilot-file-tools.ts): the host's id for it,
 * the run that asked, the tool call it answers, and the version it is bound to. Its own module, so both card modules
 * use the one definition without an import cycle (copilot.ts imports copilot-file-tools.ts, not the reverse).
 */
export const ConfirmationBase = {
  id: z.string().uuid(),
  runId: z.string().uuid(),
  toolCallId: z.string().min(1),
  baseRev: z.number().int().nonnegative(),
};
