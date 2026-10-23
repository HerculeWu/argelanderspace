/**
 * The confirmation cards are the one list of actions (architecture-deepening ticket 07): the real UI's decision accepts
 * exactly the actions of the card union, so a new card kind cannot be shown without being decidable, or the reverse.
 */
import { expect, test } from "vitest";
import { CopilotConfirmationDecisionSchema, CopilotConfirmationSchema } from "../src/index.js";

test("a decision names exactly the actions the cards have", () => {
  const cards = CopilotConfirmationSchema.options.map((card) => card.shape.action.value);
  const decisions = CopilotConfirmationDecisionSchema.shape.action.options;
  expect(new Set(decisions)).toEqual(new Set(cards));
  expect(decisions).toHaveLength(cards.length);
  expect(cards).toHaveLength(15);
  // the fifteen of this version, by name (twelve business kinds — three of them the Shelf's, shelf ticket 07 — and the
  // three file and command tool kinds)
  expect([...cards].sort()).toEqual([
    "delete_doc",
    "delete_mail",
    "delete_manuscript",
    "delete_plan",
    "edit_file",
    "move_mail",
    "refresh_arxiv_source",
    "replace_argument_graph",
    "replace_text_reading",
    "run_command",
    "send_mail",
    "shelf_add",
    "shelf_delete",
    "shelf_take",
    "write_file",
  ]);
});
