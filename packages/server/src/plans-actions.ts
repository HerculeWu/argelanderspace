import type { PlansFile } from "@argelanderspace/contracts";
import { loadPlans, savePlans } from "@argelanderspace/core";
import type { AsyncLock } from "./lock.js";

export function readPlans(statusDir: string): PlansFile {
  return loadPlans(statusDir);
}

/** Replace a validated whole document using the app's dedicated Plan lock. */
export async function replacePlans(
  statusDir: string,
  planLock: AsyncLock,
  file: PlansFile,
  onChanged: () => void
): Promise<{ conflictRev: number } | { saved: PlansFile }> {
  const outcome = await planLock.run(() => {
    const current = readPlans(statusDir);
    if (file.rev !== current.rev) return { conflictRev: current.rev } as const;
    savePlans(statusDir, file, { bumpRev: true });
    return { saved: { ...file, rev: file.rev + 1 } } as const;
  });
  if ("saved" in outcome) onChanged();
  return outcome;
}
