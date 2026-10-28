import { SAMPLE_INTAKE_CONVERSATION, type SampleIntakeConversation } from "../sample-ids";
import type { ChapterDefinition, Requirement, TutorialAnchor } from "../types";
import { copilotOpen } from "./copilot";

/** The anchors of chapter 9, constants checked by the static anchor test. */
const MESSAGES = { ui: "copilot-messages" } as const;
const reply = (key: string): TutorialAnchor => ({ ui: "copilot-message", key });

/**
 * Chapter 9, "intake" (project-intake ticket 07; approved prototype, ticket 05): what moving an existing project in is,
 * looked at in a preset conversation the panel replays — nothing is sent, nothing needs a provider. The replay is chosen
 * by "take me there": the registered `open_copilot` action carrying the conversation's id (navigation only).
 *
 * `replay` is the preset conversation, `null` while the sample holds none (it is recorded by ticket 10): then the steps
 * point at the messages area, "take me there" only opens the panel, and a card still reads on its own.
 */
export function intakeChapter(replay: SampleIntakeConversation | null): ChapterDefinition {
  const seen = (key: string | null) => (key === null ? [MESSAGES] : [MESSAGES, reply(key)]);
  const interview = replay?.replies.interview ?? null;
  const summary = replay?.replies.summary ?? null;
  /** The panel is open and, once there is a replay, shows it: the reply this step points at is in the page. */
  const requirement = (key: string | null): Requirement => ({
    test: (s) => copilotOpen(s) && (key === null || s.dom.present(reply(key))),
    where: "copilot",
    takeMeThere: replay ? { action: "open_copilot", conversationId: replay.id } : { action: "open_copilot" },
  });
  /** Without a replay 9.1's body must not speak of one ("in the replay ..."): the copy has its own variant. 9.2's never does. */
  const bare = replay ? {} : { bodyKey: "bodyNoReplay" };
  return {
    id: "intake",
    n: 9,
    steps: [
      { id: "intake.interview", kind: "look", anchors: seen(interview), requires: requirement(interview), ...bare },
      { id: "intake.summary", kind: "look", anchors: seen(summary), requires: requirement(summary) },
      { id: "intake.agent", kind: "agent", anchors: [] },
    ],
  };
}

/** The registered chapter: the sample's preset move-in conversation, or its absence. */
export const INTAKE: ChapterDefinition = intakeChapter(SAMPLE_INTAKE_CONVERSATION);
