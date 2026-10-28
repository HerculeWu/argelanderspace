import { type IntakeChecklistState, IntakeStateSchema } from "@argelanderspace/contracts";
import { apiRequest } from "./request";

/**
 * Whether the Project root holds the intake checklist (project-intake ticket 06). Anything but a clear answer is
 * `unknown` (an older server, no server, a failed request): never `absent`, which would claim there is no checklist.
 */
export async function fetchIntakeChecklistState(): Promise<IntakeChecklistState> {
  try {
    const body = IntakeStateSchema.safeParse(await apiRequest<unknown>("/api/intake", { cache: "no-store" }));
    return body.success ? body.data.checklist : "unknown";
  } catch {
    return "unknown";
  }
}
