import type { ConversationModel, CopilotModel, CopilotProvider } from "@argelanderspace/contracts";

/**
 * Which model the Copilot starts with when the user has not chosen one (project-intake ticket 11). A model whose
 * context window cannot hold the instruction and tool schemas and still leave the reserve for a following round gets
 * refused for `capacity` (the smallest ones already at the first message), so it is never picked for the user. The
 * service says which models those are (`fits: false` in the model list; the measure is the server's, this page
 * holds no byte counts); a list without the mark is taken as fitting.
 */
export const fitsWindow = (model: CopilotModel): boolean => model.fits !== false;

/** The same model key the picker uses. */
export const modelKey = (choice: { provider: string; model: string }): string => `${choice.provider}\n${choice.model}`;

/** A model the Copilot could talk to at all: a configured credential and a tool-capable model. */
const runnable = (provider: CopilotProvider, model: CopilotModel): boolean => provider.credential.configured && model.tools;

/** The panel's default: the first tool-capable model of the first configured provider that has one whose window fits. */
export function defaultModel(list: readonly CopilotProvider[]): ConversationModel | null {
  for (const provider of list) {
    const found = provider.models.find((model) => runnable(provider, model) && fitsWindow(model));
    if (found) return { provider: provider.id, model: found.id, thinking: null };
  }
  return null;
}

/**
 * The model a move-in starts with, null when none can run it: the one on screen when it can run it and either its
 * window holds the conversation or the user chose it themselves; else the first model that can run it and fits. A
 * model the user chose is never replaced behind their back, and never sent to when its window is too small either:
 * that gives null, and the entry shows the window card (`windowBlocksIntake`) instead of a refused message.
 * `autoKey` is the key of the model this page picked for the user, if any: only that one counts as not chosen.
 */
export function intakeModel(list: readonly CopilotProvider[], choice: ConversationModel | null, autoKey: string | null): ConversationModel | null {
  const usable = (provider: CopilotProvider, model: CopilotModel) => runnable(provider, model) && model.defaultThinkingValid;
  const kept = keptChoice(list, choice);
  if (choice && kept && usable(kept.provider, kept.model)) {
    if (fitsWindow(kept.model)) return { ...choice, thinking: null };
    if (modelKey(choice) !== autoKey) return null; // chosen by the user and too small: not replaced, not sent to
  }
  for (const item of list) {
    const found = item.models.find((candidate) => usable(item, candidate) && fitsWindow(candidate));
    if (found) return { provider: item.id, model: found.id, thinking: null };
  }
  return null;
}

const keptChoice = (list: readonly CopilotProvider[], choice: ConversationModel | null) => {
  const provider = choice && list.find((item) => item.id === choice.provider);
  const model = provider?.models.find((item) => item.id === choice?.model);
  return provider && model ? { provider, model } : null;
};

/**
 * True when a move-in finds no model and the window is the reason, so the card says "no model's window is large
 * enough" rather than "no model": the user's own choice is usable but too small (kept, not replaced), or some model
 * that could run it is too small and no model that could run it fits at all (one that fits but is held back by its
 * default thinking level is not the window's doing). Only meaningful while `intakeModel` is null.
 */
export function windowBlocksIntake(list: readonly CopilotProvider[], choice: ConversationModel | null, autoKey: string | null): boolean {
  const kept = keptChoice(list, choice);
  if (choice && kept && runnable(kept.provider, kept.model) && kept.model.defaultThinkingValid && !fitsWindow(kept.model) && modelKey(choice) !== autoKey) return true;
  const models = list.flatMap((provider) => provider.models.filter((model) => runnable(provider, model)));
  return models.some((model) => model.defaultThinkingValid && !fitsWindow(model)) && !models.some(fitsWindow);
}

/**
 * True when the window card is about the user's own choice: it is usable but too small (kept, not replaced) while
 * another model that could run the move-in fits, so the card asks to switch models in the picker rather than to add
 * one. Only meaningful while `windowBlocksIntake` is true.
 */
export function chosenTooSmall(list: readonly CopilotProvider[], choice: ConversationModel | null, autoKey: string | null): boolean {
  const kept = keptChoice(list, choice);
  if (!choice || !kept || modelKey(choice) === autoKey || fitsWindow(kept.model)) return false;
  return list.some((provider) => provider.models.some((model) => runnable(provider, model) && model.defaultThinkingValid && fitsWindow(model)));
}
