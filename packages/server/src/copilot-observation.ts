/**
 * What a page observation may be written as. The history is read back strictly (`CopilotObservationSchema`, record by
 * record), so an observation that does not satisfy it must never be written: the write would succeed and the
 * conversation would not load again. The argument graph page is the one page whose observation form is computed here
 * (it is reduced from the page the view published), so it is the one that gets a fallback.
 */
import {
  ARGUMENT_ACTIONS_NOTE,
  type ArgumentPage,
  CopilotObservationSchema,
  type PageContext,
} from "@argelanderspace/contracts";

export interface RecordableObservation {
  /** The JSON that goes into the history and to the model. */
  content: string;
  page: PageContext;
  /** The argument graph page was replaced by one without its details. */
  degraded: boolean;
}

const failed = (page: PageContext): ArgumentPage => ({
  work: { id: page.argument?.work.id ?? "unknown", title: page.argument?.work.title ?? "" },
  phase: "error",
  rev: null,
  counts: { arguments: 0, edges: 0 },
  audit: null,
  selectedId: null,
  partial: false,
  graph: null,
  outline: null,
  edges: null,
  selected: null,
  reduction: null,
  note: `the argument graph page of this moment could not be recorded, so this observation carries no graph; do not guess it, and wait for the next observation or ask the user. ${ARGUMENT_ACTIONS_NOTE}.`,
});

/**
 * The observation as it can be read back, or null when not even a page without the argument graph's details can be
 * (nothing is written then; the next model request tries again with the then-current page).
 */
export function recordableObservation(
  taskContextId: string,
  page: PageContext,
  warn: (message: string) => void = console.warn
): RecordableObservation | null {
  const record = (candidate: PageContext) =>
    CopilotObservationSchema.safeParse({ version: 1, taskContextId, page: candidate });
  if (record(page).success)
    return {
      content: JSON.stringify({ version: 1, taskContextId, page }),
      page,
      degraded: false,
    };
  warn(
    "copilot: a page observation did not satisfy the history contract; it is not recorded as built"
  );
  if (!page.argument) return null;
  const fallback: PageContext = { ...page, status: "error", argument: failed(page) };
  if (!record(fallback).success) return null;
  return {
    content: JSON.stringify({ version: 1, taskContextId, page: fallback }),
    page: fallback,
    degraded: true,
  };
}
