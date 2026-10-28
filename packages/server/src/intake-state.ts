/**
 * Project intake, the entry's one server fact (project-intake ticket 06; contracts `intake.ts`): does the Project
 * root hold `argelanderspace-intake.md`. Existence only, from one `lstat`: the file's content is never opened (the
 * checklist is the agent's and the user's, `docs/contracts.md` 「项目迁入」). A root that cannot be looked at is
 * `unknown`, never `absent`: a system error must not read as "no checklist".
 */

import { lstatSync } from "node:fs";
import { join } from "node:path";
import { INTAKE_CHECKLIST_FILE, type IntakeChecklistState } from "@argelanderspace/contracts";

export function intakeChecklistState(projectRoot: string): IntakeChecklistState {
  try {
    const stat = lstatSync(join(projectRoot, INTAKE_CHECKLIST_FILE));
    // A file (or a link, which names one): present. A folder or anything else by that name is not a checklist and
    // not a clean "no": the page cannot say.
    return stat.isFile() || stat.isSymbolicLink() ? "present" : "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT" ? "absent" : "unknown";
  }
}
