/** The Library's intake entries ask the Copilot panel for a move-in (project-intake ticket 06). */
export type IntakeKind = "start" | "resume";

/** One request: `seq` counts up, so the same kind asked twice is two requests. */
export interface IntakeRequest {
  seq: number;
  kind: IntakeKind;
}

/**
 * A request to show one saved conversation (project-intake ticket 07): the tutorial's "take me there" of the replay
 * step, `open_copilot` carrying a `conversationId`. Navigation only, like picking it in the list: nothing is created
 * or sent, and an id the list does not hold changes nothing.
 */
export interface ConversationRequest {
  seq: number;
  id: string;
}
