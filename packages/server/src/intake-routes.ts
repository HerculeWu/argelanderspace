/** `GET /api/intake` (project-intake ticket 06): whether the Project root holds the intake checklist. See intake-state.ts. */

import type { IntakeState } from "@argelanderspace/contracts";
import { intakeChecklistState } from "./intake-state.js";
import type { ProtectedRoutes } from "./protected-app.js";

export function mountIntakeRoutes(routes: ProtectedRoutes, options: { projectRoot: string }): void {
  const app = routes.withDefaults({ noStore: true });
  app.get("/api/intake", (c) => {
    const state: IntakeState = { checklist: intakeChecklistState(options.projectRoot) };
    return c.json(state, 200, { "Cache-Control": "no-store" });
  });
}
