import { SAMPLE_CONVERSATION } from "../sample-ids";
import type { ChapterDefinition, Requirement, WorkbenchSnapshot } from "../types";

const [FIRST_QUESTION, SECOND_QUESTION] = SAMPLE_CONVERSATION.questions;
const [PLAN_REPLY] = SAMPLE_CONVERSATION.operationReplies;

/** The anchors of chapter 8, constants checked by the static anchor test. */
const TOGGLE = { ui: "copilot-toggle" } as const;
const SIDEBAR = { ui: "copilot-sidebar" } as const;
const MESSAGES = { ui: "copilot-messages" } as const;
/** The first question, asked in Jerabkova's reader: its message and the page context folded under it. */
const FIRST = { ui: "copilot-message", key: FIRST_QUESTION } as const;
const FIRST_CONTEXT = { ui: "copilot-message-context", within: FIRST } as const;
/** The second question (the Plan request) and the operation card of the reply that carried it out. */
const SECOND = { ui: "copilot-message", key: SECOND_QUESTION } as const;
const PLAN_OPERATION = { ui: "copilot-operation", within: { ui: "copilot-message", key: PLAN_REPLY } } as const;
const CONVERSATIONS = { ui: "copilot-conversations" } as const;
const CONVERSATION_LIST = { ui: "copilot-conversation-list" } as const;
const SETTINGS = { ui: "copilot-settings" } as const;
/** The model settings dialog: it lists one card per provider, none of them the one to point at. */
const PROVIDER_SETTINGS = { ui: "provider-settings" } as const;

/**
 * The panel is open: L1 is the Shell's `copilotOpen` in the page context; without it (L3) the sidebar is in the page and
 * not hidden (the Shell keeps the closed panel mounted and hidden).
 */
export function copilotOpen(s: WorkbenchSnapshot): boolean {
  const open = s.page.workspace?.copilotOpen;
  if (typeof open === "boolean") return open;
  return s.dom.present(SIDEBAR) && s.dom.attr(SIDEBAR, "hidden") === null;
}

/** Steps 8.4-8.5 look at the panel's own buttons; "take me there" is the workspace's registered action that opens it. */
const PANEL_OPEN: Requirement = {
  test: copilotOpen,
  where: "copilot",
  takeMeThere: { action: "open_copilot" },
};

/**
 * Steps 8.2-8.3 point into the conversation's messages, so they need the open panel showing chapter 8's preset
 * conversation (its first question is in the page). "Take me there" opens the panel on that conversation (navigation
 * only), so it also brings the panel back from another conversation, such as chapter 9's move-in one. 8.4 and 8.5
 * keep PANEL_OPEN: their anchors do not depend on which conversation is shown.
 */
const CONVERSATION_SHOWN: Requirement = {
  // While the panel is still reading the conversation (its messages area says so) the answer is not known yet: not a "go back" card.
  test: (s) => copilotOpen(s) && (s.dom.present(FIRST) || s.dom.attr(MESSAGES, "data-loading") !== null),
  where: "copilot",
  takeMeThere: { action: "open_copilot", conversationId: SAMPLE_CONVERSATION.id },
};

/** Chapter 8, "copilot" (appendix A): the preset conversation replayed; nothing is sent, nothing needs a provider. */
export const COPILOT_CHAPTER: ChapterDefinition = {
  id: "copilot",
  n: 8,
  steps: [
    {
      id: "copilot.open",
      kind: "do",
      anchors: [TOGGLE, SIDEBAR],
      // Supplementary item 4: L1, with L3 behind it.
      gate: copilotOpen,
    },
    {
      id: "copilot.context",
      kind: "look",
      anchors: [MESSAGES, FIRST, FIRST_CONTEXT],
      requires: CONVERSATION_SHOWN,
    },
    {
      id: "copilot.operations",
      kind: "look",
      anchors: [SECOND, PLAN_OPERATION],
      requires: CONVERSATION_SHOWN,
      // Not a gate: the card offers the plan page the operation wrote to (the task is in chapter 6's plan).
      takeMeThere: { action: "switch_view", view: "plan" },
    },
    {
      id: "copilot.conversations",
      kind: "look",
      anchors: [CONVERSATIONS, CONVERSATION_LIST],
      requires: PANEL_OPEN,
    },
    {
      id: "copilot.provider",
      kind: "look",
      anchors: [SETTINGS, PROVIDER_SETTINGS],
      requires: PANEL_OPEN,
    },
    {
      id: "copilot.agent",
      kind: "agent",
      anchors: [],
    },
  ],
};
