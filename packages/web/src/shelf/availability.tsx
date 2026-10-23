import type { TutorialState } from "@argelanderspace/contracts";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { fetchTutorial } from "../api/tutorial";
import { usePreferences } from "../argelander/preferences";
import { samePath } from "../tutorial/progress";
import { setIngestPromptProject } from "./ingest-prompt";

/*
 * Whether the Shelf's entries are shown (shelf ticket 05; contracts "Shelf" section: the tutorial Project has none, spec Q21).
 * The tutorial Project is the folder `tutorial.json` is bound to while it still carries the tutorial marker — the same
 * test the tutorial layer mounts on. Until that is known (settings or the tutorial state still loading) the entries
 * stay hidden, so no Shelf control flashes up in the tutorial. Outside the Shell (a page rendered on its own) there is
 * no provider and the entries are hidden too.
 */

const ShelfAvailabilityContext = createContext<boolean | undefined>(undefined);

/** true only when the open project is known not to be the tutorial Project. */
export function useShelfAvailable(): boolean {
  return useContext(ShelfAvailabilityContext) === true;
}

/** The rule itself: `undefined` while either input is still loading. */
export function shelfAvailable(tutorial: TutorialState | null | undefined, projectRoot: string | null | undefined): boolean | undefined {
  // Not read yet, or the read failed (`fetchTutorial` answers null): not known, so no entry is shown.
  if (tutorial === undefined || tutorial === null) return undefined;
  // No usable progress: no project is bound, so this one is not the tutorial Project.
  const bound = tutorial.progress ? tutorial.project : null;
  if (!bound || bound.state !== "ready") return true;
  if (projectRoot === undefined) return undefined;
  return !samePath(bound.path, projectRoot);
}

/** For tests and pages that know the answer. */
export const ShelfAvailabilityValue = ShelfAvailabilityContext.Provider;

/** The Shell's provider: reads the tutorial state once and compares it with the open project's folder. */
export function ShelfAvailabilityProvider({ children }: { children: ReactNode }) {
  const { settings } = usePreferences();
  const [tutorial, setTutorial] = useState<TutorialState | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    fetchTutorial(controller.signal).then(setTutorial, () => undefined);
    return () => controller.abort();
  }, []);
  const root = settings ? (settings.running.project_root?.path ?? null) : undefined;
  // The ingest reminders are kept per project folder (ingest-prompt.ts).
  useEffect(() => {
    if (root !== undefined) setIngestPromptProject(root);
  }, [root]);
  return <ShelfAvailabilityContext.Provider value={shelfAvailable(tutorial, root)}>{children}</ShelfAvailabilityContext.Provider>;
}
